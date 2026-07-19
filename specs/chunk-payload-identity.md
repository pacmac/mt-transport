---
task: chunk-payload-identity
status: proposed — awaiting approval, no edits made
source_hash: ~  # set once implementation lands
updated: 2026-07-19
scope:
  - projects/pac-garage-alarm/src/main.cpp        # branch chunk-integration ONLY
  - projects/mt-transport/clients/node/index.js
  - projects/mt-transport/clients/node/lib/commands.js
  - projects/mt-transport/clients/node/test/run.js   # added: cover the new grammar
---

# Spec: chunk-payload-identity — `chunk info` bypasses a pid check that already exists

Forked from `specs/m5-camera-i2c-fix.md` §9, which scoped the defect and
deliberately declined to fix it in that cycle.

---

## 1. The defect, stated precisely

Requesting pid 1 returns pid 2's payload **and reports success**.

Three things combine, and only the first is a real bug:

1. `@<t> chunk info` carries no pid, and calls `sendManifest()` directly.
2. `sendManifest()` describes whatever `_pid` the device currently holds.
3. `ChunkClient` sees an unfamiliar pid in the manifest, resets, and adopts it.

This is the same class as the I2C corruption fixed in the previous cycle, one
layer up: **a wrong answer that looks like a right one.** The offset prefix now
guards the byte stream; nothing guards payload identity.

---

## 2. What investigation changed about the fix

§9 reads as though pid validation needs to be written. **It does not — it already
exists and is already correct.** `mylibs/mt-chunk/src/MtChunk.cpp:118-128`:

```c
if (data[0] == MSG_GETMANIFEST) {
    if (len < 3) return false;
    uint16_t pid = get16(data + 1);
    if ((!_data && !_src) || pid != _pid) {
        sendErr(pid, pid <= _highWater ? ERR_GONE : ERR_NOSUCH);
        return true;
    }
    sendManifest();
    return true;
}
```

It validates the requested pid and even discriminates *evicted* (`ERR_GONE`,
"stop retrying") from *never existed* (`ERR_NOSUCH`) using `_highWater`.

The text handler at `pac-garage-alarm/src/main.cpp:1091` simply **bypasses it**:

```c
if (!strncasecmp(a, "info", 4)) {
    g_chunks.sendManifest();          // <-- straight past the check
```

Four lines below, the `pull` handler does the opposite, and states the rule:

> *"Synthesise the binary PULL and feed the SAME handler a radio pull would hit,
> so the text path cannot drift from the binary one."*

`info` violates the invariant `pull` observes. **The task is therefore to remove
a bypass, not to add validation** — a materially smaller and safer change than
§9 implies, and one that makes the codebase obey its own stated rule.

Why the bypass exists: `info` predates pid being a concern. When one payload
existed, "describe what you hold" and "describe pid N" were the same question.

---

## 3. Change 1 — device (`pac-garage-alarm/src/main.cpp`, branch `chunk-integration`)

Make `info` mirror `pull`: parse an optional pid, synthesise a 3-byte
`GETMANIFEST`, feed `onFrame()`.

```
@<t> chunk info          -> discovery: describe whatever is held  (unchanged)
@<t> chunk info <pid>    -> validated: manifest, or GONE/NOSUCH
```

**Bare `info` deliberately keeps its current meaning.** The Node client uses it
to *discover* the pid at the start of a fetch, before it knows one. Making pid
mandatory would break discovery, and there is no sane pid to send when the whole
point of the call is to learn it.

That leaves a footgun — a caller that *has* a pid but sends bare `info` still
gets a silent substitution. **§4 closes it at the call site**, which is the right
place: the device cannot distinguish "I don't know the pid" from "I forgot to
send it", but the client always knows which it is.

The existing JSON text reply already carries `"pid":%u`, so a text-side caller
can always tell what it was actually given. Keep that.

---

## 4. Change 2 — Node client discovery discipline (`clients/node/index.js`)

