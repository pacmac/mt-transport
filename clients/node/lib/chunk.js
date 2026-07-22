'use strict';
// mt-chunk — Node.js consumer.
//
// The device side is a stateless server that answers "give me chunks 8..15".
// This is the other half: it asks, reassembles, verifies, and writes the file.
// It is a straight port of ChunkClient in ../../src/MtChunk.cpp and MUST stay
// byte-compatible with it — see wire-format notes below.
//
// NO IMAGE CONVERSION HAPPENS HERE. The camera emits JPEG and the chunker moves
// opaque bytes, so reassembly is concatenation plus a CRC check. Anything that
// looks like decoding/encoding would be a bug.
//
// Transport is injected, exactly as on the device side, so this can be tested
// against recorded frames with no radio and no gateway.

const zlib = require('zlib');

// ---- wire constants — keep in step with src/MtChunk.h -----------------------
// 231, not 237. MeshtasticTransport::send() encodes the Data protobuf into a
// 237-byte buffer and the envelope (portnum tag+varint = 3, payload tag+length
// varint = 3) lives in there too. A 237-byte payload overflows pb_encode and
// send() returns false SILENTLY. Found on hardware — the native harness has no
// protobuf envelope and cannot catch it.
const MESH_PAYLOAD_MAX = 231;
const CHUNK_HEADER_LEN = 7;
const CHUNK_DATA_MAX   = MESH_PAYLOAD_MAX - CHUNK_HEADER_LEN; // 224
const PULL_BATCH_MAX   = 16;

const MSG = { CHUNK: 0x01, PULL: 0x02, MANIFEST: 0x03, ERR: 0x04, GETMANIFEST: 0x05, BUSY: 0x06 };
// ptype registry — MUST match mylibs/mt-chunk/src/MtChunk.h PayloadType.
// JSON (4) is v2's ONE generic type for every machine-lane JSON response
// (config, schema, debug, calc, env); the JSON's own `t` field names which one,
// so consumers route on `t`, not on ptype. SCHEMA (1) is superseded by it.
const PT  = { SCHEMA: 1, IMAGE: 2, LOG: 3, JSON: 4 };
const ERR = { GONE: 1, BADRANGE: 2, NOSUCH: 3 };

// Node's zlib.crc32 is IEEE 802.3 reflected — the same value mtchunk::crc32 and
// Python's zlib.crc32 produce. Verified three ways against a real camera frame
// (C8245EBB). Do not substitute another CRC32 variant; several exist.
const crc32 = (buf) => zlib.crc32(buf) >>> 0;

// ---- frame codec ------------------------------------------------------------
// Big-endian throughout, matching put16/put32 on the device.

function decodeFrame(buf) {
  if (!buf || buf.length < 1) return null;
  const type = buf[0];

  if (type === MSG.MANIFEST) {
    if (buf.length < 14) return null;
    return {
      type, pid: buf.readUInt16BE(1), ptype: buf[3],
      bytes: buf.readUInt32BE(4), count: buf.readUInt16BE(8),
      crc: buf.readUInt32BE(10) >>> 0,
    };
  }
  if (type === MSG.CHUNK) {
    if (buf.length < CHUNK_HEADER_LEN) return null;
    return {
      type, pid: buf.readUInt16BE(1), idx: buf.readUInt16BE(3),
      count: buf.readUInt16BE(5), data: buf.subarray(CHUNK_HEADER_LEN),
    };
  }
  if (type === MSG.ERR) {
    if (buf.length < 4) return null;
    return { type, pid: buf.readUInt16BE(1), code: buf[3] };
  }
  if (type === MSG.BUSY) {
    // Device-driven flow control: "not ready — retry this range after N ms."
    // [type][pid:2][retry_after_ms:2]. Kept byte-compatible with MtChunk.h MSG_BUSY.
    if (buf.length < 5) return null;
    return { type, pid: buf.readUInt16BE(1), retryAfterMs: buf.readUInt16BE(3) };
  }
  return { type };
}

function encodePull(pid, first, count) {
  if (count < 1) count = 1;
  if (count > PULL_BATCH_MAX) count = PULL_BATCH_MAX;
  const b = Buffer.alloc(6);
  b[0] = MSG.PULL;
  b.writeUInt16BE(pid, 1);
  b.writeUInt16BE(first, 3);
  b[5] = count;
  return b;
}

function encodeGetManifest(pid) {
  const b = Buffer.alloc(3);
  b[0] = MSG.GETMANIFEST;
  b.writeUInt16BE(pid, 1);
  return b;
}

// ---- client -----------------------------------------------------------------

class ChunkClient {
  /**
   * @param {(frame:Buffer)=>Promise<void>|void} send  transport out
   */
  constructor(send) {
    this.send = send;
    this.reset();
    // Device-driven pacing: when the server answers a pull with MSG_BUSY it sets
    // this to "do not pull again until" (epoch ms). The fetch loop obeys it — the
    // DEVICE owns the pace; the client never guesses channel state (that was the
    // old client-side channel-quiet heuristic, now removed).
    this.busyUntil = 0;
  }

