// Wire codec — the ONLY code that knows the private protocol shapes.
// port 260 JSON (telemetry/config/adverts), port 261 push frames (0x10-0x16),
// the @<target> <verb> [args] command grammar + reply correlation.
// Pure (encode/decode); no I/O.
//
// Ported byte-for-byte from the proven clients/node/lib (chunk-push.js,
// commands.js, payloads.js). Big-endian throughout, matching put16/put32 on the
// device. This MUST stay in step with mylibs/mt-chunk-push/src/MtChunkPush.h —
// both sides carry the same golden vectors so a divergence fails a test, never a
// radio transfer.
'use strict';
const zlib = require('zlib');
const { MeshError } = require('./errors');

// ---- wire constants — keep in step with MtChunkPush.h -----------------------
// 231, not 237: MeshtasticTransport::send() encodes the Data protobuf into a
// 237-byte buffer and the envelope (portnum + payload tags/varints, 6 B) lives
// there too. A 237-byte payload overflows pb_encode and send() returns false
// SILENTLY. Found on hardware; a harness with no protobuf envelope cannot catch it.
const MESH_PAYLOAD_MAX = 231;

// 5, not mt-chunk's 7: a pushed chunk carries no `count` (the manifest does, and
// is repeated), so a count per chunk would be pure redundancy.
const PUSH_CHUNK_HEADER_LEN = 5;
const CHUNK_DATA_MAX = MESH_PAYLOAD_MAX - PUSH_CHUNK_HEADER_LEN; // 226

const REPAIR_HEADER_LEN = 4;
const REPAIR_IDS_MAX = Math.floor((MESH_PAYLOAD_MAX - REPAIR_HEADER_LEN) / 2); // 113

// The manifest is the sole carrier of count+crc and cannot be requested, so the
// device re-sends it on this cadence.
const MANIFEST_REPEAT_EVERY = 8;

// Wire protocol version — MUST match MtChunkPush.h PUSH_PROTO_VERSION. Bump on any
// change to frame layout or to what a verb answers with.
const PROTO_VERSION = 1;

// A fresh 0x10 block, clear of mt-chunk's pull block 0x01-0x06. Both ride port
// 261, so a frame from the wrong protocol must be unmistakable, never misparsed.
const MSG = {
  START:      0x10,
  MANIFEST:   0x11,
  CHUNK:      0x12,
  PROGRESS_Q: 0x13,
  PROGRESS:   0x14,
  REPAIR:     0x15,
  COMPLETE:   0x16,
};

// ptype registry — MUST match MtChunk.h PayloadType.
const PT = { SCHEMA: 1, IMAGE: 2, LOG: 3, JSON: 4 };

// Upload state as reported by the device's status frame (`upst`).
const UP = { IDLE: 0, PENDING: 1, SENDING: 2, AWAITACK: 3 };

// Node's zlib.crc32 is IEEE 802.3 reflected — the same value mtchunk::crc32 and
// Python's zlib.crc32 produce. Do NOT substitute another CRC32 variant; several
// exist and they disagree silently. Node >= 20.12.
const crc32 = (buf) => zlib.crc32(buf) >>> 0;

// ---- @command grammar (from commands.js) ------------------------------------
// Addressing accepts the 4-hex node suffix, the short name, or "*". Short names
// MUST NOT contain spaces — the device tokenises on the first space to split
// target from verb, so a spaced target breaks addressing entirely.
// Normalize a target to the @-grammar token the firmware matches: the 4-hex node-id
// suffix, a short name, or "*". Strips a leading @/!; a numeric node-num or an 8-hex
// mac is reduced to its last-4-hex suffix. Canonical home of images' former _target
// (shared so the CLI, command() and the push control path address identically).
function resolveAtToken(target) {
  let s = String(target).replace(/^@/, '').replace(/^!/, '');
  if (/^\d+$/.test(s) && s.length > 4) s = (Number(s) >>> 0).toString(16);
  return s.length > 4 ? s.slice(-4) : s;
}

