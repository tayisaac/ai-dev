// Engine for the setup, refine and review workflows (`orch run …`).
// The build workflow keeps its own engine in orch.mjs.

import { existsSync, readFileSync, mkdirSync, renameSync } from "node:fs";
import path from "node:path";
import { paths, readRuns, writeRuns, RUN_TERMINAL, excludeHome, ORCH, spawnName } from "./lib.mjs";
import { WORKFLOWS, Hold } from "./workflows.mjs";


export function context(root, cfg) {
  return { root, P: paths(root), cfg };
}

function die(msg) {
  console.error(`✗ ${msg}`);
  process.exit(1);
}

export const stageOf = (run) => WORKFLOWS[run.workflow].stages.find((s) => s.id === run.stage);
const stageIndex = (run, id) => WORKFLOWS[run.workflow].stages.findIndex((s) => s.id === id);

function record(run, stage, note) {
  run.stage = stage;
  run.history.push({ at: new Date().toISOString(), stage, ...(note ? { note } : {}) });
}

/** Move to a named stage (or the next one), passing over stages whose skip() is true. */
export function moveTo(ctx, run, target) {
  const stages = WORKFLOWS[run.workflow].stages;
  if (target === "done") return record(run, "done");
  let i = target ? stageIndex(run, target) : stageIndex(run, run.stage) + 1;
  while (i < stages.length && stages[i].skip?.(ctx, run)) i++;
  if (i >= stages.length) return record(run, "done");
  record(run, stages[i].id);
  // Entering an agents stage always means fresh work: set aside any earlier outputs
  // (for example the first draft, after the user replied "revise plans").
  if (stages[i].kind === "agents") {
    for (const a of stages[i].agents(ctx, run)) {
      const f = path.join(run.dir, a.output);
      if (existsSync(f)) renameSync(f, `${f}.previous-${run.history.length}`);
    }
  }
}

export function hold(run, reason) {
  run.reason = reason;
  run.resumeTo = run.stage === "needs-human" ? run.resumeTo : run.stage;
  record(run, "needs-human");
}

/** The agents a run's current stage expects, with which outputs are still missing. */
export function expectedAgents(ctx, run) {
  const st = stageOf(run);
  if (st?.kind !== "agents") return [];
  return st.agents(ctx, run).map((a) => ({ ...a, done: existsSync(path.join(run.dir, a.output)) && readFileSync(path.join(run.dir, a.output), "utf8").trim().length > 0 }));
}

function load(root, id) {
  const data = readRuns(root);
  const run = data.runs[id];
  if (!run) die(`No run "${id}". See: ${ORCH} status`);
  return { data, run };
}

// ── commands ─────────────────────────────────────────────────────────────────

function start(ctx, workflow, args) {
  const wf = WORKFLOWS[workflow];
  if (!wf) die(`Unknown workflow "${workflow}". Use: setup, refine or review (build has its own commands).`);
  let init;
  try { init = wf.init(ctx, args); } catch (e) { die(e.message); }
  const data = readRuns(ctx.root);
  let id = init.id;
  const live = data.runs[id];
  if (live && !RUN_TERMINAL.has(live.stage)) die(`Run "${id}" is already in progress (stage: ${live.stage}). Continue it, or reply: cancel ${id}`);
  for (let n = 2; data.runs[id] && RUN_TERMINAL.has(data.runs[id].stage) && id === init.id; n++) {
    if (!data.runs[`${init.id}-${n}`]) id = `${init.id}-${n}`;
  }
  excludeHome(ctx.root);
  const run = {
    id, workflow, stage: null, createdAt: new Date().toISOString(),
    dir: path.join(ctx.P.runs, id), data: init.data, history: [], attempts: {}, spawned: [],
  };
  mkdirSync(run.dir, { recursive: true });
  moveTo(ctx, run, wf.stages[0].id);
  data.runs[id] = run;
  writeRuns(ctx.root, data);
  console.log(`Started ${wf.title.toLowerCase()} run "${id}". Working folder: ${run.dir}\n`);
  next(ctx, id);
}

