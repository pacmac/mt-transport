---
task: mesh-download-stats
status: IMPLEMENTED + VERIFIED 2026-07-23. images 29 (+6: persisted stats after a repair-round get; outcome/crcOk/chunks/received/repairs/totalMs; file SURVIVES success) + full suite green. LIVE b80f: a stats record is written on every outcome (verified via a fast failure path) with the full field set; success-path numbers proven offline. Fixed a finally-masks-error bug (missing() is null pre-manifest).
source_hash:
  clients/mesh/lib/push-receiver.js: 7060f5761d0fe8ab2f69f4ac0ccee9d09c1a7bdc3d65cbc424414c7c023578ed
  clients/mesh/lib/store.js: 8510bbcdc784e8a8277290a74fdcd51b82322c49cbe6fda1050cb613d5f3f51e
  clients/mesh/lib/images.js: 1bf20a01e2a6e81b168bdc0d3dfa17489032390cf71affcbdbd2aee48acbd32d
  clients/mesh/index.js: 964eb99c9a230e28216101ba2da4802d5b6049476ccea6aa6758256b4b3c68ab
  clients/mesh/bin/mtmesh.js: 438e48267dbee384c5b310479999f63ad6f5b69d75c23b59a099ccbd76cc750e
  clients/mesh/test/images.js: 16294f2ced7c2ffb3b1434c0ca0a3ca985689cd449c73a77c29ad3b3af26beae
scope:
  - specs/mesh-download-stats.md
  - clients/mesh/lib/push-receiver.js   # firstRxMs (record on first chunk); lastRxMs already exists
  - clients/mesh/lib/store.js           # saveStats/loadStats -> <pid>.stats.json (persistent, NOT cleared)
  - clients/mesh/lib/images.js          # _drive try/finally -> _recordStats on EVERY outcome (success + failures)
  - clients/mesh/index.js               # imageStats(node,pid) accessor; emit 'image-stats'
  - clients/mesh/bin/mtmesh.js          # image get/grab summary includes the stats
  - clients/mesh/test/images.js         # a stats record is persisted with the right fields + survives success
# NOT changing:
#   get() still returns a Buffer (non-breaking); stats are persisted + emitted + returned alongside.
---

# Spec: mesh-download-stats — per-pid transfer telemetry that survives restarts

## The record (one JSON object per pid, `<pid>.stats.json`)
```
{ pid, node, outcome,        // 'ok' | 'EXFER' | 'ECRC' | 'EDEADLINE' | 'ENOIMG' | 'EABORT' | ...
  crcOk, bytes,
  chunks, received, missing, // count, unique received, final missing count
  repairs, repairIds, dupes, staleRounds, startsSent, queriesSent,   // from rx.stats
  startedAt, firstChunkAt, finishedAt,   // ms epoch
  totalMs, streamMs }        // total; streamMs = lastRx - firstRx (the actual on-air stream span)
```
Written on EVERY terminal outcome (success AND failure) and **kept** — the persistent
per-pid history you can read after a crash/restart. (The partial is still cleared/kept per
the resume rules; this stats file is separate and permanent.)

## Diffs

### lib/push-receiver.js — first-chunk timestamp
Constructor: `this.firstRxMs = null;`. In `onFrame`, on the FIRST accepted CHUNK:
`if (this.firstRxMs === null) this.firstRxMs = nowMs;` (lastRxMs already updates every frame).

### lib/store.js — persistent stats sidecar
```js
_statsPath(node, pid) { return path.join(this.dir, String(node).replace(/[^\w!-]/g, '_'), `pid${pid}.stats.json`); }
saveStats(node, pid, stats) { const p = this._statsPath(node, pid); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(stats, null, 2)); return p; }
loadStats(node, pid) { try { return JSON.parse(fs.readFileSync(this._statsPath(node, pid), 'utf8')); } catch { return null; } }
```

### lib/images.js — record on every outcome
Wrap `_drive`'s body in try/finally; set `outcome='ok'` + `bytes` in the success branch; the
catch captures `e.code`; the finally builds + persists + logs + emits the record:
```js
async _drive(entry, { onProgress, signal } = {}) {
  const { rx, node } = entry; const pid = rx.pid;
  const startedAt = Date.now(); let outcome = null, bytes = 0;
  try {
    ... existing body; success branch: outcome = 'ok'; bytes = buf.length; return { buf, path };
  } catch (e) { outcome = e.code || 'error'; throw e; }
  finally {
    const stats = {
      pid, node, outcome: outcome || 'unknown', crcOk: outcome === 'ok', bytes,
      chunks: rx.count, received: rx.received, missing: rx.missing ? rx.missing().length : null,
      repairs: rx.stats.repairsSent, repairIds: rx.stats.repairIds, dupes: rx.stats.dupes,
      staleRounds: rx.stats.staleRounds, startsSent: rx.stats.startsSent, queriesSent: rx.stats.queriesSent,
      startedAt, firstChunkAt: rx.firstRxMs, finishedAt: Date.now(), totalMs: Date.now() - startedAt,
      streamMs: (rx.firstRxMs && rx.lastRxMs) ? rx.lastRxMs - rx.firstRxMs : null,
    };
    try { this.store.saveStats(node, pid, stats); } catch (e) { this.log.debug('saveStats failed: %s', e && e.message); }
    this.log.info('image %s: pid %d %d/%d chunks, %d repairs, %d dupes, stream %ss total %ss',
      stats.outcome, pid, rx.received, rx.count, stats.repairs, stats.dupes,
      stats.streamMs != null ? (stats.streamMs / 1000).toFixed(1) : '?', (stats.totalMs / 1000).toFixed(1));
    this.emit('image-stats', stats);
  }
}
```
(EABORT/EPROTO/ENOIMG paths also flow through the finally → they too get a record.)

### index.js
`async imageStats(node, pid) { return this.images.store.loadStats(node, pid); }` and the
`'image-stats'` event is re-emitted (images.emit already forwards to Mesh).

### bin/mtmesh.js — show it
`image get`/`image grab` run: after the fetch, merge the persisted stats into the summary:
`return { pid, bytes, out, stats: await m.imageStats(t, pid) }` (stats undefined-safe).

## Verify (Observe)
1. **Offline** (test/images.js): after a successful `get()`, `store.loadStats(node,pid)` returns a
   record with `outcome:'ok'`, `crcOk:true`, `chunks`/`received` correct, `repairs>=1` for the lossy
   sim, and `totalMs`/`streamMs` numeric; the file **persists** after success (not cleared). Full suite green.
2. **LIVE b80f:** `image grab --json` shows a `stats` block; `pidN.stats.json` exists with real numbers
   (chunks, repairs, streamMs), and remains after the pull completes.
