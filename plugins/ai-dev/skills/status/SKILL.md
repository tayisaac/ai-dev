---
name: status
description: 'ai-dev: show every build, setup, refine and review run, and what''s waiting for you.'
disable-model-invocation: true
allowed-tools: 'Bash(ai-dev-orch *)'
---
# /ai-dev:status

Run `ai-dev-orch status` and show the output. If anything is waiting for the
user, list the exact replies it needs. Then stop: don't continue any run.
