'use strict';
// mt-transport — Node client for the PAC private Meshtastic protocol.
//
// SKELETON. The chunk path is implemented and tested against the real C++
// encoder; the rest is wired but only lightly exercised, and anything not built
// throws rather than returning a plausible empty result. See SPEC.md.
//
// Scope: ONLY what stock Meshtastic does not carry. Text, position, telemetry
// and nodeinfo remain node-dash's business.

const { MeshEvents } = require('./lib/events');
const { CommandQueue } = require('./lib/queue');
const { PayloadStore } = require('./lib/store');
const { parse260, parseAdverts } = require('./lib/payloads');
const { cmd, target, UNSAFE_TO_RETRY } = require('./lib/commands');
const chunk = require('./lib/chunk');

const PORT_ALARM = 260; // JSON: debug, config, adverts
const PORT_CHUNK = 261; // binary: chunked payloads

class Client {
  /**
   * @param {object} o
   *   host       "192.168.10.205:8000"
   *   gatewayId  "!2687afb1"  the BLE-connected node used to transmit
   *   channel    2            channel index the devices listen on
   */
  constructor(o) {
    this.host = o.host;
    this.gatewayId = o.gatewayId;
    // HARD RULE, no exceptions: never transmit on PRIMARY (channel 0). These
    // devices listen on a private channel and PRIMARY is the public mesh —
    // sending there leaks alarm traffic and commands to every node in range.
    // channel defaults to 0 everywhere in the Meshtastic API, so an unset value
    // is the dangerous case and must be rejected rather than defaulted.
    if (o.channel === 0) {
      throw new Error('channel 0 (PRIMARY) is forbidden — use the private channel index');
    }
    if (o.channel === undefined || o.channel === null) {
      throw new Error('channel must be given explicitly — it must never default to 0/PRIMARY');
    }
    this.channel = o.channel;
    this.store = new PayloadStore({ dir: o.payloadDir || './payloads' });

    this.events = new MeshEvents({ host: this.host });
    this.queue = new CommandQueue({
      send: (text) => this._sendText(text),
      minSpacingMs: o.minSpacingMs ?? 3000,
      timeoutMs: o.timeoutMs ?? 20000,
    });

    this.latest = new Map();   // node_id -> last parsed 260 payload
    this.adverts = new Map();  // node_id -> [{pid, ptype, bytes, chunks}]
    this._fetches = new Map(); // pid -> ChunkClient

    this.events.on(`port:${PORT_ALARM}`, (buf, e) => this._on260(buf, e));
    this.events.on(`port:${PORT_CHUNK}`, (buf) => this._onChunk(buf));
    this.events.on('text', (e) => this._onText(e));
  }

  async connect() {
    const p = new Promise((res) => this.events.once('open', res));
    this.events.start();
    return p;
  }
  close() { this.events.stop(); }

  // ---- outbound --------------------------------------------------------------

