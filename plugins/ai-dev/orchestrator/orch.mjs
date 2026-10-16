#!/usr/bin/env node
// ai-dev rules engine: the code behind /ai-dev.
//
// Claude (the coordinator) runs these commands; this script decides what is
// allowed. Approvals are NOT here: they come only from messages you type,
// via the approvals hook (approvals.mjs).
//
// Build workflow (/ai-dev:build):
//   orch init                    start or resume a run
//   orch next                    what to do now (the coordinator loops on this)
//   orch start <id>              create the worktree for a feature
//   orch advance <id> <stage>    move a feature forward (checked)
//   orch fail <id> "<evidence>"  send a failed check/review back to the builder
//   orch prepare-land <id>       serial merge queue: update to main + Verify
//   orch land <id>               fast-forward main (needs your `land <id>`)
//   orch hold <id> "<reason>"    park a feature for you
//   orch status                  table of all features
//   orch stop                    end the build run (hooks stop enforcing it)
//
// Setup, refine and review workflows (/ai-dev:setup | refine | review):
//   orch run start <workflow> [args]   start a run
//   orch run next [<run>]              what to do now for active runs
//   orch run done <run>                report the current stage finished (checked)
//   orch run exec <run>                run the current code stage
//   orch run hold <run> "<reason>"     park a run for the user
//   orch run cancel <run>              end a run

import { execSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, appendFileSync } from "node:fs";
import path from "node:path";
import {
  mainRoot, paths, git, tryGit, slug, loadConfig, readLedger, writeLedger, setStage,
  TERMINAL, AGENT_FOR_STAGE, ADVANCE, loadPlan, startable, readSpec, specIsStub, uncheckedSteps, excludeHome,
} from "./lib.mjs";
import { runCommand, runsStatus } from "./runs.mjs";
import { ORCH, spawnName } from "./lib.mjs";

const root = mainRoot();
const P = paths(root);
const cfg = loadConfig(root);
const [cmd, ...args] = process.argv.slice(2);

function die(msg) {
  console.error(`✗ ${msg}`);
  process.exit(1);
}

function requireLedger() {
  const l = readLedger(root);
  if (!l || !l.active) die(`No active run. Start one with: ${ORCH} init`);
  return l;
}

function feature(ledger, id) {
  const f = ledger.features[id];
  if (!f) die(`Feature ${id} is not in this run. See: ${ORCH} status`);
  return f;
}

function mainIsClean() {
  // .ai-dev/ is git-excluded, so it never shows up here.
  return git(root, "status", "--porcelain").length === 0;
}

