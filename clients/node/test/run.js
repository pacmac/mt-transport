'use strict';
// Skeleton smoke tests — no radio, no gateway. Proves the module loads, the
// command builder is correct, the queue serialises, and the chunk codec still
// parses real C++ encoder output.

const assert = require('assert');
const { cmd, target, parse260, parseAdverts, CommandQueue, chunk } = require('../index');

let pass = 0;
let skipped = 0;
const jobs = [];
const t = (name, fn) => jobs.push(async () => {
  try { await fn(); pass++; console.log(`  ok  ${name}`); }
  catch (e) { console.log(`  FAIL ${name}: ${e.message}`); process.exitCode = 1; }
});

console.log('mt-transport node skeleton\n');

t('command builder produces the device grammar', () => {
  assert.strictEqual(cmd.ping('336b'), '@336b ping');
  assert.strictEqual(cmd.chunkPull('336b', 2, 16, 16), '@336b chunk pull 2 16 16');
  assert.strictEqual(cmd.name('*', 'GRGE'), '@* name GRGE');
});

t('chunkInfo distinguishes discovery from a validated query', () => {
  // Bare form is DISCOVERY — "describe whatever you hold" — the only way a
  // caller learns a pid it does not yet know. It must stay pid-less.
  assert.strictEqual(cmd.chunkInfo('336b'), '@336b chunk info');
  // With a pid it is a VALIDATED query the device can refuse with GONE/NOSUCH.
  // A caller that knows the pid must use this form, or it gets whatever the
  // device happens to hold and is told that was a success.
  assert.strictEqual(cmd.chunkInfo('336b', 2), '@336b chunk info 2');
  // pid 0 must not collapse to the bare form — `undefined` selects discovery,
  // and 0 is a value, not an absence.
  assert.strictEqual(cmd.chunkInfo('336b', 0), '@336b chunk info 0');
});

t('target rejects whitespace (would break device tokenising)', () => {
  assert.throws(() => target('bad name'));
  assert.strictEqual(target('@336b'), '336b');
});

t('260 parser tolerates truncation instead of throwing', () => {
  const r = parse260(Buffer.from('{"type":"debug","boot":1'));
  assert.strictEqual(r.type, 'unparseable');
});

t('advert parser reads the agreed shape', () => {
  const a = parseAdverts({ av: [[7, 'img', 14832, 65]] });
  assert.strictEqual(a[0].pid, 7);
  assert.strictEqual(a[0].chunks, 65);
});

t('queue dedups identical pending commands', () => {
  // minSpacing 0 so the first command goes IN FLIGHT immediately — that is the
  // case the dedup originally missed.
  const q = new CommandQueue({ send: async () => {}, minSpacingMs: 0, timeoutMs: 50 });
  const a = q.enqueue('@336b ping');
  const b = q.enqueue('@336b ping');
  assert.strictEqual(a, b, 'same promise returned');
  // The queue rejects on timeout by design. Swallow it here — an unhandled
  // rejection would take the process down, which is exactly what happened the
  // first time this test was written.
  a.catch(() => {});
});

t('queue serialises: second command waits for the first', async () => {
  const sent = [];
  const q = new CommandQueue({ send: async (x) => sent.push(x), minSpacingMs: 0, timeoutMs: 5000 });
  const p1 = q.enqueue('@336b ping');
  const p2 = q.enqueue('@336b status');
  await new Promise((r) => setTimeout(r, 20));
  assert.strictEqual(sent.length, 1, 'only one in flight');
  q.onReply({ type: 'pong' });
  await p1;
  await new Promise((r) => setTimeout(r, 20));
  assert.strictEqual(sent.length, 2, 'second sent after first replied');
  q.onReply({ type: 'status' });
  await p2;
});

t('chunk codec round-trips a pull frame', () => {
  const f = chunk.encodePull(0x1234, 16, 99);
  assert.strictEqual(f.length, 6);
  assert.strictEqual(f[5], 16, 'count clamped to PULL_BATCH_MAX');
  const d = chunk.decodeFrame(Buffer.from([0x03,0,1,2,0,0,0x1B,0xF4,0,32,0x65,0xFB,0xD5,0xD9]));
  assert.strictEqual(d.type, chunk.MSG.MANIFEST);
  assert.strictEqual(d.count, 32);
  assert.strictEqual(d.crc >>> 0, 0x65FBD5D9);
});

t('crc32 matches the value agreed by device, camera and python', () => {
  const fs = require('fs');
  // Resolve from __dirname, NOT the cwd. This path used to be cwd-relative, so
  // it only found the fixture when the suite happened to be run from
  // clients/node; run from the repo root it silently skipped AND still printed
  // `ok`. The one check backing "CRC32 agrees across four implementations" was
  // therefore not running, while reporting that it had — the same
  // wrong-answer-that-looks-right failure this whole task is about.
  const p = require('path').resolve(
    __dirname, '../../../../../mylibs/mt-chunk/test/fixtures/real_ov3660_outdoor.jpg');
  if (!fs.existsSync(p)) {
    // mylibs is a sibling repo, so a standalone checkout may genuinely lack it.
    // Loud, and NOT counted as a pass — a silent skip is what hid this.
    console.log(`  SKIP  fixture missing: ${p}`);
    skipped++;
    return;
  }
  assert.strictEqual(chunk.crc32(fs.readFileSync(p)) >>> 0, 0x65FBD5D9);
});

(async () => {
  for (const j of jobs) await j();
  console.log(`\n${pass} passed${skipped ? `, ${skipped} SKIPPED` : ''}`);
})();
