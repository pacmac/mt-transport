// Target resolver: a user's target token -> { num, atToken }.
//   num     — numeric node id for a directed DM (null => broadcast: '*' or unresolvable)
//   atToken — the @-grammar token for the command text (4-hex suffix / short name / '*')
// `roster` is the gateway node list (array of { id:'!<hex>', num, name }), cached by index.
// Numeric and 8-hex/!mac forms resolve WITHOUT a roster; a 4-hex suffix or short name
// needs the roster to recover the full num (a suffix alone is not the whole id).
'use strict';
const { resolveAtToken } = require('./protocol');

function resolveTarget(target, roster = []) {
  const atToken = resolveAtToken(target);
  const s = String(target).replace(/^@/, '').replace(/^!/, '');
  if (s === '*') return { num: null, atToken: '*' };

  // Direct numeric forms — no roster needed.
  if (/^\d+$/.test(s) && s.length > 4) return { num: (Number(s) >>> 0), atToken };
  if (/^[0-9a-f]{8}$/i.test(s)) return { num: (parseInt(s, 16) >>> 0), atToken };

  // 4-hex suffix or short name — look the full num up in the roster.
  const sl = s.toLowerCase();
  for (const n of roster) {
    if (!n) continue;
    const id = String(n.id || '').replace(/^!/, '').toLowerCase();
    const name = n.name != null ? String(n.name) : '';
    if (id.endsWith(sl) || name === s || name.toLowerCase() === sl) {
      return { num: (n.num != null ? (n.num >>> 0) : null), atToken };
    }
  }
  return { num: null, atToken };
}

module.exports = { resolveTarget };
