#!/usr/bin/env bash
# Creates a small sample project with AI Blueprint and the ai-dev repo files
# (what /ai-dev:setup would add), ready to try every ai-dev workflow.
# Run it from a clone of the marketplace repo:
#
#   bash tools/setup-sample-project.sh                 # → ~/Projects/ai-dev-sample
#   bash tools/setup-sample-project.sh ~/somewhere/else
#
# The project: a tiny JavaScript library with three features in its build plan.
#   2. Greeting  and  3. Farewell  are independent, so they run in parallel.
#   4. Messages  depends on both, so it starts only after both have landed.
# It also has a small, deliberately flawed module (src/legacy/orders.js) for
# trying /ai-dev:review.

set -euo pipefail

PLUGIN="$(cd "$(dirname "$0")/../plugins/ai-dev" && pwd)"
DEST="${1:-$HOME/Projects/ai-dev-sample}"

say()  { printf '\n\033[1m%s\033[0m\n' "$*"; }
fail() { printf '\n✗ %s\n' "$*" >&2; exit 1; }

# ── Checks ───────────────────────────────────────────────────────────────────
[ -f "$PLUGIN/orchestrator/orch.mjs" ] || fail "Run this script from a clone of the ai-dev marketplace repo (it needs plugins/ai-dev)."
command -v git  >/dev/null || fail "git is not installed."
command -v node >/dev/null || fail "Node.js is not installed. Install Node 18 or later."
command -v npx  >/dev/null || fail "npx is not available (it comes with Node.js)."
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 18 ] || fail "Node $NODE_MAJOR found; Node 18 or later is needed."
[ -e "$DEST" ] && fail "$DEST already exists. Remove it, or pass a different folder."

# ── App ──────────────────────────────────────────────────────────────────────
say "Creating the sample app in $DEST"
mkdir -p "$DEST"
cd "$DEST"
git init -q -b main
git config user.name  >/dev/null 2>&1 || git config user.name  "Blueprint Sample"
git config user.email >/dev/null 2>&1 || git config user.email "sample@example.com"

cat > package.json <<'EOF'
{
  "name": "greetings-sample",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "node --test",
    "verify": "node --test"
  }
}
EOF
mkdir -p src test
echo 'export const VERSION = "1.0.0";' > src/index.js
cat > test/smoke.test.js <<'EOF'
import test from "node:test";
import assert from "node:assert";
import { VERSION } from "../src/index.js";

test("version is set", () => assert.strictEqual(VERSION, "1.0.0"));
EOF
mkdir -p src/legacy
cat > src/legacy/orders.js <<'EOF2'
// Deliberately flawed legacy code, for trying /ai-dev:review audit.
export function findOrders(db, customerId, status) {
  // Builds SQL by string concatenation.
  return db.query("SELECT * FROM orders WHERE customer_id = " + customerId + " AND status = '" + status + "'");
}

export async function orderTotals(db, orderIds) {
  const totals = [];
  for (const id of orderIds) {
    // One query per order.
    const lines = await db.query("SELECT price, qty FROM order_lines WHERE order_id = " + id);
    totals.push(lines.reduce((sum, l) => sum + l.price * l.qty, 0));
  }
  return totals;
}
EOF2
printf 'node_modules/\n.DS_Store\n' > .gitignore

# ── Blueprint ────────────────────────────────────────────────────────────────
say "Installing AI Blueprint (Claude Code adapter)"
npx --yes create-ai-blueprint@latest --claude --yes

# ── ai-dev repo files (what /ai-dev:setup adds) ─────────────────────────────
say "Adding the ai-dev rule file, config and permission"
node --input-type=module -e "const m = await import(process.argv[1]); console.log(m.writeRepoFiles(process.cwd()));" "$PLUGIN/orchestrator/workflows.mjs"

# ── Plans (normally from /discovery or written by you, then /overview) ──────
say "Writing the sample plans"
cat > blueprint/project-plan.md <<'EOF'
# Project Plan

