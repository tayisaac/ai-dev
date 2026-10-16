---
name: review
description: 'ai-dev workflow. Review a PR, a branch or existing code with parallel lens reviewers and a validator, producing a report. Never edits code or posts to GitHub.'
argument-hint: 'pr <n> | branch <b> [--base <b>] | audit <path|full> [security] [performance] [quality] [tests]'
disable-model-invocation: true
allowed-tools: 'Read(/${CLAUDE_PLUGIN_ROOT}/**) Bash(ai-dev-orch *)'
---
# /ai-dev:review

1. Read `${CLAUDE_PLUGIN_ROOT}/coordinator/coordinator.md` and follow it for the
   rest of this run. It makes you the ai-dev coordinator.
2. Read `${CLAUDE_PLUGIN_ROOT}/coordinator/workflows/review.md` and follow it.

Workflow arguments: `$ARGUMENTS`
