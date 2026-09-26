(function () {
  'use strict';
  const input = document.getElementById('archive');
  const result = document.getElementById('result');
  const issues = document.getElementById('issues');
  const draws = document.getElementById('draws');
  function line(parent, value, className) {
    const li = document.createElement('li');
    li.textContent = value;
    li.className = className;
    parent.appendChild(li);
  }
  input.addEventListener('change', async () => {
    const file = input.files[0];
    result.hidden = true;
    if (!file) return;
    input.disabled = true;
    document.getElementById('status').textContent = `正在逐檔驗證 ${file.name}…`;
    try {
      const report = await LW.inspectPackage(file);
      result.hidden = false;
      document.getElementById('result-title').textContent = report.errors.length ? '驗證未通過' : report.warnings.length ? '驗證通過，部分資料缺少' : '驗證通過';
      document.getElementById('result-title').className = report.errors.length ? 'bad' : report.warnings.length ? 'warn' : 'ok';
      document.getElementById('summary').textContent = `${report.audit.event.title || '未命名活動'} · 場次 ${report.audit.event.sessionId} · ${report.audit.draws.length} 抽 · ${report.state ? '可還原場次' : '無場次備份'}`;
      issues.replaceChildren();
      if (!report.errors.length && !report.warnings.length) line(issues, '候選名單、結果、錄影與備份資料一致。', 'ok');
      for (const message of report.errors) line(issues, message, 'bad');
      for (const message of report.warnings) line(issues, message, 'warn');
      draws.replaceChildren();
      for (const d of report.audit.draws) line(draws, `第 ${d.seq} 抽 · ${d.prize} · ${d.winner} · ${d.status} · ${d.video?.file ? '有錄影紀錄' : '無錄影'}`, '');
      document.getElementById('status').textContent = '檢查完成';
    } catch (err) {
      result.hidden = false;
      document.getElementById('result-title').textContent = '無法驗證';
      document.getElementById('result-title').className = 'bad';
      document.getElementById('summary').textContent = err.message || String(err);
      issues.replaceChildren();
      draws.replaceChildren();
      document.getElementById('status').textContent = '檢查失敗';
    } finally { input.disabled = false; }
  });
})();
