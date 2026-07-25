// offline_recorder.js — contract test for the recorder module. No sockets: packet
// events are fed straight to the handler, which is what the websocket would do.
//
// This module is the EVIDENCE TRAIL — every diagnosis in this project has come back
// to these CSVs — so the things asserted here are: rows are written exactly as the
// original script wrote them, a malformed event never costs us a row, and stop()
// genuinely stops (a surviving reconnect timer would resurrect the socket behind the
// host's back).
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Recorder, FIELDS } = require('../recorder');

let checks = 0;
const ok = (c, m) => { assert(c, m); checks++; };
const quiet = { info() {}, warn() {}, debug() {} };

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rec-'));
const pkt = (over = {}) => JSON.stringify({
  type: 'packet', addr: 'AA:BB', data: { packet: Object.assign({
    from: 0x8cee336b, to: 0xffffffff, id: 0x1234abcd, channel: 2,
    rx_rssi: -56, rx_snr: 6.25, hop_limit: 3, hop_start: 3,
    decoded: { portnum: 'TELEMETRY_APP', payload: '' },
  }, over) },
});

// ---- 1. header once, then one row per packet -------------------------------
{
  const rec = new Recorder({ dataDir: tmp, wsUrl: 'ws://unused' }, quiet);
  fs.mkdirSync(tmp, { recursive: true });
  rec._handle(pkt());
  rec._handle(pkt());
  const lines = fs.readFileSync(rec.csvPath(), 'utf8').trim().split('\n');
  ok(lines[0] === FIELDS.join(','), 'header written exactly once, unchanged field order');
  ok(lines.length === 3, 'two packets -> two rows');
  const cols = lines[1].split(',');
  ok(cols[FIELDS.indexOf('from_id')] === '8cee336b', 'from_id hex8');
  ok(cols[FIELDS.indexOf('to_id')] === 'ffffffff', 'to_id hex8');
  ok(cols[FIELDS.indexOf('pkt_id')] === '1234abcd', 'pkt_id hex8');
  ok(cols[FIELDS.indexOf('rssi')] === '-56', 'rssi recorded (per-receiver link data)');
  ok(rec.rows === 2, 'row counter');
}

// ---- 2. non-packet events and junk are ignored, never throw ----------------
{
  const rec = new Recorder({ dataDir: tmp, wsUrl: 'ws://unused' }, quiet);
  const before = rec.rows;
  rec._handle('not json at all');
  rec._handle(JSON.stringify({ type: 'status' }));
  rec._handle(JSON.stringify({ type: 'packet' }));                 // no data
  rec._handle(JSON.stringify({ type: 'packet', data: {} }));        // no packet
  ok(rec.rows === before, 'malformed input writes nothing and does not throw');
}

// ---- 3. text payloads are decoded and CSV-escaped --------------------------
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rec2-'));
  const rec = new Recorder({ dataDir: dir, wsUrl: 'ws://unused' }, quiet);
  fs.mkdirSync(dir, { recursive: true });
  const evil = 'has "quotes", a comma\nand a newline';
  rec._handle(pkt({ decoded: { portnum: 'TEXT_MESSAGE_APP', payload: Buffer.from(evil).toString('base64') } }));
  const body = fs.readFileSync(rec.csvPath(), 'utf8');
  ok(body.includes('"has ""quotes"", a comma'), 'CSV quoting/escaping preserved (QUOTE_MINIMAL)');
  ok(body.includes('and a newline"'), 'the embedded newline is kept INSIDE the quoted field');
  // GOTCHA, asserted deliberately: a text payload may contain a newline, so this file
  // is RFC4180 with multi-line records — naive split('\n') over-counts rows. Any
  // analysis must use a real CSV parser (python csv.DictReader, etc.), never line
  // splitting. Here the single logical row spans two physical lines.
  ok(body.trim().split('\n').length === 3, 'one logical row spans two physical lines — do NOT line-split these CSVs');
  fs.rmSync(dir, { recursive: true, force: true });
}

// ---- 4. liveness + alerts ---------------------------------------------------
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rec3-'));
  fs.mkdirSync(dir, { recursive: true });
  const rec = new Recorder({ dataDir: dir, wsUrl: 'ws://unused' }, quiet);
  const emitted = [];
  rec.emit = (t, p) => emitted.push([t, p]);

  const id = '8cee336b';
  const t0 = 10000;
  rec._liveness(id, t0);
  rec._liveness(id, t0 + 60);
  rec._liveness(id, t0 + 120);
  rec._liveness(id, t0 + 180);        // 3 gaps of 60s -> median 60
  rec._checkSilences(t0 + 180 + 400); // > max(300, 5*60) -> alert
  ok(emitted.some(([t, p]) => t === 'alert' && /SILENT/.test(p.message)), 'silence alert raised from the node OWN cadence');
  ok(rec.nodes.get(id).alerted === true, 'node marked alerted');

  rec._liveness(id, t0 + 700);        // it comes back
  ok(emitted.some(([t, p]) => t === 'alert' && /BACK/.test(p.message)), 'recovery alert raised');
  ok(rec.nodes.get(id).alerted === false, 'alert cleared on return');
  ok(fs.existsSync(path.join(dir, 'alerts.log')), 'alerts persisted to disk');
  fs.rmSync(dir, { recursive: true, force: true });
}

// ---- 5. events reach the host bus ------------------------------------------
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rec4-'));
  fs.mkdirSync(dir, { recursive: true });
  const rec = new Recorder({ dataDir: dir, wsUrl: 'ws://unused' }, quiet);
  const seen = [];
  rec.emit = (t, p) => seen.push([t, p]);
  rec._handle(pkt());
  ok(seen.length === 1 && seen[0][0] === 'packet', 'packet published to the host bus');
  ok(seen[0][1].from_id === '8cee336b', 'published row carries the decoded fields');
  fs.rmSync(dir, { recursive: true, force: true });
}

// ---- 6. stop() leaves NOTHING running --------------------------------------
{
  const rec = new Recorder({ dataDir: tmp, wsUrl: 'ws://127.0.0.1:1' }, quiet); // refused connect
  rec.start();
  ok(rec._timer !== null, 'silence timer running while started');
  return Promise.resolve()
    .then(() => new Promise((r) => setTimeout(r, 60)))   // let the connect fail + schedule
    .then(() => rec.stop())
    .then(() => {
      ok(rec._timer === null, 'silence timer cleared');
      ok(rec._reconnect === null, 'reconnect timer cleared');
      ok(rec._ws === null, 'websocket released');
      ok(rec._stopped === true, 'stopped flag set');
      // The decisive one: a close event AFTER stop must not resurrect the socket.
      rec._connect();
      ok(rec._ws === null, 'STOPPED RECORDER REFUSES TO RECONNECT');
      fs.rmSync(tmp, { recursive: true, force: true });
      console.log(`offline_recorder OK: ${checks} checks passed`);
    });
}
