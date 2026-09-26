/* Pure roster and per-prize eligibility rules. */
(function (root) {
  'use strict';
  const LW = (root.LW = root.LW || {});
  function parsePeople(text) {
    const seen = new Map();
    const list = [];
    for (const line of text.split(/\r?\n/)) {
      const raw = line.trim();
      const separator = /\s+\|\s+/.exec(raw);
      const name = (separator ? raw.slice(0, separator.index) : raw).replace(/\s+/g, ' ').trim();
      const group = (separator ? raw.slice(separator.index + separator[0].length) : '').replace(/\s+/g, ' ').trim();
      if (!name) continue;
      const identity = group ? `${name} | ${group}` : name;
      const n = (seen.get(identity) || 0) + 1;
      seen.set(identity, n);
      list.push({ name, group, key: n > 1 ? `${identity}#${n}` : identity });
    }
    return list;
  }
  function eligiblePeople(list, records, prize, settings) {
    const policy = prize?.repeatPolicy || 'inherit';
    const allowRepeat = policy === 'allow' || (policy === 'inherit' && settings.allowRepeat);
    const held = allowRepeat ? null : new Set(records.filter((r) => r.status === 'valid' || (r.status === 'void' && !r.returnToPool)).map((r) => r.key));
    return list.filter((p) => (!prize?.eligibleGroup || p.group === prize.eligibleGroup) && (!held || !held.has(p.key)));
  }
  Object.assign(LW, { parsePeople, eligiblePeople });
})(typeof window !== 'undefined' ? window : globalThis);
