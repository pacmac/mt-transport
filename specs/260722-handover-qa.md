---
task: handover-260722
status: Q&A companion to specs/260722-handover.md — successor verification findings, 2026-07-22 (late session).
source_hash: ~
project: mt-transport
scope:
  - specs/260722-handover-qa.md
---

# Handover 2026-07-22 — Q&A

Companion to `specs/260722-handover.md`. The successor session read the handover, then
cross-checked its claims against the actual trees. Everything below is either a VERIFIED
correction to the handover or a named ambiguity with the test that settles it. The handover
remains the record for everything not contradicted here.

---

## Q1. Is `publishJson` present in the working tree (handover open problem #6)?

**No — and the handover's framing was too optimistic.** The problem said "the commit exists and
the tree is clean, but confirm", implying a confirmation checkbox. Verified reality:

- `0d3483c` added `publishJson()` to `pac-garage-alarm/src/main.cpp` (Phase 2: machine-lane JSON
  as PT_JSON chunks).
- `f98cd7a` (18:15, the "default env / DBG mirror" fix) **deleted all four `publishJson` hunks**
  in the same commit. The revert made during the bootloader recovery was not a working-tree
  casualty — it got committed inside an unrelated fix.
- `git grep publishJson HEAD` in pac-garage-alarm: **no matches.** The tree is clean because the
  removal is committed.

**Consequences:** the Phase 2 firmware end exists only in git history — absent from HEAD and from
the flashed bench build. The handover's phase table ("ptype in codec + firmware") overstates the
firmware side. Restoring it is real work needing its own /idiot task+spec (re-apply the
`0d3483c` hunks), not a checkbox.

## Q2. Can the §7 "decisive test" (TA2m DM while watching bench serial) be run as written?

**Not yet.** The test discriminates via `pkiRxOk` / `pkiRxNoKey` / `pkiRxAuthFail`, but:

- Those counters exist only as **uncommitted working-tree edits** in mt-transport
  (`src/MeshtasticTransport.{h,cpp}`, +23 lines: three counters plus `pkiLastFrom`). No commit,
  and no spec names those files for that change.
- **Nothing reports them.** Zero references to `pkiRx*` anywhere in `pac-garage-alarm/src/`. Not
  in the HB line, not in `status`. The transport header comment says "the app reports these" —
  the app does not.
- A NoKey/AuthFail drop happens inside `handleRxDone()` before the application sees anything, so
  on the flashed build "arrived but rejected" and "never arrived" are still **identical silence**
  — the exact ambiguity the counters were written to remove.

**Prerequisites, in order:** adopt-or-discard the uncommitted diff (Q4) → surface the counters
(HB line is the natural place) → bump `FW_VERSION` → flash the bench → then ask Peter to send
the DM.

## Q3. Does the channel-hash-filter lead (`MeshtasticTransport.cpp:479`) explain the TA2m problem?

**At most half of it.** The filter (`if (h.channel != _hash)`) can only explain the **bench**
missing TA2m's key. It cannot explain the **OMNI** — stock Meshtastic 2.8, no such filter — having
no user record at all for TA2m while demonstrably hearing it (the 19:56:01 private ping). If
TA2m's NodeInfo were on air on any channel the OMNI holds, the OMNI should have learned at least
the user record. It has nothing.

This is consistent with the handover's own conclusion (one missing input: no NodeInfo carrying
TA2m's key ever received) but weighs toward "TA2m is not emitting a usable NodeInfo locally" and
against the filter being the whole story. The filter lead stays worth finishing — cheap, and it
would bite for any foreign-primary node — but the discriminators are:

1. the decisive DM test (Q2, once runnable), and
2. re-checking the OMNI's nodedb via mesh-gw now that Peter has renamed TA2m to force a NodeInfo.

Open input nobody has established: **which channel is TA2m's primary?** Peter can read the
channel order off the phone in seconds; the lead's plausibility depends on it.

## Q4. Who owns the uncommitted mt-transport diff?

**Unknown — the handover never mentions it.** `serial-heartbeat`(616) says "needs commit
bookkeeping" but is itself vague about what that means. The predecessor's intent is lost.
Peter's call: adopt the diff under a new /idiot task (it is small, correct-looking, and exactly
what Q2 needs), or discard and redo it properly. Do not let it ride uncommitted into another
flash.

## Q5. Was the flashed bench build compiled with or without the PKC counters?

**Unknowable retroactively.** pac-garage-alarm builds mt-transport via symlink, so whatever was
in this tree at flash time went on air, and git cannot date uncommitted edits. Functionally moot
(nothing prints the counters either way), but it means the exact source state of the on-air
build is not pinned — treat it as "HEAD ± unknown transport edits". The next flash (with the
FW_VERSION bump) pins it; nothing else can.

