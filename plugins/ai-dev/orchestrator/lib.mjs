// Shared code for the orchestrator CLI (orch.mjs) and its hooks.
// Zero dependencies: Node 18+ and git 2.31+.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** The installed plugin folder (orchestrator/ is one level down). */
export const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** How the coordinator calls the engine: bin/ai-dev-orch, on the Bash PATH while the plugin is enabled. */
export const ORCH = "ai-dev-orch";

// ── Paths ────────────────────────────────────────────────────────────────────

/** Root of the main checkout, even when called from inside a worktree. */
export function mainRoot(cwd = process.cwd()) {
  const common = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], {
    cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
  }).trim();
  return path.dirname(common);
}

// Everything ai-dev creates at run time lives in .ai-dev/, which is excluded
// from git through .git/info/exclude (never .gitignore):
//   .ai-dev/state/     ledgers, written only by orch.mjs and the approvals hook
//   .ai-dev/worktrees/ one git worktree per feature being built or PR being reviewed
//   .ai-dev/runs/<id>/ working files for setup, refine and review runs
export const paths = (root) => ({
  root,
  home: path.join(root, ".ai-dev"),
  worktrees: path.join(root, ".ai-dev", "worktrees"),
  state: path.join(root, ".ai-dev", "state"),
  ledger: path.join(root, ".ai-dev", "state", "ledger.json"),
  runsLedger: path.join(root, ".ai-dev", "state", "runs.json"),
  runs: path.join(root, ".ai-dev", "runs"),
  config: path.join(root, ".claude", "ai-dev.json"),
  rules: path.join(root, ".claude", "rules", "ai-dev.md"),
  plan: path.join(root, "blueprint", "build-plan.md"),
  agents: path.join(root, "AGENTS.md"),
});

/** Keep .ai-dev/ out of git without touching .gitignore. Safe to call repeatedly. */
export function excludeHome(root) {
  const exclude = path.join(git(root, "rev-parse", "--path-format=absolute", "--git-common-dir"), "info", "exclude");
  mkdirSync(path.dirname(exclude), { recursive: true });
  const ex = existsSync(exclude) ? readFileSync(exclude, "utf8") : "";
  if (!ex.split("\n").includes("/.ai-dev/")) {
    writeFileSync(exclude, `${ex}${ex === "" || ex.endsWith("\n") ? "" : "\n"}/.ai-dev/\n`);
  }
}

// ── Git ──────────────────────────────────────────────────────────────────────

export function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

export function tryGit(cwd, ...args) {
  try { return { ok: true, out: git(cwd, ...args) }; }
  catch (e) { return { ok: false, out: `${e.stdout ?? ""}${e.stderr ?? ""}`.trim() }; }
}

// Blueprint's branch rule: lowercase ASCII letters and digits, other runs → one hyphen.
export const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

// ── Config ───────────────────────────────────────────────────────────────────

const DEFAULTS = {
  concurrency: 2,
  maxRepairAttempts: 2,
  verify: null,               // null = read "Verify: `...`" from AGENTS.md
  worktreeSetup: "auto",      // "auto" = detect lockfile; a command string; or false
  copyFiles: [".env", ".env.local"],
  featureBranchPrefix: null,  // null = read git.featureBranchPrefix from blueprint/config.json
};

export function loadConfig(root) {
  const p = paths(root);
  let cfg = { ...DEFAULTS };
  if (existsSync(p.config)) cfg = { ...cfg, ...JSON.parse(readFileSync(p.config, "utf8")) };

  if (!cfg.featureBranchPrefix) {
    try {
      const bp = JSON.parse(readFileSync(path.join(root, "blueprint", "config.json"), "utf8"));
      cfg.featureBranchPrefix = bp?.git?.featureBranchPrefix || "feature/";
    } catch { cfg.featureBranchPrefix = "feature/"; }
  }
  if (!cfg.verify && existsSync(p.agents)) {
    const m = readFileSync(p.agents, "utf8").match(/Verify:\s*`([^`]+)`/);
    if (m) cfg.verify = m[1];
  }
  return cfg;
}

// ── Ledger ───────────────────────────────────────────────────────────────────
// Build-run state. Lives in .ai-dev/state/ (git-excluded) and is
// written only by orch.mjs and the approvals hook. The guard hook blocks
// agents from editing it directly.

export function readLedger(root) {
  const p = paths(root);
  if (!existsSync(p.ledger)) return null;
  return JSON.parse(readFileSync(p.ledger, "utf8"));
}

export function writeLedger(root, ledger) {
  const p = paths(root);
  mkdirSync(p.state, { recursive: true });
  const tmp = `${p.ledger}.tmp`;
  writeFileSync(tmp, JSON.stringify(ledger, null, 2) + "\n");
  renameSync(tmp, p.ledger); // atomic replace
}

export function setStage(ledger, id, stage, note) {
  const f = ledger.features[id];
  f.stage = stage;
  f.history.push({ at: new Date().toISOString(), stage, ...(note ? { note } : {}) });
}

// ── Stages ───────────────────────────────────────────────────────────────────
//
//  spec ─► spec-ready ─(you: approve N)─► approved ─► building ─► checking ─► reviewing
//    ▲          │                                        ▲            │           │
//    └(revise N)┘                                        └── orch fail (max N) ───┘
//
//  reviewing ─► ready-to-land ─(orch prepare-land: serial)─► landing ─► land-pending
//            ─(you: land N)─► land-approved ─(orch land)─► merged
//
//  Any stage ─► needs-human (repairs exhausted, conflict, orch hold)  ·  drop N ─► dropped

export const TERMINAL = new Set(["merged", "dropped"]);

/** Which subagent may be spawned for a feature at each stage. Enforced by guard.mjs. */
export const AGENT_FOR_STAGE = {
  "spec": "ai-dev-spec-writer",
  "building": "ai-dev-builder",
  "checking": "ai-dev-verifier",
  "reviewing": "ai-dev-reviewer",
  "landing": "ai-dev-lander",
};

/** Internally every agent is "ai-dev-<role>"; the guard keys on this prefix. */
export const AGENT_PREFIX = "ai-dev-";

/** Plugin agent name ("ai-dev:builder") → internal name ("ai-dev-builder"). Other names pass through. */
export const bareAgent = (t) => (typeof t === "string" ? (t.startsWith("ai-dev:") ? `ai-dev-${t.slice(7)}` : t) : "");

/** Internal name → the subagent_type the coordinator passes to the Agent tool. */
export const spawnName = (t) => `ai-dev:${t.replace(/^ai-dev-/, "")}`;

// ── Runs ledger (setup, refine, review) ──────────────────────────────────────

export function readRuns(root) {
  const p = paths(root).runsLedger;
  return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : { runs: {} };
}

export function writeRuns(root, data) {
  const p = paths(root);
  mkdirSync(p.state, { recursive: true });
  const tmp = `${p.runsLedger}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n");
  renameSync(tmp, p.runsLedger);
}

