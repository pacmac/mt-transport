'use strict';
// Cross-implementation test: parse the EXACT bytes the C++ ChunkServer emits.
//
// Frames come from ../../test/dump_frames, which runs the real device-side
// encoder. If the two implementations disagree on so much as a byte order this
// fails here, rather than on air where the only symptom would be a CRC failure
// after a minute of airtime.
//
// dump_frames lives in the mt-chunk library, which is at pio/mylibs — a SIBLING
// of projects/, not under this repo. node-dash flagged that the SPEC's relative
// paths implied otherwise.
//
//   MTC=/usr/share/pac/dev/pio/mylibs/mt-chunk
//   $MTC/test/dump_frames $MTC/test/fixtures/real_ov3660_outdoor.jpg /tmp/frames.bin
//   node test/cross-cpp.js /tmp/frames.bin $MTC/test/fixtures/real_ov3660_outdoor.jpg

const fs = require('fs');
const { ChunkClient, crc32, CHUNK_DATA_MAX } = require('../lib/chunk');

let pass = 0, fail = 0;
const check = (cond, what) => {
  if (cond) { pass++; }
  else { fail++; console.log(`  FAIL: ${what}`); }
};

function readFrames(path) {
  const raw = fs.readFileSync(path);
  const out = [];
  let o = 0;
  while (o + 2 <= raw.length) {
    const len = raw.readUInt16BE(o); o += 2;
    if (o + len > raw.length) break;
    out.push(raw.subarray(o, o + len)); o += len;
  }
  return out;
}

const framesPath = process.argv[2] || '/tmp/frames.bin';
const srcPath = process.argv[3];

const frames = readFrames(framesPath);
const source = srcPath ? fs.readFileSync(srcPath) : null;
console.log(`frames from C++: ${frames.length}`);

// --- 1. clean reassembly ----------------------------------------------------
const sent = [];
let c = new ChunkClient((f) => sent.push(f));
for (const f of frames) c.onFrame(f);

check(c.haveManifest, 'manifest decoded from C++ bytes');
check(c.complete, `all ${c.count} chunks received (${c.received})`);
check(c.verified, 'CRC verified against the C++ manifest');
if (source) check(Buffer.compare(c.buf, source) === 0, 'bytes identical to source file');
console.log(`  pid=${c.pid} len=${c.len} chunks=${c.count} crc=${c.crc.toString(16)}`);
console.log(`  computed crc=${crc32(c.buf).toString(16)}`);
check(frames.every((f) => f.length <= 237), 'no frame exceeded 237 bytes');

// --- 2. loss: drop every 3rd chunk, confirm it asks for exactly the gaps -----
c = new ChunkClient((f) => sent.push(f));
sent.length = 0;
frames.forEach((f, i) => { if (i === 0 || i % 3 !== 0) c.onFrame(f); });
check(!c.complete, 'incomplete after induced loss');
check(!c.verified, 'not verified while incomplete');
const asked = c.requestNext();
check(asked, 'requestNext() issues a pull for the first gap');
if (sent.length) {
  const p = sent[sent.length - 1];
  check(p.length === 6 && p[0] === 0x02, 'pull frame is 6 bytes, type 0x02');
  console.log(`  pull: pid=${p.readUInt16BE(1)} first=${p.readUInt16BE(3)} count=${p[5]}`);
  check(p[5] >= 1 && p[5] <= 16, 'pull count within 1..PULL_BATCH_MAX');
}

// --- 3. duplicates and reordering must not matter ---------------------------
c = new ChunkClient(() => {});
const shuffled = frames.slice(1).sort(() => 0.5 - Math.random());
c.onFrame(frames[0]);                       // manifest first
for (const f of shuffled) { c.onFrame(f); c.onFrame(f); } // every chunk twice
check(c.verified, 'verified despite reordering and duplicate delivery');

// --- 4. corruption must be caught -------------------------------------------
c = new ChunkClient(() => {});
for (const f of frames) c.onFrame(f);
c.buf[Math.floor(c.buf.length / 2)] ^= 0x01;
check(!c.verified, 'single flipped bit detected by CRC32');

// --- 5. stale pid dropped ----------------------------------------------------
c = new ChunkClient(() => {});
c.onFrame(frames[0]);
const before = c.received;
const bogus = Buffer.from(frames[1]);
bogus.writeUInt16BE(0x9999, 1);             // wrong pid
c.onFrame(bogus);
check(c.received === before, 'chunk with stale pid dropped, not blended');

// --- 6. a DUPLICATE manifest must not wipe progress -------------------------
// Regression from a real on-air failure: the JS port reallocated the buffer and
// cleared the received set on EVERY manifest, not just on a pid change. Since
// manifests arrive repeatedly (rebroadcast, and re-requested by the client),
// progress climbed to 22/32 and then reset to 0, over and over, and the
// transfer could never complete. The C++ client never had this bug — the port
// diverged from it.
c = new ChunkClient(() => {});
for (const f of frames) c.onFrame(f);
check(c.verified, 'complete before duplicate manifest');
const beforeDup = c.received;
c.onFrame(frames[0]);              // the manifest again
check(c.received === beforeDup, 'duplicate manifest did NOT reset progress');
check(c.verified, 'still verified after duplicate manifest');

// A manifest for a DIFFERENT pid must still reset — that is a replaced payload.
c.onFrame(Buffer.concat([Buffer.from([0x03,0x99,0x99]), frames[0].subarray(3)]));
check(c.received === 0, 'manifest for a different pid DOES reset');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
