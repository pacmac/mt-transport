// Antenna alignment measurement.
//
// PORTED from node-dash's real align-api.js (369 lines, retained at
// reference/alarm-integration/), not reconstructed from prose. It moved here under the
// 2026-07-25 ownership change: its substance is mesh domain — it sends a ping, correlates
// the reply, reads rssi/snr and averages bursts. node-dash keeps PRESENTATION.
//
// THIS FILE OWNS THE ENTIRE VIEW-MODEL. Their browser contract says the backend computes
// everything and the page renders it — quality, labels, best, trend, bar heights. Two
// phones on one session show identical screens. Do not move arithmetic to the client.
//
// WHAT IS BEING MEASURED — two different signals, do not conflate them:
//   * the PONG PAYLOAD rssi/snr is THE DEVICE's reading of our ping, measured AT THE
//     ANTENNA BEING TURNED. This is primary and the most stable.
//   * the per-radio ENVELOPE (rx_rssi/rx_snr, one event per receiving radio) is OUR
//     antennas hearing the device. Secondary; yields yagi_q/omni_q.
'use strict';

// Timing comes from config (`align.*`), NOT from constants here. These values were
// measured by the original implementation — reply latency mean 16.1 s, max 18.6 s, ~75%
// land, pings spaced just OVER the collect window so each is a genuinely separate attempt
// — but a measured value is still a value that may need tuning against a real radio, and
// a ported constant is not exempt from "every timeout is configurable".
// The required config keys. There are deliberately NO defaults here — settings.js is the
// only place a value may live, so a caller that forgets one gets a loud error rather than
// a silent constant nobody knows about.
const REQUIRED = ['collectMs', 'burstSpacingMs', 'replyWindowSec', 'replyWindowMinSec',
                  'replyWindowMaxSec', 'burstMin', 'burstMax', 'burstDefault'];
const round1 = (v) => (typeof v === 'number' && Number.isFinite(v)) ? Math.round(v * 10) / 10 : null;
const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hexSuffix = (num) => (Number(num) >>> 0).toString(16).padStart(8, '0').slice(-4);

// node-dash's EXACT implementation (their src/utils.js:24), copied verbatim rather than
// re-derived. If we invented an equivalent, the align page would disagree with the rest
// of their UI for the same node — which is worse than being slightly wrong consistently.
// SNR weighted 60%, RSSI 40%: SNR is the better LoRa link indicator.
function signalQuality(rssi, snr) {
  const hasRssi = rssi != null, hasSnr = snr != null;
  if (!hasRssi && !hasSnr) return 0;
  const snrScore = hasSnr ? Math.max(0, Math.min(1, (snr + 20) / 30)) : null;
  const rssiScore = hasRssi ? Math.max(0, Math.min(1, (rssi + 120) / 70)) : null;
  if (snrScore != null && rssiScore != null) return Math.round((snrScore * 0.6 + rssiScore * 0.4) * 100);
  return Math.round((snrScore != null ? snrScore : rssiScore) * 100);
}

// Bands + semantic colour, confirmed by node-dash (app-nodes.js:234, node-status.js:236).
function qualityBand(q) {
  if (q == null) return { label: '—', cls: 'base-content/30' };
  if (q >= 76) return { label: 'Excellent', cls: 'success' };
  if (q >= 51) return { label: 'Good', cls: 'success' };
  if (q >= 26) return { label: 'Fair', cls: 'warning' };
  return { label: 'Poor', cls: 'error' };
}

class Align {
  // deps: { send(text,{channel}) -> {id}, radios: {label -> nodeId}, addrOf(addr) -> nodeId,
  //         channel, cache, log, onChange(view) }
  constructor(deps = {}) {
    // cfg is the resolved `align` block; DEFAULTS only fills gaps so a bare/stubbed
    // instance still works (tests construct one directly).
    this.cfg = deps.cfg || {};
    this.send = deps.send;
    this.radios = deps.radios || {};
    this.addrOf = deps.addrOf || (() => null);
    this.channel = deps.channel;
    this.cache = deps.cache || null;
    this.log = deps.log || { info() {}, warn() {}, debug() {} };
    this.onChange = deps.onChange || (() => {});
    this.session = null;
  }

