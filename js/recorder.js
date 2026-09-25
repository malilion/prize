/* 抽獎轉盤 — records the stage canvas (plus the sound bus) with MediaRecorder.
 * MP4 is preferred because it opens everywhere (QuickTime, Windows, phones); WebM is the fallback. */
(function (root) {
  'use strict';
  const LW = (root.LW = root.LW || {});

  const WITH_AUDIO = [
    'video/mp4;codecs=avc1.640028,mp4a.40.2',
    'video/mp4;codecs=avc1,mp4a.40.2',
    'video/mp4;codecs=avc1.42E028,mp4a.40.2',
    'video/mp4',
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm',
  ];
  const VIDEO_ONLY = [
    'video/mp4;codecs=avc1.640028',
    'video/mp4;codecs=avc1',
    'video/mp4;codecs=avc1.42E028',
    'video/mp4',
    'video/webm;codecs=vp9',
    'video/webm;codecs=vp8',
    'video/webm',
  ];

  function supported() {
    return typeof root.MediaRecorder === 'function' &&
      typeof root.HTMLCanvasElement === 'function' &&
      typeof root.HTMLCanvasElement.prototype.captureStream === 'function';
  }

  /** First supported MIME type; '' means "let the browser choose". */
  function pickType(withAudio) {
    const list = withAudio ? WITH_AUDIO : VIDEO_ONLY;
    return list.find((type) => {
      try { return MediaRecorder.isTypeSupported(type); } catch (_) { return false; }
    }) || '';
  }

  function describe() {
    if (!supported()) return null;
    const type = pickType(true) || pickType(false);
    if (/mp4/i.test(type)) return 'MP4（H.264）';
    if (/vp9/i.test(type)) return 'WebM（VP9）';
    if (/vp8/i.test(type)) return 'WebM（VP8）';
    if (/webm/i.test(type)) return 'WebM';
    return '瀏覽器預設格式';
  }

  const extensionFor = (mime) => (/mp4/i.test(mime) ? 'mp4' : 'webm');

  /**
   * Start recording. Returns a handle whose stop() resolves to { blob, mimeType, durationMs }.
   * Throws if the browser refuses to start — the caller aborts the draw in that case.
   */
  function start(canvas, { audioTrack = null, fps = 30, videoBitsPerSecond = 5000000 } = {}) {
    if (!supported()) throw new Error('這個瀏覽器不支援畫面錄影');
    const canvasStream = canvas.captureStream(fps);
    const tracks = canvasStream.getVideoTracks();
    if (audioTrack && audioTrack.readyState === 'live') tracks.push(audioTrack.clone());
    const stream = new MediaStream(tracks);
    const hasAudio = stream.getAudioTracks().length > 0;
    const preferred = pickType(hasAudio);

    let recorder;
    try {
      recorder = new MediaRecorder(stream, {
        mimeType: preferred || undefined,
        videoBitsPerSecond,
        audioBitsPerSecond: hasAudio ? 128000 : undefined,
      });
    } catch (_) {
      recorder = new MediaRecorder(stream); // browser default container
    }

    const chunks = [];
    let failure = null;
    const release = () => stream.getTracks().forEach((t) => t.stop());
    recorder.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
    recorder.onerror = (e) => { failure = e.error || new Error('錄影時發生錯誤'); };
    try {
      recorder.start(1000);
    } catch (err) {
      release();
      throw err;
    }

    const startedAt = performance.now();
    const mimeType = () => recorder.mimeType || preferred || 'video/webm';
    const finish = () => {
      const type = mimeType();
      return {
        blob: new Blob(chunks, { type: type.split(';')[0] }),
        mimeType: type,
        durationMs: performance.now() - startedAt,
      };
    };

    return {
      startedAt,
      get mimeType() { return mimeType(); },
      stop() {
        return new Promise((resolve, reject) => {
          const done = () => {
            release();
            if (!chunks.length) reject(failure || new Error('錄影沒有產生任何畫面'));
            else resolve(finish());
          };
          if (recorder.state === 'inactive') return done();
          recorder.onstop = done;
          try { recorder.stop(); } catch (err) { release(); reject(err); }
        });
      },
      cancel() {
        try { if (recorder.state !== 'inactive') recorder.stop(); } catch (_) { /* already stopped */ }
        release();
      },
    };
  }

  LW.Recorder = { supported, describe, start, extensionFor };
})(typeof window !== 'undefined' ? window : globalThis);
