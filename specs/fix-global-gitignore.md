---
task: fix-global-gitignore
status: proposed
source_hash: ~
updated: 2026-07-19
scope:
  - /root/.gitignore_global   # outside the workspace; the target of this fix
---

# Spec: fix-global-gitignore — unanchored source-dir names ignore real source

## 1. The bug

`/root/.gitignore_global` (git's `core.excludesFile`, applied to EVERY repo) has
directory patterns with **no leading slash**, so git matches them at any depth,
in every repository. Several are common **source** directory names:

| line | pattern | origin | why it is wrong globally |
|---|---|---|---|
| 38 | `lib/`   | Python packaging build dir | ignores every `lib/` source dir in every repo — this hid `clients/node/lib/` (the entire mt-transport Node client core: commands.js, chunk.js, store.js, events.js, queue.js, payloads.js). The committed `index.js` `require()`s those, so a fresh clone had a broken client. |
| 39 | `lib64/` | Python packaging build dir | same class; unanchored, catches any `lib64/`. |
| 121 | `bin/`  | "build directories" block | `bin/` is a very common source/script dir (CLI entry points, helper scripts); ignoring it globally silently drops source. |

Peter, 2026-07-19: the blanket `lib/` "should only apply to the linux /lib
folder there may be other similar issues. fix them."

## 2. The fix — two categories, only one is touched

A global ignore must carry ONLY patterns that are correct in *every* repo. Split
the entries by that test:

**A. MUST always be ignored, in every repo — KEEP every one.** These are never
source and must never be committed anywhere:
`node_modules/`, `__pycache__/`, `venv/`/`env/`/`ENV/`, `build/`, `dist/`,
`out/`, `target/`, `.cache/`, `develop-eggs/`, `downloads/`, `eggs/`, `.eggs/`,
`wheels/`, `sdist/`, `parts/`, `var/`, plus all the file-glob artifacts
(`*.o`, `*.pyc`, `*.class`, `*.log`, editor/OS files, secrets). Peter,
2026-07-19: "node_modules/, __pycache__/ must never be included in any repo" —
exactly; they stay.

**B. Commonly SOURCE directory names — REMOVE (this is the whole bug):**
`lib/` (38), `lib64/` (39), `bin/` (121). Unanchored, they ignore real source
in every repo (this hid the entire `clients/node/lib/`). A project that really
emits build output into `lib/` or `bin/` ignores it in its OWN `.gitignore`,
where the intent is local and visible — never silently, everywhere.

Only category B is removed. Category A is left exactly as-is.

## 3. Not in scope (reported, not fixed here)

- **Duplicate lines** — `build/` (32, 118), `dist/` (34, 119), `*.log` (60, 124),
  `*.so` (30, 94), `*.out` (97, 111), `*~` (9, 144). Cosmetic; a dedup pass is a
  separate, low-value cleanup.
- `*.spec` (49) — RPM/Python spec pattern. This project's specs are `.md`, so it
  does not touch them; left.

## 4. Verification

- `git check-ignore -v clients/node/lib/chunk.js` → **no match** (was matching
  `/root/.gitignore_global:38`).
- `git check-ignore` for `node_modules`, `__pycache__`, `build`, `dist`,
  `venv` → **still ignored**, proving category A is untouched and the fix is
  surgical, not a wholesale gutting.
- Then the follow-through (task step 3): `git add clients/node/lib` succeeds
  normally, making the Node client complete in git for the first time — this
  also lands the payload-identity `commands.js` fix and the chunk-resume
  `store.js`/`chunk.js` work that were stranded by the ignore.

This is a user-dotfile fix, so there is no repo commit for `.gitignore_global`
itself; the observable result is the `git check-ignore` behaviour and the
now-trackable `clients/node/lib/`.
