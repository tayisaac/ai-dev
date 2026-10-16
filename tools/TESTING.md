# Testing the ai-dev plugin

Try every workflow on a throwaway sample project before using the plugin on
real work. Install the plugin first (see the [README](../README.md)), or try
a clone without installing: `claude --plugin-dir <clone>/plugins/ai-dev`.

## 1. Create the sample project

In Terminal, from a clone of the marketplace repo:

```bash
bash tools/setup-sample-project.sh
```

This creates `~/Projects/ai-dev-sample`. Pass a different path as the first
argument to change it. It takes about a minute and needs Node 18+, git, and an
internet connection (for `npx`). It includes:

- a tiny JavaScript library, with AI Blueprint installed, the files
  `/ai-dev:setup` adds, and the plans already written
- a build plan with three items: 2 and 3 run in parallel, and 4 waits for both
- `src/legacy/orders.js`, a deliberately flawed module to review

Then:

```bash
cd ~/Projects/ai-dev-sample
claude
```

Accept the **trust this folder** prompt; the hooks don't load until you do.
Press **Shift+Tab** until the mode shows *accept edits*. You'll get fewer
permission prompts, and the hooks still enforce the rules.

Reply commands must be the **first line** of your message.

## 2. Review: `/ai-dev:review audit src/legacy security performance`

About 5 minutes and US$1 at API prices. This is the quickest workflow to try.

| You see | You reply |
| --- | --- |
| Security and performance reviewers run in parallel, then a validator tries to confirm each P1. A report lands in `docs/reviews/` | `fix R-01 R-02` |
| The planner proposes a build-plan item that fixes them | `approve plan` |
| Item added, overview refreshed, report committed | — |

Then try `accept R-03 <reason>` on a finding you won't fix, or `finish review`
to end without fixes. A PR review (`/ai-dev:review pr <n>`) works the same way
but needs a GitHub remote. It writes the report to the run folder, with a
ready-to-paste comment for each finding.

## 3. Refine: `/ai-dev:refine "Greet people in their own language" --quick`

About 5 minutes and US$1. Shows how one sentence becomes a requirement.

| You see | You reply |
| --- | --- |
| The code scout checks the codebase, then round 1 of 2–3 questions, each with a suggested answer | e.g. `1 yes, 2 yes, 3 only en, es and fr` |
| More rounds until the acceptance criteria are concrete | answer, or `use assumptions` |
| The analyst's critique; any blocking question comes back to you | answer |
| Proposed build-plan items | `approve plan` (or `revise plan <changes>`) |

The refined requirement lands in `docs/requirements/`, and the items are
appended to the build plan.

## 4. Build: `/ai-dev:build`

About 20–30 minutes and US$5–7 for the three sample items.

| You see | You reply |
| --- | --- |
| Two spec writers run side by side, then two specs with their assumptions | `approve 2 3` |
| Build, check and review for each. Feature 2 is rebased, Verify runs, and the lander commits | `land 2` |
| Feature 3 is rebased onto the new main, Verify runs on the combined code | `land 3` |
| Feature 4 starts now that its dependencies have landed | `approve 4`, then `land 4` |

## 5. Setup: `/ai-dev:setup` (on a real repo, or a copy of one)

The sample is already set up. To try setup, open Claude Code in a **copy** of a
small existing project with a clean checkout, and run `/ai-dev:setup`. It takes about 15 minutes and US$3.

| You see | You reply |
| --- | --- |
| A new `ai-dev/setup` branch, then a request to install Blueprint | `approve install` |
| Four surveyors map the code, then 3–5 questions about the project | `ok`, or your answers |
| Drafted plans, standards and commands, with `TODO (confirm)` items | `approve plans` (or `revise plans <changes>`) |
| Tests and Verify are set up, the overview is generated, a trial worktree proves builds will work, and a health check runs | `land setup`, or `finish setup` to open a PR yourself |

## Try plain language

- Without a command, ask: "Can you check the legacy orders code for slow
  queries?" Claude suggests `/ai-dev:review audit src/legacy/orders.js performance`
  instead of reviewing ad hoc.
- After `/ai-dev:ask`, describe it: `/ai-dev:ask look for security holes in the
  legacy code`. Claude shows its reading as a command and waits. Reply `yes` to start.

## Try the guardrails

- When a spec or plan is waiting, reply "looks good, go ahead". Nothing moves:
  only the exact reply works.
- Ask Claude to "just merge it" or "commit this" while a run is active. The git
  command is blocked.
- During a review, ask a reviewer to fix what it found. It can't: reviewers can
  only write to their run folder.
- Start two refine runs and reply `approve plan`. You're asked which run you
  mean (`approve plan <run id>`).

## Check progress any time

- In Claude Code: `/ai-dev:status`
- A run's working files: `.ai-dev/runs/<run id>/`
- A feature being built: `.ai-dev/worktrees/<id>-<name>/`

## Clean up

Delete the sample folder. Everything ai-dev created is inside it.

## Troubleshooting

| Problem | Fix |
| --- | --- |
| The `/ai-dev:…` commands aren't listed | Check `claude plugin list` shows `ai-dev@ai-dev-marketplace` as enabled, then restart `claude` |
| Nothing is blocked | The hooks didn't load. Accept the trust prompt and restart `claude` |
| A permission prompt for every edit | Switch to *accept edits* mode (Shift+Tab) |
| A run shows `needs-human` | Read the reason in `/ai-dev:status`, fix it, then reply `retry <run id>` (or `retry <feature id>` for a build), or `cancel <run id>` |
| "more than one run is waiting" | Add the run id to your reply, e.g. `approve plan refine-alpha-thing` |
| Setup's trial worktree fails | Add the missing local file to `copyFiles`, or set `worktreeSetup`, in `.claude/ai-dev.json`, then reply `retry setup` |
| You need to stop a build part-way | Ask Claude to run `ai-dev-orch stop`. `/ai-dev:build` resumes it |
