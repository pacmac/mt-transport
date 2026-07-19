'use strict';
// The "@<target> <verb> [args]" command surface.
//
// Addressing accepts the 4-hex node suffix, the short name, or "*". The suffix
// derives from FICR and cannot be misconfigured, so it is the safe default —
// a renamed unit still answers to it.
//
// SHORT NAMES MUST NOT CONTAIN SPACES: the device tokenises on the first space
// to split target from verb, so a spaced short name breaks addressing entirely.
// The firmware rejects such names; this mirrors that rather than relying on it.

function target(t) {
  const s = String(t).replace(/^@/, '');
  if (s !== '*' && /\s/.test(s)) throw new Error(`invalid target ${JSON.stringify(t)}: contains whitespace`);
  return s;
}

const cmd = {
  ping:      (t) => `@${target(t)} ping`,
  status:    (t) => `@${target(t)} status`,
  reboot:    (t) => `@${target(t)} reboot`,
  interval:  (t, s) => `@${target(t)} interval ${s | 0}`,
  detect:    (t, s) => `@${target(t)} detect ${s | 0}`,
  name:      (t, n) => `@${target(t)} name ${n}`,
  lname:     (t, n) => `@${target(t)} lname ${n}`,
  // pid is OPTIONAL and the two forms mean different things. Bare `info` is
  // DISCOVERY — "describe whatever you hold" — for a caller that does not yet
  // know a pid. Passing one makes it a VALIDATED query the device will refuse
  // with GONE/NOSUCH rather than silently answering about a different payload.
  // A caller that KNOWS the pid must always pass it; see index.js fetch().
  chunkInfo: (t, pid) => (pid === undefined
    ? `@${target(t)} chunk info`
    : `@${target(t)} chunk info ${pid | 0}`),
  // pid is REQUIRED — without it a pull always fetches whichever payload the
  // device happens to hold, and the device answers GONE once that changes.
  chunkPull: (t, pid, first, count) => `@${target(t)} chunk pull ${pid | 0} ${first | 0} ${count | 0}`,
};

// Commands that are NOT idempotent — never retry these automatically.
const UNSAFE_TO_RETRY = new Set(['reboot', 'name', 'lname', 'interval', 'detect']);

module.exports = { cmd, target, UNSAFE_TO_RETRY };
