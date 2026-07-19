'use strict';
// Port 260 — the JSON surface: debug telemetry, config broadcasts, adverts.
//
// Parsing is deliberately tolerant. These frames are built with snprintf on a
// device with a fixed reply buffer, so a truncated frame is a real possibility
// and must degrade to "unparseable" rather than throwing into the event loop.

function parse260(buf) {
  let txt;
  try { txt = buf.toString('utf8'); } catch { return null; }
  let obj;
  try { obj = JSON.parse(txt); }
  catch { return { type: 'unparseable', raw: txt }; }
  return obj;
}

// Availability advert — NOT YET EMITTED BY THE FIRMWARE (mt-chunk step 2).
// Shape agreed in specs/mt-chunk.md: "av":[[pid, type, bytes, chunks], ...]
function parseAdverts(obj) {
  if (!obj || !Array.isArray(obj.av)) return [];
  return obj.av
    .filter((a) => Array.isArray(a) && a.length >= 4)
    .map(([pid, ptype, bytes, chunks]) => ({ pid, ptype, bytes, chunks }));
}

module.exports = { parse260, parseAdverts };