function buildCommand(target, verb, args = []) {
  // Guard the RAW target: a space breaks the firmware's "@<target> <verb>" split.
  // Check before resolveAtToken (which would slice a spaced token to its last 4 chars).
  const raw = String(target).replace(/^@/, '').replace(/^!/, '');
  if (raw !== '*' && /\s/.test(raw)) {
    throw new MeshError(`invalid target ${JSON.stringify(target)}: contains whitespace`, 'EBADTARGET');
  }
  const t = resolveAtToken(target);
  const tail = (args && args.length) ? ' ' + args.join(' ') : '';
  return `@${t} ${verb}${tail}`;
}

// Replies carry no request id, so correlation is positional (see timing.js). A
// reply is a JSON object serialised as text; anything else is not our reply.
function parseReply(text) {
  if (typeof text !== 'string' || !text.startsWith('{')) return null;
  try { return JSON.parse(text); } catch { return null; }
}

// ---- port 260 JSON (from payloads.js) — tolerant ----------------------------
// These frames are built with snprintf on a device with a fixed reply buffer, so
// a truncated frame is real and must degrade to "unparseable" rather than throw
// into the event loop.
function parse260(buf) {
  let txt;
  try { txt = buf.toString('utf8'); } catch { return null; }
  try { return JSON.parse(txt); }
  catch { return { type: 'unparseable', raw: txt }; }
}

// ---- push frame encoders (from chunk-push.js) -------------------------------
// ★ = client-emitted (us). The device-side encoders are included so the codec is
// fully roundtrip-testable offline and stays in parity with the C++.

// ★ START — "begin/re-begin streaming pid". Idempotent; the device restarts its pass.
function encodeStart(pid) {
  const b = Buffer.allocUnsafe(3);
  b[0] = MSG.START; b.writeUInt16BE(pid, 1);
  return b;
}

// ★ PROGRESS_Q — "where did you get to?" (am I waiting, or did I lose the tail?)
function encodeProgressQ(pid) {
  const b = Buffer.allocUnsafe(3);
  b[0] = MSG.PROGRESS_Q; b.writeUInt16BE(pid, 1);
  return b;
}

// ★ REPAIR — ask for exactly these missing ids. Rejects an over-long or empty
// list rather than truncating: a silently shortened repair looks like a
// successful request and then hangs waiting for ids never actually asked for.
function encodeRepair(pid, ids) {
  if (!ids || ids.length === 0 || ids.length > REPAIR_IDS_MAX) return null;
  const b = Buffer.allocUnsafe(REPAIR_HEADER_LEN + ids.length * 2);
  b[0] = MSG.REPAIR;
  b.writeUInt16BE(pid, 1);
  b[3] = ids.length;
  ids.forEach((id, i) => b.writeUInt16BE(id, REPAIR_HEADER_LEN + i * 2));
  return b;
}

// ★ COMPLETE — only WE can assert the whole payload arrived; this releases the
// device's buffer.
function encodeComplete(pid, crc) {
  const b = Buffer.allocUnsafe(7);
  b[0] = MSG.COMPLETE;
  b.writeUInt16BE(pid, 1);
  b.writeUInt32BE(crc >>> 0, 3);
  return b;
}

function encodeManifest(pid, ptype, bytes, count, crc) {
  const b = Buffer.allocUnsafe(14);
  b[0] = MSG.MANIFEST;
  b.writeUInt16BE(pid, 1);
  b[3] = ptype;
  b.writeUInt32BE(bytes >>> 0, 4);
  b.writeUInt16BE(count, 8);
  b.writeUInt32BE(crc >>> 0, 10);
  return b;
}

function encodeChunk(pid, seq, data) {
  if (data.length > CHUNK_DATA_MAX) return null;
  const b = Buffer.allocUnsafe(PUSH_CHUNK_HEADER_LEN + data.length);
  b[0] = MSG.CHUNK;
  b.writeUInt16BE(pid, 1);
  b.writeUInt16BE(seq, 3);
  data.copy(b, PUSH_CHUNK_HEADER_LEN);
  return b;
}

