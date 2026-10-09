/* 等待捕获轨道就绪，避免将尚未收到 addtrack 的直播捕获流复制为空流。 */
export async function captureVideoStream(media, signal) {
  const capture = media?.captureStream || media?.mozCaptureStream;
  if (typeof capture !== 'function') throw new Error('当前浏览器不能从视频画面录像，可以先截图取证。');
  if (media.readyState < 2 || !media.videoWidth || !media.videoHeight || media.paused || media.ended) {
    throw new Error('画面还没有加载出来，请等视频播放后再录像。');
  }
  const source = capture.call(media);
  const stopSource = () => source.getTracks().forEach(track => track.stop());
  try {
    await new Promise((resolve, reject) => {
      let timeout;
      const cleanup = () => {
        clearTimeout(timeout);
        source.removeEventListener('addtrack', ready);
        signal.removeEventListener('abort', abort);
      };
      const abort = () => { cleanup(); reject(new DOMException('录像已取消', 'AbortError')); };
      const ready = () => {
        if (signal.aborted) return abort();
        if (source.getVideoTracks().some(track => track.readyState === 'live')) { cleanup(); resolve(); }
      };
      source.addEventListener('addtrack', ready);
      signal.addEventListener('abort', abort, { once: true });
      timeout = setTimeout(() => { cleanup(); reject(new Error('未取得可录制的视频轨道，请刷新视频后重试。')); }, 3000);
      ready();
    });
    source.getAudioTracks().forEach(track => track.stop());
    return new MediaStream(source.getVideoTracks().filter(track => track.readyState === 'live'));
  } catch (failure) { stopSource(); throw failure; }
}

/* 仅在尚未收到数据、且用户未停止时尝试下一编码格式；不拼接不同编码的片段。 */
export function recordVideo(stream, { formats, bitsPerSecond, onStop, onError }) {
  let recorder, stopped = false, index = 0;
  const start = () => {
    if (stopped) { onError('录像已停止，尚未取得视频数据。'); return; }
    const format = formats[index++];
    if (!format) { onError('当前浏览器无法启动视频编码，请换用其他浏览器或先截图取证。'); return; }
    let active;
    try { active = new MediaRecorder(stream, { mimeType: format.mimeType, videoBitsPerSecond: bitsPerSecond }); }
    catch { start(); return; }
    recorder = active;
    const parts = [];
    let failed = false, hadData = false;
    active.ondataavailable = event => { if (event.data?.size && !failed) { hadData = true; parts.push(event.data); } };
    active.onerror = () => { failed = true; };
    active.onstop = () => {
      if (failed) {
        if (!hadData && !stopped) { start(); return; }
        onError('视频编码中断，这段录像没有保存，请重新录像或先截图取证。');
        return;
      }
      onStop(new Blob(parts, { type: format.type }), format);
    };
    try { active.start(1000); }
    catch { active.onstop = null; active.onerror = null; active.ondataavailable = null; start(); }
  };
  // 让调用方先登记会话，再处理同步启动失败。
  queueMicrotask(start);
  return {
    stop() {
      stopped = true;
      if (recorder?.state !== 'inactive' && recorder) recorder.stop();
    }
  };
}
