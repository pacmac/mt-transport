// recorder — the whole-mesh RAW packet recorder, as a host module.
//
// Subscribes to mesh-gw's /events websocket and appends one CSV row per packet event
// per reporting BLE device (per-receiver RSSI is link data, so the same packet heard
// by two gateways is two rows). Decodes telemetry/text/nodeinfo into columns. Raises
// per-node missed-heartbeat alerts from each node's OWN observed cadence — no node
// ids are configured anywhere.
//
// This is the EVIDENCE TRAIL. Every diagnosis in this project has come back to these
// CSVs, so the rules here are: never lose a row, never let a failure here take the
// host down, and never block the event loop long enough to delay a mesh command.
//
// Deliberately NOT the @pac/mesh domain view — that module reports nodes, replies and
// images; this one records frames.
//
// State is per-instance (nothing at module scope) so start() can be called again
// after stop() without leaking the previous run's websocket, timer or node table.
'use strict';
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');
const protobuf = require('protobufjs');

const FIELDS = ['utc', 'addr', 'from_id', 'to_id', 'channel', 'port', 'pkt_id',
  'rssi', 'snr', 'hop_limit', 'hop_start', 'relay', 'temp_c', 'rh_pct',
  'vbat_v', 'batt_pct', 'uptime_s', 'text', 'long_name'];

const root = protobuf.loadSync(path.join(__dirname, 'meshtastic.proto'));
const Telemetry = root.lookupType('Telemetry');
const User = root.lookupType('User');

