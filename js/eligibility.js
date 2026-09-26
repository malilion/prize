/* Pure roster and per-prize eligibility rules. */
(function (root) {
  'use strict';
  const LW = (root.LW = root.LW || {});
  function rosterEntries(text) {
    const entries = [];
    for (const line of text.split(/\r?\n/)) {
      const raw = line.trim();
      const separator = /\s+\|\s+/.exec(raw);
      const name = (separator ? raw.slice(0, separator.index) : raw).replace(/\s+/g, ' ').trim();
      const group = (separator ? raw.slice(separator.index + separator[0].length) : '').replace(/\s+/g, ' ').trim();
      if (name) entries.push({ name, group, identity: group ? `${name} | ${group}` : name });
    }
    return entries;
  }
  function parsePeople(text) {
    const entries = rosterEntries(text);
    // Reserve every literal identity before assigning duplicate suffixes. Otherwise a
    // second "甲" could receive the same key as someone actually named "甲#2".
    const identities = new Set(entries.map((entry) => entry.identity));
    const seen = new Map();
    const used = new Set();
    const list = [];
    for (const { name, group, identity } of entries) {
      let n = (seen.get(identity) || 0) + 1;
      let key = identity;
      if (n > 1) {
        while (identities.has(`${identity}#${n}`) || used.has(`${identity}#${n}`)) n++;
        key = `${identity}#${n}`;
      }
      seen.set(identity, n);
      used.add(key);
      list.push({ name, group, key });
    }
    return list;
  }
  function parsePeopleLegacy(text) {
    const seen = new Map();
    return rosterEntries(text).map(({ name, group, identity }) => {
      const n = (seen.get(identity) || 0) + 1;
      seen.set(identity, n);
      return { name, group, key: n > 1 ? `${identity}#${n}` : identity };
    });
  }
  function legacyRosterKeyCollision(text) {
    const used = new Set();
    for (const { key } of parsePeopleLegacy(text)) {
      if (used.has(key)) return true;
      used.add(key);
    }
    return false;
  }
  function rosterIdentifierIssue(list) {
    for (const [index, person] of list.entries()) {
      if (person.name.length > 200) return `名單第 ${index + 1} 位的姓名超過 200 字元`;
      if (person.group.length > 40) return `名單第 ${index + 1} 位的組別超過 40 字元`;
      if (person.key.length > 220) return `名單第 ${index + 1} 位的識別鍵超過 220 字元`;
    }
    return '';
  }
  function ambiguousRosterNames(list) {
    const seen = new Set();
    const ambiguous = new Set();
    for (const person of list) {
      if (seen.has(person.name)) ambiguous.add(person.name);
      else seen.add(person.name);
    }
    return ambiguous;
  }
  function allowsRepeat(prize, settings) {
    const policy = prize?.repeatPolicy || 'inherit';
    return policy === 'allow' || (policy === 'inherit' && !!settings?.allowRepeat);
  }
  function eligiblePeople(list, records, prize, settings, { voidNoReturnExcluded = true } = {}) {
    const allowRepeat = allowsRepeat(prize, settings);
    const held = new Set(records.filter((r) =>
      (!allowRepeat && r.status === 'valid') ||
      (r.status === 'void' && !r.returnToPool && (!allowRepeat || voidNoReturnExcluded))).map((r) => r.key));
    return list.filter((p) => (!prize?.eligibleGroup || p.group === prize.eligibleGroup) && !held.has(p.key));
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

  function drawOrderRisks(list, records, prizes, settings) {
    const available = eligiblePeople(list, records, { repeatPolicy: 'exclude' }, { allowRepeat: false });
    const availableByGroup = new Map();
    for (const person of available) availableByGroup.set(person.group, (availableByGroup.get(person.group) || 0) + 1);
    const drawn = new Map();
    for (const record of records) if (record.status === 'valid') drawn.set(record.prizeId, (drawn.get(record.prizeId) || 0) + 1);
    const upcoming = prizes.map((prize) => ({
      group: prize.eligibleGroup || '',
      count: Math.max(0, prize.qty - (drawn.get(prize.id) || 0)),
      repeat: allowsRepeat(prize, settings),
    }));
    const groupDemands = new Map();
    const lastGroupDraw = new Map();
    let exclusiveRequired = 0;
    let lastExclusiveDraw = -1;
    for (const [index, prize] of upcoming.entries()) {
      if (!prize.count || prize.repeat) continue;
      exclusiveRequired += prize.count;
      lastExclusiveDraw = index;
      if (prize.group) {
        groupDemands.set(prize.group, (groupDemands.get(prize.group) || 0) + prize.count);
        lastGroupDraw.set(prize.group, index);
      }
    }
    // Earlier repeat-allowed prizes can still choose new people; count that worst-case
    // loss of availability without counting people already used by exclusive prizes twice.
    let earlierExclusive = 0;
    let freshRepeatWinners = 0;
    const earlierExclusiveByGroup = new Map();
    const freshRepeatByGroup = new Map();
    const groupExposure = new Map();
    for (const [index, prize] of upcoming.entries()) {
      if (!prize.count) continue;
      if (!prize.repeat) {
        earlierExclusive += prize.count;
        if (prize.group) earlierExclusiveByGroup.set(prize.group, (earlierExclusiveByGroup.get(prize.group) || 0) + prize.count);
      } else if (index < lastExclusiveDraw) {
        const freeOverall = available.length - earlierExclusive - freshRepeatWinners;
        const freeInGroup = prize.group
          ? (availableByGroup.get(prize.group) || 0) - (earlierExclusiveByGroup.get(prize.group) || 0) - (freshRepeatByGroup.get(prize.group) || 0)
          : freeOverall;
        const fresh = Math.max(0, Math.min(prize.count, freeOverall, freeInGroup));
        freshRepeatWinners += fresh;
        if (prize.group) freshRepeatByGroup.set(prize.group, (freshRepeatByGroup.get(prize.group) || 0) + fresh);
      }
      for (const [group, lastIndex] of lastGroupDraw) {
        if (index >= lastIndex || (prize.group && (prize.group !== group || !prize.repeat))) continue;
        const canTake = Math.min(prize.count, availableByGroup.get(group) || 0);
        groupExposure.set(group, (groupExposure.get(group) || 0) + canTake);
      }
    }
    return {
      repeatBeforeExclusive: exclusiveRequired > 0 && available.length >= exclusiveRequired &&
        freshRepeatWinners > available.length - exclusiveRequired,
      groups: [...groupDemands].filter(([group, required]) => {
        const free = availableByGroup.get(group) || 0;
        return free >= required && (groupExposure.get(group) || 0) > free - required;
      }).map(([group]) => group),
    };
  }

  const NAME_HEADER = /^(姓名|名字|名稱|員工姓名|中文姓名|參加者|name|full ?name)$/i;
  const GROUP_HEADER = /^(組別|組別名稱|部門|單位|group|team|department)$/i;
  const ID_HEADER = /^(編號|參加編號|抽獎編號|員工編號|工號|學號|會員編號|識別碼|id|employee ?id|student ?id|member ?id)$/i;
  function rosterImportIsTable(fileName, mimeType, text) {
    const firstLine = text.slice(0, text.search(/\r?\n|$/));
    return /\.(csv|tsv)$/i.test(fileName) || /csv|tab-separated-values/i.test(mimeType) || firstLine.includes('\t');
  }
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

  Object.assign(LW, { parsePeople, parsePeopleLegacy, legacyRosterKeyCollision, rosterIdentifierIssue, ambiguousRosterNames, allowsRepeat, eligiblePeople, exclusiveCapacity, drawOrderRisks, rosterImportIsTable, rosterImportFromRows, rosterLinesFromRows });
})(typeof window !== 'undefined' ? window : globalThis);
