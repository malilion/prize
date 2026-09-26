(function () {
  'use strict';
  const input = document.getElementById('archive');
  const result = document.getElementById('result');
  const issues = document.getElementById('issues');
  const draws = document.getElementById('draws');
  const expectedInput = document.getElementById('expected-hash');
  let lastDigest = '';
  let lastReport = null;
  let lastError = null;
  function line(parent, value, className) {
    const li = document.createElement('li');
    li.textContent = value;
    li.className = className;
    parent.appendChild(li);
  }
  function renderHashComparison() {
    if (!lastDigest) return;
    const expected = expectedInput.value.trim().toLowerCase();
    const match = document.getElementById('hash-match');
    const title = document.getElementById('result-title');
    if (!expected) {
      match.textContent = '未提供活動時公開的 ZIP 指紋；目前只能檢查憑證包內部一致性。';
      match.className = 'warn';
    } else if (!/^[0-9a-f]{64}$/.test(expected)) {
      match.textContent = '公開指紋格式不正確，請輸入 64 位十六進位字元。';
      match.className = 'bad';
    } else if (expected !== lastDigest) {
      match.textContent = '公開指紋不符：這份 ZIP 與活動時公布的檔案不同。';
      match.className = 'bad';
    } else {
      match.textContent = '公開指紋相符：這份 ZIP 與公布的檔案逐位元組一致。';
      match.className = 'ok';
    }
    const failedHash = !!expected && match.className === 'bad';
    const failed = failedHash || !!lastError || !!lastReport?.errors.length;
    const warning = !!lastReport?.warnings.length;
    title.textContent = failed ? '驗證未通過' : warning ? '驗證通過，部分資料缺少' : '驗證通過';
    title.className = failed ? 'bad' : warning ? 'warn' : 'ok';
  }
  expectedInput.addEventListener('input', renderHashComparison);
  input.addEventListener('change', async () => {
    const file = input.files[0];
    result.hidden = true;
    if (!file) return;
    lastDigest = '';
    lastReport = null;
    lastError = null;
    document.getElementById('actual-hash').textContent = '';
    input.disabled = true;
    document.getElementById('status').textContent = `正在逐檔驗證 ${file.name}…`;
    try {
      lastDigest = await LW.sha256Hex(file);
      document.getElementById('actual-hash').textContent = lastDigest;
      const report = await LW.inspectPackage(file);
      lastReport = report;
      result.hidden = false;
      document.getElementById('summary').textContent = `${report.audit.event.title || '未命名活動'} · 場次 ${report.audit.event.sessionId} · ${report.audit.draws.length} 抽 · ${report.state ? '可還原場次' : '無場次備份'}`;
      issues.replaceChildren();
      if (!report.errors.length && !report.warnings.length) line(issues, '候選名單、結果、錄影與備份資料一致。', 'ok');
      for (const message of report.errors) line(issues, message, 'bad');
      for (const message of report.warnings) line(issues, message, 'warn');
      draws.replaceChildren();
      for (const d of report.audit.draws) line(draws, `第 ${d.seq} 抽 · ${d.prize} · ${d.winner} · ${d.status} · ${d.video?.file ? '有錄影紀錄' : '無錄影'}`, '');
      renderHashComparison();
      document.getElementById('status').textContent = '檢查完成';
    } catch (err) {
      lastError = err;
      result.hidden = false;
      document.getElementById('result-title').textContent = '無法驗證';
      document.getElementById('result-title').className = 'bad';
      document.getElementById('summary').textContent = err.message || String(err);
      issues.replaceChildren();
      draws.replaceChildren();
      if (lastDigest) renderHashComparison();
      document.getElementById('status').textContent = '檢查失敗';
    } finally { input.disabled = false; }
  });
})();
