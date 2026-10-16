#!/usr/bin/env node
// PreToolUse hook: the hard rules of the ai-dev plugin.
//
// While a build run or any setup/refine/review run is active, this hook:
//   1. Lets an ai-dev-* subagent start only for the stage its feature or run is at.
//   2. Blocks git commands that move branches, rewrite history or land work, for
//      everyone. Only ai-dev-orch does those. Only ai-dev-lander may commit.
//   3. Limits where each agent may write:
//        read-only agents (surveyors, scouts, analyst, reviewers, validator) → their run folder
//        planner → the run folder, blueprint/, AGENTS.md, CLAUDE.md
//        build agents → their feature worktree (spec writer, verifier, reviewer: its blueprint/ only)
//        coordinator → anything except feature worktrees
//   4. Stops anyone editing the run state, the plugin's own files, the repo's ai-dev config
//      and rule file, or the project's Claude Code settings.
//   5. Lets only the coordinator (main session) run ai-dev-orch.
//
// With nothing active it allows everything, except starting ai-dev-* subagents.
//
// Guardrails against drift, not a security boundary: a determined agent could
// disguise a shell command past the string checks below.

import { readFileSync, writeSync } from "node:fs";
import path from "node:path";
import {
  mainRoot, paths, readLedger, writeLedger, readRuns, writeRuns, AGENT_FOR_STAGE, AGENT_PREFIX,
  TERMINAL, RUN_TERMINAL, bareAgent, loadConfig, PLUGIN_ROOT,
} from "./lib.mjs";
import { READ_ONLY_AGENTS } from "./workflows.mjs";
import { stageOf, expectedAgents, context } from "./runs.mjs";

function deny(reason) {
  writeSync(1, JSON.stringify({ // sync write: process.exit can cut off async pipe writes
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: `[ai-dev] ${reason}`,
    },
  }));
  process.exit(0);
}
const allow = () => process.exit(0); // no opinion: normal permission flow applies

let input;
try { input = JSON.parse(readFileSync(0, "utf8")); } catch { allow(); }

const tool = input.tool_name;
const ti = input.tool_input ?? {};
const agentType = input.agent_type ? bareAgent(input.agent_type) : null; // set inside subagents
const inSubagent = Boolean(input.agent_id);
const isKitAgent = typeof agentType === "string" && agentType.startsWith(AGENT_PREFIX);
const BUILD_AGENTS = new Set(Object.values(AGENT_FOR_STAGE));

let root, ledger, runsData;
try {
  root = mainRoot(input.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd());
  ledger = readLedger(root);
  runsData = readRuns(root);
} catch {
  allow(); // not a git repo: nothing to enforce
}
const buildActive = Boolean(ledger?.active);
const liveRuns = Object.values(runsData.runs).filter((r) => !RUN_TERMINAL.has(r.stage));
const active = buildActive || liveRuns.length > 0;
const P = paths(root);

const inside = (p, dir) => {
  const rel = path.relative(dir, p);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
};

