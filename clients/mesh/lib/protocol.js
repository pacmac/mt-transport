// Wire codec — the ONLY code that knows the private protocol shapes.
// port 260 JSON (telemetry/config/adverts), port 261 chunk/push frames,
// the @<target> <verb> [args] command grammar + reply correlation.
// Pure-ish (encode/decode); no I/O. (Bodies: mesh-transport phase.)
'use strict';
const { ni } = require('./errors');

// --- @command grammar ---
function buildCommand(target, verb, args) { return ni('protocol.buildCommand'); } // -> text
function parseReply(text) { return ni('protocol.parseReply'); }                    // JSON reply -> obj

// --- port 260 JSON ---
function parse260(payloadB64) { return ni('protocol.parse260'); } // -> {type, ...}

// --- port 261 chunk/push frames ---
function decodeFrame(buf) { return ni('protocol.decodeFrame'); }
function encodeStart(pid) { return ni('protocol.encodeStart'); }
function encodeRepair(pid, ids) { return ni('protocol.encodeRepair'); }
function encodeComplete(pid, crc) { return ni('protocol.encodeComplete'); }

// crc32 (IEEE 802.3 reflected; node>=20.12 native). Skeleton.
function crc32(buf) { return ni('protocol.crc32'); }

module.exports = { buildCommand, parseReply, parse260,
                   decodeFrame, encodeStart, encodeRepair, encodeComplete, crc32 };
