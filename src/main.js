import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions';
import { Api } from 'telegram/tl/api';
import { PromisedWebSockets } from 'telegram/extensions/PromisedWebSockets';
import { NewMessage } from 'telegram/events';

// ===== 配置（来自 Cloudflare Pages 的 Build 环境变量）=====
const API_ID = parseInt(import.meta.env.VITE_API_ID || '0');
const API_HASH = import.meta.env.VITE_API_HASH || '';
const PROXY_DOMAIN = import.meta.env.VITE_PROXY_DOMAIN || '';

// ===== 代理：重写 GramJS 内部的 WebSocket 地址（最可靠，不依赖全局 patch）=====
// GramJS 在浏览器用 w3cwebsocket，它在模块加载时就锁定了全局 WebSocket，
// 所以“覆盖 window.WebSocket”永远无效。这里直接继承 PromisedWebSockets，
// 重写它拼 URL 的 getWebSocketLink()，把地址改走你的 Worker 反代。
class ProxiedWebSockets extends PromisedWebSockets {
  getWebSocketLink(ip, port, testServers) {
    const path = `/apiws${testServers ? '_test' : ''}`;
    if (PROXY_DOMAIN) {
      return `wss://${PROXY_DOMAIN}/${ip}${path}`;
    }
    return super.getWebSocketLink(ip, port, testServers);
  }
}

if (!PROXY_DOMAIN) {
  console.warn('[tg] 未设置 VITE_PROXY_DOMAIN，将直连 Telegram（国内大概率失败）。请在 Cloudflare Pages 环境变量里配置。');
}

// 安全兜底：万一仍有对 telegram.org 的 HTTP 请求（如下载媒体等），也走代理
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

