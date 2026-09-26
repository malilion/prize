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
  function allowsRepeat(prize, settings) {
    const policy = prize?.repeatPolicy || 'inherit';
    return policy === 'allow' || (policy === 'inherit' && !!settings?.allowRepeat);
  }
  function eligiblePeople(list, records, prize, settings) {
    const allowRepeat = allowsRepeat(prize, settings);
    const held = allowRepeat ? null : new Set(records.filter((r) => r.status === 'valid' || (r.status === 'void' && !r.returnToPool)).map((r) => r.key));
    return list.filter((p) => (!prize?.eligibleGroup || p.group === prize.eligibleGroup) && (!held || !held.has(p.key)));
  }

  function exclusiveCapacity(list, records, demands) {
    const available = eligiblePeople(list, records, { repeatPolicy: 'exclude' }, { allowRepeat: false });
    const required = demands.reduce((sum, demand) => sum + demand.count, 0);
    const groups = new Map();
    const availableByGroup = new Map();
    for (const person of available) availableByGroup.set(person.group, (availableByGroup.get(person.group) || 0) + 1);
    for (const demand of demands) {
      if (demand.group) groups.set(demand.group, (groups.get(demand.group) || 0) + demand.count);
    }
    return {
      available: available.length,
      required,
      groups: [...groups].map(([group, count]) => ({
        group,
        required: count,
        available: availableByGroup.get(group) || 0,
      })),
    };
  }

  const NAME_HEADER = /^(姓名|名字|名稱|員工姓名|中文姓名|參加者|name|full ?name)$/i;
  const GROUP_HEADER = /^(組別|組別名稱|部門|單位|group|team|department)$/i;
  const ID_HEADER = /^(編號|參加編號|抽獎編號|員工編號|工號|學號|會員編號|識別碼|id|employee ?id|student ?id|member ?id)$/i;
  function rosterImportFromRows(rows, isTable = false) {
    const cleaned = rows.map((cells) => cells.map((cell) => String(cell ?? '').trim()))
      .filter((cells) => cells.some(Boolean));
    const header = cleaned[0] || [];
    const nameColumn = isTable || cleaned.length > 1 ? header.findIndex((cell) => NAME_HEADER.test(cell)) : -1;
    const groupColumn = isTable || cleaned.length > 1 ? header.findIndex((cell) => GROUP_HEADER.test(cell)) : -1;
    const idColumn = nameColumn >= 0 ? header.findIndex((cell) => ID_HEADER.test(cell)) : -1;
    if (nameColumn >= 0) cleaned.shift();
    const lines = cleaned.map((cells) => {
      if (nameColumn >= 0) {
        const name = (cells[nameColumn] || '').replace(/\s+/g, ' ').trim();
        const group = groupColumn >= 0 ? (cells[groupColumn] || '').replace(/\s+/g, ' ').trim() : '';
        const id = idColumn >= 0 ? (cells[idColumn] || '').replace(/\s+/g, ' ').trim() : '';
        return name ? `${id ? `${id} ` : ''}${name}${group ? ` | ${group}` : ''}` : '';
      }
      return cells.filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
    }).filter(Boolean);
    return { lines, hasNameHeader: nameColumn >= 0, hasGroupColumn: groupColumn >= 0 && nameColumn >= 0, hasIdColumn: idColumn >= 0 };
  }

  const rosterLinesFromRows = (rows, isTable = false) => rosterImportFromRows(rows, isTable).lines;

  Object.assign(LW, { parsePeople, allowsRepeat, eligiblePeople, exclusiveCapacity, rosterImportFromRows, rosterLinesFromRows });
})(typeof window !== 'undefined' ? window : globalThis);
