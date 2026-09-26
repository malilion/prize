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

  const NAME_HEADER = /^(姓名|名字|名稱|員工姓名|中文姓名|參加者|name|full ?name)$/i;
  const GROUP_HEADER = /^(組別|組別名稱|部門|單位|group|team|department)$/i;
  function rosterLinesFromRows(rows, isTable = false) {
    const cleaned = rows.map((cells) => cells.map((cell) => String(cell ?? '').trim()))
      .filter((cells) => cells.some(Boolean));
    const header = cleaned[0] || [];
    const nameColumn = isTable || cleaned.length > 1 ? header.findIndex((cell) => NAME_HEADER.test(cell)) : -1;
    const groupColumn = isTable || cleaned.length > 1 ? header.findIndex((cell) => GROUP_HEADER.test(cell)) : -1;
    if (nameColumn >= 0) cleaned.shift();
    return cleaned.map((cells) => {
      if (nameColumn >= 0) {
        const name = (cells[nameColumn] || '').replace(/\s+/g, ' ').trim();
        const group = groupColumn >= 0 ? (cells[groupColumn] || '').replace(/\s+/g, ' ').trim() : '';
        return name ? `${name}${group ? ` | ${group}` : ''}` : '';
      }
      return cells.filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
    }).filter(Boolean);
  }

  Object.assign(LW, { parsePeople, eligiblePeople, rosterLinesFromRows });
})(typeof window !== 'undefined' ? window : globalThis);
