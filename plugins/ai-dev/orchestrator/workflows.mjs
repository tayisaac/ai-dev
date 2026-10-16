// Stage tables for the setup, refine and review workflows.
//
// Each workflow is a list of stages. The engine (runs.mjs) walks them in order
// and the guard hook only lets the agents of the CURRENT stage start.
//
// Stage kinds:
//   code         the engine does it itself (`orch run exec`): git, installs, files
//   agents       one or more subagents write named output files in the run folder;
//                `orch run done` checks every required output before moving on
//   coordinator  Claude in your session does it (usually: ask you questions);
//                `orch run done` checks the result file before moving on
//   gate         waits for a reply you type; handled by the approvals hook
//
// Optional on any stage: skip(ctx, run) → true to pass over it.

import { existsSync, readFileSync, writeFileSync, mkdirSync, copyFileSync, statSync, mkdtempSync, cpSync, readdirSync, rmSync } from "node:fs";
import { execSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { git, tryGit, slug, parsePlanText, loadPlan, ITEM, NOTE, readLedger, excludeHome, paths, PLUGIN_ROOT } from "./lib.mjs";

/** Thrown by a code stage to park the run for the user (needs-human). */
export class Hold extends Error {}

// ── helpers ──────────────────────────────────────────────────────────────────

const read = (f) => (existsSync(f) ? readFileSync(f, "utf8") : "");
const nonEmpty = (f) => existsSync(f) && readFileSync(f, "utf8").trim().length > 0;
const tail = (s, n = 40) => String(s).trim().split("\n").slice(-n).join("\n");

function sh(command, cwd, minutes = 15) {
  try {
    return { ok: true, out: execSync(command, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: minutes * 60_000, maxBuffer: 64 * 1024 * 1024 }) };
  } catch (e) {
    return { ok: false, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
}

/** Text of one "## Heading" section of a markdown file. */
function section(text, heading) {
  const parts = text.split(/^## /m);
  const hit = parts.find((p) => p.toLowerCase().startsWith(heading.toLowerCase()));
  return hit ? hit.slice(hit.indexOf("\n") + 1) : "";
}
const bullets = (s) => (s.match(/^\s*[-*] \S.*$/gm) ?? []).filter((l) => !/^\s*[-*] _?\(?(none|tbd)\)?_?\s*$/i.test(l));

const skillFile = (ctx, name) => path.join(ctx.root, ".claude", "skills", name, "SKILL.md");
const blueprintInstalled = (root) =>
  existsSync(path.join(root, "blueprint", "build-plan.md")) && existsSync(path.join(root, ".claude", "skills", "feature", "SKILL.md"));

function setupCommand(ctx, dir) {
  const c = ctx.cfg.worktreeSetup;
  if (c === false) return null;
  if (typeof c === "string" && c !== "auto") return c;
  if (existsSync(path.join(dir, "pnpm-lock.yaml"))) return "pnpm install --frozen-lockfile";
  if (existsSync(path.join(dir, "yarn.lock"))) return "yarn install --frozen-lockfile";
  if (existsSync(path.join(dir, "bun.lockb")) || existsSync(path.join(dir, "bun.lock"))) return "bun install --frozen-lockfile";
  if (existsSync(path.join(dir, "package-lock.json"))) return "npm ci";
  return null;
}

/** Verify command, re-read from AGENTS.md each time (setup creates it mid-run). */
function verifyCommand(ctx) {
  if (ctx.cfg.verify) return ctx.cfg.verify;
  const m = read(path.join(ctx.root, "AGENTS.md")).match(/Verify:\s*`([^`]+)`/);
  return m ? m[1] : null;
}

function buildRunLanding(root) {
  const l = readLedger(root);
  return l?.active && l.landing ? l.landing : null;
}

// ── shared tail: proposal → your approval → build plan → overview → commit ──
// Used by refine (new items for a requirement) and review (items that fix findings).

/** Check a proposal.md: one ```build-plan block of new, correctly numbered items. */
export function readProposal(ctx, run) {
  const text = read(path.join(run.dir, "proposal.md"));
  const m = text.match(/```build-plan\n([\s\S]*?)```/);
  if (!m) return { error: "proposal.md has no ```build-plan fenced block with the new items." };
  const block = m[1].replace(/\s+$/, "") + "\n";
  const items = parsePlanText(block);
  if (!items.length) return { error: "The ```build-plan block has no items in the form `- [ ] 12. **Title** - description`." };
  const existing = loadPlan(ctx.root);
  const maxId = Math.max(0, ...existing.map((f) => parseInt(f.id, 10)).filter(Number.isFinite));
  const ids = new Set();
  for (const it of items) {
    if (it.done) return { error: `Item ${it.id} is ticked; new items must be unticked.` };
    if (parseInt(it.id, 10) <= maxId) return { error: `Item ${it.id} reuses an existing number. New items start at ${maxId + 1}; never renumber.` };
    if (ids.has(it.id)) return { error: `Item ${it.id} appears twice.` };
    ids.add(it.id);
    if (!it.touches?.length) return { error: `Item ${it.id} has no "touches:" note. Add the code areas it changes so parallel builds stay safe.` };
    for (const d of it.depends) {
      if (!existing.some((f) => f.id === d) && !ids.has(d) && !items.some((x) => x.id === d)) return { error: `Item ${it.id} depends on ${d}, which isn't in the build plan.` };
    }
  }
  return { block, items };
}

/**
 * Another run may have added items since this proposal was written. New items are
 * not referenced anywhere yet, so renumber them (and their depends) to follow on.
 */
function renumberIfNeeded(ctx, block) {
  const items = parsePlanText(block);
  const maxId = Math.max(0, ...loadPlan(ctx.root).map((f) => parseInt(f.id, 10)).filter(Number.isFinite));
  if (items.every((it) => parseInt(it.id, 10) > maxId)) return { block, renumbered: null };
  const map = new Map(items.map((it, i) => [it.id, String(maxId + 1 + i)]));
  const out = block.split("\n").map((line) => {
    const m = ITEM.exec(line);
    if (m) return line.replace(`] ${m[3]}.`, `] ${map.get(m[3])}.`);
    const n = /^(\s+[-*] depends:\s*)(.+)$/i.exec(line);
    if (n) return n[1] + n[2].split(",").map((d) => map.get(d.trim()) ?? d.trim()).join(", ");
    return line;
  }).join("\n");
  return { block: out, renumbered: [...map].map(([a, b]) => `${a}→${b}`).join(", ") };
}

function appendToPlan(ctx, block) {
  const file = path.join(ctx.root, "blueprint", "build-plan.md");
  const lines = read(file).split("\n");
  let last = -1;
  lines.forEach((l, i) => { if (ITEM.test(l) || (last >= 0 && i === last + 1 && NOTE.test(l))) last = i; });
  // extend over notes/sub-lines that belong to the last item
  while (last >= 0 && last + 1 < lines.length && /^\s+\S/.test(lines[last + 1])) last++;
  const insert = block.replace(/\n+$/, "").split("\n");
  if (last < 0) lines.push("", ...insert);
  else lines.splice(last + 1, 0, ...insert);
  writeFileSync(file, lines.join("\n").replace(/\n*$/, "\n"));
}

function planTail({ afterApply }) {
  return [
    {
      id: "slice", kind: "agents",
      describe: "Planner proposes build-plan items",
      agents: (ctx, run) => [{
        type: "ai-dev-planner", focus: "slice", output: "proposal.md",
        lines: [
          `Task: propose new build-plan items, written to proposal.md in the run folder. Nothing else changes.`,
          run.workflow === "refine"
            ? `Inputs: requirement.md and scout.md (and critique.md) in the run folder.`
            : `Inputs: the review report ${run.data.reportPath} — only these findings: ${(run.data.fixIds ?? []).join(", ")}.`,
          `Brief skill (to size each item): ${skillFile(ctx, "brief")}`,
          `Number new items from ${nextItemNumber(ctx)}. Put them in ONE \`\`\`build-plan fenced block, each with "depends:" and "touches:" notes.`,
        ],
      }],
      check: (ctx, run) => readProposal(ctx, run).error ?? null,
    },
    {
      id: "approve-plan", kind: "gate",
      wait: (ctx, run) => {
        const p = readProposal(ctx, run);
        const list = p.items ? p.items.map((i) => `${i.id}. ${i.title}  (touches: ${i.touches.join(", ")}${i.depends.length ? `; depends: ${i.depends.join(", ")}` : ""})`).join("\n        ") : `(${p.error})`;
        return `New build-plan items proposed in ${path.join(run.dir, "proposal.md")}:\n        ${list}\n      You type: approve plan   or   revise plan <what to change>   or   cancel ${run.id}`;
      },
      onReply: (ctx, run, text) => {
        if (/^approve plan\b/i.test(text)) return { to: "apply", msg: `approved the proposed build-plan items for ${run.id}` };
        const r = /^revise plan\b\s*([\s\S]*)$/i.exec(text);
        if (r) {
          if (!r[1].trim()) return { error: "say what to change: revise plan <changes>" };
          return { to: "slice", feedback: `The user asked for these changes to the proposed items:\n${r[1].trim()}`, msg: `sent ${run.id}'s proposed items back for revision` };
        }
        return null;
      },
    },
    {
      id: "apply", kind: "code",
      describe: "Write the approved items into the build plan",
      exec: (ctx, run) => {
        if (buildRunLanding(ctx.root)) throw new Hold(`Build feature ${buildRunLanding(ctx.root)} is landing right now. Reply retry ${run.id} once it has landed.`);
        const raw = read(path.join(run.dir, "proposal.md")).match(/```build-plan\n([\s\S]*?)```/);
        if (!raw) throw new Hold("proposal.md has no ```build-plan block.");
        const { block, renumbered } = renumberIfNeeded(ctx, raw[1].replace(/\s+$/, "") + "\n");
        const items = parsePlanText(block);
        const extra = afterApply ? afterApply(ctx, run) : [];
        appendToPlan(ctx, block);
        // Commit straight away, so your checkout is clean again within seconds and a
        // build feature can land while the overview is being regenerated.
        const files = ["blueprint/build-plan.md", ...extra];
        git(ctx.root, "add", "--", ...files);
        if (git(ctx.root, "diff", "--cached", "--name-only")) {
          git(ctx.root, "commit", "-q", "-m", run.workflow === "refine" ? `Refine requirement: ${run.data.title}` : `Plan fixes from review ${run.id}`, "--", ...files);
        }
        run.data.applied = { at: Date.now(), ids: items.map((i) => i.id), files };
        return `Added ${items.length === 1 ? "item" : "items"} ${run.data.applied.ids.join(", ")} to the build plan${renumbered ? ` (renumbered ${renumbered}, because other items were added meanwhile)` : ""}${extra.length ? ` and wrote ${extra.join(", ")}` : ""}; committed.`;
      },
    },
    {
      id: "overview", kind: "agents",
      describe: "Planner refreshes the project overview",
      agents: (ctx) => [{
        type: "ai-dev-planner", focus: "overview", output: "overview.md",
        lines: [
          `Task: run Blueprint's overview skill so the project overview includes the new build-plan items.`,
          `Overview skill: ${skillFile(ctx, "overview")}`,
          `Write a two-line note of what changed to overview.md in the run folder.`,
        ],
      }],
      check: (ctx, run) => {
        const f = path.join(ctx.root, "blueprint", "context", "project-overview.md");
        if (!existsSync(f) || statSync(f).mtimeMs < (run.data.applied?.at ?? 0)) return "blueprint/context/project-overview.md wasn't regenerated after the new items were added.";
        return null;
      },
    },
    {
      id: "commit", kind: "code",
      describe: "Commit the refreshed overview",
      exec: (ctx, run) => {
        const files = ["blueprint/context/project-overview.md", "blueprint/build-plan.md"].filter((f) => existsSync(path.join(ctx.root, f)));
        git(ctx.root, "add", "--", ...files);
        if (git(ctx.root, "diff", "--cached", "--name-only")) git(ctx.root, "commit", "-q", "-m", "Refresh project overview", "--", ...files);
        run.data.finished = true;
        const ids = run.data.applied?.ids ?? [];
        return { done: true, message: `Committed. ${ids.length === 1 ? `Build-plan item ${ids[0]} is` : `Build-plan items ${ids.join(", ")} are`} ready: run /ai-dev:build.` };
      },
    },
  ];
}

function nextItemNumber(ctx) {
  try {
    return Math.max(0, ...loadPlan(ctx.root).map((f) => parseInt(f.id, 10)).filter(Number.isFinite)) + 1;
  } catch { return 1; }
}

// ═════════════════════════════════════════════════════════════════════════════
// SETUP — one-time team setup of a repo
// ═════════════════════════════════════════════════════════════════════════════

const SURVEY_FOCUS = {
  stack: "stack, frameworks and versions, package manager, and the real dev/build/test/lint commands",
  conventions: "conventions in practice: folder layout, naming, styling, state, data fetching, error handling",
  testing: "testing and verification reality: test runner, existing tests, CI workflows, any combined verify command",
  features: "what the app already does: shipped features inferred from routes, pages, entry points and modules",
};

const setup = {
  title: "One-time setup",
  init: (ctx, args) => {
    if (args.length) throw new Error("setup takes no arguments.");
    return { id: "setup", data: {} };
  },
  stages: [
    {
      id: "preflight", kind: "code",
      describe: "Check the repo and create the setup branch",
      exec: (ctx, run) => {
        const branch = git(ctx.root, "rev-parse", "--abbrev-ref", "HEAD");
        if (branch === "HEAD") throw new Hold("The main checkout is on a detached HEAD. Switch to your main branch first.");
        if (git(ctx.root, "status", "--porcelain")) throw new Hold("The main checkout has uncommitted changes. Commit or stash them first, then retry setup.");
        const tracked = git(ctx.root, "ls-files").split("\n").filter((f) => f && !f.startsWith(".claude/"));
        const code = tracked.filter((f) => /\.(js|jsx|ts|tsx|mjs|cjs|vue|svelte|py|rb|go|java|kt|cs|php|rs|swift|scala|ex|exs)$/.test(f));
        run.data.brownfield = code.length > 0;
        run.data.skill = run.data.brownfield ? "adopt" : "onboard";
        run.data.installed = blueprintInstalled(ctx.root);
        run.data.base = branch;
        run.data.branch = "ai-dev/setup";
        if (tryGit(ctx.root, "rev-parse", "--verify", "--quiet", run.data.branch).ok) throw new Hold(`Branch ${run.data.branch} already exists. Delete it or finish the earlier setup first.`);
        git(ctx.root, "switch", "-q", "-c", run.data.branch);
        excludeHome(ctx.root);
        return `On new branch ${run.data.branch} (from ${branch}). ${run.data.brownfield ? `Existing codebase (${code.length} source files): using /adopt.` : "New project: using /onboard."} Blueprint ${run.data.installed ? "is already installed" : "needs installing"}.`;
      },
    },
    {
      id: "approve-install", kind: "gate",
      skip: (ctx, run) => run.data.installed,
      wait: () => `Blueprint isn't installed yet. Installing runs: npx create-ai-blueprint@latest --claude --yes\n      You type: approve install   or   cancel setup`,
      onReply: (ctx, run, text) => (/^approve install\b/i.test(text) ? { to: "install", msg: "approved installing AI Blueprint" } : null),
    },
    {
      id: "install", kind: "code",
      describe: "Install AI Blueprint for Claude Code",
      skip: (ctx, run) => run.data.installed,
      exec: (ctx, run) => {
        // Blueprint's installer refuses a repo that already has .claude/,
        // and --force would overwrite a team's own AGENTS.md or CLAUDE.md. So install
        // into a temporary folder and merge it in, keeping everything already here.
        if (existsSync(path.join(ctx.root, "blueprint"))) throw new Hold("A blueprint/ folder exists but Blueprint's skills don't. Remove or finish that install by hand, then retry setup.");
        const tmp = mkdtempSync(path.join(os.tmpdir(), "ai-dev-blueprint-"));
        try {
          const r = sh(`npx --yes create-ai-blueprint@latest --claude --yes --target "${tmp}"`, ctx.root, 10);
          if (!r.ok || !existsSync(path.join(tmp, "blueprint"))) throw new Hold(`The Blueprint install didn't complete:\n${tail(r.out)}`);
          const notes = [];
          cpSync(path.join(tmp, "blueprint"), path.join(ctx.root, "blueprint"), { recursive: true });
          for (const skill of readdirSync(path.join(tmp, ".claude", "skills"))) {
            const dest = path.join(ctx.root, ".claude", "skills", skill);
            if (!existsSync(dest)) cpSync(path.join(tmp, ".claude", "skills", skill), dest, { recursive: true });
          }
          const agentsMd = path.join(ctx.root, "AGENTS.md");
          if (existsSync(agentsMd)) {
            const mine = readFileSync(agentsMd, "utf8").trim();
            writeFileSync(agentsMd, `${readFileSync(path.join(tmp, "AGENTS.md"), "utf8").trimEnd()}\n\n## Project notes (from the previous AGENTS.md)\n\n${mine.replace(/^# .*\n+/, "")}\n`);
            notes.push("your existing AGENTS.md content is kept under \"Project notes\" at the end of Blueprint's AGENTS.md");
          } else copyFileSync(path.join(tmp, "AGENTS.md"), agentsMd);
          const claudeMd = path.join(ctx.root, "CLAUDE.md");
          if (existsSync(claudeMd)) {
            if (!/@AGENTS\.md/.test(readFileSync(claudeMd, "utf8"))) {
              writeFileSync(claudeMd, `${readFileSync(claudeMd, "utf8").trimEnd()}\n\n@AGENTS.md\n`);
              notes.push("your CLAUDE.md is kept, with an @AGENTS.md import added");
            } else notes.push("your CLAUDE.md is kept as is");
          } else copyFileSync(path.join(tmp, "CLAUDE.md"), claudeMd);
          if (!blueprintInstalled(ctx.root)) throw new Hold("Blueprint's files were copied in, but its skills aren't where they should be (.claude/skills/feature).");
          excludeHome(ctx.root);
          run.data.installed = true;
          return `AI Blueprint installed${notes.length ? `; ${notes.join("; ")}` : ""}.`;
        } finally {
          rmSync(tmp, { recursive: true, force: true });
        }
      },
    },
    {
      id: "repo-files", kind: "code",
      describe: "Add the ai-dev rule file, config and permission to this repo",
      exec: (ctx) => writeRepoFiles(ctx.root),
    },
    {
      id: "survey", kind: "agents",
      describe: "Four surveyors map the codebase in parallel (read-only)",
      agents: (ctx, run) => Object.entries(SURVEY_FOCUS).map(([focus, what]) => ({
        type: "ai-dev-surveyor", focus, output: `survey-${focus}.md`,
        lines: [
          `Focus: ${what}.`,
          `Method: Step 1 (the read-only survey) of ${skillFile(ctx, run.data.skill ?? "adopt")}, limited to this focus.`,
          `Write your findings to survey-${focus}.md in the run folder.`,
        ],
      })),
    },
    {
      id: "interview", kind: "coordinator",
      task: (ctx, run) =>
        `Read the four survey-*.md files in ${run.dir}. Then ask the user the intent questions from Step 2 of ${skillFile(ctx, run.data.skill)} ` +
        `(what the project is for and who uses it; whether the stack is intentional or partly legacy; what to build next; anything the survey got wrong). ` +
        `Ask 3–5 questions in ONE message, each with a suggested answer, and skip anything the surveys already answer. ` +
        `Write the answers to ${path.join(run.dir, "intent.md")}.`,
      check: (ctx, run) => (nonEmpty(path.join(run.dir, "intent.md")) ? null : "intent.md is missing or empty in the run folder."),
    },
    {
      id: "draft", kind: "agents",
      describe: "Planner drafts the plans, standards and commands",
      agents: (ctx, run) => [{
        type: "ai-dev-planner", focus: "draft", output: "draft-summary.md",
        lines: [
          `Task: Step 3 (generate the inputs) of ${skillFile(ctx, run.data.skill)}, using the survey-*.md files and intent.md in the run folder.`,
          `Write blueprint/project-plan.md, blueprint/build-plan.md (shipped features ticked), blueprint/context/coding-standards.md, and the Commands section of AGENTS.md.`,
          `Visibility is decided: Blueprint workflow files are committed. Don't run /overview, /ci or /tests yet.`,
          `Then write draft-summary.md in the run folder: what you wrote, and every TODO (confirm) item.`,
        ],
      }],
      check: (ctx) => {
        if (!loadPlan(ctx.root).length) return "blueprint/build-plan.md has no numbered checklist items yet.";
        if (!/^## Commands/m.test(read(path.join(ctx.root, "AGENTS.md")))) return "AGENTS.md has no Commands section.";
        return null;
      },
    },
    {
      id: "approve-plans", kind: "gate",
      wait: (ctx, run) =>
        `Plans drafted. Read ${path.join(run.dir, "draft-summary.md")}, then blueprint/project-plan.md, blueprint/build-plan.md, blueprint/context/coding-standards.md and AGENTS.md (git diff shows every change).\n      You type: approve plans   or   revise plans <what to change>   or   cancel setup`,
      onReply: (ctx, run, text) => {
        if (/^approve plans\b/i.test(text)) return { to: "guardrails", msg: "approved the drafted plans" };
        const r = /^revise plans\b\s*([\s\S]*)$/i.exec(text);
        if (r) {
          if (!r[1].trim()) return { error: "say what to change: revise plans <changes>" };
          return { to: "draft", feedback: `The user asked for these changes to the plans:\n${r[1].trim()}`, msg: "sent the plans back for revision" };
        }
        return null;
      },
    },
    {
      id: "guardrails", kind: "agents",
      describe: "CI engineer sets up tests (if missing) and one Verify command",
      agents: (ctx) => [{
        type: "ai-dev-ci-engineer", focus: "guardrails", output: "guardrails.md",
        lines: [
          `Task: if the project has no unit test runner, follow ${skillFile(ctx, "tests")} (unit). Then follow ${skillFile(ctx, "ci")} to define ONE Verify command, recorded as "Verify: \`...\`" in AGENTS.md.`,
          `Verify must pass on the current code. Don't push, and don't enable a pre-push hook.`,
          `Write guardrails.md in the run folder: what you added or changed, and the Verify command.`,
        ],
      }],
      check: (ctx) => {
        const v = verifyCommand(ctx);
        if (!v) return 'AGENTS.md has no "Verify: `...`" line.';
        const r = sh(v, ctx.root);
        return r.ok ? null : `Verify (\`${v}\`) fails on the current code:\n${tail(r.out)}`;
      },
    },
    {
      id: "overview", kind: "agents",
      describe: "Planner generates the project overview",
      agents: (ctx) => [{
        type: "ai-dev-planner", focus: "overview", output: "overview.md",
        lines: [`Task: run Blueprint's overview skill (${skillFile(ctx, "overview")}). Write a two-line note to overview.md in the run folder.`],
      }],
      check: (ctx) => (/_Not generated yet/.test(read(path.join(ctx.root, "blueprint", "context", "project-overview.md"))) || !existsSync(path.join(ctx.root, "blueprint", "context", "project-overview.md"))
        ? "blueprint/context/project-overview.md hasn't been generated." : null),
    },
    {
      id: "commit", kind: "code",
      describe: "Commit the setup on the setup branch",
      exec: (ctx, run) => {
        git(ctx.root, "add", "-A");
        if (git(ctx.root, "diff", "--cached", "--name-only")) git(ctx.root, "commit", "-q", "-m", "Set up AI Blueprint and ai-dev");
        return `Committed the setup on ${run.data.branch}.`;
      },
    },
    {
      id: "trial", kind: "code",
      describe: "Trial worktree: prove a fresh checkout installs and passes Verify",
      exec: (ctx, run) => {
        const dir = path.join(ctx.P.worktrees, "setup-trial");
        tryGit(ctx.root, "worktree", "remove", "--force", dir);
        mkdirSync(ctx.P.worktrees, { recursive: true });
        const add = tryGit(ctx.root, "worktree", "add", "--detach", dir, "HEAD");
        if (!add.ok) throw new Hold(`Couldn't create a trial worktree:\n${add.out}`);
        try {
          for (const f of ctx.cfg.copyFiles ?? []) if (existsSync(path.join(ctx.root, f))) copyFileSync(path.join(ctx.root, f), path.join(dir, f));
          const setupCmd = setupCommand(ctx, dir);
          if (setupCmd) {
            const s = sh(setupCmd, dir);
            if (!s.ok) throw new Hold(`A fresh worktree couldn't install dependencies (\`${setupCmd}\`):\n${tail(s.out)}\nFix worktreeSetup or copyFiles in .claude/ai-dev.json, then retry setup.`);
          }
          const v = verifyCommand(ctx);
          const r = sh(v, dir);
          if (!r.ok) throw new Hold(`Verify passes in your checkout but fails in a fresh worktree:\n${tail(r.out)}\nUsually a missing local file: add it to copyFiles in .claude/ai-dev.json, then retry setup.`);
        } finally {
          tryGit(ctx.root, "worktree", "remove", "--force", dir);
        }
        return "A fresh worktree installs and passes Verify, so build runs will work.";
      },
    },
    {
      id: "doctor", kind: "agents",
      describe: "Health check with Blueprint's doctor (read-only)",
      agents: (ctx) => [{
        type: "ai-dev-surveyor", focus: "doctor", output: "doctor.md",
        lines: [`Task: run the checks in ${skillFile(ctx, "doctor")} read-only. Don't reset or change anything, even where the skill offers to. Write the results to doctor.md in the run folder.`],
      }],
    },
    {
      id: "approve-land", kind: "gate",
      wait: (ctx, run) =>
        `Setup is committed on ${run.data.branch}. Health check: ${path.join(run.dir, "doctor.md")}. Review: git log --stat ${run.data.base}..${run.data.branch}\n` +
        `      You type: land setup   (fast-forward ${run.data.base})   or   finish setup   (keep the branch; push it and open a PR yourself)`,
      onReply: (ctx, run, text) => {
        if (/^land setup\b/i.test(text)) return { to: "land", msg: `approved landing the setup onto ${run.data.base}` };
        if (/^finish setup\b/i.test(text)) return { to: "done", msg: `finished setup; ${run.data.branch} is kept for a PR` };
        return null;
      },
    },
    {
      id: "land", kind: "code",
      describe: "Fast-forward your branch to the setup",
      exec: (ctx, run) => {
        if (git(ctx.root, "status", "--porcelain")) throw new Hold("The checkout has uncommitted changes; commit or stash them, then retry.");
        git(ctx.root, "switch", "-q", run.data.base);
        const ff = tryGit(ctx.root, "merge", "--ff-only", run.data.branch);
        if (!ff.ok) throw new Hold(`Couldn't fast-forward ${run.data.base}:\n${ff.out}`);
        tryGit(ctx.root, "branch", "-d", run.data.branch);
        return { done: true, message: `Setup landed on ${run.data.base}. The team can now use /ai-dev:refine, /ai-dev:build and /ai-dev:review.` };
      },
    },
  ],
};

// ═════════════════════════════════════════════════════════════════════════════
// REFINE — turn a requirement (a file, or one sentence) into build-plan items
// ═════════════════════════════════════════════════════════════════════════════

const REQUIREMENT_TEMPLATE = (title, source) => `# Requirement: ${title}

${source}

## Problem and users

## In scope

## Out of scope

## Acceptance criteria

## Rules and edge cases

## Non-functional needs

## Must keep working

## Assumptions

## Open questions
`;

const requirementReady = (run) => {
  const t = read(path.join(run.dir, "requirement.md"));
  if (bullets(section(t, "Acceptance criteria")).length === 0) return 'requirement.md has no acceptance criteria yet ("## Acceptance criteria" needs at least one bullet).';
  const open = bullets(section(t, "Open questions"));
  if (open.length) return `requirement.md still has ${open.length} open question(s). Resolve them, or move them to Assumptions if the user said "use assumptions".`;
  return null;
};

const refine = {
  title: "Refine a requirement",
  init: (ctx, args) => {
    if (!blueprintInstalled(ctx.root)) throw new Error("Blueprint isn't set up in this repo yet. Run /ai-dev:setup first.");
    const quick = args.includes("--quick");
    const text = args.filter((a) => a !== "--quick").join(" ").trim();
    if (!text) throw new Error('Give a requirement: /ai-dev:refine "<one sentence>"  or  /ai-dev:refine <path/to/requirement.md>');
    const file = path.resolve(ctx.root, text);
    const isFile = existsSync(file) && statSync(file).isFile();
    const title = isFile ? path.basename(file).replace(/\.[^.]+$/, "").replace(/[-_]+/g, " ") : text.replace(/^["']|["']$/g, "");
    // Short, readable id: whole words up to ~28 characters ("refine-customers-can-save").
    let short = "";
    for (const w of slug(title).split("-").filter(Boolean)) {
      if (short && short.length + w.length + 1 > 28) break;
      short = short ? `${short}-${w}` : w;
    }
    const base = `refine-${short || "requirement"}`;
    return { id: base, data: { quick, mode: isFile ? "file" : "sentence", source: isFile ? path.relative(ctx.root, file) : text, title: title.slice(0, 80), slug: base.replace(/^refine-/, "") } };
  },
  stages: [
    {
      id: "intake", kind: "code",
      describe: "Start the working draft of the requirement",
      exec: (ctx, run) => {
        mkdirSync(run.dir, { recursive: true });
        const src = run.data.mode === "file"
          ? `## Original requirement\n\n${read(path.join(ctx.root, run.data.source)).trim()}\n`
          : `> Starting point: "${run.data.source}"`;
        writeFileSync(path.join(run.dir, "requirement.md"), REQUIREMENT_TEMPLATE(run.data.title, src));
        return `Working draft: ${path.join(run.dir, "requirement.md")} (${run.data.mode === "file" ? "from your file" : "from one sentence, so expect an interview"}).`;
      },
    },
    {
      id: "scout", kind: "agents",
      describe: "Code scout checks the requirement against the codebase (read-only)",
      agents: (ctx, run) => [
        {
          type: "ai-dev-code-scout", focus: "code", output: "scout.md",
          lines: [
            `Requirement draft: requirement.md in the run folder.`,
            `Method: ${skillFile(ctx, "explore")} (read-only). For an enhancement, also read the original feature's archived spec under blueprint/history/features/.`,
            `Write scout.md: what already exists, affected areas with suggested touches tags, code to reuse, risks, related build-plan items by number, and questions only the user can answer.`,
          ],
        },
        {
          type: "ai-dev-designer", focus: "ui", output: "mockups.md", optional: true,
          lines: [`Only if this requirement changes UI: follow ${skillFile(ctx, "prototype")}, save mockups in mockups/ in the run folder, and list them in mockups.md.`],
        },
      ],
    },
    {
      id: "interview", kind: "coordinator",
      task: (ctx, run) =>
        `Refine ${path.join(run.dir, "requirement.md")} WITH THE USER. Read scout.md first so your questions are specific to this codebase. ` +
        `Open with your best one-line reading of what they want and the biggest unknown. Ask 2–3 questions per round, each with a suggested answer they can accept ("1 yes, 2 yes"). ` +
        `Cover only what matters for this feature: users and main flow; in and out of scope; rules and edge cases; data; non-functional needs; for an enhancement, what must keep working. ` +
        `After each round, update requirement.md (acceptance criteria as testable bullets; unanswered points under Open questions). ` +
        `Stop when users, flow, scope, data and acceptance criteria are concrete and nothing contradicts${run.data.quick ? ", aiming for about three rounds (--quick)" : ""}. ` +
        `If the user says "use assumptions", move open points to Assumptions with your best guess. "more depth" means keep going.`,
      check: (ctx, run) => requirementReady(run),
    },
    {
      id: "critique", kind: "agents",
      describe: "Analyst critiques the draft requirement (read-only)",
      agents: (ctx, run) => [{
        type: "ai-dev-analyst", focus: "critique", output: "critique.md",
        lines: [
          `Inputs: requirement.md and scout.md in the run folder; blueprint/project-plan.md for conflicts.`,
          `Coverage checklist: the areas listed in Step 2 of ${skillFile(ctx, "discovery")}.`,
          `Write critique.md with "## Blocking questions" (only what must be answered before building; "- none" if nothing) and "## Suggestions".`,
        ],
      }],
    },
    {
      id: "resolve", kind: "coordinator",
      task: (ctx, run) =>
        `Read ${path.join(run.dir, "critique.md")}. If it lists blocking questions, ask the user them in ONE round (with suggested answers) and update requirement.md. ` +
        `Fold any suggestions you agree with into requirement.md. If there are no blocking questions, just say so.`,
      check: (ctx, run) => requirementReady(run),
    },
    ...planTail({
      afterApply: (ctx, run) => {
        const dir = path.join(ctx.root, "docs", "requirements");
        mkdirSync(dir, { recursive: true });
        let name = `${run.data.slug}.md`;
        for (let i = 2; existsSync(path.join(dir, name)); i++) name = `${run.data.slug}-${i}.md`;
        copyFileSync(path.join(run.dir, "requirement.md"), path.join(dir, name));
        run.data.requirementPath = `docs/requirements/${name}`;
        return [run.data.requirementPath];
      },
    }),
  ],
};

// ═════════════════════════════════════════════════════════════════════════════
// REVIEW — PR, branch, or audit of existing code; report only, never edits code
// ═════════════════════════════════════════════════════════════════════════════

const LENS_AGENT = {
  correctness: "ai-dev-correctness-reviewer",
  security: "ai-dev-security-reviewer",
  performance: "ai-dev-performance-reviewer",
  quality: "ai-dev-quality-reviewer",
};
const ALL_AUDIT_LENSES = ["security", "performance", "quality", "tests"];

export const FINDING_FIELDS = ["id", "lens", "severity", "title", "file", "evidence", "recommendation"];

function readFindings(run) {
  const out = [];
  for (const lens of run.data.agentLenses) {
    const f = path.join(run.dir, `findings-${lens}.json`);
    const arr = JSON.parse(read(f));
    out.push(...arr);
  }
  return out;
}

function checkFindingsFile(file) {
  let arr;
  try { arr = JSON.parse(read(file)); } catch (e) { return `${path.basename(file)} isn't valid JSON (${e.message}).`; }
  if (!Array.isArray(arr)) return `${path.basename(file)} must be a JSON array (use [] for no findings).`;
  for (const [i, f] of arr.entries()) {
    const missing = FINDING_FIELDS.filter((k) => !(k in f) || f[k] === "");
    if (missing.length) return `${path.basename(file)} finding #${i + 1} is missing: ${missing.join(", ")}.`;
    if (!/^P[0-3]$/.test(f.severity)) return `${path.basename(file)} finding ${f.id} has severity "${f.severity}"; use P0, P1, P2 or P3.`;
  }
  return null;
}

const review = {
  title: "Code review",
  init: (ctx, args) => {
    const [mode, target, ...rest] = args;
    if (mode === "pr") {
      if (!/^\d+$/.test(target ?? "")) throw new Error("Usage: /ai-dev:review pr <number>");
      return { id: `review-pr-${target}`, data: { mode, target, lenses: ["correctness", "security", "performance", "quality"] } };
    }
    if (mode === "branch") {
      if (!target) throw new Error("Usage: /ai-dev:review branch <branch> [--base <branch>]");
      const bi = rest.indexOf("--base");
      return { id: `review-branch-${slug(target).slice(0, 30)}`, data: { mode, target, base: bi >= 0 ? rest[bi + 1] : null, lenses: ["correctness", "security", "performance", "quality"] } };
    }
    if (mode === "audit") {
      const where = target ?? "full";
      const lenses = rest.filter((l) => ALL_AUDIT_LENSES.includes(l));
      const bad = rest.filter((l) => !ALL_AUDIT_LENSES.includes(l));
      if (bad.length) throw new Error(`Unknown lens: ${bad.join(", ")}. Use any of: ${ALL_AUDIT_LENSES.join(", ")}.`);
      if (where !== "full" && !existsSync(path.join(ctx.root, where))) throw new Error(`No such path: ${where}`);
      return { id: `review-audit-${slug(where === "full" ? "full" : where).slice(0, 30)}`, data: { mode, target: where, lenses: lenses.length ? lenses : ALL_AUDIT_LENSES } };
    }
    throw new Error("Usage: /ai-dev:review pr <number> | branch <branch> [--base <branch>] | audit <path|full> [security] [performance] [quality] [tests]");
  },
  stages: [
    {
      id: "scope", kind: "code",
      describe: "Work out exactly what's under review",
      exec: (ctx, run) => {
        const d = run.data;
        mkdirSync(run.dir, { recursive: true });
        let files;
        if (d.mode === "audit") {
          d.reviewDir = ctx.root;
          files = git(ctx.root, "ls-files", ...(d.target === "full" ? [] : ["--", d.target])).split("\n").filter(Boolean)
            .filter((f) => !/(^|\/)(node_modules|vendor|dist|build|coverage|\.next|\.claude|\.agents|blueprint)\//.test(f) && !/\.(min\.js|lock|map|svg|png|jpe?g|gif|ico|woff2?)$|package-lock\.json$|pnpm-lock\.yaml$|yarn\.lock$/.test(f));
          d.diffCommand = null;
        } else {
          let ref;
          if (d.mode === "pr") {
            const gh = sh(`gh pr view ${d.target} --json baseRefName,title,url`, ctx.root, 2);
            if (gh.ok) { try { const j = JSON.parse(gh.out); d.base = j.baseRefName; d.title = j.title; d.url = j.url; } catch {} }
            if (!d.base) {
              const head = tryGit(ctx.root, "symbolic-ref", "--short", "refs/remotes/origin/HEAD");
              d.base = head.ok ? head.out.replace(/^origin\//, "") : "main";
            }
            const f1 = tryGit(ctx.root, "fetch", "-q", "origin", `+pull/${d.target}/head:refs/ai-dev/pr-${d.target}`);
            if (!f1.ok) throw new Hold(`Couldn't fetch PR #${d.target} from origin:\n${f1.out}`);
            tryGit(ctx.root, "fetch", "-q", "origin", d.base);
            ref = `refs/ai-dev/pr-${d.target}`;
            d.baseRef = tryGit(ctx.root, "rev-parse", "--verify", "--quiet", `origin/${d.base}`).ok ? `origin/${d.base}` : d.base;
          } else {
            if (!tryGit(ctx.root, "rev-parse", "--verify", "--quiet", d.target).ok) throw new Hold(`No branch ${d.target} in this repo.`);
            ref = d.target;
            d.base = d.base ?? readLedger(ctx.root)?.base ?? "main";
            d.baseRef = d.base;
          }
          const mb = tryGit(ctx.root, "merge-base", d.baseRef, ref);
          if (!mb.ok) throw new Hold(`Couldn't find where ${ref} branched from ${d.baseRef}:\n${mb.out}`);
          d.mergeBase = mb.out;
          d.reviewDir = path.join(ctx.P.worktrees, run.id);
          tryGit(ctx.root, "worktree", "remove", "--force", d.reviewDir);
          mkdirSync(ctx.P.worktrees, { recursive: true });
          const add = tryGit(ctx.root, "worktree", "add", "--detach", d.reviewDir, ref);
          if (!add.ok) throw new Hold(`Couldn't create the review worktree:\n${add.out}`);
          files = git(ctx.root, "diff", "--name-only", `${d.mergeBase}..${ref}`).split("\n").filter(Boolean);
          d.diffCommand = `git -C ${d.reviewDir} diff ${d.mergeBase}..HEAD`;
        }
        if (!files.length) throw new Hold("Nothing to review: no files in scope.");
        d.fileCount = files.length;
        d.agentLenses = [...new Set(d.lenses.map((l) => (l === "tests" ? "quality" : l)))];
        const areas = {};
        for (const f of files) { const a = f.includes("/") ? f.split("/").slice(0, 2).join("/") : "(root)"; areas[a] = (areas[a] ?? 0) + 1; }
        writeFileSync(path.join(run.dir, "scope.md"), [
          `# Review scope: ${run.id}`, "",
          `- Mode: ${d.mode}${d.title ? ` — ${d.title}` : ""}${d.url ? ` (${d.url})` : ""}`,
          `- Code to read: ${d.reviewDir}`,
          d.diffCommand ? `- Changes under review: \`${d.diffCommand}\`  (against ${d.baseRef})` : `- Target: ${d.target === "full" ? "the whole project" : d.target}`,
          `- Lenses: ${d.lenses.join(", ")}`,
          `- Files: ${files.length}`, "", "## Areas", "",
          ...Object.entries(areas).sort((a, b) => b[1] - a[1]).map(([a, n]) => `- ${a} (${n})`), "",
          "## Files", "", ...files.slice(0, 500).map((f) => `- ${f}`), files.length > 500 ? `- … and ${files.length - 500} more` : "",
        ].join("\n"));
        return `Scope: ${files.length} file(s) across ${Object.keys(areas).length} area(s); lenses: ${d.lenses.join(", ")}.`;
      },
    },
    {
      id: "review", kind: "agents",
      describe: "Lens reviewers work in parallel (fresh context, read-only)",
      agents: (ctx, run) => run.data.agentLenses.map((lens) => ({
        type: LENS_AGENT[lens], focus: lens, output: `findings-${lens}.json`,
        lines: [
          `Scope: scope.md in the run folder (the code, the diff if any, and the file list).`,
          lens === "correctness"
            ? `Method: look for correctness bugs in the changes, the way Claude Code's /code-review does. If the PR or branch links a requirement or spec, also check the code does what it says.`
            : `Method: the ${lens === "quality" ? run.data.lenses.filter((l) => l === "quality" || l === "tests").join(" and ") : lens} lens of ${skillFile(ctx, "audit")} (Step 3 and the severity rules), but DON'T write blueprint/context/findings.md.`,
          `Write findings-${lens}.json in the run folder: a JSON array (or []) of {"id","lens","severity":"P0|P1|P2|P3","title","file","line","evidence","recommendation"}.`,
        ],
      })),
      check: (ctx, run) => {
        for (const lens of run.data.agentLenses) {
          const e = checkFindingsFile(path.join(run.dir, `findings-${lens}.json`));
          if (e) return e;
        }
        return null;
      },
    },
    {
      id: "validate", kind: "agents",
      describe: "Validator tries to confirm every P0/P1 finding",
      skip: (ctx, run) => !readFindings(run).some((f) => /^P[01]$/.test(f.severity)),
      agents: () => [{
        type: "ai-dev-validator", focus: "validate", output: "validated.json",
        lines: [
          `Inputs: every findings-*.json and scope.md in the run folder.`,
          `For EVERY P0 and P1 finding, try to confirm it with a concrete code path, a reproduction or a test. Don't fix anything.`,
          `Write validated.json: an array of {"id","verdict":"confirmed|downgraded|rejected","severity":"P0-P3 after your check","evidence"}.`,
        ],
      }],
      check: (ctx, run) => {
        let v;
        try { v = JSON.parse(read(path.join(run.dir, "validated.json"))); } catch { return "validated.json isn't valid JSON."; }
        const byId = new Map(v.map((x) => [x.id, x]));
        for (const f of readFindings(run).filter((f) => /^P[01]$/.test(f.severity))) {
          const x = byId.get(f.id);
          if (!x) return `validated.json has no verdict for ${f.id} (${f.severity}).`;
          if (!["confirmed", "downgraded", "rejected"].includes(x.verdict)) return `${f.id}: verdict must be confirmed, downgraded or rejected.`;
          if (x.verdict === "confirmed" && !String(x.evidence ?? "").trim()) return `${f.id} is confirmed without evidence.`;
        }
        return null;
      },
    },
    {
      id: "report", kind: "code",
      describe: "Merge, number and write the review report",
      exec: (ctx, run) => {
        const d = run.data;
        const verdicts = new Map((existsSync(path.join(run.dir, "validated.json")) ? JSON.parse(read(path.join(run.dir, "validated.json"))) : []).map((x) => [x.id, x]));
        let rejected = 0;
        const kept = [];
        for (const f of readFindings(run)) {
          const v = verdicts.get(f.id);
          if (v?.verdict === "rejected") { rejected++; continue; }
          kept.push({ ...f, severity: v?.severity && /^P[0-3]$/.test(v.severity) ? v.severity : f.severity, confirmedBy: v?.verdict === "confirmed" ? v.evidence : null });
        }
        // Same file, line and title from two lenses → one finding.
        const seen = new Map();
        for (const f of kept) {
          const key = `${f.file}:${f.line ?? ""}:${f.title.toLowerCase().replace(/\W+/g, " ").trim()}`;
          const prev = seen.get(key);
          if (!prev) seen.set(key, f);
          else { prev.lens = `${prev.lens}, ${f.lens}`; if (f.severity < prev.severity) prev.severity = f.severity; }
        }
        const findings = [...seen.values()].sort((a, b) => a.severity.localeCompare(b.severity) || a.file.localeCompare(b.file));
        findings.forEach((f, i) => { f.rid = `R-${String(i + 1).padStart(2, "0")}`; f.status = "open"; });
        d.findings = findings.map(({ rid, severity, title, file, line, lens, status }) => ({ rid, severity, title, file, line, lens, status }));
        d.rejected = rejected;
        d.reportPath = d.mode === "pr" ? path.relative(ctx.root, path.join(run.dir, "report.md")) : `docs/reviews/${run.id}.md`;
        writeReport(ctx, run, findings);
        const counts = ["P0", "P1", "P2", "P3"].map((s) => `${findings.filter((f) => f.severity === s).length} ${s}`).join(", ");
        return `Report: ${d.reportPath} — ${findings.length} finding(s) (${counts}); ${rejected} rejected by the validator.`;
      },
    },
    {
      id: "triage", kind: "gate",
      wait: (ctx, run) => {
        const d = run.data;
        const top = d.findings.filter((f) => f.status === "open").slice(0, 8).map((f) => `${f.rid} [${f.severity}] ${f.title} (${f.file}${f.line ? `:${f.line}` : ""})`).join("\n        ");
        return `Review report: ${d.reportPath}\n        ${top || "(no open findings)"}\n      You type: ` +
          (d.mode === "pr"
            ? `finish review   (the report has a ready-to-paste comment for each finding)`
            : `fix R-01 R-02 …   (plan fixes as build-plan items)   ·   accept R-05 <reason>   ·   finish review`);
      },
      onReply: (ctx, run, text) => {
        const d = run.data;
        if (/^finish review\b/i.test(text)) return { to: "close", msg: `finished review ${run.id}` };
        if (d.mode === "pr" && /^(fix|accept)\b/i.test(text)) return { error: "a PR review only produces a report; the PR author fixes it. Reply: finish review" };
        const fx = /^fix\s+(.+)$/i.exec(text);
        if (fx) {
          const ids = fx[1].toUpperCase().split(/[\s,]+/).filter((x) => /^R-\d+$/.test(x));
          const unknown = ids.filter((x) => !d.findings.some((f) => f.rid === x && f.status === "open"));
          if (!ids.length) return { error: "name the findings to fix, e.g. fix R-01 R-03" };
          if (unknown.length) return { error: `not open findings in this review: ${unknown.join(", ")}` };
          d.fixIds = ids;
          return { to: "slice", msg: `will plan fixes for ${ids.join(", ")}` };
        }
        const ac = /^accept\s+(R-\d+)\s*([\s\S]*)$/i.exec(text);
        if (ac) {
          const f = d.findings.find((x) => x.rid === ac[1].toUpperCase());
          if (!f) return { error: `no finding ${ac[1]} in this review` };
          if (!ac[2].trim()) return { error: `give a reason: accept ${f.rid} <reason>` };
          f.status = "accepted"; f.reason = ac[2].trim();
          rewriteReportStatus(ctx, run);
          return { stay: true, msg: `accepted ${f.rid} (${f.reason})` };
        }
        return null;
      },
    },
    ...planTail({
      afterApply: (ctx, run) => {
        for (const f of run.data.findings) if (run.data.fixIds?.includes(f.rid)) f.status = "planned";
        rewriteReportStatus(ctx, run);
        return run.data.mode === "pr" ? [] : [run.data.reportPath];
      },
    }).map((s) => (s.id === "commit" ? { ...s, id: "commit", next: "close" } : s)),
    {
      id: "close", kind: "code",
      describe: "Finish the review",
      exec: (ctx, run) => {
        const d = run.data;
        if (d.reviewDir && d.reviewDir !== ctx.root) tryGit(ctx.root, "worktree", "remove", "--force", d.reviewDir);
        if (d.mode !== "pr" && !d.finished) {
          if (buildRunLanding(ctx.root)) throw new Hold(`Build feature ${buildRunLanding(ctx.root)} is landing right now. Retry once it has landed.`);
          git(ctx.root, "add", "--", d.reportPath);
          if (git(ctx.root, "diff", "--cached", "--name-only")) git(ctx.root, "commit", "-q", "-m", `Review report ${run.id}`, "--", d.reportPath);
        }
        return { done: true, message: `Review finished. Report: ${d.reportPath}${d.mode === "pr" ? " (not committed: it's about someone else's PR)" : " (committed)"}.` };
      },
    },
  ],
};

function writeReport(ctx, run, findings) {
  const d = run.data;
  const sev = { P0: "must not ship", P1: "likely bug or real risk", P2: "worth fixing", P3: "small cleanup" };
  const lines = [
    `# Code review: ${d.mode === "pr" ? `PR #${d.target}${d.title ? ` — ${d.title}` : ""}` : d.mode === "branch" ? `branch ${d.target}` : `${d.target === "full" ? "whole project" : d.target}`}`,
    "",
    `Run \`${run.id}\` · ${new Date().toISOString().slice(0, 10)} · lenses: ${d.lenses.join(", ")} · ${d.fileCount} file(s)${d.url ? ` · ${d.url}` : ""}`,
    "",
    `${findings.length} finding(s) after validation; ${d.rejected} rejected as unconfirmed. P0/P1 findings were checked by a separate validator.`,
    "",
    "| ID | Severity | Status | Lens | Finding | Where |",
    "| --- | --- | --- | --- | --- | --- |",
    ...findings.map((f) => `| ${f.rid} | ${f.severity} | ${f.status} | ${f.lens} | ${f.title.replace(/\|/g, "\\|")} | \`${f.file}${f.line ? `:${f.line}` : ""}\` |`),
    "",
  ];
  for (const f of findings) {
    lines.push(
      `## ${f.rid} [${f.severity}] ${f.title}`, "",
      `**Where:** \`${f.file}${f.line ? `:${f.line}` : ""}\` · **Lens:** ${f.lens} · **Severity:** ${f.severity} (${sev[f.severity]}) · **Status:** ${f.status}`, "",
      `**Evidence:** ${f.evidence}`, "",
      ...(f.confirmedBy ? [`**Confirmed by validator:** ${f.confirmedBy}`, ""] : []),
      `**Recommendation:** ${f.recommendation}`, "",
      ...(d.mode === "pr" ? [`**Suggested PR comment** (on \`${f.file}${f.line ? `:${f.line}` : ""}\`):`, "", `> ${f.severity}: ${f.title}. ${f.recommendation}`.replace(/\n/g, "\n> "), ""] : []),
    );
  }
  const out = path.join(ctx.root, d.reportPath);
  mkdirSync(path.dirname(out), { recursive: true });
  writeFileSync(out, lines.join("\n"));
}

/** Update the Status column and headers in the report after accept/fix. */
function rewriteReportStatus(ctx, run) {
  const out = path.join(ctx.root, run.data.reportPath);
  let t = read(out);
  for (const f of run.data.findings) {
    t = t.replace(new RegExp(`^\\| ${f.rid} \\| (P[0-3]) \\| [a-z]+ \\|`, "m"), `| ${f.rid} | $1 | ${f.status} |`);
    t = t.replace(new RegExp(`(## ${f.rid} [\\s\\S]*?\\*\\*Status:\\*\\* )[a-z]+`), `$1${f.status}${f.reason ? ` — ${f.reason.replace(/\$/g, "$$$$")}` : ""}`);
  }
  writeFileSync(out, t);
}

export const WORKFLOWS = { setup, refine, review };

/** Agent types that only read code and write to their run folder. */
// The plugin's per-repo files, committed with setup so the whole team shares them:
//   .claude/rules/ai-dev.md   has Claude suggest /ai-dev commands for plain-language requests
//   .claude/ai-dev.json       concurrency, repairs, Verify, worktree setup (kept if it exists)
//   .claude/settings.json     allows Bash(ai-dev-orch *) so the coordinator isn't prompted each step
export function writeRepoFiles(root) {
  const P = paths(root), done = [];
  mkdirSync(path.dirname(P.rules), { recursive: true });
  copyFileSync(path.join(PLUGIN_ROOT, "templates", "rules-ai-dev.md"), P.rules);
  done.push(".claude/rules/ai-dev.md");
  if (!existsSync(P.config)) {
    copyFileSync(path.join(PLUGIN_ROOT, "templates", "ai-dev.json"), P.config);
    done.push(".claude/ai-dev.json");
  }
  const settingsFile = path.join(root, ".claude", "settings.json");
  let settings = {};
  if (existsSync(settingsFile)) {
    try { settings = JSON.parse(readFileSync(settingsFile, "utf8")); }
    catch { throw new Hold(".claude/settings.json isn't valid JSON. Fix it, then retry setup."); }
  }
  const allow = (settings.permissions ??= {}).allow ??= [];
  if (!allow.includes("Bash(ai-dev-orch *)")) {
    allow.push("Bash(ai-dev-orch *)");
    writeFileSync(settingsFile, JSON.stringify(settings, null, 2) + "\n");
    done.push("an allow rule for ai-dev-orch in .claude/settings.json");
  }
  return `Added ${done.join(", ")}.`;
}

export const READ_ONLY_AGENTS = new Set([
  "ai-dev-surveyor", "ai-dev-code-scout", "ai-dev-analyst", "ai-dev-designer",
  "ai-dev-correctness-reviewer", "ai-dev-security-reviewer", "ai-dev-performance-reviewer",
  "ai-dev-quality-reviewer", "ai-dev-validator",
]);
