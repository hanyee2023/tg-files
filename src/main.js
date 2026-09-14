import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions';
import { Api } from 'telegram/tl/api';
import { PromisedWebSockets } from 'telegram/extensions/PromisedWebSockets';
import { CustomFile } from 'telegram/client/uploads';
import { NewMessage } from 'telegram/events';

// ===== 配置（来自 Cloudflare Pages 的 Build 环境变量）=====
const API_ID = parseInt(import.meta.env.VITE_API_ID || '0');
const API_HASH = import.meta.env.VITE_API_HASH || '';
const PROXY_DOMAIN = import.meta.env.VITE_PROXY_DOMAIN || '';

// ===== 代理：重写 GramJS 内部的 WebSocket 地址（最可靠，不依赖全局 patch）=====
class ProxiedWebSockets extends PromisedWebSockets {
  getWebSocketLink(ip, port, testServers) {
    const path = `/apiws${testServers ? '_test' : ''}`;
    if (PROXY_DOMAIN) return `wss://${PROXY_DOMAIN}/${ip}${path}`;
    return super.getWebSocketLink(ip, port, testServers);
  }
}
if (!PROXY_DOMAIN) {
  console.warn('[tg] 未设置 VITE_PROXY_DOMAIN，将直连 Telegram（国内大概率失败）。请在 Cloudflare Pages 环境变量里配置。');
}
// 安全兜底：万一仍有对 telegram.org 的 HTTP 请求，也走代理
if (PROXY_DOMAIN) {
  const origFetch = self.fetch;
  self.fetch = function (input, init) {
    let s = typeof input === 'string' ? input : (input?.url || '');
    if (s.includes('telegram.org') && !s.includes(PROXY_DOMAIN)) {
      try {
        const u = new URL(s);
        const n = `https://${PROXY_DOMAIN}/${u.hostname}${u.pathname}${u.search}`;
        input = typeof input === 'string' ? n : new Request(n, input);
      } catch (e) {}
    }
    return origFetch.call(self, input, init);
  };
}

// ===== 主题：浅色默认 + 蓝/绿/紫三色 + 深色，统一 AyuGram 风格 =====
const THEME = localStorage.getItem('tg_theme') || 'light';
const ACCENT = localStorage.getItem('tg_accent') || 'blue';
document.documentElement.dataset.theme = THEME;
document.documentElement.dataset.accent = ACCENT;

