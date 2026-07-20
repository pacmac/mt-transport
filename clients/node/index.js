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
const push = require('./lib/chunk-push');
const { PushReceiver } = require('./lib/push-receiver');

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
    // Command routing. node-dash reshaped the message model (2026-07-20): the old
    // POST /{gw}/messages path is now Primary/chat only. Command/response goes via
    // POST /nodes/<num>/command, which builds "@<last4> <verb>" and resolves the
    // Private channel by NAME server-side. In this mode _sendText posts the verb+
    // args (the "@target " we prepend is stripped) to o.nodeNum; text replies land
    // in node-dash's command_history, and chunk frames still arrive as binary
    // port-261 private_app events on the same /events WS.
    this.commandRoute = !!o.commandRoute;
    this.nodeNum = o.nodeNum;
    this.store = new PayloadStore({ dir: o.payloadDir || './payloads' });

    this.events = new MeshEvents({ host: this.host });
    this.queue = new CommandQueue({
      send: (text) => this._sendText(text),
      minSpacingMs: o.minSpacingMs ?? 3000,
      timeoutMs: o.timeoutMs ?? 20000,
    });

    this.latest = new Map();   // node_id -> last parsed 260 payload
    this.adverts = new Map();  // node_id -> [{pid, ptype, bytes, chunks}]
    this._fetches = new Map(); // pid -> ChunkClient  (pull)
    this._pushes = new Map();  // pid -> PushReceiver (push)

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
    if (this.commandRoute) {
      if (this.nodeNum == null) throw new Error('commandRoute requires nodeNum');
      // Strip the "@<target> " prefix our command builders add; node-dash re-adds
      // "@<last4-of-num>" and resolves the Private channel by name — so PRIMARY is
      // never reachable through this route (the server owns the channel).
      const command = text.replace(/^@\S+\s+/, '');
      const r = await fetch(`http://${this.host}/nodes/${this.nodeNum}/command`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command }),
      });
      if (!r.ok) throw new Error(`command route failed: ${r.status}`);
      return r.json();
    }
    // Legacy path — now Primary/chat on node-dash; kept for the raw mesh-gw route
    // and tests. Belt and braces: the constructor rejects 0, but a caller mutating
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
    // Two protocols share port 261 with disjoint type blocks (pull 0x01-0x06,
    // push 0x10-0x16), so the first byte decides. A frame from the wrong one is
    // dropped by that protocol's decoder rather than misparsed.
    if (buf.length >= 1 && buf[0] >= 0x10 && buf[0] <= 0x16) {
      const now = Date.now();
      for (const r of this._pushes.values()) r.onFrame(buf, now);
      return;
    }
    for (const c of this._fetches.values()) c.onFrame(buf);
  }


  // ---- push transfer ---------------------------------------------------------

  /**
   * Fetch a payload by PUSH: the device streams at its own rate and we listen
   * passively, reconciling only at the end.
   *
   * WHY THIS EXISTS. fetch() (pull) puts a REQUEST on the critical path of every
   * batch, and a lost request stalls the transfer permanently — measured on air
   * as "stalled at 16/32, no serve, no busy", where the device's own UART showed
   * it was never asked for chunk 16. Push removes that path: 4/4 CRC-verified
   * transfers of the same payload over the same radio.
   *
   * Control travels as TEXT commands because mesh-gw sends no raw portnums —
   * the same reason pull requests are text. Chunks come back binary on 261.
   *
   * Resolves with verified bytes. Never returns a partial: a plausible-but-wrong
   * image is worse than no image.
   */
  async push(t, pid, { onProgress, deadlineMs, payloadDir, signal,
                       idleMs = 35000, pollMs = 1000 } = {}) {
    if (this._pushes.has(pid)) throw new Error(`push ${pid}: already in flight`);

    const rx = new PushReceiver(pid, { idleMs });
    this._pushes.set(pid, rx);
    const t0 = Date.now();
    const deadline = deadlineMs ? t0 + deadlineMs : t0 + 600000;
    const partPath = payloadDir
      ? require('path').join(payloadDir, `pid-${pid}.jpg.part`) : null;
    let lastPrefix = -1;

    // Translate a protocol frame into the text command that carries it.
    const emit = async (buf) => {
      const f = push.decodeFrame(buf);
      if (!f) return;
      if (f.type === push.MSG.START)      return this._sendText(`@${t} push ${f.pid}`);
      if (f.type === push.MSG.PROGRESS_Q) return this._sendText(`@${t} push q ${f.pid}`);
      if (f.type === push.MSG.REPAIR)     return this._sendText(`@${t} push rep ${f.pid} ${f.ids.join(',')}`);
      if (f.type === push.MSG.COMPLETE)   return this._sendText(`@${t} push done ${f.pid} ${f.crc}`);
    };

    // Write-through partial, so a browser can render the contiguous prefix as it
    // grows. NOTE for whoever builds UI on this: the prefix stalls at the FIRST
    // gap and then jumps when repair fills it — at ~17% loss that is typically
    // ~6% then 100%. The numeric bar is the honest progress indicator.
    const writePart = () => {
      if (!partPath) return;
      let k = 0;
      while (rx.chunks.has(k)) k++;
      if (k === 0 || k === lastPrefix) return;
      lastPrefix = k;
      const parts = [];
      for (let i = 0; i < k; i++) parts.push(rx.chunks.get(i));
      try { require('fs').writeFileSync(partPath, Buffer.concat(parts)); } catch (_) {}
    };

    try {
      // ADOPT rather than restart when the device is already serving this pid.
      // upst=3 (sent everything, holding) is the valuable case: one query plus a
      // repair round instead of re-streaming the whole payload. That is a resume.
      let adopt = false;
      try {
        const st = await this.command(t, 'pushStat');
        if (st && (st.upst === 2 || st.upst === 3) && st.up === pid) adopt = true;
      } catch (_) { /* no stat: fall through and START normally */ }

      if (!adopt) await emit(push.encodeStart(pid));

      while (Date.now() < deadline) {
        if (signal && signal.aborted) throw new Error(`push ${pid}: aborted`);
        await new Promise((r) => setTimeout(r, pollMs));

        // ABSOLUTE clock, matching _onChunk's rx.onFrame(buf, Date.now()).
        // These were different time bases: onFrame stamped epoch ms while tick
        // received elapsed ms, so (now - lastRx) was hugely negative, the idle
        // check never tripped, and tick() never issued a single query, repair or
        // complete. The transfer sat at 24/32 until the deadline. Only shows up
        // once the loop lives in the client — a standalone script uses one clock.
        const out = rx.tick(Date.now());
        if (out) await emit(out);

        writePart();
        if (onProgress) onProgress({ received: rx.received, count: rx.count,
                                     elapsedMs: Date.now() - t0 });

        if (rx.failed) throw new Error(`push ${pid}: ${rx.failed}`);
        if (rx.done) {
          const buf = rx.assemble();
          if (!buf) throw new Error(`push ${pid}: complete but CRC failed`);
          if (partPath) { try { require('fs').unlinkSync(partPath); } catch (_) {} }
          return buf;
        }
      }
      throw new Error(
        `push ${pid}: deadline at ${rx.received}/${rx.count}`);
    } finally {
      this._pushes.delete(pid);
    }
  }

  // ---- chunked payload fetch -------------------------------------------------

  /**
   * Fetch a payload by pid. Resolves with verified bytes.
   * Throws on GONE, CRC failure, or timeout — never returns a partial, because
   * a plausible-but-wrong image is worse than no image.
   */
  async fetch(t, pid, { timeoutMs = 300000, batch = 16, onProgress, deadlineMs,
    // Pacing timers. Defaults are the radio-tuned values (a chunk lands ~2.2 s
    // after its pull); the offline L0 harness overrides them down to milliseconds
    // to test the loop LOGIC deterministically with no radio. Changing them here
    // changes ONLY how long the loop waits, never what it does — see offline-fetch.js.
    answerMs = 6000,                         // wait for the device's answer to a pull
    batchMs = batch * 2200 + 4000,           // then for the rest of the batch to land
    pollMs = 150,                            // poll granularity inside those waits
    idleSleepMs = 1000,                      // pause when nothing is outstanding to pull
  } = {}) {
    const c = new chunk.ChunkClient(async (frame) => {
      // The gateway cannot send raw portnums, so pull frames are decoded back
      // into text commands. The device feeds them to the SAME handler a binary
      // pull would hit, so the two paths cannot drift.
      if (frame[0] === chunk.MSG.GETMANIFEST) {
        // Carry the pid. ChunkClient already encoded it at [1:3]; dropping it
        // here asked "describe whatever you hold", so a caller fetching pid 1
        // was handed pid 2's manifest and adopted it, reporting success. We
        // know the pid we want, so we must ask a question the device can refuse.
        // noReply: the manifest is delivered as a BINARY frame on port 261, not a
        // text reply. Waiting for text would stall until timeout — worse now that
        // node-dash routes command replies to command_history, off our text path.
        // The manifest loop re-requests until haveManifest is set from that frame.
        await this.queue.enqueue(
          cmd.chunkInfo(t, frame.readUInt16BE(1)), { priority: 1, noReply: true });
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

      // --- chunks (DEVICE-DRIVEN pacing) ---
      // The device tells us when to pull. We pull, then wait for its answer:
      // chunks (progress), or MSG_BUSY{retry_after} — wait that long, then re-pull
      // the SAME range. We do NOT guess channel state; the device owns the pace
      // (it alone knows its TX queue + how long since it last served, i.e. whether
      // its own rebroadcast storm has settled). A bounded fallback covers a lost
      // MSG_BUSY. requestNext() re-pulls only the missing contiguous run.
      // Reliability over speed. See specs/chunk-flow-control.md.
      const hardMs = deadlineMs != null ? deadlineMs : timeoutMs;
      const ANSWER_MS = answerMs;             // wait for the device's answer to a pull
      const BATCH_MS  = batchMs;              // then for the rest of the batch to land
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

        const before = c.received;
        c.clearBusy();                        // fresh pull: reset the BUSY latch
        if (!c.requestNext(batch)) { await this._sleep(idleSleepMs); continue; }

        // Wait for the device's answer: chunks start arriving, a BUSY latch, or
        // silence — whichever first.
        const answerBy = Date.now() + ANSWER_MS;
        while (Date.now() < answerBy && Date.now() - started < hardMs) {
          if (c.verified || c.received > before || c.busyUntil > Date.now()) break;
          await this._sleep(pollMs);
        }

        if (c.busyUntil > Date.now()) {
          // OBEY the device: it said "retry after N". Wait it out — being throttled
          // is not a stall, so it does not count toward giving up.
          await this._sleep(Math.min(c.busyUntil - Date.now(), 60000));
          idle = 0;
          continue;
        }

        if (c.received > before) {
          idle = 0;
          // Let the rest of this batch arrive before pulling the next range.
          const batchBy = Date.now() + BATCH_MS;
          while (Date.now() < batchBy && Date.now() - started < hardMs) {
            if (c.verified || c.received >= before + batch || c.busyUntil > Date.now()) break;
            await this._sleep(pollMs);
          }
          emit();
          // Persist after any progress so an interruption resumes from here.
          this.store.savePartial(t,
            { pid, crc: c.crc, count: c.count, len: c.len, have: c.have, buf: c.buf });
        } else {
          // Silence — neither chunks nor a BUSY (lost pull or lost answer). The
          // fallback is to loop and re-pull; bounded by the idle count.
          idle++;
          emit();
        }
        if (idle >= 12) throw new Error(
          `pid ${pid}: stalled at ${c.received}/${c.count} after 12 empty windows (no serve, no busy)`);
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

  /** Fetch and write out. Returns the path. */
  async fetchAndSave(t, pid, opts = {}) {
    const buf = await this.fetch(t, pid, opts);
    return this.store.save(buf, { pid, ptype: opts.ptype ?? 2, node: t });
  }
}

module.exports = { Client, chunk, cmd, target, parse260, parseAdverts,
                   PayloadStore, CommandQueue, MeshEvents,
                   PORT_ALARM, PORT_CHUNK };
