/* 抽獎轉盤 — app controller: state, panels, the draw sequence, recording, exports. */
(function () {
  'use strict';
  const { $, $$, esc } = LW;

  const PREROLL_MS = 1000;   // recording starts this long before the wheel moves
  const POSTROLL_MS = 3000;  // …and keeps rolling this long on the result
  const VERSION = 1;
  const DEFAULT_SETTINGS = { spinSeconds: 8, record: true, autoDownload: true, sound: true, allowRepeat: false };
  const SAMPLE = {
    title: '年度尾牙抽獎',
    prizes: [['三獎 咖啡禮券', 5], ['二獎 藍牙耳機', 3], ['頭獎 旅遊住宿券', 1]],
    people: [
      '陳怡君', '林家豪', '張雅婷', '黃冠宇', '李承恩', '王思妤', '吳宗翰', '劉佳穎', '蔡孟哲', '楊子晴',
      '許柏翰', '鄭宇軒', '謝欣妤', '郭品妤', '洪振宇', '曾詩涵', '邱建宏', '廖芷若', '賴俊傑', '周語彤',
      '葉承翰', '蘇怡萱', '莊博文', '呂佩珊', '江宥蓁', '何俊宏', '羅筱涵', '高子傑', '潘雅雯', '簡志豪',
    ].join('\n'),
  };

  /* =================================================================== state */

  const newSession = () => ({ id: LW.sessionCode(), createdAt: new Date().toISOString() });

  function sampleState() {
    return {
      v: VERSION,
      title: SAMPLE.title,
      session: newSession(),
      prizes: SAMPLE.prizes.map(([name, qty]) => ({ id: LW.uid('prize'), name, qty })),
      currentPrizeId: null,
      people: SAMPLE.people,
      records: [],
      settings: { ...DEFAULT_SETTINGS },
      sample: true,
    };
  }

  /* Saved state is re-validated on load: every field that reaches the page, a file name or the
     ZIP gets its expected type back, so a hand-edited localStorage can't smuggle markup or paths. */
  const str = (v, max) => String(v == null ? '' : v).slice(0, max);
  const int = (v, min, max, fallback) => {
    const n = Math.round(Number(v));
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
  };
  const isoOr = (v, fallback) => (typeof v === 'string' && !Number.isNaN(Date.parse(v)) ? v : fallback);
  const sha = (v) => (typeof v === 'string' && /^[0-9a-f]{64}$/.test(v) ? v : '');
  const STATUSES = ['valid', 'void', 'aborted', 'pending'];
  const VIDEO_STATES = ['ready', 'recording', 'failed', 'none'];

  function cleanVideoFile(name) {
    const raw = String(name || '');
    const m = /\.(mp4|webm)$/i.exec(raw);
    return `${LW.safeFilename(m ? raw.slice(0, -m[0].length) : raw, 120)}.${m ? m[1].toLowerCase() : 'mp4'}`;
  }

  function sanitizeState(raw) {
    const now = new Date().toISOString();
    const s = {
      v: VERSION,
      title: str(raw.title, 40),
      session: { id: str(raw.session && raw.session.id, 16) || LW.sessionCode(), createdAt: isoOr(raw.session && raw.session.createdAt, now) },
      prizes: (Array.isArray(raw.prizes) ? raw.prizes : []).map((p) => ({
        id: str(p && p.id, 64) || LW.uid('prize'),
        name: str(p && p.name, 40),
        qty: int(p && p.qty, 1, 999, 1),
      })),
      currentPrizeId: raw.currentPrizeId == null ? null : str(raw.currentPrizeId, 64),
      people: str(raw.people, 2000000),
      records: [],
      settings: { ...DEFAULT_SETTINGS },
      sample: !!raw.sample,
    };
    const set = raw.settings || {};
    s.settings.spinSeconds = int(set.spinSeconds, 3, 15, DEFAULT_SETTINGS.spinSeconds);
    for (const k of ['record', 'autoDownload', 'sound', 'allowRepeat']) {
      if (typeof set[k] === 'boolean') s.settings[k] = set[k];
    }
    for (const r of Array.isArray(raw.records) ? raw.records : []) {
      if (!r || typeof r !== 'object') continue;
      const v = r.video && typeof r.video === 'object' ? r.video : {};
      const video = { state: VIDEO_STATES.includes(v.state) ? v.state : 'none' };
      if (video.state === 'ready') {
        Object.assign(video, {
          file: cleanVideoFile(v.file),
          mime: str(v.mime, 80),
          size: int(v.size, 0, Number.MAX_SAFE_INTEGER, 0),
          sha256: sha(v.sha256),
          durationMs: int(v.durationMs, 0, 36e5, 0),
          downloaded: !!v.downloaded,
        });
      } else if (video.state === 'failed') {
        video.error = str(v.error, 200);
      }
      s.records.push({
        id: str(r.id, 64) || LW.uid('draw'),
        seq: int(r.seq, 1, 1e6, s.records.length + 1),
        prizeId: str(r.prizeId, 64),
        prizeName: str(r.prizeName, 40),
        name: str(r.name, 200),
        key: str(r.key, 220),
        index: int(r.index, 0, 1e7, 0),
        candidateCount: int(r.candidateCount, 0, 1e7, 0),
        candidatesHash: sha(r.candidatesHash),
        drawnAt: isoOr(r.drawnAt, now),
        status: STATUSES.includes(r.status) ? r.status : 'aborted',
        voidReason: r.voidReason == null ? undefined : str(r.voidReason, 60),
        voidAt: r.voidAt == null ? undefined : isoOr(r.voidAt, now),
        returnToPool: !!r.returnToPool,
        abortReason: r.abortReason == null ? undefined : str(r.abortReason, 200),
        video,
      });
    }
    return s;
  }

  function loadState() {
    const saved = LW.Store.load();
    const s = saved && typeof saved === 'object' && saved.v === VERSION ? sanitizeState(saved) : sampleState();
    for (const r of s.records) {
      if (r.status === 'pending') {
        // The page died mid-spin. Keep the pre-drawn result on file so an interrupted draw can't vanish.
        r.status = 'aborted';
        r.abortReason = '抽獎途中頁面被關閉或重新整理';
      }
      if (!r.video || r.video.state === 'recording') {
        r.video = { state: 'failed', error: '頁面在錄影完成前被關閉' };
      }
    }
    return s;
  }

  const state = loadState();
  let phase = 'idle'; // idle → drawing → saving → result → idle
  let zipping = false;
  let clearing = false;
  let saveTimer = 0;
  let storageError = false;

  function persist(now = false) {
    clearTimeout(saveTimer);
    const write = () => {
      const saved = LW.Store.save(state);
      if (!saved && !storageError) {
        toast('無法寫入瀏覽器儲存空間。抽獎已暫停，請先匯出中獎名單，並檢查儲存權限或可用空間。', { tone: 'error', timeout: 0 });
      }
      if (storageError !== !saved) {
        storageError = !saved;
        renderControls();
        renderSettings();
      }
      return saved;
    };
    if (now) return write();
    else saveTimer = setTimeout(write, 250);
  }

  /* ----- derived data ----- */

  let peopleCache = { text: null, list: [] };
  /** One entry per non-empty line. Repeated names get their own key (陳怡君, 陳怡君#2). */
  function people() {
    if (peopleCache.text === state.people) return peopleCache.list;
    const seen = new Map();
    const list = [];
    for (const line of state.people.split(/\r?\n/)) {
      const name = line.replace(/\s+/g, ' ').trim();
      if (!name) continue;
      const n = (seen.get(name) || 0) + 1;
      seen.set(name, n);
      list.push({ name, key: n > 1 ? `${name}#${n}` : name });
    }
    peopleCache = { text: state.people, list };
    return list;
  }

  function duplicateNames() {
    const counts = new Map();
    for (const p of people()) counts.set(p.name, (counts.get(p.name) || 0) + 1);
    return [...counts].filter(([, n]) => n > 1).map(([name, count]) => ({ name, count }));
  }

  /** Who wins something stays out; a voided winner stays out unless they were put back. */
  const holdsPrize = (r) => r.status === 'valid' || (r.status === 'void' && !r.returnToPool);

  function candidates() {
    if (state.settings.allowRepeat) return people();
    const out = new Set(state.records.filter(holdsPrize).map((r) => r.key));
    return people().filter((p) => !out.has(p.key));
  }

  const STATUS_LABEL = { valid: '有效', void: '作廢', aborted: '中斷', pending: '進行中' };

  const prizeById = (id) => state.prizes.find((p) => p.id === id) || null;
  const currentPrize = () => prizeById(state.currentPrizeId);
  const drawnCount = (id) => state.records.reduce((n, r) => n + (r.prizeId === id && r.status === 'valid' ? 1 : 0), 0);
  const remaining = (p) => Math.max(0, p.qty - drawnCount(p.id));
  const prizeLabel = (p) => (p.name || '').trim() || '未命名獎項';
  const allDrawn = () => state.prizes.length > 0 && state.prizes.every((p) => remaining(p) === 0);
  /** Valid winners of a prize, newest first. */
  const winnersOf = (id) => state.records.filter((r) => r.prizeId === id && r.status === 'valid').map((r) => r.name).reverse();
  const busy = () => phase === 'drawing' || phase === 'saving' || zipping || clearing;
  const rosterLocked = () => state.records.length > 0;
  const readyVideos = () => state.records.filter((r) => r.video && r.video.state === 'ready');

  /** Keep "本輪獎項" pointing at something drawable, in list order. */
  function ensureCurrentPrize() {
    const cur = currentPrize();
    if (cur && remaining(cur) > 0) return;
    const next = state.prizes.find((p) => remaining(p) > 0);
    state.currentPrizeId = next ? next.id : cur ? cur.id : state.prizes[0] ? state.prizes[0].id : null;
  }

  function drawBlocker() {
    if (storageError) return '無法保存抽獎紀錄，請檢查瀏覽器的儲存權限或可用空間';
    if (!state.prizes.length) return '先到「獎池」新增獎項';
    if (allDrawn()) return '所有獎項都已抽出';
    const prize = currentPrize();
    if (!prize) return '請選擇本輪獎項';
    if (remaining(prize) === 0) return `「${prizeLabel(prize)}」已經抽完，請改選其他獎項`;
    if (!people().length) return '先到「名單」加入抽獎人員';
    if (!candidates().length) return '名單上已經沒有可以抽的人';
    if (state.settings.record && !LW.Recorder.supported()) {
      return '這個瀏覽器不能錄影：請改用最新版 Chrome、Edge 或 Safari，或到「設定」關閉自動錄影';
    }
    return null;
  }

  /* =================================================================== elements */

  const el = {
    app: $('#app'),
    canvas: $('#stage'),
    spin: $('#spin'),
    spinLabel: $('#spin .btn__label'),
    spinHint: $('#spin-hint'),
    prizeSelect: $('#prize-select'),
    sound: $('#sound-toggle'),
    present: $('#present-toggle'),
    sessionId: $('#session-id'),
    sampleNotice: $('#sample-notice'),
    prizeList: $('#prize-list'),
    prizeSummary: $('#prize-summary'),
    peopleText: $('#people-text'),
    peopleSummary: $('#people-summary'),
    peopleHelp: $('#people-help'),
    dedupe: $('#people-dedupe'),
    optExclude: $('#opt-exclude'),
    records: $('#records'),
    recordsSummary: $('#records-summary'),
    exportCsv: $('#export-csv'),
    exportZip: $('#export-zip'),
    verify: $('#verify-video'),
    optTitle: $('#opt-title'),
    optSpin: $('#opt-spin'),
    optSpinOut: $('#opt-spin-out'),
    optRecord: $('#opt-record'),
    optAutoDl: $('#opt-autodl'),
    optSound: $('#opt-sound'),
    recordSupport: $('#record-support'),
    storageInfo: $('#storage-info'),
    retryStorage: $('#retry-storage'),
    toasts: $('#toasts'),
    announcer: $('#announcer'),
    filePeople: $('#file-people'),
    fileVerify: $('#file-verify'),
    dlgVoid: $('#dlg-void'),
    dlgReset: $('#dlg-reset'),
    dlgVideo: $('#dlg-video'),
    dlgVerify: $('#dlg-verify'),
  };

  const stage = new LW.Stage(el.canvas);
  stage.onTick = () => LW.Sound.tick();
  LW.Sound.setEnabled(state.settings.sound);

  const icon = (name) => `<svg class="icon" aria-hidden="true"><use href="#i-${name}"/></svg>`;

  /* =================================================================== stage sync */

  let fpKey = null;
  let fpValue = '';
  function fingerprintFor(names) {
    const key = names.join('\n');
    if (key !== fpKey) {
      fpKey = key;
      fpValue = '';
      LW.sha256Hex(key).then((hash) => {
        if (fpKey !== key) return;
        fpValue = hash;
        if (phase === 'idle' && key) stage.setView({ fingerprint: hash });
      });
    }
    return fpValue;
  }

  function idleReadout(pool) {
    if (!people().length) return { label: '名單是空的', text: '請在「名單」加入抽獎人員', tone: 'muted' };
    if (allDrawn()) return { label: '抽獎結束', text: '所有獎項都已抽出', tone: 'muted' };
    if (!pool.length) return { label: '沒有可抽的人', text: '名單上的人都已中獎', tone: 'muted' };
    return { label: '指針位置', text: null, tone: 'normal' };
  }

  /** Idle only: during a draw and while a result is on screen, the stage keeps that draw's frozen view. */
  function syncStage() {
    if (phase !== 'idle') return;
    const pool = candidates();
    const names = pool.map((p) => p.name);
    const prize = currentPrize();
    stage.setLabels(names);
    stage.setView({
      title: state.title.trim(),
      drawNo: state.records.length + 1,
      sessionId: state.session.id,
      candidateCount: names.length,
      fingerprint: names.length ? fingerprintFor(names) : '',
      prize: prize ? { name: prizeLabel(prize), total: prize.qty, remaining: remaining(prize) } : null,
      prizeWinners: prize ? winnersOf(prize.id) : [],
      readout: idleReadout(pool),
    });
    el.canvas.setAttribute('aria-label', `抽獎轉盤。${prize ? `本輪獎項：${prizeLabel(prize)}，` : ''}候選 ${names.length} 人。`);
  }

  let syncTimer = 0;
  const syncSoon = () => { clearTimeout(syncTimer); syncTimer = setTimeout(syncStage, 200); };

  function leaveResult() {
    if (phase !== 'result') return;
    phase = 'idle';
    stage.clearResult();
  }

  /* =================================================================== rendering */

  function renderAll() {
    renderControls();
    renderTabs();
    renderPrizes();
    renderPeople();
    renderRecords();
    renderSettings();
    el.sessionId.textContent = state.session.id;
    el.sampleNotice.hidden = !state.sample;
    $$('.lockable').forEach((fs) => { fs.disabled = busy() || (!!fs.closest('#pane-people') && rosterLocked()); });
    $('#sample-clear').disabled = busy();
    $('#reset-open').disabled = busy();
  }

  function renderControls() {
    const isBusy = busy();
    const blocker = isBusy ? null : drawBlocker();
    el.spin.disabled = isBusy || !!blocker;
    el.spin.setAttribute('aria-busy', String(isBusy));
    el.spinLabel.textContent = phase === 'drawing' ? '抽獎中' : phase === 'saving' ? '儲存錄影' : zipping ? '憑證包打包中' : clearing ? '正在清除場次' : '開始抽獎';
    el.spinHint.textContent = blocker ||
      (phase === 'drawing' && state.settings.record ? '錄影中，請不要切換分頁或關閉視窗' :
        phase === 'saving' ? '正在儲存這一抽的錄影…' : zipping ? '請等憑證包打包完成' : clearing ? '請等場次清除完成' : '按空白鍵也能開始');
    el.spinHint.classList.toggle('is-warning', !!blocker);

    el.prizeSelect.innerHTML = state.prizes.length
      ? state.prizes.map((p) => {
        const left = remaining(p);
        return `<option value="${esc(p.id)}"${p.id === state.currentPrizeId ? ' selected' : ''}${left ? '' : ' disabled'}>` +
          `${esc(prizeLabel(p))}（${left ? `剩 ${left}/${p.qty}` : '已抽完'}）</option>`;
      }).join('')
      : '<option value="">尚未設定獎項</option>';
    el.prizeSelect.disabled = isBusy || !state.prizes.length;
  }

  function renderTabs() {
    $('#count-prizes').textContent = state.prizes.length || '';
    $('#count-people').textContent = people().length || '';
    $('#count-records').textContent = state.records.length || '';
  }

  /* ----- prizes ----- */

  function prizeRow(p, i) {
    const drawn = drawnCount(p.id);
    const isCurrent = p.id === state.currentPrizeId && remaining(p) > 0;
    const label = esc(prizeLabel(p));
    return `<li class="prize" data-id="${esc(p.id)}">
      <div class="prize__line">
        <span class="prize__index mono" aria-hidden="true">${i + 1}</span>
        <input class="input prize__name" data-field="name" value="${esc(p.name)}" maxlength="40" autocomplete="off"
          placeholder="例：頭獎 旅遊住宿券" aria-label="第 ${i + 1} 個獎項的名稱">
        <label class="prize__qty">
          <input class="input input--num" data-field="qty" type="number" inputmode="numeric" min="${Math.max(1, drawn)}" max="999"
            value="${p.qty}" aria-label="「${label}」的名額">
          <span aria-hidden="true">名</span>
        </label>
      </div>
      <div class="prize__line prize__meta">
        <span class="prize__status">
          ${isCurrent ? '<span class="chip chip--accent">本輪</span>' : ''}
          ${remaining(p) === 0 ? '<span class="chip chip--quiet">已抽完</span>' : ''}
          <span data-role="progress">已抽 ${drawn} / ${p.qty}</span>
        </span>
        <span class="prize__tools">
          <button class="btn btn--icon btn--sm btn--ghost" type="button" data-act="up" aria-label="把「${label}」往上移"${i === 0 ? ' disabled' : ''}>${icon('up')}</button>
          <button class="btn btn--icon btn--sm btn--ghost" type="button" data-act="down" aria-label="把「${label}」往下移"${i === state.prizes.length - 1 ? ' disabled' : ''}>${icon('down')}</button>
          <button class="btn btn--icon btn--sm btn--ghost" type="button" data-act="del" aria-label="刪除「${label}」"${drawn ? ' disabled title="已經抽出過的獎項不能刪除，可以改名額"' : ''}>${icon('trash')}</button>
        </span>
      </div>
      <p class="field__error" data-role="error"></p>
    </li>`;
  }

  function renderPrizes() {
    el.prizeList.innerHTML = state.prizes.map(prizeRow).join('');
    renderPrizeSummary();
  }

  function renderPrizeSummary() {
    const slots = state.prizes.reduce((n, p) => n + p.qty, 0);
    const drawn = state.records.filter((r) => r.status === 'valid').length;
    el.prizeSummary.textContent = state.prizes.length
      ? `${state.prizes.length} 項・${slots} 個名額・已抽出 ${drawn}`
      : '還沒有獎項';
  }

  /* ----- people ----- */

  function renderPeople() {
    if (document.activeElement !== el.peopleText && el.peopleText.value !== state.people) {
      el.peopleText.value = state.people;
    }
    el.optExclude.checked = !state.settings.allowRepeat;
    renderPeopleMeta();
  }

  function renderPeopleMeta() {
    const all = people();
    const pool = candidates();
    const dups = duplicateNames();
    el.peopleSummary.textContent = all.length ? `共 ${all.length} 人・可抽 ${pool.length} 人` : '名單是空的';
    if (dups.length) {
      const sample = dups.slice(0, 3).map((d) => `${d.name}×${d.count}`).join('、');
      el.peopleHelp.textContent = `有 ${dups.length} 個名字重複（${sample}${dups.length > 3 ? '…' : ''}），重複的名字會各自參加抽獎。`;
    } else {
      el.peopleHelp.textContent = '可以加上編號或部門，例如「A001 陳怡君」。';
    }
    el.peopleHelp.classList.toggle('is-warning', dups.length > 0);
    el.dedupe.hidden = !dups.length;
    $('#people-lock-note').hidden = !rosterLocked();
  }

  function setPeople(text) {
    if (busy() || rosterLocked()) return;
    state.people = text;
    el.peopleText.value = text;
    state.sample = false;
    persist();
    renderAll();
    syncStage();
  }

  /* ----- records ----- */

  function recordItem(r) {
    if (r.status === 'pending') {
      // Never show the pre-drawn name while the wheel is still turning.
      return `<li class="record">
        <div class="record__head">
          <span class="record__seq mono">#${LW.pad(r.seq, 3)}</span>
          <span class="record__prize">${esc(r.prizeName)}</span>
        </div>
        <p class="record__name"><span class="record__who">抽獎進行中…</span></p>
      </li>`;
    }
    const v = r.video || { state: 'none' };
    let video;
    if (v.state === 'ready') {
      video = `<p class="record__video">
        <span>錄影 ${(v.durationMs / 1000).toFixed(1)} 秒・${LW.formatBytes(v.size)}${v.downloaded ? '・已下載' : ''}</span>
        <span class="record__hash mono" title="SHA-256：${esc(v.sha256)}">SHA-256 ${esc(LW.shortHash(v.sha256))}</span>
      </p>`;
    } else if (v.state === 'recording') {
      video = '<p class="record__video">錄影處理中…</p>';
    } else if (v.state === 'failed') {
      video = `<p class="record__video is-error">錄影失敗：${esc(v.error || '原因不明')}</p>`;
    } else {
      video = '<p class="record__video">這一抽沒有錄影</p>';
    }
    const actions = [];
    if (v.state === 'ready') {
      actions.push(`<button class="btn btn--sm" type="button" data-act="play" data-id="${esc(r.id)}">${icon('play')}播放</button>`);
      actions.push(`<button class="btn btn--sm" type="button" data-act="save" data-id="${esc(r.id)}">${icon('download')}下載錄影</button>`);
    }
    if (r.status === 'valid') {
      actions.push(`<button class="btn btn--sm btn--ghost" type="button" data-act="void" data-id="${esc(r.id)}"${busy() ? ' disabled' : ''}>作廢</button>`);
    }
    let badge = '';
    if (r.status === 'void') {
      badge = `<span class="badge badge--void">作廢・${esc(r.voidReason || '未註明')}${r.returnToPool ? '・已放回名單' : ''}</span>`;
    } else if (r.status === 'aborted') {
      badge = `<span class="badge badge--void" title="中斷時已抽定的結果，保留作為紀錄">中斷・${esc(r.abortReason || '原因不明')}</span>`;
    }
    return `<li class="record${r.status === 'valid' ? '' : ' is-void'}">
      <div class="record__head">
        <span class="record__seq mono">#${LW.pad(r.seq, 3)}</span>
        <span class="record__prize">${esc(r.prizeName)}</span>
        <time class="record__time" datetime="${esc(r.drawnAt)}" title="${esc(LW.formatDateTime(r.drawnAt))}">${LW.formatTime(r.drawnAt)}</time>
      </div>
      <p class="record__name"><span class="record__who">${esc(r.name)}</span>${badge}</p>
      ${video}
      ${actions.length ? `<div class="record__actions">${actions.join('')}</div>` : ''}
    </li>`;
  }

  function renderRecords() {
    el.records.innerHTML = state.records.length
      ? state.records.slice().reverse().map(recordItem).join('')
      : `<li class="empty">
          <p class="empty__title">還沒有中獎紀錄</p>
          <p>按下「開始抽獎」後，每一抽的結果和錄影都會出現在這裡，可以播放、下載或作廢。</p>
        </li>`;
    const count = (status) => state.records.filter((r) => r.status === status).length;
    const [valid, voided, aborted] = [count('valid'), count('void'), count('aborted')];
    el.recordsSummary.textContent = state.records.length
      ? `${state.records.length} 抽・有效 ${valid}${voided ? `・作廢 ${voided}` : ''}${aborted ? `・中斷 ${aborted}` : ''}`
      : '尚無紀錄';
    el.exportCsv.disabled = !state.records.length;
    el.exportZip.disabled = !state.records.length || busy() || zipping;
    el.verify.disabled = !readyVideos().length;
  }

  /* ----- settings ----- */

  function setValue(input, value) {
    if (document.activeElement !== input && input.value !== String(value)) input.value = value;
  }

  function renderSettings() {
    const s = state.settings;
    setValue(el.optTitle, state.title);
    setValue(el.optSpin, s.spinSeconds);
    el.optSpinOut.textContent = `${s.spinSeconds} 秒`;
    el.optRecord.checked = s.record;
    el.optAutoDl.checked = s.autoDownload;
    el.optAutoDl.disabled = !s.record;
    el.optSound.checked = s.sound;
    renderSoundToggle();

    const format = LW.Recorder.describe();
    el.recordSupport.textContent = format
      ? `錄影格式：${format}・1920×1080・30 fps。錄下的就是轉盤畫面（含音效），從開始前 1 秒錄到結果後 3 秒。`
      : '這個瀏覽器不支援錄影，請改用最新版 Chrome、Edge 或 Safari。';
    el.recordSupport.classList.toggle('is-warning', !format);
    el.retryStorage.hidden = !storageError;
    renderStorageInfo();
  }

  let vaultChecked = false;
  function renderStorageInfo() {
    const videos = readyVideos();
    const bytes = videos.reduce((n, r) => n + (r.video.size || 0), 0);
    const pending = videos.filter((r) => !r.video.downloaded).length;
    if (!vaultChecked) {
      el.storageInfo.textContent = '';
      return;
    }
    if (!LW.Vault.durable) {
      el.storageInfo.textContent = '這個瀏覽器無法長期保存候選名單快照與錄影，重新整理後就會消失。請保持自動下載錄影開啟，並在每抽後匯出憑證包。';
      el.storageInfo.classList.add('is-warning');
      return;
    }
    el.storageInfo.classList.toggle('is-warning', pending > 0);
    el.storageInfo.textContent = videos.length
      ? `這台電腦的瀏覽器裡存有 ${videos.length} 段錄影（${LW.formatBytes(bytes)}）${pending ? `，其中 ${pending} 段還沒下載` : '，都已下載'}。`
      : '錄影會同時存在這台電腦的瀏覽器裡，重新整理也不會消失。';
  }

  function renderSoundToggle() {
    const on = state.settings.sound;
    el.sound.setAttribute('aria-pressed', String(on));
    el.sound.title = on ? '音效：開（會一起錄進影片）' : '音效：關';
    el.sound.querySelector('use').setAttribute('href', on ? '#i-sound' : '#i-mute');
  }

  /* =================================================================== feedback */

  function toast(message, { tone = 'info', action = null, timeout = 5000 } = {}) {
    const node = document.createElement('div');
    node.className = `toast toast--${tone}`;
    node.setAttribute('role', tone === 'error' ? 'alert' : 'status');
    const msg = document.createElement('p');
    msg.className = 'toast__msg';
    msg.textContent = message;
    node.appendChild(msg);
    const close = () => {
      if (node.classList.contains('is-leaving')) return;
      node.classList.add('is-leaving');
      setTimeout(() => node.remove(), 200);
    };
    if (action) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'btn btn--sm';
      b.textContent = action.label;
      b.addEventListener('click', () => {
        if (busy()) {
          toast('抽獎進行中，等這一抽結束再復原。', { tone: 'error' });
          return;
        }
        action.run();
        close();
      });
      node.appendChild(b);
    }
    const x = document.createElement('button');
    x.type = 'button';
    x.className = 'btn btn--icon btn--sm btn--ghost';
    x.setAttribute('aria-label', '關閉通知');
    x.innerHTML = icon('x');
    x.addEventListener('click', close);
    node.appendChild(x);
    el.toasts.appendChild(node);
    while (el.toasts.children.length > 4) el.toasts.firstElementChild.remove();
    if (timeout) setTimeout(close, action ? Math.max(timeout, 8000) : timeout);
  }

  function announce(text) {
    el.announcer.textContent = '';
    requestAnimationFrame(() => { el.announcer.textContent = text; });
  }

  /* =================================================================== the draw */

  async function startDraw() {
    if (busy()) return;
    LW.Sound.unlock(); // must happen inside the click / key gesture
    leaveResult();
    const blocker = drawBlocker();
    if (blocker) {
      syncStage();
      renderControls();
      toast(blocker, { tone: 'error' });
      return;
    }

    const prize = currentPrize();
    const pool = candidates();
    const names = pool.map((p) => p.name);
    const seq = state.records.length + 1;

    phase = 'drawing';
    stage.clearResult();
    stage.setLabels(names);
    renderAll();

    let recorder = null;
    let record = null;
    let snapshotSaved = Promise.resolve();
    try {
      const fingerprint = await LW.sha256Hex(names.join('\n'));
      const index = LW.randomInt(pool.length);
      stage.setView({
        title: state.title.trim(),
        drawNo: seq,
        sessionId: state.session.id,
        candidateCount: names.length,
        fingerprint,
        prize: { name: prizeLabel(prize), total: prize.qty, remaining: remaining(prize) },
        prizeWinners: winnersOf(prize.id),
        readout: { label: '準備開始', text: null, tone: 'normal' },
      });
      if (state.settings.record) {
        try {
          recorder = LW.Recorder.start(el.canvas, { audioTrack: LW.Sound.track() });
        } catch (err) {
          throw Object.assign(new Error(`錄影無法啟動（${err.message || err}），這一抽沒有進行。請改用最新版 Chrome、Edge 或 Safari，或到「設定」關閉自動錄影。`), { beforeDraw: true });
        }
        stage.setRecording(recorder.startedAt);
        LW.Vault.persist();
      }

      // The result is fixed now, so it goes on file before the wheel moves: if the page dies
      // mid-spin, this draw survives as "中斷" instead of silently disappearing.
      const winner = pool[index];
      record = {
        id: LW.uid('draw'),
        seq,
        prizeId: prize.id,
        prizeName: prizeLabel(prize),
        name: winner.name,
        key: winner.key,
        index,
        candidateCount: names.length,
        candidatesHash: fingerprint,
        drawnAt: new Date().toISOString(),
        status: 'pending',
        video: recorder ? { state: 'recording' } : { state: 'none' },
      };
      state.records.push(record);
      if (!persist(true)) {
        state.records.pop();
        record = null;
        throw Object.assign(new Error('無法保存這一抽的預定結果，抽獎沒有開始。請檢查瀏覽器的儲存權限或可用空間。'), { beforeDraw: true });
      }
      snapshotSaved = LW.Vault.put({ id: record.id, candidates: names, video: null });
      await snapshotSaved;

      await LW.wait(PREROLL_MS);
      stage.setView({ readout: { label: '轉動中', text: null, tone: 'normal' } });
      const landed = await stage.spinTo(index, state.settings.spinSeconds * 1000);
      if (landed !== index) throw new Error(`轉盤停在第 ${landed + 1} 格，與抽出的第 ${index + 1} 格不符`);
    } catch (err) {
      if (recorder) recorder.cancel();
      stage.setRecording(null);
      const why = (err && err.message) || String(err);
      if (record) {
        record.status = 'aborted';
        record.abortReason = why;
        record.video = recorder ? { state: 'failed', error: '抽獎中斷，錄影未完成' } : { state: 'none' };
        persist(true);
      }
      phase = 'idle';
      renderAll();
      syncStage();
      toast(err && err.beforeDraw ? why : `這一抽中斷了，沒有產生結果：${why}`, { tone: 'error', timeout: 0 });
      return;
    }

    record.status = 'valid';
    record.drawnAt = new Date().toISOString();
    persist(true);

    stage.setView({
      prize: { name: record.prizeName, total: prize.qty, remaining: remaining(prize) },
      prizeWinners: winnersOf(prize.id),
      readout: { label: '恭喜中獎', text: record.name, tone: 'winner' },
    });
    stage.celebrate();
    LW.Sound.fanfare();
    announce(`第 ${seq} 抽，${record.prizeName}：${record.name}`);
    phase = 'saving';
    renderAll();

    if (recorder) {
      await LW.wait(POSTROLL_MS);
      await finishRecording(record, recorder, snapshotSaved);
    }
    phase = 'result';
    ensureCurrentPrize();
    persist();
    renderAll();
  }

  async function finishRecording(record, recorder, snapshotSaved) {
    stage.setRecording(null);
    try {
      const out = await recorder.stop();
      const sha256 = await LW.sha256Hex(out.blob);
      const file = videoFileName(record, out.mimeType);
      record.video = {
        state: 'ready',
        file,
        mime: out.mimeType,
        size: out.blob.size,
        sha256,
        durationMs: Math.round(out.durationMs),
        downloaded: false,
      };
      await snapshotSaved;
      await LW.Vault.update(record.id, { video: out.blob });
      if (state.settings.autoDownload) {
        LW.download(out.blob, file);
        record.video.downloaded = true;
      }
      persist(true);
      toast(state.settings.autoDownload
        ? `第 ${record.seq} 抽的錄影已下載（${LW.formatBytes(out.blob.size)}）`
        : `第 ${record.seq} 抽的錄影已存好，可以在「紀錄」下載`, { timeout: 4000 });
    } catch (err) {
      record.video = { state: 'failed', error: (err && err.message) || String(err) };
      persist(true);
      toast(`第 ${record.seq} 抽的錄影沒有存成功（${record.video.error}）。中獎結果已經記錄。`, { tone: 'error', timeout: 0 });
    }
  }

  function videoFileName(record, mime) {
    const base = `抽獎錄影_第${LW.pad(record.seq, 3)}抽_${record.prizeName}_${record.name}_${LW.fileStamp(new Date(record.drawnAt))}`;
    return `${LW.safeFilename(base, 120)}.${LW.Recorder.extensionFor(mime)}`;
  }

  /* =================================================================== exports */

  function csvRows() {
    const rows = [['序號', '獎項', '中獎者', '抽出時間', '狀態', '備註', '候選人數', '名單指紋（SHA-256）', '錄影檔名', '錄影 SHA-256', '場次代碼']];
    for (const r of state.records) {
      if (r.status === 'pending') continue;
      const v = r.video || {};
      const ready = v.state === 'ready';
      const note = r.status === 'void'
        ? `${r.voidReason || ''}${r.returnToPool ? '（已放回名單）' : ''}`
        : r.status === 'aborted' ? `抽獎中斷：${r.abortReason || ''}` : '';
      rows.push([
        r.seq, r.prizeName, r.name, LW.formatDateTime(r.drawnAt), STATUS_LABEL[r.status] || r.status, note,
        r.candidateCount, r.candidatesHash, ready ? v.file : '', ready ? v.sha256 : '', state.session.id,
      ]);
    }
    return rows;
  }

  const eventSlug = () => LW.safeFilename(state.title.trim() || '抽獎', 30);

  function exportCSV() {
    if (!state.records.length) return;
    const blob = new Blob([LW.toCSV(csvRows())], { type: 'text/csv;charset=utf-8' });
    LW.download(blob, `中獎名單_${eventSlug()}_${LW.fileStamp()}.csv`);
  }

  function auditDraw(r, snap) {
    const v = r.video || {};
    const entry = {
      seq: r.seq,
      id: r.id,
      drawnAt: r.drawnAt,
      prize: r.prizeName,
      winner: r.name,
      winnerIndex: r.index,
      candidateCount: r.candidateCount,
      candidatesSha256: r.candidatesHash,
      candidates: snap && snap.candidates ? snap.candidates : null,
      status: r.status,
    };
    if (r.status === 'void') entry.void = { reason: r.voidReason || '', at: r.voidAt, returnedToPool: !!r.returnToPool };
    if (r.status === 'aborted') entry.aborted = { reason: r.abortReason || '', note: '抽獎途中中斷；winner 為轉動前已抽定的結果，保留作為紀錄，不算中獎' };
    entry.video = v.state === 'ready'
      ? { file: v.file, mimeType: v.mime, bytes: v.size, durationMs: v.durationMs, sha256: v.sha256 }
      : { state: v.state || 'none', error: v.error };
    return entry;
  }

  function auditDoc(draws, now) {
    return {
      format: 'lucky-wheel-audit/1',
      exportedAt: now.toISOString(),
      event: { title: state.title.trim(), sessionId: state.session.id, sessionCreatedAt: state.session.createdAt },
      method: {
        random: 'Web Crypto crypto.getRandomValues()，以拒絕取樣產生均勻整數（沒有模數偏差）。winnerIndex 是中獎者在 candidates 裡的位置，從 0 起算。',
        candidatesSha256: 'SHA-256(UTF-8(candidates 依轉盤順序以換行字元 \\n 連接))，與錄影畫面下方的「名單指紋」相同。',
        eligibility: state.settings.allowRepeat ? '允許重複中獎（匯出當下的設定）' : '中獎者（含作廢但未放回名單的人）不參加之後的抽獎（匯出當下的設定）',
        recording: '每一抽自動錄下 1920×1080 的轉盤畫面，從轉動前 1 秒錄到結果後 3 秒；檔案的 SHA-256 記在 video.sha256。',
      },
      prizes: state.prizes.map((p) => ({ name: prizeLabel(p), quantity: p.qty, drawn: drawnCount(p.id) })),
      participants: people().map((p) => p.name),
      draws,
    };
  }

  function readmeText(now, draws, missing) {
    const count = (status) => state.records.filter((r) => r.status === status).length;
    const lines = [
      '抽獎憑證包　驗證說明',
      '',
      `活動名稱：${state.title.trim() || '（未命名）'}`,
      `場次代碼：${state.session.id}`,
      `匯出時間：${LW.formatDateTime(now)}`,
      `抽獎次數：${state.records.length}（有效 ${count('valid')}、作廢 ${count('void')}、中斷 ${count('aborted')}）`,
      '序號連續編排；作廢與中斷的抽次也保留在紀錄裡，不會被刪除。',
      '',
      '【內容】',
      '中獎名單.csv　每一抽的獎項、中獎者、時間、錄影檔名與 SHA-256，可直接用 Excel 開啟。',
      '抽獎紀錄.json　完整稽核紀錄，含每一抽當下的候選名單（candidates）。',
      '錄影/　　　　　每一抽的完整錄影，畫面下方顯示場次、抽次、候選人數、名單指紋與時間。',
      'SHA256SUMS.txt　所有錄影檔的 SHA-256 雜湊值。',
      '',
      '【確認錄影沒有被修改】',
      'macOS／Linux：在這個資料夾開啟終端機，執行',
      '    shasum -a 256 -c SHA256SUMS.txt',
      '  每一行都顯示 OK 就代表檔案和抽獎當下完全相同。',
      'Windows（PowerShell）：',
      '    Get-FileHash -Algorithm SHA256 .\\錄影\\<檔名>',
      '  把結果和 SHA256SUMS.txt 或 中獎名單.csv 裡的值比對。',
      '也可以在抽獎轉盤的「紀錄 → 驗證錄影檔」選擇影片，自動比對。',
      '',
      '【確認候選名單】',
      '錄影畫面下方的「名單指紋」是那一抽候選名單的 SHA-256 前後各 8 碼。',
      '把 抽獎紀錄.json 中該抽的 candidates 依序以換行字元連接（最後不加換行）後計算 SHA-256，',
      '結果應與 candidatesSha256 完全相同；winnerIndex 指出中獎者在名單中的位置（從 0 起算）。',
    ];
    if (missing.length) {
      lines.push('', '【注意】下列錄影不在匯出時的瀏覽器中，沒有包含在這個憑證包裡，請到當時的下載資料夾尋找：');
      for (const r of missing) lines.push(`  第 ${r.seq} 抽：${r.video.file}（SHA-256 ${r.video.sha256}）`);
    }
    return lines.join('\r\n') + '\r\n';
  }

  async function exportPackage() {
    if (zipping || busy() || !state.records.length) return;
    zipping = true;
    renderAll();
    const label = el.exportZip.querySelector('.btn__label');
    el.exportZip.disabled = true;
    el.exportZip.setAttribute('aria-busy', 'true');
    label.textContent = '打包中';
    try {
      const now = new Date();
      const folder = LW.safeFilename(`抽獎憑證包_${eventSlug()}_${LW.fileStamp(now)}`, 80);
      const videos = [];
      const sums = [];
      const missing = [];
      const draws = [];
      for (const r of state.records) {
        const snap = await LW.Vault.get(r.id);
        draws.push(auditDraw(r, snap));
        if (r.video && r.video.state === 'ready') {
          const file = cleanVideoFile(r.video.file); // never let a stored name leave the ZIP folder
          if (snap && snap.video) {
            sums.push(`${r.video.sha256}  錄影/${file}`);
            videos.push({ name: `${folder}/錄影/${file}`, data: snap.video, record: r });
          } else missing.push(r);
        }
      }
      const entries = [
        { name: `${folder}/中獎名單.csv`, data: LW.toCSV(csvRows()) },
        { name: `${folder}/抽獎紀錄.json`, data: JSON.stringify(auditDoc(draws, now), null, 2) },
        { name: `${folder}/SHA256SUMS.txt`, data: sums.length ? `${sums.join('\n')}\n` : '' },
        { name: `${folder}/驗證說明.txt`, data: readmeText(now, draws, missing) },
        ...videos,
      ];
      const zip = await LW.makeZip(entries, {
        date: now,
        onProgress: (done, total) => { label.textContent = `打包中 ${Math.floor((done / Math.max(1, total)) * 100)}%`; },
      });
      LW.download(zip, `${folder}.zip`);
      for (const v of videos) v.record.video.downloaded = true;
      persist(true);
      if (missing.length) {
        toast(`憑證包已下載，但有 ${missing.length} 段錄影不在這個瀏覽器裡，清單寫在「驗證說明.txt」。`, { tone: 'error', timeout: 0 });
      } else {
        toast(`憑證包已下載（${LW.formatBytes(zip.size)}）`);
      }
    } catch (err) {
      toast(`憑證包沒有匯出：${(err && err.message) || err}`, { tone: 'error', timeout: 0 });
    } finally {
      zipping = false;
      el.exportZip.removeAttribute('aria-busy');
      label.textContent = '匯出憑證包';
      renderAll();
      renderStorageInfo();
    }
  }

  /* =================================================================== videos */

  async function videoBlob(record) {
    const snap = await LW.Vault.get(record.id);
    if (snap && snap.video) return snap.video;
    toast(`這段錄影已經不在瀏覽器裡。若當時有自動下載，請到下載資料夾找「${record.video.file}」。`, { tone: 'error', timeout: 0 });
    return null;
  }

  async function saveVideo(id) {
    const r = state.records.find((x) => x.id === id);
    if (!r || !r.video || r.video.state !== 'ready') return;
    const blob = await videoBlob(r);
    if (!blob) return;
    LW.download(blob, cleanVideoFile(r.video.file));
    r.video.downloaded = true;
    persist();
    renderRecords();
    renderStorageInfo();
  }

  function fillMeta(dl, rows) {
    dl.innerHTML = rows.map(([k, v, mono]) => `<dt>${esc(k)}</dt><dd${mono ? ' class="mono"' : ''}>${esc(v)}</dd>`).join('');
  }

  async function playVideo(id) {
    const r = state.records.find((x) => x.id === id);
    if (!r || !r.video || r.video.state !== 'ready') return;
    const blob = await videoBlob(r);
    if (!blob) return;
    const dlg = el.dlgVideo;
    const player = $('video', dlg);
    const url = URL.createObjectURL(blob);
    $('.dialog__title', dlg).textContent = `第 ${r.seq} 抽錄影・${r.prizeName}・${r.name}`;
    fillMeta($('[data-f="meta"]', dlg), [
      ['檔名', r.video.file],
      ['長度', `${(r.video.durationMs / 1000).toFixed(1)} 秒・${LW.formatBytes(r.video.size)}`],
      ['抽出時間', LW.formatDateTime(r.drawnAt)],
      ['SHA-256', r.video.sha256, true],
    ]);
    $('[data-act="download"]', dlg).onclick = () => saveVideo(id);
    player.src = url;
    dlg.addEventListener('close', () => {
      player.pause();
      player.removeAttribute('src');
      player.load();
      URL.revokeObjectURL(url);
    }, { once: true });
    dlg.showModal();
  }

  async function verifyFile(file) {
    const sha = await LW.sha256Hex(file);
    const match = state.records.find((r) => r.video && r.video.sha256 === sha);
    const dlg = el.dlgVerify;
    dlg.classList.toggle('is-ok', !!match);
    dlg.classList.toggle('is-bad', !match);
    if (match) {
      $('.dialog__title', dlg).textContent = '錄影檔相符';
      $('[data-f="lead"]', dlg).textContent = `這個檔案和第 ${match.seq} 抽的紀錄完全一致，內容沒有被修改過。`;
      fillMeta($('[data-f="meta"]', dlg), [
        ['獎項', match.prizeName],
        ['中獎者', `${match.name}${match.status === 'valid' ? '' : `（${STATUS_LABEL[match.status] || match.status}：${match.voidReason || match.abortReason || '未註明'}）`}`],
        ['抽出時間', LW.formatDateTime(match.drawnAt)],
        ['檔案', file.name],
        ['SHA-256', sha, true],
      ]);
    } else {
      $('.dialog__title', dlg).textContent = '找不到相符的紀錄';
      $('[data-f="lead"]', dlg).textContent = '這個檔案和本場次每一抽的錄影都不同：可能是其他場次的錄影，或檔案曾被剪輯、轉檔或修改。';
      fillMeta($('[data-f="meta"]', dlg), [
        ['檔案', file.name],
        ['大小', LW.formatBytes(file.size)],
        ['SHA-256', sha, true],
      ]);
    }
    dlg.showModal();
  }

  /* =================================================================== dialogs */

  function openDialog(dlg) {
    dlg.returnValue = '';
    dlg.showModal();
  }

  document.addEventListener('click', (e) => {
    const closer = e.target.closest('[data-close]');
    if (closer) closer.closest('dialog').close(closer.dataset.close || '');
  });

  // Click on the backdrop closes a dialog (the dialog box itself is the only hit target inside).
  $$('dialog').forEach((dlg) => {
    dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(''); });
  });

  function openVoid(id) {
    const r = state.records.find((x) => x.id === id);
    if (!r || r.status !== 'valid' || busy()) return;
    const dlg = el.dlgVoid;
    const form = $('form', dlg);
    form.reset();
    dlg.dataset.id = id;
    $('[data-f="seq"]', dlg).textContent = r.seq;
    $('[data-f="prize"]', dlg).textContent = r.prizeName;
    $('[data-f="name"]', dlg).textContent = r.name;
    openDialog(dlg);
  }

  el.dlgVoid.addEventListener('close', () => {
    const dlg = el.dlgVoid;
    if (dlg.returnValue !== 'confirm') return;
    const r = state.records.find((x) => x.id === dlg.dataset.id);
    if (!r || r.status !== 'valid') return;
    const form = $('form', dlg);
    r.status = 'void';
    r.voidReason = form.elements.reason.value.trim() || '未註明';
    r.voidAt = new Date().toISOString();
    r.returnToPool = form.elements.back.checked;
    state.currentPrizeId = r.prizeId; // the freed slot is usually redrawn right away
    persist(true);
    leaveResult();
    renderAll();
    syncStage();
    toast(`已作廢第 ${r.seq} 抽，「${r.prizeName}」多出 1 個名額可以重抽。`);
  });

  function openReset() {
    if (busy()) return;
    const dlg = el.dlgReset;
    const videos = readyVideos();
    const pending = videos.filter((r) => !r.video.downloaded).length;
    $('[data-f="records"]', dlg).textContent = state.records.length;
    $('[data-f="videos"]', dlg).textContent = videos.length;
    const warn = $('[data-f="pending"]', dlg);
    warn.hidden = !pending;
    warn.textContent = pending ? `其中 ${pending} 段錄影還沒下載過，建議先匯出憑證包。` : '';
    $('#reset-confirm').value = '';
    $('#reset-go').disabled = true;
    openDialog(dlg);
  }

  $('#reset-confirm').addEventListener('input', (e) => {
    $('#reset-go').disabled = e.target.value.trim() !== '重設';
  });

  el.dlgReset.addEventListener('close', () => {
    const v = el.dlgReset.returnValue;
    if (v === 'export') exportPackage();
    if (v === 'confirm') resetDraws();
  });

  async function resetDraws() {
    if (busy()) return;
    clearing = true;
    renderAll();
    try {
      state.records = [];
      state.session = newSession();
      state.currentPrizeId = null;
      ensureCurrentPrize();
      persist(true);
      await LW.Vault.clear();
      leaveResult();
      toast(`已重設。新的場次代碼是 ${state.session.id}。`);
    } finally {
      clearing = false;
      renderAll();
      syncStage();
    }
  }

  async function clearSample() {
    if (busy()) return;
    clearing = true;
    renderAll();
    try {
      state.title = '';
      state.prizes = [];
      state.people = '';
      state.records = [];
      state.currentPrizeId = null;
      state.session = newSession();
      state.sample = false;
      persist(true);
      await LW.Vault.clear();
      leaveResult();
    } finally {
      clearing = false;
      renderAll();
      syncStage();
      selectTab('prizes');
      $('#prize-add').focus();
    }
  }

  /* =================================================================== tabs */

  const TABS = ['prizes', 'people', 'records', 'settings'];

  function selectTab(name, focus = false) {
    for (const t of TABS) {
      const tab = $(`#tab-${t}`);
      const on = t === name;
      tab.setAttribute('aria-selected', String(on));
      tab.tabIndex = on ? 0 : -1;
      $(`#pane-${t}`).hidden = !on;
      if (on && focus) tab.focus();
    }
    LW.Store.setPref('tab', name);
  }

  $('.tabs').addEventListener('click', (e) => {
    const tab = e.target.closest('[role="tab"]');
    if (tab) selectTab(tab.id.replace('tab-', ''));
  });

  $('.tabs').addEventListener('keydown', (e) => {
    const i = TABS.indexOf(document.activeElement.id.replace('tab-', ''));
    if (i < 0) return;
    const next = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: TABS.length - 1 }[e.key];
    if (next == null) return;
    e.preventDefault();
    selectTab(TABS[(next + TABS.length) % TABS.length], true);
  });

  /* =================================================================== events: controls */

  el.spin.addEventListener('click', startDraw);

  el.prizeSelect.addEventListener('change', () => {
    state.currentPrizeId = el.prizeSelect.value;
    persist();
    leaveResult();
    syncStage();
    renderControls();
    renderPrizes();
  });

  function setSound(on) {
    LW.Sound.unlock();
    state.settings.sound = on;
    LW.Sound.setEnabled(on);
    persist();
    renderSettings();
  }
  el.sound.addEventListener('click', () => setSound(!state.settings.sound));

  let wakeLock = null;
  async function setPresenting(on) {
    el.app.classList.toggle('is-presenting', on);
    el.present.setAttribute('aria-pressed', String(on));
    $('.btn__label', el.present).textContent = on ? '結束簡報' : '簡報模式';
    $('use', el.present).setAttribute('href', on ? '#i-shrink' : '#i-expand');
    if (on) {
      try { if (!document.fullscreenElement && document.documentElement.requestFullscreen) await document.documentElement.requestFullscreen(); } catch (_) { /* windowed is fine */ }
      try { wakeLock = navigator.wakeLock ? await navigator.wakeLock.request('screen') : null; } catch (_) { wakeLock = null; }
    } else {
      if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
      if (wakeLock) wakeLock.release().catch(() => {});
      wakeLock = null;
    }
  }
  el.present.addEventListener('click', () => setPresenting(!el.app.classList.contains('is-presenting')));
  document.addEventListener('fullscreenchange', () => {
    if (!document.fullscreenElement && el.app.classList.contains('is-presenting')) setPresenting(false);
  });

  document.addEventListener('keydown', (e) => {
    if (e.defaultPrevented || e.isComposing || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.target.closest && e.target.closest('input, textarea, select, button, a, [contenteditable], dialog')) return;
    if (e.key === ' ' || e.key === 'Enter') {
      e.preventDefault();
      startDraw();
    } else if (e.key === 'f' || e.key === 'F') {
      setPresenting(!el.app.classList.contains('is-presenting'));
    } else if (e.key === 'Escape' && phase === 'result') {
      leaveResult();
      syncStage();
    }
  });

  /* =================================================================== events: panels */

  $('#sample-clear').addEventListener('click', clearSample);

  // prizes
  $('#prize-add').addEventListener('click', () => {
    const p = { id: LW.uid('prize'), name: '', qty: 1 };
    state.prizes.push(p);
    state.sample = false;
    ensureCurrentPrize();
    persist();
    renderAll();
    syncStage();
    $(`.prize[data-id="${p.id}"] .prize__name`).focus();
  });

  function rowError(row, message) {
    const box = $('[data-role="error"]', row);
    box.textContent = message || '';
    $$('.input', row).forEach((input) => input.removeAttribute('aria-invalid'));
    return box;
  }

  el.prizeList.addEventListener('input', (e) => {
    const row = e.target.closest('.prize');
    const p = row && prizeById(row.dataset.id);
    if (!p) return;
    if (e.target.dataset.field === 'name') {
      p.name = e.target.value;
      rowError(row, '');
    } else if (e.target.dataset.field === 'qty') {
      const n = Number(e.target.value);
      if (!Number.isInteger(n) || n < Math.max(1, drawnCount(p.id)) || n > 999) return; // judged on blur
      p.qty = n;
      rowError(row, '');
      $('[data-role="progress"]', row).textContent = `已抽 ${drawnCount(p.id)} / ${p.qty}`;
    }
    state.sample = false;
    el.sampleNotice.hidden = true;
    persist();
    renderPrizeSummary();
    renderControls();
    syncSoon();
  });

  el.prizeList.addEventListener('change', (e) => {
    const row = e.target.closest('.prize');
    const p = row && prizeById(row.dataset.id);
    if (!p) return;
    if (e.target.dataset.field === 'qty') {
      const n = Number(e.target.value);
      const min = Math.max(1, drawnCount(p.id));
      if (!Number.isInteger(n) || n < min || n > 999) {
        e.target.value = p.qty;
        rowError(row, min > 1
          ? `名額要介於 ${min}～999（已經抽出 ${min} 名），已還原為 ${p.qty}。`
          : `名額要介於 1～999 的整數，已還原為 ${p.qty}。`);
      }
      ensureCurrentPrize();
      persist();
      renderPrizes();
      renderControls();
      syncStage();
    } else if (e.target.dataset.field === 'name' && !p.name.trim()) {
      rowError(row, '請輸入獎項名稱，例如「頭獎 旅遊住宿券」。');
      e.target.setAttribute('aria-invalid', 'true');
    }
  });

  el.prizeList.addEventListener('click', (e) => {
    const button = e.target.closest('button[data-act]');
    if (!button) return;
    const row = button.closest('.prize');
    const i = state.prizes.findIndex((p) => p.id === row.dataset.id);
    if (i < 0) return;
    const act = button.dataset.act;
    if (act === 'up' || act === 'down') {
      const j = act === 'up' ? i - 1 : i + 1;
      if (j < 0 || j >= state.prizes.length) return;
      [state.prizes[i], state.prizes[j]] = [state.prizes[j], state.prizes[i]];
      persist();
      renderPrizes();
      renderControls();
      const moved = $(`.prize[data-id="${row.dataset.id}"]`);
      const again = $(`[data-act="${act}"]`, moved);
      (again.disabled ? $(`[data-act="${act === 'up' ? 'down' : 'up'}"]`, moved) : again).focus();
    } else if (act === 'del') {
      const [removed] = state.prizes.splice(i, 1);
      ensureCurrentPrize();
      persist();
      renderAll();
      syncStage();
      toast(`已刪除「${prizeLabel(removed)}」`, {
        action: {
          label: '復原',
          run: () => {
            state.prizes.splice(Math.min(i, state.prizes.length), 0, removed);
            ensureCurrentPrize();
            persist();
            renderAll();
            syncStage();
          },
        },
      });
    }
  });

  // people
  el.peopleText.addEventListener('input', () => {
    if (busy() || rosterLocked()) {
      el.peopleText.value = state.people;
      return;
    }
    state.people = el.peopleText.value;
    state.sample = false;
    el.sampleNotice.hidden = true;
    persist();
    renderPeopleMeta();
    renderTabs();
    renderControls();
    syncSoon();
  });

  $('#people-import').addEventListener('click', () => el.filePeople.click());

  const HEADER = /^(姓名|名字|名稱|員工姓名|中文姓名|參加者|name|full ?name)$/i;
  el.filePeople.addEventListener('change', async () => {
    const file = el.filePeople.files[0];
    el.filePeople.value = '';
    if (!file) return;
    const text = LW.decodeText(await file.arrayBuffer());
    if (busy() || rosterLocked()) return;
    const isTable = /\.(csv|tsv)$/i.test(file.name) || /csv/.test(file.type);
    let rows = isTable ? LW.parseCSV(text).map((cells) => cells.map((c) => c.trim()).filter(Boolean)) : text.split(/\r?\n/).map((l) => [l.trim()]);
    rows = rows.filter((cells) => cells.length && cells.join(''));
    if (rows.length > 1 && rows[0].some((c) => HEADER.test(c))) rows.shift();
    const lines = rows.map((cells) => cells.join(' ').replace(/\s+/g, ' ').trim()).filter(Boolean);
    if (!lines.length) {
      toast(`「${file.name}」裡沒有讀到任何名字。請確認每行一位，或 CSV 每一列是一個人。`, { tone: 'error', timeout: 0 });
      return;
    }
    const before = state.people;
    setPeople(lines.join('\n'));
    toast(`已從「${file.name}」匯入 ${lines.length} 人，原本的名單已取代`, { action: { label: '復原', run: () => setPeople(before) } });
  });

  el.dedupe.addEventListener('click', () => {
    const seen = new Set();
    const kept = people().filter((p) => (seen.has(p.name) ? false : seen.add(p.name)));
    const removed = people().length - kept.length;
    const before = state.people;
    setPeople(kept.map((p) => p.name).join('\n'));
    toast(`已移除 ${removed} 個重複的名字`, { action: { label: '復原', run: () => setPeople(before) } });
  });

  $('#people-clear').addEventListener('click', () => {
    if (!state.people.trim()) return;
    const before = state.people;
    setPeople('');
    el.peopleText.focus();
    toast('名單已清空', { action: { label: '復原', run: () => setPeople(before) } });
  });

  el.optExclude.addEventListener('change', () => {
    state.settings.allowRepeat = !el.optExclude.checked;
    persist();
    renderPeopleMeta();
    renderControls();
    syncStage();
  });

  // records
  el.records.addEventListener('click', (e) => {
    const button = e.target.closest('button[data-act]');
    if (!button) return;
    const { act, id } = button.dataset;
    if (act === 'play') playVideo(id);
    if (act === 'save') saveVideo(id);
    if (act === 'void') openVoid(id);
  });
  el.exportCsv.addEventListener('click', exportCSV);
  el.exportZip.addEventListener('click', exportPackage);
  el.verify.addEventListener('click', () => el.fileVerify.click());
  el.fileVerify.addEventListener('change', () => {
    const file = el.fileVerify.files[0];
    el.fileVerify.value = '';
    if (file) verifyFile(file);
  });

  // settings
  el.optTitle.addEventListener('input', () => {
    state.title = el.optTitle.value;
    persist();
    stage.setView({ title: state.title.trim() });
  });
  el.optSpin.addEventListener('input', () => {
    state.settings.spinSeconds = Number(el.optSpin.value);
    el.optSpinOut.textContent = `${state.settings.spinSeconds} 秒`;
    persist();
  });
  el.optRecord.addEventListener('change', () => {
    state.settings.record = el.optRecord.checked;
    persist();
    renderSettings();
    renderControls();
  });
  el.optAutoDl.addEventListener('change', () => {
    state.settings.autoDownload = el.optAutoDl.checked;
    persist();
  });
  el.optSound.addEventListener('change', () => setSound(el.optSound.checked));
  el.retryStorage.addEventListener('click', () => {
    if (busy()) return;
    if (persist(true)) toast('設定與抽獎紀錄已重新儲存，可以繼續抽獎。');
    else toast('仍無法儲存，請檢查瀏覽器的儲存權限或可用空間。', { tone: 'error' });
  });
  $('#reset-open').addEventListener('click', openReset);

  /* =================================================================== lifecycle */

  window.addEventListener('pagehide', () => persist(true));
  window.addEventListener('beforeunload', (e) => {
    persist(true);
    if (busy()) {
      e.preventDefault();
      e.returnValue = '';
    }
  });

  ensureCurrentPrize();
  const savedTab = LW.Store.getPref('tab', 'prizes');
  selectTab(TABS.includes(savedTab) ? savedTab : 'prizes');
  renderAll();
  syncStage();
  LW.Vault.ready().then(() => {
    vaultChecked = true;
    renderStorageInfo();
  });

  // Debug handle for the browser console: LW.app.state, LW.app.stage
  LW.app = { state, stage, get phase() { return phase; } };
})();