function injectTheme() {
  if (document.getElementById('tg-theme')) return;
  const s = document.createElement('style');
  s.id = 'tg-theme';
  s.textContent = `
  :root, html[data-theme="light"] {
    --accent:#3390ec; --accent-hover:#2b7ed4; --accent-soft:rgba(51,144,236,.13);
    --bg-app:#ffffff; --bg-panel:#ffffff; --bg-hover:#f4f4f5; --bg-active:var(--accent-soft);
    --chat-bg:#ffffff; --bubble-in:#ffffff; --bubble-out:var(--accent-soft);
    --text-primary:#1c1c1e; --text-secondary:#707579; --text-meta:#a8b0b8;
    --divider:#e7e9ec; --input-bg:#f1f3f4; --scrollbar:rgba(0,0,0,.18);
    --shadow:0 1px 2px rgba(0,0,0,.10); --green:#2fae4f; --red:#e9573f;
  }
  html[data-theme="dark"] {
    --accent:#3390ec; --accent-hover:#2b7ed4; --accent-soft:rgba(51,144,236,.16);
    --bg-app:#0e1621; --bg-panel:#17212b; --bg-hover:#202b36; --bg-active:var(--accent-soft);
    --chat-bg:#0e1621; --bubble-in:#182533; --bubble-out:var(--accent-soft);
    --text-primary:#ffffff; --text-secondary:#7d8e9b; --text-meta:rgba(255,255,255,.45);
    --divider:#101921; --input-bg:#17212b; --scrollbar:rgba(255,255,255,.2);
    --shadow:0 1px 1px rgba(0,0,0,.3); --green:#4dcd5e; --red:#e9573f;
  }
  html[data-accent="blue"]   { --accent:#3390ec; --accent-hover:#2b7ed4; --accent-soft:rgba(51,144,236,.13);  --bubble-out:#e7f3ff; }
  html[data-accent="green"]  { --accent:#2fae4f; --accent-hover:#279247; --accent-soft:rgba(47,174,79,.13);   --bubble-out:#e7f9ea; }
  html[data-accent="purple"] { --accent:#8b5cf6; --accent-hover:#7a4fe0; --accent-soft:rgba(139,92,246,.13);  --bubble-out:#f1e9ff; }

  *{box-sizing:border-box}
  #app-view{background:var(--bg-app)}
  #sidebar,#chat-list,#settings-panel{background:var(--bg-panel)}
  #chat-header,#input-bar{border-bottom:1px solid var(--divider);background:var(--bg-panel)}
  #input-bar{border-top:1px solid var(--divider)}
  #chat-window,#messages-wrap{background:var(--chat-bg)}
  .chat-item:hover{background:var(--bg-hover)}
  .chat-item.active{background:var(--bg-active)}
  .avatar{color:#fff;font-weight:600;overflow:hidden}
  .avatar img{width:100%;height:100%;object-fit:cover}
  .chat-info .name{color:var(--text-primary)}
  .chat-info .preview{color:var(--text-secondary)}
  .chat-header .name,#chat-name{color:var(--text-primary)}
  .chat-header .status,#chat-status{color:var(--text-secondary)}
  .msg-bubble{background:var(--bubble-in);color:var(--text-primary);box-shadow:var(--shadow)}
  .msg.out .msg-bubble{background:var(--bubble-out);color:var(--text-primary)}
  .msg .sender{color:var(--accent)}
  .msg .text{font-size:15px;line-height:1.35;word-wrap:break-word;white-space:pre-wrap}
  .msg .meta{font-size:11px;color:var(--text-meta);text-align:right;margin-top:2px}
  .msg.out .meta{color:var(--text-secondary)}
  .msg-media{margin:4px 0;border-radius:10px;overflow:hidden;cursor:pointer;position:relative;background:var(--bg-hover)}
  .msg-media img{display:block;max-width:100%;border-radius:10px}
  .file-card{display:flex;align-items:center;gap:10px;padding:10px;background:var(--bg-hover);border-radius:10px;min-width:220px}
  .file-icon{font-size:28px}
  .file-info{flex:1;min-width:0}
  .file-name{font-size:14px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:var(--text-primary)}
  .file-size{font-size:12px;color:var(--text-secondary)}
  .file-dl-btn,.act-btn{background:var(--accent);color:#fff;border:none;border-radius:18px;padding:6px 12px;cursor:pointer;font-size:13px}
  .act-btn{background:var(--bg-hover);color:var(--text-secondary);width:34px;height:34px;padding:0;border-radius:50%;
    display:inline-flex;align-items:center;justify-content:center;margin-left:6px}
  .act-btn:hover{background:var(--accent-soft);color:var(--accent)}
  .act-btn svg{width:18px;height:18px;fill:currentColor}
  .msg-actions{display:flex;justify-content:flex-end;margin-top:4px}
  .date-sep span{background:var(--bg-hover);color:var(--text-secondary);font-size:12px;padding:3px 12px;border-radius:12px}
  .loading-spinner{width:28px;height:28px;border:3px solid var(--divider);border-top-color:var(--accent);
    border-radius:50%;margin:20px auto;animation:spin 1s linear infinite}
  @keyframes spin{to{transform:rotate(360deg)}}
  #login-view{background:var(--bg-app)}
  .login-status{margin-top:10px;font-size:14px}
  .login-status.error{color:var(--red)}
  .login-status.success{color:var(--green)}

  /* 统一图标按钮 */
  .icon-btn{background:transparent;border:none;color:var(--text-secondary);cursor:pointer;
    display:inline-flex;align-items:center;justify-content:center;padding:8px;border-radius:50%}
  .icon-btn:hover{background:var(--bg-hover);color:var(--accent)}
  .icon-btn svg{width:22px;height:22px;fill:currentColor}
  #menu-btn,#back-btn,#search-in-chat{color:var(--text-secondary);background:none;border:none;cursor:pointer;
    width:40px;height:40px;border-radius:50%;display:flex;align-items:center;justify-content:center}
  #menu-btn:hover,#back-btn:hover,#search-in-chat:hover{background:var(--bg-hover);color:var(--accent)}
  #menu-btn svg,#back-btn svg,#search-in-chat svg{width:22px;height:22px;fill:currentColor}
  #send-btn,#attach-btn{display:inline-flex;align-items:center;justify-content:center;border:none;cursor:pointer;border-radius:50%}
  #send-btn{background:var(--accent);color:#fff;width:44px;height:44px}
  #send-btn:hover{background:var(--accent-hover)}
  #send-btn:disabled{opacity:.4;cursor:default}
  #send-btn svg{width:20px;height:20px;fill:#fff}
  #attach-btn{color:var(--text-secondary);background:none;width:44px;height:44px}
  #attach-btn:hover{background:var(--bg-hover);color:var(--accent)}
  #attach-btn svg{width:22px;height:22px;fill:currentColor}
  #msg-input{background:var(--input-bg);color:var(--text-primary);border:none;border-radius:18px;
    padding:10px 16px;font-size:15px;resize:none;outline:none}
  #search-input{background:var(--input-bg);color:var(--text-primary);border:none;border-radius:18px;
    padding:8px 14px 8px 42px;font-size:14px;outline:none;width:100%}

  /* 媒体播放覆盖层（始终显示首帧 + 播放按钮） */
  .play-overlay{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;
    background:rgba(0,0,0,.28);font-size:46px;pointer-events:auto;cursor:pointer;color:#fff}
  .vd-progress{position:absolute;left:8px;right:8px;bottom:8px;height:5px;background:rgba(255,255,255,.3);
    border-radius:3px;overflow:hidden}
  .vd-bar{height:100%;width:0;background:var(--accent);transition:width .15s linear}
  .vd-pct{position:absolute;right:8px;bottom:16px;font-size:11px;color:#fff;text-shadow:0 1px 2px rgba(0,0,0,.6)}

  /* 媒体查看器（全屏弹窗 + 左右切换） */
  #media-viewer{position:fixed;inset:0;background:rgba(0,0,0,.94);z-index:1000;display:none;
    align-items:center;justify-content:center;flex-direction:column}
  #media-viewer.open{display:flex}
  #mv-stage{flex:1;width:100%;display:flex;align-items:center;justify-content:center;position:relative;overflow:hidden}
  #mv-content{max-width:96%;max-height:86%;border-radius:8px}
  #mv-content.audio{width:90%;max-width:520px}
  .mv-nav{position:absolute;top:50%;transform:translateY(-50%);width:54px;height:54px;border-radius:50%;
    background:rgba(255,255,255,.14);border:none;color:#fff;font-size:26px;cursor:pointer;
    display:flex;align-items:center;justify-content:center}
  .mv-nav:hover{background:rgba(255,255,255,.28)}
  .mv-prev{left:14px}.mv-next{right:14px}
  #mv-bar{display:flex;gap:10px;align-items:center;padding:14px;background:rgba(0,0,0,.5);width:100%;justify-content:center}
  #mv-bar .icon-btn{background:rgba(255,255,255,.12)}
  #mv-bar .icon-btn:hover{background:rgba(255,255,255,.25);color:#fff}
  #mv-caption{color:#fff;font-size:14px;max-width:60%;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}

  /* 网盘面板 */
  #netdisk-panel{position:fixed;inset:0;background:var(--bg-app);z-index:900;display:none;flex-direction:column}
  #netdisk-panel.open{display:flex}
  #nd-header{display:flex;align-items:center;gap:10px;padding:10px 14px;background:var(--bg-panel);
    border-bottom:1px solid var(--divider)}
  #nd-header .title{font-weight:600;font-size:17px;flex:1;color:var(--text-primary)}
  #nd-grid{flex:1;overflow:auto;padding:14px;display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));
    gap:12px;align-content:start}
  .nd-card{background:var(--bg-panel);border-radius:10px;overflow:hidden;cursor:pointer;border:1px solid var(--divider);
    display:flex;flex-direction:column}
  .nd-thumb{height:120px;background:var(--bg-hover);display:flex;align-items:center;justify-content:center;overflow:hidden}
  .nd-thumb img{width:100%;height:100%;object-fit:cover}
  .nd-thumb .ph{font-size:40px}
  .nd-meta{padding:8px 10px}
  .nd-name{font-size:13px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:var(--text-primary)}
  .nd-sub{font-size:11px;color:var(--text-secondary);margin-top:2px}
  .nd-actions{display:flex;gap:6px;padding:0 8px 8px}
  .nd-actions button{flex:1;background:var(--bg-hover);color:var(--text-primary);border:none;border-radius:8px;
    padding:6px;font-size:12px;cursor:pointer;display:flex;align-items:center;justify-content:center;gap:4px}
  .nd-actions button:hover{background:var(--accent-soft);color:var(--accent)}
  .nd-actions button svg{width:14px;height:14px;fill:currentColor}
  #nd-fab{position:fixed;right:22px;bottom:22px;width:56px;height:56px;border-radius:50%;background:var(--accent);
    color:#fff;border:none;font-size:28px;cursor:pointer;z-index:950;display:none;align-items:center;justify-content:center;
    box-shadow:0 4px 14px rgba(0,0,0,.3)}
  #nd-fab.open{display:flex}

  /* 主题设置 */
  .theme-row{display:flex;gap:10px;align-items:center}
  .theme-opt{flex:1;padding:10px;border:1px solid var(--divider);border-radius:10px;background:var(--bg-app);
    color:var(--text-primary);cursor:pointer;font-size:14px;font-weight:500}
  .theme-opt.active{border-color:var(--accent);color:var(--accent);background:var(--accent-soft)}
  .accent-opt{width:40px;height:40px;border-radius:50%;border:2px solid transparent;cursor:pointer}
  .accent-opt.active{border-color:var(--text-primary)}
  .hidden{display:none !important}
  `;
  document.head.appendChild(s);
}

