#!/usr/bin/env node
// UserPromptSubmit hook: the human gates.
//
// Approvals only come from a message whose FIRST LINE is a reply command.
//
// Build runs (feature numbers):
//   approve <id> [<id>...]     spec-ready    → approved
//   revise <id> <changes>      spec-ready    → spec (the rest of the message is the feedback)
//   land <id> [<id>...]        land-pending  → land-approved (the commit as it is now)
//   retry <id> [<id>...]       needs-human   → back where it stopped, repairs reset
//   drop <id> [<id>...]        any           → dropped (worktree kept)
//
// Setup, refine and review runs (words; add the run id if two runs could match):
//   approve install · approve plans · approve plan · revise plans|plan <changes>
//   land setup · finish setup · fix R-01 R-02 · accept R-05 <reason> · finish review
//   retry <run> · cancel <run>
//
// orch.mjs has no command for any of these, and the guard stops agents editing
// the state files, so Claude can't approve its own work. The message still
// reaches Claude, with a note of what was recorded, so it carries on.

import { readFileSync, writeSync } from "node:fs";
import {
  mainRoot, readLedger, writeLedger, setStage, tryGit, TERMINAL, readRuns, writeRuns, RUN_TERMINAL, loadConfig, PLUGIN_ROOT,
} from "./lib.mjs";
import { WORKFLOWS } from "./workflows.mjs";
import { moveTo, context, stageOf } from "./runs.mjs";

function reply(context, warning) {
  const out = { hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: context } };
  if (warning) out.systemMessage = warning;
  writeSync(1, JSON.stringify(out));
  process.exit(0);
}

let input;
try { input = JSON.parse(readFileSync(0, "utf8")); } catch { process.exit(0); }
if (input.agent_id) process.exit(0); // never from inside a subagent

const prompt = String(input.prompt ?? "");
const [first, ...more] = prompt.split("\n");
const m = /^\s*(approve|revise|land|retry|drop|cancel|finish|fix|accept)\s+(.+)$/i.exec(first);
if (!m) process.exit(0);

let root;
try { root = mainRoot(input.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd()); } catch { process.exit(0); }

const verb = m[1].toLowerCase();
const restOfLine = m[2].trim();
const done = [];
const problems = [];

// ── build runs: numeric feature ids ──────────────────────────────────────────
const firstArg = restOfLine.split(/[\s,]+/)[0];
if (["approve", "revise", "land", "retry", "drop"].includes(verb) && /^[0-9]+[a-z]?$/i.test(firstArg)) {
  const ledger = readLedger(root);
  if (!ledger?.active) process.exit(0);
  let ids, feedback = "";
  if (verb === "revise") {
    const r = /^(\S+)\s*(.*)$/.exec(restOfLine);
    ids = [r[1]];
    feedback = [r[2], ...more].join("\n").trim();
  } else {
    ids = restOfLine.split(/[\s,]+/).filter(Boolean);
    if (!ids.every((id) => /^[0-9]+[a-z]?$/i.test(id))) process.exit(0); // ordinary sentence
  }
  for (const id of ids) {
    const f = ledger.features[id];
    if (!f) { problems.push(`feature ${id} isn't in this build run`); continue; }
    if (verb === "approve") {
      if (f.stage !== "spec-ready") { problems.push(`feature ${id} is "${f.stage}", not waiting for spec approval`); continue; }
      setStage(ledger, id, "approved", "approved by user");
      delete f.feedback;
      done.push(`approved the spec for feature ${id}`);
    } else if (verb === "revise") {
      if (f.stage !== "spec-ready") { problems.push(`feature ${id} is "${f.stage}", not waiting for spec approval`); continue; }
      if (!feedback) { problems.push(`say what to change: revise ${id} <changes>`); continue; }
      f.feedback = `The user asked for these spec changes:\n${feedback}`;
      setStage(ledger, id, "spec", "revision requested");
      done.push(`sent feature ${id}'s spec back for revision`);
    } else if (verb === "land") {
      if (f.stage !== "land-pending") { problems.push(`feature ${id} is "${f.stage}", not waiting for landing approval`); continue; }
      // You approve the commit as it is now, including any amend you made yourself.
      const head = tryGit(f.worktree, "rev-parse", "HEAD");
      const clean = tryGit(f.worktree, "status", "--porcelain");
      const onBase = tryGit(f.worktree, "merge-base", "--is-ancestor", ledger.base, "HEAD");
      if (!head.ok || !clean.ok || clean.out || !onBase.ok) {
        problems.push(`feature ${id}'s worktree has uncommitted changes or isn't on top of ${ledger.base}; commit or undo them first`);
        continue;
      }
      f.commit = head.out;
      setStage(ledger, id, "land-approved", `landing approved by user at ${head.out.slice(0, 8)}`);
      done.push(`approved landing feature ${id}`);
    } else if (verb === "retry") {
      if (f.stage !== "needs-human") { problems.push(`feature ${id} is "${f.stage}", not waiting for you`); continue; }
      const to = f.resumeTo ?? "building";
      f.attempts = 0;
      delete f.reason;
      setStage(ledger, id, to, "retried by user");
      done.push(`resumed feature ${id} at "${to}" with repairs reset`);
    } else if (verb === "drop") {
      if (TERMINAL.has(f.stage)) { problems.push(`feature ${id} is already ${f.stage}`); continue; }
      if (ledger.landing === id) ledger.landing = null;
      setStage(ledger, id, "dropped", "dropped by user");
      done.push(`dropped feature ${id} (worktree kept at ${f.worktree})`);
    }
  }
  if (done.length) writeLedger(root, ledger);
  finish(`Continue the ai-dev build loop as coordinator (${PLUGIN_ROOT}/coordinator/coordinator.md and workflows/build.md): run \`ai-dev-orch next\` and do what it lists.`);
}

