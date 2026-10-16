# /ai-dev:review — review a PR, a branch, or existing code

Produces a validated review report. It never edits code and never posts to
GitHub.

| Command | Reviews | Lenses |
| --- | --- | --- |
| `/ai-dev:review pr 1234` | A pull request's changes (fetched into a separate worktree) | correctness, security, performance, quality |
| `/ai-dev:review branch <b> [--base main]` | A branch's changes, such as an integration branch after a build | correctness, security, performance, quality |
| `/ai-dev:review audit <path\|full> [security] [performance] [quality] [tests]` | Existing code, for optimisation and vulnerabilities | the ones named, or all four |

Stages: scope → lens reviewers in parallel (fresh context, read-only) →
validator confirms every P0/P1 → report written → **triage** (wait for the
user) → for chosen fixes: planner proposes items (wait for `approve plan`) →
build plan → overview → commit → close.

## Start

Run `ai-dev-orch run start review <workflow arguments>`,
passing the workflow arguments unchanged. The command prints the
run id (`review-…`).

## The loop

Run `ai-dev-orch run next <run>` and do every ACTION:

- **`run: … run exec <run>`**: run it.
- **`spawn subagent …`**: start every listed reviewer in the background, **in
  parallel**, with the printed prompt lines verbatim. When all have returned,
  run `ai-dev-orch run done <run>`.
- **`WAITING FOR THE USER`**: summarise the report (counts by severity, the
  P0/P1 findings in one line each) and give the exact replies, then end your turn.

## Triage replies (the user types these)

- **PR review:** `finish review`. The report includes a ready-to-paste comment
  for each finding. The report isn't committed, because it's about someone
  else's PR.
- **Audit or branch review:**
  - `fix R-01 R-03` plans those fixes as build-plan items, which then wait for
    `approve plan`.
  - `accept R-05 <reason>` records that it won't be fixed, and why.
  - `finish review` ends the review. The report is committed to `docs/reviews/`.

## Notes

- Reviewers and the validator run on the strongest model. Findings use P0–P3:
  P0 must not ship, P1 is a likely bug or real risk, P2 is worth fixing, P3 is
  small cleanup.
- Findings go into the report, **not** Blueprint's `findings.md`. Open P0/P1
  findings there would block every feature build from landing.
- A large `audit full` is slow. If the user asks for a whole project, suggest
  reviewing one area at a time.