// ===== SVG 图标 =====
const ICONS = {
  send: '<svg viewBox="0 0 24 24"><path d="M2 21l21-9L2 3v7l15 2-15 2z"/></svg>',
  attach: '<svg viewBox="0 0 24 24"><path d="M16.5 6v11.5a4 4 0 1 1-8 0V5a2.5 2.5 0 0 1 5 0v10.5a1 1 0 1 1-2 0V6H10v9.5a2.5 2.5 0 0 0 5 0V5a4 4 0 1 0-8 0v12.5a5.5 5.5 0 0 0 11 0V6h-1.5z"/></svg>',
  menu: '<svg viewBox="0 0 24 24"><path d="M3 6h18v2H3zm0 5h18v2H3zm0 5h18v2H3z"/></svg>',
  back: '<svg viewBox="0 0 24 24"><path d="M15.4 7.4 14 6l-6 6 6 6 1.4-1.4-4.6-4.6z"/></svg>',
  search: '<svg viewBox="0 0 24 24"><path d="M15.5 14h-.8l-.3-.3a6.5 6.5 0 1 0-.7.7l.3.3v.8l5 5 1.5-1.5-5-5zm-6 0A4.5 4.5 0 1 1 14 9.5 4.5 4.5 0 0 1 9.5 14z"/></svg>',
  download: '<svg viewBox="0 0 24 24"><path d="M12 3v10l4-4 1.4 1.4L12 16.8 6.6 11.4 8 10l4 4V3zM5 19h14v2H5z"/></svg>',
  share: '<svg viewBox="0 0 24 24"><path d="M18 16a3 3 0 0 0-2.4 1.2l-7-4.1a3 3 0 0 0 0-2.2l7-4.1A3 3 0 1 0 15 5l-7 4.1a3 3 0 1 0 0 5.8l7 4.1A3 3 0 1 0 18 16z"/></svg>',
  expand: '<svg viewBox="0 0 24 24"><path d="M5 5h6V3H3v8h2zm14-2v6h-2V5h-4V3zM5 19v-6H3v8h8v-2zm14 0h-6v2h8v-8h-2z"/></svg>',
  close: '<svg viewBox="0 0 24 24"><path d="M18.3 5.7 12 12l6.3 6.3-1.4 1.4L10.6 13.4 4.3 19.7 2.9 18.3 9.2 12 2.9 5.7 4.3 4.3 10.6 10.6 16.9 4.3z"/></svg>',
  netdisk: '<svg viewBox="0 0 24 24"><path d="M4 5h16a1 1 0 0 1 1 1v5H3V6a1 1 0 0 1 1-1zm-1 9h18v5a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1zm3 2h4v2H6z"/></svg>',
  folder: '<svg viewBox="0 0 24 24"><path d="M3 5h8l2 2h8a1 1 0 0 1 1 1v3H2V6a1 1 0 0 1 1-1zm-1 7h20v8a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1z"/></svg>',
};

// ===== 状态 =====
let client = null;
let phoneCodeHash = '';
let currentEntity = null;
let currentPeer = null;
let allChats = [];
let loginStep = 'phone';
let handlersRegistered = false;
let currentMediaList = [];
let mediaViewerIndex = -1;
let netdiskChannel = null;
let netdiskMediaList = [];
let isNetdiskMode = false;

const COLORS = ['#e17076','#7bc862','#65aadd','#a695c7','#ee7aae','#6ec9cb','#faa774','#5b7b9a'];

// ===== 创建客户端 =====
function createClient(sessionStr) {
  return new TelegramClient(
    new StringSession(sessionStr || ''),
    API_ID, API_HASH,
    { connectionRetries: 5, retryDelay: 2000, useWSS: true, networkSocket: ProxiedWebSockets }
  );
}
function saveSession() {
  try { if (client) localStorage.setItem('tg_session', client.session.save()); } catch (e) {}
}
window.addEventListener('beforeunload', saveSession);

// ===== DOM 引用 =====
const $ = (id) => document.getElementById(id);
const el = {
  loginView: $('login-view'), appView: $('app-view'),
  phone: $('phone'), code: $('code'), codeRow: $('code-row'),
  password: $('password'), passwordRow: $('password-row'),
  mainBtn: $('main-btn'), loginStatus: $('login-status'),
  sidebar: $('sidebar'), chatList: $('chat-list'), searchInput: $('search-input'),
  chatWindow: $('chat-window'), chatHeader: $('chat-header'), chatAvatar: $('chat-avatar'),
  chatName: $('chat-name'), chatStatus: $('chat-status'),
  messagesWrap: $('messages-wrap'), messages: $('messages'), messagesBg: $('messages-bg'),
  inputBar: $('input-bar'), msgInput: $('msg-input'), sendBtn: $('send-btn'),
  attachBtn: $('attach-btn'), fileInput: $('file-input'),
  menuBtn: $('menu-btn'), settingsPanel: $('settings-panel'), settingsClose: $('settings-close'),
  backBtn: $('back-btn'), logoutBtn: $('logout-btn'),
  bgFileInput: $('bg-file-input'), bgOpacity: $('bg-opacity'),
  previewOverlay: $('preview-overlay'), previewImg: $('preview-img'), previewClose: $('preview-close'),
};

// ===== 媒体信息提取 =====
function getMediaInfo(msg) {
  const doc = msg.document || msg.media?.document || (msg.media?.webpage?.document);
  const photo = msg.photo || msg.media?.photo || (msg.media?.webpage?.photo);
  const info = { type: 'file', mime: '', name: '', size: 0, w: 0, h: 0, duration: 0 };
  if (photo && !doc) { info.type = 'photo'; return info; }
  if (doc) {
    info.mime = doc.mimeType || '';
    info.size = doc.size || 0;
    const fn = (doc.attributes || []).find((a) => a.fileName);
    if (fn) info.name = fn.fileName;
    const v = (doc.attributes || []).find((a) => a.duration != null);
    if (v) { info.duration = v.duration || 0; info.w = v.w || 0; info.h = v.h || 0; }
    if (info.mime.startsWith('video/')) info.type = 'video';
    else if (info.mime.startsWith('audio/')) info.type = 'audio';
    else if (info.mime.startsWith('image/')) info.type = 'image';
    else info.type = 'file';
  }
  return info;
}

// ===== 初始化 =====
async function init() {
  injectTheme();
  buildMediaViewer();
  buildNetdiskUI();
  buildThemeUI();
  if (!API_ID || !API_HASH) {
    el.loginStatus.className = 'login-status error';
    el.loginStatus.textContent = '请设置环境变量（VITE_API_ID / VITE_API_HASH / VITE_PROXY_DOMAIN）';
    return;
  }
  const saved = localStorage.getItem('tg_session');
  if (saved) {
    try {
      client = createClient(saved);
      await client.connect();
      await client.getMe();
      registerHandlers();
      enterApp();
      return;
    } catch (e) {
      console.log('Session expired', e);
      localStorage.removeItem('tg_session');
    }
  }
  el.loginStatus.textContent = '请输入手机号登录';
}

