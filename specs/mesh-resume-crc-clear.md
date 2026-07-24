---
task: mesh-resume-crc-clear
status: IMPLEMENTED + VERIFIED (offline) 2026-07-23. images 23 (+3: corrupt->EXFER, corrupt partial CLEARED, incomplete never-corrupt) + full suite green. Live: downloads work (26502 clean); forcing an on-air corruption isn't practical, so the selective-clear is proven offline (definitive). Fixes the 30825 resume-poisoning.
source_hash:
  clients/mesh/lib/push-receiver.js: 2ec8a872c9a42c95a8dd619976a1f82849446224aeed1a217b21628a0f0c9d9c
  clients/mesh/lib/images.js: c12ec0ebb5adaebaa021e2037281fedafa44656ef2a5b83042a928e97464a266
  clients/mesh/test/images.js: 6281144a7301e70be19b546e701c1bcd488d2339590ff8987ad753fb6957f104
scope:
  - specs/mesh-resume-crc-clear.md
  - clients/mesh/lib/push-receiver.js   # add a `corrupt` flag, set when assemble() fails CRC on a complete set
  - clients/mesh/lib/images.js          # _drive: clearPartial only when corrupt (EXFER-corrupt + ECRC), not on missing-chunk failures
  - clients/mesh/test/images.js         # corrupt-complete-set -> EXFER + partial CLEARED; missing-chunk -> partial KEPT
# NOT changing:
#   the deadline / stuck / unresponsive paths keep the partial (resume is the point).
#   per-chunk CRC (the deeper fix that would let us re-fetch just the bad chunk) — separate task.
---

# Spec: clear the persisted partial on a whole-image CRC failure

## Why
No per-chunk CRC exists, so a chunk can be saved "present" with wrong bytes; only the
whole-image CRC catches it, at the end, without identifying which chunk. Resume then
re-assembles the same corrupt data forever. Since we can't pinpoint the bad chunk, the
only safe recovery is to discard the partial and re-fetch — but ONLY for corruption, not
for a merely-incomplete transfer (which resume is designed to continue).

## Diffs

### lib/push-receiver.js — flag corruption
Constructor (near `this.failed = null;`):
```diff
     this.failed = null;
+    this.corrupt = false;   // set when a COMPLETE set fails the whole-image CRC (unrecoverable by resume)
```
Where the complete-set CRC fails (~:184):
```diff
-      if (!asm) { this.failed = 'CRC mismatch on a complete set'; return null; }
+      if (!asm) { this.failed = 'CRC mismatch on a complete set'; this.corrupt = true; return null; }
```

### lib/images.js — clear only on corruption
`_drive` failure handling (~:155-158):
```diff
-      if (rx.failed) throw new MeshError(`image ${pid}: ${rx.failed}`, 'EXFER');
+      if (rx.failed) {
+        // Corrupt (CRC-mismatch on a complete set) -> the persisted partial holds bad bytes and
+        // resume can't recover it, so drop it and force a fresh re-fetch. Incompleteness
+        // (stuck / unresponsive) KEEPS the partial: resume is exactly how a marginal link converges.
+        if (rx.corrupt) this.store.clearPartial(node, pid);
+        throw new MeshError(`image ${pid}: ${rx.failed}`, 'EXFER');
+      }
       if (rx.done) {
         const buf = rx.assemble();
-        if (!buf) throw new MeshError(`image ${pid}: complete but CRC failed`, 'ECRC');
+        if (!buf) { this.store.clearPartial(node, pid); throw new MeshError(`image ${pid}: complete but CRC failed`, 'ECRC'); }
```
(`EDEADLINE` at ~:166 is unchanged — missing chunks, keep the partial.)

## Verify (Observe)
1. **Offline** (test/images.js): a device sim that streams a full set with ONE chunk's bytes
   corrupted → `get()` throws `EXFER` AND `store.loadPartial(node,pid)` returns **null** (cleared).
   A separate missing-chunk/deadline failure → the partial is **still present** (kept for resume).
   Existing images assertions stay green.
2. **LIVE b80f:** a fresh capture that (if it) CRC-fails no longer sticks — the next `image get`
   re-streams instead of re-serving the corrupt partial. (The 30825 repro is what this prevents;
   26502 already pulls clean.)
