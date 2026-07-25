// SseHub — the one live event stream the service publishes.
//
// WHY SSE AND NOT WS: our stream is one-way (commands go up by POST), and SSE puts
// RECONNECT AND RESUME IN THE PROTOCOL. A dashboard that drops reconnects itself and
// replays from Last-Event-ID. We hand-rolled that for WS in @pac/mesh's lib/gw.js;
// here it is free — but only if the server holds up its end, which is this file:
//
//   * every event carries a MONOTONIC id;
//   * a replay buffer serves Last-Event-ID on reconnect;
//   * if the buffer has rolled PAST the client's id we say so explicitly with a
//     `gap` event rather than resuming silently.
//
// That last point matters more than it looks. A silent gap is exactly the failure
// this project keeps fighting: a hole in a record that is indistinguishable from
// "nothing happened". A consumer must be able to tell "you missed some" from
// "there was nothing to miss".
'use strict';

const KEEPALIVE_MS = 25000;   // comment frame; keeps idle proxies from closing us
const SLOW_BYTES   = 1 << 20; // 1 MB queued to one client = it is not keeping up

class SseHub {
  // opts: { bufferSize, log, keepaliveMs }
  constructor(opts = {}) {
    this.bufferSize = opts.bufferSize != null ? opts.bufferSize : 500;
    this.log = opts.log || { info() {}, warn() {}, debug() {} };
    this.keepaliveMs = opts.keepaliveMs != null ? opts.keepaliveMs : KEEPALIVE_MS;
    this._buf = [];        // ring of { id, event, json }
    this._nextId = 1;      // monotonic, never reused within a process lifetime
    this._clients = new Set();
    this._timer = null;
    this._closed = false;
  }

  get clientCount() { return this._clients.size; }
  get lastId() { return this._nextId - 1; }
  // Oldest id still replayable; 0 when the buffer is empty.
  get oldestId() { return this._buf.length ? this._buf[0].id : 0; }

  // Publish one event to every attached client and to the replay buffer.
  // `event` is the WIRE name (namespaced, e.g. 'mesh.node') — a published contract,
  // deliberately NOT an internal EventEmitter name.
  publish(event, data) {
    if (this._closed) return null;
    const rec = { id: this._nextId++, event: String(event), json: safeJson(data) };
    this._buf.push(rec);
    if (this._buf.length > this.bufferSize) this._buf.shift();
    const frame = frameOf(rec);
    for (const c of this._clients) this._write(c, frame);
    return rec.id;
  }

  // Attach an HTTP response as an SSE client. Returns a detach function.
  attach(req, res) {
    if (this._closed) { res.writeHead(503).end(); return () => {}; }
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      // Without this, a proxy that buffers would defeat the whole point of a stream.
      'X-Accel-Buffering': 'no',
    });

    const client = { res, alive: true };
    this._clients.add(client);

    // Resume, or say plainly that we cannot.
    const last = parseId(req.headers && req.headers['last-event-id']);
    if (last != null) {
      const missed = this._replayFrom(last);
      if (missed === null) {
        // The buffer has rolled past their position: they HAVE missed events and we
        // cannot say which. Tell them, with the range, so they can re-sync from REST.
        this._write(client, frameOf({
          id: this.lastId || 0,
          event: 'gap',
          json: safeJson({ from: last, oldest: this.oldestId, latest: this.lastId }),
        }));
      } else {
        for (const rec of missed) this._write(client, frameOf(rec));
      }
    }

    this._ensureKeepalive();
    const detach = () => {
      if (!client.alive) return;
      client.alive = false;
      this._clients.delete(client);
      this._maybeStopKeepalive();
    };
    res.on('close', detach);
    res.on('error', detach);
    return detach;
  }

  close() {
    this._closed = true;
    for (const c of this._clients) { try { c.res.end(); } catch { /* already gone */ } }
    this._clients.clear();
    this._maybeStopKeepalive();
  }

  // ---- internals ------------------------------------------------------------

  // Events strictly newer than `lastId`, or null when we cannot serve that far back.
  _replayFrom(lastId) {
    if (lastId >= this.lastId) return [];              // already current
    if (!this._buf.length) return null;                // nothing buffered at all
    if (lastId < this.oldestId - 1) return null;       // rolled past — a real gap
    return this._buf.filter((r) => r.id > lastId);
  }

  _write(client, frame) {
    if (!client.alive) return;
    try {
      client.res.write(frame);
      // A client that cannot drain must never back up the service that is also
      // delivering commands to the units. Drop it; SSE will reconnect and resume.
      if (client.res.writableLength > SLOW_BYTES) {
        this.log.warn('sse: dropping slow client (%d bytes queued)', client.res.writableLength);
        client.alive = false;
        this._clients.delete(client);
        try { client.res.destroy(); } catch { /* already gone */ }
      }
    } catch (e) {
      client.alive = false;
      this._clients.delete(client);
      this.log.debug('sse: write failed: %s', e && e.message);
    }
  }

  _ensureKeepalive() {
    if (this._timer || !this.keepaliveMs) return;
    this._timer = setInterval(() => {
      for (const c of this._clients) this._write(c, ': keepalive\n\n');
    }, this.keepaliveMs);
    if (this._timer.unref) this._timer.unref();   // never hold the process open
  }

  _maybeStopKeepalive() {
    if (this._timer && this._clients.size === 0) {
      clearInterval(this._timer);
      this._timer = null;
    }
  }
}

function frameOf(rec) {
  // data must be one line: JSON.stringify never emits a raw newline, so this holds.
  return `id: ${rec.id}\nevent: ${rec.event}\ndata: ${rec.json}\n\n`;
}

function safeJson(data) {
  try { return JSON.stringify(data === undefined ? null : data); }
  catch (e) { return JSON.stringify({ error: 'unserialisable', message: e && e.message }); }
}

function parseId(v) {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : null;
}

module.exports = { SseHub };
