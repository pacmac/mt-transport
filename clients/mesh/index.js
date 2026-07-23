// @pac/mesh — the mesh domain module. THE single owner of mesh mechanics, our
// private protocol and timing. Consumers (node-dash, CLI, daemon, any dashboard)
// speak DOMAIN — nodes, detections, images, config, alerts — and know nothing of
// ports, frames, chunks, channels, airtime or queues.
//
// Skeleton: every method is exported and empty (throws NotImplemented). Wiring
// and shape only; bodies land in later phases (see specs/mesh-module.md).
'use strict';
const { EventEmitter } = require('events');
const errors = require('./lib/errors');
const { ni } = errors;
const settings = require('./lib/settings');
const { Gateway } = require('./lib/gw');
const { Timing } = require('./lib/timing');
const { Model } = require('./lib/model');
const { Images } = require('./lib/images');
const { Config } = require('./lib/config');
const { Notifier } = require('./lib/notify');

const VERSION = require('./package.json').version;

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
  }

  // ---- lifecycle ----
  async connect() { return ni('Mesh.connect'); }   // load config, open gw, wire events
  async close() { return ni('Mesh.close'); }

  // ---- events (typed, domain-level): 'node','detection','image-available','alert','error'
  //      (inherited on/off/emit from EventEmitter; documented here as the contract)

  // ---- live model (no I/O) ----
  nodes() { return ni('Mesh.nodes'); }
  node(id) { return ni('Mesh.node'); }

  // ---- commands (module owns grammar + timing + correlation) ----
  async command(node, verb, args) { return ni('Mesh.command'); }  // generic escape hatch
  async ping(node) { return ni('Mesh.ping'); }
  async status(node, domain) { return ni('Mesh.status'); }        // '', 'mem', 'alarm'

  // ---- images (hides chunk/push/timing) ----
  async listImages(node) { return ni('Mesh.listImages'); }
  async getImage(node, pid, opts) { return ni('Mesh.getImage'); } // -> Buffer
  startImageListener() { return ni('Mesh.startImageListener'); }  // passive push catch

  // ---- config (schema-validated) ----
  async getSchema(node) { return ni('Mesh.getSchema'); }
  async getConfig(node) { return ni('Mesh.getConfig'); }
  async setConfig(node, patch) { return ni('Mesh.setConfig'); }   // validate then send

  // ---- alerts ----
  startAlertListener() { return ni('Mesh.startAlertListener'); }  // -> 'alert' events -> notifier
}

// factory
function connect(opts) { const m = new Mesh(opts); return m.connect().then(() => m); }

module.exports = { Mesh, connect, errors, settings, VERSION };