// ── setup, refine, review runs ───────────────────────────────────────────────
const data = readRuns(root);
const live = Object.values(data.runs).filter((r) => !RUN_TERMINAL.has(r.stage));
if (!live.length) process.exit(0);

// A run id anywhere on the first line picks that run; otherwise every run whose gate understands the reply.
const tokens = first.trim().split(/\s+/);
const named = live.find((r) => tokens.includes(r.id));
const text = [tokens.filter((t) => t !== named?.id).join(" "), ...more].join("\n").trim();
const fullText = [first.trim(), ...more].join("\n").trim();
const candidates = named ? [named] : live;
const ctx = context(root, loadConfig(root));

if (verb === "retry" || verb === "cancel") {
  if (!named) process.exit(0); // "retry"/"cancel" need the run id
  if (verb === "retry") {
    if (named.stage !== "needs-human") problems.push(`${named.id} is "${named.stage}", not waiting for you`);
    else {
      const to = named.resumeTo ?? WORKFLOWS[named.workflow].stages[0].id;
      named.attempts = {}; delete named.reason; delete named.feedback;
      moveTo(ctx, named, to);
      done.push(`resumed ${named.id} at "${named.stage}"`);
    }
  } else {
    named.stage = "cancelled";
    named.history.push({ at: new Date().toISOString(), stage: "cancelled", note: "cancelled by user" });
    done.push(`cancelled ${named.id}${named.data?.branch ? ` (branch ${named.data.branch} and any worktree are kept)` : ""}`);
  }
} else {
  const matches = [];
  for (const run of candidates) {
    const st = stageOf(run);
    if (st?.kind !== "gate") continue;
    // Try the reply as typed, then without the run id ("land setup" names both).
    const res = st.onReply(ctx, run, fullText) ?? (named ? st.onReply(ctx, run, text) : null);
    if (res) matches.push({ run, res });
  }
  if (!matches.length) process.exit(0); // not a reply any waiting run understands
  if (matches.length > 1) {
    problems.push(`more than one run is waiting for "${tokens.slice(0, 2).join(" ")}" (${matches.map((x) => x.run.id).join(", ")}); add the run id, e.g. "${tokens.slice(0, 2).join(" ")} ${matches[0].run.id}"`);
  } else {
    const { run, res } = matches[0];
    if (res.error) problems.push(`${run.id}: ${res.error}`);
    else {
      if (res.feedback) run.feedback = res.feedback; else delete run.feedback;
      if (!res.stay) moveTo(ctx, run, res.to);
      done.push(`${res.msg}${res.stay ? "" : ` → ${run.id} is now at "${run.stage}"`}`);
    }
  }
}
if (done.length) writeRuns(root, data);
finish(`Continue the ai-dev run loop as coordinator (${PLUGIN_ROOT}/coordinator/coordinator.md and the run's workflow file): run \`ai-dev-orch run next\` and do what it lists.`);

function finish(how) {
  const context = [
    done.length ? `[ai-dev] Recorded from the user's message: ${done.join("; ")}.` : "",
    problems.length ? `[ai-dev] Not recorded: ${problems.join("; ")}.` : "",
    how,
  ].filter(Boolean).join("\n");
  reply(context, problems.length ? `ai-dev: ${problems.join("; ")}` : undefined);
}
