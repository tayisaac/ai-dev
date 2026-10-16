# ai-dev plugin

Four team workflows on [AI Blueprint](https://ai-blueprint.dev), each with its
own command: `/ai-dev:setup`, `/ai-dev:refine`, `/ai-dev:build` and
`/ai-dev:review`, plus `/ai-dev:status` and `/ai-dev:ask`. Installation and team
rollout are in the [marketplace README](../../README.md).

## How it works

- **One coordinator.** Each command is a thin skill that loads the same
  coordinator rules (`coordinator/coordinator.md`) and its workflow file
  (`coordinator/workflows/<workflow>.md`). Your Claude Code session acts as the
  coordinator: it starts the subagents the engine asks for and talks to you.
- **A rules engine.** `ai-dev-orch` (in `bin/`, on the Bash PATH while the
  plugin is enabled) decides what happens next, checks each stage's output,
  caps repairs and does all git work.
- **Two hooks.** `guard.mjs` checks every tool call while a run is active;
  `approvals.mjs` records reply commands from the messages you type.
- **Plain language.** `/ai-dev:ask <what you want>` shows the matching command
  and waits for `yes`. Without a command, the `suggest` skill and the repo's
  `.claude/rules/ai-dev.md` (added by setup) have Claude suggest the command
  instead of doing the work ad hoc. Only you can start a workflow.

Reply commands must be the **first line** of your message.

## What the code enforces

| Rule | Enforced by |
| --- | --- |
| Each workflow's stages run in order, and each stage's output is checked before moving on | `ai-dev-orch` |
| Which build items run together (`depends:`, `touches:`, concurrency) | `ai-dev-orch` |
| Repairs are capped (default 2), then the run waits for you | `ai-dev-orch` |
| New build-plan items are numbered correctly and have `touches:` notes | `ai-dev-orch` |
| Builds land one at a time, rebased on the latest branch, with Verify run on the combined code | `ai-dev-orch` |
| A subagent can only start at its stage, for its feature or run | guard hook |
| Only the engine merges, switches branches or pushes; only the lander commits | guard hook |
| Read-only agents (surveyors, scout, analyst, reviewers, validator) write only to their run folder. The planner writes only planning files | guard hook |
| Nobody edits the run state, the plugin's files, `.claude/ai-dev.json`, the ai-dev rule file or Claude Code settings while a run is active | guard hook |
| Approvals come only from messages you type | approvals hook |

With no run active, the hooks allow everything, so the plugin stays out of the
way in repos that don't use it.

## Agents and models

| Agent | Workflow | Writes | Model |
| --- | --- | --- | --- |
| `ai-dev:surveyor` | setup | Run folder only | `haiku` (fast, read-only) |
| `ai-dev:planner` | setup, refine, review | Planning files | inherits your session's |
| `ai-dev:ci-engineer` | setup | Test and CI setup | inherits |
| `ai-dev:code-scout` | refine | Run folder only | `haiku` (fast, read-only) |
| `ai-dev:analyst` | refine | Run folder only | inherits |
| `ai-dev:designer` (optional) | refine | Mockups in the run folder | inherits |
| `ai-dev:correctness-reviewer`, `security-reviewer`, `performance-reviewer`, `quality-reviewer` | review | Run folder only | `opus` (strongest) |
| `ai-dev:validator` | review | Run folder only | `opus` (strongest) |
| `ai-dev:spec-writer`, `builder`, `verifier`, `lander` | build | The feature's worktree | inherits |
| `ai-dev:reviewer` | build | The feature's worktree (findings only) | `opus` (strongest) |

To change a model, edit the `model:` line in `agents/<agent>.md` in the
marketplace repository and release a new version.

## Per-repo settings: `.claude/ai-dev.json`

| Key | Default | Meaning |
| --- | --- | --- |
| `concurrency` | `2` | How many build items run at once |
| `maxRepairAttempts` | `2` | Failed checks sent back before a run waits for you |
| `verify` | `null` | The Verify command. `null` reads `Verify: \`…\`` from `AGENTS.md` |
| `worktreeSetup` | `"auto"` | Dependency install in a new worktree: `"auto"` detects the lockfile, or a command, or `false` |
| `copyFiles` | `[".env", ".env.local"]` | Local files copied into each new worktree |

At run time everything goes in `.ai-dev/` in the repo (state, worktrees and run
folders), excluded through `.git/info/exclude`, so `.gitignore` isn't touched.

## Notes and limits

- **Guardrails, not a security boundary.** The hooks catch drift and mistakes.
  A determined agent could disguise a shell command past the string checks.
- **Reviews never write Blueprint's `findings.md`.** Open P0/P1 findings there
  would block every build from landing. Review reports go to `docs/reviews/`
  (audit and branch reviews, committed) or the run folder (PR reviews, not
  committed).
- **AI review isn't a full security assessment.** Treat P0/P1 findings as
  verified leads, confirm performance findings by measuring, and keep your
  existing scanners and penetration testing.
- **AI attribution in commits:** Blueprint's `AGENTS.md` forbids it, and the
  lander is told so. To be sure, also turn off commit attribution in your
  Claude Code settings.
- **Independent review:** the build reviewer runs a plain `/audit current` in a
  fresh context, not Blueprint's `/audit independent` receipt. If your config
  requires independent review for sensitive work, the lander stops at that gate.
- **While anything is running,** git commands that move branches or land work
  are blocked in the session, including ones you ask Claude for. Run
  `/ai-dev:status` to see what's active.
- Tested on Linux. macOS should behave the same. Windows is untested.