// ===== 主题：注入 Telegram 官方暗色主题（不依赖外部 CSS 文件）=====
function injectTheme() {
  if (document.getElementById('tg-theme')) return;
  const s = document.createElement('style');
  s.id = 'tg-theme';
  s.textContent = `
  :root{
    --tg-bg:#0e1621; --tg-panel:#17212b; --tg-hover:#202b36; --tg-active:#2b5278;
    --tg-blue:#3390ec; --tg-blue-2:#2ea6ff; --tg-text:#ffffff; --tg-text-2:#7d8e9b;
    --tg-bubble-in:#182533; --tg-bubble-out:#2b5278; --tg-divider:#101921;
    --tg-green:#4dcd5e; --tg-red:#e9573f;
  }
  *{box-sizing:border-box}
  body,html{margin:0;padding:0;background:var(--tg-bg);color:var(--tg-text);
    font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
    -webkit-font-smoothing:antialiased}
  #app-view{background:var(--tg-bg)}
  #sidebar,#chat-list,#settings-panel{background:var(--tg-panel)}
  #chat-header,#input-bar{background:var(--tg-panel);border-bottom:1px solid var(--tg-divider)}
  #input-bar{border-top:1px solid var(--tg-divider)}
  #chat-window,#messages-wrap{background:var(--tg-bg)}
  .chat-item{display:flex;align-items:center;gap:12px;padding:8px 12px;cursor:pointer;
    border-bottom:1px solid rgba(255,255,255,.03)}
  .chat-item:hover{background:var(--tg-hover)}
  .chat-item.active{background:var(--tg-active)}
  .avatar{width:50px;height:50px;border-radius:50%;flex:0 0 50px;display:flex;
    align-items:center;justify-content:center;color:#fff;font-weight:600;font-size:20px;overflow:hidden}
  .avatar img{width:100%;height:100%;object-fit:cover}
  .chat-info{flex:1;min-width:0}
  .chat-info .name{color:var(--tg-text);font-weight:600;font-size:15px;
    white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .chat-info .preview{color:var(--tg-text-2);font-size:13px;white-space:nowrap;
    overflow:hidden;text-overflow:ellipsis;margin-top:2px}
  .chat-header .name,#chat-name{color:var(--tg-text);font-weight:600}
  .chat-header .status,#chat-status{color:var(--tg-text-2);font-size:13px}
  .msg{display:flex;margin:2px 0;padding:0 12px}
  .msg.out{justify-content:flex-end}
  .msg.in{justify-content:flex-start}
  .msg-bubble{max-width:78%;padding:6px 10px 8px;border-radius:12px;position:relative;
    background:var(--tg-bubble-in);color:var(--tg-text);box-shadow:0 1px 1px rgba(0,0,0,.18)}
  .msg.out .msg-bubble{background:var(--tg-bubble-out)}
  .msg .sender{color:var(--tg-blue-2);font-size:13px;font-weight:600;margin-bottom:2px}
  .msg .text{font-size:15px;line-height:1.35;word-wrap:break-word;white-space:pre-wrap}
  .msg .meta{font-size:11px;color:rgba(255,255,255,.45);text-align:right;margin-top:2px}
  .msg.out .meta{color:rgba(255,255,255,.6)}
  .msg-media{margin:4px 0;border-radius:8px;overflow:hidden;cursor:pointer;position:relative}
  .msg-media img{display:block;max-width:100%;border-radius:8px}
  .file-card{display:flex;align-items:center;gap:10px;padding:10px;background:rgba(0,0,0,.2);
    border-radius:10px;min-width:220px}
  .file-icon{font-size:28px}
  .file-info{flex:1;min-width:0}
  .file-name{font-size:14px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .file-size{font-size:12px;color:var(--tg-text-2)}
  .file-dl-btn,.act-btn{background:var(--tg-blue);color:#fff;border:none;border-radius:18px;
    padding:6px 12px;cursor:pointer;font-size:13px}
  .act-btn{background:rgba(255,255,255,.12);width:34px;height:34px;padding:0;border-radius:50%;
    display:inline-flex;align-items:center;justify-content:center;margin-left:6px}
  .act-btn:hover{background:rgba(255,255,255,.22)}
  .act-btn svg{width:18px;height:18px;fill:#fff}
  .msg-actions{display:flex;justify-content:flex-end;margin-top:4px}
  .date-sep{text-align:center;margin:10px 0}
  .date-sep span{background:rgba(0,0,0,.3);color:var(--tg-text-2);font-size:12px;
    padding:3px 12px;border-radius:12px}
  .loading-spinner{width:28px;height:28px;border:3px solid rgba(255,255,255,.2);
    border-top-color:var(--tg-blue);border-radius:50%;margin:20px auto;animation:spin 1s linear infinite}
  @keyframes spin{to{transform:rotate(360deg)}}
  #login-view{background:var(--tg-panel)}
  .login-status{margin-top:10px;font-size:14px}
  .login-status.error{color:var(--tg-red)}
  .login-status.success{color:var(--tg-green)}
  #send-btn,#main-btn,#attach-btn,#menu-btn,#back-btn{background:var(--tg-blue);color:#fff;border:none;
    border-radius:50%;cursor:pointer;display:inline-flex;align-items:center;justify-content:center}
  #send-btn svg,#attach-btn svg,#menu-btn svg,#back-btn svg{width:22px;height:22px;fill:#fff}
  #msg-input{background:var(--tg-bg);color:var(--tg-text);border:1px solid var(--tg-divider);
    border-radius:18px;padding:10px 14px;font-size:15px;resize:none;outline:none}
  #search-input{background:var(--tg-bg);color:var(--tg-text);border:none;border-radius:18px;
    padding:8px 14px;font-size:14px;outline:none;width:100%}
  .icon-btn{background:transparent;border:none;color:var(--tg-text-2);cursor:pointer;
    display:inline-flex;align-items:center;justify-content:center;padding:6px;border-radius:50%}
  .icon-btn:hover{background:var(--tg-hover);color:var(--tg-text)}
  .icon-btn svg{width:22px;height:22px;fill:currentColor}
  /* 媒体查看器（全屏弹窗） */
  #media-viewer{position:fixed;inset:0;background:rgba(0,0,0,.92);z-index:1000;display:none;
    align-items:center;justify-content:center;flex-direction:column}
  #media-viewer.open{display:flex}
  #mv-stage{flex:1;width:100%;display:flex;align-items:center;justify-content:center;position:relative;overflow:hidden}
  #mv-content{max-width:96%;max-height:86%;border-radius:8px}
  #mv-content.video,#mv-content.img,#mv-content.audio{pointer-events:auto}
  #mv-content.audio{width:90%;max-width:520px}
  .mv-nav{position:absolute;top:50%;transform:translateY(-50%);width:54px;height:54px;
    border-radius:50%;background:rgba(255,255,255,.12);border:none;color:#fff;font-size:26px;
    cursor:pointer;display:flex;align-items:center;justify-content:center}
  .mv-nav:hover{background:rgba(255,255,255,.25)}
  .mv-prev{left:14px}.mv-next{right:14px}
  #mv-bar{display:flex;gap:10px;align-items:center;padding:14px;background:rgba(0,0,0,.4);width:100%;justify-content:center}
  #mv-bar .icon-btn{background:rgba(255,255,255,.1)}
  #mv-caption{color:#fff;font-size:14px;max-width:60%;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  /* 网盘面板 */
  #netdisk-panel{position:fixed;inset:0;background:var(--tg-bg);z-index:900;display:none;flex-direction:column}
  #netdisk-panel.open{display:flex}
  #nd-header{display:flex;align-items:center;gap:10px;padding:10px 14px;background:var(--tg-panel);
    border-bottom:1px solid var(--tg-divider)}
  #nd-header .title{font-weight:600;font-size:17px;flex:1}
  #nd-grid{flex:1;overflow:auto;padding:14px;display:grid;
    grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:12px;align-content:start}
  .nd-card{background:var(--tg-panel);border-radius:10px;overflow:hidden;cursor:pointer;
    border:1px solid var(--tg-divider);display:flex;flex-direction:column}
  .nd-thumb{height:120px;background:#0a0f16;display:flex;align-items:center;justify-content:center;overflow:hidden}
  .nd-thumb img{width:100%;height:100%;object-fit:cover}
  .nd-thumb .ph{font-size:40px}
  .nd-meta{padding:8px 10px}
  .nd-name{font-size:13px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .nd-sub{font-size:11px;color:var(--tg-text-2);margin-top:2px}
  .nd-actions{display:flex;gap:6px;padding:0 8px 8px}
  .nd-actions button{flex:1;background:var(--tg-hover);color:#fff;border:none;border-radius:8px;
    padding:6px;font-size:12px;cursor:pointer;display:flex;align-items:center;justify-content:center;gap:4px}
  .nd-actions button svg{width:14px;height:14px;fill:#fff}
  #nd-fab{position:fixed;right:22px;bottom:22px;width:56px;height:56px;border-radius:50%;
    background:var(--tg-blue);color:#fff;border:none;font-size:28px;cursor:pointer;z-index:950;
    display:none;align-items:center;justify-content:center;box-shadow:0 4px 14px rgba(0,0,0,.4)}
  #nd-fab.open{display:flex}
  .play-overlay{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;
    background:rgba(0,0,0,.25);font-size:46px;pointer-events:none}
  .hidden{display:none !important}
  `;
  document.head.appendChild(s);
}