// ===== 登录流程 =====
el.mainBtn.addEventListener('click', async () => {
  if (loginStep === 'phone') {
    const phone = el.phone.value.trim();
    if (!phone) return;
    el.mainBtn.disabled = true; el.mainBtn.textContent = '连接中...'; el.loginStatus.textContent = '';
    try {
      if (!client) client = createClient('');
      await client.connect();
      const r = await client.sendCode({ apiId: API_ID, apiHash: API_HASH }, phone);
      phoneCodeHash = r.phoneCodeHash;
      el.codeRow.classList.remove('hidden');
      el.mainBtn.textContent = '登录'; el.mainBtn.disabled = false;
      loginStep = 'code';
      el.loginStatus.className = 'login-status success';
      el.loginStatus.textContent = '验证码已发送';
    } catch (e) {
      el.loginStatus.className = 'login-status error';
      el.loginStatus.textContent = e.message || String(e);
      el.mainBtn.disabled = false; el.mainBtn.textContent = '发送验证码';
    }
  } else if (loginStep === 'code') {
    const code = el.code.value.trim();
    const phone = el.phone.value.trim();
    if (!code) return;
    el.mainBtn.disabled = true;
    try {
      await client.invoke(new Api.auth.SignIn({ phoneNumber: phone, phoneCodeHash, phoneCode: code }));
      saveSession(); registerHandlers(); enterApp();
    } catch (e) {
      if (e.message?.includes('SESSION_PASSWORD_NEEDED')) {
        el.passwordRow.classList.remove('hidden');
        el.mainBtn.textContent = '确认'; loginStep = 'password';
        el.loginStatus.className = 'login-status';
        el.loginStatus.textContent = '请输入两步验证密码';
      } else {
        el.loginStatus.className = 'login-status error';
        el.loginStatus.textContent = e.message || String(e);
      }
      el.mainBtn.disabled = false;
    }
  } else if (loginStep === 'password') {
    const pwd = el.password.value;
    if (!pwd) return;
    el.mainBtn.disabled = true;
    try {
      await client.signInWithPassword({ password: pwd });
      saveSession(); registerHandlers(); enterApp();
    } catch (e) {
      el.loginStatus.className = 'login-status error';
      el.loginStatus.textContent = e.message || String(e);
      el.mainBtn.disabled = false;
    }
  }
});

function enterApp() {
  el.loginView.style.display = 'none';
  el.appView.classList.add('active');
  loadChatList();
  loadBackground();
}

// ===== 实时消息监听 =====
function registerHandlers() {
  if (handlersRegistered || !client) return;
  handlersRegistered = true;
  client.addEventHandler(async (event) => {
    const m = event.message;
    if (!m) return;
    saveSession();
    if (isNetdiskMode && netdiskChannel && m.chatId?.toString() === netdiskChannel.id?.toString()) {
      refreshNetdiskGrid();
      return;
    }
    updateChatPreview(m);
    if (m.out) return;
    if (currentEntity && m.chatId?.toString() === currentEntity.id?.toString()) {
      renderMessageAndThumb(m, { entity: currentEntity });
      el.messages.scrollTop = el.messages.scrollHeight;
    }
  }, new NewMessage({}));
}

// ===== 聊天列表 =====
async function loadChatList() {
  el.chatList.innerHTML = '<div style="text-align:center;padding:20px;color:var(--text-secondary);">加载中...</div>';
  try {
    const dialogs = await client.getDialogs({ limit: 100 });
    allChats = [];
    el.chatList.innerHTML = '';
    for (let i = 0; i < dialogs.length; i++) {
      const d = dialogs[i];
      const entity = d.entity;
      const name = entity.title || entity.firstName || entity.username || 'Unknown';
      const preview = d.message?.message || d.message?.text || '';
      const color = COLORS[i % COLORS.length];
      const chat = { dialog: d, entity, name, preview, color, id: entity.id?.toString() || '' };
      allChats.push(chat);
      const item = document.createElement('div');
      item.className = 'chat-item';
      item.dataset.idx = i;
      item.innerHTML = `
        <div class="avatar" style="background:${color}">${escapeHtml(name.charAt(0).toUpperCase())}</div>
        <div class="chat-info">
          <div class="name">${escapeHtml(name)}</div>
          <div class="preview">${escapeHtml(preview.slice(0, 40))}</div>
        </div>`;
      item.addEventListener('click', () => openChat(chat, item));
      el.chatList.appendChild(item);
      // 异步加载真实头像
      loadAvatarInto(entity, item.querySelector('.avatar'));
    }
  } catch (e) {
    el.chatList.innerHTML = `<div style="padding:20px;color:var(--red);">错误: ${escapeHtml(e.message)}</div>`;
  }
}

function updateChatPreview(m) {
  const chatId = m.chatId?.toString();
  if (!chatId) return;
  const chat = allChats.find((c) => c.id === chatId);
  if (!chat) return;
  const text = typeof m.message === 'string' ? m.message : (typeof m.text === 'string' ? m.text : '');
  chat.preview = text;
  const idx = allChats.indexOf(chat);
  const item = el.chatList.querySelector(`.chat-item[data-idx="${idx}"]`);
  const prev = item?.querySelector('.preview');
  if (prev) prev.textContent = text.slice(0, 40);
}

// 用 downloadProfilePhoto 拉取真实头像（修复头像不显示）
async function loadAvatarInto(entity, avatarEl) {
  if (!avatarEl || !entity) return;
  try {
    const buf = await client.downloadProfilePhoto(entity, { isBig: false });
    if (buf && buf.length > 0) {
      const url = URL.createObjectURL(new Blob([buf], { type: 'image/jpeg' }));
      avatarEl.innerHTML = `<img src="${url}" alt="" />`;
    }
  } catch (e) { /* 无头像则保留首字母 */ }
}

el.searchInput.addEventListener('input', (e) => {
  const q = e.target.value.toLowerCase();
  document.querySelectorAll('.chat-item').forEach((item) => {
    const name = item.querySelector('.name')?.textContent.toLowerCase() || '';
    item.style.display = name.includes(q) ? '' : 'none';
  });
});