export function next(ctx, only) {
  const data = readRuns(ctx.root);
  const runs = Object.values(data.runs).filter((r) => !RUN_TERMINAL.has(r.stage) && (!only || r.id === only));
  if (!runs.length) {
    console.log(only ? `Run "${only}" is finished.` : "No setup, refine or review runs in progress.");
    return;
  }
  for (const run of runs) {
    const st = stageOf(run);
    console.log(`RUN ${run.id} (${WORKFLOWS[run.workflow].title}) · stage: ${run.stage}`);
    if (run.stage === "needs-human") {
      console.log(`  WAITING FOR THE USER: needs you: ${run.reason}\n      You type: retry ${run.id}   or   cancel ${run.id}`);
      continue;
    }
    if (st.kind === "code") {
      console.log(`  ACTION: run: ${ORCH} run exec ${run.id}   (${st.describe})`);
    } else if (st.kind === "agents") {
      const list = expectedAgents(ctx, run);
      const todo = list.filter((a) => !a.done);
      console.log(`  ${st.describe}.`);
      for (const a of todo) {
        console.log(`  ACTION: spawn subagent ${spawnName(a.type)} in the background${a.optional ? " (OPTIONAL — only if it applies)" : ""}. Prompt, exactly:`);
        const prompt = [
          `RUN: ${run.id}`,
          `Run folder: ${run.dir}`,
          `Focus: ${a.focus}`,
          ...a.lines,
          ...(run.feedback ? [`Feedback from the last attempt (fix this first):`, run.feedback] : []),
        ];
        console.log(prompt.flatMap((l) => String(l).split("\n")).map((l) => `      | ${l}`).join("\n"));
      }
      const required = list.filter((a) => !a.optional);
      if (required.every((a) => a.done)) console.log(`  ACTION: all required outputs are in. Run: ${ORCH} run done ${run.id}`);
      else console.log(`  When they have all returned, run: ${ORCH} run done ${run.id}`);
    } else if (st.kind === "coordinator") {
      console.log(`  ACTION (you, the coordinator): ${st.task(ctx, run)}`);
      if (run.feedback) console.log(`  Fix first: ${run.feedback}`);
      console.log(`  When finished, run: ${ORCH} run done ${run.id}`);
    } else if (st.kind === "gate") {
      console.log(`  WAITING FOR THE USER: ${st.wait(ctx, run)}`);
    }
  }
}

function done(ctx, id) {
  const { data, run } = load(ctx.root, id);
  const st = stageOf(run);
  if (!st || !["agents", "coordinator"].includes(st.kind)) {
    die(`Run "${id}" is at "${run.stage}"${st ? ` (${st.kind})` : ""}; "done" only finishes an agents or coordinator stage.` +
        (st?.kind === "code" ? ` Run: ${ORCH} run exec ${id}` : st?.kind === "gate" ? " It's waiting for the user's reply." : ""));
  }
  if (st.kind === "agents") {
    const missing = expectedAgents(ctx, run).filter((a) => !a.optional && !a.done);
    if (missing.length) die(`Still missing: ${missing.map((a) => `${a.output} (${spawnName(a.type)})`).join(", ")}. Spawn or RESPAWN those subagents.`);
  }
  const problem = st.check?.(ctx, run) ?? null;
  if (problem && st.kind === "coordinator") {
    // Your own stage (e.g. the interview): no repair limit, just finish it.
    run.feedback = problem;
    writeRuns(ctx.root, data);
    console.log(`✗ Stage "${run.stage}" isn't finished yet:\n${problem}`);
    process.exitCode = 1;
    return;
  }
  if (problem) {
    const max = ctx.cfg.maxRepairAttempts ?? 2;
    run.attempts[run.stage] = (run.attempts[run.stage] ?? 0) + 1;
    if (run.attempts[run.stage] > max) {
      hold(run, `stage "${run.stage}" failed its check ${run.attempts[run.stage]} times. Last problem:\n${problem}`);
      writeRuns(ctx.root, data);
      console.log(`Run ${id} → needs-human.\n`);
    } else {
      run.feedback = problem;
      // Set this stage's outputs aside so the next attempt is a real redo.
      if (st.kind === "agents") {
        // Only the outputs the problem names have to be redone (all of them if it names none).
        const outs = expectedAgents(ctx, run);
        const named = outs.filter((a) => problem.includes(a.output));
        for (const a of named.length ? named : outs) {
          const f = path.join(run.dir, a.output);
          if (existsSync(f)) renameSync(f, `${f}.attempt-${run.attempts[run.stage]}`);
        }
      }
      writeRuns(ctx.root, data);
      console.log(`✗ Stage "${run.stage}" isn't finished (attempt ${run.attempts[run.stage]}/${max}):\n${problem}\n` +
        (st.kind === "agents" ? `Spawn the agent(s) again with a first line "RESPAWN" after the RUN line, including this problem.` : "Fix it, then run done again."));
    }
    process.exitCode = 1;
    return next(ctx, id);
  }
  delete run.feedback;
  moveTo(ctx, run);
  writeRuns(ctx.root, data);
  console.log(`Run ${id}: "${st.id}" done → ${run.stage}.\n`);
  next(ctx, id);
}