  // Operator-set and PERSISTED: a weak node can answer at 18–43 s, longer than a fixed
  // 20 s window that would discard those replies.
  // Validated on USE, not construction: Mesh builds an Align before config is resolved so
  // that _onEvent can route pongs on any instance. A missing value must still be a loud
  // error rather than a silent NaN, so it is checked the moment the value is needed.
  _requireCfg() {
    for (const k of REQUIRED) {
      if (!Number.isFinite(this.cfg[k])) {
        throw new Error(`align: config align.${k} is required (got ${this.cfg[k]}) — declare it in settings.js`);
      }
    }
    return this.cfg;
  }

  _clampWindow(s) {
    const c = this._requireCfg();
    return Math.max(c.replyWindowMinSec,
      Math.min(c.replyWindowMaxSec, Math.round(Number(s) || c.replyWindowSec)));
  }
  _clampN(n) {
    const c = this._requireCfg();
    return Math.max(c.burstMin, Math.min(c.burstMax, Math.round(Number(n) || c.burstDefault)));
  }

  replyWindowSec() {
    const v = this.cache ? this.cache.value('align', 'reply_window_sec') : null;
    return this._clampWindow(v != null ? v : this.cfg.replyWindowSec);
  }
  setReplyWindowSec(sec) {
    const v = this._clampWindow(sec);
    if (this.cache) this.cache.put('align', 'reply_window_sec', v);
    this._push();
    return v;
  }

  // ---- the view-model — the ONLY thing published -----------------------------
  // Built fresh on every change; ALL derived state lives here so the browser prints.
  view() {
    const s = this.session;
    if (!s) {
      return { kind: 'align', running: false, target: null, tx: null, channel: null,
               nBurst: this.cfg.burstDefault, replyWindowSec: this.replyWindowSec(),
               burst: null, warning: null, best: null, current: null, readings: [] };
    }
    const rs = s.readings;
    const qualities = rs.map((r) => r.quality);
    let lo = qualities.length ? Math.min(...qualities) : 0;
    let hi = qualities.length ? Math.max(...qualities) : 100;
    // Don't flatten: a tight cluster of readings would otherwise render as identical bars
    // and hide the very differences the operator is hunting for.
    if (hi - lo < 20) { const m = (hi + lo) / 2; lo = m - 10; hi = m + 10; }
    const barPct = (q) => Math.max(8, Math.min(100, Math.round(((q - lo) / (hi - lo)) * 100)));

    const bestN = rs.length ? rs.reduce((a, b) => (b.quality > a.quality ? b : a)).n : null;

    const readings = rs.map((r, i) => {
      const prev = i > 0 ? rs[i - 1] : null;
      const delta = prev ? r.quality - prev.quality : null;
      return {
        ...r,
        barPct: barPct(r.quality),
        isBest: r.n === bestN,
        isCurrent: i === rs.length - 1,
        trendDir: delta === null ? null : delta > 1 ? 'up' : delta < -1 ? 'down' : 'same',
        trendDelta: delta === null ? null : Math.round(delta),
      };
    });

    // The headline: the newest reading and its relationship to the best, both computed
    // here so the page only prints them.
    let current = null;
    if (readings.length) {
      const c = readings[readings.length - 1];
      const bestQ = rs.reduce((a, b) => (b.quality > a.quality ? b : a)).quality;
      // A reading that TIES the best is AT the best — say "best yet", not "−0 below".
      const atBest = c.quality >= bestQ;
      current = { ...c, isBest: atBest, gapToBest: Math.max(0, bestQ - c.quality), bestN, bestAgo: c.n - bestN };
    }

    return {
      kind: 'align', running: true,
      target: s.num, tx: s.txLabel, channel: s.channel,
      nBurst: s.nBurst, replyWindowSec: this.replyWindowSec(),
      burst: s.burst ? { active: true, got: s.burst.got, of: s.burst.of } : null,
      warning: s.warning,
      best: bestN === null ? null : { n: bestN },
      current, readings,
    };
  }