// ===== SVG 图标 =====
const ICONS = {
  send: '<svg viewBox="0 0 24 24"><path d="M2 21l21-9L2 3v7l15 2-15 2z"/></svg>',
  attach: '<svg viewBox="0 0 24 24"><path d="M16.5 6v11.5a4 4 0 11-8 0V5a2.5 2.5 0 015 0v10.5a1 1 0 11-2 0V6H10v9.5a2.5 2.5 0 005 0V5a4 4 0 10-8 0v12.5a5.5 5.5 0 0011 0V6h-1.5z"/></svg>',
  menu: '<svg viewBox="0 0 24 24"><path d="M3 6h18v2H3zM3 11h18v2H3zM3 16h18v2H3z"/></svg>',
  back: '<svg viewBox="0 0 24 24"><path d="M15.4 7.4 14 6l-6 6 6 6 1.4-1.4-4.6-4.6z"/></svg>',
  search: '<svg viewBox="0 0 24 24"><path d="M15.5 14h-.8l-.3-.3a6.5 6.5 0 10-.7.7l.3.3v.8l5 5 1.5-1.5-5-5zm-6 0A4.5 4.5 0 1114 9.5 4.5 4.5 0 019.5 14z"/></svg>',
  download: '<svg viewBox="0 0 24 24"><path d="M12 3v10l4-4 1.4 1.4L12 16.8 6.6 11.4 8 10l4 4V3zM5 19h14v2H5z"/></svg>',
  share: '<svg viewBox="0 0 24 24"><path d="M18 16a3 3 0 00-2.4 1.2l-7-4.1a3 3 0 000-2.2l7-4.1A3 3 0 1015 5l-7 4.1a3 3 0 100 5.8l7 4.1A3 3 0 1018 16z"/></svg>',
  expand: '<svg viewBox="0 0 24 24"><path d="M5 5h6V3H3v8h2zm14-2v6h-2V5h-4V3zM5 19v-6H3v8h8v-2zm14 0h-6v2h8v-8h-2z"/></svg>',
  close: '<svg viewBox="0 0 24 24"><path d="M18.3 5.7 12 12l6.3 6.3-1.4 1.4L10.6 13.4 4.3 19.7 2.9 18.3 9.2 12 2.9 5.7 4.3 4.3 10.6 10.6 16.9 4.3z"/></svg>',
  netdisk: '<svg viewBox="0 0 24 24"><path d="M4 5h16a1 1 0 011 1v5H3V6a1 1 0 011-1zm-1 9h18v5a1 1 0 01-1 1H4a1 1 0 01-1-1zm3 2h4v2H6z"/></svg>',
  folder: '<svg viewBox="0 0 24 24"><path d="M3 5h8l2 2h8a1 1 0 011 1v3H2V6a1 1 0 011-1zm-1 7h20v8a1 1 0 01-1 1H3a1 1 0 01-1-1z"/></svg>',
};