// ===== 打开聊天 =====
async function openChat(chat, itemEl) {
  isNetdiskMode = false;
  currentEntity = chat.entity;
  currentPeer = chat.dialog.inputPeer || chat.entity;
  document.querySelectorAll('.chat-item').forEach((i) => i.classList.remove('active'));
  if (itemEl) itemEl.classList.add('active');
  el.chatWindow.classList.remove('no-chat');
  el.chatWindow.querySelector('.placeholder')?.remove();
  el.chatHeader.classList.remove('hidden');
  el.messagesWrap.classList.remove('hidden');
  el.inputBar.classList.remove('hidden');
  el.chatName.textContent = chat.name;
  el.chatStatus.textContent = '在线';
  el.chatAvatar.textContent = escapeHtml(chat.name.charAt(0).toUpperCase());
  el.chatAvatar.style.background = chat.color;
  loadAvatarInto(chat.entity, el.chatAvatar);
  if (window.innerWidth <= 768) {
    el.sidebar.classList.add('hidden-mobile');
    el.chatWindow.classList.add('active-mobile');
  }
  el.messages.innerHTML = '<div class="loading-spinner"></div>';
  try {
    const messages = await client.getMessages(chat.entity, { limit: 50 });
    el.messages.innerHTML = '';
    let lastDate = '';
    currentMediaList = [];
    for (const msg of messages.reverse()) {
      const date = formatDate(msg.date);
      if (date !== lastDate) {
        lastDate = date;
        const sep = document.createElement('div');
        sep.className = 'date-sep';
        sep.innerHTML = `<span>${date}</span>`;
        el.messages.appendChild(sep);
      }
      renderMessageAndThumb(msg, chat);
      if (msg.media) currentMediaList.push(msg);
    }
    el.messages.scrollTop = el.messages.scrollHeight;
  } catch (e) {
    el.messages.innerHTML = `<div style="padding:20px;color:var(--red);">加载失败: ${escapeHtml(e.message)}</div>`;
  }
}

// ===== 渲染消息 =====
function renderMessage(msg, chat) {
  if (msg.className === 'MessageEmpty') return;
  const isOut = msg.out || false;
  const div = document.createElement('div');
  div.className = `msg ${isOut ? 'out' : 'in'}`;
  div.dataset.id = msg.id;
  const text = typeof msg.message === 'string' ? msg.message : (typeof msg.text === 'string' ? msg.text : '');
  const textHtml = text ? `<div class="text">${escapeHtml(text)}</div>` : '';
  const mediaHtml = msg.media ? renderMedia(msg) : '';
  let senderHtml = '';
  if (!isOut && chat.entity?.className === 'Channel' && msg.sender) {
    const senderName = msg.sender.firstName || msg.sender.title || '';
    if (senderName) senderHtml = `<div class="sender">${escapeHtml(senderName)}</div>`;
  }
  const time = formatTime(msg.date);
  const actions = msg.media ? `
    <div class="msg-actions">
      <button class="act-btn" data-act="share" data-id="${msg.id}" title="分享">${ICONS.share}</button>
      <button class="act-btn" data-act="download" data-id="${msg.id}" title="下载">${ICONS.download}</button>
      <button class="act-btn" data-act="view" data-id="${msg.id}" title="查看">${ICONS.expand}</button>
    </div>` : '';
  div.innerHTML = `<div class="msg-bubble">${senderHtml}${mediaHtml}${textHtml}${actions}<div class="meta">${time}</div></div>`;
  el.messages.appendChild(div);
}

function renderMedia(msg) {
  const info = getMediaInfo(msg);
  if (info.type === 'photo' || info.type === 'image') {
    return `<div class="msg-media" id="m-${msg.id}" data-msg-id="${msg.id}" style="width:300px;max-width:100%;aspect-ratio:3/2;background:var(--bg-hover);display:flex;align-items:center;justify-content:center;">🖼️</div>`;
  }
  if (info.type === 'video') {
    return `<div class="msg-media" id="v-${msg.id}" data-msg-id="${msg.id}" style="position:relative;width:320px;max-width:100%;aspect-ratio:16/9;background:#000;display:flex;align-items:center;justify-content:center;font-size:40px;color:#fff;">🎬<div class="play-overlay">▶️</div></div>`;
  }
  if (info.type === 'audio') {
    return `<div class="msg-media" id="a-${msg.id}" data-msg-id="${msg.id}" style="padding:8px;">🎵 加载中...</div>`;
  }
  const fileName = info.name || `file_${msg.id}`;
  const size = formatSize(info.size);
  const icon = info.mime === 'application/pdf' ? '📄' : info.mime.includes('zip') ? '🗜️' : '📦';
  return `<div class="msg-media"><div class="file-card">
    <div class="file-icon">${icon}</div>
    <div class="file-info"><div class="file-name">${escapeHtml(fileName)}</div><div class="file-size">${size}</div></div>
  </div></div>`;
}

// 异步加载缩略图：始终显示首帧（视频即首帧），点播才下完整文件
async function loadMediaThumb(msg) {
  const container = $(`m-${msg.id}`) || $(`v-${msg.id}`) || $(`a-${msg.id}`);
  if (!container) return;
  try {
    const thumbBuf = await client.downloadMedia(msg, { thumb: true });
    if (thumbBuf && thumbBuf.length > 0) {
      const url = URL.createObjectURL(new Blob([thumbBuf], { type: 'image/jpeg' }));
      let inner = `<img src="${url}" alt="" loading="lazy" />`;
      const info = getMediaInfo(msg);
      if (info.type === 'video') inner += `<div class="play-overlay">▶️</div>`;
      container.innerHTML = inner;
      container.dataset.msgId = msg.id;
    }
  } catch (e) { console.log('thumb error', e); }
}

// 统一点击：卡片内播放 > 操作按钮 > 打开查看器
el.messages.addEventListener('click', (e) => {
  const playEl = e.target.closest('.play-overlay');
  if (playEl) {
    const container = playEl.closest('.msg-media');
    const id = parseInt(container.dataset.msgId);
    const msg = currentMediaList.find((m) => m.id === id);
    if (msg) inlinePlayVideo(container, msg);
    return;
  }
  const actBtn = e.target.closest('.act-btn');
  if (actBtn) {
    const id = parseInt(actBtn.dataset.id);
    const act = actBtn.dataset.act;
    const msg = currentMediaList.find((m) => m.id === id);
    if (!msg) return;
    if (act === 'view') { const idx = currentMediaList.findIndex((m) => m.id === id); openMediaViewer(idx, currentMediaList); }
    else if (act === 'download') downloadMedia(msg);
    else if (act === 'share') shareMedia(msg);
    return;
  }
  const mediaEl = e.target.closest('.msg-media');
  if (mediaEl && !e.target.closest('.msg-actions')) {
    const id = parseInt(mediaEl.dataset.msgId);
    const idx = currentMediaList.findIndex((m) => m.id === id);
    if (idx >= 0) openMediaViewer(idx, currentMediaList);
  }
});

