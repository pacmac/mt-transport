// Offline test for lib/settings.js — DEFAULTS < config.yaml < env < opts, and find().
'use strict';
const assert = require('assert');
const os = require('os');
const fs = require('fs');
const path = require('path');
const settings = require('../lib/settings');

let pass = 0;
const ok = (cond, msg) => { assert(cond, msg); pass++; };

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mtmesh-cfg-'));
const cfgPath = path.join(dir, 'config.yaml');
fs.writeFileSync(cfgPath, 'channel: 5\nlogLevel: debug\ngw:\n  host: filehost\n  gatewayId: "!file"\n');

try {
  // DEFAULTS
  ok(settings.DEFAULTS.channel === 2 && settings.DEFAULTS.gw.gatewayId === null, 'DEFAULTS present, gatewayId null');

  // file over defaults; unset keys keep DEFAULTS
  let c = settings.load({ configPath: cfgPath });
  ok(c.channel === 5 && c.gw.host === 'filehost' && c.gw.gatewayId === '!file', 'file overrides defaults');
  ok(c.gw.port === 8001 && c.timing.sendSpacingMs === 3000, 'unset keys keep DEFAULTS (mesh-gw :8001, never node-dash :8000)');
  ok(c.logLevel === 'debug', 'file logLevel applied');

  // env over file
  process.env.MTMESH_CHANNEL = '7';
  c = settings.load({ configPath: cfgPath });
  ok(c.channel === 7, 'env overrides file');

  // opts over env
  c = settings.load({ configPath: cfgPath, channel: 9 });
  ok(c.channel === 9, 'opts override env');
  delete process.env.MTMESH_CHANNEL;

  // opts.gw host:port moves BOTH port and sendPort (else send/events split)
  c = settings.load({ configPath: cfgPath, gw: '1.2.3.4:9001' });
  ok(c.gw.host === '1.2.3.4' && c.gw.port === 9001 && c.gw.sendPort === 9001,
    'opts.gw host:port sets host+port+sendPort');

  // host-only override leaves ports untouched (from DEFAULTS: 8001/8001 = mesh-gw)
  c = settings.load({ configPath: cfgPath, gw: 'onlyhost' });
  ok(c.gw.host === 'onlyhost' && c.gw.port === 8001 && c.gw.sendPort === 8001,
    'host-only override leaves ports as-is');

  // env MTMESH_GW host:port also moves both ports
  process.env.MTMESH_GW = 'envhost:7000';
  c = settings.load({ configPath: cfgPath });
  ok(c.gw.host === 'envhost' && c.gw.port === 7000 && c.gw.sendPort === 7000,
    'env MTMESH_GW host:port sets both ports');
  delete process.env.MTMESH_GW;

  // undefined opts don't clobber
  c = settings.load({ configPath: cfgPath, gatewayId: undefined });
  ok(c.gw.gatewayId === '!file', 'undefined opts do not clobber file value');

  // find() precedence
  ok(settings.find({ configPath: cfgPath }) === cfgPath, 'find: configPath wins');
  process.env.MTMESH_CONFIG = cfgPath;
  ok(settings.find({}) === cfgPath, 'find: MTMESH_CONFIG honored');
  delete process.env.MTMESH_CONFIG;
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log(`settings OK: ${pass} assertions passed`);
