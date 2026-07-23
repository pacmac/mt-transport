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
const { Gateway } = require('./lib/gw');
const { Timing } = require('./lib/timing');
const { Model } = require('./lib/model');
const { Images } = require('./lib/images');
const { Config } = require('./lib/config');
const { Notifier } = require('./lib/notify');
const log = require('./lib/log').log.child('mesh');

const VERSION = require('./package.json').version;
const PORT_ALARM = 260; // JSON: debug, config, adverts
const PORT_CHUNK = 261; // binary: chunk/push frames

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
      command: (node, verb, args) => this.command(node, verb, args),
    });
    this.images.emit = (type, payload) => this.emit(type, payload);
    this.gw.onEvent((ev) => this._onEvent(ev));
    log.debug('connecting to gw %s (gwId %s, channel %d)', this.cfg.gw.host, this.gwId, this.channel);
    await this.gw.connect();
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

  // ---- commands (module owns grammar + timing + correlation) ----
  async command(node, verb, args = []) {
    const a = Array.isArray(args) ? args : (args === '' || args == null ? [] : [args]);
    const text = protocol.buildCommand(node, verb, a);
    return this.timing.enqueue(
      () => this.gw.sendText(this.gwId, text, { channel: this.channel }),
      { match: (r) => r && typeof r === 'object', dedupKey: `${node}|${verb}|${text}` });
  }
  async ping(node) { return this.command(node, 'ping'); }
  async status(node, domain) { return this.command(node, 'status', domain ? [domain] : []); }

  // ---- images (hides chunk/push/timing) ----
  async listImages(node) { return this.images.list(node); }
  async getImage(node, pid, opts) { return this.images.get(node, pid, opts); } // -> Buffer
  startImageListener() { return this.images.startListener(); }  // autonomous push catch

  // ---- config (mesh-config phase) ----
  async getSchema(node) { return ni('Mesh.getSchema'); }
  async getConfig(node) { return ni('Mesh.getConfig'); }
  async setConfig(node, patch) { return ni('Mesh.setConfig'); }

  // ---- alerts (notify phase) ----
  startAlertListener() { return ni('Mesh.startAlertListener'); }
}

// factory
function connect(opts) { const m = new Mesh(opts); return m.connect().then(() => m); }

module.exports = { Mesh, connect, errors, settings, VERSION };