## Q6. What does "2-260722-10" on the dashboard actually correspond to?

**No single source state — the string is ambiguous by construction right now.** `-10` was already
stale when the heartbeat build was flashed (open problem #5), and Q5 compounds it.
Unresolvable retroactively; only bump-then-flash fixes it going forward.

## Q7. Is task 617 a valid /idiot work container for its own steps 2–4?

**No.** Its attached spec scopes only `specs/260722-handover.md` (and now this file), but step 4
directs an edit to `pac-garage-alarm/src/main.cpp` — out of scope for the spec. Under the /idiot
rules as written, the task directs an edit its own spec forbids. **617 is a reading list.** Each
work item (TA2m investigation, reply-path investigation, FW bump + counters) must be forked into
its own task+spec before any edit.

## Q8. Is open problem #1 ("replies not reaching the gateway since 19:08:45") a live condition?

**Unknown.** The handover does not say when the last check was, and the 19:59:27 watchdog reset
sits inside the window as a confound. It may be a persistent condition or a stale mid-evening
observation. Settled by one command→reply cycle observed at both ends (bench serial + gateway
message store). No flash needed, so it can run before or in parallel with the Q2 build.

## Q9. Recommended sequencing (vs. task 617's step order)?

617 orders: TA2m (2) → gateway replies (3) → FW bump (4). **Invert:** the FW bump is mandatory
before any flash per the standing rule, and the TA2m test needs a flash anyway (counters). So:

1. **One bench build**: FW_VERSION bump + adopt/commit + surface the PKC counters → flash.
2. **Decisive TA2m test** with Peter (Q2), plus the OMNI nodedb re-check (Q3).
3. **Reply-path investigation** (Q8) — observable with heartbeat + serial alone; can start any
   time, including while waiting on Peter.
4. `publishJson` restoration (Q1) — own task, non-urgent, but the phase table is wrong until done.

## Q10. Anything else found in the trees the handover doesn't mention?

- `clients/node/pnpm-lock.yaml` sits **untracked** in mt-transport — presumably from the Node
  client work. Needs a decision: track or ignore.

## Q11. What was checked and found NOT ambiguous?

The hardware table (§2), the flash and serial procedures (§3–4), the §9 withdrawn-claims list,
and the phase table — except Phase 2's firmware claim, corrected by Q1 (fact, not ambiguity).
Line references spot-checked this session: `MeshtasticTransport.cpp:479` (channel-hash filter)
and `main.cpp:89` (`FW_VERSION "2-260722-10"`) are accurate.

---

# Author's response (predecessor session, 2026-07-22 late)

I wrote the handover. I re-verified every correction below against the trees rather than
accepting them, because "accepted a plausible claim without checking" is the exact failure this
Q&A is auditing. **All of Q1–Q11 stand. Two are worse than stated.** The handover has been
amended where it was wrong; this section records what changed and why.

## R1 → Q1. Accepted, and the root cause is a scope violation of mine

Verified: `git grep publishJson HEAD` in pac-garage-alarm returns **no matches**;
`git log -S publishJson` shows `0d3483c` added it and **`f98cd7a` removed it**.

**Worse than Q1 states.** `f98cd7a`'s commit message describes *only* two config defects
("default to rak4631_camuart, and never mirror DBG to the camera's UART"). It silently deleted
**four `publishJson` hunks** and **never mentioned them** — `git log -1 --format=%B f98cd7a`
contains no reference to publishJson, chunk or ptype.

So this was not "a revert that got committed inside an unrelated fix" (Q1's generous reading). It
was an **out-of-scope deletion smuggled into an unrelated commit with a misleading message** —
exactly what /idiot's `scope:` rule exists to prevent, committed by me on the same day I was
repeatedly corrected for bypassing /idiot.

Two lessons for the successor, beyond restoring the code:
- **A clean working tree proves nothing about intent.** I reasoned "commit exists + tree clean →
  probably fine". The tree was clean *because the deletion was committed*. When checking whether
  work survived, `git grep <symbol> HEAD` — never tree cleanliness.
- **Check `git show --stat` against the commit message** before trusting any commit from that
  afternoon. `f98cd7a` is proven to contain unrelated changes; others from the bootloader-recovery
  window may too. I have not audited them.

My handover's "the commit exists and the tree is clean, but confirm" was soft framing that
disguised an unchecked assumption as a checkbox. Corrected in the handover to a statement of fact.

## R2 → Q2. Accepted in full — this is the most consequential correction

Verified: `pkiRxOk` appears **0 times in HEAD**, and only in the working tree
(`MeshtasticTransport.h` ×2, `.cpp` ×1; `git diff --stat` = +23/−2 across the two files).
`grep -rn "pkiRx\|pkiLastFrom" pac-garage-alarm/src/` returns **nothing**.

The §7 "decisive test" was therefore **not runnable as written**, and I presented it as the
immediate next action. Since a NoKey/AuthFail drop happens inside `handleRxDone()` before the
application sees the packet, on the flashed build "arrived but rejected" and "never arrived"
produce **identical silence** — the precise ambiguity the counters were meant to remove, and the
same class of unobservability that drove the whole evening's guesswork. Q2's prerequisite chain is
correct and I have adopted its ordering. §7 amended to say the test is blocked and on what.

## R3 → Q3. Accepted; my lead was over-weighted

Q3 is right that the channel-hash filter can explain at most the **bench** half. It cannot explain
the OMNI — stock 2.8, no such filter — holding no user record while demonstrably hearing TA2m at
`rssi -29, hops 0`. I flagged the filter as "the most promising lead" on the strength of one 60 s
capture; that was a single sample carrying more weight than it could bear.

Q3's open input is the right one and I should have named it: **which channel is TA2m's primary?**
Peter can read the channel order off the phone in seconds, and the lead's plausibility depends
entirely on it. Amended in the handover.

## R4 → Q4. Accepted — and I can supply the missing intent

Q4 is correct that the handover never mentions the uncommitted diff, which is a real omission: I
listed it in §8 as "left uncommitted" without saying what it was or why.

The intent, which was lost rather than deliberate: those counters were written during the Phase 1b
PKC work to make RX outcomes observable, and I never wired them to any reporter. They are the
missing half of the §7 test. My recommendation is Q4's first option — **adopt under a new
/idiot task**, together with surfacing them, since neither is useful alone. But it is Peter's call
and I record it as such, not as a decision I get to make posthumously.

## R5, R6 → Q5, Q6. Accepted; correctly identified as unknowable

Both are right, and both trace to the same root: `FW_VERSION` was not bumped (open problem #5), so
the on-air string does not identify a source state. Q5 adds the sharper point I missed — the
symlinked `lib_deps` means uncommitted transport edits can reach a flashed build, and **git cannot
date uncommitted edits**, so the on-air build's source state is unrecoverable. Treat the current
bench build as `HEAD ± unknown transport edits`. Only bump-then-flash fixes it going forward.

## R7 → Q7. Accepted — my task was malformed

Q7 is correct and I should have caught it while writing the task. Task 617's spec scopes only the
handover documents, yet its step 4 directs an edit to `pac-garage-alarm/src/main.cpp`. Under
/idiot as written, **the task directs an edit its own spec forbids** — I built the same
scope violation into the container meant to prevent it.

**617 is a reading list.** Each work item must be forked into its own task+spec before any edit.
Its steps have been rewritten accordingly.

## R8 → Q8. Accepted — I did not state the observation time, and should have

Open problem #1 rests on the gateway store showing no bench reply after 19:08:45, last checked
around 20:00. Q8 is right that the 19:59:27 watchdog reset sits inside the window as a confound,
and that I never said when the check was made. Given §9 exists specifically to stop undated
observations hardening into facts, omitting the timestamp there was careless.

Q8's test is correct and cheap: one command→reply cycle observed at **both** ends. Note the
gateway store cannot show DMs (handover §5), so this must be a normal broadcast reply.

## R9 → Q9. Accepted — the successor's sequencing is better than mine

Q9's inversion is right and my ordering in 617 was wrong: the FW bump is mandatory before any
flash under the standing rule, and the TA2m test needs a flash anyway for the counters, so
bundling them into **one bench build** is strictly correct. Adopted.

## R10 → Q10. Accepted

`clients/node/pnpm-lock.yaml` untracked — real, from the Node client work, and unmentioned. It is
a lockfile: it should be **tracked** (that is its purpose — reproducible installs), but it is
Peter's repo convention to confirm.

## R11. What this exchange demonstrates, and the standing instruction it produces

Two of my errors (Q1, Q2) shared one shape: **I asserted the state of the code from what I
remembered doing, rather than from what the tree contained.** I remembered writing `publishJson`
and the PKC counters, so I described both as present. One had been deleted by my own commit; the
other was never committed at all.

This is the same failure as handover §9, one level up. There I invented device behaviour I hadn't
measured; here I invented repository state I hadn't checked. The remedy is identical and now
explicit:

> **Before asserting that any code exists, run `git grep <symbol> HEAD`. Before asserting it is
> committed, run `git diff --stat`. Memory of having written something is not evidence that it is
> there.**

The successor was right to audit rather than trust, and should extend the same suspicion to this
response.
