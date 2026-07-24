// @pac/mesh — the mesh domain module. THE single owner of mesh mechanics, our
// private protocol and timing. Consumers (node-dash, CLI, daemon, any dashboard)
// speak DOMAIN — nodes, detections, images, config, alerts — and know nothing of
// ports, frames, chunks, channels, airtime or queues.
//
// Phase 3 (mesh-cli-live): the live vertical is wired — connect + command/ping/
// status + nodes/node + basic model. Images/config/notify bodies land in their
// own phases and still throw NotImplemented.
'use strict';
const { EventEmitter } = require('events');
const errors = require('./lib/errors');
const { ni, MeshError } = errors;
const settings = require('./lib/settings');
const protocol = require('./lib/protocol');
const { resolveTarget } = require('./lib/resolve');
const { Gateway } = require('./lib/gw');
const { Timing } = require('./lib/timing');
const { Model } = require('./lib/model');
const { Images } = require('./lib/images');
const { Config } = require('./lib/config');
const { Notifier } = require('./lib/notify');
const { Daemon } = require('./lib/daemon');
const log = require('./lib/log').log.child('mesh');

const VERSION = require('./package.json').version;
const PORT_ALARM = 260; // JSON: debug, config, adverts
const PORT_CHUNK = 261; // binary: chunk/push frames

// Verbs that answer by ANOTHER route (a 260/binary frame), never a text reply — resolve
// on send instead of waiting, else they always ETIMEOUT. Keyed by verb OR "verb subverb".
const NO_REPLY = new Set(['debug', 'sch', 'cam grab', 'chunk pull', 'push pull']);

// Non-idempotent verbs: repeating them causes real side effects (double reboot, extra
// watchdog reset), so the `cmd` passthrough must NOT auto-retry these. Everything else is
// safe to resend. Reachable only via the raw escape hatch.
const DANGER = new Set(['reboot', 'wedge']);

class Mesh extends EventEmitter {
  // opts merge into config (defaults < config.yaml < env < opts). channel!=0.
  constructor(opts = {}) {
    super();
    this.opts = opts;
    this.cfg = null;          // resolved config (settings.load) — set in connect()
    this.gw = null;
    this.timing = null;
    this.model = null;
    this.images = null;
    this.config = null;       // config DOMAIN (device settings), not app config
    this.notifier = null;
    this.gwId = null;
    this.channel = null;
    this._roster = [];        // cached gateway node list ({id,num,name}) for target->num
  }

  // ---- lifecycle ----
  async connect() {
    this.cfg = settings.load(this.opts);
    require('./lib/log').log.setLevel(this.cfg.logLevel);
    this.gwId = this.cfg.gw.gatewayId;
    if (!this.gwId) throw new MeshError('gw.gatewayId not configured — set it in config.yaml', 'ECONFIG');
    this.channel = this.cfg.channel;
    this.gw = new Gateway(this.cfg);
    this.timing = new Timing(this.cfg.timing);
    this.model = new Model();
    this.images = new Images({
      gw: this.gw, gwId: this.gwId, channel: this.channel, protocol,
      timing: this.timing, model: this.model, cfg: this.cfg,
      log: require('./lib/log').log.child('images'),
      command: (node, verb, args) => this.command(node, verb, args, this._idem()),   // push stat etc. are idempotent
      send: (node, text) => this._sendRaw(node, text),   // fire-and-forget control via the DM path
    });
    this.images.emit = (type, payload) => this.emit(type, payload);
    this.config = new Config({
      command: (node, verb, args) => this.command(node, verb, args, this._idem()),   // config/chunk cfg/name are idempotent
      send: (node, text) => this._sendRaw(node, text),      // `sch` pages: fire-and-forget over the DM path
      log: require('./lib/log').log.child('config'),
      schemaTimeoutMs: this.cfg.timing && this.cfg.timing.chunkAnswerMs,
    });
    this.gw.onEvent((ev) => this._onEvent(ev));
    log.debug('connecting to gw %s (gwId %s, channel %d)', this.cfg.gw.host, this.gwId, this.channel);
    await this.gw.connect();
    await this._refreshRoster();   // seed target->num; refreshed lazily on a resolver miss
    return this;
  }

  async close() { if (this.gw) await this.gw.close(); }

  // Route a normalized gw event into replies (timing) and the model.
  _onEvent(ev) {
    if (ev.kind === 'text') {
      const reply = protocol.parseReply(ev.text);
      if (reply) { this.timing.onReply(reply); this.emit('reply', reply, ev.from); }
      return;
    }
    if (ev.kind === 'app' && ev.portnum === PORT_ALARM) {
      const obj = protocol.parse260(ev.payload);
      if (obj && obj.t === 'sch') { this.config.onSchemaFrame(ev.from, obj); return; } // schema page, not model state
      this.model.apply({ from: ev.from, obj });
      this.emit('node', this.model.node(ev.from));
      return;
    }
    if (ev.kind === 'app' && ev.portnum === PORT_CHUNK) {
      this.images.onFrame(ev.payload, ev.from);
    }
  }

  // ---- events (typed, domain-level): 'node','reply','detection','image-available','alert','error'
  //      (inherited on/off/emit from EventEmitter)

  // ---- live model ----
  async nodes() { return this._summaries(await this.gw.nodes(this.gwId)); }
  async node(id) { return (await this.nodes()).find((n) => n.id === id || n.num === id) || null; }

