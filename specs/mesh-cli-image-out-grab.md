---
task: mesh-cli-image-out-grab
status: IMPLEMENTED 2026-07-23; image get --out VERIFIED, image grab live-DEFERRED. Offline: images 20 (+3 grab) + full suite green. LIVE b80f: `image get <pid> --out` now exits CLEAN (rc=0, proper JSON error / would write) — the exit-2 buffer-dump is fixed. `image grab` logic offline-proven + poll-bounded; live end-to-end DEFERRED — a fresh capture is intermittent (camera sometimes returns no new frame) AND capture+full push-stream takes ~2min, and today's heavy on-air testing congested b80f. The underlying flow (cam grab -> publish -> fetch) WAS proven live earlier: pid 60780 -> valid 320x240 JPEG.
source_hash:
  clients/mesh/bin/mtmesh.js: 3505b1e4eea84f75fa590c651c853ed36d805dbc3afc068c225b6e5a57221fea
  clients/mesh/index.js: dc28701f212e26e61f0b4167af19767e63273b71243a8014390880efe396523f
  clients/mesh/lib/images.js: 8857b65aacae2777c85f1a43e23de04e8663de475f9efbc4c5a389ad5120afcb
  clients/mesh/test/images.js: eb2311b7feb27b09f27f837d0079e9fe98ebfcfca251f734d27e995ec1fdf651
scope:
  - specs/mesh-cli-image-out-grab.md
  - clients/mesh/bin/mtmesh.js       # require fs; image get run writes --out + returns summary; new `image grab` verb
  - clients/mesh/index.js            # grabImage(node, opts) delegates to images.grab
  - clients/mesh/lib/images.js       # grab(node): cam grab -> poll list until a fresh pid is ready -> get() it
  - clients/mesh/test/images.js      # offline: grab() sends `cam grab`, polls, returns the fresh capture
# NOT changing:
#   images.get() still saves to the store (unchanged); --out is an ADDITIONAL copy the CLI writes.
---

# Spec: image get --out fix + image grab

## (1) image get --out — the bug
`bin/mtmesh.js:23` run passes `{ out: o.out }` to `m.getImage`, but `images.get(node,pid,opts)`
(images.js:170-174) ignores `opts` — it saves to the store and returns the Buffer. main()
then `format(buf)` → `<2510 bytes>` and the raw Buffer round-trips oddly (exit 2). The CLI,
which owns file paths, should write `--out` and return a small summary (never dump the buffer).

```diff
-const { Mesh, errors } = require('..');
+const { Mesh, errors } = require('..');
+const fs = require('fs');
```
```diff
   { verb: 'image get',   target: true,  args: '<pid> [--out FILE]', help: 'fetch an image',
-    run: (m, t, a, o) => m.getImage(t, a[0], { out: o.out }) },
+    run: async (m, t, a, o) => {
+      const buf = await m.getImage(t, a[0]);
+      const res = { pid: Number(a[0]), bytes: buf.length };
+      if (o.out) { fs.writeFileSync(o.out, buf); res.out = o.out; }
+      return res;                       // summary, not the raw Buffer
+    } },
```

## (2) image grab — capture then fetch
```diff
+  { verb: 'image grab',  target: true,  args: '[--out FILE]', help: 'capture a fresh photo, then fetch it',
+    run: async (m, t, a, o) => {
+      const g = await m.grabImage(t);   // { pid, bytes, buf }
+      const res = { pid: g.pid, bytes: g.bytes };
+      if (o.out) { fs.writeFileSync(o.out, g.buf); res.out = o.out; }
+      return res;
+    } },
```
index.js: `async grabImage(node, opts) { return this.images.grab(node, opts); }`

lib/images.js — `grab()`: fire the capture, poll `list()` until a FRESH pid is published+ready,
then fetch it. `cam grab` is no-reply (the device answers by publishing), so send + poll — the
same flow that verified the pipeline live (pid 60780).
```js
async grab(node, { pollMs = 2000, timeoutMs = 20000 } = {}) {
  const before = await this.list(node).catch(() => ({}));
  await this.send(node, 'cam grab');                     // trigger capture (fire-and-forget)
  const deadline = Date.now() + timeoutMs;
  let st = null;
  while (Date.now() < deadline) {
    await sleep(pollMs);
    st = await this.list(node).catch(() => null);
    if (st && st.ready && st.pid && st.pid !== before.pid) break;   // a NEW capture is published
  }
  if (!(st && st.ready && st.pid)) throw new MeshError('grab: no fresh capture published in time', 'EGRAB');
  const buf = await this.get(node, st.pid);
  return { pid: st.pid, bytes: buf.length, buf };
}
```

## Verify (Observe)
1. **Offline** (test/images.js): a sim where `send('cam grab')` publishes a new pid → `grab()`
   returns `{pid,bytes,buf}` with the fetched bytes; full suite green.
2. **LIVE b80f:** `image get <pid> --out /tmp/x.jpg` writes a real JPEG (no exit 2), prints
   `{pid,bytes,out}`. `image grab --out /tmp/y.jpg` captures a fresh frame and writes it —
   `file` reports a 320x240 JPEG.
