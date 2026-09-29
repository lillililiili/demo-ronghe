// 清单、分片、密钥均走同一授权代理；不向外部地址或其他目标泄漏会话。
export function streamUrl(raw, { origin, targetId, streamId }) {
  const url = new URL(raw, origin);
  const prefix = `/api/v1/targets/${encodeURIComponent(targetId)}/video/streams/${encodeURIComponent(streamId)}/`;
  // 平台签发的临时媒体标识不承载登录凭据；真实上游会话仅由后端保存。
  const mediaSession = /^\?session=[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (url.origin !== origin || url.username || url.password || (url.search && !mediaSession.test(url.search)) || url.hash
    || !url.pathname.startsWith(prefix) || /%2f|%5c|%2e/i.test(url.pathname)) {
    throw new Error('视频地址不属于当前目标的授权通道');
  }
  return url.href;
}

export function authenticatedHlsLoader({ origin, targetId, streamId, session, readToken, onUnauthorized }) {
  return class AuthenticatedLoader {
    constructor() {
      this.stats = { aborted: false, loaded: 0, total: 0, retry: 0, chunkCount: 0, bwEstimate: 0,
        loading: { start: 0, first: 0, end: 0 }, parsing: { start: 0, end: 0 }, buffering: { start: 0, first: 0, end: 0 } };
    }
    load(context, config, callbacks) {
      this.context = context;
      this.controller = new AbortController();
      this.stats.loading.start = performance.now();
      const timeout = config.timeout || config.loadPolicy?.maxLoadTimeMs || 15000;
      this.timer = setTimeout(() => {
        this.timedOut = true;
        this.controller.abort();
        callbacks.onTimeout(this.stats, context, null);
      }, timeout);
      this.request(context, callbacks);
    }
    async request(context, callbacks) {
      try {
        const token = readToken();
        if (!token || token !== session) throw new Error('登录会话已变化');
        const url = streamUrl(context.url, { origin, targetId, streamId });
        const headers = new Headers({ Authorization: `Bearer ${token}` });
        if (context.rangeEnd) headers.set('Range', `bytes=${context.rangeStart || 0}-${context.rangeEnd - 1}`);
        const response = await fetch(url, { headers, redirect: 'error', cache: 'no-store', credentials: 'same-origin', signal: this.controller.signal });
        // 销毁或换会话后的迟到响应不能触发全局退出，尤其不能清除新登录会话。
        if (this.stats.aborted || this.timedOut || readToken() !== session) return;
        if (response.status === 401) onUnauthorized?.();
        if (!response.ok) throw Object.assign(new Error('视频读取失败'), { status: response.status });
        this.stats.loading.first = performance.now();
        const data = context.responseType === 'arraybuffer' ? await response.arrayBuffer() : await response.text();
        if (this.stats.aborted || this.timedOut) return;
        if (readToken() !== session) throw new Error('登录会话已变化');
        this.stats.loaded = this.stats.total = typeof data === 'string' ? new TextEncoder().encode(data).length : data.byteLength;
        this.stats.loading.end = performance.now();
        callbacks.onSuccess({ url, data, code: response.status }, this.stats, context, response);
      } catch (error) {
        if (!this.stats.aborted && !this.timedOut) callbacks.onError({ code: error.status || 0, text: '视频读取失败，请刷新状态' }, context, null, this.stats);
      } finally { clearTimeout(this.timer); }
    }
    abort() { this.stats.aborted = true; clearTimeout(this.timer); this.controller?.abort(); }
    destroy() { this.abort(); this.context = null; }
    getCacheAge() { return null; }
  };
}
