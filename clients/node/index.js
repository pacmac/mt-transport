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
    this.channel = o.channel ?? 2;
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
  async fetch(t, pid, { timeoutMs = 300000, batch = 16 } = {}) {
    const c = new chunk.ChunkClient(async (frame) => {
      // The gateway cannot send raw portnums, so pull frames are decoded back
      // into text commands. The device feeds them to the SAME handler a binary
      // pull would hit, so the two paths cannot drift.
      if (frame[0] === chunk.MSG.GETMANIFEST) {
        await this.queue.enqueue(cmd.chunkInfo(t), { priority: -1, retries: 1 });
      } else if (frame[0] === chunk.MSG.PULL) {
        await this.queue.enqueue(
          cmd.chunkPull(t, frame.readUInt16BE(3), frame[5]),
          { priority: -1, retries: 1, dedupKey: `pull:${frame.readUInt16BE(3)}` });
      }
    });
    this._fetches.set(pid, c);
    try {
      const started = Date.now();
      await c.requestManifest(pid);
      while (Date.now() - started < timeoutMs) {
        if (c.gone) throw new Error(`pid ${pid}: GONE (evicted)`);
        if (c.verified) return c.buf;
        if (c.complete && !c.verified) throw new Error(`pid ${pid}: CRC failed after reassembly`);
        if (!c.haveManifest) { await c.requestManifest(pid); continue; }
        if (!c.requestNext(batch)) await new Promise((r) => setTimeout(r, 1000));
      }
      throw new Error(`pid ${pid}: timeout at ${Math.round(c.progress * 100)}%`);
    } finally {
      this._fetches.delete(pid);
    }
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
