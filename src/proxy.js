// 代理 patch：必须在所有其他 import 之前执行
// 因为 ES Module 中 import 按顺序执行，这个文件第一个 import，确保 GramJS 拿到的是 patch 后的 WebSocket

const PROXY_DOMAIN = import.meta.env.VITE_PROXY_DOMAIN || '';

if (PROXY_DOMAIN) {
  console.log('[Proxy] Patching WebSocket, fetch, and XHR via:', PROXY_DOMAIN);

  // 只替换 URL hostname 中包含 telegram.org 的请求
  function shouldRewrite(urlStr) {
    try {
      const u = new URL(urlStr, location.href);
      return u.hostname.endsWith('.telegram.org') && u.hostname !== PROXY_DOMAIN;
    } catch (e) {
      return false;
    }
  }

  function rewriteWsUrl(urlStr) {
    try {
      const u = new URL(urlStr);
      return `wss://${PROXY_DOMAIN}/${u.hostname}${u.pathname}${u.search}`;
    } catch (e) {
      return urlStr;
    }
  }

  function rewriteHttpUrl(urlStr) {
    try {
      const u = new URL(urlStr, location.href);
      return `https://${PROXY_DOMAIN}/${u.hostname}${u.pathname}${u.search}`;
    } catch (e) {
      return urlStr;
    }
  }

  // ===== Patch WebSocket =====
  const OrigWS = self.WebSocket;
  self.WebSocket = function (url, protocols) {
    if (typeof url === 'string' && shouldRewrite(url)) {
      const newUrl = rewriteWsUrl(url);
      console.log('[Proxy] WS URL FULL:', url);
      console.log('[Proxy] WS rewrite:', url, '->', newUrl);
      url = newUrl;
    }
    return protocols !== undefined ? new OrigWS(url, protocols) : new OrigWS(url);
  };
  self.WebSocket.prototype = OrigWS.prototype;
  self.WebSocket.CONNECTING = OrigWS.CONNECTING;
  self.WebSocket.OPEN = OrigWS.OPEN;
  self.WebSocket.CLOSING = OrigWS.CLOSING;
  self.WebSocket.CLOSED = OrigWS.CLOSED;

  // ===== Patch fetch =====
  const origFetch = self.fetch;
  self.fetch = function (input, init) {
    let urlStr = typeof input === 'string' ? input : (input && input.url ? input.url : '');
    if (shouldRewrite(urlStr)) {
      const newUrl = rewriteHttpUrl(urlStr);
      console.log('[Proxy] fetch rewrite:', urlStr, '->', newUrl);
      if (typeof input === 'string') {
        input = newUrl;
      } else {
        input = new Request(newUrl, input);
      }
    }
    return origFetch.call(self, input, init);
  };

  // ===== Patch XMLHttpRequest =====
  const OrigXHR = self.XMLHttpRequest;
  self.XMLHttpRequest = function () {
    const xhr = new OrigXHR();
    const origOpen = xhr.open;
    let _url = '';

    xhr.open = function (method, url, async, user, password) {
      _url = url;
      if (shouldRewrite(url)) {
        const newUrl = rewriteHttpUrl(url);
        console.log('[Proxy] XHR rewrite:', url, '->', newUrl);
        url = newUrl;
      }
      return origOpen.call(xhr, method, url, async !== false, user, password);
    };

    return xhr;
  };
  self.XMLHttpRequest.prototype = OrigXHR.prototype;
  self.XMLHttpRequest.DONE = OrigXHR.DONE;
  self.XMLHttpRequest.HEADERS_RECEIVED = OrigXHR.HEADERS_RECEIVED;
  self.XMLHttpRequest.LOADING = OrigXHR.LOADING;
  self.XMLHttpRequest.OPENED = OrigXHR.OPENED;
  self.XMLHttpRequest.UNSENT = OrigXHR.UNSENT;

} else {
  console.warn('[Proxy] PROXY_DOMAIN not set - connecting directly to Telegram');
}
