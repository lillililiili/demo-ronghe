// 缩略图需要后端校验原件；限制并发，关闭预览时取消尚未开始的请求。
export function createPreviewRequestQueue(limit = 3) {
  let active = 0;
  const pending = [];
  const canceled = () => new DOMException('预览请求已取消', 'AbortError');
  function drain() {
    while (active < limit && pending.length) pending.shift().start();
  }
  return (run, signal) => new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(canceled()); return; }
    const entry = {
      start() {
        signal?.removeEventListener('abort', cancel);
        if (signal?.aborted) { reject(canceled()); return; }
        active += 1;
        Promise.resolve().then(run).then(resolve, reject).finally(() => { active -= 1; drain(); });
      }
    };
    function cancel() {
      const index = pending.indexOf(entry);
      if (index >= 0) pending.splice(index, 1);
      reject(canceled());
    }
    pending.push(entry);
    signal?.addEventListener('abort', cancel, { once: true });
    drain();
  });
}