function run(command, cwd, timeoutMin = 20) {
  try {
    const out = execSync(command, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
                                    timeout: timeoutMin * 60_000, maxBuffer: 64 * 1024 * 1024 });
    return { ok: true, out };
  } catch (e) {
    return { ok: false, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
}

const tail = (s, n = 60) => s.trim().split("\n").slice(-n).join("\n");

function setupCommand(dir) {
  if (cfg.worktreeSetup === false) return null;
  if (typeof cfg.worktreeSetup === "string" && cfg.worktreeSetup !== "auto") return cfg.worktreeSetup;
  if (existsSync(path.join(dir, "pnpm-lock.yaml"))) return "pnpm install --frozen-lockfile";
  if (existsSync(path.join(dir, "yarn.lock"))) return "yarn install --frozen-lockfile";
  if (existsSync(path.join(dir, "bun.lockb")) || existsSync(path.join(dir, "bun.lock"))) return "bun install --frozen-lockfile";
  if (existsSync(path.join(dir, "package-lock.json"))) return "npm ci";
  return null;
}

// ── init ─────────────────────────────────────────────────────────────────────

function init() {
  if (!existsSync(P.plan)) die("blueprint/build-plan.md not found. Is AI Blueprint installed here?");
  const branch = git(root, "rev-parse", "--abbrev-ref", "HEAD");

  excludeHome(root); // keep .ai-dev/ out of git without touching .gitignore

  let ledger = readLedger(root);
  if (ledger) {
    if (branch !== ledger.base) die(`Main checkout is on "${branch}"; this run lands onto "${ledger.base}". Switch back first.`);
    ledger.active = true;
    writeLedger(root, ledger);
    console.log(`Resumed the run on "${ledger.base}".`);
  } else {
    if (!mainIsClean()) die("Main checkout has uncommitted changes. Commit or stash them first.");
    ledger = { active: true, base: branch, startedAt: new Date().toISOString(), landing: null, features: {} };
    writeLedger(root, ledger);
    console.log(`Started a run. Features will land onto "${branch}".`);
  }

  console.log(`Concurrency ${cfg.concurrency} · max repairs ${cfg.maxRepairAttempts} · Verify: ${cfg.verify ?? "NOT SET"}`);
  if (!cfg.verify) console.log(`⚠ No Verify command found in AGENTS.md. Run /ci, or set "verify" in .claude/ai-dev.json. Landing will skip Verify until then.`);
  const plan = loadPlan(root);
  const unknown = plan.filter((f) => !f.done && !f.parent && f.touches === null).map((f) => f.id);
  if (unknown.length) console.log(`ℹ Features without a "touches:" note run one at a time: ${unknown.join(", ")}`);
  console.log("");
  next();
}

// ── next: the coordinator's to-do list ───────────────────────────────────────

function next() {
  const ledger = requireLedger();
  const plan = loadPlan(root);
  const actions = [];
  const waits = [];

  for (const [id, f] of Object.entries(ledger.features)) {
    if (TERMINAL.has(f.stage)) continue;
    const tag = `[${id} ${f.title}]`;
    const agent = AGENT_FOR_STAGE[f.stage];
    if (agent) {
      let line = `${tag} spawn subagent ${spawnName(agent)}. Prompt must begin "FEATURE: ${id}" and give worktree ${f.worktree}`;
      if (f.stage === "spec") line += ` and branch ${f.branch}`;
      if (f.feedback) line += `. Include this feedback verbatim:\n      ${f.feedback.replace(/\n/g, "\n      ")}`;
      actions.push(line);
    }
    switch (f.stage) {
      case "spec-ready":
        waits.push(`${tag} spec ready: ${path.join(f.worktree, "blueprint/context/current-feature.md")}\n      You type: approve ${id}   or   revise ${id} <what to change>   or   drop ${id}`);
        break;
      case "approved":
        actions.push(`${tag} run: ${ORCH} advance ${id} building`);
        break;
      case "ready-to-land":
        if (!ledger.landing) actions.push(`${tag} run: ${ORCH} prepare-land ${id}`);
        else actions.push(`${tag} queued to land after feature ${ledger.landing}`);
        break;
      case "land-pending":
        waits.push(`${tag} work commit ${f.commit?.slice(0, 8)} ready on ${f.branch}. Check: git -C ${f.worktree} show --stat HEAD\n      You type: land ${id}   or   drop ${id}`);
        break;
      case "land-approved":
        actions.push(`${tag} run: ${ORCH} land ${id}`);
        break;
      case "needs-human":
        waits.push(`${tag} needs you: ${f.reason ?? "see status"}\n      Fix it in ${f.worktree}, then type: retry ${id}   or   drop ${id}`);
        break;
    }
  }

  for (const f of startable(plan, ledger, cfg)) {
    actions.push(`[${f.id} ${f.title}] start: ${ORCH} start ${f.id}`);
  }

  const active = Object.values(ledger.features).filter((f) => !TERMINAL.has(f.stage)).length;
  const remaining = plan.filter((f) => !f.done && !f.parent && !ledger.features[f.id]).length;

  console.log(`ACTIONS (do all now; spawn subagents in parallel, in the background):`);
  console.log(actions.length ? actions.map((a) => `  - ${a}`).join("\n") : "  (none)");
  console.log(`WAITING FOR THE USER:`);
  console.log(waits.length ? waits.map((w) => `  - ${w}`).join("\n") : "  (none)");
  if (!actions.length && !waits.length && active === 0) {
    console.log(remaining
      ? `BLOCKED: ${remaining} unstarted feature(s), but none is ready (unmet "depends:"). Tell the user.`
      : `DONE: every build-plan feature in reach has landed. Run: ${ORCH} stop`);
  } else if (!actions.length) {
    console.log(`Nothing to run until the user replies or a running subagent returns.`);
  }
}

// ── start ────────────────────────────────────────────────────────────────────

function start(id) {
  const ledger = requireLedger();
  const prev = ledger.features[id];
  if (prev?.stage === "dropped" && existsSync(prev.worktree)) {
    die(`Feature ${id} was dropped and its worktree is still at ${prev.worktree}. To start it again, the user removes it first: git worktree remove --force ${prev.worktree} && git branch -D ${prev.branch}`);
  }
  if (prev && prev.stage !== "dropped") die(`Feature ${id} is already in this run (stage: ${prev.stage}).`);
  const plan = loadPlan(root);
  const f = startable(plan, ledger, cfg).find((x) => x.id === id);
  if (!f) {
    const p = plan.find((x) => x.id === id);
    if (!p) die(`No build-plan item ${id}.`);
    die(`Feature ${id} can't start now: it's done, a parent item, has unmet dependencies, overlaps an active feature's "touches", or the concurrency limit (${cfg.concurrency}) is reached.`);
  }

  const branch = `${cfg.featureBranchPrefix}${slug(f.title)}`;
  const dir = path.join(P.worktrees, `${id}-${slug(f.title)}`);
  mkdirSync(P.worktrees, { recursive: true });
  const add = tryGit(root, "worktree", "add", "-b", branch, dir, ledger.base);
  if (!add.ok) die(`git worktree add failed:\n${add.out}`);

  for (const file of cfg.copyFiles ?? []) {
    const src = path.join(root, file);
    if (existsSync(src)) copyFileSync(src, path.join(dir, file));
  }
  const setup = setupCommand(dir);
  if (setup) {
    console.log(`Setting up worktree: ${setup}`);
    const r = run(setup, dir);
    if (!r.ok) console.log(`⚠ Setup failed (continuing):\n${tail(r.out, 20)}`);
  }

  ledger.features[id] = { title: f.title, branch, worktree: dir, touches: f.touches,
                          stage: "spec", attempts: 0, history: [] };
  setStage(ledger, id, "spec");
  writeLedger(root, ledger);
  console.log(`Started feature ${id} "${f.title}" in ${dir} on ${branch}.\n`);
  next();
}

// ── advance ──────────────────────────────────────────────────────────────────

function advance(id, to) {
  const ledger = requireLedger();
  const f = feature(ledger, id);
  if (!(ADVANCE[f.stage] ?? []).includes(to)) {
    const human = { "spec-ready": "approve/revise", "land-pending": "land", "needs-human": "retry" }[f.stage];
    die(`Can't move feature ${id} from "${f.stage}" to "${to}".${human ? ` Only the user can move it on, by typing: ${human} ${id}` : ""}`);
  }

  const spec = readSpec(f.worktree);
  if (to === "spec-ready") {
    if (specIsStub(spec)) die("current-feature.md is still the empty stub. The spec writer didn't write a spec.");
    if (!spec.includes(f.branch)) die(`The spec's **Branch:** must be \`${f.branch}\` (this worktree's branch).`);
    if (!new RegExp(`From build-plan:\\*\\*\\s*feature\\s+${id}\\b`).test(spec)) die(`The spec isn't for build-plan feature ${id}.`);
  }
  if (to === "checking") {
    const left = uncheckedSteps(spec);
    if (left > 0) die(`${left} build step(s) are still unchecked in the spec. The builder isn't finished.`);
    if (!git(f.worktree, "status", "--porcelain")) die("The worktree has no changes. Nothing was built.");
  }
  if (to === "land-pending") {
    if (git(f.worktree, "status", "--porcelain")) die("The worktree has uncommitted changes. /complete should leave it clean after the work commit.");
    const ahead = Number(git(f.worktree, "rev-list", "--count", `${ledger.base}..HEAD`));
    if (ahead < 1) die("No work commit on the feature branch yet.");
    if (!tryGit(f.worktree, "merge-base", "--is-ancestor", ledger.base, "HEAD").ok) die(`The branch isn't on top of the latest ${ledger.base}. Run prepare-land again.`);
    f.commit = git(f.worktree, "rev-parse", "HEAD");
  }

  if (to === "building") delete f.reason;
  setStage(ledger, id, to);
  writeLedger(root, ledger);
  console.log(`Feature ${id} → ${to}.\n`);
  next();
}

// ── fail: bounded repair loop ────────────────────────────────────────────────

function sendBack(ledger, id, evidence) {
  const f = ledger.features[id];
  f.attempts += 1;
  if (f.attempts > cfg.maxRepairAttempts) {
    f.reason = `gave up after ${cfg.maxRepairAttempts} repair attempts. Last failure:\n${evidence}`;
    f.resumeTo = "building";
    setStage(ledger, id, "needs-human", "repairs exhausted");
    return false;
  }
  f.feedback = evidence;
  setStage(ledger, id, "building", `repair ${f.attempts}/${cfg.maxRepairAttempts}`);
  return true;
}

function fail(id, evidence) {
  const ledger = requireLedger();
  const f = feature(ledger, id);
  if (!["checking", "reviewing", "landing"].includes(f.stage)) die(`Feature ${id} is "${f.stage}"; only checking, reviewing or landing can fail back to the builder.`);
  if (!evidence) die(`Give the evidence: ${ORCH} fail ${id} "<what failed, with reproduction>"`);
  if (f.stage === "landing" && ledger.landing === id) ledger.landing = null;
  const retried = sendBack(ledger, id, evidence);
  writeLedger(root, ledger);
  console.log(retried ? `Feature ${id} → building (repair ${f.attempts}/${cfg.maxRepairAttempts}).\n`
                      : `Feature ${id} → needs-human (repairs exhausted).\n`);
  next();
}

// ── prepare-land: the serial merge queue ─────────────────────────────────────

function prepareLand(id) {
  const ledger = requireLedger();
  const f = feature(ledger, id);
  if (f.stage !== "ready-to-land") die(`Feature ${id} is "${f.stage}", not ready-to-land.`);
  if (ledger.landing && ledger.landing !== id) die(`Feature ${ledger.landing} is landing. One at a time; try again after it lands.`);
  ledger.landing = id;
  writeLedger(root, ledger);

  const park = (reason) => {
    ledger.landing = null;
    f.reason = reason;
    f.resumeTo = "ready-to-land";
    setStage(ledger, id, "needs-human", "landing blocked");
    writeLedger(root, ledger);
    console.log(`Feature ${id} → needs-human: ${reason}\n`);
    next();
    process.exit(0);
  };

  // 1. Put this feature's work on top of the latest base.
  const before = git(f.worktree, "rev-parse", "HEAD");
  const dirty = git(f.worktree, "status", "--porcelain").length > 0;
  if (dirty) git(f.worktree, "stash", "push", "--include-untracked", "-m", `orchestrator-${id}`);
  const ahead = Number(git(f.worktree, "rev-list", "--count", `${ledger.base}..HEAD`));
  const update = ahead > 0 ? tryGit(f.worktree, "rebase", ledger.base) : tryGit(f.worktree, "merge", "--ff-only", ledger.base);
  if (!update.ok) {
    if (ahead > 0) tryGit(f.worktree, "rebase", "--abort");
    if (dirty) tryGit(f.worktree, "stash", "pop");
    park(`couldn't update to latest ${ledger.base}:\n${tail(update.out, 20)}`);
  }
  if (dirty) {
    const pop = tryGit(f.worktree, "stash", "pop");
    if (!pop.ok) park(`conflict replaying the work onto latest ${ledger.base}. In ${f.worktree}: fix the conflict markers, run \`git add -A && git reset -q && git stash drop\`, then reply retry ${id}.`);
  }

  // 2. Re-install if dependencies changed underneath.
  const changed = git(f.worktree, "diff", "--name-only", before, "HEAD");
  if (/(^|\n)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?)(\n|$)/.test(changed)) {
    const setup = setupCommand(f.worktree);
    if (setup) run(setup, f.worktree);
  }

  // 3. Verify the combined code.
  if (cfg.verify) {
    console.log(`Running Verify in ${f.worktree}: ${cfg.verify}`);
    const v = run(cfg.verify, f.worktree);
    if (!v.ok) {
      ledger.landing = null;
      const retried = sendBack(ledger, id, `Verify failed after updating to latest ${ledger.base} (\`${cfg.verify}\`):\n${tail(v.out)}`);
      writeLedger(root, ledger);
      console.log(retried ? `Verify failed. Feature ${id} → building (repair ${f.attempts}/${cfg.maxRepairAttempts}).\n`
                          : `Verify failed. Feature ${id} → needs-human (repairs exhausted).\n`);
      next();
      return;
    }
  } else {
    console.log("⚠ No Verify command configured; skipping Verify.");
  }

  setStage(ledger, id, "landing");
  writeLedger(root, ledger);
  console.log(`Feature ${id} is up to date with ${ledger.base} and passed Verify → landing.\n`);
  next();
}