// ===== 状态 =====
let client = null;
let phoneCodeHash = '';
let currentEntity = null;
let currentPeer = null;
let allChats = [];
let loginStep = 'phone';
let handlersRegistered = false;
let currentMediaList = [];   // 当前会话/网盘里的媒体消息，用于查看器翻页
let mediaViewerIndex = -1;
let netdiskChannel = null;   // 选作网盘的频道
let netdiskMediaList = [];
let isNetdiskMode = false;

const COLORS = ['#e17076','#7bc862','#65aadd','#a695c7','#ee7aae','#6ec9cb','#faa774','#5b7b9a'];

// ===== 创建客户端（统一配置浏览器 WebSocket 传输）=====
function createClient(sessionStr) {
  return new TelegramClient(
    new StringSession(sessionStr || ''),
    API_ID,
    API_HASH,
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

// ===== 工具：媒体信息提取 =====
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
      // 网盘频道新文件：刷新网格
      refreshNetdiskGrid();
      return;
    }
    updateChatPreview(m);
    if (m.out) return;
    if (currentEntity && m.chatId?.toString() === currentEntity.id?.toString()) {
      renderMessage(m, { entity: currentEntity });
      el.messages.scrollTop = el.messages.scrollHeight;
    }
  }, new NewMessage({}));
}

