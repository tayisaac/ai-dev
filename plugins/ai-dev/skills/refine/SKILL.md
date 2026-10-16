---
name: refine
description: 'ai-dev workflow. Refine a requirement with you (from one sentence or a file), check it against the code, and propose build-plan items.'
argument-hint: '"<one sentence>" | <path/to/requirement.md> [--quick]'
disable-model-invocation: true
allowed-tools: 'Read(/${CLAUDE_PLUGIN_ROOT}/**) Bash(ai-dev-orch *)'
---
# /ai-dev:refine

1. Read `${CLAUDE_PLUGIN_ROOT}/coordinator/coordinator.md` and follow it for the
   rest of this run. It makes you the ai-dev coordinator.
2. Read `${CLAUDE_PLUGIN_ROOT}/coordinator/workflows/refine.md` and follow it.

Workflow arguments: `$ARGUMENTS`
