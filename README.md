# ai-dev marketplace

A Claude Code plugin marketplace with one plugin, **ai-dev**: an AI dev team
built on [AI Blueprint](https://ai-blueprint.dev). Subagents do the work using
Blueprint's skills, a rules engine and two hooks enforce the order, and you
approve every step that matters.

| Command | What it does | You approve with |
| --- | --- | --- |
| `/ai-dev:setup` | One-time setup of a repo: installs Blueprint, surveys the code, drafts the plans with you, sets up tests and Verify, and proves worktrees work | `approve install`, `approve plans`, `land setup` |
| `/ai-dev:refine "<sentence or file>"` | Refines a requirement with you (from one sentence if that's all you have), checks it against the code, and proposes build-plan items | `approve plan` |
| `/ai-dev:build` | Builds approved items in parallel git worktrees (spec, build, check, review), then lands them one at a time | `approve <id>`, `land <id>` |
| `/ai-dev:review pr <n>` · `branch <b>` · `audit <path> [lenses]` | Parallel lens reviewers and a validator produce a report. Never edits code or posts to GitHub | `fix R-…`, `accept R-… <reason>`, `finish review` |
| `/ai-dev:status` | Shows every run and what's waiting for you | — |
| `/ai-dev:ask <plain words>` | Works out the right command from your description and starts only when you reply `yes` | `yes` |

Details of how it works are in [plugins/ai-dev/README.md](plugins/ai-dev/README.md).

## Install (each developer, once)

Needs Claude Code, Node 18+ and git 2.31+. In Claude Code:

```
/plugin marketplace add tayisaac/ai-dev
/plugin install ai-dev@ai-dev-marketplace
```

Or from a terminal:

```bash
claude plugin marketplace add tayisaac/ai-dev
claude plugin install ai-dev@ai-dev-marketplace
```

The plugin's install id is `ai-dev@ai-dev-marketplace`: the plugin name, then
the marketplace name from `.claude-plugin/marketplace.json`.

## Set up a repo (once per repo)

Open Claude Code in the repo (on a clean checkout) and run `/ai-dev:setup`. It
works on an `ai-dev/setup` branch and commits, for the whole team:

- AI Blueprint, with any existing `AGENTS.md` and `CLAUDE.md` content kept
- the plans, coding standards and commands, drafted with you
- `.claude/rules/ai-dev.md`, which has Claude suggest `/ai-dev` commands for plain-language requests
- `.claude/ai-dev.json`: concurrency, repair limit, Verify command, worktree setup
- an allow rule for `ai-dev-orch` in `.claude/settings.json`, so the coordinator isn't prompted at every step

## Roll out to a team

**Per repo:** add this to the repo's `.claude/settings.json` and commit it.
Anyone who opens the repo in Claude Code and accepts the trust prompt gets the
marketplace and the plugin.

```json
{
  "extraKnownMarketplaces": {
    "ai-dev-marketplace": {
      "source": { "source": "github", "repo": "tayisaac/ai-dev" }
    }
  },
  "enabledPlugins": {
    "ai-dev@ai-dev-marketplace": true
  }
}
```

**Whole organisation:** an Owner of a Claude Team or Enterprise organisation can
put the same two keys in managed settings at
[claude.ai/admin-settings/claude-code](https://claude.ai/admin-settings/claude-code).
It then installs on every machine, and users can't turn it off. See
[Manage plugins for your organization](https://code.claude.com/docs/en/plugins/org).

## Updates

Releases are versioned by `version` in
[`plugins/ai-dev/.claude-plugin/plugin.json`](plugins/ai-dev/.claude-plugin/plugin.json).
To release, change the plugin, bump `version`, and push. Developers then run:

```bash
claude plugin update ai-dev@ai-dev-marketplace
```

To have updates arrive automatically, turn on auto-update for this marketplace
in `/plugin`, or add `"autoUpdate": true` to its `extraKnownMarketplaces` entry.

Teams don't edit the plugin's files in their repos: plugin files are replaced on
every update. Per-repo settings go in `.claude/ai-dev.json`. Changes to agents,
models or workflows go into this repository as a new release.

## Try it first

From a clone of this repository:

```bash
bash tools/setup-sample-project.sh
cd ~/Projects/ai-dev-sample
claude
```

The sample has Blueprint, a three-item build plan and a deliberately flawed
module to review. [tools/TESTING.md](tools/TESTING.md) walks through each workflow.
To try a local clone without installing it, start Claude Code with
`claude --plugin-dir <clone>/plugins/ai-dev`.

## Moving from the copy-in kit

If a repo has the earlier copy-in version (`.claude/orchestrator/`), remove it
before enabling the plugin, so the two don't both run their hooks:

1. Delete `.claude/orchestrator/`, `.claude/skills/ai-dev/`, `.claude/skills/ai-dev-*/`, `.claude/agents/ai-dev-*.md` and `.claude/rules/ai-dev.md`.
2. Remove the kit's `hooks` entries and its `orch.mjs` allow rule from `.claude/settings.json`.
3. Move any settings you changed in `.claude/orchestrator/config.json` to `.claude/ai-dev.json`.
4. Commit, install the plugin, and run `/ai-dev:setup`. On a repo where Blueprint is already installed it skips the install and builds on what's there.

Finish any active runs first: `node .claude/orchestrator/orch.mjs status`.

## Layout

```
.claude-plugin/marketplace.json   the marketplace: lists the ai-dev plugin
plugins/ai-dev/                   the plugin
  .claude-plugin/plugin.json      name, version, description
  skills/                         ask, setup, refine, build, review, status, suggest
  coordinator/                    the shared coordinator rules and one file per workflow
  agents/                         the 16 subagents
  hooks/hooks.json                registers the guard and approvals hooks
  bin/ai-dev-orch                 the rules engine command (on the Bash PATH while enabled)
  orchestrator/                   engine, stage tables and hooks (Node, no dependencies)
  templates/                      the rule file and default config that setup adds to a repo
tools/                            sample project script and test walkthrough
```