// ===== 聊天列表 =====
async function loadChatList() {
  el.chatList.innerHTML = '<div style="text-align:center;padding:20px;color:#708499;">加载中...</div>';
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
    }
    for (let i = 0; i < allChats.length; i++) loadAvatar(allChats[i]);
  } catch (e) {
    el.chatList.innerHTML = `<div style="padding:20px;color:#ff6b6b;">错误: ${escapeHtml(e.message)}</div>`;
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

async function loadAvatar(chat) {
  try {
    const photos = await client.getProfilePhotos(chat.entity);
    if (photos.length > 0) {
      const buf = await client.downloadMedia(photos[0], { thumb: true });
      if (buf && buf.length > 0) {
        const url = URL.createObjectURL(new Blob([buf], { type: 'image/jpeg' }));
        const items = el.chatList.querySelectorAll('.chat-item');
        for (const item of items) {
          if (item.dataset.idx == allChats.indexOf(chat)) {
            const av = item.querySelector('.avatar');
            if (av) av.innerHTML = `<img src="${url}" alt="" />`;
          }
        }
      }
    }
  } catch (e) {}
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
  el.chatAvatar.innerHTML = escapeHtml(chat.name.charAt(0).toUpperCase());
  el.chatAvatar.style.background = chat.color;
  if (window.innerWidth <= 768) {
    el.sidebar.classList.add('hidden-mobile');
    el.chatWindow.classList.add('active-mobile');
  }
  try {
    const photos = await client.getProfilePhotos(chat.entity);
    if (photos.length > 0) {
      const buf = await client.downloadMedia(photos[0], { thumb: true });
      if (buf && buf.length > 0) {
        const url = URL.createObjectURL(new Blob([buf], { type: 'image/jpeg' }));
        el.chatAvatar.innerHTML = `<img src="${url}" alt="" />`;
      }
    }
  } catch (e) {}
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
    el.messages.innerHTML = `<div style="padding:20px;color:#ff6b6b;">加载失败: ${escapeHtml(e.message)}</div>`;
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
  let textHtml = text ? `<div class="text">${escapeHtml(text)}</div>` : '';
  let mediaHtml = msg.media ? renderMedia(msg) : '';

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
    const id = `m-${msg.id}`;
    return `<div class="msg-media" id="${id}" data-msg-id="${msg.id}">
      <div style="width:300px;height:200px;background:#1a1a2e;display:flex;align-items:center;justify-content:center;border-radius:8px;">🖼️</div></div>`;
  }
  if (info.type === 'video') {
    const id = `v-${msg.id}`;
    return `<div class="msg-media" id="${id}" data-msg-id="${msg.id}" style="position:relative;">
      <div style="width:320px;height:200px;background:#000;display:flex;align-items:center;justify-content:center;border-radius:8px;font-size:40px;">🎬</div>
      <div class="play-overlay">▶️</div></div>`;
  }
  if (info.type === 'audio') {
    const id = `a-${msg.id}`;
    return `<div class="msg-media" id="${id}" data-msg-id="${msg.id}"><div style="padding:8px;">🎵 加载中...</div></div>`;
  }
  // 文件
  const fileName = info.name || `file_${msg.id}`;
  const size = formatSize(info.size);
  const icon = info.mime === 'application/pdf' ? '📄' : info.mime.includes('zip') ? '🗜️' : '📦';
  return `<div class="msg-media"><div class="file-card">
    <div class="file-icon">${icon}</div>
    <div class="file-info"><div class="file-name">${escapeHtml(fileName)}</div><div class="file-size">${size}</div></div>
  </div></div>`;
}

// 异步加载缩略图（仅缩略图，点播才下完整文件）
async function loadMediaThumb(msg) {
  const info = getMediaInfo(msg);
  const container = $(`m-${msg.id}`) || $(`v-${msg.id}`) || $(`a-${msg.id}`);
  if (!container) return;
  try {
    const thumbBuf = await client.downloadMedia(msg, { thumb: true });
    if (thumbBuf && thumbBuf.length > 0) {
      const url = URL.createObjectURL(new Blob([thumbBuf], { type: 'image/jpeg' }));
      let inner = `<img src="${url}" alt="" loading="lazy" />`;
      if (info.type === 'video') inner += `<div class="play-overlay">▶️</div>`;
      container.innerHTML = inner;
      container.dataset.msgId = msg.id;
    }
  } catch (e) { console.log('thumb error', e); }
}

// 统一点击处理：内联播放 > 操作按钮 > 打开查看器
el.messages.addEventListener('click', (e) => {
  // 1) 卡片内视频内联播放
  const playEl = e.target.closest('.play-overlay');
  if (playEl) {
    const container = playEl.closest('.msg-media');
    const id = parseInt(container.dataset.msgId);
    const msg = currentMediaList.find((m) => m.id === id);
    if (msg) inlinePlayVideo(container, msg);
    return;
  }
  // 2) 分享 / 下载 / 查看 按钮
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
  // 3) 点击媒体本身 → 全屏查看器
  const mediaEl = e.target.closest('.msg-media');
  if (mediaEl && !e.target.closest('.msg-actions')) {
    const id = parseInt(mediaEl.dataset.msgId);
    const idx = currentMediaList.findIndex((m) => m.id === id);
    if (idx >= 0) openMediaViewer(idx, currentMediaList);
  }
});

