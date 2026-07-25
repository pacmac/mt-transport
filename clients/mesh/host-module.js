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
const { reply, binary } = require('../host');
const { log: rootLog } = require('./lib/log');

// Internal event -> wire name. EXPLICIT ON PURPOSE: internal names are ours to change,
// wire names are a published contract (API.md §5). Renaming an internal event must
// not silently rename something a dashboard is listening for — if the two ever need
// to differ, they differ HERE, visibly, and API.md changes with it.
const WIRE_EVENTS = {
  node:              'node',
  reply:             'reply',
  text:              'text',        // free-form human message (not our JSON protocol)
  detection:         'detection',
  alert:             'alert',
  'image-available': 'image-available',
  image:             'image',
  // Request lifecycle. These were emitted internally and mapped NOWHERE, so a consumer
  // following a command had to poll — while API.md claimed events were watchable. They
  // are on the wire now. `request-sent` is terminal for a text (no receipt is possible);
  // `request-done` means a result actually came back.
  'request-queued':    'request-queued',
  'request-trying':    'request-trying',
  'request-done':      'request-done',
  'request-sent':      'request-sent',
  'request-failed':    'request-failed',
  'request-expired':   'request-expired',
  'request-cancelled': 'request-cancelled',
  // The COMPLETE alignment view-model on every change. The browser renders it and decides
  // nothing — quality, labels, best, trend and bar heights are all computed server-side,
  // so two phones on one session show identical screens.
  align:               'align',
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
        // NB: named replyObj, not `reply` — that would shadow the reply() response
        // helper imported above, which is exactly the kind of trap that bites later.
        ? (replyObj, from) => safe(ctx, wire, { from, reply: replyObj })
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
        // OUR devices only. /nodes below returns the WHOLE mesh (third-party nodes
        // included, deliberately) — this is the list a dashboard builds a device UI
        // from, so it never hardcodes node ids. No device round-trip: safe to poll,
        // and it still lists a declared unit while that unit is asleep.
        ['GET', '/devices', async () => mesh.devices()],
        ['GET', '/nodes', async () => mesh.nodes()],
        ['GET', '/nodes/:target', async ({ params }) => {
          // Resolve FIRST: mesh.node() matches only a full '!id' or num, while callers
          // (and every other route here) accept the 4-hex short form too. Looking up
          // before resolving made /nodes/336b 404 while /mode/336b worked — the same
          // target, two answers.
          const info = await mesh.unitInfo(params.target);
          const node = info && info.id ? await mesh.node(info.id) : null;
          if (!node) return reply(404, { error: 'unknown node', target: params.target });
          return { ...node, ...info };
        }],
        // The outbox: EVERY command and text you sent, with its state and tries. Not just
        // what could not be delivered immediately — a dev command and a text used to
        // leave no record at all. Filterable and paged because it is now the full record.
        ['GET', '/queue', async ({ query }) => mesh.requests({
          unit: query.get('unit') || undefined,
          state: query.get('state') || undefined,
          kind: query.get('kind') || undefined,
          limit: query.get('limit') || undefined,
          offset: query.get('offset') || undefined,
        })],
        ['GET', '/queue/:target', async ({ params, query }) => mesh.requests({
          unit: params.target, state: query.get('state') || undefined,
          limit: query.get('limit') || undefined, offset: query.get('offset') || undefined,
        })],
        ['GET', '/mode/:target', async ({ params }) => mesh.unitInfo(params.target)],

        // ---- commands (mutate a real radio unit) ----------------------------
        // Queued: returns an id immediately; the unit may be asleep and the command
        // lands in its next wake window. Asynchronous by nature — see API.md 6.1.
        ['POST', '/queue', async ({ body }) => {
          if (!need(body, 'unit', 'verb')) return reply(400, { error: 'need {unit, verb, args?, ttlMs?, maxAttempts?}' });
          return mesh.queueCommand(body.unit, body.verb, body.args || [], {
            ttlMs: body.ttlMs, maxAttempts: body.maxAttempts,
          });
        }],
        ['DELETE', '/queue/:id', async ({ params }) => {
          const c = mesh.queueCancel(params.id);
          return c || reply(404, { error: 'not pending / unknown id' });
        }],
        // live/dev routed: dev units answer directly, live units are queued.
        ['POST', '/command', async ({ body }) => {
          if (!need(body, 'unit', 'verb')) return reply(400, { error: 'need {unit, verb, args?, force?}' });
          try {
            return await mesh.dispatch(body.unit, body.verb, body.args || [], {
              force: !!body.force, noReply: body.noReply,
            });
          } catch (e) {
            // ELIVE = refused because the unit is live and this needed dev routing.
            return reply(e && e.code === 'ELIVE' ? 409 : 502, { error: (e && e.message) || String(e), code: e && e.code });
          }
        }],
        ['POST', '/mode', async ({ body }) => {
          if (!body || !body.unit || !['dev', 'live', 'auto'].includes(body.mode))
            return reply(400, { error: 'need {unit, mode: dev|live|auto}' });
          return mesh.setUnitMode(body.unit, body.mode);
        }],

        // ---- free-form text (human chat), NOT a command ----------------------
        // Separate from /command because chat needs explicit channel control: the
        // command path forces channel 0 (PKC DM), which does not decode for a
        // handheld. Default channel is the configured private one.
        // CAUTION: this puts arbitrary text on a SHARED mesh. Address it, and only
        // to nodes that are ours to talk to.
        ['POST', '/text', async ({ body }) => {
          if (!body || typeof body.text !== 'string' || !body.text.length)
            return reply(400, { error: 'need {text, to?, channel?}' });
          try {
            const r = await mesh.sendText(body.text, { to: body.to, channel: body.channel });
            return { sent: true, to: body.to ?? null, channel: body.channel ?? null, result: r ?? null };
          } catch (e) { return reply(502, { error: (e && e.message) || String(e), code: e && e.code }); }
        }],

        // ---- antenna alignment ----------------------------------------------
        // A spot measurement, not a meter: one press fires a BURST of pings ~1.2 s apart
        // and averages them, because a single ping jitters ~0.7 dB at a fixed position.
        // A reply takes ~16 s, so a burst is tens of seconds — the response here returns
        // as soon as the pings are away; watch the `align` event for the result.
        //
        // Everything derived (quality 0-100, band label, colour class, trend, best,
        // gapToBest, bar heights) is computed SERVER-SIDE and pushed complete. A consumer
        // renders the model and computes nothing.
        ['GET', '/align', async () => mesh.alignState()],
        ['POST', '/align/ping', async ({ body }) => {
          if (!body || !body.target) return reply(400, { error: 'need {target, n?}  n = 1..5, default 4' });
          try {
            const r = await mesh.alignPing(body.target, body.n);
            return r.ok ? { ...r, model: mesh.alignState() } : reply(409, r);
          } catch (e) { return reply(502, { error: (e && e.message) || String(e), code: e && e.code }); }
        }],
        ['POST', '/align/stop', async () => ({ ...mesh.alignStop(), model: mesh.alignState() })],
        // The operator's reply-wait period. Server-owned and PERSISTED: a weak node can
        // answer at 18-43 s, longer than a fixed window would allow.
        ['POST', '/align/config', async ({ body }) => {
          if (!body || body.replyWindowSec == null) return reply(400, { error: 'need {replyWindowSec} (5..120)' });
          return mesh.alignConfig({ replyWindowSec: body.replyWindowSec });
        }],

        // ---- config: the device's SELF-DESCRIBING field table -----------------
        // The device publishes its own schema over `sch` pages — id, type, label,
        // default, writability and bounds — so a dashboard builds its config form
        // from the DEVICE rather than from a hardcoded list that silently rots.
        // That is the whole point of exposing it here: a field added in firmware
        // appears in the UI with no dashboard change.
        //
        // Writes go through `set`, which maps each field to its OWN TEXT VERB
        // (lib/config.js `map.writeVerb`). The uniform {type:set} port-260 channel
        // is unreachable over the text-only gateway, so consumers must never try to
        // build that payload themselves — this route is the supported path.
        ['GET', '/schema/:target', async ({ params, query }) => {
          try { return await mesh.getSchema(params.target, { refresh: query.get('refresh') === '1' }); }
          catch (e) { return deviceUnreachable(e, params.target); }
        }],
        ['GET', '/config/:target', async ({ params }) => {
          try { return await mesh.getConfig(params.target); }
          catch (e) { return deviceUnreachable(e, params.target); }
        }],
        ['POST', '/config/:target', async ({ params, body }) => {
          if (!body || typeof body !== 'object' || !Object.keys(body).length)
            return reply(400, { error: 'need a {field: value} patch' });
          try { return await mesh.setConfig(params.target, body); }
          catch (e) { return deviceUnreachable(e, params.target); }
        }],

        // ---- images: metadata on the stream, BYTES over HTTP -----------------
        // These need a LIVE round-trip to the unit, so a sleeping unit cannot answer:
        // it is deaf outside its ~8 s wake window. That is 504 (upstream did not
        // respond in time), never 500 — nothing is broken, the radio is simply asleep.
        // A caller should check GET /mesh/mode/:target ('awake') before asking.
        ['GET', '/images/:target', async ({ params }) => {
          try { return await mesh.listImages(params.target); }
          catch (e) { return deviceUnreachable(e, params.target); }
        }],
        ['GET', '/images/:target/:pid', async ({ params }) => {
          try {
            const buf = await mesh.getImage(params.target, params.pid);
            if (!buf) return reply(404, { error: 'unknown image' });
            return binary(buf, 'image/jpeg');
          } catch (e) { return deviceUnreachable(e, params.target); }
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

// A unit that did not answer is not a server fault. Distinguish it clearly so a
// dashboard can say "asleep / unreachable" instead of showing an error.
function deviceUnreachable(e, target) {
  const msg = (e && e.message) || String(e);
  const timedOut = /timeout|timed out/i.test(msg);
  return reply(timedOut ? 504 : 502, {
    error: timedOut ? 'unit did not answer' : msg,
    target,
    detail: timedOut ? 'the unit is asleep or out of range; it answers only in its wake window' : undefined,
  });
}