// 卡片内视频：先显示首帧，点击后带进度条下载并播放
function inlinePlayVideo(container, msg) {
  container.innerHTML = `
    <video class="vd-video" controls playsinline style="max-width:340px;max-height:380px;width:100%;border-radius:8px;display:none;background:#000;"></video>
    <div class="vd-progress" style="display:block;"><div class="vd-bar"></div></div>
    <div class="vd-pct">0%</div>`;
  const video = container.querySelector('.vd-video');
  const bar = container.querySelector('.vd-bar');
  const pct = container.querySelector('.vd-pct');
  (async () => {
    try {
      const buf = await client.downloadMedia(msg, {
        progressCallback: (p, _cur, total) => {
          let ratio = (typeof p === 'number') ? (p <= 1 ? p : (total ? p / total : 0)) : 0;
          if (ratio > 0) { bar.style.width = Math.min(100, ratio * 100) + '%'; pct.textContent = Math.round(ratio * 100) + '%'; }
        }
      });
      if (!buf) { container.innerHTML = '🎬 加载失败'; return; }
      const info = getMediaInfo(msg);
      const mime = info.mime || 'video/mp4';
      const url = URL.createObjectURL(new Blob([buf], { type: mime }));
      video.src = url;
      video.style.display = 'block';
      container.querySelector('.vd-progress').style.display = 'none';
      pct.style.display = 'none';
      video.play().catch(() => {});
    } catch (err) { container.innerHTML = '🎬 播放失败'; }
  })();
}

// ===== 媒体查看器（全屏 + 左右滑动切换）=====
function buildMediaViewer() {
  const v = document.createElement('div');
  v.id = 'media-viewer';
  v.innerHTML = `
    <div id="mv-stage">
      <button class="mv-nav mv-prev" id="mv-prev">‹</button>
      <div id="mv-content-holder"></div>
      <button class="mv-nav mv-next" id="mv-next">›</button>
    </div>
    <div id="mv-bar">
      <span id="mv-caption"></span>
      <button class="icon-btn" id="mv-share" title="分享">${ICONS.share}</button>
      <button class="icon-btn" id="mv-dl" title="下载">${ICONS.download}</button>
      <button class="icon-btn" id="mv-close" title="关闭">${ICONS.close}</button>
    </div>`;
  document.body.appendChild(v);
  $('mv-prev').addEventListener('click', () => navMedia(-1));
  $('mv-next').addEventListener('click', () => navMedia(1));
  $('mv-close').addEventListener('click', closeMediaViewer);
  $('mv-dl').addEventListener('click', () => { if (mediaViewerIndex >= 0) downloadMedia(currentMediaList[mediaViewerIndex]); });
  $('mv-share').addEventListener('click', () => { if (mediaViewerIndex >= 0) shareMedia(currentMediaList[mediaViewerIndex]); });
  document.addEventListener('keydown', (e) => {
    if (!$('media-viewer').classList.contains('open')) return;
    if (e.key === 'ArrowLeft') navMedia(-1);
    else if (e.key === 'ArrowRight') navMedia(1);
    else if (e.key === 'Escape') closeMediaViewer();
  });
  const stage = $('mv-stage');
  let sx = 0, sy = 0;
  stage.addEventListener('touchstart', (e) => { sx = e.touches[0].clientX; sy = e.touches[0].clientY; }, { passive: true });
  stage.addEventListener('touchend', (e) => {
    const dx = e.changedTouches[0].clientX - sx;
    const dy = e.changedTouches[0].clientY - sy;
    if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy)) navMedia(dx < 0 ? 1 : -1);
  }, { passive: true });
}

function openMediaViewer(index, list) {
  currentMediaList = list;
  mediaViewerIndex = index;
  $('media-viewer').classList.add('open');
  renderMediaViewer();
}
function closeMediaViewer() {
  $('media-viewer').classList.remove('open');
  $('mv-content-holder').innerHTML = '';
  mediaViewerIndex = -1;
}
function navMedia(dir) {
  if (currentMediaList.length === 0) return;
  mediaViewerIndex = (mediaViewerIndex + dir + currentMediaList.length) % currentMediaList.length;
  renderMediaViewer();
}
async function renderMediaViewer() {
  const msg = currentMediaList[mediaViewerIndex];
  if (!msg) return;
  const holder = $('mv-content-holder');
  holder.innerHTML = '<div class="loading-spinner"></div>';
  const info = getMediaInfo(msg);
  const caption = (typeof msg.message === 'string' ? msg.message : '') || info.name || '';
  $('mv-caption').textContent = caption;
  try {
    if (['video','audio','file','image','photo'].includes(info.type)) {
      const buf = await client.downloadMedia(msg);
      if (!buf) { holder.innerHTML = '<div style="color:#fff">加载失败</div>'; return; }
      const mime = info.mime || (info.type === 'image' || info.type === 'photo' ? 'image/jpeg' : 'application/octet-stream');
      const url = URL.createObjectURL(new Blob([buf], { type: mime }));
      if (info.type === 'video') holder.innerHTML = `<video id="mv-content" class="video" controls autoplay src="${url}"></video>`;
      else if (info.type === 'audio') holder.innerHTML = `<audio id="mv-content" class="audio" controls autoplay src="${url}"></audio>`;
      else if (info.type === 'image' || info.type === 'photo') holder.innerHTML = `<img id="mv-content" class="img" src="${url}" />`;
      else holder.innerHTML = `<iframe id="mv-content" class="img" src="${url}" style="background:#fff"></iframe>`;
    } else {
      holder.innerHTML = '<div style="color:#fff">不支持的媒体</div>';
    }
  } catch (e) {
    holder.innerHTML = `<div style="color:#ff6b6b;">加载失败: ${escapeHtml(e.message)}</div>`;
  }
}

// ===== 下载 / 分享 =====
async function downloadMedia(msg) {
  try {
    const info = getMediaInfo(msg);
    const buf = await client.downloadMedia(msg);
    if (!buf) { alert('下载失败：无数据'); return; }
    const mime = info.mime || (info.type === 'image' || info.type === 'photo' ? 'image/jpeg' : 'application/octet-stream');
    const blob = new Blob([buf], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = info.name || `telegram_${msg.id}`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  } catch (e) { alert('下载失败: ' + (e.message || e)); }
}

async function shareMedia(msg) {
  try {
    const info = getMediaInfo(msg);
    const buf = await client.downloadMedia(msg);
    if (!buf) { alert('分享失败：无数据'); return; }
    const mime = info.mime || 'application/octet-stream';
    const blob = new Blob([buf], { type: mime });
    const file = new File([blob], info.name || `telegram_${msg.id}`, { type: mime });
    let link = '';
    const shareEntity = isNetdiskMode ? netdiskChannel : currentEntity;
    if (shareEntity?.username) link = `https://t.me/${shareEntity.username}/${msg.id}`;
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      await navigator.share({ files: [file], title: info.name, text: link });
    } else if (link) {
      await navigator.clipboard.writeText(link);
      alert('分享链接已复制：\n' + link);
    } else {
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a'); a.href = url; a.download = file.name; a.click();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    }
  } catch (e) { if (e.name !== 'AbortError') alert('分享失败: ' + (e.message || e)); }
}

// 图片预览（原有 lightbox，保留）
function openPreview(url) {
  if (el.previewImg) { el.previewImg.src = url; el.previewOverlay?.classList.remove('hidden'); }
}
el.previewClose?.addEventListener('click', () => el.previewOverlay?.classList.add('hidden'));
el.previewOverlay?.addEventListener('click', (e) => { if (e.target === el.previewOverlay) el.previewOverlay.classList.add('hidden'); });

// 渲染时顺带加载缩略图
const _origRenderMessage = renderMessage;
function renderMessageAndThumb(msg, chat) {
  _origRenderMessage(msg, chat);
  if (msg.media) {
    const info = getMediaInfo(msg);
    if (info.type !== 'file') loadMediaThumb(msg);
  }
}

// ===== 发送消息 =====
el.sendBtn.addEventListener('click', () => sendMessage());
el.msgInput.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); } });
el.msgInput.addEventListener('input', () => { el.msgInput.style.height = 'auto'; el.msgInput.style.height = Math.min(el.msgInput.scrollHeight, 120) + 'px'; });