- `fetch(pid)` — a caller that already knows the pid — MUST send `info <pid>`.
- Bare `info` is reserved for an explicit "what do you have?" discovery call.

This is what actually eliminates the defect for the client. §3 gives the device
the ability to refuse; this is what makes the client ask a refusable question.

`ERR_GONE` must surface as a failed fetch. It must **not** be retried —
`MtChunk.h:71` is explicit: *"evicted — caller must stop retrying this pid."*

---

## 5. Change 3 — `dedupKey` must carry pid (`clients/node/index.js:140`)

```js
dedupKey: `pull:${frame.readUInt16BE(3)}`      // offset only — pid ignored
```

Two pulls for the *same offset in different payloads* dedup against each other,
so the second is silently dropped.

**This is in scope for sequencing reasons, not tidiness.** It is latent only
while the device holds one payload. §3 and §4 are precisely what make multiple
pids reachable and normal. Landing them without this would **convert a latent
bug into a live one**, wearing the same "wrong answer that looks right"
signature as the defect being fixed. Fix must ship in the same change as trigger.

Key becomes `pull:${pid}:${first}`.

---

## 6. Explicitly NOT in scope

- **`MtChunk.cpp:288` reset-and-adopt.** Once §3 lands, the client only ever
  sees manifests it asked for, so the adopt path is reached legitimately. Its
  comment describes correct behaviour for a payload genuinely replaced mid-fetch.
  Changing it is defence-in-depth against an unpatched device — a real scenario,
  but a different one. Own cycle if wanted.
- **`pac-garage-alarm` main branch.** Stays exactly `deploy-2026-07-19`, which is
  what the field unit runs. All work on `chunk-integration`.
- The three camera-side leftovers (debug logging, stale `M5CameraSource.h:41-45`
  comment, oversized `g_out`) — disjoint files, separate tidy-up.
- `CMD_SETTLE_MS` reduction — a measured change, own cycle.

---

## 7. Verification — what counts as a pass

1. **The defect itself.** Publish a camera payload (evicting the embedded image),
   then ask for the embedded image's pid. Expect `GONE`. A manifest for the
   *other* pid is a fail, and is exactly today's behaviour.
2. **`NOSUCH` vs `GONE` discriminate.** Ask for a pid above `_highWater`; expect
   `NOSUCH`. Both mapping to one code would lose the retry/don't-retry signal.
3. **Discovery still works.** Bare `info` returns the held payload's manifest.
4. **No regression.** A full camera fetch still completes and **CRC-matches**.
   Not "an image arrived" — a CRC match. A wrong-but-plausible reassembly is
   exactly what the CRC exists to catch.
5. `node clients/node/test/run.js` passes, **including a new case covering both
   `chunkInfo` forms**. Scope was amended to include `test/run.js` for this:
   untested new grammar is exactly how the `chunkPull` arity bug survived into
   a commit — the builder gained a parameter, no test asserted the output, and
   the caller was never updated. Not repeating that on the same file in the
   same week.

**Hardware rules for §7:** DEV1 `!8cee336b` on the bench ONLY. The field unit
`!987ab80f` (named `HOME`, physically at the garage) must never be flashed or
tested against. **Channel 2 (`Private`) only — never channel 0.**

Ports (verified 2026-07-19, and the handoff records only the first):
`/dev/ttyACM1` = `239a:8029` RAK upload, renumbers on flash — resolve by USB id.
`/dev/ttyACM0` = `1a86:55d4` RAK debug UART, **stable across reflash**.
`/dev/ttyUSB0` = `0403:6001` M5 FT232 — plugging it resets the ESP32.

---

## 8. Known unknown, not addressed here

`clients/node/test/run.js` logs `(fixture absent, skipped)` — one cross-check
does not run. Given this project's headline claim is "verified byte-for-byte
against the real C++ encoder", that skip should be understood before anyone
leans on it. Recorded, not fixed here.
