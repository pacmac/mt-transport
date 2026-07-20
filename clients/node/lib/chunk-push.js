'use strict';
// mt-chunk-push — Node.js codec.
//
// The other half of mylibs/mt-chunk-push/src/MtChunkPush.h, and it MUST stay
// byte-identical to it. Both sides carry the same golden vectors
// (test/offline-push.js and mt-chunk-push/test/test_push_codec.cpp) so a
// divergence fails a test rather than a radio transfer.
//
// WHY PUSH. A failing pull transfer's device UART showed every pull it received:
//     CHUNK: pull pid=1 0 x16 sendFails=0
//     CHUNK: pull pid=1 0 x8  sendFails=0
// Both first=0 — the device was never asked for chunk 16, and served perfectly
// when it was asked. The request path was the defect, and pull puts a request on
// the critical path of every batch. Push removes it: the device streams at its
// own rate and this side listens passively.
//
// THIS FILE IS THE WIRE ONLY. The passive receiver lands in a later step; the
// codec is kept separable so it can be proven against the C++ before any radio
// is involved.
//
// NO IMAGE CONVERSION HAPPENS HERE, as in chunk.js — the chunker moves opaque
// bytes and reassembly is concatenation plus a CRC check.

const zlib = require('zlib');

// ---- wire constants — keep in step with MtChunkPush.h -----------------------
// 231, not 237: MeshtasticTransport::send() encodes the Data protobuf into a
// 237-byte buffer and the envelope (portnum tag+varint 3, payload tag+len
// varint 3) lives in there too. A 237-byte payload overflows pb_encode and
// send() returns false SILENTLY. Found on hardware; a harness with no protobuf
// envelope cannot catch it.
const MESH_PAYLOAD_MAX = 231;

// 5, not mt-chunk's 7: a pushed chunk carries no `count`. The manifest arrives
// first and is repeated (MANIFEST_REPEAT_EVERY), so a count in every chunk would
// be 2 bytes of pure redundancy per frame.
const PUSH_CHUNK_HEADER_LEN = 5;
const CHUNK_DATA_MAX = MESH_PAYLOAD_MAX - PUSH_CHUNK_HEADER_LEN; // 226

const REPAIR_HEADER_LEN = 4;
const REPAIR_IDS_MAX = Math.floor((MESH_PAYLOAD_MAX - REPAIR_HEADER_LEN) / 2); // 113

// The manifest is the sole carrier of count+crc and there is deliberately no way
// to request it, so the device re-sends it on this cadence. See MtChunkPush.h.
const MANIFEST_REPEAT_EVERY = 8;

// Wire protocol version — MUST match MtChunkPush.h PUSH_PROTO_VERSION. Bump on
// any change to frame layout or to what a verb answers with. Rides the existing
// `push stat` reply, so checking it costs no extra airtime. See the header for
// the near-miss that motivated it (silent verbs -> a hang, not an error).
const PROTO_VERSION = 1;

// A fresh 0x10 block, clear of mt-chunk's 0x01-0x06. Both ride port 261, so a
// frame from the wrong protocol must be unmistakable rather than silently
// misparsed as a plausible pull.
const MSG = {
  START:      0x10,
  MANIFEST:   0x11,
  CHUNK:      0x12,
  PROGRESS_Q: 0x13,
  PROGRESS:   0x14,
  REPAIR:     0x15,
  COMPLETE:   0x16,
};

const PT = { SCHEMA: 1, IMAGE: 2, LOG: 3 };

// Upload state as reported by the device's status frame (`upst`). UP_PENDING is
// what makes a lost START recoverable — the flag stays set and the next status
// frame re-advertises, so the receiver just asks again.
const UP = { IDLE: 0, PENDING: 1, SENDING: 2, AWAITACK: 3 };

// Node's zlib.crc32 is IEEE 802.3 reflected — the same value mtchunk::crc32 and
// Python's zlib.crc32 produce. Do not substitute another CRC32 variant; several
// exist and they disagree.
const crc32 = (buf) => zlib.crc32(buf) >>> 0;

// ---- encoders ---------------------------------------------------------------
// Big-endian throughout, matching put16/put32 on the device.

function encodeStart(pid) {
  const b = Buffer.allocUnsafe(3);
  b[0] = MSG.START; b.writeUInt16BE(pid, 1);
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

function encodeProgressQ(pid) {
  const b = Buffer.allocUnsafe(3);
  b[0] = MSG.PROGRESS_Q; b.writeUInt16BE(pid, 1);
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

// Rejects rather than truncates an over-long list: a silently shortened repair
// would look like a successful request and then hang waiting for ids that were
// never actually asked for.
function encodeRepair(pid, ids) {
  if (!ids || ids.length === 0 || ids.length > REPAIR_IDS_MAX) return null;
  const b = Buffer.allocUnsafe(REPAIR_HEADER_LEN + ids.length * 2);
  b[0] = MSG.REPAIR;
  b.writeUInt16BE(pid, 1);
  b[3] = ids.length;
  ids.forEach((id, i) => b.writeUInt16BE(id, REPAIR_HEADER_LEN + i * 2));
  return b;
}

function encodeComplete(pid, crc) {
  const b = Buffer.allocUnsafe(7);
  b[0] = MSG.COMPLETE;
  b.writeUInt16BE(pid, 1);
  b.writeUInt32BE(crc >>> 0, 3);
  return b;
}

// ---- decoder ----------------------------------------------------------------
// Returns null for anything malformed, short, or of an unknown type. Never
// returns a partially-populated frame: a short frame decoding to plausible zeros
// is exactly how a transfer ends up waiting on a chunk nobody will send.

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
      // A zero-length body is malformed, not an empty chunk: the sender only
      // ever emits a window it actually read, so 0 bytes means truncation.
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
      // Trust the declared count only if the bytes are actually there.
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
      return null; // unknown type
  }
}

module.exports = {
  PROTO_VERSION,
  MESH_PAYLOAD_MAX, PUSH_CHUNK_HEADER_LEN, CHUNK_DATA_MAX,
  REPAIR_HEADER_LEN, REPAIR_IDS_MAX, MANIFEST_REPEAT_EVERY,
  MSG, PT, UP, crc32,
  encodeStart, encodeManifest, encodeChunk, encodeProgressQ,
  encodeProgress, encodeRepair, encodeComplete,
  decodeFrame,
};