## Product
A tiny JavaScript (ES modules) library of message helpers. It exists to try
out the /ai-dev workflows, so every feature is deliberately small.

## Users
Developers who import the helpers.

## Stack
Node 18+, plain JavaScript ES modules, the built-in `node:test` runner. No
dependencies.

## Features
- Greeting and farewell helpers, each in its own module.
- A single entry point that re-exports every helper.

## Out of scope
Input validation, internationalisation, publishing to npm.
EOF

cat > blueprint/build-plan.md <<'EOF'
# Build Plan

## Your features

- [x] 1. **Project setup** - package.json, `src/index.js` and the `node:test` runner
- [ ] 2. **Greeting** - `greet(name)` in `src/greet.js` returns "Hello, <name>!", with a test in `test/greet.test.js`
  - touches: greet
- [ ] 3. **Farewell** - `farewell(name)` in `src/farewell.js` returns "Goodbye, <name>!", with a test in `test/farewell.test.js`
  - touches: farewell
- [ ] 4. **Messages entry point** - `src/index.js` re-exports `greet` and `farewell` alongside `VERSION`, with a test in `test/index.test.js`
  - depends: 2, 3
  - touches: index
EOF

cat > blueprint/context/project-overview.md <<'EOF'
# Project Overview

## Product
A tiny ES-module JavaScript library of message helpers. No UI, no server, no
dependencies.

## Architecture
- Node 18+, ES modules (`"type": "module"` in package.json).
- One module per helper in `src/`, one test file per module in `test/`, using
  `node:test` and `node:assert`.
- `src/index.js` is the public entry point.
- Verify: `npm run verify` (runs `node --test`).

## Features
1. Project setup (done): package.json, `src/index.js` exporting `VERSION`, smoke test.
2. Greeting: `greet(name)` in `src/greet.js` returns `Hello, <name>!`. Test in `test/greet.test.js`.
3. Farewell: `farewell(name)` in `src/farewell.js` returns `Goodbye, <name>!`. Test in `test/farewell.test.js`.
4. Messages entry point: `src/index.js` re-exports `greet` and `farewell` alongside `VERSION`. Test in `test/index.test.js`. Builds on 2 and 3.

## UX
None (library).
EOF

# Replace the Next.js placeholder Commands section with this project's real commands.
node - <<'EOF'
const fs = require("fs");
const p = "AGENTS.md";
let t = fs.readFileSync(p, "utf8");
const start = t.indexOf("## Commands");
if (start < 0) { console.error("AGENTS.md has no Commands section; add `- Verify: \\`npm run verify\\`` by hand."); process.exit(0); }
let end = t.indexOf("\n## ", start + 5);
if (end < 0) end = t.length;
t = t.slice(0, start) + "## Commands\n\n- Test: `npm test`\n- Verify: `npm run verify`\n" + t.slice(end);
fs.writeFileSync(p, t);
EOF

# ── Check and commit ─────────────────────────────────────────────────────────
say "Checking the sample runs"
npm test --silent >/dev/null || fail "The sample's tests failed."
node "$PLUGIN/bin/ai-dev-orch" status >/dev/null || fail "The ai-dev engine didn't run."

git add -A
git commit -q -m "Sample project with AI Blueprint and ai-dev"

say "Ready: $DEST"
cat <<EOF

Next:
  1. cd "$DEST"
  2. claude                (accept the "trust this folder" prompt)
                           The ai-dev plugin must be installed (see README.md), or try
                           this clone directly:  claude --plugin-dir "$PLUGIN"
  3. Shift+Tab until the mode shows "accept edits" (fewer permission prompts)
  4. Try a workflow:
       /ai-dev:build                                build items 2–4 (approve 2 3, land 2, …)
       /ai-dev:review audit src/legacy security performance
       /ai-dev:refine "Greet people in their own language"

See tools/TESTING.md in the marketplace repo for what to expect.
EOF
