/* Prepare the hosted app for offline reloads; file:// already reads every asset locally. */
(function (root) {
  'use strict';
  const LW = (root.LW = root.LW || {});
  let setup;

  async function inspect() {
    if (root.location.protocol === 'file:') {
      return { ready: true, message: '本機版的程式檔案不需要網路' };
    }
    if (root.isSecureContext === false || !root.navigator?.serviceWorker || !root.MessageChannel) {
      return { ready: false, message: '此瀏覽器無法快取線上版；正式活動請下載本機版，或保持網路連線' };
    }
    try {
      setup ||= root.navigator.serviceWorker.register('./sw.js', { scope: './', updateViaCache: 'none' })
        .then(() => root.navigator.serviceWorker.ready);
      const registration = await setup;
      const active = registration.active;
      if (!active) throw new Error('沒有啟用的離線程式');
      const channel = new root.MessageChannel();
      const checked = await new Promise((resolve) => {
        const timer = setTimeout(() => resolve(false), 3000);
        channel.port1.onmessage = (event) => {
          clearTimeout(timer);
          resolve(event.data?.ready === true);
        };
        active.postMessage({ type: 'prize-shell-status' }, [channel.port2]);
      });
      channel.port1.close();
      return checked
        ? { ready: true, message: '線上版程式檔案已備妥，可在斷網後重新開啟' }
        : { ready: false, message: '線上版離線程式檔案不完整；請保持網路連線或改用本機版' };
    } catch (_) {
      setup = null;
      return { ready: false, message: '線上版離線程式檔案尚未備妥；請保持網路連線或改用本機版' };
    }
  }

  // Registration begins on load. A slow or blocked install must not hold preflight forever.
  LW.offlineReadiness = () => new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ ready: false, message: '離線程式檔案尚未備妥；請稍後重新檢查' }), 8000);
    inspect().then((result) => {
      clearTimeout(timer);
      resolve(result);
    }, () => {
      clearTimeout(timer);
      resolve({ ready: false, message: '離線程式檔案尚未備妥；請稍後重新檢查' });
    });
  });
  LW.offlineReadiness();
})(typeof window !== 'undefined' ? window : globalThis);
