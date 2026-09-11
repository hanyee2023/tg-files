// 代理 patch：必须在所有其他 import 之前执行
// 因为 ES Module 中 import 按顺序执行，这个文件第一个 import，确保 GramJS 拿到的是 patch 后的 WebSocket

const PROXY_DOMAIN = import.meta.env.VITE_PROXY_DOMAIN || '';

if (PROXY_DOMAIN) {
  console.log('[Proxy] Patching WebSocket and fetch via:', PROXY_DOMAIN);

  // Patch WebSocket
  const OrigWS = self.WebSocket;
  self.WebSocket = function (url, protocols) {
    if (typeof url === 'string' && url.includes('telegram.org')) {
      try {
        const u = new URL(url);
        url = `wss://${PROXY_DOMAIN}/${u.hostname}${u.pathname}`;
        console.log('[Proxy] WS rewrite:', u.hostname, '->', PROXY_DOMAIN);
      } catch (e) {
        console.error('[Proxy] WS rewrite error:', e);
      }
    }
    return protocols !== undefined ? new OrigWS(url, protocols) : new OrigWS(url);
  };
  // 复制所有静态属性和原型
  self.WebSocket.prototype = OrigWS.prototype;
  self.WebSocket.CONNECTING = OrigWS.CONNECTING;
  self.WebSocket.OPEN = OrigWS.OPEN;
  self.WebSocket.CLOSING = OrigWS.CLOSING;
  self.WebSocket.CLOSED = OrigWS.CLOSED;

  // Patch fetch
  const origFetch = self.fetch;
  self.fetch = function (input, init) {
    let urlStr = typeof input === 'string' ? input : (input && input.url ? input.url : '');
    if (urlStr.includes('telegram.org')) {
      try {
        const u = new URL(urlStr);
        const newUrl = `https://${PROXY_DOMAIN}/${u.hostname}${u.pathname}${u.search}`;
        if (typeof input === 'string') {
          input = newUrl;
        } else {
          input = new Request(newUrl, input);
        }
      } catch (e) {
        console.error('[Proxy] fetch rewrite error:', e);
      }
    }
    return origFetch.call(self, input, init);
  };
} else {
  console.warn('[Proxy] PROXY_DOMAIN not set - connecting directly to Telegram');
}
