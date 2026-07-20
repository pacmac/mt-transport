'use strict';
// Codec test for lib/chunk-push.js. No radio, no gateway, no device.
//
// The GOLDEN VECTORS below are duplicated verbatim in
// mylibs/mt-chunk-push/test/test_push_codec.cpp. That duplication is deliberate
// and load-bearing: it is the only thing that proves the JS and C++ codecs agree
// on the actual bytes. Two independently "correct" codecs that disagree on a
// field width produce a transfer that fails only on air — the most expensive
// place to find it.
//
// If you change a vector here, change it there too, or the pair stops meaning
// anything.
//
// Run: node test/offline-push.js

const assert = require('assert');
const p = require('../lib/chunk-push');

let pass = 0, fail = 0;

function t(name, fn) {
  try { fn(); pass++; console.log(`  ok   ${name}`); }
  catch (e) { fail++; console.log(`  FAIL ${name}\n       ${e.message}`); }
}

const hex = (b) => b.toString('hex').toUpperCase();

// ---- constants --------------------------------------------------------------
// Asserted, not assumed: these derive from the 237-byte protobuf buffer and a
// wrong value fails silently on hardware (send() returns false, frame never
// goes out).
console.log('constants');
t('MESH_PAYLOAD_MAX == 231', () => assert.strictEqual(p.MESH_PAYLOAD_MAX, 231));
t('PUSH_CHUNK_HEADER_LEN == 5', () => assert.strictEqual(p.PUSH_CHUNK_HEADER_LEN, 5));
t('CHUNK_DATA_MAX == 226', () => assert.strictEqual(p.CHUNK_DATA_MAX, 226));
t('REPAIR_IDS_MAX == 113', () => assert.strictEqual(p.REPAIR_IDS_MAX, 113));
t('MANIFEST_REPEAT_EVERY == 8', () => assert.strictEqual(p.MANIFEST_REPEAT_EVERY, 8));
t('type block is 0x10..0x16', () => {
  assert.strictEqual(p.MSG.START, 0x10);
  assert.strictEqual(p.MSG.COMPLETE, 0x16);
});

// ---- golden vectors ---------------------------------------------------------
console.log('golden vectors (must match test_push_codec.cpp byte for byte)');

t('START pid=1', () =>
  assert.strictEqual(hex(p.encodeStart(1)), '100001'));

// pid 1, IMAGE, 7156 bytes, 32 chunks, crc 0x65FBD5D9 — the real pid-1 test
// image already embedded in nRF program flash (test_image.h).
t('MANIFEST pid=1', () =>
  assert.strictEqual(hex(p.encodeManifest(1, p.PT.IMAGE, 7156, 32, 0x65FBD5D9)),
                     '1100010200001BF4002065FBD5D9'));

const body = Buffer.from([0xDE, 0xAD, 0xBE, 0xEF]);
t('CHUNK pid=1 seq=16', () =>
  assert.strictEqual(hex(p.encodeChunk(1, 16, body)), '1200010010DEADBEEF'));

t('PROGRESS_Q pid=1', () =>
  assert.strictEqual(hex(p.encodeProgressQ(1)), '130001'));

t('PROGRESS cur=32 done', () =>
  assert.strictEqual(hex(p.encodeProgress(1, 32, true)), '140001002001'));

t('PROGRESS cur=17 !done', () =>
  assert.strictEqual(hex(p.encodeProgress(1, 17, false)), '140001001100'));

// Scattered, non-contiguous ids — the case first+count could not express, and
// the reason REPAIR carries an explicit list.
t('REPAIR ids=[16,17,31]', () =>
  assert.strictEqual(hex(p.encodeRepair(1, [16, 17, 31])), '1500010300100011001F'));

t('COMPLETE pid=1', () =>
  assert.strictEqual(hex(p.encodeComplete(1, 0x65FBD5D9)), '16000165FBD5D9'));

// ---- round trip -------------------------------------------------------------
console.log('round trip');

t('manifest', () => {
  const f = p.decodeFrame(p.encodeManifest(7, p.PT.IMAGE, 7156, 32, 0x65FBD5D9));
  assert.strictEqual(f.type, p.MSG.MANIFEST);
  assert.strictEqual(f.pid, 7);
  assert.strictEqual(f.ptype, p.PT.IMAGE);
  assert.strictEqual(f.bytes, 7156);
  assert.strictEqual(f.count, 32);
  assert.strictEqual(f.crc, 0x65FBD5D9);
});

