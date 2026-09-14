// 必须最先 import proxy.js，确保 WebSocket/fetch/XHR 在 GramJS 加载前被 patch
import './proxy.js';
import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions';
import { Api } from 'telegram/tl/api';

// ===== 配置（优先 localStorage，其次环境变量）=====
function getConfig() {
  return {
    apiId: parseInt(localStorage.getItem('tg_api_id') || import.meta.env.VITE_API_ID || '0'),
    apiHash: localStorage.getItem('tg_api_hash') || import.meta.env.VITE_API_HASH || '',
    proxyDomain: localStorage.getItem('tg_proxy') || import.meta.env.VITE_PROXY_DOMAIN || '',
  };
}

let CFG = getConfig();

// ===== 动态代理 patch（如果 localStorage 有代理配置）=====
let proxyPatched = false;
function applyProxyPatchFromLS() {
  if (proxyPatched || !CFG.proxyDomain) return;
  proxyPatched = true;

  function shouldRewrite(urlStr) {
    try {
      const u = new URL(urlStr, location.href);
      return u.hostname.endsWith('.telegram.org') && u.hostname !== CFG.proxyDomain;
    } catch (e) { return false; }
  }

  const OrigWS = self.WebSocket;
  self.WebSocket = function (url, protocols) {
    if (typeof url === 'string' && shouldRewrite(url)) {
      try {
        const u = new URL(url);
        const cleanHost = u.hostname;
        const newUrl = `wss://${CFG.proxyDomain}/${cleanHost}${u.pathname}${u.search}`;
        console.log('[Proxy LS] WS:', cleanHost, '->', newUrl);
        const realWs = new OrigWS(newUrl);
        
        const proxyWs = new EventTarget();
        for (const p of ['readyState','bufferedAmount','extensions','protocol','url']) {
          Object.defineProperty(proxyWs, p, { get: () => realWs[p] });
        }
        Object.defineProperty(proxyWs, 'binaryType', {
          get: () => realWs.binaryType, set: (v) => { realWs.binaryType = v; }
        });
        proxyWs.send = (data) => realWs.send(data);
        proxyWs.close = (code, reason) => realWs.close(code, reason);
        
        for (const type of ['open','message','close','error']) {
          realWs.addEventListener(type, (ev) => {
            let newEv;
            if (type === 'message') {
              if (typeof ev.data === 'string' && ev.data.charAt(0) === '{') {
                try {
                  const d = JSON.parse(ev.data);
                  if (d.error) console.error('[Proxy LS] Worker error:', d);
                  else if (d.status) console.log('[Proxy LS] Worker status:', d.status, d);
                } catch(e) {}
                return;
              }
              newEv = new MessageEvent('message', { data: ev.data });
            } else if (type === 'close') {
              newEv = new CloseEvent('close', { code: ev.code, reason: ev.reason, wasClean: ev.wasClean });
            } else { newEv = new Event(type); }
            proxyWs.dispatchEvent(newEv);
            const h = proxyWs['on' + type];
            if (typeof h === 'function') h(newEv);
          });
        }
        console.log('[Proxy LS] WS connected');
        realWs.addEventListener('error', (e) => console.error('[Proxy LS] WS error', e));
        realWs.addEventListener('close', (e) => console.log('[Proxy LS] WS closed', e.code, e.reason));
        return proxyWs;
      } catch (e) {
        console.error('[Proxy LS] WS rewrite error', e);
      }
    }
    return protocols !== undefined ? new OrigWS(url, protocols) : new OrigWS(url);
  };
  self.WebSocket.prototype = OrigWS.prototype;
  self.WebSocket.CONNECTING = OrigWS.CONNECTING;
  self.WebSocket.OPEN = OrigWS.OPEN;
  self.WebSocket.CLOSING = OrigWS.CLOSING;
  self.WebSocket.CLOSED = OrigWS.CLOSED;

  const origFetch = self.fetch;
  self.fetch = function (input, init) {
    let s = typeof input === 'string' ? input : (input?.url || '');
    if (shouldRewrite(s)) {
      try {
        const u = new URL(s, location.href);
        const n = `https://${CFG.proxyDomain}/${u.hostname}${u.pathname}${u.search}`;
        input = typeof input === 'string' ? n : new Request(n, input);
      } catch (e) {}
    }
    return origFetch.call(self, input, init);
  };
}

// ===== 连接超时包装 =====
const CONNECT_TIMEOUT = 15000;
function connectWithTimeout(client) {
  return Promise.race([
    client.connect(),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error('连接超时：无法连接到 Telegram 服务器，请检查代理配置')), CONNECT_TIMEOUT)
    ),
  ]);
}

function withTimeout(promise, ms, msg) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(msg || '请求超时')), ms)),
  ]);
}
