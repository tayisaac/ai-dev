# /ai-dev:refine — turn a requirement into approved build-plan items

Works from a requirement file **or a single sentence**. It refines the
requirement with the user, then proposes build-plan items that
`/ai-dev:build` can run.

Stages: intake → code scout checks the codebase (and an optional designer) →
**you interview the user** → analyst critiques the draft → **you resolve
blocking questions** → planner proposes items (wait for `approve plan`) →
items written to the build plan → overview refreshed → committed.

## Start

Run `ai-dev-orch run start refine <workflow arguments>`,
passing the workflow arguments unchanged. A quoted sentence, a file path, and
`--quick` all work. The command prints the run id (`refine-…`).

## The loop

Run `ai-dev-orch run next <run>` and do every ACTION:

- **`run: … run exec <run>`**: run it.
- **`spawn subagent …`**: start the listed subagents in the background with the
  printed prompt lines verbatim. The designer is **optional**: start it only if
  the requirement changes what users see. When the required ones have
  returned, run `ai-dev-orch run done <run>`.
- **`ACTION (you, the coordinator)`**: the interview, or resolving the
  analyst's blocking questions. Do exactly what it describes.
- **`WAITING FOR THE USER`**: show the proposed items and the exact reply, then
  end your turn.

## How to interview

The working draft is `requirement.md` in the run folder. You edit it; the user
can open and edit it too.

1. Read `scout.md` first, so every question is specific to this codebase.
2. Open with one line: your best reading of what they want, and the biggest
   unknown.
3. Ask **2–3 questions per round**, numbered, each with a **suggested answer**
   in italics, so they can reply "1 yes, 2 yes, 3 only on product pages".
4. After each round, update `requirement.md`: acceptance criteria as testable
   bullets, decisions in their sections, anything unanswered under
   "## Open questions".
5. Stop when the users, main flow, scope, data and acceptance criteria are
   concrete and nothing contradicts. Then run `ai-dev-orch run done <run>`. It
   refuses while open questions remain.
6. If the user says **"use assumptions"**, move the open questions to
   "## Assumptions" with your best guess for each. **"more depth"** means keep
   asking. With `--quick`, aim for about three rounds.

For an enhancement to something that already exists, always ask what must keep
working exactly as it does today, and record it under "## Must keep working".

## Finishing

When the run is done, tell the user which items were added and that
`/ai-dev:build` builds them. The refined requirement is in `docs/requirements/`.