  /** Clear the BUSY latch just before issuing a fresh pull. */
  clearBusy() { this.busyUntil = 0; }

  reset() {
    this.pid = 0;
    this.len = 0;
    this.count = 0;
    this.crc = 0;
    this.ptype = 0;
    this.haveManifest = false;
    this.gone = false;
    this.buf = null;
    this.have = null;   // Set of chunk indices
  }

  get received() { return this.have ? this.have.size : 0; }
  get complete() { return this.haveManifest && this.count > 0 && this.received === this.count; }

  /** Completeness is not correctness — the whole-payload CRC is the assertion. */
  get verified() { return this.complete && crc32(this.buf) === this.crc; }

  get progress() { return this.count ? this.received / this.count : 0; }

  requestManifest(pid) { return this.send(encodeGetManifest(pid)); }

  /**
   * Resume: install a previously-persisted partial buffer and received set.
   * Call ONLY after the manifest has been accepted and its identity confirmed
   * to match the partial (same pid/crc/count/len) — the caller checks that, so
   * that a stale partial for a reused pid can never be blended into a different
   * image. Copies the saved bytes over the freshly-allocated buffer and adopts
   * the received indices; the pull loop then requests only the gaps.
   */
  seed({ buf, have }) {
    if (!this.haveManifest) throw new Error('seed() before manifest');
    if (buf && buf.length === this.buf.length) buf.copy(this.buf);
    for (const i of have) if (i < this.count) this.have.add(i);
  }

  /** Ask for the next contiguous run we lack. Returns false when nothing is outstanding. */
  requestNext(batch = PULL_BATCH_MAX) {
    if (!this.haveManifest || this.gone) return false;
    let first = -1;
    for (let i = 0; i < this.count; i++) {
      if (!this.have.has(i)) { first = i; break; }
    }
    if (first < 0) return false;
    // Contiguous run only: keeps the request at 6 bytes. Scattered requests
    // would need a bitmap, and the extra rounds cost less than that.
    let run = 0;
    for (let i = first; i < this.count && run < batch; i++) {
      if (this.have.has(i)) break;
      run++;
    }
    this.send(encodePull(this.pid, first, run));
    return true;
  }

  /** Feed a received frame. */
  onFrame(raw) {
    const f = decodeFrame(raw);
    if (!f) return;

    if (f.type === MSG.BUSY) {
      // Device-driven flow control: "retry this range after retry_after_ms." Obey
      // it — do not re-pull until then. Guard on pid so a stale BUSY for a
      // different payload can't throttle this fetch.
      if (f.pid === this.pid) this.busyUntil = Date.now() + f.retryAfterMs;
      return;
    }

    if (f.type === MSG.MANIFEST) {
      // A DUPLICATE manifest for the payload we are already fetching must be
      // ignored, not re-applied. Rebroadcasts and re-requests mean manifests
      // arrive repeatedly, and an earlier version reallocated the buffer and
      // cleared the received set every time — so progress reached 22/32 on air
      // and then reset to 0, repeatedly, and the transfer could never finish.
      // The C++ client resets only on a pid CHANGE; this port had diverged.
      if (this.haveManifest && f.pid === this.pid &&
          f.bytes === this.len && f.count === this.count) {
        return; // same payload, same shape — nothing to do
      }
      // A manifest for a DIFFERENT pid means the payload was replaced while we
      // were fetching. Start over rather than blend two payloads.
      this.pid = f.pid;
      this.len = f.bytes;
      this.count = f.count;
      this.crc = f.crc >>> 0;
      this.ptype = f.ptype;
      this.buf = Buffer.alloc(f.bytes);
      this.have = new Set();
      this.haveManifest = true;
      this.gone = false;
      return;
    }

    if (f.type === MSG.CHUNK) {
      if (!this.haveManifest) return;
      // Stale or unsolicited: drop rather than blend.
      if (f.pid !== this.pid || f.count !== this.count || f.idx >= this.count) return;
      const off = f.idx * CHUNK_DATA_MAX;
      if (off + f.data.length > this.buf.length) return;
      f.data.copy(this.buf, off);
      this.have.add(f.idx); // idempotent, so duplicates are harmless
      return;
    }

    if (f.type === MSG.ERR) {
      if (f.code === ERR.GONE) this.gone = true; // stop retrying
      return;
    }
  }
}

module.exports = {
  MESH_PAYLOAD_MAX, CHUNK_HEADER_LEN, CHUNK_DATA_MAX, PULL_BATCH_MAX,
  MSG, PT, ERR, crc32, decodeFrame, encodePull, encodeGetManifest, ChunkClient,
};