// ── land ─────────────────────────────────────────────────────────────────────

function land(id) {
  const ledger = requireLedger();
  const f = feature(ledger, id);
  if (f.stage !== "land-approved") die(`Feature ${id} is "${f.stage}". Landing needs the user to type: land ${id}`);
  if (git(root, "rev-parse", "--abbrev-ref", "HEAD") !== ledger.base) die(`Main checkout isn't on ${ledger.base}.`);
  // Uncommitted changes elsewhere in the checkout are fine (a refine run may be mid-way);
  // only changes to files this feature also changes would block the fast-forward.
  const dirty = git(root, "status", "--porcelain").split("\n").filter(Boolean).map((l) => l.slice(3).replace(/^.* -> /, ""));
  const touched = new Set(git(root, "diff", "--name-only", `${ledger.base}..${f.branch}`).split("\n").filter(Boolean));
  const clash = dirty.filter((p) => touched.has(p));
  if (clash.length) die(`Uncommitted changes in your checkout touch files this feature changes: ${clash.join(", ")}. Commit or stash them, then run land again.`);
  if (git(f.worktree, "rev-parse", "HEAD") !== f.commit) die(`The branch changed after the user approved it. Ask them to check it and reply: land ${id}`);

  const ff = tryGit(root, "merge", "--ff-only", f.branch);
  if (!ff.ok) die(`Fast-forward failed (${ledger.base} moved?):\n${ff.out}`);

  const rm = tryGit(root, "worktree", "remove", f.worktree);
  if (rm.ok) tryGit(root, "branch", "-d", f.branch);
  ledger.landing = null;
  delete f.feedback;
  setStage(ledger, id, "merged", f.commit);
  writeLedger(root, ledger);
  console.log(`Landed feature ${id} "${f.title}" on ${ledger.base} (${f.commit.slice(0, 8)}).` +
              (rm.ok ? "" : `\n⚠ Worktree kept (${rm.out.split("\n")[0]}). Remove it yourself when done.`) + "\n");
  next();
}

