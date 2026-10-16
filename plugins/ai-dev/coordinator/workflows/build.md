# /ai-dev:build — build approved items in parallel and land them

Builds the unticked items in `blueprint/build-plan.md`, several at a time, each
in its own git worktree. Every spec waits for `approve <id>` and every commit
waits for `land <id>`.

## Start

Run `ai-dev-orch init`. If it fails, show the user the
message and stop.

## The loop

Run `ai-dev-orch next` and do **everything** under
ACTIONS:

- **`start`** lines: run the given `ai-dev-orch start <id>` command.
- **`spawn subagent`** lines: call the Agent tool with that `subagent_type`,
  **in the background**, starting several in one turn when there are several.
  The prompt must begin with `FEATURE: <id>` on its own line, followed by:
  ```
  Worktree: <worktree path from the action>
  Branch: <branch, for ai-dev:spec-writer>
  Build-plan item: <id>. <title>
  <feedback, verbatim, if the action includes any>
  ```
  Add nothing else.
- **`run:`** lines: run the command shown.

Each `ai-dev-orch` command prints the updated list, so keep going until there are
no ACTIONS left. Then tell the user what's waiting for them and end your turn.
You'll be woken when a subagent returns or the user replies.

## When a subagent returns

Map its result to one command. Quote evidence in **single quotes**, replacing
any single quote inside with ’.

| Subagent | Result | Run |
| --- | --- | --- |
| ai-dev:spec-writer | spec written | `ai-dev-orch advance <id> spec-ready` |
| ai-dev:builder | `RESULT: DONE` | `ai-dev-orch advance <id> checking` |
| ai-dev:builder | `RESULT: STOPPED` | `ai-dev-orch hold <id> '<why>'` |
| ai-dev:verifier | `RESULT: PASS` | `ai-dev-orch advance <id> reviewing` |
| ai-dev:verifier | `RESULT: FAIL` | `ai-dev-orch fail <id> '<failures with reproduction>'` |
| ai-dev:reviewer | `RESULT: PASS` | `ai-dev-orch advance <id> ready-to-land` |
| ai-dev:reviewer | `RESULT: FAIL` | `ai-dev-orch fail <id> '<open P0/P1 findings>'` |
| ai-dev:lander | `RESULT: COMMITTED` | `ai-dev-orch advance <id> land-pending` |
| ai-dev:lander | `RESULT: BLOCKED` by a code problem | `ai-dev-orch fail <id> '<the gate and why>'` |
| ai-dev:lander | `RESULT: BLOCKED` otherwise | `ai-dev-orch hold <id> '<the gate and why>'` |

If `advance` refuses (for example, the builder left steps unticked), start the
same subagent again with a line `RESPAWN` after the `FEATURE:` line, telling it
what `advance` reported. If the same stage fails twice, `hold` the feature.

## Talking to the user

- **Spec ready:** the feature, a two-line summary, the assumptions and open
  questions the spec writer flagged, and the spec's path. Then: "Reply
  `approve <id>`, or `revise <id> <what to change>`."
- **Ready to land:** the feature, the commit subject, and
  `git -C <worktree> show --stat HEAD`. Then: "Reply `land <id>`."
- **Needs you:** the feature and the reason. Then: "Fix it in the worktree and
  reply `retry <id>`, or `drop <id>`."

Several ids can go in one reply, such as `approve 3 4`.

## Finishing

When `next` says DONE, run `ai-dev-orch status`, show the build table, and run
`ai-dev-orch stop`. If it says BLOCKED, show why and ask the user what to do.
Suggest `/ai-dev:review branch <branch>` before the branch goes to a pull request.