export const RUN_TERMINAL = new Set(["done", "cancelled"]);

export function activeRuns(root) {
  return Object.values(readRuns(root).runs).filter((r) => !RUN_TERMINAL.has(r.stage));
}

/** Transitions `orch advance` may make. Human-only transitions are not listed here. */
export const ADVANCE = {
  "spec": ["spec-ready"],
  "approved": ["building"],
  "building": ["checking"],
  "checking": ["reviewing"],
  "reviewing": ["ready-to-land"],
  "landing": ["land-pending"],
};

// ── Build plan ───────────────────────────────────────────────────────────────
//
// Reads blueprint/build-plan.md from the MAIN checkout. Optional nested notes:
//   - [ ] 4. **Checkout flow** - cart to payment
//     - depends: 2, 3
//     - touches: checkout, payments

export const ITEM = /^(\s*)[-*] \[( |x|X)\] ([0-9]+[a-z]?)\.\s+\*\*(.+?)\*\*/;
export const NOTE = /^\s+[-*] (depends|touches):\s*(.+)$/i;

export function loadPlan(root) {
  return parsePlanText(readFileSync(paths(root).plan, "utf8"));
}

/** Parse build-plan markdown (a whole file or a proposed block of items). */
export function parsePlanText(text) {
  const items = [];
  let current;
  for (const line of text.split("\n")) {
    const m = ITEM.exec(line);
    if (m) {
      current = { id: m[3], title: m[4].trim(), done: m[2] !== " ", indent: m[1].length,
                  depends: [], touches: null, parent: false };
      items.push(current);
      continue;
    }
    const n = NOTE.exec(line);
    if (n && current) {
      // "depends: none" / "touches: -" mean nothing; don't treat them as ids or tags.
      const vals = n[2].split(",").map((s) => s.trim()).filter((s) => s && !/^(none|n\/a|-|—)$/i.test(s));
      if (n[1].toLowerCase() === "depends") current.depends = vals;
      else current.touches = vals.map((v) => v.toLowerCase());
    }
  }
  // /feature only builds leaf items: mark items followed by a deeper item as parents.
  for (let i = 0; i < items.length - 1; i++) {
    if (items[i + 1].indent > items[i].indent) items[i].parent = true;
  }
  return items;
}

/**
 * Features that may start now: unchecked leaf items, dependencies checked on
 * main, not already in the ledger, within the concurrency limit, and not
 * touching an area another active feature touches. A feature with no
 * `touches` note is exclusive: it runs only when nothing else is active.
 */
export function startable(plan, ledger, cfg) {
  const byId = new Map(plan.map((f) => [f.id, f]));
  const active = Object.entries(ledger.features)
    .filter(([, f]) => !TERMINAL.has(f.stage))
    .map(([id, f]) => ({ id, ...f, touches: byId.get(id)?.touches ?? f.touches ?? null }));

  const slots = cfg.concurrency - active.filter((f) => f.stage !== "needs-human").length;
  if (slots <= 0) return [];
  if (active.some((f) => f.touches === null)) return [];

  const busy = new Set(active.flatMap((f) => f.touches));
  const out = [];
  for (const f of plan) {
    if (out.length >= slots) break;
    const prev = ledger.features[f.id];
    if (f.done || f.parent || (prev && !(prev.stage === "dropped" && !existsSync(prev.worktree)))) continue;
    if (!f.depends.every((d) => byId.get(d)?.done)) continue;
    if (f.touches === null) {
      if (active.length === 0 && out.length === 0) return [f];
      continue;
    }
    if (f.touches.some((t) => busy.has(t))) continue;
    out.push(f);
    f.touches.forEach((t) => busy.add(t));
  }
  return out;
}

// ── Spec file checks ─────────────────────────────────────────────────────────

export function readSpec(worktree) {
  const p = path.join(worktree, "blueprint", "context", "current-feature.md");
  return existsSync(p) ? readFileSync(p, "utf8") : "";
}

export const specIsStub = (text) => !/^# (Feature|Fix|Rollback):/m.test(text);

export function uncheckedSteps(text) {
  const sec = text.split(/^## /m).find((s) => /^Build steps/i.test(s)) ?? "";
  return (sec.match(/^\s*- \[ \]/gm) ?? []).length;
}