// ── hold, status, stop ───────────────────────────────────────────────────────

function hold(id, reason) {
  const ledger = requireLedger();
  const f = feature(ledger, id);
  if (TERMINAL.has(f.stage)) die(`Feature ${id} is already ${f.stage}.`);
  f.reason = reason || "held by the coordinator";
  f.resumeTo = f.stage === "needs-human" ? f.resumeTo : f.stage;
  if (ledger.landing === id) ledger.landing = null;
  setStage(ledger, id, "needs-human", "hold");
  writeLedger(root, ledger);
  console.log(`Feature ${id} → needs-human.\n`);
  next();
}

function status() {
  const ledger = readLedger(root);
  console.log("BUILD");
  if (!ledger) console.log("  No build run yet.");
  else {
    console.log(`  Run ${ledger.active ? "active" : "stopped"} · lands onto ${ledger.base} · landing now: ${ledger.landing ?? "—"}`);
    const rows = Object.entries(ledger.features);
    if (!rows.length) console.log("  No features started.");
    for (const [id, f] of rows) {
      console.log(`  ${id.padStart(4)}  ${f.stage.padEnd(14)} ${String(f.attempts).padStart(1)}/${cfg.maxRepairAttempts}  ${f.title}${f.reason ? `  — ${f.reason.split("\n")[0]}` : ""}`);
    }
  }
  console.log("\nSETUP · REFINE · REVIEW");
  runsStatus(root);
}

