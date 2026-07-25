// Level-based debugging for @pac/mesh. A single shared logger, no cfg threading:
// every module does `const log = require('./log').log.child('<scope>')` and they
// all share one level. index.connect() will call `log.setLevel(cfg.logLevel)`
// once settings.load lands; until then the level comes from env MTMESH_LOG (name
// or number), defaulting to 'info'.
//
// Logs go to STDERR only — stdout is reserved for CLI data output (`--json` must
// never be polluted). Line format: `<LEVEL> [<scope>] <message>`.
'use strict';
const util = require('util');

const LEVELS = { silent: -1, error: 0, warn: 1, info: 2, debug: 3, trace: 4 };
const NAMES = Object.keys(LEVELS);

// Never throw from a logger — an unknown level degrades to the fallback.
function resolveName(v, fallback) {
  if (v == null) return fallback;
  if (typeof v === 'number') {
    const n = NAMES.find((k) => LEVELS[k] === v);
    return n || fallback;
  }
  const s = String(v).toLowerCase();
  return (s in LEVELS) ? s : fallback;
}

// One shared state object closed over by the root logger and every child.
const state = {
  level: LEVELS[resolveName(process.env.MTMESH_LOG, 'info')],
  out: process.stderr,
  sink: null,          // set by setSink(): the embedding host takes ownership of output
};
const currentName = () => NAMES.find((k) => LEVELS[k] === state.level) || 'info';

function makeLogger(scope) {
  const emit = (method) => (...args) => {
    if (state.level < LEVELS[method]) return;
    const prefix = scope ? `[${scope}] ` : '';
    const msg = util.format(...args);
    // A host that embeds this module owns its own logging; writing straight to
    // process.stderr behind its back is not acceptable in a shared process.
    // setSink() redirects here. A throwing sink must never take down the caller —
    // logging is never worth losing a mesh command over.
    if (state.sink) {
      try { state.sink(method, `${prefix}${msg}`, scope || ''); return; }
      catch { /* fall through to the stream so the line is not simply lost */ }
    }
    state.out.write(`${method.toUpperCase()} ${prefix}${msg}\n`);
  };
  return {
    error: emit('error'),
    warn:  emit('warn'),
    info:  emit('info'),
    debug: emit('debug'),
    trace: emit('trace'),
    // Nested scopes join with ':' — child('a').child('b') => "[a:b]".
    child: (s) => makeLogger(scope ? `${scope}:${s}` : s),
    // Runtime override — affects the root AND every child (shared state).
    setLevel: (v) => { state.level = LEVELS[resolveName(v, currentName())]; return currentName(); },
    isEnabled: (method) => state.level >= LEVELS[method],
    get level() { return currentName(); },
    // Hand output to the embedding host. When this module runs inside the single
    // service, the HOST owns logging — writing to process.stderr behind its back is
    // not acceptable in a shared process.
    //   setSink(fn)     fn(level, message, scope) receives every line
    //   setSink(stream) writes to that stream instead of stderr
    //   setSink(null)   restores the default (stderr)
    // Affects the root AND every child (shared state), like setLevel.
    setSink: (sink) => {
      if (typeof sink === 'function') { state.sink = sink; }
      else if (sink && typeof sink.write === 'function') { state.sink = null; state.out = sink; }
      else { state.sink = null; state.out = process.stderr; }
    },
    // Test hook: redirect output without spawning. Not part of the public API.
    _setOut: (stream) => { state.out = stream; },
  };
}

module.exports = { log: makeLogger(''), LEVELS };
