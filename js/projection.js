(function () {
  'use strict';
  document.getElementById('fullscreen').addEventListener('click', () => {
    if (!document.fullscreenElement) document.documentElement.requestFullscreen().catch(() => {});
    else document.exitFullscreen().catch(() => {});
  });
})();