async function sendMessage() {
  const text = el.msgInput.value.trim();
  if (!text || !currentEntity) return;
  el.msgInput.value = ''; el.msgInput.style.height = 'auto';
  el.sendBtn.disabled = true;
  try {
    const sent = await client.sendMessage(currentEntity, { message: text });
    if (sent) { renderMessageAndThumb(sent, { entity: currentEntity }); el.messages.scrollTop = el.messages.scrollHeight; updateChatPreview(sent); }
    saveSession();
  } catch (e) { alert('发送失败: ' + (e.message || e)); }
  el.sendBtn.disabled = false;
}

// ===== 发送附件（用 CustomFile 包裹，浏览器上传最稳妥）=====
el.attachBtn.addEventListener('click', () => el.fileInput.click());
el.fileInput.addEventListener('change', async () => {
  const files = Array.from(el.fileInput.files || []);
  if (!files.length || !currentEntity) return;
  el.fileInput.value = '';
  for (const file of files) {
    el.sendBtn.disabled = true;
    try {
      const custom = new CustomFile(file.name, file.size, file.name, file);
      const sent = await client.sendFile(currentEntity, {
        file: custom,
        caption: file.name || '',
        forceDocument: !/^image\//.test(file.type || ''),
        workers: 4,
      });
      if (sent) { renderMessageAndThumb(sent, { entity: currentEntity }); el.messages.scrollTop = el.messages.scrollHeight; updateChatPreview(sent); }
      saveSession();
    } catch (e) {
      console.error('附件发送失败:', e);
      alert('发送失败: ' + (e?.message || e));
    }
  }
  el.sendBtn.disabled = false;
});

// ===== 返回（移动端）=====
el.backBtn.addEventListener('click', () => {
  el.sidebar.classList.remove('hidden-mobile');
  el.chatWindow.classList.remove('active-mobile');
});

// ===== 设置面板 =====
el.menuBtn.addEventListener('click', async () => {
  el.settingsPanel.classList.add('open');
  await fillNetdiskChannels();
});
el.settingsClose.addEventListener('click', () => el.settingsPanel.classList.remove('open'));

document.querySelectorAll('.bg-option').forEach((opt) => {
  opt.addEventListener('click', () => {
    const bg = opt.dataset.bg;
    if (bg === 'default') { el.messagesBg.style.background = 'var(--chat-bg)'; el.messagesBg.style.opacity = 1; localStorage.removeItem('tg_bg'); }
    else if (bg === 'telegram') {
      el.messagesBg.style.background = 'linear-gradient(135deg, rgba(51,144,236,.12), rgba(143,92,246,.12))';
      el.messagesBg.style.opacity = 1; localStorage.setItem('tg_bg', 'telegram');
    }
  });
});
el.bgFileInput.addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (ev) => { const dataUrl = ev.target.result; localStorage.setItem('tg_bg', dataUrl); el.messagesBg.style.backgroundImage = `url(${dataUrl})`; el.messagesBg.style.backgroundSize = 'cover'; el.messagesBg.style.opacity = 1; };
  reader.readAsDataURL(file);
});
el.bgOpacity.addEventListener('input', (e) => { el.messagesBg.style.opacity = (e.target.value / 100); localStorage.setItem('tg_bg_opacity', e.target.value); });

function loadBackground() {
  const bg = localStorage.getItem('tg_bg');
  const opacity = localStorage.getItem('tg_bg_opacity') || '0';
  el.bgOpacity.value = parseInt(opacity);
  el.messagesBg.style.opacity = (parseInt(opacity) / 100);
  if (bg === 'telegram') el.messagesBg.style.background = 'linear-gradient(135deg, rgba(51,144,236,.12), rgba(143,92,246,.12))';
  else if (bg && bg.startsWith('data:')) { el.messagesBg.style.backgroundImage = `url(${bg})`; el.messagesBg.style.backgroundSize = 'cover'; }
  else el.messagesBg.style.background = 'var(--chat-bg)';
}

// ===== 退出登录 =====
el.logoutBtn.addEventListener('click', () => {
  if (!confirm('确定退出登录？')) return;
  localStorage.removeItem('tg_session');
  location.reload();
});

// ===== 主题设置 UI =====
function buildThemeUI() {
  if ($('theme-section')) return;
  const wrap = document.createElement('div');
  wrap.id = 'theme-section';
  wrap.className = 'settings-section';
  wrap.innerHTML = `
    <h3>外观</h3>
    <div class="theme-row">
      <button class="theme-opt" data-theme="light">浅色</button>
      <button class="theme-opt" data-theme="dark">深色</button>
    </div>
    <h3 style="margin-top:14px;">主题色</h3>
    <div class="theme-row">
      <button class="accent-opt" data-accent="blue" style="background:#3390ec" title="蓝色"></button>
      <button class="accent-opt" data-accent="green" style="background:#2fae4f" title="绿色"></button>
      <button class="accent-opt" data-accent="purple" style="background:#8b5cf6" title="紫色"></button>
    </div>
    <h3 style="margin-top:14px;">网盘模式</h3>
    <div style="font-size:13px;color:var(--text-secondary);margin-bottom:8px;">选择一个频道作为网盘（文件保存在该频道）</div>
    <select id="netdisk-channel" style="width:100%;padding:8px;border-radius:8px;background:var(--input-bg);color:var(--text-primary);border:1px solid var(--divider);"></select>
    <button id="netdisk-enter" style="margin-top:10px;width:100%;padding:10px;border:none;border-radius:8px;background:var(--accent);color:#fff;cursor:pointer;font-weight:500;">进入网盘</button>`;
  el.settingsPanel.appendChild(wrap);
  wrap.querySelectorAll('.theme-opt').forEach((b) => b.addEventListener('click', () => setTheme(b.dataset.theme)));
  wrap.querySelectorAll('.accent-opt').forEach((b) => b.addEventListener('click', () => setAccent(b.dataset.accent)));
  $('netdisk-enter').addEventListener('click', () => enterNetdisk());
  updateThemeUI();
}
function setTheme(t) { document.documentElement.dataset.theme = t; localStorage.setItem('tg_theme', t); updateThemeUI(); }
function setAccent(a) { document.documentElement.dataset.accent = a; localStorage.setItem('tg_accent', a); updateThemeUI(); }
function updateThemeUI() {
  const t = document.documentElement.dataset.theme, a = document.documentElement.dataset.accent;
  document.querySelectorAll('.theme-opt').forEach((b) => b.classList.toggle('active', b.dataset.theme === t));
  document.querySelectorAll('.accent-opt').forEach((b) => b.classList.toggle('active', b.dataset.accent === a));
}