try {
  // ── Agent: stage-gated subagents ───────────────────────────────────────────
  if (tool === "Agent" || tool === "Task") {
    const type = bareAgent(ti.subagent_type ?? "");
    if (!type.startsWith(AGENT_PREFIX)) allow();
    if (inSubagent) deny("Only the coordinator may start ai-dev subagents.");
    const prompt = String(ti.prompt ?? "");

    // Build workflow: "FEATURE: <id>"
    if (BUILD_AGENTS.has(type)) {
      if (!buildActive) deny(`${type} only runs inside a build run. Start one with /ai-dev:build.`);
      const m = /^\s*FEATURE:\s*(\S+)/.exec(prompt);
      if (!m) deny(`The prompt for ${type} must begin with "FEATURE: <id>".`);
      const id = m[1];
      const f = ledger.features[id];
      if (!f) deny(`Feature ${id} isn't in this build run. Run: ai-dev-orch next`);
      const expected = AGENT_FOR_STAGE[f.stage];
      if (expected !== type) {
        deny(expected
          ? `Feature ${id} is at "${f.stage}", which needs ${expected}, not ${type}.`
          : `Feature ${id} is at "${f.stage}"; no subagent runs at this stage. Run: ai-dev-orch next`);
      }
      if (!prompt.includes(f.worktree)) deny(`Give ${type} its worktree path in the prompt: ${f.worktree}`);
      const key = `${f.stage}#${f.history.length}`;
      if (f.spawned === key && !/^\s*RESPAWN\b/m.test(prompt)) {
        deny(`An ${type} was already started for feature ${id} at this stage. Wait for it to return. If it returned without finishing, add a line "RESPAWN" to the prompt.`);
      }
      f.spawned = key;
      writeLedger(root, ledger);
      allow();
    }

    // Setup, refine, review: "RUN: <id>"
    const m = /^\s*RUN:\s*(\S+)/.exec(prompt);
    if (!m) deny(`The prompt for ${type} must begin with "RUN: <run id>", copied from: ai-dev-orch run next`);
    const run = runsData.runs[m[1]];
    if (!run || RUN_TERMINAL.has(run.stage)) deny(`No active run "${m[1]}". Run: ai-dev-orch run next`);
    const st = stageOf(run);
    if (st?.kind !== "agents") deny(`Run ${run.id} is at "${run.stage}"; no subagent runs at this stage. Run: ai-dev-orch run next`);
    const ctx = context(root, loadConfig(root));
    const focus = (/^\s*Focus:\s*(\S+)/m.exec(prompt) ?? [])[1];
    const slot = expectedAgents(ctx, run).find((a) => a.type === type && (!focus || a.focus === focus));
    if (!slot) {
      const want = expectedAgents(ctx, run).map((a) => `${a.type} (focus ${a.focus})`).join(", ");
      deny(`Run ${run.id} is at "${run.stage}", which runs ${want}, not ${type}${focus ? ` with focus ${focus}` : ""}.`);
    }
    if (!prompt.includes(run.dir)) deny(`Give ${type} the run folder in the prompt: ${run.dir}`);
    const key = `${run.stage}#${run.history.length}#${run.attempts?.[run.stage] ?? 0}#${type}#${slot.focus}`;
    run.spawned = run.spawned ?? [];
    if (run.spawned.includes(key) && !/^\s*RESPAWN\b/m.test(prompt)) {
      deny(`An ${type} (focus ${slot.focus}) was already started for this stage. Wait for it to return. If it returned without finishing, add a line "RESPAWN".`);
    }
    if (!run.spawned.includes(key)) run.spawned.push(key);
    writeRuns(root, runsData);
    allow();
  }

  if (!active) allow();

  const protectedPaths = [
    P.state, PLUGIN_ROOT, P.config, P.rules,
    path.join(root, ".claude", "settings.json"), path.join(root, ".claude", "settings.local.json"),
  ];
  const isProtected = (file) => protectedPaths.some((p) => inside(file, p));
  const featureWorktrees = buildActive ? Object.values(ledger.features).filter((f) => !TERMINAL.has(f.stage)).map((f) => f.worktree) : [];
  const runDirs = liveRuns.map((r) => r.dir);

  // ── Write / Edit ───────────────────────────────────────────────────────────
  if (["Write", "Edit", "MultiEdit", "NotebookEdit"].includes(tool)) {
    const raw = ti.file_path ?? ti.notebook_path;
    if (!raw) allow();
    const file = path.resolve(input.cwd || root, raw);
    if (isProtected(file)) deny("Run state, the ai-dev plugin's files, .claude/ai-dev.json, the ai-dev rule file and Claude Code settings can't be edited while anything is running.");
    const inRunDir = runDirs.some((d) => inside(file, d));

    if (isKitAgent) {
      if (BUILD_AGENTS.has(agentType)) {
        if (!featureWorktrees.some((w) => inside(file, w))) deny(`Build agents may only edit files inside their feature worktree. ${file} is outside every active worktree.`);
        if (["ai-dev-spec-writer", "ai-dev-verifier", "ai-dev-reviewer"].includes(agentType) && !featureWorktrees.some((w) => inside(file, path.join(w, "blueprint")))) {
          deny(`${agentType} only writes Blueprint files (specs, evidence, findings) under <worktree>/blueprint/. Report code problems instead of fixing them.`);
        }
        allow();
      }
      if (READ_ONLY_AGENTS.has(agentType)) {
        if (!inRunDir) deny(`${agentType} is read-only: it writes only to its run folder under .ai-dev/runs/. Report what you found instead of changing it.`);
        allow();
      }
      if (agentType === "ai-dev-planner") {
        const ok = inRunDir || inside(file, path.join(root, "blueprint")) ||
          [path.join(root, "AGENTS.md"), path.join(root, "CLAUDE.md")].includes(file);
        if (!ok) deny("The planner writes only to its run folder, blueprint/, AGENTS.md and CLAUDE.md. Code changes go through a build run.");
        allow();
      }
      if (agentType === "ai-dev-ci-engineer") {
        if (inside(file, P.home) && !inRunDir) deny("The CI engineer can't write inside .ai-dev/ except its run folder.");
        allow();
      }
      allow();
    }
    if (!inSubagent && featureWorktrees.some((w) => inside(file, w))) {
      deny("The coordinator doesn't edit feature worktrees. Send the change back to a subagent (orch fail, or revise via the user).");
    }
    allow();
  }

  // ── Bash ───────────────────────────────────────────────────────────────────
  if (tool === "Bash") {
    const cmd = String(ti.command ?? "");
    const ORCH_CALL = /(?<![\w-])ai-dev-orch(?![\w-])|\bnode\s+\S*orchestrator\/orch\.mjs\b/g;

    if (new RegExp(ORCH_CALL).test(cmd) && inSubagent) deny("Only the coordinator runs ai-dev-orch. Report your result and finish.");
    const touched = cmd.replace(ORCH_CALL, "ORCH");
    if (/\.ai-dev\/state|\.claude\/ai-dev\.json|\.claude\/rules\/ai-dev\.md|\.claude\/settings(\.local)?\.json/.test(touched) ||
        touched.includes(PLUGIN_ROOT) || /\.claude\/plugins\//.test(touched)) {
      deny("Run state, the ai-dev plugin's files, its config and rule file, and Claude Code settings can't be touched from the shell while anything is running.");
    }
    if (READ_ONLY_AGENTS.has(agentType) && /\b(npm\s+(i|install|ci|add|uninstall)|pnpm\s+(add|install|i|remove)|yarn\s+(add|install|remove)|bun\s+(add|install)|pip3?\s+install)\b/.test(cmd)) {
      deny(`${agentType} is read-only and can't install or remove packages.`);
    }

    // git subcommands that move branches, rewrite history or land work.
    const GIT = /\bgit\b((?:\s+(?:-C\s+\S+|-c\s+\S+|--[\w-]+(?:=\S+)?))*)\s+([a-z][\w-]*)([^;&|]*)/g;
    const blocked = new Set(["merge", "push", "pull", "rebase", "reset", "cherry-pick", "revert", "checkout",
                             "switch", "restore", "stash", "worktree", "commit", "tag", "update-ref", "am", "filter-branch", "clean", "fetch"]);
    for (const m of cmd.matchAll(GIT)) {
      const sub = m[2];
      const rest = m[3] ?? "";
      if (sub === "branch" && /\s-(d|D|m|M|f|c|C)\b|--(delete|move|force|copy)\b/.test(rest)) {
        deny("Branches are created and deleted by ai-dev-orch only.");
      }
      if (!blocked.has(sub)) continue;
      if (sub === "commit" && agentType === "ai-dev-lander") continue;
      if (sub === "restore" && (agentType === "ai-dev-builder" || agentType === "ai-dev-ci-engineer")) continue; // undoing their own edits
      if (sub === "fetch" && !inSubagent) continue;
      deny(`"git ${sub}" is reserved for ai-dev-orch while a run is active.` +
           (agentType === "ai-dev-lander" ? " Stop after the work commit and report back. The orchestrator lands it once the user approves."
            : BUILD_AGENTS.has(agentType) ? " You're already on the right branch in your worktree. Leave your changes uncommitted and report back."
            : isKitAgent ? " Read the code as it is and report back."
            : " Run: ai-dev-orch status"));
    }
    allow();
  }

  allow();
} catch (err) {
  // Fail closed while anything is active: better a blocked call than a silent bypass.
  if (active) deny(`guard error (${err.message}). Run: ai-dev-orch status`);
  allow();
}
