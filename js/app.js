/* 抽獎轉盤 — app controller: state, panels, the draw sequence, recording, exports. */
(function () {
  'use strict';
  const { $, $$, esc } = LW;

  const PREROLL_MS = 1000;   // recording starts this long before the wheel moves
  const POSTROLL_MS = 3000;  // …and keeps rolling this long on the result
  const VERSION = 1;
  const RECORD_PAGE_SIZE = 50;
  const MAX_PEOPLE_CHARS = 2000000;
  const MAX_IMPORT_BYTES = 32 * 1024 * 1024;
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
      rosterKeyScheme: 2,
      vaultGeneration: '',
      prizes: SAMPLE.prizes.map(([name, qty]) => ({ id: LW.uid('prize'), name, qty, eligibleGroup: '', repeatPolicy: 'inherit' })),
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
      rosterKeyScheme: raw.rosterKeyScheme === 2 || !raw.records?.length || !LW.legacyRosterKeyCollision(str(raw.people, 2000000)) ? 2 : 1,
      vaultGeneration: typeof raw.vaultGeneration === 'string' && /^vault_[0-9a-f]{16}$/.test(raw.vaultGeneration) ? raw.vaultGeneration : '',
      prizes: (Array.isArray(raw.prizes) ? raw.prizes : []).map((p) => ({
        id: str(p && p.id, 64) || LW.uid('prize'),
        name: str(p && p.name, 40),
        qty: int(p && p.qty, 1, 999, 1),
        eligibleGroup: str(p && p.eligibleGroup, 40).trim(),
        repeatPolicy: ['inherit', 'allow', 'exclude'].includes(p && p.repeatPolicy) ? p.repeatPolicy : 'inherit',
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
        rule: r.rule && typeof r.rule === 'object' ? {
          eligibleGroup: str(r.rule.eligibleGroup, 40).trim(),
          repeatPolicy: ['inherit', 'allow', 'exclude'].includes(r.rule.repeatPolicy) ? r.rule.repeatPolicy : 'inherit',
          allowRepeat: !!r.rule.allowRepeat,
        } : undefined,
        abortReason: r.abortReason == null ? undefined : str(r.abortReason, 200),
        video,
      });
    }
    return s;
  }

  function loadState(saved) {
    const s = saved ? sanitizeState(saved) : sampleState();
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

  const initialRead = LW.Store.read();
  const state = loadState(initialRead.status === 'ok' && LW.Store.validState(initialRead.value, VERSION) ? initialRead.value : null);
  let exportReceipt = LW.normalizeExportReceipt(LW.Store.getPref('lastExportReceipt', null), state.session.id);
  let exportReceiptSaved = !!exportReceipt;
  let recordsPageIndex = 0;
  let recordsViewSessionId = state.session.id;
  LW.Vault.setGeneration(state.vaultGeneration);
  let phase = 'idle'; // idle → drawing → saving → result → idle
  let zipping = false;
  let clearing = false;
  let checking = state.records.some((record) => (record.status === 'valid' || record.status === 'void') && record.video?.state === 'failed');
  let saveTimer = 0;
  let storageError = false;
  let staleState = false;
  let preflightCurrent = false;
  let storageProblem = initialRead.status === 'unavailable' ? 'unavailable'
    : initialRead.status === 'corrupt' ? 'corrupt'
      : initialRead.status === 'ok' && !LW.Store.validState(initialRead.value, VERSION) ? 'incompatible' : null;
  let persistedSnapshot = initialRead.raw;

  function invalidatePreflight() {
    if (checking || !preflightCurrent) return;
    preflightCurrent = false;
    const result = $('#preflight-results');
    result.replaceChildren();
    const item = document.createElement('li');
    item.className = 'check-bad';
    item.textContent = '設定或紀錄已變更，請重新執行活動前檢查。';
    result.appendChild(item);
  }

  function freshStore() {
    const current = LW.Store.read();
    return current.status !== 'unavailable' && current.raw === persistedSnapshot;
  }

  function markStale() {
    if (staleState) return;
    toast('另一個分頁已更新此場次。請重新整理，以免覆蓋較新的抽獎紀錄。', { tone: 'error', timeout: 0 });
    staleState = true;
    clearTimeout(saveTimer);
    invalidatePreflight();
    renderAll();
  }

  function canEditSession(allowDuringDraw = false) {
    if ((busy() && !(allowDuringDraw && phase === 'drawing')) || storageProblem) return false;
    if (staleState || !freshStore()) {
      markStale();
      return false;
    }
    return true;
  }

  function saveSessionState(next, { allowRecovery = false } = {}) {
    invalidatePreflight();
    if (storageProblem === 'unavailable' || (storageProblem && !allowRecovery)) return false;
    if (staleState || !freshStore()) {
      markStale();
      return false;
    }
    const saved = LW.Store.save(next);
    if (saved) {
      persistedSnapshot = JSON.stringify(next);
      storageProblem = null;
    }
    return saved;
  }

  function persist(now = false) {
    invalidatePreflight();
    clearTimeout(saveTimer);
    const write = () => {
      if (storageProblem) return false;
      if (staleState || !freshStore()) {
        markStale();
        return false;
      }
      const saved = LW.Store.save(state);
      if (saved) persistedSnapshot = JSON.stringify(state);
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

  let peopleCache = { text: null, scheme: null, list: [] };
  /** One entry per non-empty line. Repeated identities get an ordinal key. */
  function people() {
    if (peopleCache.text === state.people && peopleCache.scheme === state.rosterKeyScheme) return peopleCache.list;
    const list = state.rosterKeyScheme === 1 ? LW.parsePeopleLegacy(state.people) : LW.parsePeople(state.people);
    peopleCache = { text: state.people, scheme: state.rosterKeyScheme, list };
    return list;
  }

  function duplicateNames() {
    const counts = new Map();
    for (const p of people()) {
      const identity = p.group ? `${p.name} | ${p.group}` : p.name;
      counts.set(identity, (counts.get(identity) || 0) + 1);
    }
    return [...counts].filter(([, n]) => n > 1).map(([name, count]) => ({ name, count }));
  }

  function candidates(prize = currentPrize()) { return LW.eligiblePeople(people(), state.records, prize, state.settings); }

  const STATUS_LABEL = { valid: '有效', void: '作廢', aborted: '中斷', pending: '進行中' };

  const prizeById = (id) => state.prizes.find((p) => p.id === id) || null;
  const currentPrize = () => prizeById(state.currentPrizeId);
  const drawnCount = (id) => state.records.reduce((n, r) => n + (r.prizeId === id && r.status === 'valid' ? 1 : 0), 0);
  const remaining = (p) => Math.max(0, p.qty - drawnCount(p.id));
  const prizeLabel = (p) => (p.name || '').trim() || '未命名獎項';
  const allDrawn = () => state.prizes.length > 0 && state.prizes.every((p) => remaining(p) === 0);
  /** Valid winners of a prize, newest first. */
  const winnersOf = (id) => state.records.filter((r) => r.prizeId === id && r.status === 'valid').map((r) => r.name).reverse();
  const busy = () => phase === 'drawing' || phase === 'saving' || phase === 'rehearsal' || zipping || clearing || checking;
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
    if (storageProblem) return '儲存的場次無法安全讀取，請先下載原始資料或還原備份';
    if (staleState || !freshStore()) return '另一個分頁已更新此場次，請重新整理後再抽獎';
    if (storageError) return '無法保存抽獎紀錄，請檢查瀏覽器的儲存權限或可用空間';
    if (state.rosterKeyScheme === 1) return '舊版場次的姓名識別鍵發生衝突，請先匯出憑證包，再重設抽獎以建立新場次';
    if (!state.prizes.length) return '先到「獎池」新增獎項';
    if (allDrawn()) return '所有獎項都已抽出';
    const prize = currentPrize();
    if (!prize) return '請選擇本輪獎項';
    if (!prize.name.trim()) return '請先為本輪獎項輸入名稱';
    if (remaining(prize) === 0) return `「${prizeLabel(prize)}」已經抽完，請改選其他獎項`;
    if (!people().length) return '先到「名單」加入抽獎人員';
    const rosterIssue = LW.rosterIdentifierIssue(people());
    if (rosterIssue) return `${rosterIssue}，請先修正名單再抽獎`;
    if (!candidates().length) return prize.eligibleGroup ? `「${prizeLabel(prize)}」的「${prize.eligibleGroup}」組已沒有符合規則的人` : '名單上已經沒有可以抽的人';
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
    stageText: $('#stage-text'),
    prizeSelect: $('#prize-select'),
    sound: $('#sound-toggle'),
    present: $('#present-toggle'),
    sessionId: $('#session-id'),
    stateAlert: $('#state-alert'),
    stateAlertMessage: $('#state-alert-message'),
    stateAlertDownload: $('#state-alert-download'),
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
    recordsSearch: $('#records-search'),
    recordsStatus: $('#records-status'),
    recordsPager: $('#records-pager'),
    recordsPageSummary: $('#records-page-summary'),
    recordsPageActions: $('#records-page-actions'),
    recordsPrevious: $('#records-previous'),
    recordsNext: $('#records-next'),
    exportCsv: $('#export-csv'),
    exportValid: $('#export-valid'),
    printValid: $('#print-valid'),
    printSheet: $('#print-sheet'),
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
    dlgEvidence: $('#dlg-evidence'),
    dlgVerify: $('#dlg-verify'),
  };

  const stage = new LW.Stage(el.canvas);
  stage.onTick = () => LW.Sound.tick();
  let projectionWindow = null;
  stage.onFrame = (canvas, view) => {
    if (!projectionWindow) return;
    if (projectionWindow.closed) { projectionWindow = null; return; }
    try {
      const doc = projectionWindow.document;
      const mirror = doc.getElementById('projection-canvas');
      if (!mirror) return;
      mirror.getContext('2d', { alpha: false }).drawImage(canvas, 0, 0);
      mirror.dataset.lastFrameAt = String(Date.now());
      const status = doc.getElementById('projection-status');
      const next = `${view.prize ? view.prize.name : '尚無獎項'} · ${view.readout?.text || view.readout?.label || ''}`;
      if (status && status.textContent !== next) status.textContent = next;
      const aria = `抽獎投影。${next}`;
      if (mirror.getAttribute('aria-label') !== aria) mirror.setAttribute('aria-label', aria);
    } catch (_) { projectionWindow = null; }
  };
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
    renderStateAlert();
    renderControls();
    renderTabs();
    renderPrizes();
    renderPeople();
    renderRecords();
    renderSettings();
    el.sessionId.textContent = state.session.id;
    el.sampleNotice.hidden = !state.sample || !!storageProblem;
    $$('.lockable').forEach((fs) => { fs.disabled = busy() || !!storageProblem || staleState || (!!fs.closest('#pane-people') && rosterLocked()); });
    $('#sample-clear').disabled = busy() || !!storageProblem || staleState;
    $('#reset-open').disabled = busy() || !!storageProblem || staleState;
    $('#rehearse').disabled = busy() || !!storageProblem || staleState;
    $('#backup-export').disabled = busy() || !!storageProblem || staleState;
    for (const id of ['preflight', 'backup-import']) $(`#${id}`).disabled = busy() || staleState;
    el.sound.disabled = (busy() && phase !== 'drawing') || !!storageProblem || staleState;
  }

  function renderStateAlert() {
    el.stateAlert.hidden = !storageProblem && !staleState;
    if (!storageProblem && !staleState) return;
    el.stateAlertMessage.textContent = !storageProblem
      ? '另一個分頁已更新此場次。這個分頁的設定可能未保存；請重新整理後再操作。'
      : storageProblem === 'unavailable'
      ? '無法讀取瀏覽器儲存空間。已暫停抽獎與寫入；檢查瀏覽器權限後按「重新讀取」。'
      : storageProblem === 'corrupt'
        ? '原場次資料無法解析，已暫停寫入。請先下載原始資料，再到「設定 → 場次移轉」還原有效備份。'
        : '原場次格式與這個版本不相容，已暫停寫入。請使用建立場次的新版程式，或先下載原始資料再還原備份。';
    el.stateAlertDownload.hidden = !storageProblem || initialRead.raw === null;
  }

  function renderControls() {
    const isBusy = busy();
    const blocker = isBusy ? null : drawBlocker();
    el.spin.disabled = isBusy || !!blocker;
    el.spin.setAttribute('aria-busy', String(isBusy));
    el.spinLabel.textContent = phase === 'drawing' ? '抽獎中' : phase === 'saving' ? '儲存錄影' : phase === 'rehearsal' ? '預演中' : zipping ? '憑證包打包中' : clearing ? '正在處理場次' : checking ? '檢查中' : '開始抽獎';
    el.spinHint.textContent = blocker ||
      (phase === 'drawing' && state.settings.record ? '錄影中，請不要切換分頁或關閉視窗' :
        phase === 'saving' ? '正在儲存這一抽的錄影…' : zipping ? '請等憑證包打包完成' : clearing ? '請等場次處理完成' : checking ? '活動前檢查進行中' : '按空白鍵也能開始');
    el.spinHint.classList.toggle('is-warning', !!blocker);
    const last = state.records[state.records.length - 1];
    el.stageText.textContent = phase === 'drawing' ? `第 ${last?.status === 'pending' ? last.seq : state.records.length + 1} 抽轉盤轉動中；結果完成後會公布。`
      : (phase === 'saving' || phase === 'result') && last ? `第 ${last.seq} 抽，${last.prizeName}：${last.name}。錄影狀態：${last.video?.state === 'ready' ? '已儲存' : last.video?.state === 'failed' ? '失敗' : '處理中'}。`
        : phase === 'rehearsal' ? '預演中。這次不會寫入紀錄或占用名額。'
          : `本輪獎項：${currentPrize() ? prizeLabel(currentPrize()) : '未設定'}；目前可抽 ${candidates().length} 人。${blocker || ''}`;

    el.prizeSelect.innerHTML = state.prizes.length
      ? state.prizes.map((p) => {
        const left = remaining(p);
        return `<option value="${esc(p.id)}"${p.id === state.currentPrizeId ? ' selected' : ''}${left ? '' : ' disabled'}>` +
          `${esc(prizeLabel(p))}（${left ? `剩 ${left}/${p.qty}` : '已抽完'}）</option>`;
      }).join('')
      : '<option value="">尚未設定獎項</option>';
    el.prizeSelect.disabled = isBusy || !!storageProblem || staleState || !state.prizes.length;
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
    const ruleLocked = state.records.some((r) => r.prizeId === p.id);
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
      <div class="prize__rules">
        <label>限定組別 <input class="input" data-field="group" value="${esc(p.eligibleGroup || '')}" maxlength="40" placeholder="全部組別" aria-label="「${label}」限定組別"${ruleLocked ? ' disabled' : ''}></label>
        <label>曾中獎者 <select class="input select" data-field="repeat" aria-label="「${label}」曾中獎者規則"${ruleLocked ? ' disabled' : ''}>
          <option value="inherit"${!p.repeatPolicy || p.repeatPolicy === 'inherit' ? ' selected' : ''}>依名單設定</option>
          <option value="exclude"${p.repeatPolicy === 'exclude' ? ' selected' : ''}>排除</option>
          <option value="allow"${p.repeatPolicy === 'allow' ? ' selected' : ''}>可參加</option>
        </select></label>
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
      el.peopleHelp.textContent = `有 ${dups.length} 個姓名與組別組合重複（${sample}${dups.length > 3 ? '…' : ''}），重複項目會各自參加抽獎。`;
    } else {
      el.peopleHelp.textContent = '可以加上編號或部門，例如「A001 陳怡君」。';
    }
    el.peopleHelp.classList.toggle('is-warning', dups.length > 0);
    el.dedupe.hidden = !dups.length;
    $('#people-lock-note').hidden = !rosterLocked();
  }

  function setPeople(text, { saveNow = false } = {}) {
    if (rosterLocked() || !canEditSession()) return false;
    if (text.length > MAX_PEOPLE_CHARS) {
      toast('名單超過可保存的長度，請先縮短再匯入。', { tone: 'error' });
      return false;
    }
    const previous = state.people;
    const wasSample = state.sample;
    state.people = text;
    el.peopleText.value = text;
    state.sample = false;
    if (saveNow && !persist(true)) {
      state.people = previous;
      state.sample = wasSample;
      el.peopleText.value = previous;
      renderAll();
      return false;
    }
    if (!saveNow) persist();
    renderAll();
    syncStage();
    return true;
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
    actions.push(`<button class="btn btn--sm btn--ghost" type="button" data-act="evidence" data-id="${esc(r.id)}"${busy() ? ' disabled' : ''}>查核快照</button>`);
    if (r.status === 'valid') {
      actions.push(`<button class="btn btn--sm btn--ghost" type="button" data-act="void" data-id="${esc(r.id)}"${busy() || staleState || storageProblem ? ' disabled' : ''}>作廢</button>`);
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
    if (recordsViewSessionId !== state.session.id) {
      recordsViewSessionId = state.session.id;
      recordsPageIndex = 0;
      el.recordsSearch.value = '';
      el.recordsStatus.value = '';
    }
    let page = LW.recordPage(state.records, {
      query: el.recordsSearch.value, status: el.recordsStatus.value,
      page: recordsPageIndex, pageSize: RECORD_PAGE_SIZE,
    });
    if (!page.items.length && recordsPageIndex > 0) {
      recordsPageIndex = Math.max(0, Math.ceil(page.total / RECORD_PAGE_SIZE) - 1);
      page = LW.recordPage(state.records, {
        query: el.recordsSearch.value, status: el.recordsStatus.value,
        page: recordsPageIndex, pageSize: RECORD_PAGE_SIZE,
      });
    }
    el.records.innerHTML = page.items.length ? page.items.map(recordItem).join('')
      : state.records.length ? `<li class="empty">
          <p class="empty__title">找不到符合的紀錄</p>
          <p>試試其他姓名、獎項、抽次或狀態。</p>
        </li>` : `<li class="empty">
          <p class="empty__title">還沒有中獎紀錄</p>
          <p>按下「開始抽獎」後，每一抽的結果和錄影都會出現在這裡，可以播放、下載或作廢。</p>
        </li>`;
    el.recordsSearch.disabled = !state.records.length;
    el.recordsStatus.disabled = !state.records.length;
    el.recordsPager.hidden = !state.records.length;
    el.recordsPageSummary.textContent = page.total
      ? `顯示第 ${recordsPageIndex * RECORD_PAGE_SIZE + 1}–${recordsPageIndex * RECORD_PAGE_SIZE + page.items.length} 筆，共 ${page.total} 筆符合條件`
      : '沒有符合條件的紀錄';
    el.recordsPrevious.disabled = !page.hasPrevious;
    el.recordsNext.disabled = !page.hasNext;
    el.recordsPageActions.hidden = !page.hasPrevious && !page.hasNext;
    const count = (status) => state.records.filter((r) => r.status === status).length;
    const [valid, voided, aborted] = [count('valid'), count('void'), count('aborted')];
    el.recordsSummary.textContent = state.records.length
      ? `${state.records.length} 抽・有效 ${valid}${voided ? `・作廢 ${voided}` : ''}${aborted ? `・中斷 ${aborted}` : ''}`
      : '尚無紀錄';
    el.exportCsv.disabled = !state.records.length || busy();
    el.exportValid.disabled = !valid || busy();
    el.printValid.disabled = !valid || busy();
    el.exportZip.disabled = !state.records.length || busy() || zipping;
    el.verify.disabled = !readyVideos().length;
    renderExportReceipt();
  }

  function renderExportReceipt() {
    const visible = exportReceipt && exportReceipt.sessionId === state.session.id;
    $('#export-hash').hidden = !visible;
    if (!visible) return;
    $('#export-file-name').textContent = exportReceipt.fileName;
    const time = $('#export-time');
    time.dateTime = exportReceipt.exportedAt;
    time.textContent = LW.formatDateTime(exportReceipt.exportedAt);
    $('#export-hash-value').textContent = exportReceipt.sha256;
    $('#export-receipt-warning').hidden = exportReceiptSaved;
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
    el.retryStorage.hidden = !storageError || !!storageProblem;
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
      ? `紀錄標示 ${videos.length} 段錄影（${LW.formatBytes(bytes)}）${pending ? `，其中 ${pending} 段尚未標記為已下載` : '，都已標記為已下載'}。播放或匯出時會再確認檔案是否仍在瀏覽器中。`
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
        if (action.run() === false) {
          toast('無法完成復原，請檢查場次儲存狀態。', { tone: 'error' });
          return;
        }
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
    phase = 'drawing';
    renderAll();
    try {
      await LW.DrawGate.run(state.session.id, performDraw);
    } catch (err) {
      phase = 'idle';
      renderAll();
      syncStage();
      toast(err.message || String(err), { tone: 'error', timeout: 0 });
    }
  }

  async function performDraw(assertLock) {
    leaveResult();
    const blocker = drawBlocker();
    if (blocker) {
      phase = 'idle';
      syncStage();
      renderControls();
      toast(blocker, { tone: 'error' });
      return;
    }

    const prize = currentPrize();
    const pool = candidates();
    const names = pool.map((p) => p.name);
    const seq = state.records.length + 1;

    stage.clearResult();
    stage.setLabels(names);
    renderAll();

    let recorder = null;
    let record = null;
    let drawId = null;
    let pendingSaved = false;
    try {
      const fingerprint = await LW.sha256Hex(names.join('\n'));
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
      drawId = LW.uid('draw');
      try {
        await LW.Vault.put({ id: drawId, candidates: names, candidateKeys: pool.map((p) => p.key), video: null });
      } catch (err) {
        throw Object.assign(new Error(`候選名單快照無法保存（${err.message || err}），這一抽沒有進行。`), { beforeDraw: true });
      }
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
      const index = LW.randomInt(pool.length);
      const winner = pool[index];
      record = {
        id: drawId,
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
        rule: { eligibleGroup: prize.eligibleGroup || '', repeatPolicy: prize.repeatPolicy || 'inherit', allowRepeat: LW.allowsRepeat(prize, state.settings) },
      };
      await assertLock();
      state.records.push(record);
      if (!persist(true)) {
        state.records.pop();
        record = null;
        throw Object.assign(new Error('無法保存這一抽的預定結果，抽獎沒有開始。請檢查瀏覽器的儲存權限或可用空間。'), { beforeDraw: true });
      }
      pendingSaved = true;

      await LW.wait(PREROLL_MS);
      stage.setView({ readout: { label: '轉動中', text: null, tone: 'normal' } });
      const landed = await stage.spinTo(index, state.settings.spinSeconds * 1000);
      if (landed !== index) throw new Error(`轉盤停在第 ${landed + 1} 格，與抽出的第 ${index + 1} 格不符`);
    } catch (err) {
      if (recorder) recorder.cancel();
      stage.setRecording(null);
      const why = (err && err.message) || String(err);
      if (err?.lockLost) staleState = true;
      if (pendingSaved && record && !err?.lockLost) {
        record.status = 'aborted';
        record.abortReason = why;
        record.video = recorder ? { state: 'failed', error: '抽獎中斷，錄影未完成' } : { state: 'none' };
        persist(true);
      }
      if (!pendingSaved && drawId) {
        try { await LW.Vault.removeSession(state.vaultGeneration, [{ id: drawId }]); } catch (_) { /* orphaned evidence is harmless */ }
      }
      phase = 'idle';
      renderAll();
      syncStage();
      toast(err && err.beforeDraw ? why : `這一抽中斷了，沒有產生結果：${why}`, { tone: 'error', timeout: 0 });
      return;
    }

    record.status = 'valid';
    record.drawnAt = new Date().toISOString();
    try { await assertLock(); } catch (err) {
      if (recorder) recorder.cancel();
      stage.setRecording(null);
      record.status = 'pending';
      staleState = true;
      phase = 'idle';
      renderAll();
      syncStage();
      toast(err.message || String(err), { tone: 'error', timeout: 0 });
      return;
    }
    if (!persist(true)) {
      if (recorder) recorder.cancel();
      stage.setRecording(null);
      record.status = 'aborted';
      record.abortReason = '轉盤停止後無法保存有效中獎結果';
      record.video = recorder ? { state: 'failed', error: '結果儲存失敗，錄影已取消' } : { state: 'none' };
      persist(true); // the previously saved pending record still becomes aborted after a reload
      phase = 'idle';
      renderAll();
      syncStage();
      stage.setView({ readout: { label: '結果未保存，抽獎中斷', text: null, tone: 'muted' } });
      toast('轉盤已停止，但有效中獎結果無法保存，因此這一抽已標記為中斷。請先檢查儲存空間並匯出憑證包。', { tone: 'error', timeout: 0 });
      return;
    }

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
      await finishRecording(record, recorder);
    }
    phase = 'result';
    ensureCurrentPrize();
    persist();
    renderAll();
  }

  async function runPreflight() {
    if (busy()) return;
    checking = true;
    preflightCurrent = false;
    $('#preflight-results').replaceChildren();
    renderAll();
    try {
    const checks = [];
    const add = (ok, message) => checks.push({ ok, message });
    add(!state.sample, state.sample ? '目前仍是範例資料' : '已使用正式資料');
    add(state.prizes.length > 0 && state.prizes.every((p) => p.name.trim() && p.qty > 0), '獎項名稱與名額完整');
    add(people().length > 0, `名單有 ${people().length} 人`);
    add(state.rosterKeyScheme === 2, state.rosterKeyScheme === 2 ? '名單識別鍵不會互相衝突' : '舊版場次的姓名識別鍵有衝突；請先備份，再重設抽獎');
    const rosterIssue = LW.rosterIdentifierIssue(people());
    add(!rosterIssue, rosterIssue || '名單姓名、組別與識別鍵可完整保存');
    const duplicates = duplicateNames();
    add(!duplicates.length, duplicates.length ? `${duplicates.length} 個名字重複，請確認是否為不同的人` : '名單沒有完全相同的名字');
    for (const prize of state.prizes) {
      const available = candidates(prize).length;
      const left = remaining(prize);
      const repeat = LW.allowsRepeat(prize, state.settings);
      add(!left || (available > 0 && (repeat || available >= left)),
        `「${prizeLabel(prize)}」可抽 ${available} 人、尚有 ${left} 個名額${repeat ? '（允許重複中獎）' : ''}`);
    }
    const exclusiveDemands = state.prizes.filter((prize) =>
      remaining(prize) > 0 && !LW.allowsRepeat(prize, state.settings))
      .map((prize) => ({ group: prize.eligibleGroup, count: remaining(prize) }));
    if (exclusiveDemands.length) {
      const capacity = LW.exclusiveCapacity(people(), state.records, exclusiveDemands);
      add(capacity.available >= capacity.required, `排除重複中獎的獎項尚有 ${capacity.required} 個名額，目前未占用名單有 ${capacity.available} 人`);
      for (const group of capacity.groups) add(group.available >= group.required,
        `「${group.group}」組的排除重複中獎獎項合計尚有 ${group.required} 個名額，目前可用 ${group.available} 人`);
      const orderRisks = LW.drawOrderRisks(people(), state.records, state.prizes, state.settings);
      if (orderRisks.repeatBeforeExclusive) add(false,
        '依目前獎項順序，先抽允許重複中獎的獎，可能用掉後續排除重複獎需要的人；請先抽排除重複的獎項');
      for (const group of orderRisks.groups) add(false,
        `依目前獎項順序，「${group}」組的人可能先被不限組別或允許重複中獎的獎抽走；請先抽該組的限組獎`);
    }
    add(!state.settings.record || LW.Recorder.supported(), '此瀏覽器可執行目前的錄影設定');
    await LW.Vault.ready();
    await recoverRecordings();
    add(LW.Vault.durable, '錄影與候選快照可長期保存於此瀏覽器');
    add(!storageProblem, storageProblem ? '原場次資料無法安全讀取，請先依上方提示處理' : '原場次資料可安全讀取');
    const canSave = storageProblem ? false : persist(true);
    storageError = !canSave;
    renderControls();
    renderSettings();
    add(canSave, '場次設定可寫入瀏覽器');
    const snapshotIssues = [];
    const videoIssues = [];
    for (const [index, record] of state.records.entries()) {
      $('#preflight-results').textContent = `正在查核既有抽次 ${index + 1}/${state.records.length}…`;
      const saved = await LW.Vault.get(record.id);
      const evidence = await LW.inspectDrawEvidence(record, saved, { allowDuplicateKeys: state.rosterKeyScheme === 1 });
      if (evidence.errors.length) snapshotIssues.push(`第 ${record.seq} 抽：${evidence.errors.join('、')}`);
      if (record.video?.state === 'ready') {
        try {
          if (!await LW.verifiedVideo(saved, record.video)) videoIssues.push(`第 ${record.seq} 抽：錄影已遺失`);
        } catch (err) {
          videoIssues.push(`第 ${record.seq} 抽：${err.message || err}`);
        }
      }
    }
    const evidenceIssues = [...snapshotIssues, ...videoIssues];
    add(!evidenceIssues.length, evidenceIssues.length
      ? `既有紀錄有 ${snapshotIssues.length} 份候選快照異常、${videoIssues.length} 段錄影遺失或不符；${evidenceIssues.slice(0, 3).join('；')}${evidenceIssues.length > 3 ? '；其餘請逐抽查核' : ''}`
      : '既有紀錄的候選快照與錄影大小、SHA-256 均符合紀錄');
    if (navigator.storage && navigator.storage.estimate) {
      try {
        const { usage, quota } = await navigator.storage.estimate();
        const available = quota - usage;
        add(Number.isFinite(available) && available > (state.settings.record ? 250 : 1) * 1024 * 1024, Number.isFinite(available) ? `可用瀏覽器空間約 ${LW.formatBytes(Math.max(0, available))}` : '瀏覽器沒有回報可用空間');
      } catch (_) { add(false, '無法查詢可用瀏覽器空間'); }
    }
    const stillCurrent = !staleState && freshStore();
    add(stillCurrent, stillCurrent ? '檢查期間場次沒有被其他分頁更新' : '檢查期間場次已變更，請重新整理後再檢查');
    $('#preflight-results').innerHTML = checks.map((c) => `<li class="${c.ok ? 'check-ok' : 'check-bad'}">${c.ok ? '通過' : '注意'}：${esc(c.message)}</li>`).join('');
    preflightCurrent = stillCurrent;
    toast(checks.every((c) => c.ok) ? '活動前檢查通過' : `活動前檢查有 ${checks.filter((c) => !c.ok).length} 項需要處理`, { tone: checks.every((c) => c.ok) ? 'info' : 'error' });
    } catch (err) {
      const item = document.createElement('li');
      item.className = 'check-bad';
      item.textContent = `活動前檢查未完成：${err.message || err}`;
      $('#preflight-results').replaceChildren(item);
      toast(`活動前檢查未完成：${err.message || err}`, { tone: 'error' });
    } finally {
      checking = false;
      renderAll();
    }
  }

  async function rehearse() {
    if (busy()) return;
    LW.Sound.unlock();
    leaveResult();
    const blocker = drawBlocker();
    if (blocker) { toast(blocker, { tone: 'error' }); return; }
    const prize = currentPrize();
    const names = candidates().map((p) => p.name);
    phase = 'rehearsal';
    renderAll();
    let probe = null;
    try {
      stage.clearResult();
      stage.setLabels(names);
      stage.setView({
        title: `預演 · ${state.title.trim()}`,
        drawNo: state.records.length + 1,
        sessionId: state.session.id,
        candidateCount: names.length,
        fingerprint: await LW.sha256Hex(names.join('\n')),
        prize: { name: prizeLabel(prize), total: prize.qty, remaining: remaining(prize) },
        prizeWinners: winnersOf(prize.id),
        readout: { label: '預演，不計入紀錄', text: null, tone: 'muted' },
      });
      if (state.settings.record) {
        probe = LW.Recorder.start(el.canvas, { audioTrack: LW.Sound.track() });
        stage.setRecording(probe.startedAt);
      }
      await stage.spinTo(Math.floor(names.length / 2), Math.min(5000, state.settings.spinSeconds * 1000));
      stage.setView({ readout: { label: '預演完成，不計入紀錄', text: null, tone: 'muted' } });
      if (probe) {
        const testVideo = await probe.stop();
        if (!testVideo.blob.size) throw new Error('預演錄影沒有產生檔案');
        probe = null;
        stage.setRecording(null);
      }
      announce('預演完成。抽獎紀錄與獎項名額沒有變動。');
      toast(state.settings.record ? '預演完成；轉盤與錄影功能可用，紀錄沒有變動。' : '預演完成；轉盤流程可用，紀錄沒有變動。');
      await LW.wait(1500);
    } catch (err) {
      if (probe) probe.cancel();
      toast(`預演失敗：${err.message || err}`, { tone: 'error' });
    } finally {
      stage.setRecording(null);
      phase = 'idle';
      stage.clearResult();
      stage.setLabels([]);
      renderAll();
      syncStage();
    }
  }

  async function finishRecording(record, recorder) {
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
      await LW.Vault.update(record.id, { video: out.blob, videoMeta: { ...record.video } });
      const volatile = !LW.Vault.durable;
      let downloadError = null;
      if (state.settings.autoDownload || volatile) {
        try {
          LW.download(out.blob, file);
          record.video.downloaded = true;
        } catch (err) {
          downloadError = err;
        }
      }
      const metadataSaved = persist(true);
      if (!metadataSaved) {
        toast(`第 ${record.seq} 抽的錄影已產生，但雜湊值無法保存到瀏覽器紀錄。${downloadError ? '自動下載也失敗，請到「紀錄」手動下載。' : ''}請保持頁面開啟並立即匯出憑證包。`, { tone: 'error', timeout: 0 });
      } else if (downloadError) {
        toast(`第 ${record.seq} 抽的錄影無法自動下載（${downloadError.message || downloadError}）。請立即到「紀錄」手動下載。`, { tone: 'error', timeout: 0 });
      } else if (volatile) {
        toast(`第 ${record.seq} 抽的錄影只暫存在記憶體，已要求瀏覽器下載。請確認下載資料夾有檔案，重新整理前再匯出憑證包。`, { tone: 'error', timeout: 0 });
      } else {
        toast(state.settings.autoDownload
          ? `第 ${record.seq} 抽的錄影已要求下載（${LW.formatBytes(out.blob.size)}）`
          : `第 ${record.seq} 抽的錄影已存好，可以在「紀錄」下載`, { timeout: 4000 });
      }
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

  async function recoverRecordings() {
    const missing = state.records.filter((record) =>
      (record.status === 'valid' || record.status === 'void') && record.video?.state === 'failed');
    if (!missing.length) return;
    const recovered = [];
    for (const record of missing) {
      const snapshot = await LW.Vault.get(record.id);
      const video = await LW.recoverVideo(snapshot);
      if (video) recovered.push({ record, video });
    }
    if (!recovered.length) return;
    if (staleState || !freshStore()) {
      markStale();
      return;
    }
    for (const entry of recovered) {
      entry.previous = entry.record.video;
      entry.record.video = entry.video;
    }
    const saved = persist(true);
    if (!saved && staleState) {
      for (const { record, previous } of recovered) record.video = previous;
    }
    toast(saved
      ? `已驗證並恢復 ${recovered.length} 段先前未完成的錄影。`
      : staleState
        ? '已找回錄影，但另一個分頁更新了場次。請重新整理後再檢查。'
        : `已找回 ${recovered.length} 段錄影，但瀏覽器無法更新紀錄。請立刻匯出憑證包。`,
    { tone: saved ? 'info' : 'error', timeout: saved ? 6000 : 0 });
  }

  /* =================================================================== exports */

  function csvRows() {
    const rows = [[...LW.AUDIT_CSV_HEADER]];
    for (const r of state.records) {
      if (r.status === 'pending') continue;
      const v = r.video || {};
      const ready = v.state === 'ready';
      const note = r.status === 'void'
        ? `${r.voidReason || ''}${r.returnToPool ? '（已放回名單）' : ''}`
        : r.status === 'aborted' ? `抽獎中斷：${r.abortReason || ''}` : '';
      rows.push([
        r.seq, r.prizeName, r.name, new Date(r.drawnAt).toISOString(), STATUS_LABEL[r.status] || r.status, note,
        r.candidateCount, r.candidatesHash, ready ? v.file : '', ready ? v.sha256 : '', state.session.id,
      ]);
    }
    return rows;
  }

  const eventSlug = () => LW.safeFilename(state.title.trim() || '抽獎', 30);

  function exportCSV() {
    if (!state.records.length || busy()) return;
    if (storageProblem || staleState || !freshStore()) {
      toast('場次資料已變更或無法安全讀取，請重新整理後再匯出完整抽次紀錄。', { tone: 'error' });
      return;
    }
    const blob = new Blob([LW.toCSV(csvRows())], { type: 'text/csv;charset=utf-8' });
    LW.download(blob, `完整抽次紀錄_${eventSlug()}_${LW.fileStamp()}.csv`);
  }

  function exportValidWinners() {
    if (busy() || !state.records.some((record) => record.status === 'valid')) return;
    if (storageProblem || staleState || !freshStore()) {
      toast('場次資料已變更或無法安全讀取，請重新整理後再匯出有效得獎名單。', { tone: 'error' });
      return;
    }
    try {
      const csv = LW.toCSV(LW.validWinnersRows(state.records, state.session.id));
      LW.download(new Blob([csv], { type: 'text/csv;charset=utf-8' }),
        `有效得獎名單_${eventSlug()}_${LW.fileStamp()}.csv`);
    } catch (err) {
      toast(`有效得獎名單無法匯出：${err.message || err}`, { tone: 'error' });
    }
  }

  function printValidWinners() {
    if (busy() || !state.records.some((record) => record.status === 'valid')) return;
    if (storageProblem || staleState || !freshStore()) {
      toast('場次資料已變更或無法安全讀取，請重新整理後再列印發獎核對表。', { tone: 'error' });
      return;
    }
    try {
      const rows = LW.validWinnersRows(state.records, state.session.id).slice(1);
      el.printSheet.innerHTML = `
        <header class="print-sheet__head">
          <h1>${esc(state.title.trim() || '抽獎')}・發獎核對表</h1>
          <p>場次 ${esc(state.session.id)}　有效得獎 ${rows.length} 筆　列印時間 ${esc(LW.formatDateTime(new Date()))}（本機時間）</p>
        </header>
        <table class="print-sheet__table">
          <thead><tr><th scope="col">抽次</th><th scope="col">獎項</th><th scope="col">得獎者／識別鍵</th><th scope="col">抽出時間（本機）</th><th scope="col">領取簽名</th></tr></thead>
          <tbody>${rows.map(([seq, prize, , name, key, drawnAt]) => `
            <tr><td>#${esc(seq)}</td><td>${esc(prize)}</td><td><strong>${esc(name)}</strong><small>${esc(key)}</small></td>
            <td>${esc(LW.formatDateTime(drawnAt))}</td><td class="print-sheet__signature"></td></tr>`).join('')}</tbody>
        </table>
        <p class="print-sheet__note">本表只供人工發獎核對；簽收不會寫回抽獎紀錄。若有作廢或重抽，請重新列印。</p>`;
      document.body.classList.add('is-printing-winners');
      window.print();
    } catch (err) {
      document.body.classList.remove('is-printing-winners');
      el.printSheet.replaceChildren();
      toast(`發獎核對表無法列印：${err.message || err}`, { tone: 'error' });
    }
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
      candidateKeys: snap && snap.candidateKeys ? snap.candidateKeys : null,
      winnerKey: r.key,
      eligibility: r.rule || null,
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
      format: 'lucky-wheel-audit/2',
      exportedAt: now.toISOString(),
      event: { title: state.title.trim(), sessionId: state.session.id, sessionCreatedAt: state.session.createdAt },
      method: {
        random: 'Web Crypto crypto.getRandomValues()，以拒絕取樣產生均勻整數（沒有模數偏差）。winnerIndex 是中獎者在 candidates 裡的位置，從 0 起算。',
        candidatesSha256: 'SHA-256(UTF-8(candidates 依轉盤順序以換行字元 \\n 連接))，與錄影畫面下方的「名單指紋」相同。',
        eligibility: '每抽的 eligibility 保存限定組別與曾中獎者規則；candidateKeys 保存實際候選人的識別鍵。',
        recording: '每一抽自動錄下 1920×1080 的轉盤畫面，從轉動前 1 秒錄到結果後 3 秒；檔案的 SHA-256 記在 video.sha256。',
      },
      prizes: state.prizes.map((p) => ({ id: p.id, name: prizeLabel(p), quantity: p.qty, eligibleGroup: p.eligibleGroup || '', repeatPolicy: p.repeatPolicy || 'inherit', drawn: drawnCount(p.id) })),
      participants: people().map((p) => p.name),
      participantDetails: people().map((p) => ({ name: p.name, group: p.group, key: p.key })),
      draws,
    };
  }

  function readmeText(now, draws, missing, snapshotIssues = []) {
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
      '中獎名單.csv　每一抽的獎項、中獎者、UTC 時間、錄影檔名與 SHA-256，可直接用 Excel 開啟。',
      '抽獎紀錄.json　完整稽核紀錄，含每一抽當下的候選名單（candidates）。',
      '場次狀態.json　完整場次設定、獎項、名單與抽獎紀錄，可在「設定 → 還原場次備份」讀取。',
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
      '整包驗證：在抽獎轉盤程式資料夾開啟 verify.html，選擇這份 ZIP，可在離線電腦上檢查候選名單、結果與錄影。',
      '整包 ZIP 的 SHA-256 會顯示在匯出後的「紀錄」面板；請在活動時用獨立管道公開，驗證者可在 verify.html 輸入比對。',
      '',
      '【確認候選名單】',
      '錄影畫面下方的「名單指紋」是那一抽候選名單的 SHA-256 前後各 8 碼。',
      '把 抽獎紀錄.json 中該抽的 candidates 依序以換行字元連接（最後不加換行）後計算 SHA-256，',
      '結果應與 candidatesSha256 完全相同；winnerIndex 指出中獎者在名單中的位置（從 0 起算）。',
      '驗證只確認憑證包內部一致性；若整包被重建，仍需與活動當時公開的雜湊值比對。',
    ];
    if (missing.length) {
      lines.push('', '【注意】下列錄影不在匯出時的瀏覽器中，沒有包含在這個憑證包裡，請到當時的下載資料夾尋找：');
      for (const r of missing) lines.push(`  第 ${r.seq} 抽：${r.video.file}（SHA-256 ${r.video.sha256}）`);
    }
    if (snapshotIssues.length) {
      lines.push('', `【注意】${snapshotIssues.length} 份候選快照與抽獎紀錄不一致或已遺失，這份憑證包無法通過完整驗證：`);
      for (const issue of snapshotIssues.slice(0, 100)) lines.push(`  第 ${issue.seq} 抽：${issue.errors.join('；')}`);
      if (snapshotIssues.length > 100) lines.push(`  其餘 ${snapshotIssues.length - 100} 份請在獨立驗證頁逐抽檢查。`);
    }
    return lines.join('\r\n') + '\r\n';
  }

  async function exportPackage(force = false) {
    if (zipping || busy() || (!force && !state.records.length)) return;
    zipping = true;
    renderAll();
    const label = el.exportZip.querySelector('.btn__label');
    el.exportZip.disabled = true;
    el.exportZip.setAttribute('aria-busy', 'true');
    label.textContent = '打包中';
    try {
      await LW.DrawGate.run(state.session.id, async (assertLock) => {
        await assertLock();
        if (storageProblem || staleState || !freshStore()) throw new Error('場次資料已變更或無法安全讀取，請重新整理後再匯出');
        const now = new Date();
        const folder = LW.safeFilename(`抽獎憑證包_${eventSlug()}_${LW.fileStamp(now)}`, 80);
        const videos = [];
        const sums = [];
        const missing = [];
        const snapshotIssues = [];
        const draws = [];
        for (const [index, r] of state.records.entries()) {
          if (index % 25 === 0) {
            await assertLock();
            label.textContent = `查核抽次 ${index + 1}/${state.records.length}`;
          }
          const snap = await LW.Vault.get(r.id);
          draws.push(auditDraw(r, snap));
          const evidence = await LW.inspectDrawEvidence(r, snap, { allowDuplicateKeys: state.rosterKeyScheme === 1 });
          if (evidence.errors.length) snapshotIssues.push({ seq: r.seq, errors: evidence.errors });
          if (r.video && r.video.state === 'ready') {
            const file = cleanVideoFile(r.video.file); // never let a stored name leave the ZIP folder
            let video;
            try { video = await LW.verifiedVideo(snap, r.video); }
            catch (err) { throw new Error(`第 ${r.seq} 抽的錄影無法通過驗證：${err.message || err}`); }
            if (video) {
              sums.push(`${r.video.sha256}  錄影/${file}`);
              videos.push({ name: `${folder}/錄影/${file}`, data: video, record: r });
            } else missing.push(r);
          }
        }
        const entries = [
          { name: `${folder}/中獎名單.csv`, data: LW.toCSV(csvRows()) },
          { name: `${folder}/抽獎紀錄.json`, data: JSON.stringify(auditDoc(draws, now), null, 2) },
          { name: `${folder}/場次狀態.json`, data: JSON.stringify({ format: 'lucky-wheel-session/1', exportedAt: now.toISOString(), state }, null, 2) },
          { name: `${folder}/SHA256SUMS.txt`, data: sums.length ? `${sums.join('\n')}\n` : '' },
          { name: `${folder}/驗證說明.txt`, data: readmeText(now, draws, missing, snapshotIssues) },
          ...videos,
        ];
        const zip = await LW.makeZip(entries, {
          date: now,
          onProgress: (done, total) => { label.textContent = `打包中 ${Math.floor((done / Math.max(1, total)) * 100)}%`; },
        });
        label.textContent = '計算整包指紋';
        const packageHash = await LW.sha256Hex(zip);
        await assertLock();
        if (storageProblem || staleState || !freshStore()) throw new Error('打包期間場次資料已變更，請重新整理後重新匯出');
        const fileName = `${folder}.zip`;
        LW.download(zip, fileName);
        exportReceipt = LW.normalizeExportReceipt({ sessionId: state.session.id, fileName, sha256: packageHash, exportedAt: now.toISOString() }, state.session.id);
        exportReceiptSaved = LW.Store.setPref('lastExportReceipt', exportReceipt);
        for (const v of videos) v.record.video.downloaded = true;
        persist(true);
        if (missing.length || snapshotIssues.length || !exportReceiptSaved) {
          const evidenceProblems = [
            missing.length ? `${missing.length} 段錄影未包含` : '',
            snapshotIssues.length ? `${snapshotIssues.length} 份候選快照異常` : '',
          ].filter(Boolean);
          const incomplete = evidenceProblems.length
            ? `${evidenceProblems.join('、')}；這份備份無法通過完整驗證` : '';
          const unsaved = exportReceiptSaved ? '' : '指紋收據無法留存在瀏覽器，請立即下載文字收據';
          toast(`憑證包已下載，但${[incomplete, unsaved].filter(Boolean).join('；')}。`, { tone: 'error', timeout: 0 });
        } else {
          toast(`憑證包已下載（${LW.formatBytes(zip.size)}）`);
        }
      });
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

  let inspectedBackup = null;
  async function chooseBackup(file) {
    if (!file || busy()) return;
    clearing = true;
    renderAll();
    try {
      const result = await LW.inspectPackage(file);
      if (result.errors.length) throw new Error(result.errors.slice(0, 3).join('；'));
      if (!result.state) throw new Error('這份憑證包沒有完整場次狀態，無法還原');
      const s = result.state;
      if (!Array.isArray(s.prizes) || !Array.isArray(s.records) || typeof s.people !== 'string' || !s.settings || s.prizes.length > 1000 || s.records.length > 100000 || s.people.length > 2000000 || !s.session?.id ||
        s.prizes.some((p) => !p || typeof p.id !== 'string' || !p.id || typeof p.name !== 'string' || !Number.isInteger(p.qty) || p.qty < 1 || p.qty > 999) ||
        new Set(s.prizes.map((p) => p.id)).size !== s.prizes.length ||
        s.records.some((r, i) => !r || !r.id || r.seq !== i + 1 || !['valid', 'void', 'aborted'].includes(r.status) || (r.video?.state === 'ready' && (cleanVideoFile(r.video.file) !== r.video.file || !sha(r.video.sha256)))) ||
        new Set(s.records.map((r) => r.id)).size !== s.records.length) throw new Error('場次狀態資料不完整、識別碼重複或超出限制');
      inspectedBackup = result;
      const missing = result.warnings.filter((line) => line.includes('錄影未包含')).length;
      const collidingKeys = s.records.length > 0 && result.warnings.some((line) => line.includes('識別鍵發生衝突'));
      $('#restore-summary').textContent = `活動：${s.title || '未命名'}；場次：${s.session.id}；${s.prizes.length} 項獎品、${s.records.length} 抽。${missing ? `${missing} 段錄影缺少，只能還原紀錄。` : '錄影齊全。'}${collidingKeys ? ' 舊版名單識別鍵衝突；還原後須重設場次才能繼續抽獎。' : ''}${storageProblem ? ' 目前儲存的場次無法讀取；還原會取代原始資料，建議先下載原始資料。' : ''}`;
      $('#restore-confirm').value = '';
      $('#restore-go').disabled = true;
      openDialog($('#dlg-restore'));
    } catch (err) {
      inspectedBackup = null;
      toast(`無法讀取場次備份：${err.message || err}`, { tone: 'error', timeout: 0 });
    } finally {
      clearing = false;
      renderAll();
    }
  }

  async function restoreBackup() {
    if (busy() || !inspectedBackup || $('#restore-confirm').value.trim() !== '還原') return;
    const backup = inspectedBackup;
    $('#dlg-restore').close();
    clearing = true;
    renderAll();
    try {
      clearTimeout(saveTimer);
      const incoming = backup.state.records.map((r) => ({
        id: r.id,
        candidates: backup.snapshots.get(r.id) || null,
        candidateKeys: backup.audit.draws.find((d) => d.id === r.id)?.candidateKeys || null,
        video: r.video?.state === 'ready' ? backup.files.get(`${backup.prefix}錄影/${r.video.file}`) || null : null,
      }));
      const restored = sanitizeState(backup.state);
      await LW.DrawGate.run(state.session.id, async (assertLock) => {
        await assertLock();
        if (!freshStore()) throw new Error('另一個分頁已更新此場次，請重新整理後再還原');
        await LW.replaceSession(state, restored, incoming, { store: { save: (next) => saveSessionState(next, { allowRecovery: true }) } });
      });
      Object.assign(state, restored);
      peopleCache = { text: null, list: [] };
      fpKey = null;
      phase = 'idle';
      stage.clearResult();
      LW.Sound.setEnabled(state.settings.sound);
      ensureCurrentPrize();
      storageError = false;
      inspectedBackup = null;
      renderAll();
      syncStage();
      toast(`已還原場次 ${state.session.id}，共 ${state.records.length} 抽。`);
    } catch (err) {
      toast(`還原失敗：${err.message || err}`, { tone: 'error', timeout: 0 });
    } finally {
      clearing = false;
      renderAll();
    }
  }

  /* =================================================================== videos */

  async function videoBlob(record) {
    try {
      const snap = await LW.Vault.get(record.id);
      const video = await LW.verifiedVideo(snap, record.video);
      if (video) return video;
    } catch (err) {
      toast(`第 ${record.seq} 抽的錄影無法安全讀取：${err.message || err}。請檢查先前下載的檔案。`, { tone: 'error', timeout: 0 });
      return null;
    }
    toast(`這段錄影已經不在瀏覽器裡。若當時有自動下載，請到下載資料夾找「${record.video.file}」。`, { tone: 'error', timeout: 0 });
    return null;
  }

  async function saveVideo(id) {
    const r = state.records.find((x) => x.id === id);
    if (!r || !r.video || r.video.state !== 'ready') return;
    const blob = await videoBlob(r);
    if (!blob) return;
    LW.download(blob, cleanVideoFile(r.video.file));
    if (canEditSession()) {
      const previous = r.video.downloaded;
      r.video.downloaded = true;
      if (!persist(true)) r.video.downloaded = previous;
    }
    renderRecords();
    renderStorageInfo();
  }

  function fillMeta(dl, rows) {
    dl.innerHTML = rows.map(([k, v, mono]) => `<dt>${esc(k)}</dt><dd${mono ? ' class="mono"' : ''}>${esc(v)}</dd>`).join('');
  }

  let evidenceRequest = 0;
  let activeDrawEvidence = null;
  async function showDrawEvidence(id) {
    const record = state.records.find((item) => item.id === id);
    if (!record || record.status === 'pending' || busy()) return;
    const sessionId = state.session.id;
    const request = ++evidenceRequest;
    const dlg = el.dlgEvidence;
    const status = $('#evidence-status');
    const preview = $('#evidence-preview');
    activeDrawEvidence = null;
    dlg.classList.remove('is-ok', 'is-bad');
    $('#dlg-evidence-title').textContent = `第 ${record.seq} 抽・候選快照查核`;
    status.textContent = '正在讀取並重新計算候選名單指紋…';
    $('#evidence-meta').replaceChildren();
    preview.replaceChildren();
    $('#evidence-download').disabled = true;
    openDialog(dlg);
    try {
      const snapshot = await LW.Vault.get(record.id);
      const result = await LW.inspectDrawEvidence(record, snapshot, { allowDuplicateKeys: state.rosterKeyScheme === 1 });
      if (request !== evidenceRequest || !dlg.open || state.session.id !== sessionId) return;
      dlg.classList.toggle('is-ok', !result.errors.length);
      dlg.classList.toggle('is-bad', !!result.errors.length);
      status.textContent = result.errors.length
        ? `查核未通過：${result.errors.join('；')}`
        : `候選快照與本機抽獎紀錄一致${result.warnings.length ? `；注意：${result.warnings.join('；')}` : ''}。`;
      fillMeta($('#evidence-meta'), [
        ['獎項', record.prizeName],
        ['中獎者', record.name],
        ['候選人數與中獎位置', `${record.candidateCount} 人・第 ${record.index + 1} 位`],
        ['當時資格規則', record.rule
          ? `${record.rule.eligibleGroup || '不限組別'}・${record.rule.allowRepeat ? '允許曾中獎者再參加' : '排除曾中獎者'}`
          : '未記錄（舊版場次）'],
        ['紀錄 SHA-256', record.candidatesHash || '未提供', true],
        ['快照 SHA-256', result.actualHash || '無法計算', true],
      ]);
      if (Array.isArray(result.candidates)) {
        preview.replaceChildren(...result.candidates.slice(0, 20).map((name, index) => {
          const item = document.createElement('li');
          const key = Array.isArray(result.candidateKeys) && typeof result.candidateKeys[index] === 'string' ? result.candidateKeys[index] : '';
          item.textContent = `${String(name)}${key ? `（${key}）` : ''}${index === record.index ? '・中獎位置' : ''}`;
          if (index === record.index) item.classList.add('is-winner');
          return item;
        }));
      }
      if (!result.errors.length) {
        activeDrawEvidence = { record, result, sessionId };
        $('#evidence-download').disabled = false;
      }
    } catch (err) {
      if (request !== evidenceRequest || !dlg.open) return;
      dlg.classList.add('is-bad');
      status.textContent = `查核無法完成：${err.message || err}`;
    }
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
    if (!r || r.status !== 'valid' || !canEditSession()) return;
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
    if (!r || r.status !== 'valid' || !canEditSession()) return;
    const form = $('form', dlg);
    const index = state.records.indexOf(r);
    const previousPrizeId = state.currentPrizeId;
    state.records[index] = {
      ...r,
      status: 'void',
      voidReason: form.elements.reason.value.trim() || '未註明',
      voidAt: new Date().toISOString(),
      returnToPool: form.elements.back.checked,
    };
    state.currentPrizeId = r.prizeId; // the freed slot is usually redrawn right away
    if (!persist(true)) {
      state.records[index] = r;
      state.currentPrizeId = previousPrizeId;
      renderAll();
      syncStage();
      toast('作廢狀態無法保存，這一抽仍保持有效；請先修復瀏覽器儲存問題。', { tone: 'error', timeout: 0 });
      return;
    }
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
      clearTimeout(saveTimer);
      const next = { ...state, records: [], rosterKeyScheme: 2, session: newSession(), currentPrizeId: state.prizes[0]?.id || null };
      await LW.DrawGate.run(state.session.id, async (assertLock) => {
        await assertLock();
        if (!freshStore()) throw new Error('另一個分頁已更新此場次，請重新整理後再重設');
        await LW.replaceSession(state, next, [], { store: { save: saveSessionState } });
      });
      Object.assign(state, next);
      storageError = false;
      leaveResult();
      toast(`已重設。新的場次代碼是 ${state.session.id}。`);
    } catch (err) {
      toast(`重設失敗：${err.message || err}`, { tone: 'error', timeout: 0 });
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
      clearTimeout(saveTimer);
      const next = { ...state, title: '', prizes: [], people: '', records: [], rosterKeyScheme: 2, currentPrizeId: null, session: newSession(), sample: false };
      await LW.DrawGate.run(state.session.id, async (assertLock) => {
        await assertLock();
        if (!freshStore()) throw new Error('另一個分頁已更新此場次，請重新整理後再清除範例');
        await LW.replaceSession(state, next, [], { store: { save: saveSessionState } });
      });
      Object.assign(state, next);
      storageError = false;
      leaveResult();
      selectTab('prizes');
      $('#prize-add').focus();
    } catch (err) {
      toast(`清除範例失敗：${err.message || err}`, { tone: 'error', timeout: 0 });
    } finally {
      clearing = false;
      renderAll();
      syncStage();
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
    if (!canEditSession()) { renderControls(); return; }
    state.currentPrizeId = el.prizeSelect.value;
    persist();
    leaveResult();
    syncStage();
    renderControls();
    renderPrizes();
  });

  function setSound(on) {
    if (!canEditSession(true)) return;
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
  $('#projection-open').addEventListener('click', () => {
    if (projectionWindow && !projectionWindow.closed) { projectionWindow.focus(); return; }
    projectionWindow = window.open('projection.html', 'lucky-wheel-projection', 'popup,width=1280,height=720');
    if (!projectionWindow) toast('瀏覽器阻擋了投影視窗，請允許這個網站開啟彈出視窗。', { tone: 'error' });
    else stage.setView({});
  });
  window.addEventListener('message', (event) => {
    if (event.data?.type !== 'lucky-wheel-projection-ready' || !event.source ||
      (location.protocol !== 'file:' && event.origin !== location.origin)) return;
    try {
      const expected = new URL('projection.html', document.baseURI).href;
      if (event.source.location.href !== expected || !event.source.document.getElementById('projection-canvas')) return;
      projectionWindow = event.source;
      stage.setView({});
    } catch (_) { /* only a same-origin projection window can reconnect */ }
  });
  document.addEventListener('fullscreenchange', () => {
    if (!document.fullscreenElement && el.app.classList.contains('is-presenting')) setPresenting(false);
  });

  document.addEventListener('keydown', (e) => {
    const action = LW.shortcutAction(e, { modalOpen: !!document.querySelector('dialog[open]') });
    if (action === 'draw') {
      e.preventDefault();
      startDraw();
    } else if (action === 'present') {
      setPresenting(!el.app.classList.contains('is-presenting'));
    } else if (action === 'close-result' && phase === 'result') {
      leaveResult();
      syncStage();
    }
  });

  /* =================================================================== events: panels */

  $('#sample-clear').addEventListener('click', clearSample);

  // prizes
  $('#prize-add').addEventListener('click', () => {
    if (!canEditSession()) return;
    const p = { id: LW.uid('prize'), name: '', qty: 1, eligibleGroup: '', repeatPolicy: 'inherit' };
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
    if (!canEditSession()) { renderPrizes(); return; }
    if (e.target.dataset.field === 'name') {
      p.name = e.target.value;
      rowError(row, '');
    } else if (e.target.dataset.field === 'group') {
      if (state.records.some((r) => r.prizeId === p.id)) return;
      p.eligibleGroup = e.target.value.trim();
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
    if (!canEditSession()) { renderPrizes(); return; }
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
    } else if (e.target.dataset.field === 'repeat') {
      if (state.records.some((r) => r.prizeId === p.id)) return;
      p.repeatPolicy = e.target.value;
      persist();
      renderPeopleMeta();
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
    if (!canEditSession()) return;
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
    if (!canEditSession() || rosterLocked()) {
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

  let pendingPeopleImport = null;
  const importDialog = $('#dlg-people-import');
  importDialog.addEventListener('close', () => { pendingPeopleImport = null; });
  $('#people-import').addEventListener('click', () => el.filePeople.click());

  el.filePeople.addEventListener('change', async () => {
    const file = el.filePeople.files[0];
    el.filePeople.value = '';
    if (!file) return;
    if (file.size > MAX_IMPORT_BYTES) {
      toast('名單檔案超過 32 MB，請移除不需要的欄位後再匯入。', { tone: 'error' });
      return;
    }
    try {
      const text = LW.decodeText(await file.arrayBuffer());
      if (busy() || rosterLocked()) return;
      const isTable = LW.rosterImportIsTable(file.name, file.type, text);
      const rows = isTable ? LW.parseCSV(text) : text.split(/\r?\n/).map((line) => [line]);
      const imported = LW.rosterImportFromRows(rows, isTable);
      if (!imported.lines.length) throw new Error('沒有讀到任何名字。請確認每行一位，或 CSV 每一列是一個人');
      const next = imported.lines.join('\n');
      if (next.length > MAX_PEOPLE_CHARS) throw new Error('匯入名單超過可保存的長度，請先縮短或分批整理名單');
      pendingPeopleImport = { text: next, fileName: file.name, count: imported.lines.length };
      $('#people-import-summary').textContent = `「${file.name}」共 ${imported.lines.length} 人。確認後會取代目前 ${people().length} 人；下方預覽前 ${Math.min(8, imported.lines.length)} 人。`;
      $('#people-import-columns').textContent = isTable
        ? imported.hasNameHeader
          ? `辨識欄位：姓名${imported.hasIdColumn ? '、編號' : ''}${imported.hasGroupColumn ? '、組別' : ''}；其他欄位不匯入。`
          : '未辨識到姓名表頭，會把每列的欄位合併為一位參加者。'
        : '文字檔每行匯入一位參加者。';
      const warning = $('#people-import-warning');
      warning.hidden = !isTable || imported.hasNameHeader;
      warning.textContent = warning.hidden ? '' : '請確認預覽中沒有電話、Email 等不應顯示在轉盤上的資料。';
      const preview = $('#people-import-preview');
      preview.replaceChildren(...imported.lines.slice(0, 8).map((line) => {
        const item = document.createElement('li');
        item.textContent = line;
        return item;
      }));
      openDialog(importDialog);
    } catch (err) {
      pendingPeopleImport = null;
      toast(`無法匯入「${file.name}」：${err.message || err}`, { tone: 'error', timeout: 0 });
    }
  });

  $('#people-import-confirm').addEventListener('click', () => {
    if (!pendingPeopleImport) return;
    const imported = pendingPeopleImport;
    importDialog.close();
    if (rosterLocked() || !canEditSession()) {
      toast('場次已變更或無法安全保存，請重新整理後再匯入。', { tone: 'error', timeout: 0 });
      return;
    }
    const before = state.people;
    if (!setPeople(imported.text, { saveNow: true })) {
      toast('名單未能保存，原本名單已保留。', { tone: 'error', timeout: 0 });
      return;
    }
    toast(`已從「${imported.fileName}」匯入 ${imported.count} 人，原本的名單已取代`, { action: { label: '復原', run: () => setPeople(before, { saveNow: true }) } });
  });

  el.dedupe.addEventListener('click', () => {
    const seen = new Set();
    const kept = people().filter((p) => {
      const identity = p.group ? `${p.name} | ${p.group}` : p.name;
      return seen.has(identity) ? false : seen.add(identity);
    });
    const removed = people().length - kept.length;
    const before = state.people;
    if (!setPeople(kept.map((p) => p.group ? `${p.name} | ${p.group}` : p.name).join('\n'), { saveNow: true })) {
      toast('無法保存整理後的名單，原本名單已保留。', { tone: 'error' });
      return;
    }
    toast(`已移除 ${removed} 個重複的名字`, { action: { label: '復原', run: () => setPeople(before, { saveNow: true }) } });
  });

  $('#people-clear').addEventListener('click', () => {
    if (!state.people.trim()) return;
    const before = state.people;
    if (!setPeople('', { saveNow: true })) {
      toast('無法清空並保存名單，原本名單已保留。', { tone: 'error' });
      return;
    }
    el.peopleText.focus();
    toast('名單已清空', { action: { label: '復原', run: () => setPeople(before, { saveNow: true }) } });
  });

  el.optExclude.addEventListener('change', () => {
    if (!canEditSession()) { el.optExclude.checked = !state.settings.allowRepeat; return; }
    state.settings.allowRepeat = !el.optExclude.checked;
    persist();
    renderPeopleMeta();
    renderControls();
    syncStage();
  });

  // records
  el.recordsSearch.addEventListener('input', () => { recordsPageIndex = 0; renderRecords(); });
  el.recordsStatus.addEventListener('change', () => { recordsPageIndex = 0; renderRecords(); });
  el.recordsPrevious.addEventListener('click', () => {
    if (recordsPageIndex > 0) { recordsPageIndex--; renderRecords(); }
  });
  el.recordsNext.addEventListener('click', () => {
    recordsPageIndex++;
    renderRecords();
  });
  el.records.addEventListener('click', (e) => {
    const button = e.target.closest('button[data-act]');
    if (!button) return;
    const { act, id } = button.dataset;
    if (act === 'play') playVideo(id);
    if (act === 'save') saveVideo(id);
    if (act === 'evidence') showDrawEvidence(id);
    if (act === 'void') openVoid(id);
  });
  el.dlgEvidence.addEventListener('close', () => { evidenceRequest++; activeDrawEvidence = null; });
  $('#evidence-download').addEventListener('click', () => {
    if (!activeDrawEvidence || !el.dlgEvidence.open || state.session.id !== activeDrawEvidence.sessionId) return;
    const { record, result } = activeDrawEvidence;
    try {
      const rows = [['位置', '姓名', '識別鍵', '中獎位置']];
      for (const [index, name] of result.candidates.entries()) {
        rows.push([index + 1, name, result.candidateKeys[index], index === record.index ? '是' : '']);
      }
      LW.download(new Blob([LW.toCSV(rows)], { type: 'text/csv;charset=utf-8' }),
        `${LW.safeFilename(`第${record.seq}抽_候選名單_${state.session.id}`, 80)}.csv`);
    } catch (err) {
      toast(`候選名單無法下載：${err.message || err}`, { tone: 'error' });
    }
  });
  el.exportCsv.addEventListener('click', exportCSV);
  el.exportValid.addEventListener('click', exportValidWinners);
  el.printValid.addEventListener('click', printValidWinners);
  window.addEventListener('afterprint', () => {
    document.body.classList.remove('is-printing-winners');
    el.printSheet.replaceChildren();
  });
  el.exportZip.addEventListener('click', () => exportPackage());
  $('#export-hash-copy').addEventListener('click', async () => {
    if (!exportReceipt || exportReceipt.sessionId !== state.session.id) return;
    try {
      if (!navigator.clipboard?.writeText) throw new Error('剪貼簿不可用');
      await navigator.clipboard.writeText(exportReceipt.sha256);
      toast('已複製 ZIP 的 SHA-256');
    } catch (_) {
      toast('無法自動複製。請選取畫面上的 SHA-256 手動複製。', { tone: 'error' });
    }
  });
  $('#export-receipt-download').addEventListener('click', () => {
    if (!exportReceipt || exportReceipt.sessionId !== state.session.id) return;
    LW.download(new Blob([LW.exportReceiptText(exportReceipt)], { type: 'text/plain;charset=utf-8' }),
      `${exportReceipt.fileName.slice(0, -4)}_SHA256.txt`);
  });
  el.verify.addEventListener('click', () => el.fileVerify.click());
  el.fileVerify.addEventListener('change', () => {
    const file = el.fileVerify.files[0];
    el.fileVerify.value = '';
    if (file) verifyFile(file);
  });

  // settings
  el.optTitle.addEventListener('input', () => {
    if (!canEditSession()) return;
    state.title = el.optTitle.value;
    persist();
    stage.setView({ title: state.title.trim() });
  });
  el.optSpin.addEventListener('input', () => {
    if (!canEditSession()) return;
    state.settings.spinSeconds = Number(el.optSpin.value);
    el.optSpinOut.textContent = `${state.settings.spinSeconds} 秒`;
    persist();
  });
  el.optRecord.addEventListener('change', () => {
    if (!canEditSession()) return;
    state.settings.record = el.optRecord.checked;
    persist();
    renderSettings();
    renderControls();
  });
  el.optAutoDl.addEventListener('change', () => {
    if (!canEditSession()) return;
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
  $('#preflight').addEventListener('click', runPreflight);
  $('#rehearse').addEventListener('click', rehearse);
  $('#backup-export').addEventListener('click', () => exportPackage(true));
  $('#backup-import').addEventListener('click', () => { if (!busy()) $('#file-restore').click(); });
  el.stateAlertDownload.addEventListener('click', () => {
    if (initialRead.raw === null) return;
    LW.download(new Blob([initialRead.raw], { type: 'text/plain;charset=utf-8' }), `抽獎場次原始資料_${LW.fileStamp()}.txt`);
  });
  $('#state-alert-reload').addEventListener('click', () => window.location.reload());
  $('#file-restore').addEventListener('change', () => {
    const file = $('#file-restore').files[0];
    $('#file-restore').value = '';
    if (file) chooseBackup(file);
  });
  $('#restore-confirm').addEventListener('input', () => { $('#restore-go').disabled = $('#restore-confirm').value.trim() !== '還原'; });
  $('#restore-go').addEventListener('click', restoreBackup);
  $('#dlg-restore').addEventListener('close', () => { inspectedBackup = null; });

  /* =================================================================== lifecycle */

  window.addEventListener('pagehide', () => persist(true));
  window.addEventListener('storage', (event) => {
    if (event.key === 'lucky-wheel/pref/lastExportReceipt') {
      exportReceipt = LW.normalizeExportReceipt(LW.Store.getPref('lastExportReceipt', null), state.session.id);
      exportReceiptSaved = !!exportReceipt;
      renderExportReceipt();
      return;
    }
    if (event.key !== LW.Store.stateKey || event.newValue === persistedSnapshot) return;
    markStale();
  });
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
  LW.Vault.ready().then(async () => {
    vaultChecked = true;
    try { await recoverRecordings(); }
    catch (err) { toast(`錄影恢復檢查失敗：${err.message || err}`, { tone: 'error' }); }
    finally {
      checking = false;
      renderAll();
    }
  }).catch((err) => {
    checking = false;
    renderAll();
    toast(`錄影儲存空間無法開啟：${err.message || err}`, { tone: 'error' });
  });

  // Debug handle for the browser console: LW.app.state, LW.app.stage
  LW.app = { state, stage, get phase() { return phase; } };
})();
