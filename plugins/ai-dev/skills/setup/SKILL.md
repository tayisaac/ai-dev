---
name: setup
description: 'ai-dev workflow. One-time setup of this repo for the team: installs AI Blueprint, surveys the code, drafts the plans with you, sets up tests and Verify, and proves worktrees work.'
argument-hint: '(no arguments)'
disable-model-invocation: true
allowed-tools: 'Read(/${CLAUDE_PLUGIN_ROOT}/**) Bash(ai-dev-orch *)'
---
# /ai-dev:setup

1. Read `${CLAUDE_PLUGIN_ROOT}/coordinator/coordinator.md` and follow it for the
   rest of this run. It makes you the ai-dev coordinator.
2. Read `${CLAUDE_PLUGIN_ROOT}/coordinator/workflows/setup.md` and follow it.

Workflow arguments: `$ARGUMENTS`
