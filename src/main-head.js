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
        url = `wss://${CFG.proxyDomain}/${cleanHost}${u.pathname}${u.search}`;
        console.log('[Proxy LS] WS:', cleanHost, '->', url);
        // 不传 protocols：CF Workers WebSocketPair 不支持协议协商
        return new OrigWS(url);
      } catch (e) {}
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
