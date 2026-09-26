(function () {
  'use strict';
  const canvas = document.getElementById('projection-canvas');
  const status = document.getElementById('projection-status');
  function requestConnection() {
    try {
      if (window.opener && !window.opener.closed) {
        window.opener.postMessage({ type: 'lucky-wheel-projection-ready' },
          location.protocol === 'file:' ? '*' : location.origin);
      }
    } catch (_) { /* the operator window may have been closed or navigated */ }
  }
  requestConnection();
  window.addEventListener('pageshow', requestConnection);
  window.addEventListener('focus', requestConnection);
  setInterval(() => {
    const stale = Date.now() - Number(canvas.dataset.lastFrameAt || 0) > 5000;
    status.parentElement.classList.toggle('is-disconnected', stale);
    if (stale) status.textContent = '等待操作台重新連線…';
    requestConnection();
  }, 2000);
  document.getElementById('fullscreen').addEventListener('click', () => {
    if (!document.fullscreenElement) document.documentElement.requestFullscreen().catch(() => {});
    else document.exitFullscreen().catch(() => {});
  });
})();
