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
const { Butler } = require('./lib/butler');
const { Align } = require('./lib/align');
const { Notifier } = require('./lib/notify');
const { Daemon } = require('./lib/daemon');
const log = require('./lib/log').log.child('mesh');

const VERSION = require('./package.json').version;
const PORT_ALARM = 260; // JSON: debug, config, adverts
const PORT_CHUNK = 261; // binary: chunk/push frames

// Verbs that answer by ANOTHER route (a 260/binary frame), never a text reply — resolve
// on send instead of waiting, else they always ETIMEOUT. Keyed by verb OR "verb subverb".
const NO_REPLY = new Set(['debug', 'cam grab', 'chunk pull', 'push pull']);

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
    // The device registry (which node ids are OURS). Created HERE, not in connect(),
    // because _onEvent -> _markOurs can run on any instance and must never depend on
    // connect() having populated it. connect() SEEDS it from config + disk.
    this._ours = new Set();
    this._radioAddrs = new Map();   // BLE addr -> node id, filled from mesh-gw /devices
    // Align is constructed HERE for the same reason: _onEvent routes pongs into it, and
    // that must not depend on connect() having run. connect() supplies the real deps —
    // until then it has no session, so every hook is a no-op.
    this.align = new Align({ addrOf: (addr) => this._radioAddrs.get(addr) || null });
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
    // Antenna alignment. Sends its pings through gw.sendText DIRECTLY, deliberately
    // bypassing the request ledger: 4 pings per press is instrument traffic, and it would
    // drown the outbox that exists to show a person what THEY sent. Same reasoning that
    // keeps chunk transfer out of it.
    Object.assign(this.align, {
      send: (text, opts) => this.gw.sendText(this.gwId, text, opts),
      cfg: this.cfg.align,
      radios: (this.cfg.align && this.cfg.align.radios) || {},
      channel: this.channel,
      cache: this.images && this.images.store && this.images.store.cache,
      log: require('./lib/log').log.child('align'),
      onChange: (view) => this.emit('align', view),
    });

    this.config = new Config({
      command: (node, verb, args) => this.command(node, verb, args, this._idem()),   // config/chunk cfg/name are idempotent
      send: (node, text) => this._sendRaw(node, text),      // `sch` pages: fire-and-forget over the DM path
      log: require('./lib/log').log.child('config'),
      // The schema is a FILE (generated at firmware build time), never a radio pull.
      schemaFile: this.cfg.schema && this.cfg.schema.file,
      // Persist the schema: pulling it needs the unit awake, and a sleeper is
      // unreachable ~99% of the time, so an in-memory cache would be empty after
      // every service restart. See Config.schema().
      store: this.images && this.images.store,
    });
    // Command butler: per-unit queue, delivered into the wake window ('heard'). deliver = the
    // idempotent PKC-DM command path (one attempt per window; the butler owns cross-window retry).
    this.butler = new Butler({
      // One deliver for both kinds; the entry says which. A text has no verb and no
      // reply to wait for, so it cannot go down the command path.
      deliver: (unit, verb, args, entry) => (entry && entry.kind === 'text'
        ? this._deliverText(entry)
        : this.command(unit, verb, args, this._idem())),
      store: this.images.store,
      log: require('./lib/log').log.child('butler'),
      cfg: this.cfg,
    });
    // Request lifecycle. Re-emitted as `request-*` and mapped onto the SSE wire in
    // host-module.js, so a consumer can follow a request without polling.
    for (const ev of ['queued', 'trying', 'done', 'sent', 'failed', 'expired', 'cancelled']) {
      this.butler.on(ev, (e) => this.emit('request-' + ev, e));
    }
    this.on('heard', (e) => { this.butler.onHeard(e.from).catch((err) => log.debug('butler onHeard: %s', err && err.message)); });

    // The device registry: which node ids are OURS. Two sources, union.
    //   - DECLARED (cfg.devices): authoritative, and present even for a unit that is
    //     asleep or has never been heard. NOT cfg.units — that is a mode-override map,
    //     so a unit with no override is absent from it and would silently vanish here.
    //   - LEARNED (a 260/261 frame decoded from it): only our firmware sends those, so
    //     it is proof rather than a naming convention. Persisted, because a unit asleep
    //     since the last restart has sent us nothing.
    for (const id of Object.keys(this.cfg.devices || {})) this._ours.add(id);
    for (const id of this.images.store.loadDevices()) this._ours.add(id);
    this.gw.onEvent((ev) => this._onEvent(ev));
    log.debug('connecting to gw %s (gwId %s, channel %d)', this.cfg.gw.host, this.gwId, this.channel);
    await this.gw.connect();
    await this._refreshRoster();   // seed target->num; refreshed lazily on a resolver miss
    await this._refreshRadios();   // BLE addr -> node id, so align can label yagi vs omni
    return this;
  }

  async close() { if (this.gw) await this.gw.close(); }

  // Route a normalized gw event into replies (timing) and the model.
  _onEvent(ev) {
    if (ev.kind === 'heard') {
      // A unit transmitted → its wake window is open. Record last-heard (live/dev mode),
      // cue the butler, and surface for consumers.
      this.model.heard(ev.from, Date.now());
      // Per-RADIO envelope for an alignment ping: OUR antennas hearing the device. One
      // such event per receiving radio, which is the only place yagi_q/omni_q can come
      // from. Ignored unless a session is running and the reply_id matches.
      if (ev.replyId != null) this.align.onEnvelope(ev.replyId, ev.addr, ev.rssi, ev.snr);
      this.emit('heard', { from: ev.from, portnum: ev.portnum, rssi: ev.rssi, snr: ev.snr });
      return;
    }
    if (ev.kind === 'text') {
      const reply = protocol.parseReply(ev.text);
      if (reply) {
        // A pong may be an alignment measurement. Offered to align FIRST because align
        // needs the per-radio `addr`, which nothing downstream carries — but it is only
        // consumed if a session is running and the reply_id matches an outstanding ping,
        // so normal command traffic is unaffected.
        if (reply.type === 'pong') this.align.onPong(reply, ev.replyId, ev.addr);
        this.timing.onReply(reply, ev.replyId); this.emit('reply', reply, ev.from);
      }
      // Not our JSON protocol => a HUMAN message. Previously dropped on the floor,
      // which meant an operator texting the mesh was invisible to this service.
      // Surfaced as 'text' so a console/chat consumer can see it; deliberately NOT
      // fed to timing.onReply, since it correlates to no command.
      else this.emit('text', {
        from: ev.from, text: ev.text, channel: ev.channel,
        // packetId is what a REPLY threads against (Meshtastic reply_id). It was captured
        // in gw._normalize but never surfaced, so a consumer could read a message and had
        // no way to answer it as a reply — it could only send a standalone text.
        packetId: ev.packetId, replyId: ev.replyId,
      });
      return;
    }
    if (ev.kind === 'app' && ev.portnum === PORT_ALARM) {
      this._markOurs(ev.from);
      const obj = protocol.parse260(ev.payload);
      this.model.apply({ from: ev.from, obj });
      this.emit('node', this.model.node(ev.from));
      return;
    }
    if (ev.kind === 'app' && ev.portnum === PORT_CHUNK) {
      this._markOurs(ev.from);
      this.images.onFrame(ev.payload, ev.from);
    }
  }

  // Learn that a node is ours. Runs on EVERY protocol frame, so the already-known case
  // must stay in memory — persisting per frame would write to disk continuously.
  _markOurs(id) {
    if (!id || this._ours.has(id)) return;
    this._ours.add(id);
    log.info('device registry: learned %s (speaks our protocol)', id);
    const store = this.images && this.images.store;
    if (!store) return;                     // no store wired (bare instance) — memory only
    try { store.saveDevices([...this._ours]); }
    catch (e) { log.warn('device registry: persist failed: %s', e && e.message); }
  }

  // ---- events (typed, domain-level): 'node','reply','detection','image-available','alert','error'
  //      (inherited on/off/emit from EventEmitter)

  // ---- live model ----
  async nodes() { return this._summaries(await this.gw.nodes(this.gwId)); }
  async node(id) { return (await this.nodes()).find((n) => n.id === id || n.num === id) || null; }

  // OUR devices only — the dynamic device list a dashboard builds its UI from, so it
  // never hardcodes node ids. Everything here is already in hand (roster + model +
  // registry): no device round-trip, so it is safe to poll and works with every unit
  // asleep. Liveness (mode/awake/slp) is included so a consumer does not have to follow
  // up with N calls to /mode/:target just to render a list.
  async devices() {
    const roster = new Map();
    try { for (const n of await this.nodes()) roster.set(n.id, n); }
    catch (e) { log.debug('devices: roster unavailable: %s', e && e.message); }

    const declared = this.cfg.devices || {};
    const ids = [...new Set([...Object.keys(declared), ...this._ours])].sort();

    return ids.map((id) => {
      const r = roster.get(id) || null;
      const u = (r && r.raw && r.raw.user) || {};
      const m = this.model.node(id) || {};
      const pos = (r && r.raw && r.raw.position) || null;
      const name = r ? r.name : null;
      // The firmware puts the build in the long name as "<suffix> <version>". Parse it
      // if it matches and leave it null otherwise — never guess a version.
      const fwMatch = typeof name === 'string' ? name.match(/^[0-9a-f]{4}\s+(\S+)$/i) : null;
      return {
        id,
        num: r ? r.num : null,
        name,
        shortName: u.short_name || null,
        label: (declared[id] && declared[id].label) || null,
        source: declared[id] ? 'config' : 'learned',
        // A DECLARED device stays listed while asleep or unheard — vanishing from the
        // list because it is sleeping is precisely what this route exists to prevent.
        present: !!r,
        mode: this.unitMode(id),
        awake: this.unitMode(id) === 'dev',
        slp: m.slp != null ? m.slp : null,
        lastHeard: r ? r.lastHeard : null,
        lastHeardMs: m.lastHeardMs || null,
        fw: fwMatch ? fwMatch[1] : null,
        position: pos && pos.latitude_i != null
          ? { lat: pos.latitude_i / 1e7, lon: pos.longitude_i / 1e7 } : null,
        hops: r ? r.hops : null,
        rssi: (r && r.raw && r.raw.rssi != null) ? r.raw.rssi : null,
        snr: (r && r.raw && r.raw.snr != null) ? r.raw.snr : null,
      };
    });
  }

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
      const id = e.node_id || e.id || (num != null ? '!' + (num >>> 0).toString(16) : null);
      return {
        id,
        num,
        name: u.long_name || u.short_name || e.long_name || e.short_name || null,
        lastHeard: e.last_heard != null ? e.last_heard : null,
        hops: e.hops != null ? e.hops : null,
        // Is this one of OUR alarm devices, or just another node on the shared mesh?
        // The roster is returned WHOLE (third-party nodes included, deliberately) —
        // this flag is what lets a consumer tell them apart without hardcoding ids.
        ours: this._ours.has(id),
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
    const reply = await this.timing.enqueue(
      () => this.gw.sendText(this.gwId, text, opts),
      { match: (r) => r && typeof r === 'object', dedupKey: `${key}|${verb}`, retries, timeoutMs, noReply: !!nr });
    // Learn the unit's sleep state from any reply that carries it (feeds live/dev mode).
    if (num != null && reply && typeof reply === 'object' && reply.slp != null) {
      this.model.sleep('!' + (num >>> 0).toString(16), reply.slp);
    }
    return reply;
  }

  // ---- live/dev mode (per-unit command routing) ----
  // Resolve a unit's interaction mode. First match wins: explicit config override,
  // then the device's known sleep state, then last-heard silence, else dev.
  unitMode(id) {
    const u = (this.cfg.units && this.cfg.units[id]) || {};
    if (u.mode === 'dev' || u.mode === 'live') return u.mode;   // operator override
    const n = this.model.node(id);
    if (n && n.slp === 1) return 'live';                        // device reports sleep on
    const silentMs = this.cfg.mode.silentMs;
    if (n && n.lastHeardMs && Date.now() - n.lastHeardMs > silentMs) return 'live'; // silent = asleep
    return 'dev';
  }

  // Operator command path: dev → direct (synchronous, returns the reply); live → auto-queue via
  // the butler (asynchronous, returns a queued ack — never a timeout on a sleeping unit).
  // command() stays the DIRECT primitive; internal callers + the butler's deliver use it directly.
  async dispatch(unit, verb, args = [], opts = {}) {
    const id = await this._unitKey(unit);
    const mode = this.unitMode(id);
    if (mode === 'live') {
      if (DANGER.has(verb) && !opts.force) {
        throw new MeshError(`${verb}: '${unit}' is LIVE (sleeping) — re-run with --force to queue a side-effecting command`, 'ELIVE');
      }
      const entry = await this.queueCommand(unit, verb, args, opts);
      const n = this.model.node(id);
      return { queued: true, mode, id: entry.id, unit: id, verb, args: entry.args,
               note: 'delivers on the unit\'s next wake window', lastHeardMs: n && n.lastHeardMs || null };
    }
    // DEV (awake) unit: still goes through the ledger, so every command you send is
    // recorded and trackable by id — previously this path was direct and INVISIBLE.
    // The caller keeps its synchronous reply: the butler's immediate attempt does the
    // work, and we simply wait for that entry to settle instead of bypassing it.
    const entry = await this.queueCommand(unit, verb, args, opts);
    const settled = await this._awaitSettled(entry.id, opts.waitMs);
    if (settled && settled.state === 'done') return settled.result;
    if (settled && settled.error) throw new MeshError(settled.error.message, settled.error.code);
    // Still in flight when the caller's patience ran out: hand back the id rather than
    // pretending it failed. The ledger keeps working on it.
    return { queued: true, mode, id: entry.id, unit: id, verb, args: entry.args,
             state: settled ? settled.state : 'queued',
             note: 'still in progress — follow it by id' };
  }

  // Wait for one ledger entry to reach a terminal state. Used by the dev path so a
  // caller keeps a synchronous reply without the command skipping the ledger.
  _awaitSettled(id, waitMs) {
    const TERMINAL = new Set(['done', 'sent', 'failed', 'expired', 'cancelled']);
    const limit = waitMs != null ? waitMs
      : this.cfg.timing.replyTimeoutMs + this.cfg.timing.sendSpacingMs;
    const now = this.butler.get(id);
    if (now && TERMINAL.has(now.state)) return Promise.resolve(now);
    // No event surface to wait on (a bare/stubbed butler): report what we can see rather
    // than hanging on a listener that will never fire.
    if (typeof this.butler.on !== 'function') return Promise.resolve(now);
    return new Promise((resolve) => {
      const done = (e) => {
        if (!e || e.id !== id) return;
        clearTimeout(timer);
        for (const ev of ['done', 'sent', 'failed', 'expired', 'cancelled']) this.butler.removeListener(ev, done);
        resolve(e);
      };
      const timer = setTimeout(() => {
        for (const ev of ['done', 'sent', 'failed', 'expired', 'cancelled']) this.butler.removeListener(ev, done);
        resolve(this.butler.get(id));
      }, limit);
      for (const ev of ['done', 'sent', 'failed', 'expired', 'cancelled']) this.butler.on(ev, done);
    });
  }

  // Mode + liveness for a unit (for the daemon's /nodes/:id and the `mode` verb).
  async unitInfo(target) {
    const id = await this._unitKey(target);
    const n = this.model.node(id) || {};
    const mode = this.unitMode(id);
    return { id, mode, lastHeardMs: n.lastHeardMs || null, slp: n.slp != null ? n.slp : null, awake: mode === 'dev' };
  }

  // Set (or clear, with 'auto') a unit's mode override — persisted to config.yaml AND applied to
  // this running instance so it takes effect immediately (the daemon re-reads config on restart).
  async setUnitMode(target, mode) {
    const id = await this._unitKey(target);
    const r = settings.setUnitMode(this.opts, id, mode);
    this.cfg.units = this.cfg.units || {};
    if (mode === 'auto') {
      if (this.cfg.units[id]) { delete this.cfg.units[id].mode; if (!Object.keys(this.cfg.units[id]).length) delete this.cfg.units[id]; }
    } else {
      this.cfg.units[id] = { ...(this.cfg.units[id] || {}), mode };
    }
    return { id, mode, file: r.file, resolved: this.unitMode(id) };
  }
  // Send FREE-FORM text (a human message), not a command. Deliberately separate from
  // command()/_sendRaw(): those build an addressed "@target verb" and force channel 0
  // (PKC DM), which for a handheld like TA2m does NOT decode in either direction —
  // measured. Chat therefore needs explicit channel control, so it is exposed here
  // rather than bolted onto the command path.
  //   to      target (num, '!id' or short form). Omit for a broadcast on the channel.
  //   channel defaults to the configured private channel, NOT 0.
  async sendText(text, { to, channel, replyId } = {}) {
    if (typeof text !== 'string' || !text.length) throw new MeshError('sendText: text required', 'EUSAGE');
    const ch = channel != null ? channel : this.channel;
    let toNum = null;
    if (to != null && to !== '*') {
      const r = await this._resolve(to);
      if (r.num == null) throw new MeshError(`sendText: cannot resolve target ${to}`, 'ETARGET');
      toNum = r.num;
    }
    // Text goes through the LEDGER like everything else. It used to be fire-and-forget
    // and invisible: you could send a message and have no record it existed. It can only
    // ever reach `sent`, never `done` — a plain text message carries no receipt.
    //
    // Key by the RESOLVED node id, exactly as commands do. Keying by the caller's raw
    // string ('336b') would file the same device under two different units and split its
    // history in half.
    let unitKey = '*';
    if (to != null && to !== '*') {
      unitKey = await this._unitKey(to).catch(() => String(to));
    }
    return this.butler.enqueue(unitKey, null, [], {
      kind: 'text', body: text, toNum, channel: ch,
      // Threads the reply against the message being answered, so it lands as a reply on
      // the recipient's device rather than as an unrelated text.
      replyId: replyId != null ? Number(replyId) : null,
    });
  }

  // Deliver a ledger entry of kind 'text'. Separate from command delivery because there
  // is no verb, no reply to correlate and no receipt to wait for — handing the frame to
  // the gateway is the whole operation.
  async _deliverText(entry) {
    const opts = { channel: entry.channel != null ? entry.channel : this.channel };
    if (entry.toNum != null) opts.to = entry.toNum;
    if (entry.replyId != null) opts.replyId = entry.replyId;
    return this.gw.sendText(this.gwId, entry.body, opts);
  }

  async ping(node) { return this.command(node, 'ping', [], this._idem()); }
  async status(node, domain) { return this.command(node, 'status', domain ? [domain] : [], this._idem()); }

  // ---- images (hides chunk/push/timing) ----
  async listImages(node) { return this.images.list(node); }
  async getImage(node, pid, opts) { return this.images.get(node, pid, opts); } // -> Buffer
  async grabImage(node, opts) { return this.images.grab(node, opts); }          // capture -> fetch: { pid, bytes, buf }
  async imageStats(node, pid) { return this.images.store.loadStats(node, pid); } // persisted per-pid transfer telemetry
  startImageListener() { return this.images.startListener(); }  // autonomous push catch

  // ---- command butler (queue + deliver into the wake window) ----
  // Canonicalise a target to the node-id key the queue + 'heard' both use.
  async _unitKey(target) {
    const { num } = await this._resolve(target);
    return num != null ? '!' + (num >>> 0).toString(16) : String(target);
  }
  async queueCommand(target, verb, args = [], opts = {}) {
    return this.butler.enqueue(await this._unitKey(target), verb, args, opts);
  }
  async queueList(target) { return this.butler.list(target ? await this._unitKey(target) : undefined); }

  // ---- antenna alignment -----------------------------------------------------
  // Which of OUR radios reported a packet. mesh-gw identifies a receiving device by BLE
  // `addr`; the config names radios by node id (an id survives a MAC change, and keeps
  // identity out of code). This maps one to the other.
  async _refreshRadios() {
    try {
      const j = await this.gw.devices();
      for (const d of (j && j.devices) || []) if (d.addr && d.node_id) this._radioAddrs.set(d.addr, d.node_id);
      log.debug('align: %d radio address(es) mapped', this._radioAddrs.size);
    } catch (e) { log.debug('align: radio map unavailable: %s', e && e.message); }
    return this._radioAddrs;
  }

  // One press = one burst of N pings, averaged into a single reading. Opens or retargets
  // the session as needed, exactly as the original did.
  async alignPing(target, n) {
    const r = await this._resolve(target);
    if (r.num == null) throw new MeshError(`align: cannot resolve target ${target}`, 'ETARGET');
    const s = this.align.session;
    if (!s || s.num !== r.num) {
      // Label the transmitting radio for the view. The configured gateway is what we send
      // through; it is reported to the UI, never chosen by it.
      const label = Object.entries((this.cfg.align && this.cfg.align.radios) || {})
        .find(([, id]) => id === this.gwId);
      this.align.start({ num: r.num, txLabel: (label && label[0] || 'gateway').toUpperCase(), channel: this.channel });
    }
    return this.align.ping(n);
  }
  alignStop() { return this.align.stop(); }
  alignState() { return this.align.view(); }
  alignConfig({ replyWindowSec } = {}) {
    if (replyWindowSec != null) this.align.setReplyWindowSec(replyWindowSec);
    return this.align.view();
  }

  // The outbox, queried. Reads the LEDGER rather than the butler's in-memory mirror, so
  // it sees settled history too — the butler only holds what it is still working on.
  async requests({ unit, state, kind, limit, offset } = {}) {
    const u = unit ? await this._unitKey(unit).catch(() => unit) : undefined;
    return this.images.store.listRequests({ unit: u, state, kind, limit, offset });
  }
  queueCancel(id) { return this.butler.cancel(id); }

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
  // Device field table (id/type/label/default/writable/bounds). CACHED, because it
  // costs one `sch` page-pull round-trip per page. opts.refresh forces a re-pull —
  // needed after a firmware update, since a new build can add or change fields and a
  // stale cached schema would render a form that no longer matches the device.
  async getSchema(node, opts) { return this.config.schema(node, opts); }
  async getConfig(node) { return this.config.get(node); }           // { values, unread }
  async setConfig(node, patch) { return this.config.set(node, patch); } // schema-validated, then confirmed

  // ---- alerts (notify phase) ----
  startAlertListener() { return ni('Mesh.startAlertListener'); }
}

// factory
function connect(opts) { const m = new Mesh(opts); return m.connect().then(() => m); }

module.exports = { Mesh, connect, errors, settings, Daemon, VERSION };
