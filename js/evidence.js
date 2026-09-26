/* Offline archive inspection shared by the app and the standalone verifier. */
(function (root) {
  'use strict';
  const LW = (root.LW = root.LW || {});
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const hex = (s) => typeof s === 'string' && /^[0-9a-f]{64}$/.test(s);
  const AUDIT_CSV_HEADER = Object.freeze(['序號', '獎項', '中獎者', '抽出時間（UTC）', '狀態', '備註', '候選人數', '名單指紋（SHA-256）', '錄影檔名', '錄影 SHA-256', '場次代碼']);
  const LEGACY_CSV_HEADER = [...AUDIT_CSV_HEADER];
  LEGACY_CSV_HEADER[3] = '抽出時間';

  function formatVerificationReport({ fileName = '', actualHash = '', expectedHash = '', report = null, error = null, generatedAt = new Date() } = {}) {
    const oneLine = (value) => String(value == null ? '' : value).replace(/[\r\n\t]+/g, ' ').trim();
    const actual = oneLine(actualHash).toLowerCase();
    const expected = oneLine(expectedHash).toLowerCase();
    const hashResult = !expected ? '未提供公開指紋，無法確認 ZIP 是否與活動時公布的檔案相同'
      : !hex(expected) ? '公開指紋格式不正確'
        : !hex(actual) ? 'ZIP 指紋無法計算，未能比對公開值'
          : actual === expected ? '公開指紋相符' : '公開指紋不符';
    const packageResult = error ? '無法完成包內檢查'
      : !report ? '尚未完成包內檢查'
        : report.errors.length ? '包內檢查未通過'
          : report.warnings.length ? '包內資料一致，但有注意事項' : '包內資料一致';
    const lines = [
      '抽獎憑證包驗證報告',
      `產生時間（UTC）：${new Date(generatedAt).toISOString()}`,
      `ZIP 檔名：${oneLine(fileName) || '未提供'}`,
      `ZIP SHA-256：${hex(actual) ? actual : '無法計算'}`,
      `活動時公開的 SHA-256：${expected || '未提供'}`,
      `包內檢查：${packageResult}`,
      `公開指紋比對：${hashResult}`,
    ];
    if (report) {
      lines.push(`活動：${oneLine(report.audit?.event?.title) || '未命名'}`,
        `場次：${oneLine(report.audit?.event?.sessionId) || '未提供'}`,
        `抽次：${report.audit?.draws?.length ?? '未知'}`,
        `錯誤：${report.errors.length} 項`,
        ...report.errors.map((item) => `  - ${oneLine(item)}`),
        `注意事項：${report.warnings.length} 項`,
        ...report.warnings.map((item) => `  - ${oneLine(item)}`));
    }
    if (error) lines.push(`檢查失敗原因：${oneLine(error.message || error)}`);
    lines.push('', '本報告可自行編輯；請保留原始 ZIP 與活動時公開的指紋，供他人獨立覆核。');
    return lines.join('\r\n') + '\r\n';
  }

  async function inspectDrawEvidence(record, snapshot, { allowDuplicateKeys = false } = {}) {
    const errors = [];
    const warnings = [];
    const candidates = snapshot?.candidates;
    const candidateKeys = snapshot?.candidateKeys;
    let actualHash = '';
    if (!snapshot || snapshot.id !== record.id || !Array.isArray(candidates)) {
      errors.push('找不到這一抽的候選名單快照');
      return { errors, warnings, actualHash, candidates: null, candidateKeys: null };
    }
    if (candidates.some((name) => typeof name !== 'string')) errors.push('候選名單含有無效的姓名資料');
    else {
      actualHash = await LW.sha256Hex(candidates.join('\n'));
      if (!hex(record.candidatesHash) || actualHash !== record.candidatesHash) errors.push('候選名單 SHA-256 與抽獎紀錄不符');
    }
    if (record.candidateCount !== candidates.length || !Number.isInteger(record.index) ||
      record.index < 0 || record.index >= candidates.length || candidates[record.index] !== record.name) {
      errors.push('候選人數、中獎位置或姓名與抽獎紀錄不符');
    }
    if (!Array.isArray(candidateKeys) || candidateKeys.length !== candidates.length ||
      candidateKeys.some((key) => typeof key !== 'string' || !key)) {
      errors.push('候選人識別鍵快照缺失或格式不正確');
    } else {
      if (candidateKeys[record.index] !== record.key) errors.push('中獎者識別鍵與候選快照不符');
      if (new Set(candidateKeys).size !== candidateKeys.length) {
        if (allowDuplicateKeys) warnings.push('舊版名單識別鍵有衝突，無法確認同鍵參加者是否被公平區分');
        else errors.push('候選人識別鍵重複，無法確認每人都被獨立抽選');
      }
    }
    return { errors, warnings, actualHash, candidates, candidateKeys };
  }

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
    if (!audit || !['lucky-wheel-audit/1', 'lucky-wheel-audit/2'].includes(audit.format) || !Array.isArray(audit.draws) || audit.draws.length > 100000 || !audit.event || typeof audit.event.sessionId !== 'string') throw new Error('抽獎紀錄格式不正確或抽次過多');
    const backup = files.has(prefix + '場次狀態.json') ? JSON.parse(await readText('場次狀態.json')) : null;
    const oldKeyCollision = backup?.state?.rosterKeyScheme !== 2 && typeof backup?.state?.people === 'string' && backup.state.people.length <= 2000000 &&
      typeof LW.legacyRosterKeyCollision === 'function' && LW.legacyRosterKeyCollision(backup.state.people);
    const lines = (await readText('SHA256SUMS.txt')).trim().split(/\r?\n/).filter(Boolean);
    const sums = new Map();
    for (const line of lines) {
      const match = /^([0-9a-f]{64})  (錄影\/.+)$/.exec(line);
      if (!match || sums.has(match[2])) throw new Error('SHA256SUMS.txt 格式或檔名重複');
      sums.set(match[2], match[1]);
    }
    const errors = [];
    const warnings = [];
    if (oldKeyCollision) warnings.push(audit.draws.length
      ? '舊版場次的參加者識別鍵發生衝突；無法確認同鍵的兩人是否被公平區分，還原後須重設場次才能繼續抽獎'
      : '舊版名單識別鍵發生衝突；場次尚未抽獎，還原後會改用新版識別鍵');
    const known = new Set(['中獎名單.csv', '抽獎紀錄.json', '場次狀態.json', 'SHA256SUMS.txt', '驗證說明.txt']);
    for (const name of files.keys()) {
      const relative = name.slice(prefix.length);
      if (!known.has(relative) && !relative.startsWith('錄影/')) errors.push(`憑證包有未知檔案：${relative}`);
    }
    const csv = LW.parseCSV(await readText('中獎名單.csv'));
    const expectedHeader = audit.format === 'lucky-wheel-audit/2' ? AUDIT_CSV_HEADER : LEGACY_CSV_HEADER;
    if (JSON.stringify(csv[0]) !== JSON.stringify(expectedHeader)) errors.push('中獎名單.csv 的表頭不正確');
    if (csv.length !== audit.draws.length + 1) errors.push('中獎名單.csv 的抽次數量與稽核紀錄不符');
    if (audit.format === 'lucky-wheel-audit/1') warnings.push('舊版憑證包的 CSV 使用未標示時區的本地時間，無法驗證時間欄位');
    const snapshots = new Map();
    const usedVideos = new Set();
    const ids = new Set();
    for (const [i, draw] of audit.draws.entries()) {
      const tag = `第 ${i + 1} 抽`;
      if (!draw || typeof draw !== 'object' || Array.isArray(draw)) throw new Error(`${tag}：抽獎紀錄格式不正確`);
      if (draw.video != null && (typeof draw.video !== 'object' || Array.isArray(draw.video) ||
        (draw.video.file != null && (typeof draw.video.file !== 'string' || !draw.video.file)))) throw new Error(`${tag}：錄影資料格式不正確`);
      if (audit.format === 'lucky-wheel-audit/2' &&
        (!Array.isArray(draw.candidateKeys) || typeof draw.winnerKey !== 'string' || !draw.winnerKey ||
          !draw.eligibility || typeof draw.eligibility !== 'object' || Array.isArray(draw.eligibility) ||
          typeof draw.eligibility.eligibleGroup !== 'string' ||
          !['inherit', 'allow', 'exclude'].includes(draw.eligibility.repeatPolicy) ||
          typeof draw.eligibility.allowRepeat !== 'boolean')) {
        errors.push(`${tag}：缺少候選識別鍵或資格規則，無法驗證候選人資格`);
      }
      const csvRow = csv[i + 1];
      const safeCell = (value) => /^[=+\-@\t\r]/.test(String(value)) ? `'${value}` : String(value);
      const statusLabel = { valid: '有效', void: '作廢', aborted: '中斷' }[draw.status];
      const note = draw.status === 'void'
        ? `${draw.void?.reason || ''}${draw.void?.returnedToPool ? '（已放回名單）' : ''}`
        : draw.status === 'aborted' ? `抽獎中斷：${draw.aborted?.reason || ''}` : '';
      const utc = typeof draw.drawnAt === 'string' && !Number.isNaN(Date.parse(draw.drawnAt))
        ? new Date(draw.drawnAt).toISOString() : null;
      if (!csvRow || csvRow.length !== expectedHeader.length || csvRow[0] !== String(draw.seq) || csvRow[1] !== safeCell(draw.prize) || csvRow[2] !== safeCell(draw.winner) ||
        (audit.format === 'lucky-wheel-audit/2' && csvRow[3] !== utc) || csvRow[4] !== statusLabel || csvRow[5] !== safeCell(note) ||
        csvRow[6] !== String(draw.candidateCount) || csvRow[7] !== draw.candidatesSha256 || csvRow[8] !== (draw.video?.file || '') || csvRow[9] !== (draw.video?.sha256 || '') || csvRow[10] !== audit.event.sessionId) errors.push(`${tag}：中獎名單.csv 與稽核紀錄不符`);
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
          if (!Array.isArray(draw.candidateKeys) || draw.candidateKeys.length !== names.length ||
            draw.candidateKeys.some((key) => typeof key !== 'string' || !key) ||
            (!oldKeyCollision && new Set(draw.candidateKeys).size !== names.length) ||
            draw.candidateKeys[draw.winnerIndex] !== draw.winnerKey) errors.push(`${tag}：候選識別鍵或中獎者識別鍵不符`);
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
      if (!backup || backup.format !== 'lucky-wheel-session/1' || !backup.state || backup.state.v !== 1 || !Array.isArray(backup.state.records) || backup.state.records.length !== audit.draws.length || backup.state.session?.id !== audit.event.sessionId) errors.push('場次備份格式或抽次與稽核紀錄不符');
      else {
        state = backup.state;
        if (typeof state.title !== 'string' || !Array.isArray(state.prizes) || typeof state.people !== 'string' || !state.settings || state.prizes.length > 1000 || state.records.length > 100000 || state.people.length > 2000000 ||
          state.prizes.some((prize) => !prize || typeof prize !== 'object' || typeof prize.id !== 'string' || typeof prize.name !== 'string') ||
          state.records.some((record) => !record || typeof record !== 'object' || typeof record.id !== 'string')) throw new Error('場次備份內容不完整或超出限制');
        const roster = typeof LW.parsePeople === 'function' && typeof state.people === 'string'
          ? oldKeyCollision ? LW.parsePeopleLegacy(state.people) : LW.parsePeople(state.people) : null;
        const peopleByKey = roster && !oldKeyCollision ? new Map(roster.map((p) => [p.key, p])) : null;
        if (audit.event.title !== state.title?.trim() || audit.event.sessionCreatedAt !== state.session?.createdAt) errors.push('活動名稱或建立時間與場次備份不符');
        if (roster && (JSON.stringify(roster.map((p) => p.name)) !== JSON.stringify(audit.participants) || JSON.stringify(roster) !== JSON.stringify(audit.participantDetails))) errors.push('場次名單與稽核紀錄中的參加者不符');
        if (!Array.isArray(audit.prizes) || audit.prizes.length !== state.prizes.length || audit.prizes.some((p, i) => {
          const prize = state.prizes[i];
          const drawn = state.records.filter((r) => r.prizeId === prize.id && r.status === 'valid').length;
          return !p || typeof p !== 'object' || p.id !== prize.id || p.name !== (prize.name.trim() || '未命名獎項') || p.quantity !== prize.qty || p.eligibleGroup !== (prize.eligibleGroup || '') || p.repeatPolicy !== (prize.repeatPolicy || 'inherit') || p.drawn !== drawn || !Number.isInteger(prize.qty) || prize.qty < 1 || prize.qty > 999 || drawn > prize.qty;
        })) errors.push('獎項清單與場次備份不符');
        const prizeIds = new Set(state.prizes.map((prize) => prize.id));
        if (state.records.some((record) => record.status === 'valid' && !prizeIds.has(record.prizeId))) errors.push('有效中獎紀錄指向不存在的獎項');
        for (const [i, r] of state.records.entries()) {
          const d = audit.draws[i];
          if (!d || typeof d !== 'object') throw new Error(`第 ${i + 1} 抽：抽獎紀錄格式不正確`);
          const video = r.video || { state: 'none' };
          const videoMismatch = video.state === 'ready'
            ? video.file !== d.video?.file || video.mime !== d.video?.mimeType || video.size !== d.video?.bytes || video.durationMs !== d.video?.durationMs || video.sha256 !== d.video?.sha256
            : video.state !== d.video?.state || (video.error || undefined) !== (d.video?.error || undefined);
          const statusMismatch = r.status === 'void'
            ? r.voidReason !== d.void?.reason || r.voidAt !== d.void?.at || !!r.returnToPool !== d.void?.returnedToPool
            : r.status === 'aborted' ? r.abortReason !== d.aborted?.reason : !!d.void || !!d.aborted;
          if (r.id !== d.id || r.seq !== d.seq || r.drawnAt !== d.drawnAt || r.name !== d.winner || r.key !== d.winnerKey || r.index !== d.winnerIndex || r.candidateCount !== d.candidateCount || r.candidatesHash !== d.candidatesSha256 || r.status !== d.status || r.prizeName !== d.prize || JSON.stringify(r.rule || null) !== JSON.stringify(d.eligibility || null) || videoMismatch || statusMismatch) errors.push(`第 ${i + 1} 抽：場次備份與稽核紀錄不符`);
          if (Array.isArray(d.candidateKeys) && roster) {
            if (peopleByKey) {
              for (const [n, key] of d.candidateKeys.entries()) {
                const person = peopleByKey.get(key);
                if (!person || person.name !== d.candidates?.[n] || (d.eligibility?.eligibleGroup && person.group !== d.eligibility.eligibleGroup)) { errors.push(`第 ${i + 1} 抽：候選人或組別不在場次名單中`); break; }
              }
            }
            if (r.key !== d.winnerKey || r.rule?.eligibleGroup !== d.eligibility?.eligibleGroup || r.rule?.allowRepeat !== d.eligibility?.allowRepeat) errors.push(`第 ${i + 1} 抽：資格規則與場次備份不符`);
            if (typeof LW.eligiblePeople === 'function' && d.eligibility) {
              const drawnAt = Date.parse(d.drawnAt);
              const past = state.records.slice(0, i).map((previous) => previous.status === 'void' && Date.parse(previous.voidAt) > drawnAt ? { ...previous, status: 'valid' } : previous);
              const expected = LW.eligiblePeople(roster, past, d.eligibility, { allowRepeat: d.eligibility.allowRepeat });
              if (expected.length !== d.candidateKeys.length || expected.some((person, index) => person.key !== d.candidateKeys[index] || person.name !== d.candidates?.[index])) errors.push(`第 ${i + 1} 抽：實際候選名單與資格規則不符`);
            }
          }
        }
      }
    } else if (audit.format === 'lucky-wheel-audit/2') {
      errors.push('新版憑證包缺少場次狀態.json，無法核對完整名單與候選人資格');
    } else warnings.push('舊版憑證包沒有場次狀態.json，無法還原完整場次');
    return { files, prefix, audit, state, snapshots, errors, warnings };
  }

  Object.assign(LW, { inspectPackage, inspectDrawEvidence, formatVerificationReport, AUDIT_CSV_HEADER });
})(typeof window !== 'undefined' ? window : globalThis);