  // Normalize the gateway node roster. VERIFIED live 2026-07-23 against
  // :8001/{gwId}/nodes: { total, count, filter, nodes } where `nodes` is a DICT
  // keyed by num-as-string (node_id absent; name in user.long_name/short_name).
  // Accept a dict OR an array (defensive for other gateways/versions).
  _summaries(j) {
    const nodes = (j && j.nodes !== undefined) ? j.nodes : j;
    let list;
    if (Array.isArray(nodes)) list = nodes;
    else if (nodes && typeof nodes === 'object') list = Object.values(nodes);
    else list = [];
    return list.map((e) => {
      const u = e.user || {};
      const num = e.num != null ? e.num : e.from_num;
      return {
        id: e.node_id || e.id || (num != null ? '!' + (num >>> 0).toString(16) : null),
        num,
        name: u.long_name || u.short_name || e.long_name || e.short_name || null,
        lastHeard: e.last_heard != null ? e.last_heard : null,
        hops: e.hops != null ? e.hops : null,
        raw: e,
      };
    });
  }

  // ---- addressing: target -> num, DM-default send, private fallback ----
  async _refreshRoster() {
    try { this._roster = await this.nodes(); }
    catch (e) { log.debug('roster refresh failed: %s', e && e.message); }
    return this._roster;
  }

  // Resolve a target to { num, atToken }. On a name/suffix miss, refetch the roster
  // once (it may be stale) then accept whatever we get — a null num means broadcast.
  async _resolve(node) {
    let r = resolveTarget(node, this._roster);
    if (r.num == null && r.atToken !== '*') { await this._refreshRoster(); r = resolveTarget(node, this._roster); }
    return r;
  }

  // Decide DM vs fallback + build the addressing prefix. Returns { text, opts, key }.
  _addressed(node, body, num, atToken) {
    const dm = this.cfg.dm || {};
    const directed = dm.default !== false && num != null;   // DM only when we have a num
    const addr = (directed && dm.omitAddress) ? '' : `@${atToken} `;  // @ stays until fleet-flashed
    const text = `${addr}${body}`;
    const opts = directed
      ? { to: num, channel: 0 }                                       // directed PKC DM
      : { channel: dm.fallbackChannel != null ? dm.fallbackChannel : this.channel }; // private broadcast
    return { text, opts, key: `${num != null ? num : atToken}|${text}` };
  }

  // Fire-and-forget send over the DM path (control frames; no reply awaited).
  async _sendRaw(node, body) {
    const { num, atToken } = await this._resolve(node);
    const { text, opts } = this._addressed(node, body, num, atToken);
    return this.gw.sendText(this.gwId, text, opts);
  }

  // Reliability profile for KNOWN-idempotent commands: resend on timeout (safe to repeat).
  // The raw command() below defaults to retries=0 — the escape hatch for reboot/wedge.
  _idem() { const r = this.cfg.retry || {}; return { retries: r.idempotent != null ? r.idempotent : 0, timeoutMs: r.attemptTimeoutMs }; }

  // Reliability profile for a RAW `cmd` passthrough: idempotent-retry unless the verb is
  // side-effecting (reboot/wedge → one-shot). Keeps cmd hop/echo/status resilient on a
  // marginal link without repeating a reboot.
  _cmdReliab(verb) { return DANGER.has(verb) ? {} : this._idem(); }

  // ---- commands (module owns grammar + timing + correlation) ----
  // { retries, timeoutMs } destructured (NOT named `opts` — that is the send opts from _addressed).
  async command(node, verb, args = [], { retries = 0, timeoutMs, noReply } = {}) {
    const a = Array.isArray(args) ? args : (args === '' || args == null ? [] : [args]);
    const { num, atToken } = await this._resolve(node);
    const body = `${verb}${a.length ? ' ' + a.join(' ') : ''}`;
    const { text, opts, key } = this._addressed(node, body, num, atToken);
    // Explicit noReply wins; otherwise auto-detect the by-another-route verbs.
    const nr = noReply != null ? noReply : (NO_REPLY.has(verb) || (a.length > 0 && NO_REPLY.has(`${verb} ${a[0]}`)));
    return this.timing.enqueue(
      () => this.gw.sendText(this.gwId, text, opts),
      { match: (r) => r && typeof r === 'object', dedupKey: `${key}|${verb}`, retries, timeoutMs, noReply: !!nr });
  }
  async ping(node) { return this.command(node, 'ping', [], this._idem()); }
  async status(node, domain) { return this.command(node, 'status', domain ? [domain] : [], this._idem()); }

  // ---- images (hides chunk/push/timing) ----
  async listImages(node) { return this.images.list(node); }
  async getImage(node, pid, opts) { return this.images.get(node, pid, opts); } // -> Buffer
  async grabImage(node, opts) { return this.images.grab(node, opts); }          // capture -> fetch: { pid, bytes, buf }
  async imageStats(node, pid) { return this.images.store.loadStats(node, pid); } // persisted per-pid transfer telemetry
  startImageListener() { return this.images.startListener(); }  // autonomous push catch

  // ---- daemon (long-running: model + autonomous image listener + domain feed) ----
  // Requires connect() first (cfg set). Returns the started Daemon.
  listen(opts = {}) {
    if (!this.cfg) throw new MeshError('listen() requires connect() first', 'ECONFIG');
    this.daemon = new Daemon({
      mesh: this, cfg: this.cfg, log: require('./lib/log').log.child('daemon'),
      out: opts.out, json: opts.json,
    });
    return this.daemon.start();
  }

  // ---- config (mesh-config phase) ----
  async getSchema(node) { return this.config.schema(node); }        // device field table (cached)
  async getConfig(node) { return this.config.get(node); }           // { values, unread }
  async setConfig(node, patch) { return this.config.set(node, patch); } // schema-validated, then confirmed

  // ---- alerts (notify phase) ----
  startAlertListener() { return ni('Mesh.startAlertListener'); }
}

// factory
function connect(opts) { const m = new Mesh(opts); return m.connect().then(() => m); }

module.exports = { Mesh, connect, errors, settings, Daemon, VERSION };