function exec(ctx, id) {
  const { data, run } = load(ctx.root, id);
  const st = stageOf(run);
  if (st?.kind !== "code") die(`Run "${id}" is at "${run.stage}", which isn't a code stage.`);
  let res;
  try {
    res = st.exec(ctx, run);
  } catch (e) {
    hold(run, e instanceof Hold ? e.message : `${st.id} failed: ${e.message}`);
    writeRuns(ctx.root, data);
    console.log(`Run ${id} → needs-human: ${run.reason}\n`);
    return next(ctx, id);
  }
  const message = typeof res === "string" ? res : res?.message;
  if (res?.done && !st.next) record(run, "done");
  else moveTo(ctx, run, st.next ?? res?.to);
  writeRuns(ctx.root, data);
  console.log(`${message ?? `${st.id} done.`}\n`);
  next(ctx, id);
}

function holdCmd(ctx, id, reason) {
  const { data, run } = load(ctx.root, id);
  if (RUN_TERMINAL.has(run.stage)) die(`Run "${id}" is already ${run.stage}.`);
  hold(run, reason || "held by the coordinator");
  writeRuns(ctx.root, data);
  console.log(`Run ${id} → needs-human.\n`);
  next(ctx, id);
}

export function runsStatus(root) {
  const runs = Object.values(readRuns(root).runs);
  if (!runs.length) return console.log("  No runs yet.");
  for (const r of runs) {
    console.log(`  ${r.id.padEnd(30)} ${r.stage.padEnd(16)} ${WORKFLOWS[r.workflow].title}${r.reason ? `  — ${r.reason.split("\n")[0]}` : ""}`);
  }
}

export function runCommand(root, cfg, args) {
  const ctx = context(root, cfg);
  const [sub, ...rest] = args;
  const need = (n, usage) => { if (rest.length < n) die(`Usage: ${ORCH} run ${usage}`); };
  switch (sub) {
    case "start": need(1, "start <setup|refine|review> [args]"); return start(ctx, rest[0], rest.slice(1));
    case "next": return next(ctx, rest[0]);
    case "done": need(1, "done <run>"); return done(ctx, rest[0]);
    case "exec": need(1, "exec <run>"); return exec(ctx, rest[0]);
    case "hold": need(1, 'hold <run> "<reason>"'); return holdCmd(ctx, rest[0], rest.slice(1).join(" "));
    case "cancel": die("Only the user can cancel a run, by typing: cancel <run>");
    default: die(`Usage: ${ORCH} run start|next|done|exec|hold …`);
  }
}