t('chunk', () => {
  const f = p.decodeFrame(p.encodeChunk(1, 16, body));
  assert.strictEqual(f.seq, 16);
  assert.ok(f.data.equals(body));
});

t('repair', () => {
  const f = p.decodeFrame(p.encodeRepair(1, [16, 17, 31]));
  assert.deepStrictEqual(f.ids, [16, 17, 31]);
});

t('progress done / !done', () => {
  const a = p.decodeFrame(p.encodeProgress(1, 32, true));
  assert.strictEqual(a.cursor, 32);
  assert.strictEqual(a.done, true);
  const b = p.decodeFrame(p.encodeProgress(1, 5, false));
  assert.strictEqual(b.cursor, 5);
  assert.strictEqual(b.done, false);
});

t('complete', () => {
  const f = p.decodeFrame(p.encodeComplete(9, 0x11223344));
  assert.strictEqual(f.pid, 9);
  assert.strictEqual(f.crc, 0x11223344);
});

t('start / progressQ', () => {
  assert.strictEqual(p.decodeFrame(p.encodeStart(3)).pid, 3);
  assert.strictEqual(p.decodeFrame(p.encodeProgressQ(4)).pid, 4);
});

// ---- malformed input must NEVER decode ---------------------------------------
// The whole point: a short frame decoding to plausible zeros is how a transfer
// ends up waiting forever on a chunk nobody will send.
console.log('malformed rejection');

const bad = (name, buf) => t(name, () => assert.strictEqual(p.decodeFrame(buf), null));

bad('empty', Buffer.alloc(0));
bad('null', null);
bad('unknown type 0x99', Buffer.from('990001', 'hex'));
// mt-chunk frames ride the same port 261; they must be rejected, not misparsed.
bad('mt-chunk MSG_PULL 0x02', Buffer.from('02000100000010', 'hex'));
bad('mt-chunk MSG_CHUNK 0x01', Buffer.from('01000100000020', 'hex'));
bad('mt-chunk MSG_BUSY 0x06', Buffer.from('0600010BB8', 'hex'));
bad('short manifest (13)',
    p.encodeManifest(1, p.PT.IMAGE, 7156, 32, 0x65FBD5D9).subarray(0, 13));
bad('chunk with no body', p.encodeChunk(1, 16, body).subarray(0, p.PUSH_CHUNK_HEADER_LEN));
bad('truncated chunk hdr', p.encodeChunk(1, 16, body).subarray(0, 4));
bad('repair truncated ids', p.encodeRepair(1, [16, 17, 31]).subarray(0, 9));
// Declares 3 ids but carries 1 — must be rejected on the byte count, not
// trusted from the header field.
bad('repair lies about n', Buffer.from('150001030010', 'hex'));
bad('repair n=0', Buffer.from('15000100', 'hex'));
bad('short progress (5)', Buffer.from('1400010020', 'hex'));
bad('short complete (6)', Buffer.from('16000165FBD5', 'hex'));

// ---- encoder bounds ----------------------------------------------------------
// null is never a valid frame, so a caller ignoring the return sends nothing
// rather than something truncated.
console.log('encoder bounds');

t('chunk over CHUNK_DATA_MAX -> null', () =>
  assert.strictEqual(p.encodeChunk(1, 0, Buffer.alloc(p.CHUNK_DATA_MAX + 1)), null));
t('chunk exactly CHUNK_DATA_MAX ok', () =>
  assert.strictEqual(p.encodeChunk(1, 0, Buffer.alloc(p.CHUNK_DATA_MAX)).length,
                     p.MESH_PAYLOAD_MAX));
t('repair over REPAIR_IDS_MAX -> null', () =>
  assert.strictEqual(
    p.encodeRepair(1, Array.from({ length: p.REPAIR_IDS_MAX + 1 }, (_, i) => i)), null));
t('repair at REPAIR_IDS_MAX ok', () =>
  assert.strictEqual(
    p.encodeRepair(1, Array.from({ length: p.REPAIR_IDS_MAX }, (_, i) => i)).length,
    p.REPAIR_HEADER_LEN + p.REPAIR_IDS_MAX * 2));
t('repair empty -> null', () => assert.strictEqual(p.encodeRepair(1, []), null));

// ---- CRC agreement -----------------------------------------------------------
// zlib.crc32 must be the SAME IEEE 802.3 reflected variant mtchunk::crc32 uses.
// Several CRC32s exist and they disagree; this pins it.
console.log('crc');
t('crc32("123456789") == 0xCBF43926', () =>
  assert.strictEqual(p.crc32(Buffer.from('123456789')), 0xCBF43926));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
