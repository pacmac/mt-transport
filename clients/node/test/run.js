'use strict';
// Skeleton smoke tests — no radio, no gateway. Proves the module loads, the
// command builder is correct, the queue serialises, and the chunk codec still
// parses real C++ encoder output.

const assert = require('assert');
const { cmd, target, parse260, parseAdverts, CommandQueue, chunk } = require('../index');

let pass = 0;
const jobs = [];
const t = (name, fn) => jobs.push(async () => {
  try { await fn(); pass++; console.log(`  ok  ${name}`); }
  catch (e) { console.log(`  FAIL ${name}: ${e.message}`); process.exitCode = 1; }
});

console.log('mt-transport node skeleton\n');

t('command builder produces the device grammar', () => {
  assert.strictEqual(cmd.ping('336b'), '@336b ping');
  assert.strictEqual(cmd.chunkPull('336b', 16, 16), '@336b chunk pull 16 16');
  assert.strictEqual(cmd.name('*', 'GRGE'), '@* name GRGE');
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
  const p = '../../../../mylibs/mt-chunk/test/fixtures/real_ov3660_outdoor.jpg';
  if (!fs.existsSync(p)) { console.log('     (fixture absent, skipped)'); return; }
  assert.strictEqual(chunk.crc32(fs.readFileSync(p)) >>> 0, 0x65FBD5D9);
});

(async () => {
  for (const j of jobs) await j();
  console.log(`\n${pass} passed`);
})();
