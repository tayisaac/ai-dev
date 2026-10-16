---
name: build
description: 'ai-dev workflow. Build approved build-plan items in parallel git worktrees (spec, build, check, review) and land them one at a time.'
argument-hint: '(no arguments)'
disable-model-invocation: true
allowed-tools: 'Read(/${CLAUDE_PLUGIN_ROOT}/**) Bash(ai-dev-orch *)'
---
# /ai-dev:build

1. Read `${CLAUDE_PLUGIN_ROOT}/coordinator/coordinator.md` and follow it for the
   rest of this run. It makes you the ai-dev coordinator.
2. Read `${CLAUDE_PLUGIN_ROOT}/coordinator/workflows/build.md` and follow it.

Workflow arguments: `$ARGUMENTS`