  async _sendText(text) {
    // Belt and braces: the constructor rejects 0, but a caller mutating
    // .channel afterwards must not be able to reach PRIMARY either.
    if (!this.channel) throw new Error('refusing to send on channel 0 (PRIMARY)');
    const r = await fetch(`http://${this.host}/${this.gatewayId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, channel: this.channel }),
    });
    if (!r.ok) throw new Error(`gateway send failed: ${r.status}`);
    return r.json();
  }

  /** Issue a command and wait for its JSON reply. */
  command(t, verb, ...args) {
    const build = cmd[verb];
    if (!build) throw new Error(`unknown verb: ${verb}`);
    const text = build(t, ...args);
    return this.queue.enqueue(text, {
      // Retry ONLY where repeating is harmless. A retried reboot reboots twice.
      retries: UNSAFE_TO_RETRY.has(verb) ? 0 : 1,
      match: (reply) => typeof reply === 'object' && reply !== null,
    });
  }

  // ---- inbound ---------------------------------------------------------------

  _on260(buf, e) {
    const obj = parse260(buf);
    if (!obj) return;
    const node = e.node_id || String(e.from_num);
    this.latest.set(node, obj);
    const av = parseAdverts(obj);
    if (av.length) this.adverts.set(node, av);
    this.events.emit('payload', node, obj, e);
  }

  _onText(e) {
    const t = e?.data?.text;
    if (typeof t !== 'string' || !t.startsWith('{')) return;
    let obj; try { obj = JSON.parse(t); } catch { return; }
    // Replies carry no request id, so correlation is positional — one command
    // in flight at a time is what makes this sound. See lib/queue.js.
    this.queue.onReply(obj);
    this.events.emit('reply', obj, e);
  }

  _onChunk(buf) {
    for (const c of this._fetches.values()) c.onFrame(buf);
  }

  // ---- chunked payload fetch -------------------------------------------------

  /**
   * Fetch a payload by pid. Resolves with verified bytes.
   * Throws on GONE, CRC failure, or timeout — never returns a partial, because
   * a plausible-but-wrong image is worse than no image.
   */
  async fetch(t, pid, { timeoutMs = 300000, batch = 16, onProgress, deadlineMs } = {}) {
    const c = new chunk.ChunkClient(async (frame) => {
      // The gateway cannot send raw portnums, so pull frames are decoded back
      // into text commands. The device feeds them to the SAME handler a binary
      // pull would hit, so the two paths cannot drift.
      if (frame[0] === chunk.MSG.GETMANIFEST) {
        // Carry the pid. ChunkClient already encoded it at [1:3]; dropping it
        // here asked "describe whatever you hold", so a caller fetching pid 1
        // was handed pid 2's manifest and adopted it, reporting success. We
        // know the pid we want, so we must ask a question the device can refuse.
        await this.queue.enqueue(
          cmd.chunkInfo(t, frame.readUInt16BE(1)), { priority: 1, retries: 1 });
      } else if (frame[0] === chunk.MSG.PULL) {
        // noReply: the device answers with chunks on port 261, not text.
        // dedupKey MUST include the pid: keyed on offset alone, a pull for
        // chunk 0 of pid 2 dedups against a pending pull for chunk 0 of pid 1
        // and is silently dropped. Latent while only one payload exists —
        // which is exactly the condition this change removes.
        await this.queue.enqueue(
          cmd.chunkPull(t, frame.readUInt16BE(1), frame.readUInt16BE(3), frame[5]),
          { priority: -1, noReply: true,
            dedupKey: `pull:${frame.readUInt16BE(1)}:${frame.readUInt16BE(3)}` });
      }
    });
    this._fetches.set(pid, c);
    try {
      const started = Date.now();

      // --- manifest ---
      while (!c.haveManifest) {
        if (Date.now() - started > timeoutMs) throw new Error(`pid ${pid}: no manifest`);
        await c.requestManifest(pid);
        await this._settle(() => c.haveManifest, 20000);
      }

      // --- resume: seed from a persisted partial for this EXACT payload ---
      // Identity is pid+crc+count+len. A mismatch (a 16-bit pid collision behind
      // a different image) is rejected and the stale partial cleared, so two
      // images can never blend. On a match the pull loop below requests only the
      // gaps. This is what makes an interrupted transfer continue rather than
      // restart — the point of the whole cycle. See specs/chunk-resume.md.
      const prior = this.store.loadPartial(t, pid);
      if (prior && prior.crc === c.crc && prior.count === c.count && prior.len === c.len) {
        c.seed({ buf: prior.buf, have: prior.have });
      } else if (prior) {
        this.store.clearPartial(t, pid); // same pid, different image — discard
      }

      // --- chunks ---
      // PACING: pull only when the CHANNEL has gone quiet. The device's chunks are
      // broadcasts the Omni rebroadcasts several times each over ~10 s, so after a
      // batch the air stays busy long after `received` stops climbing. Firing the
      // next pull into that storm collides and the pull/serve is lost — the stall
      // seen at a RANDOM index every run (feed-verified 2026-07-20: the client
      // re-pulled the right range 8x, the device simply never served it through
      // the congestion). The old pacing keyed off `received` going quiet, but
      // duplicates don't change `received`, so a saturated channel looked idle.
      // Now we wait until no frame AT ALL (duplicates included — see
      // ChunkClient.lastFrameAt) has arrived for QUIET_MS, THEN pull, so it lands
      // in a gap between rebroadcast bursts. Reliability over speed: slower, but it
      // completes. requestNext() re-pulls only the missing contiguous run.
      const hardMs = deadlineMs != null ? deadlineMs : timeoutMs;
      const QUIET_MS = 3000;              // no frame for this long => a burst ended
      const QUIET_MAX_MS = 12000;         // but never wait forever for quiet
      const PULL_WAIT_MS = batch * 2200 + 8000; // upper bound on one batch landing
      const emit = () => { if (onProgress) { try { onProgress(
        { received: c.received, count: c.count, batch, elapsedMs: Date.now() - started });
      } catch { /* a throwing progress cb must never break the transfer */ } } };

      let idle = 0;
      while (Date.now() - started < hardMs) {
        // GONE: the device evicted this pid, so the bytes are unrecoverable and a
        // saved partial is useless — drop it rather than resume into a dead payload.
        if (c.gone) { this.store.clearPartial(t, pid); throw new Error(`pid ${pid}: GONE (evicted)`); }
        if (c.verified) { this.store.clearPartial(t, pid); emit(); return c.buf; }
        if (c.complete && !c.verified) throw new Error(`pid ${pid}: CRC failed after reassembly`);

        // 1) LISTEN before pulling — wait for the channel to fall silent so the
        //    pull lands in a gap, not on top of the rebroadcast storm. Bounded so
        //    a permanently-busy channel can't deadlock us.
        const quietBy = Date.now() + QUIET_MAX_MS;
        while (c.sinceLastFrame < QUIET_MS && Date.now() < quietBy
               && Date.now() - started < hardMs) {
          await this._sleep(200);
        }

        // 2) pull the next missing contiguous run
        const before = c.received;
        if (!c.requestNext(batch)) { await this._sleep(1000); continue; }

        // 3) wait for the batch to land: the full batch, OR the channel going
        //    quiet again after the device has had time to respond (which covers a
        //    partial or a wholly-lost delivery — either way we re-pull the gap).
        const pullAt = Date.now();
        const pullBy = pullAt + PULL_WAIT_MS;
        while (Date.now() < pullBy && Date.now() - started < hardMs) {
          if (c.verified || c.received >= before + batch) break;
          if (c.sinceLastFrame >= QUIET_MS && Date.now() - pullAt >= 3000) break;
          await this._sleep(200);
        }

        emit();
        if (c.received !== before) {
          idle = 0;
          // Persist after any progress so an interruption resumes from here.
          this.store.savePartial(t,
            { pid, crc: c.crc, count: c.count, len: c.len, have: c.have, buf: c.buf });
        } else {
          idle++; // only wholly-empty windows count toward giving up
        }
        if (idle >= 12) throw new Error(
          `pid ${pid}: stalled at ${c.received}/${c.count} after 12 empty windows`);
      }
      throw new Error(`pid ${pid}: timeout at ${Math.round(c.progress * 100)}% (${c.received}/${c.count})`);
    } finally {
      this._fetches.delete(pid);
    }
  }

  _sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

  /** Poll until cond() or ms elapses. Cheap; the radio is the slow part. */
  async _settle(cond, ms) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (cond()) return true;
      await this._sleep(400);
    }
    return cond();
  }

  /**
   * Like _settle, but also returns early once progress() has stopped changing
   * for quietMs — i.e. the batch's deliverable chunks have arrived and the rest
   * were lost. Ending the window then lets the caller re-pull the gap promptly
   * instead of idling out the whole budget. Returns true only if cond() held.
   */
  async _settleQuiet(cond, progress, ms, quietMs) {
    const end = Date.now() + ms;
    let last = progress();
    let lastChange = Date.now();
    while (Date.now() < end) {
      if (cond()) return true;
      const p = progress();
      if (p !== last) { last = p; lastChange = Date.now(); }
      else if (Date.now() - lastChange >= quietMs) return false; // gone quiet
      await this._sleep(300);
    }
    return cond();
  }

  /** Fetch and write out. Returns the path. */
  async fetchAndSave(t, pid, opts = {}) {
    const buf = await this.fetch(t, pid, opts);
    return this.store.save(buf, { pid, ptype: opts.ptype ?? 2, node: t });
  }
}

module.exports = { Client, chunk, cmd, target, parse260, parseAdverts,
                   PayloadStore, CommandQueue, MeshEvents,
                   PORT_ALARM, PORT_CHUNK };