  _push() { try { this.onChange(this.view()); } catch (e) { this.log.debug('align push failed: %s', e && e.message); } }

  // ---- session ---------------------------------------------------------------
  start({ num, txLabel, channel }) {
    if (this.session) this.stop();
    this.session = {
      num, suffix: hexSuffix(num), txLabel: txLabel || 'OMNI',
      channel: channel != null ? channel : this.channel,
      nBurst: this.cfg.burstDefault, readingCount: 0, readings: [], burst: null, warning: null,
    };
    this.log.info('align: session on !%s (@%s) via %s ch%d',
      (Number(num) >>> 0).toString(16), this.session.suffix, this.session.txLabel, this.session.channel);
    this._push();
    return { ok: true };
  }

  stop() {
    if (!this.session) return { ok: true };
    this._clearTimers(this.session.burst);
    this.session = null;
    this.log.info('align: stopped');
    this._push();      // running:false to everyone
    return { ok: true };
  }

  _clearTimers(burst) {
    if (!burst) return;
    if (burst.deadlineTimer) clearTimeout(burst.deadlineTimer);
    for (const p of burst.pings.values()) if (p.collectTimer) clearTimeout(p.collectTimer);
  }

  // ---- one commanded burst ---------------------------------------------------
  async ping(n) {
    const s = this.session;
    if (!s) return { ok: false, error: 'no session' };
    if (s.burst) return { ok: false, error: 'burst in progress' };
    const of = this._clampN(n);
    s.nBurst = of;
    const burst = { of, got: 0, done: 0, samples: [], pings: new Map(), deadlineTimer: null };
    s.burst = burst;
    s.warning = null;

    // ONE deadline covering the reply window for the LAST ping. At it, resolve with
    // whatever landed — never wait out unanswered pings, or a burst where some replies
    // never come sits "gathering" while its average is already good enough, and every
    // press is rejected as busy for the duration.
    burst.deadlineTimer = setTimeout(() => this._resolve(burst),
      (of - 1) * this.cfg.burstSpacingMs + this.replyWindowSec() * 1000);
    this._push();                       // button -> gathering 0/of

    for (let i = 0; i < of; i++) {
      if (this.session !== s || s.burst !== burst) return { ok: true, of };   // cancelled
      await this._sendPing(burst);
      if (i < of - 1) await sleep(this.cfg.burstSpacingMs);
    }
    return { ok: true, of };
  }

  async _sendPing(burst) {
    const s = this.session;
    if (!s || s.burst !== burst) return;
    let sent;
    try {
      sent = await this.send(`@${s.suffix} ping`, { channel: s.channel });
    } catch (e) {
      burst.done += 1;                  // a ping that never left counts as resolved
      this.log.debug('align: ping send failed: %s', e && e.message);
      this._maybeResolve(burst);
      return;
    }
    if (!sent || sent.id == null) {
      burst.done += 1;
      this.log.warn('align: ping %d/%d got no packet id back — not counted as an attempt', burst.pings.size + 1, burst.of);
      this._maybeResolve(burst);
      return;
    }
    // Logged at info: a burst that silently sends fewer pings than asked would quietly
    // weaken the average, and the air trace alone cannot distinguish "not sent" from
    // "sent but not heard".
    this.log.info('align: ping %d/%d away (id %s)', burst.pings.size + 1, burst.of, sent.id);
    // No per-ping timeout: the burst deadline resolves everything at once. An unanswered
    // ping simply never lands a sample.
    burst.pings.set(sent.id, { replyId: sent.id, payload: null, byRadio: {}, collectTimer: null, resolved: false });
  }