function inlinePlayVideo(container, msg) {
  container.innerHTML = '<div class="loading-spinner"></div>';
  (async () => {
    try {
      const buf = await client.downloadMedia(msg);
      if (!buf) { container.innerHTML = '🎬'; return; }
      const mime = getMediaInfo(msg).mime || 'video/mp4';
      const url = URL.createObjectURL(new Blob([buf], { type: mime }));
      container.innerHTML = `<video controls autoplay style="max-width:340px;max-height:380px;border-radius:8px;" src="${url}"></video>`;
    } catch (err) { container.innerHTML = '🎬'; }
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
  // 键盘
  document.addEventListener('keydown', (e) => {
    if (!$('media-viewer').classList.contains('open')) return;
    if (e.key === 'ArrowLeft') navMedia(-1);
    else if (e.key === 'ArrowRight') navMedia(1);
    else if (e.key === 'Escape') closeMediaViewer();
  });
  // 触摸滑动
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
    if (info.type === 'video' || info.type === 'audio' || info.type === 'file' || info.type === 'image' || info.type === 'photo') {
      const buf = await client.downloadMedia(msg);
      if (!buf) { holder.innerHTML = '<div style="color:#fff">加载失败</div>'; return; }
      const mime = info.mime || (info.type === 'image' ? 'image/jpeg' : 'application/octet-stream');
      const url = URL.createObjectURL(new Blob([buf], { type: mime }));
      if (info.type === 'video') {
        holder.innerHTML = `<video id="mv-content" class="video" controls autoplay src="${url}"></video>`;
      } else if (info.type === 'audio') {
        holder.innerHTML = `<audio id="mv-content" class="audio" controls autoplay src="${url}"></audio>`;
      } else if (info.type === 'image' || info.type === 'photo') {
        holder.innerHTML = `<img id="mv-content" class="img" src="${url}" />`;
      } else {
        holder.innerHTML = `<iframe id="mv-content" class="img" src="${url}" style="background:#fff"></iframe>`;
      }
    } else {
      holder.innerHTML = '<div style="color:#fff">不支持的媒体</div>';
    }
  } catch (e) {
    holder.innerHTML = `<div style="color:#ff6b6b;">加载失败: ${escapeHtml(e.message)}</div>`;
  }
}

// 卡片内视频内联播放已合并到上方统一点击事件处理

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
    // 公开频道可生成 t.me 链接
    let link = '';
    const shareEntity = isNetdiskMode ? netdiskChannel : currentEntity;
    if (shareEntity?.username) {
      link = `https://t.me/${shareEntity.username}/${msg.id}`;
    }
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      await navigator.share({ files: [file], title: info.name, text: link });
    } else if (link) {
      await navigator.clipboard.writeText(link);
      alert('分享链接已复制：\n' + link);
    } else {
      // 没有公开链接则回退为下载
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

// 触发缩略图加载（在渲染循环后调用）
const _origRenderMessage = renderMessage;
function renderMessageAndThumb(msg, chat) {
  _origRenderMessage(msg, chat);
  if (msg.media) {
    const info = getMediaInfo(msg);
    if (info.type !== 'file') loadMediaThumb(msg);
    else { /* 文件用图标，无需缩略图 */ }
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

// ===== 发送附件（修复：用 sendFile，支持图片/视频/任意文件）=====
el.attachBtn.addEventListener('click', () => el.fileInput.click());
el.fileInput.addEventListener('change', async () => {
  const files = el.fileInput.files;
  if (!files || !files.length || !currentEntity) return;
  for (const file of files) {
    const btn = el.sendBtn;
    btn.disabled = true;
    try {
      const sent = await client.sendFile(currentEntity, {
        file: file,
        caption: file.name || '',
        forceDocument: !file.type.startsWith('image/'),
      });
      if (sent) { renderMessageAndThumb(sent, { entity: currentEntity }); el.messages.scrollTop = el.messages.scrollHeight; }
    } catch (e) { alert('发送失败: ' + (e.message || e)); }
  }
  el.fileInput.value = '';
  el.sendBtn.disabled = false;
  const messages = await client.getMessages(currentEntity, { limit: 5 });
  el.messages.innerHTML = '';
  for (const msg of messages.reverse()) renderMessageAndThumb(msg, { entity: currentEntity });
  el.messages.scrollTop = el.messages.scrollHeight;
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
    if (bg === 'default') { el.messagesBg.style.background = '#0e1621'; localStorage.removeItem('tg_bg'); }
    else if (bg === 'telegram') { el.messagesBg.style.background = 'linear-gradient(135deg, #2b5278 0%, #0e1621 100%)'; localStorage.setItem('tg_bg', 'telegram'); }
  });
});
el.bgFileInput.addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (ev) => { const dataUrl = ev.target.result; localStorage.setItem('tg_bg', dataUrl); el.messagesBg.style.backgroundImage = `url(${dataUrl})`; el.messagesBg.style.backgroundSize = 'cover'; };
  reader.readAsDataURL(file);
});
el.bgOpacity.addEventListener('input', (e) => { el.messagesBg.style.opacity = (e.target.value / 100); localStorage.setItem('tg_bg_opacity', e.target.value); });

