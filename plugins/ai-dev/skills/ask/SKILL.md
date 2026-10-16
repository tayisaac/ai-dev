---
name: ask
description: 'ai-dev: describe what you want in plain words and get the right ai-dev workflow command, which starts only when you reply yes. Also routes /ai-dev:ask <workflow> …'
argument-hint: '<what you want, in plain words> | setup | refine … | build | review … | status'
disable-model-invocation: true
allowed-tools: 'Read(/${CLAUDE_PLUGIN_ROOT}/**) Bash(ai-dev-orch *)'
---
# /ai-dev:ask — the ai-dev coordinator's front door

Read `${CLAUDE_PLUGIN_ROOT}/coordinator/coordinator.md` now and follow it for the
rest of this run. It makes you the coordinator and sets the rules for every
workflow. The workflow files are in `${CLAUDE_PLUGIN_ROOT}/coordinator/workflows/`.

| Command | Workflow file | What it does |
| --- | --- | --- |
| `/ai-dev:setup` | `setup.md` | One-time setup of this repo for the team |
| `/ai-dev:refine "<sentence or file>"` | `refine.md` | Turn a requirement into approved build-plan items |
| `/ai-dev:build` | `build.md` | Build approved items in parallel worktrees and land them |
| `/ai-dev:review pr <n>` · `branch <b>` · `audit <path> [lenses]` | `review.md` | Review a PR, a branch, or existing code |
| `/ai-dev:status` | — | Show every run |

## Route

The user typed: `$ARGUMENTS`

Read the first word:

| First word | Do |
| --- | --- |
| `setup`, `refine`, `build`, `review` | Read the matching workflow file and follow it. The workflow arguments are the rest of what they typed, after that first word |
| `status` | Run `ai-dev-orch status`, show it, stop |
| *(none)* | Show the command table above with one line on each, mention they can also describe what they want after `/ai-dev:ask`, and stop |

Anything else is a request in plain words: follow **Plain-language requests**
below.

## Plain-language requests

When the first word isn't a workflow keyword (for example
`/ai-dev:ask check the checkout code for vulnerabilities`), work out the command,
show it, and **wait for the user to confirm before starting anything**.

1. **Pick the workflow:**

   | The request is about | Command |
   | --- | --- |
   | Setting the repo up, installing Blueprint, onboarding the team | `/ai-dev:setup` |
   | A new feature, a change or enhancement, a requirement or user story | `/ai-dev:refine "<the request as one clear sentence>"`, or `/ai-dev:refine <path>` if they name a requirement file. Add `--quick` if they want it fast |
   | Building, implementing, continuing what's planned | `/ai-dev:build` |
   | A pull request ("PR 123", "#123") | `/ai-dev:review pr <number>` |
   | A branch, before merging or opening a PR | `/ai-dev:review branch <branch>` |
   | Existing code: vulnerabilities, security, slowness, optimisation, maintainability, cleanup, test gaps | `/ai-dev:review audit <path> <lenses>` |
   | What's running or waiting | `status` (no confirmation needed: just run it) |

2. **Fill in the arguments from what you can see,** using read-only lookups
   only (Glob, Grep, `git branch`, `gh pr list` if available):
   - **Path:** the folder that matches their words ("the checkout code" →
     `src/checkout`). If they mean the whole project, use `full`, and suggest one
     area at a time for a big codebase.
   - **Lenses:** vulnerabilities, security → `security`. Slow, optimisation,
     performance → `performance`. Messy, duplication, maintainability →
     `quality`. Test gaps, coverage → `tests`. None mentioned → leave them off
     (all four run).
   - **Sentence for refine:** their request, tidied into one clear sentence.
     Keep their meaning, and don't add scope.

3. **Show your reading and wait.** In one short message:
   - the command in a code block, for example `/ai-dev:review audit src/checkout security`
   - one line on what it will do, and roughly how long it takes
   - "Reply **yes** to start, or tell me what to change."

   Then end your turn. Don't start any run until they confirm.

4. **On `yes`** (or "go", "ok"), read the workflow file and start it exactly as
   if they had typed the command, using the arguments you showed. If they
   correct you instead, show the updated command and wait again.

Edge cases:
- **More than one intent** (for example "refine and build the favourites
  feature"): propose the first workflow, and say which one comes next.
- **Unclear which workflow:** ask one question with the two or three likely
  commands as options.
- **Not a workflow** (a typo, a one-line fix, explaining code, a question): say
  so in one line and offer to just do it, or suggest Blueprint's `/fix` for a
  small bug.