// ===== 网盘模式 =====
function buildNetdiskUI() {
  const panel = document.createElement('div');
  panel.id = 'netdisk-panel';
  panel.innerHTML = `
    <div id="nd-header">
      <button class="icon-btn" id="nd-back">${ICONS.back}</button>
      <div class="title" id="nd-title">网盘</div>
      <button class="icon-btn" id="nd-refresh" title="刷新">⟳</button>
    </div>
    <div id="nd-grid"></div>`;
  document.body.appendChild(panel);
  const fab = document.createElement('button');
  fab.id = 'nd-fab'; fab.innerHTML = '+'; fab.title = '上传文件';
  document.body.appendChild(fab);
  const ndFile = document.createElement('input');
  ndFile.type = 'file'; ndFile.id = 'nd-file'; ndFile.multiple = true; ndFile.style.display = 'none';
  document.body.appendChild(ndFile);
  $('nd-back').addEventListener('click', exitNetdisk);
  $('nd-refresh').addEventListener('click', refreshNetdiskGrid);
  fab.addEventListener('click', () => ndFile.click());
  ndFile.addEventListener('change', uploadToNetdisk);
}

async function fillNetdiskChannels() {
  const sel = $('netdisk-channel');
  if (!sel) return;
  sel.innerHTML = '<option value="">加载中...</option>';
  try {
    const dialogs = await client.getDialogs({ limit: 100 });
    const channels = dialogs.filter((d) => d.entity.className === 'Channel');
    if (channels.length === 0) { sel.innerHTML = '<option value="">没有可用频道</option>'; return; }
    sel.innerHTML = channels.map((d) => `<option value="${d.entity.id}">${escapeHtml(d.entity.title || d.entity.username || '频道')}</option>`).join('');
  } catch (e) { sel.innerHTML = `<option value="">加载失败: ${escapeHtml(e.message)}</option>`; }
}

async function enterNetdisk() {
  const sel = $('netdisk-channel');
  const id = sel?.value;
  if (!id) { alert('请先选择一个频道'); return; }
  const dialogs = await client.getDialogs({ limit: 100 });
  netdiskChannel = dialogs.find((d) => d.entity.id?.toString() === id)?.entity;
  if (!netdiskChannel) { alert('频道无效'); return; }
  isNetdiskMode = true;
  el.settingsPanel.classList.remove('open');
  $('netdisk-panel').classList.add('open');
  $('nd-fab').classList.add('open');
  $('nd-title').textContent = netdiskChannel.title || netdiskChannel.username || '网盘';
  await refreshNetdiskGrid();
}

function exitNetdisk() {
  isNetdiskMode = false;
  $('netdisk-panel').classList.remove('open');
  $('nd-fab').classList.remove('open');
}

async function refreshNetdiskGrid() {
  const grid = $('nd-grid');
  if (!grid || !netdiskChannel) return;
  grid.innerHTML = '<div class="loading-spinner"></div>';
  try {
    const messages = await client.getMessages(netdiskChannel, { limit: 100 });
    netdiskMediaList = messages.filter((m) => m.media).reverse();
    currentMediaList = netdiskMediaList;
    if (netdiskMediaList.length === 0) { grid.innerHTML = '<div style="color:var(--text-secondary);padding:20px;">该频道暂无文件</div>'; return; }
    grid.innerHTML = '';
    for (const msg of netdiskMediaList) {
      const info = getMediaInfo(msg);
      const card = document.createElement('div');
      card.className = 'nd-card';
      const thumbId = `nd-${msg.id}`;
      const icon = info.type === 'video' ? '🎬' : info.type === 'audio' ? '🎵' : info.type === 'file' ? '📦' : '🖼️';
      card.innerHTML = `
        <div class="nd-thumb" id="${thumbId}"><div class="ph">${icon}</div></div>
        <div class="nd-meta">
          <div class="nd-name">${escapeHtml(info.name || '未命名文件')}</div>
          <div class="nd-sub">${formatSize(info.size)}${info.duration ? ' · ' + fmtDur(info.duration) : ''}</div>
        </div>
        <div class="nd-actions">
          <button data-act="open" data-id="${msg.id}">${ICONS.expand} 预览</button>
          <button data-act="dl" data-id="${msg.id}">${ICONS.download} 下载</button>
        </div>`;
      card.querySelector('[data-act="open"]').addEventListener('click', () => {
        const idx = netdiskMediaList.findIndex((m) => m.id === msg.id);
        openMediaViewer(idx, netdiskMediaList);
      });
      card.querySelector('[data-act="dl"]').addEventListener('click', () => downloadMedia(msg));
      grid.appendChild(card);
      if (info.type !== 'file') loadNetdiskThumb(msg, thumbId);
    }
  } catch (e) {
    grid.innerHTML = `<div style="color:var(--red);padding:20px;">加载失败: ${escapeHtml(e.message)}</div>`;
  }
}

async function loadNetdiskThumb(msg, thumbId) {
  try {
    const buf = await client.downloadMedia(msg, { thumb: true });
    const c = $(thumbId);
    if (buf && buf.length > 0 && c) {
      const url = URL.createObjectURL(new Blob([buf], { type: 'image/jpeg' }));
      c.innerHTML = `<img src="${url}" alt="" />`;
    }
  } catch (e) {}
}

async function uploadToNetdisk() {
  const ndFile = $('nd-file');
  if (!ndFile.files || !ndFile.files.length || !netdiskChannel) return;
  for (const file of ndFile.files) {
    try {
      const custom = new CustomFile(file.name, file.size, file.name, file);
      await client.sendFile(netdiskChannel, { file: custom, caption: file.name || '', forceDocument: !/^image\//.test(file.type || '') });
    } catch (e) { alert('上传失败: ' + (e.message || e)); }
  }
  ndFile.value = '';
  await refreshNetdiskGrid();
}

// ===== 工具函数 =====
function formatSize(bytes) {
  if (!bytes) return '';
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
  if (bytes < 1073741824) return (bytes / 1048576).toFixed(1) + ' MB';
  return (bytes / 1073741824).toFixed(2) + ' GB';
}
function fmtDur(s) {
  s = Math.floor(s || 0);
  const m = Math.floor(s / 60), ss = s % 60;
  return `${m}:${ss.toString().padStart(2, '0')}`;
}
function escapeHtml(s) {
  if (!s) return '';
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function formatTime(ts) {
  if (!ts) return '';
  return new Date(ts * 1000).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
}
function formatDate(ts) {
  if (!ts) return '';
  const d = new Date(ts * 1000);
  if (d.toDateString() === new Date().toDateString()) return '今天';
  return d.toLocaleDateString('zh-CN', { month: 'long', day: 'numeric' });
}

// ===== 启动 =====
init();
