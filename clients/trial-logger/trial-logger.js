#!/usr/bin/env node
// trial-logger — persist mesh-gw packet events to daily CSVs + missed-heartbeat alerts.
// Faithful Node port of tools/trial_logger.py (pac-garage-alarm). Subscribes to mesh-gw's
// /events websocket and appends one row per packet event per reporting BLE device (per-receiver
// RSSI is link data). Decodes telemetry/text/nodeinfo payloads into columns. Emits per-node
// missed-heartbeat ALERTs based on each node's own observed cadence — no node IDs configured.
// Whole-mesh RAW recorder (deliberately NOT the @pac/mesh domain view). See specs/trial-logger-node.md.
'use strict';
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');
const protobuf = require('protobufjs');

const WS_URL = process.env.MESH_GW_EVENTS || 'ws://localhost:8001/events';
const DATA_DIR = process.env.TRIAL_LOG_DIR || path.join(__dirname, 'data');

const FIELDS = ['utc', 'addr', 'from_id', 'to_id', 'channel', 'port', 'pkt_id',
  'rssi', 'snr', 'hop_limit', 'hop_start', 'relay', 'temp_c', 'rh_pct',
  'vbat_v', 'batt_pct', 'uptime_s', 'text', 'long_name'];

const root = protobuf.loadSync(path.join(__dirname, 'meshtastic.proto'));
const Telemetry = root.lookupType('Telemetry');
const User = root.lookupType('User');

// per-node liveness: from_id -> { last, gaps:[], alerted }
const nodes = new Map();

const nowSec = () => Date.now() / 1000;
const isoSeconds = () => new Date().toISOString().slice(0, 19) + '+00:00';
const hex8 = (n) => ((n >>> 0) || 0).toString(16).padStart(8, '0');
function median(a) { const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; }

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
    } else if (port === 'TEXT_MESSAGE_APP') {
      row.text = raw.toString('utf8');
    } else if (port === 'NODEINFO_APP') {
      const u = User.decode(raw);
      if (u.longName) row.long_name = u.longName;
    } else if (port === 'DETECTION_SENSOR_APP') {
      row.text = raw.toString('utf8');
    }
  } catch (e) { /* undecodable payloads still get their signal row */ }
}

function csvPath() {
  const day = new Date().toISOString().slice(0, 10).replace(/-/g, ''); // UTC YYYYMMDD
  return path.join(DATA_DIR, `mesh-${day}.csv`);
}
function csvField(v) {
  const s = String(v);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;   // csv QUOTE_MINIMAL
}
function appendRow(row) {
  const p = csvPath();
  const isNew = !fs.existsSync(p);
  let out = isNew ? FIELDS.join(',') + '\n' : '';
  out += FIELDS.map((k) => csvField(row[k])).join(',') + '\n';
  fs.appendFileSync(p, out);
}

function alert(msg) {
  const line = `${new Date().toISOString()} ALERT ${msg}`;
  console.log(line);
  try { fs.appendFileSync(path.join(DATA_DIR, 'alerts.log'), line + '\n'); } catch (e) { /* best effort */ }
}

function liveness(fromId, now) {
  let n = nodes.get(fromId);
  if (!n) { n = { last: now, gaps: [], alerted: false }; nodes.set(fromId, n); }
  const gap = now - n.last;
  if (gap > 0 && gap < 3600) n.gaps = n.gaps.concat(gap).slice(-20);
  if (n.alerted) { alert(`${fromId} BACK after ${Math.floor(gap)}s silence`); n.alerted = false; }
  n.last = now;
}

function checkSilences(now) {
  for (const [fromId, n] of nodes) {
    if (n.alerted || n.gaps.length < 3) continue;
    const med = median(n.gaps);
    if (now - n.last > Math.max(300, 5 * med)) {
      alert(`${fromId} SILENT for ${Math.floor(now - n.last)}s (median gap ${Math.floor(med)}s)`);
      n.alerted = true;
    }
  }
}

function handle(msg) {
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
  appendRow(row);
  liveness(row.from_id, nowSec());
}

function connect() {
  const ws = new WebSocket(WS_URL);
  ws.on('open', () => console.log('connected'));
  ws.on('message', (data) => handle(data.toString()));
  ws.on('error', (err) => console.log(`ws error: ${err && err.message}`));
  ws.on('close', () => { console.log('reconnect in 5s'); setTimeout(connect, 5000); });
}

fs.mkdirSync(DATA_DIR, { recursive: true });
console.log(`trial-logger: ${WS_URL} -> ${DATA_DIR}`);
connect();
setInterval(() => checkSilences(nowSec()), 30000);
