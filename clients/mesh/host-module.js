// @pac/mesh as a host module — the mesh domain mounted at /v1/mesh.
//
// This file is the ONLY place the mesh domain meets the outside world. It owns two
// translations and nothing else:
//   1. internal EventEmitter names -> PUBLISHED wire event names (WIRE_EVENTS below);
//   2. domain method calls -> HTTP routes.
// No mesh mechanics cross this boundary: no ports, frames, channels, queues or
// airtime. Consumers speak nodes / commands / images / config.
//
// The Mesh instance created here is the process-wide SINGLE OWNER of the mesh-gw
// connection, the butler queue and the image store. That is why consumers connect to
// this service instead of importing the module: a second instance would mean two
// butlers delivering to the same radio units.
'use strict';
const { Mesh } = require('./index');
const { log: rootLog } = require('./lib/log');

// Internal event -> wire name. EXPLICIT ON PURPOSE: internal names are ours to change,
// wire names are a published contract (API.md §5). Renaming an internal event must
// not silently rename something a dashboard is listening for — if the two ever need
// to differ, they differ HERE, visibly, and API.md changes with it.
const WIRE_EVENTS = {
  node:              'node',
  reply:             'reply',
  detection:         'detection',
  alert:             'alert',
  'image-available': 'image-available',
  image:             'image',
  // 'error' MUST be subscribed: an unhandled 'error' on an EventEmitter throws, and
  // in a shared host that would take down the recorder too.
  error:             'error',
};

module.exports = {
  name: 'mesh',

  async start(ctx) {
    const cfg = ctx.config || {};

    // The host owns output. Without this the module would write to process.stderr
    // behind the host's back (lib/log.js setSink).
    rootLog.setSink((level, message) => {
      const fn = ctx.log[level] || ctx.log.info;
      fn(message);
    });
    if (cfg.logLevel) rootLog.setLevel(cfg.logLevel);

    // Config is INJECTED, never discovered: under the host, cwd belongs to the host,
    // so file discovery would resolve to the wrong config (see lib/settings.js).
    const mesh = new Mesh({ config: cfg });
    await mesh.connect();

    // Fan the domain events onto the host's single SSE stream. A throwing handler
    // must never break the feed or kill the process.
    const subs = [];
    for (const [internal, wire] of Object.entries(WIRE_EVENTS)) {
      const handler = internal === 'reply'
        ? (reply, from) => safe(ctx, wire, { from, reply })
        : internal === 'error'
          // An Error's .message is non-enumerable and would vanish through a spread.
          ? (err) => safe(ctx, wire, { error: (err && err.message) || String(err) })
          : (payload) => safe(ctx, wire, payload && typeof payload === 'object' ? payload : { value: payload });
      mesh.on(internal, handler);
      subs.push(() => mesh.removeListener(internal, handler));
    }

    // Autonomous image collection — the always-on part of the service.
    const imgStop = mesh.startImageListener ? mesh.startImageListener() : null;

    const need = (b, ...keys) => keys.every((k) => b && b[k] != null && b[k] !== '');

    return {
      routes: [
        // ---- reads ----------------------------------------------------------
        ['GET', '/nodes', async () => mesh.nodes()],
        ['GET', '/nodes/:target', async ({ params }) => {
          const node = await mesh.node(params.target);
          if (!node) return { status: 404, body: { error: 'unknown node' } };
          return { ...node, ...(await mesh.unitInfo(params.target)) };
        }],
        ['GET', '/queue', async () => mesh.queueList()],
        ['GET', '/queue/:target', async ({ params }) => mesh.queueList(params.target)],
        ['GET', '/mode/:target', async ({ params }) => mesh.unitInfo(params.target)],

        // ---- commands (mutate a real radio unit) ----------------------------
        // Queued: returns an id immediately; the unit may be asleep and the command
        // lands in its next wake window. Asynchronous by nature — see API.md 6.1.
        ['POST', '/queue', async ({ body }) => {
          if (!need(body, 'unit', 'verb')) return { status: 400, body: { error: 'need {unit, verb, args?, ttlMs?, maxAttempts?}' } };
          return mesh.queueCommand(body.unit, body.verb, body.args || [], {
            ttlMs: body.ttlMs, maxAttempts: body.maxAttempts,
          });
        }],
        ['DELETE', '/queue/:id', async ({ params }) => {
          const c = mesh.queueCancel(params.id);
          return c || { status: 404, body: { error: 'not pending / unknown id' } };
        }],
        // live/dev routed: dev units answer directly, live units are queued.
        ['POST', '/command', async ({ body }) => {
          if (!need(body, 'unit', 'verb')) return { status: 400, body: { error: 'need {unit, verb, args?, force?}' } };
          try {
            return await mesh.dispatch(body.unit, body.verb, body.args || [], {
              force: !!body.force, noReply: body.noReply,
            });
          } catch (e) {
            // ELIVE = refused because the unit is live and this needed dev routing.
            return { status: e && e.code === 'ELIVE' ? 409 : 502, body: { error: (e && e.message) || String(e), code: e && e.code } };
          }
        }],
        ['POST', '/mode', async ({ body }) => {
          if (!body || !body.unit || !['dev', 'live', 'auto'].includes(body.mode))
            return { status: 400, body: { error: 'need {unit, mode: dev|live|auto}' } };
          return mesh.setUnitMode(body.unit, body.mode);
        }],

        // ---- images: metadata on the stream, BYTES over HTTP -----------------
        ['GET', '/images/:target', async ({ params }) => mesh.listImages(params.target)],
        ['GET', '/images/:target/:pid', async ({ params }) => {
          const buf = await mesh.getImage(params.target, params.pid);
          if (!buf) return { status: 404, body: { error: 'unknown image' } };
          return { raw: buf, contentType: 'image/jpeg' };
        }],
      ],

      async stop() {
        for (const off of subs) { try { off(); } catch { /* already gone */ } }
        if (typeof imgStop === 'function') { try { imgStop(); } catch { /* best effort */ } }
        try { await mesh.close(); } catch (e) { ctx.log.warn('mesh close failed: %s', e && e.message); }
        rootLog.setSink(null);   // hand output back
      },
    };
  },

  WIRE_EVENTS,
};

function safe(ctx, wire, payload) {
  try { ctx.bus.emit(wire, payload); }
  catch (e) { ctx.log.warn('event %s dropped: %s', wire, e && e.message); }
}