function stop() {
  const ledger = readLedger(root);
  if (!ledger) return console.log("No run.");
  ledger.active = false;
  writeLedger(root, ledger);
  const left = Object.values(ledger.features).filter((f) => f.stage !== "merged" && existsSync(f.worktree));
  console.log("Build run stopped. Hooks no longer enforce its rules. `/ai-dev:build` resumes it.");
  console.log(left.length ? `Worktrees kept for unfinished features:\n${left.map((f) => `  ${f.worktree}`).join("\n")}`
                          : "No worktrees left: every feature in this run landed.");
}

// ── dispatch ─────────────────────────────────────────────────────────────────

const need = (n, usage) => { if (args.length < n) die(`Usage: ${ORCH} ${usage}`); };
switch (cmd) {
  case "init": init(); break;
  case "next": next(); break;
  case "start": need(1, "start <id>"); start(args[0]); break;
  case "advance": need(2, "advance <id> <stage>"); advance(args[0], args[1]); break;
  case "fail": need(1, 'fail <id> "<evidence>"'); fail(args[0], args.slice(1).join(" ")); break;
  case "prepare-land": need(1, "prepare-land <id>"); prepareLand(args[0]); break;
  case "land": need(1, "land <id>"); land(args[0]); break;
  case "hold": need(1, 'hold <id> "<reason>"'); hold(args[0], args.slice(1).join(" ")); break;
  case "status": status(); break;
  case "stop": stop(); break;
  case "run": runCommand(root, cfg, args); break;
  default:
    console.log(readFileSync(new URL(import.meta.url), "utf8").split("\n").slice(1, 27).map((l) => l.replace(/^\/\/ ?/, "")).join("\n"));
}
