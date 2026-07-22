'use strict';
// offline-json-ptype.js — v2 Phase 2: the generic JSON ptype (4).
//
// Deterministic, no radio. Two things are proven here:
//
//  1. CONFORMANCE — the JS ptype registry matches the C++ one byte for byte. The
//     firmware defines the wire; if these two drift, every machine-lane response
//     silently decodes as the wrong type. Parsed straight out of MtChunk.h rather
//     than restated here, so the test cannot agree with a stale copy of itself.
//
//  2. BEHAVIOUR — a MANIFEST(ptype=4) plus its CHUNKs reassembles, passes the
//     whole-payload CRC, parses as JSON, and routes on the JSON's own `t` field.
//     Routing on `t` (not on ptype) is the whole reason ONE generic ptype suffices.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { chunk } = require('../index');
const { MSG, PT, crc32, decodeFrame, ChunkClient } = chunk;

let pass = 0;
const t = (name, fn) => { fn(); pass++; console.log(`  ok  ${name}`); };

console.log('v2 JSON ptype (4)\n');

// ---- 1. cross-language conformance ------------------------------------------
t('ptype registry matches mylibs/mt-chunk/src/MtChunk.h', () => {
  const hdr = path.resolve(__dirname, '../../../../../mylibs/mt-chunk/src/MtChunk.h');
  if (!fs.existsSync(hdr))
    throw new Error(`MtChunk.h not found at ${hdr} — cannot verify conformance, and a ` +
                    `silent skip is exactly how the codecs would be allowed to drift`);
  const src = fs.readFileSync(hdr, 'utf8');
  const block = /enum\s+PayloadType\s*:\s*uint8_t\s*\{([\s\S]*?)\}/.exec(src);
  assert(block, 'PayloadType enum not found in MtChunk.h');
  const cpp = {};
  for (const m of block[1].matchAll(/PT_([A-Z]+)\s*=\s*(\d+)/g)) cpp[m[1]] = Number(m[2]);
  assert.strictEqual(cpp.JSON, 4, 'C++ PT_JSON must be 4');
  assert.strictEqual(PT.JSON, cpp.JSON, 'JS PT.JSON must equal C++ PT_JSON');
  // The pre-existing types must not have shifted underneath us either.
  assert.strictEqual(PT.SCHEMA, cpp.SCHEMA);
  assert.strictEqual(PT.IMAGE, cpp.IMAGE);
  assert.strictEqual(PT.LOG, cpp.LOG);
});

// ---- helpers: build the frames a device would emit ---------------------------
const manifest = (pid, ptype, bytes, count, crc) => {
  const b = Buffer.alloc(14);
  b[0] = MSG.MANIFEST; b.writeUInt16BE(pid, 1); b[3] = ptype;
  b.writeUInt32BE(bytes, 4); b.writeUInt16BE(count, 8); b.writeUInt32BE(crc, 10);
  return b;
};
const chunkFrame = (pid, idx, count, data) => {
  const b = Buffer.alloc(7 + data.length);
  b[0] = MSG.CHUNK; b.writeUInt16BE(pid, 1);
  b.writeUInt16BE(idx, 3); b.writeUInt16BE(count, 5);
  data.copy(b, 7);
  return b;
};

// ---- 2. a JSON payload round-trips through the chunk client ------------------
t('MANIFEST(ptype=JSON) + CHUNKs reassemble, verify CRC, and parse as JSON', () => {
  // Deliberately larger than one chunk, so reassembly is actually exercised.
  const obj = { t: 'config', ver: 1, beat: 60, det: { n: 3, win: 30 },
                pad: 'x'.repeat(400) };
  const payload = Buffer.from(JSON.stringify(obj));
  const N = chunk.CHUNK_DATA_MAX;
  const count = Math.ceil(payload.length / N);
  assert(count > 1, 'fixture must span multiple chunks');

  const cc = new ChunkClient(() => {});
  cc.onFrame(manifest(7, PT.JSON, payload.length, count, crc32(payload)));
  assert.strictEqual(cc.ptype, PT.JSON, 'client must record the JSON ptype');

  for (let i = 0; i < count; i++)
    cc.onFrame(chunkFrame(7, i, count, payload.subarray(i * N, (i + 1) * N)));

  assert(cc.complete, 'all chunks received');
  assert(cc.verified, 'whole-payload CRC must verify — truncation is impossible');
  const got = JSON.parse(cc.buf.toString());
  assert.strictEqual(got.t, 'config');
  assert.strictEqual(got.beat, 60);
  assert.strictEqual(got.det.n, 3);
});

// ---- 3. routing is on the JSON `t` field, NOT on ptype -----------------------
t('one ptype carries every response; `t` selects the handler', () => {
  const seen = [];
  const route = (buf) => { const j = JSON.parse(buf.toString()); seen.push(j.t); return j; };
  for (const ty of ['config', 'schema', 'debug', 'calc', 'env']) {
    const payload = Buffer.from(JSON.stringify({ t: ty, v: 1 }));
    const cc = new ChunkClient(() => {});
    cc.onFrame(manifest(9, PT.JSON, payload.length, 1, crc32(payload)));
    cc.onFrame(chunkFrame(9, 0, 1, payload));
    assert(cc.verified);
    assert.strictEqual(cc.ptype, PT.JSON, 'every one of them is ptype 4');
    assert.strictEqual(route(cc.buf).t, ty);
  }
  assert.deepStrictEqual(seen, ['config', 'schema', 'debug', 'calc', 'env']);
});

// ---- 4. adding ptype 4 must not disturb IMAGE --------------------------------
t('IMAGE (2) still decodes unchanged — ptype 4 is additive, not a format change', () => {
  const img = Buffer.alloc(500, 0xAB);
  const count = Math.ceil(img.length / chunk.CHUNK_DATA_MAX);
  const cc = new ChunkClient(() => {});
  cc.onFrame(manifest(11, PT.IMAGE, img.length, count, crc32(img)));
  for (let i = 0; i < count; i++)
    cc.onFrame(chunkFrame(11, i, count,
                          img.subarray(i * chunk.CHUNK_DATA_MAX, (i + 1) * chunk.CHUNK_DATA_MAX)));
  assert(cc.verified && cc.ptype === PT.IMAGE);
  assert.strictEqual(Buffer.compare(cc.buf, img), 0);
});

// ---- 5. a corrupt JSON payload must FAIL the CRC, not parse garbage ----------
t('corrupted payload fails the whole-payload CRC', () => {
  const payload = Buffer.from(JSON.stringify({ t: 'debug', boot: 3 }));
  const cc = new ChunkClient(() => {});
  cc.onFrame(manifest(13, PT.JSON, payload.length, 1, crc32(payload)));
  const bad = Buffer.from(payload); bad[5] ^= 0xFF;
  cc.onFrame(chunkFrame(13, 0, 1, bad));
  assert(cc.complete, 'it looks complete...');
  assert(!cc.verified, '...but the CRC must reject it rather than hand up bad JSON');
});

console.log(`\n${pass} passed`);