function loadBackground() {
  const bg = localStorage.getItem('tg_bg');
  const opacity = localStorage.getItem('tg_bg_opacity') || '8';
  el.bgOpacity.value = parseInt(opacity);
  el.messagesBg.style.opacity = (parseInt(opacity) / 100);
  if (bg === 'telegram') el.messagesBg.style.background = 'linear-gradient(135deg, #2b5278 0%, #0e1621 100%)';
  else if (bg && bg.startsWith('data:')) { el.messagesBg.style.backgroundImage = `url(${bg})`; el.messagesBg.style.backgroundSize = 'cover'; el.messagesBg.style.backgroundPosition = 'center'; }
  else el.messagesBg.style.background = '#0e1621';
}

// ===== 退出登录 =====
el.logoutBtn.addEventListener('click', () => {
  if (!confirm('确定退出登录？')) return;
  localStorage.removeItem('tg_session');
  location.reload();
});

// ===== 网盘模式 =====
function buildNetdiskUI() {
  // 设置面板里追加“网盘频道”选择 + 进入按钮（若已存在则不重复）
  if ($('netdisk-channel')) return;
  const wrap = document.createElement('div');
  wrap.style.padding = '12px';
  wrap.innerHTML = `
    <div style="font-weight:600;margin-bottom:8px;">网盘模式</div>
    <div style="font-size:13px;color:#7d8e9b;margin-bottom:8px;">选择一个频道作为网盘（文件会保存在该频道里）</div>
    <select id="netdisk-channel" style="width:100%;padding:8px;border-radius:8px;background:#0e1621;color:#fff;border:1px solid #101921;"></select>
    <button id="netdisk-enter" style="margin-top:10px;width:100%;padding:10px;border:none;border-radius:8px;background:#3390ec;color:#fff;cursor:pointer;">进入网盘</button>`;
  el.settingsPanel.appendChild(wrap);
  $('netdisk-enter').addEventListener('click', () => enterNetdisk());

  // 网盘面板 + 上传按钮
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
    if (netdiskMediaList.length === 0) { grid.innerHTML = '<div style="color:#7d8e9b;padding:20px;">该频道暂无文件</div>'; return; }
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
      if (info.type !== 'file') {
        loadNetdiskThumb(msg, thumbId);
      }
    }
  } catch (e) {
    grid.innerHTML = `<div style="color:#ff6b6b;padding:20px;">加载失败: ${escapeHtml(e.message)}</div>`;
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
      await client.sendFile(netdiskChannel, { file, caption: file.name || '', forceDocument: !file.type.startsWith('image/') });
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
