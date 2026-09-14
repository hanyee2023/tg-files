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
      // 不传 protocols：CF Workers WebSocketPair 不支持协议协商
      // GramJS 传的 'binary' 会导致握手失败
      const realWs = new OrigWS(newUrl);
      
      // 创建代理 WebSocket，拦截 Worker 发来的诊断字符串消息
      // 只把二进制数据转发给 GramJS
      const proxyWs = new EventTarget();
      Object.defineProperty(proxyWs, 'readyState', { get: () => realWs.readyState });
      Object.defineProperty(proxyWs, 'bufferedAmount', { get: () => realWs.bufferedAmount });
      Object.defineProperty(proxyWs, 'extensions', { get: () => realWs.extensions });
      Object.defineProperty(proxyWs, 'protocol', { get: () => realWs.protocol });
      Object.defineProperty(proxyWs, 'binaryType', { 
        get: () => realWs.binaryType, 
        set: (v) => { realWs.binaryType = v; }
      });
      Object.defineProperty(proxyWs, 'url', { get: () => realWs.url });
      proxyWs.send = (data) => realWs.send(data);
      proxyWs.close = (code, reason) => realWs.close(code, reason);
      
      // 转发 realWs 事件到 proxyWs，但过滤掉诊断字符串消息
      const forwardEvent = (type) => {
        realWs.addEventListener(type, (ev) => {
          let newEv;
          if (type === 'message') {
            // 检查是否是 Worker 发来的诊断消息（JSON 字符串）
            if (typeof ev.data === 'string' && (ev.data.startsWith('{"') || ev.data.startsWith('[Proxy'))) {
              try {
                const diag = JSON.parse(ev.data);
                if (diag.error) {
                  console.error('[Proxy] Worker error:', diag);
                } else if (diag.status) {
                  console.log('[Proxy] Worker status:', diag.status, diag);
                }
              } catch (e) {
                console.log('[Proxy] Worker msg:', ev.data);
              }
              return; // 不转发诊断消息给 GramJS
            }
            newEv = new MessageEvent('message', { data: ev.data });
          } else if (type === 'close') {
            newEv = new CloseEvent('close', { code: ev.code, reason: ev.reason, wasClean: ev.wasClean });
          } else {
            newEv = new Event(type);
          }
          proxyWs.dispatchEvent(newEv);
          // 同步调用 onXXX 回调
          const handler = proxyWs['on' + type];
          if (typeof handler === 'function') handler(newEv);
        });
      };
      
      forwardEvent('open');
      forwardEvent('message');
      forwardEvent('close');
      forwardEvent('error');
      
      // addEventListener 支持
      proxyWs.addEventListener = function(type, listener, options) {
        return EventTarget.prototype.addEventListener.call(this, type, listener, options);
      };
      proxyWs.removeEventListener = function(type, listener, options) {
        return EventTarget.prototype.removeEventListener.call(this, type, listener, options);
      };
      
      console.log('[Proxy] WS connected');
      realWs.addEventListener('error', (e) => console.error('[Proxy] WS error', e));
      realWs.addEventListener('close', (e) => console.log('[Proxy] WS closed', e.code, e.reason));
      
      return proxyWs;
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
