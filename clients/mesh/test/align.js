'use strict';
// Alignment measurement: signalQuality/bands (node-dash's EXACT numbers), burst averaging,
// the view-model, and per-radio attribution. Offline — a fake send, no radio.
//
// The signalQuality assertions are the most important in this file. If our numbers drift
// from node-dash's, the align page disagrees with the rest of their UI for the same node,
// which is worse than being consistently slightly wrong. Their implementation was given
// verbatim on xsession (src/utils.js:24) and is reproduced in the expectations below.
const assert = require('assert');
const { Align, signalQuality, qualityBand } = require('../lib/align');
const ACFG = require('../lib/settings').load({ config: {} }).align;

let pass = 0;
const ok = (c, m) => { assert(c, m); pass++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- signalQuality: SNR weighted 60%, RSSI 40% -----------------------------
{
  // Computed from their formula: clamp01((snr+20)/30)*0.6 + clamp01((rssi+120)/70)*0.4
  const expect = (rssi, snr) => {
    const s = Math.max(0, Math.min(1, (snr + 20) / 30));
    const r = Math.max(0, Math.min(1, (rssi + 120) / 70));
    return Math.round((s * 0.6 + r * 0.4) * 100);
  };
  for (const [rssi, snr] of [[-55, 7], [-120, -14], [-90, 0], [-70, 5], [-30, 12], [-127, -20]]) {
    ok(signalQuality(rssi, snr) === expect(rssi, snr), `signalQuality(${rssi},${snr}) matches node-dash exactly`);
  }
  ok(signalQuality(null, null) === 0, 'no data -> 0');
  // A single input must use ONLY that input's score, not treat the other as zero.
  ok(signalQuality(-55, null) === Math.round(Math.max(0, Math.min(1, (-55 + 120) / 70)) * 100), 'rssi only -> rssi score alone');
  ok(signalQuality(null, 7) === Math.round(Math.max(0, Math.min(1, (7 + 20) / 30)) * 100), 'snr only -> snr score alone');
  // Clamping at both ends.
  ok(signalQuality(-200, -50) === 0, 'far below range clamps to 0');
  ok(signalQuality(0, 30) === 100, 'far above range clamps to 100');
}

// ---- bands: Excellent >=76, Good >=51, Fair >=26, else Poor ----------------
{
  ok(qualityBand(76).label === 'Excellent' && qualityBand(76).cls === 'success', '76 -> Excellent');
  ok(qualityBand(75).label === 'Good', '75 -> Good (boundary)');
  ok(qualityBand(51).label === 'Good', '51 -> Good');
  ok(qualityBand(50).label === 'Fair' && qualityBand(50).cls === 'warning', '50 -> Fair (boundary)');
  ok(qualityBand(26).label === 'Fair', '26 -> Fair');
  ok(qualityBand(25).label === 'Poor' && qualityBand(25).cls === 'error', '25 -> Poor (boundary)');
  ok(qualityBand(null).label === '—', 'null -> em dash, not a fabricated band');
}

// ---- clamps ----------------------------------------------------------------
{
  // Clamps are INSTANCE methods now — the bounds are config (align.*), not constants, so
  // they cannot be tested as free functions any more.
  const a = new Align({ cfg: ACFG });
  ok(a._clampN(0) === 4 && a._clampN(9) === 5 && a._clampN(3) === 3, 'n clamps to 1..5, default 4');
  ok(a._clampWindow(1) === 5 && a._clampWindow(999) === 120 && a._clampWindow(45) === 45, 'reply window clamps 5..120');
  // And they must FOLLOW config rather than the defaults.
  const b = new Align({ cfg: { ...ACFG, burstMax: 3, replyWindowMaxSec: 60 } });
  ok(b._clampN(9) === 3, 'burst max comes from config');
  ok(b._clampWindow(999) === 60, 'reply window max comes from config');
}

// ---- the view-model --------------------------------------------------------
function mkAlign(sent) {
  const cache = new Map();
  return new Align({
    cfg: ACFG,
    send: async (text, opts) => { const id = 100 + sent.length; sent.push({ text, opts, id }); return { id }; },
    radios: { omni: '!2687afb1', yagi: '!fa39f7b4' },
    addrOf: (addr) => ({ 'E9:B0:3F:17:27:91': '!2687afb1', 'F4:12:FA:39:F7:B6': '!fa39f7b4' }[addr] || null),
    channel: 2,
    cache: { value: (ns, k) => cache.get(`${ns}/${k}`) ?? null, put: (ns, k, v) => cache.set(`${ns}/${k}`, v) },
  });
}

(async () => {
  // Idle model — a consumer must get a renderable shape before anything starts.
  {
    const a = mkAlign([]);
    const v = a.view();
    ok(v.kind === 'align' && v.running === false, 'idle: kind + running:false');
    ok(v.readings.length === 0 && v.current === null && v.best === null, 'idle: nothing to render');
    ok(v.replyWindowSec === 30, 'idle: default reply window');
  }

  // A burst: pings addressed by hex SUFFIX (never the editable short name).
  {
    const sent = [];
    const a = mkAlign(sent);
    a.start({ num: 0x8cee336b, txLabel: 'OMNI', channel: 2 });
    ok(a.view().running === true && a.view().target === 0x8cee336b, 'session started');
    ok(a.view().tx === 'OMNI' && a.view().channel === 2, 'tx + channel reported to the UI');

    const p = a.ping(2);
    await sleep(20);
    ok(sent.length >= 1, 'burst sends a ping immediately');
    ok(sent[0].text === '@336b ping', 'addressed by node-id SUFFIX, not the short name');
    ok(a.view().burst && a.view().burst.of === 2, 'burst progress is in the model');

    // Both radios hear the pong; the DEVICE's own reading is the primary signal.
    a.onPong({ type: 'pong', rssi: -55, snr: 7 }, sent[0].id, 'E9:B0:3F:17:27:91');
    a.onEnvelope(sent[0].id, 'E9:B0:3F:17:27:91', -60, 6);
    a.onEnvelope(sent[0].id, 'F4:12:FA:39:F7:B6', -70, 3);
    await sleep(1400);                     // collect window closes
    const v = a.view();
    ok(v.readings.length >= 1 || v.burst, 'a landed pong produces progress or a reading');
    await p;
    // Clear the session: an unresolved burst leaves a ~31 s deadline timer pending, which
    // holds the event loop open and makes the whole suite look like it hangs.
    a.stop();
  }

  // Averaging + trend + best across two readings.
  {
    const sent = [];
    const a = mkAlign(sent);
    a.start({ num: 0x8cee336b });
    // Drive the internals deterministically rather than waiting out real burst timing.
    a.session.readings.push({ n: 1, quality: 40, label: 'Fair', cls: 'warning', spread: 2, got: 4, of: 4, rssi: -90, snr: 0, yagi_q: 30, omni_q: 50 });
    a.session.readings.push({ n: 2, quality: 70, label: 'Good', cls: 'success', spread: 1, got: 4, of: 4, rssi: -70, snr: 5, yagi_q: 60, omni_q: 80 });
    a.session.readingCount = 2;
    const v = a.view();
    ok(v.readings[1].trendDir === 'up' && v.readings[1].trendDelta === 30, 'trend vs the previous reading');
    ok(v.readings[0].trendDir === null, 'the first reading has no trend');
    ok(v.best.n === 2 && v.readings[1].isBest === true, 'best is the highest quality');
    ok(v.current.n === 2 && v.current.gapToBest === 0 && v.current.bestAgo === 0, 'current IS the best -> gap 0');
    ok(v.readings[1].isCurrent === true && v.readings[0].isCurrent === false, 'isCurrent marks the newest');
    ok(v.readings.every((r) => r.barPct >= 8 && r.barPct <= 100), 'bar heights are computed server-side and bounded');

    // A worse reading must report how far below the best it is, and how long ago that was.
    a.session.readings.push({ n: 3, quality: 55, label: 'Good', cls: 'success', spread: 1, got: 4, of: 4, rssi: -80, snr: 2, yagi_q: null, omni_q: 60 });
    a.session.readingCount = 3;
    const v2 = a.view();
    ok(v2.current.gapToBest === 15 && v2.current.bestN === 2 && v2.current.bestAgo === 1,
       'a worse reading reports gapToBest / bestN / bestAgo');
    ok(v2.current.isBest === false, 'a worse reading is not flagged best');
    // A radio that heard nothing must be a GAP, never a zero — zero reads as "terrible".
    ok(v2.readings[2].yagi_q === null, 'a silent radio stays null, never 0');
  }

  // Identical readings must not flatten to identical bars.
  {
    const a = mkAlign([]);
    a.start({ num: 1 });
    a.session.readings.push({ n: 1, quality: 60, label: 'Good', cls: 'success', spread: 0, got: 4, of: 4, rssi: -80, snr: 3, yagi_q: null, omni_q: 60 });
    a.session.readings.push({ n: 2, quality: 62, label: 'Good', cls: 'success', spread: 0, got: 4, of: 4, rssi: -79, snr: 3, yagi_q: null, omni_q: 62 });
    const bars = a.view().readings.map((r) => r.barPct);
    ok(bars[0] !== bars[1], 'a tight cluster still renders a visible difference');
  }

  // No replies at all -> a warning, not a fabricated reading.
  {
    const a = mkAlign([]);
    a.start({ num: 1 });
    const burst = { of: 1, got: 0, done: 0, samples: [], pings: new Map(), deadlineTimer: null };
    a.session.burst = burst;
    a._resolve(burst);
    ok(a.view().warning === 'No replies — try again.', 'a silent burst warns');
    ok(a.view().readings.length === 0, 'a silent burst invents NO reading');
  }

  // Persistence of the operator's window, and stop() clearing the session.
  {
    const a = mkAlign([]);
    ok(a.setReplyWindowSec(45) === 45, 'reply window is settable');
    ok(a.view().replyWindowSec === 45, 'and is reported in the model');
    ok(a.setReplyWindowSec(999) === 120, 'and clamped');
    a.start({ num: 1 });
    a.stop();
    ok(a.view().running === false && a.session === null, 'stop clears the session');
    ok(a.view().replyWindowSec === 120, 'the persisted window OUTLIVES the session');
  }

  // A pong for an unknown reply_id (another command crossing) must be ignored.
  {
    const sent = [];
    const a = mkAlign(sent);
    a.start({ num: 1 });
    a.session.burst = { of: 1, got: 0, done: 0, samples: [], pings: new Map(), deadlineTimer: null };
    a.onPong({ type: 'pong', rssi: -50, snr: 8 }, 99999, 'E9:B0:3F:17:27:91');
    ok(a.session.burst.samples.length === 0, 'a pong with an unmatched reply_id is ignored');
    a.stop();
  }

  console.log(`align OK: ${pass} assertions passed`);
})().catch((e) => { console.error('align FAILED:', (e && e.stack) || e); process.exit(1); });
