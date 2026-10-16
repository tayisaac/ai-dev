# ai-dev workflows: suggest the command

This repo uses the ai-dev plugin. Its workflows run as teams of subagents with
code-enforced rules and the user's approvals, and **only the user can start
them**, by typing the command. (If you are a subagent in an ai-dev run, ignore
this file.)

When the user asks, in plain words, for something one of these workflows does,
don't do it ad hoc. Reply with the exact command, filled in for their request,
and one line on what it will do. They can type it, or type `/ai-dev:ask` followed
by their request in their own words. Do the work directly only if they say they
want a quick one-off instead.

| They ask for | Suggest |
| --- | --- |
| Setting the repo up for the team, installing Blueprint | `/ai-dev:setup` |
| A new feature or a change to an existing one, a requirement or user story to refine or plan | `/ai-dev:refine "<their request in one sentence>"` (or the path to a requirement file they mention) |
| Building what's in the build plan, continuing a build | `/ai-dev:build` |
| Reviewing a pull request | `/ai-dev:review pr <number>` |
| Reviewing a branch before it goes to a PR | `/ai-dev:review branch <branch>` |
| Reviewing existing code for vulnerabilities, optimisation, maintainability or test gaps | `/ai-dev:review audit <path> <lenses>` (lenses: `security`, `performance`, `quality`, `tests`) |
| What's running, what's waiting for them | `/ai-dev:status` |

Fill in what you can see: the folder that matches "the checkout code", the
lenses that match "vulnerabilities" (security) or "slow" (performance). Ask one
short question only if the target is unclear.

Small things stay outside the workflows: a typo, a one-line fix, explaining
code, answering a question. For a small bug fix, Blueprint's `/fix` is the
lighter path.
