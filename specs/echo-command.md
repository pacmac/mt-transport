---
task: echo-command
status: IMPLEMENTED + OBSERVED 2026-07-23 (fw 2-260722-15) — echo round-trip exact on the
        channel path; DM'd commands reply by DM (radio-ACKed), channel commands on-channel.
source_hash: ../pac-garage-alarm/src/main.cpp dd3722830eaa9f98a5cf9d753eb263175982bc7b8fce279de29f6160613dce3e
project: pac-garage-alarm
scope:
  - specs/echo-command.md
  - ../pac-garage-alarm/src/main.cpp
---

# echo — comfort verb for DM round-trip payload testing

## Why
Requested by Peter 2026-07-23 during TA2m DM bring-up: ping proves delivery,
echo proves PAYLOAD INTEGRITY both ways — the reply carries the text the device
actually decoded, so a corrupted/truncated/mis-decrypted command is visible
instead of inferable. Comfort lane: reply goes as an acked PKC DM when the
requester's key is held, broadcast fallback otherwise (same as ping/status).

## Grammar
`@<target> echo <text>` → reply `{"type":"echo","msg":"<text>"}`

- `<text>` = everything after the first space following `echo`, verbatim.
- Bounded by design: the reply is built with jsonBuild + js(), whose 40-byte
  scratch slot quotes, minimally escapes (`"` and `\`) and SILENTLY TRUNCATES
  at ~36 chars (main.cpp:1417-1425). A longer echo text comes back truncated —
  acceptable and documented; the point is round-trip verification, and the
  truncation itself is deterministic. No new buffer, no new escape code.
- Empty text (`@336b echo`) → `{"type":"echo","msg":""}` — legal, still a
  round-trip proof.

## Diff — ../pac-garage-alarm/src/main.cpp (only file)

1. handleCommand, new branch AFTER the "ping" branch (~L1699, before "status"):
```c
    } else if (!strncasecmp(cmd, "echo", 4)) {
        // Round-trip payload test: reply carries the text we actually decoded.
        // js() bounds it to ~36 chars (escaped, truncated) — deterministic cap.
        const char *t = cmd + 4;
        while (*t == ' ') t++;
        const JField f[] = { { "type", js("echo"), JMUST },
                             { "msg",  js(t),      JMUST } };
        jsonBuild(reply, sizeof(reply), f, sizeof(f) / sizeof(f[0]));
```
2. help string (~L2378): `"cmds\":\"ping status env ..."` → insert `echo ` after
   `ping ` → `"ping echo status env ..."`.
3. `FW_VERSION` "2-260722-14" → "2-260722-15" (L89).

## Notes
- `comfort = true` puts it on the PKC-DM + wantAck lane and (via the rev-2
  bootstrap) triggers a key request if the sender's key is missing.
- Two `js()` calls in one packet: the jv scratch ring is 24 slots — no aliasing.
- cmd[] is 64 bytes, so `<text>` arriving at the branch is already ≤ ~58 chars;
  js() then caps the reply at ~36. Both caps are upstream of any buffer risk.

## Change 2 (Peter, refined 2026-07-23): REPLY IN KIND

First cut ("DM everything when key held") was WRONG — Peter's rule is symmetric
and better: a command DM'd to us is answered by DM; a command broadcast on the
channel is answered on the channel. Detection: `rx.to == g_nodeNum` = DM'd.

Diff (handleCommand tail, ~L2400):
- `bool comfort = false;` and both `comfort = true;` assignments — DELETED
  (the ping+status-only comfort freeze is retired; routing now keys on how the
  command arrived, not which verb it is).
- Gate becomes: `wasDm = (rx.to == g_nodeNum && rx.from != BROADCAST)`;
  `if (wasDm && keyFor(rx.from)) sendPki(...) else sendReply(broadcast)`.
- Key bootstrap fires only on `wasDm && !sent` (a channel command wants no DM,
  so no key is needed).
- Stale "Replies go out BROADCAST" comment block rewritten (2.8 legacy-DM
  history retained — it is why the PKC path and the fallback exist).

Consequences: gateway-issued commands (channel broadcasts) return to broadcast
replies — node-dash observes them directly again, as pre-PKI. TA2m DM'd
commands reply as acked PKC DMs. `@*` fan-outs stay on the channel (they are
broadcasts by definition). Out-of-band lanes (port 260/261, reply[0]=0)
untouched.

## Deliberately NOT changed
- schema/`sch` config tables (echo has no config), chunk lanes, docs — the
  help-string drift for other verbs stays with task command-help-sync.

## Verify
1. Static: branch present; help lists echo.
2. Functional: `@336b echo hello world` from TA2m → PKC DM
   `{"type":"echo","msg":"hello world"}`, ACKed; long text (>40 chars) comes
   back truncated at the js() cap; `@336b echo` → `"msg":""`.
3. Regression: ping still answers; `@336b echo x` via gateway (OMNI key) also
   returns the DM.
