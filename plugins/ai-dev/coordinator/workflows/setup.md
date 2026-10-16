# /ai-dev:setup — one-time setup of this repo for the team

Takes a repo from nothing to ready for `/ai-dev:refine`, `build` and `review`,
on its own branch (`ai-dev/setup`), ending in one commit the team can review.

Stages: preflight → install Blueprint (after `approve install`) → four
surveyors map the code in parallel → **you interview the user** → planner
drafts the plans (wait for `approve plans`) → CI engineer sets up tests and
Verify → planner generates the overview → commit → trial worktree → health
check → `land setup` or `finish setup`.

## Start

Run `ai-dev-orch run start setup`. If a setup run
already exists, run `ai-dev-orch run next setup` instead.

## The loop

Run `ai-dev-orch run next setup` and do every ACTION:

- **`run: … run exec setup`**: run it. Code stages (git, installs, checks) are
  done by the engine, never by you.
- **`spawn subagent …`**: start each listed subagent in the background with the
  printed prompt lines verbatim (the four surveyors in parallel). When they've
  all returned, run `ai-dev-orch run done setup`.
- **`ACTION (you, the coordinator)`**: this is the interview. Ask the user the
  questions it describes in **one message**, each with a suggested answer they
  can accept. Write their answers to `intent.md` in the run folder, then run
  `ai-dev-orch run done setup`.
- **`WAITING FOR THE USER`**: tell them what to review and the exact reply,
  then end your turn.

Keep going until nothing is left to do, then end your turn.

## Notes

- The surveyors run on a faster, cheaper model; they only read.
- If `run done` refuses (for example, Verify fails), do what it says: respawn
  the agent with `RESPAWN` and the problem. After two failures the run parks for
  the user with the reason.
- The trial stage creates a throwaway worktree and runs the dependency install
  and Verify in it. If it fails, the usual fix is `copyFiles` or
  `worktreeSetup` in `.claude/ai-dev.json`; the user then replies
  `retry setup`.
- When it's finished, tell the user that `/ai-dev:refine` is the next step for
  new work.