const nowSec = () => Date.now() / 1000;
const isoSeconds = () => new Date().toISOString().slice(0, 19) + '+00:00';
const hex8 = (n) => ((n >>> 0) || 0).toString(16).padStart(8, '0');
const median = (a) => { const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

function decodePayload(port, payloadB64, row) {
  try {
    const raw = payloadB64 ? Buffer.from(payloadB64, 'base64') : Buffer.alloc(0);
    if (port === 'TELEMETRY_APP') {
      const t = Telemetry.decode(raw);
      if (t.deviceMetrics) {
        const d = t.deviceMetrics;
        row.vbat_v = Number((d.voltage ?? 0).toFixed(3));
        row.batt_pct = d.batteryLevel ?? 0;
        row.uptime_s = d.uptimeSeconds ?? 0;
      } else if (t.environmentMetrics) {
        const e = t.environmentMetrics;
        row.temp_c = Number((e.temperature ?? 0).toFixed(2));
        row.rh_pct = Number((e.relativeHumidity ?? 0).toFixed(1));
      }
    } else if (port === 'TEXT_MESSAGE_APP' || port === 'DETECTION_SENSOR_APP') {
      row.text = raw.toString('utf8');
    } else if (port === 'NODEINFO_APP') {
      const u = User.decode(raw);
      if (u.longName) row.long_name = u.longName;
    }
  } catch { /* an undecodable payload still gets its signal row — never drop evidence */ }
}

const csvField = (v) => {
  const s = String(v);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;   // csv QUOTE_MINIMAL
};

class Recorder {
  constructor(cfg = {}, log) {
    this.wsUrl = cfg.wsUrl || 'ws://localhost:8001/events';
    this.dataDir = cfg.dataDir || path.join(__dirname, 'data');
    this.silenceCheckMs = cfg.silenceCheckMs != null ? cfg.silenceCheckMs : 30000;
    this.reconnectMs = cfg.reconnectMs != null ? cfg.reconnectMs : 5000;
    this.log = log || { info() {}, warn() {}, debug() {} };
    this.emit = null;            // set by start(); publishes to the host's event stream

    this.nodes = new Map();      // from_id -> { last, gaps[], alerted }
    this.rows = 0;
    this.connected = false;
    this._ws = null;
    this._timer = null;
    this._reconnect = null;
    this._stopped = false;
    this._headerFor = null;      // path whose header we have already written
  }

  start() {
    fs.mkdirSync(this.dataDir, { recursive: true });
    this.log.info('recorder: %s -> %s', this.wsUrl, this.dataDir);
    this._connect();
    this._timer = setInterval(() => this._checkSilences(nowSec()), this.silenceCheckMs);
    if (this._timer.unref) this._timer.unref();
    return this;
  }

  // Must leave NOTHING running: an un-cleared reconnect timer would resurrect the
  // websocket after the host thought this module was stopped.
  async stop() {
    this._stopped = true;
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
    if (this._reconnect) { clearTimeout(this._reconnect); this._reconnect = null; }
    if (this._ws) {
      try { this._ws.removeAllListeners(); this._ws.close(); } catch { /* already gone */ }
      this._ws = null;
    }
    this.connected = false;
    this.log.info('recorder: stopped');
  }

  status() {
    const now = nowSec();
    return {
      wsUrl: this.wsUrl,
      dataDir: this.dataDir,
      connected: this.connected,
      csv: this.csvPath(),
      rows: this.rows,
      nodes: [...this.nodes.entries()].map(([id, n]) => ({
        id,
        lastSeenSec: Math.round(now - n.last),
        medianGapSec: n.gaps.length ? Math.round(median(n.gaps)) : null,
        alerted: n.alerted,
      })).sort((a, b) => a.lastSeenSec - b.lastSeenSec),
    };
  }

  csvPath(day) {
    const d = day || new Date().toISOString().slice(0, 10).replace(/-/g, ''); // UTC YYYYMMDD
    return path.join(this.dataDir, `mesh-${d}.csv`);
  }

  days() {
    try {
      return fs.readdirSync(this.dataDir)
        .filter((f) => /^mesh-\d{8}\.csv$/.test(f))
        .map((f) => f.slice(5, 13)).sort();
    } catch { return []; }
  }

  // ---- internals ------------------------------------------------------------

  _connect() {
    if (this._stopped) return;
    const ws = new WebSocket(this.wsUrl);
    this._ws = ws;
    ws.on('open', () => { this.connected = true; this.log.info('recorder: connected'); });
    ws.on('message', (data) => this._handle(data.toString()));
    ws.on('error', (err) => this.log.warn('recorder: ws error: %s', err && err.message));
    ws.on('close', () => {
      this.connected = false;
      if (this._stopped) return;                       // stop() wins — do NOT resurrect
      this.log.info('recorder: reconnect in %dms', this.reconnectMs);
      this._reconnect = setTimeout(() => this._connect(), this.reconnectMs);
      if (this._reconnect.unref) this._reconnect.unref();
    });
  }

  _appendRow(row) {
    const p = this.csvPath();
    // Write the header only when the file is genuinely new. The path is cached so a
    // steady stream of packets does not cost an existsSync() syscall per row — this
    // runs in the same process as command delivery now.
    let out = '';
    if (this._headerFor !== p) {
      this._headerFor = p;
      if (!fs.existsSync(p)) out += FIELDS.join(',') + '\n';
    }
    out += FIELDS.map((k) => csvField(row[k])).join(',') + '\n';
    fs.appendFileSync(p, out);
    this.rows++;
  }

  _alert(msg) {
    const line = `${new Date().toISOString()} ALERT ${msg}`;
    this.log.warn('recorder: %s', msg);
    try { fs.appendFileSync(path.join(this.dataDir, 'alerts.log'), line + '\n'); }
    catch { /* best effort — an alert must never break recording */ }
    if (this.emit) this.emit('alert', { message: msg, t: Date.now() });
  }

  _liveness(fromId, now) {
    let n = this.nodes.get(fromId);
    if (!n) { n = { last: now, gaps: [], alerted: false }; this.nodes.set(fromId, n); }
    const gap = now - n.last;
    if (gap > 0 && gap < 3600) n.gaps = n.gaps.concat(gap).slice(-20);
    if (n.alerted) { this._alert(`${fromId} BACK after ${Math.floor(gap)}s silence`); n.alerted = false; }
    n.last = now;
  }

  _checkSilences(now) {
    for (const [fromId, n] of this.nodes) {
      if (n.alerted || n.gaps.length < 3) continue;
      const med = median(n.gaps);
      if (now - n.last > Math.max(300, 5 * med)) {
        this._alert(`${fromId} SILENT for ${Math.floor(now - n.last)}s (median gap ${Math.floor(med)}s)`);
        n.alerted = true;
      }
    }
  }

  _handle(msg) {
    let e;
    try { e = JSON.parse(msg); } catch { return; }
    if (e.type !== 'packet') return;
    const pkt = (e.data || {}).packet;
    if (!pkt || typeof pkt !== 'object') return;
    const dec = pkt.decoded || {};
    const row = {}; for (const k of FIELDS) row[k] = '';
    row.utc = isoSeconds();
    row.addr = e.addr || '';
    row.from_id = hex8(pkt.from);
    row.to_id = hex8(pkt.to);
    row.channel = pkt.channel ?? 0;
    row.port = dec.portnum || '';
    row.pkt_id = hex8(pkt.id);
    row.rssi = pkt.rx_rssi ?? '';
    row.snr = pkt.rx_snr ?? '';
    row.hop_limit = pkt.hop_limit ?? '';
    row.hop_start = pkt.hop_start ?? '';
    row.relay = pkt.relay_node ?? '';
    decodePayload(row.port, dec.payload, row);
    try { this._appendRow(row); }
    catch (err) { this.log.warn('recorder: append failed: %s', err && err.message); }
    this._liveness(row.from_id, nowSec());
    if (this.emit) this.emit('packet', row);
  }
}

// ---- host module contract ---------------------------------------------------
module.exports = {
  name: 'recorder',
  async start(ctx) {
    const rec = new Recorder(ctx.config || {}, ctx.log);
    rec.emit = ctx.bus && ctx.bus.emit;
    rec.start();
    return {
      routes: [
        ['GET', '/status', async () => rec.status()],
        ['GET', '/days', async () => ({ days: rec.days(), dataDir: rec.dataDir })],
        ['GET', '/alerts', async ({ query }) => {
          const n = Math.min(Number(query.get('limit')) || 100, 1000);
          try {
            const lines = fs.readFileSync(path.join(rec.dataDir, 'alerts.log'), 'utf8').trim().split('\n');
            return { alerts: lines.slice(-n) };
          } catch { return { alerts: [] }; }
        }],
      ],
      stop: () => rec.stop(),
    };
  },
  Recorder,   // exported for tests and the standalone entry
  FIELDS,
};
