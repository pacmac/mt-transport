#!/usr/bin/env node
// trial-logger — STANDALONE entry point for the recorder.
//
// All behaviour now lives in recorder.js so the same code can run either as its own
// process (this file, which is what PM2 executes today) or as a module inside the
// single service (specs/single-service-host.md). This file's ONLY job is to turn the
// environment into config and start it — exactly what the host does with ctx.config.
//
// Keeping this path unchanged is deliberate: the running PM2 app keeps working through
// the refactor, so the recorder — the evidence trail every diagnosis depends on — is
// never off the air just because the code moved.
'use strict';
const path = require('path');
const { Recorder } = require('./recorder');

const rec = new Recorder({
  wsUrl: process.env.MESH_GW_EVENTS || 'ws://localhost:8001/events',
  dataDir: process.env.TRIAL_LOG_DIR || path.join(__dirname, 'data'),
}, {
  // PM2 captures stdout; keep the original one-line-per-event style.
  info: (...a) => console.log(fmt(a)),
  warn: (...a) => console.log(fmt(a)),
  debug: () => {},
});

function fmt(a) {
  const [first, ...rest] = a;
  let i = 0;
  const s = String(first).replace(/%[sdj]/g, (m) => {
    const v = rest[i++];
    return m === '%j' ? JSON.stringify(v) : String(v);
  });
  return rest.slice(i).length ? `${s} ${rest.slice(i).join(' ')}` : s;
}

rec.start();

// Shut down cleanly so a restart never leaves a socket or timer behind.
const bye = async (sig) => { console.log(`${sig} — stopping`); await rec.stop(); process.exit(0); };
process.on('SIGINT', () => bye('SIGINT'));
process.on('SIGTERM', () => bye('SIGTERM'));
