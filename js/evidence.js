/* Offline archive inspection shared by the app and the standalone verifier. */
(function (root) {
  'use strict';
  const LW = (root.LW = root.LW || {});
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const hex = (s) => typeof s === 'string' && /^[0-9a-f]{64}$/.test(s);

  async function inspectPackage(blob) {
    const files = await LW.readZip(blob);
    const roots = [...files.keys()].map((name) => name.split('/')[0]);
    if (!roots.length || roots.some((rootName) => rootName !== roots[0])) throw new Error('憑證包必須只有一個根資料夾');
    const prefix = `${roots[0]}/`;
    const readText = async (name) => {
      const file = files.get(prefix + name);
      if (!file || file.size > 8 * 1024 * 1024) throw new Error(`缺少或過大的 ${name}`);
      return decoder.decode(await file.arrayBuffer());
    };
    const audit = JSON.parse(await readText('抽獎紀錄.json'));
    if (audit.format !== 'lucky-wheel-audit/1' || !Array.isArray(audit.draws) || !audit.event || typeof audit.event.sessionId !== 'string') throw new Error('抽獎紀錄格式不正確');
    const lines = (await readText('SHA256SUMS.txt')).trim().split(/\r?\n/).filter(Boolean);
    const sums = new Map();
    for (const line of lines) {
      const match = /^([0-9a-f]{64})  (錄影\/.+)$/.exec(line);
      if (!match || sums.has(match[2])) throw new Error('SHA256SUMS.txt 格式或檔名重複');
      sums.set(match[2], match[1]);
    }
    const errors = [];
    const warnings = [];
    const known = new Set(['中獎名單.csv', '抽獎紀錄.json', '場次狀態.json', 'SHA256SUMS.txt', '驗證說明.txt']);
    for (const name of files.keys()) {
      const relative = name.slice(prefix.length);
      if (!known.has(relative) && !relative.startsWith('錄影/')) errors.push(`憑證包有未知檔案：${relative}`);
    }
    const csv = LW.parseCSV(await readText('中獎名單.csv'));
    if (csv.length !== audit.draws.length + 1) errors.push('中獎名單.csv 的抽次數量與稽核紀錄不符');
    const snapshots = new Map();
    const usedVideos = new Set();
    const ids = new Set();
    for (const [i, draw] of audit.draws.entries()) {
      const tag = `第 ${i + 1} 抽`;
      const csvRow = csv[i + 1];
      const safeCell = (value) => /^[=+\-@\t\r]/.test(String(value)) ? `'${value}` : String(value);
      const statusLabel = { valid: '有效', void: '作廢', aborted: '中斷' }[draw.status];
      if (!csvRow || csvRow[0] !== String(draw.seq) || csvRow[1] !== safeCell(draw.prize) || csvRow[2] !== safeCell(draw.winner) || csvRow[4] !== statusLabel || csvRow[6] !== String(draw.candidateCount) || csvRow[7] !== draw.candidatesSha256 || csvRow[8] !== (draw.video?.file || '') || csvRow[9] !== (draw.video?.sha256 || '') || csvRow[10] !== audit.event.sessionId) errors.push(`${tag}：中獎名單.csv 與稽核紀錄不符`);
      if (!draw || draw.seq !== i + 1 || typeof draw.id !== 'string' || ids.has(draw.id) || !['valid', 'void', 'aborted'].includes(draw.status)) errors.push(`${tag}：抽次、ID 或狀態不正確`);
      if (draw && typeof draw.id === 'string') ids.add(draw.id);
      if (!Array.isArray(draw.candidates)) {
        errors.push(`${tag}：缺少候選名單快照`);
      } else {
        const names = draw.candidates;
        if (names.some((name) => typeof name !== 'string') || draw.candidateCount !== names.length || !Number.isInteger(draw.winnerIndex) || draw.winnerIndex < 0 || draw.winnerIndex >= names.length || names[draw.winnerIndex] !== draw.winner) errors.push(`${tag}：中獎者、位置或人數與候選名單不符`);
        const hash = await LW.sha256Hex(names.join('\n'));
        if (!hex(draw.candidatesSha256) || hash !== draw.candidatesSha256) errors.push(`${tag}：候選名單指紋不符`);
        snapshots.set(draw.id, names);
        if (draw.candidateKeys != null) {
          if (!Array.isArray(draw.candidateKeys) || draw.candidateKeys.length !== names.length || new Set(draw.candidateKeys).size !== names.length || draw.candidateKeys[draw.winnerIndex] !== draw.winnerKey) errors.push(`${tag}：候選識別鍵或中獎者識別鍵不符`);
        }
      }
      if (draw.video && draw.video.file) {
        const path = `錄影/${draw.video.file}`;
        if (draw.video.file.includes('/') || draw.video.file.includes('\\') || usedVideos.has(path) || !hex(draw.video.sha256)) errors.push(`${tag}：錄影檔名或雜湊值不正確`);
        usedVideos.add(path);
        const video = files.get(prefix + path);
        if (!video) warnings.push(`${tag}：錄影未包含在憑證包中，無法還原影片`);
        else {
          if (video.size !== draw.video.bytes) errors.push(`${tag}：錄影大小不符`);
          if (await LW.sha256Hex(video) !== draw.video.sha256 || sums.get(path) !== draw.video.sha256) errors.push(`${tag}：錄影 SHA-256 不符`);
        }
      }
    }
    for (const path of sums.keys()) if (!usedVideos.has(path) || !files.has(prefix + path)) errors.push(`校驗清單有多餘或遺失的檔案：${path}`);
    for (const name of files.keys()) if (name.startsWith(prefix + '錄影/') && !usedVideos.has(name.slice(prefix.length))) errors.push(`憑證包有未列入紀錄的錄影：${name}`);
    let state = null;
    if (files.has(prefix + '場次狀態.json')) {
      const backup = JSON.parse(await readText('場次狀態.json'));
      if (backup.format !== 'lucky-wheel-session/1' || !backup.state || backup.state.v !== 1 || !Array.isArray(backup.state.records) || backup.state.records.length !== audit.draws.length || backup.state.session?.id !== audit.event.sessionId) errors.push('場次備份格式或抽次與稽核紀錄不符');
      else {
        state = backup.state;
        if (!Array.isArray(state.prizes) || typeof state.people !== 'string' || !state.settings || state.prizes.length > 1000 || state.records.length > 100000 || state.people.length > 2000000) errors.push('場次備份內容不完整或超出限制');
        const roster = typeof LW.parsePeople === 'function' && typeof state.people === 'string' ? LW.parsePeople(state.people) : null;
        const peopleByKey = roster ? new Map(roster.map((p) => [p.key, p])) : null;
        if (audit.event.title !== state.title?.trim() || audit.event.sessionCreatedAt !== state.session?.createdAt) errors.push('活動名稱或建立時間與場次備份不符');
        if (roster && (JSON.stringify(roster.map((p) => p.name)) !== JSON.stringify(audit.participants) || JSON.stringify(roster) !== JSON.stringify(audit.participantDetails))) errors.push('場次名單與稽核紀錄中的參加者不符');
        if (!Array.isArray(audit.prizes) || audit.prizes.length !== state.prizes.length || audit.prizes.some((p, i) => {
          const prize = state.prizes[i];
          return p.id !== prize.id || p.name !== (prize.name.trim() || '未命名獎項') || p.quantity !== prize.qty || p.eligibleGroup !== (prize.eligibleGroup || '') || p.repeatPolicy !== (prize.repeatPolicy || 'inherit') || p.drawn !== state.records.filter((r) => r.prizeId === prize.id && r.status === 'valid').length;
        })) errors.push('獎項清單與場次備份不符');
        for (const [i, r] of state.records.entries()) {
          const d = audit.draws[i];
          const video = r.video || { state: 'none' };
          const videoMismatch = video.state === 'ready'
            ? video.file !== d.video?.file || video.mime !== d.video?.mimeType || video.size !== d.video?.bytes || video.durationMs !== d.video?.durationMs || video.sha256 !== d.video?.sha256
            : video.state !== d.video?.state || (video.error || undefined) !== (d.video?.error || undefined);
          const statusMismatch = r.status === 'void'
            ? r.voidReason !== d.void?.reason || r.voidAt !== d.void?.at || !!r.returnToPool !== d.void?.returnedToPool
            : r.status === 'aborted' ? r.abortReason !== d.aborted?.reason : !!d.void || !!d.aborted;
          if (r.id !== d.id || r.seq !== d.seq || r.drawnAt !== d.drawnAt || r.name !== d.winner || r.key !== d.winnerKey || r.index !== d.winnerIndex || r.candidateCount !== d.candidateCount || r.candidatesHash !== d.candidatesSha256 || r.status !== d.status || r.prizeName !== d.prize || JSON.stringify(r.rule || null) !== JSON.stringify(d.eligibility || null) || videoMismatch || statusMismatch) errors.push(`第 ${i + 1} 抽：場次備份與稽核紀錄不符`);
          if (d.candidateKeys && peopleByKey) {
            for (const [n, key] of d.candidateKeys.entries()) {
              const person = peopleByKey.get(key);
              if (!person || person.name !== d.candidates?.[n] || (d.eligibility?.eligibleGroup && person.group !== d.eligibility.eligibleGroup)) { errors.push(`第 ${i + 1} 抽：候選人或組別不在場次名單中`); break; }
            }
            if (r.key !== d.winnerKey || r.rule?.eligibleGroup !== d.eligibility?.eligibleGroup || r.rule?.allowRepeat !== d.eligibility?.allowRepeat) errors.push(`第 ${i + 1} 抽：資格規則與場次備份不符`);
            if (typeof LW.eligiblePeople === 'function' && d.eligibility) {
              const drawnAt = Date.parse(d.drawnAt);
              const past = state.records.slice(0, i).map((previous) => previous.status === 'void' && Date.parse(previous.voidAt) > drawnAt ? { ...previous, status: 'valid' } : previous);
              const expected = LW.eligiblePeople(roster, past, d.eligibility, { allowRepeat: d.eligibility.allowRepeat }).map((p) => p.key);
              if (expected.length !== d.candidateKeys.length || expected.some((key, index) => key !== d.candidateKeys[index])) errors.push(`第 ${i + 1} 抽：實際候選名單與資格規則不符`);
            }
          }
        }
      }
    } else warnings.push('舊版憑證包沒有場次狀態.json，無法還原完整場次');
    return { files, prefix, audit, state, snapshots, errors, warnings };
  }

  LW.inspectPackage = inspectPackage;
})(typeof window !== 'undefined' ? window : globalThis);
