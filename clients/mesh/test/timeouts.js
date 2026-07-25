'use strict';
// THE RULE, ENFORCED: every timeout, delay, interval and cap is declared in settings.js
// DEFAULTS — never a bare constant, never an inline `|| 8000` fallback.
//
// Peter, 2026-07-25: "EVERY SINGLE TIMEOUT MUST BE CONFIGURABLE. NO EXCEPTION."
//
// This exists because the rule was broken twice in one day and cost a full day of
// misdiagnosis: `schemaTimeoutMs || 8000`, fed from timing.chunkAnswerMs (a DIFFERENT
// operation's value), silently capped the schema pull at 8 s while the device answered at
// 31-46 s. Nothing declared it, so nobody could see or change it. A rule with no test is a
// rule that gets broken again next week.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const settings = require('../lib/settings');

let pass = 0;
const ok = (c, m) => { assert(c, m); pass++; };

const cfg = settings.load({ config: {} });

// ---- 1. the declarations exist ---------------------------------------------
const REQUIRED_TIMING = [
  'sendSpacingMs', 'replyTimeoutMs', 'chunkAnswerMs',
  'idleMs', 'grabTimeoutMs', 'grabPollMs', 'grabAckMs',
  'pushIdleMs', 'pushActMs', 'pushQuietMs', 'pushPollMs', 'pushDeadlineMs',
  'pushMaxStale', 'pushMaxUnanswered',
  'reconnectMs', 'keepaliveMs', 'silenceCheckMs',
];
for (const k of REQUIRED_TIMING) {
  ok(Number.isFinite(cfg.timing[k]) && cfg.timing[k] > 0, `timing.${k} is declared and positive`);
}
for (const k of ['collectMs', 'burstSpacingMs', 'replyWindowSec', 'replyWindowMinSec',
                 'replyWindowMaxSec', 'burstMin', 'burstMax', 'burstDefault']) {
  ok(Number.isFinite(cfg.align[k]) && cfg.align[k] > 0, `align.${k} is declared and positive`);
}
for (const k of ['ttlMs', 'maxTries', 'maxPending']) {
  ok(Number.isFinite(cfg.butler[k]) && cfg.butler[k] > 0, `butler.${k} is declared and positive`);
}

// ---- 2. the schema has NO timeout, because it is not radio traffic ----------
// The schema* timeouts existed only for the over-air pull, which is gone: the schema is a
// file generated at firmware build time. If these ever come back, someone has reinstated
// a 7-round-trip radio pull for static data.
ok(cfg.timing.schemaAnswerMs === undefined, 'schemaAnswerMs is GONE — the schema is a file, not a pull');
ok(cfg.timing.schemaRetryMs === undefined, 'schemaRetryMs is GONE — nothing to retry');
ok(typeof cfg.schema.file === 'string' && cfg.schema.file.length, 'schema.file is declared in config');

// ---- 3. NO hardcoded timing literals remain in the shipped source -----------
// Scans lib/ + index.js for the two banned shapes:
//   a) `xxxMs = 1234` / `xxxMs: 1234`  — a constant or an object literal default
//   b) `|| 1234` / `!= null ? x : 1234` — an inline fallback
// settings.js is the ONE file allowed to contain them: it IS the declaration.
const ROOT = path.join(__dirname, '..');
const files = [];
for (const f of fs.readdirSync(path.join(ROOT, 'lib'))) if (f.endsWith('.js')) files.push(path.join('lib', f));
files.push('index.js', 'host-module.js');

const ALLOW = new Set(['lib/settings.js']);
const NAME = '[A-Za-z_$][\\w$]*(?:Ms|Sec|MS|Timeout|Interval|Delay|Deadline|Spacing|Window)';
const offenders = [];
for (const rel of files) {
  if (ALLOW.has(rel)) continue;
  const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  src.split('\n').forEach((line, i) => {
    const code = line.replace(/\/\/.*$/, '');            // ignore comments
    if (/^\s*$/.test(code)) return;
    // (a) a named timing thing assigned a bare number >= 100
    if (new RegExp(`${NAME}\\s*[:=]\\s*[0-9]{3,}`).test(code)) offenders.push(`${rel}:${i + 1}: ${line.trim()}`);
    // (b) an inline numeric fallback
    else if (/\|\|\s*[0-9]{3,}/.test(code) || /!=\s*null\s*\?[^:]*:\s*[0-9]{3,}/.test(code)) {
      offenders.push(`${rel}:${i + 1}: ${line.trim()}`);
    }
  });
}
if (offenders.length) {
  console.error('HARDCODED TIMING VALUES FOUND — declare them in settings.js DEFAULTS:');
  offenders.forEach((o) => console.error('  ' + o));
}
ok(offenders.length === 0, `no hardcoded timing literals in lib/ or index.js (found ${offenders.length})`);

// ---- 4. a missing value FAILS LOUDLY rather than degrading silently ---------
// Removing fallbacks means an incomplete config must be an error. For the schema that is
// a missing FILE: serving an empty or partial schema would render a config form missing
// fields, which is the exact class of bug this whole change replaces.
(async () => {
  const { Config } = require('../lib/config');
  let threw = null;
  try { await new Config({ command: async () => ({}), send: async () => ({}) }).schema('!aa'); }
  catch (e) { threw = e; }
  ok(threw && threw.code === 'ECONFIG', 'schema() REFUSES to run without schema.file configured');

  threw = null;
  try { await new Config({ schemaFile: '/nonexistent/schema.json' }).schema('!aa'); }
  catch (e) { threw = e; }
  ok(threw && threw.code === 'ESCHEMAFILE', 'a missing schema file is a clear error, not a silent empty schema');

  console.log(`timeouts OK: ${pass} assertions passed`);
})();