function encodeProgress(pid, cursor, done) {
  const b = Buffer.allocUnsafe(6);
  b[0] = MSG.PROGRESS;
  b.writeUInt16BE(pid, 1);
  b.writeUInt16BE(cursor, 3);
  b[5] = done ? 0x01 : 0x00; // bit 0; remaining bits reserved, must stay 0
  return b;
}

// ---- push frame decoder (from chunk-push.js) --------------------------------
// Returns null for anything malformed, short, or of an unknown type. Never
// returns a partially-populated frame: a short frame decoding to plausible zeros
// is exactly how a transfer ends up waiting on a chunk nobody will send. A byte
// in the pull block 0x01-0x06 is "unknown" here and returns null — pull is out of
// scope for this phase (mesh-images).
function decodeFrame(buf) {
  if (!buf || buf.length < 1) return null;
  const type = buf[0];

  switch (type) {
    case MSG.START:
    case MSG.PROGRESS_Q:
      if (buf.length < 3) return null;
      return { type, pid: buf.readUInt16BE(1) };

    case MSG.MANIFEST:
      if (buf.length < 14) return null;
      return {
        type,
        pid: buf.readUInt16BE(1),
        ptype: buf[3],
        bytes: buf.readUInt32BE(4),
        count: buf.readUInt16BE(8),
        crc: buf.readUInt32BE(10) >>> 0,
      };

    case MSG.CHUNK:
      // A zero-length body is malformed, not an empty chunk: the sender only ever
      // emits a window it actually read, so 0 bytes means truncation.
      if (buf.length <= PUSH_CHUNK_HEADER_LEN) return null;
      if (buf.length - PUSH_CHUNK_HEADER_LEN > CHUNK_DATA_MAX) return null;
      return {
        type,
        pid: buf.readUInt16BE(1),
        seq: buf.readUInt16BE(3),
        data: buf.subarray(PUSH_CHUNK_HEADER_LEN),
      };

    case MSG.PROGRESS:
      if (buf.length < 6) return null;
      return {
        type,
        pid: buf.readUInt16BE(1),
        cursor: buf.readUInt16BE(3),
        // "done" means finished THIS PASS — NOT that the transfer is complete.
        // Only the receiver knows that, and it says so with COMPLETE.
        done: (buf[5] & 0x01) !== 0,
      };

    case MSG.REPAIR: {
      if (buf.length < REPAIR_HEADER_LEN) return null;
      const n = buf[3];
      if (n === 0 || n > REPAIR_IDS_MAX) return null;
      if (buf.length < REPAIR_HEADER_LEN + n * 2) return null;
      const ids = [];
      for (let i = 0; i < n; i++) ids.push(buf.readUInt16BE(REPAIR_HEADER_LEN + i * 2));
      return { type, pid: buf.readUInt16BE(1), ids };
    }

    case MSG.COMPLETE:
      if (buf.length < 7) return null;
      return { type, pid: buf.readUInt16BE(1), crc: buf.readUInt32BE(3) >>> 0 };

    default:
      return null; // unknown type (includes the pull block 0x01-0x06)
  }
}

module.exports = {
  // constants
  MESH_PAYLOAD_MAX, PUSH_CHUNK_HEADER_LEN, CHUNK_DATA_MAX,
  REPAIR_HEADER_LEN, REPAIR_IDS_MAX, MANIFEST_REPEAT_EVERY, PROTO_VERSION,
  MSG, PT, UP,
  // grammar + 260
  buildCommand, resolveAtToken, parseReply, parse260,
  // frame codec
  decodeFrame, encodeStart, encodeProgressQ, encodeRepair, encodeComplete,
  encodeManifest, encodeChunk, encodeProgress,
  crc32,
};