  // A pong arrives ONCE PER RECEIVING RADIO. Gather the copies over a short window, then
  // finalise into one sample. `addr` says which of our antennas reported it.
  onPong(payload, replyId, addr) {
    const s = this.session;
    if (!s || !s.burst || replyId == null) return;
    const ping = s.burst.pings.get(replyId);
    if (!ping || ping.resolved) return;
    if (!payload || payload.type !== 'pong') return;

    ping.payload = payload;
    const label = this._labelFor(addr);
    if (label) ping.byRadio[label] = { rssi: payload.rxRssi != null ? payload.rxRssi : null, snr: payload.rxSnr != null ? payload.rxSnr : null };
    if (!ping.collectTimer) {
      ping.collectTimer = setTimeout(() => this._finalizePing(s.burst, ping), this.cfg.collectMs);
    }
  }

  // Envelope signal for one receiving radio (from the 'heard' path, which carries
  // rx_rssi/rx_snr per reporting device).
  onEnvelope(replyId, addr, rssi, snr) {
    const s = this.session;
    if (!s || !s.burst || replyId == null) return;
    const ping = s.burst.pings.get(replyId);
    if (!ping || ping.resolved) return;
    const label = this._labelFor(addr);
    if (label) ping.byRadio[label] = { rssi: rssi != null ? rssi : null, snr: snr != null ? snr : null };
  }

  _labelFor(addr) {
    if (!addr) return null;
    const nodeId = this.addrOf(addr) || addr;
    for (const [label, id] of Object.entries(this.radios)) if (id === nodeId || id === addr) return label;
    return null;
  }

  _finalizePing(burst, ping) {
    const s = this.session;
    if (!s || s.burst !== burst || ping.resolved || !ping.payload) return;
    ping.resolved = true;
    if (ping.collectTimer) clearTimeout(ping.collectTimer);
    burst.done += 1;
    const p = ping.payload;
    burst.samples.push({
      quality: signalQuality(p.rssi, p.snr),     // the DEVICE's own reading — primary
      rssi: p.rssi, snr: p.snr,
      yagi_q: ping.byRadio.yagi ? signalQuality(ping.byRadio.yagi.rssi, ping.byRadio.yagi.snr) : null,
      omni_q: ping.byRadio.omni ? signalQuality(ping.byRadio.omni.rssi, ping.byRadio.omni.snr) : null,
    });
    burst.got = burst.samples.length;
    s.warning = null;                   // something landed — the link is alive
    this._push();                       // progress (got/of)
    this._maybeResolve(burst);
  }

  // Resolve early ONLY when every ping has resolved (all landed, or all sends failed).
  // The mixed case is left to the deadline so stragglers do not hold up the average.
  _maybeResolve(burst) { if (burst.done >= burst.of) this._resolve(burst); }

  // Average the landed samples into ONE reading.
  _resolve(burst) {
    const s = this.session;
    if (!s || s.burst !== burst) return;
    s.burst = null;
    this._clearTimers(burst);
    const samples = burst.samples;

    if (!samples.length) {
      s.warning = 'No replies — try again.';
      this._push();
      return;
    }
    const qs = samples.map((x) => x.quality);
    const yq = samples.map((x) => x.yagi_q).filter((v) => v != null);
    const oq = samples.map((x) => x.omni_q).filter((v) => v != null);
    const q = Math.round(mean(qs));
    const band = qualityBand(q);

    s.readings.push({
      n: ++s.readingCount,
      quality: q, label: band.label, cls: band.cls,
      spread: Math.round(Math.max(...qs) - Math.min(...qs)),
      got: samples.length, of: burst.of,
      rssi: Math.round(mean(samples.map((x) => x.rssi))),
      snr: round1(mean(samples.map((x) => x.snr))),
      // A radio that heard nothing is a GAP, never a zero — zero would read as
      // "terrible signal" when the truth is "no data from that antenna".
      yagi_q: yq.length ? Math.round(mean(yq)) : null,
      omni_q: oq.length ? Math.round(mean(oq)) : null,
    });
    this._push();
  }
}

module.exports = { Align, signalQuality, qualityBand, REQUIRED };
