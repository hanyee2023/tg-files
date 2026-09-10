import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions';
import { Api } from 'telegram/tl/api';

// ===== 配置 =====
const API_ID = parseInt(import.meta.env.VITE_API_ID || '0');
const API_HASH = import.meta.env.VITE_API_HASH || '';
const PROXY_DOMAIN = import.meta.env.VITE_PROXY_DOMAIN || '';

// ===== 代理 patch =====
if (PROXY_DOMAIN) {
  const OrigWS = self.WebSocket;
  self.WebSocket = function (url, protocols) {
    if (typeof url === 'string' && url.includes('telegram.org')) {
      try { const u = new URL(url); url = `wss://${PROXY_DOMAIN}/${u.hostname}${u.pathname}`; } catch (e) {}
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
    if (s.includes('telegram.org')) {
      try { const u = new URL(s); const n = `https://${PROXY_DOMAIN}/${u.hostname}${u.pathname}${u.search}`;
        input = typeof input === 'string' ? n : new Request(n, input); } catch (e) {}
    }
    return origFetch.call(self, input, init);
  };
}

// ===== 状态 =====
let client = null;
let phoneCodeHash = '';
let currentEntity = null;
let currentPeer = null;
let allChats = [];
let loginStep = 'phone';

const COLORS = ['#e17076','#7bc862','#65aadd','#a695c7','#ee7aae','#6ec9cb','#faa774','#5b7b9a'];

// ===== DOM 引用 =====
const $ = id => document.getElementById(id);
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

// ===== 初始化 =====
async function init() {
  if (!API_ID || !API_HASH) {
    el.loginStatus.className = 'login-status error';
    el.loginStatus.textContent = '请设置环境变量';
    return;
  }
  const saved = localStorage.getItem('tg_session');
  if (saved) {
    try {
      client = new TelegramClient(new StringSession(saved), API_ID, API_HASH, { connectionRetries: 5, retryDelay: 2000 });
      await client.connect();
      await client.getMe();
      enterApp();
      return;
    } catch (e) { console.log('Session expired', e); }
  }
  el.loginStatus.textContent = '请输入手机号登录';
}

// ===== 登录流程 =====
el.mainBtn.addEventListener('click', async () => {
  if (loginStep === 'phone') {
    const phone = el.phone.value.trim();
    if (!phone) return;
    el.mainBtn.disabled = true; el.mainBtn.textContent = '连接中...';
    el.loginStatus.textContent = '';
    try {
      if (!client) {
        client = new TelegramClient(new StringSession(''), API_ID, API_HASH, { connectionRetries: 5, retryDelay: 2000 });
        await client.connect();
      }
      const r = await client.sendCode({ apiId: API_ID, apiHash: API_HASH }, phone);
      phoneCodeHash = r.phoneCodeHash;
      el.codeRow.classList.remove('hidden');
      el.mainBtn.textContent = '登录';
      el.mainBtn.disabled = false;
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
      localStorage.setItem('tg_session', client.session.save());
      enterApp();
    } catch (e) {
      if (e.message?.includes('SESSION_PASSWORD_NEEDED')) {
        el.passwordRow.classList.remove('hidden');
        el.mainBtn.textContent = '确认';
        loginStep = 'password';
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
      localStorage.setItem('tg_session', client.session.save());
      enterApp();
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
      const preview = d.message?.text || d.message?.message || '';
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
        </div>
      `;
      item.addEventListener('click', () => openChat(chat, item));
      el.chatList.appendChild(item);
    }
    // 异步加载头像
    for (let i = 0; i < allChats.length; i++) {
      loadAvatar(allChats[i]);
    }
  } catch (e) {
    el.chatList.innerHTML = `<div style="padding:20px;color:#ff6b6b;">错误: ${escapeHtml(e.message)}</div>`;
  }
}

async function loadAvatar(chat) {
  try {
    const photos = await client.getProfilePhotos(chat.entity);
    if (photos.length > 0) {
      const buf = await client.downloadMedia(photos[0], { thumb: 0 });
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

// 搜索
el.searchInput.addEventListener('input', (e) => {
  const q = e.target.value.toLowerCase();
  document.querySelectorAll('.chat-item').forEach(item => {
    const name = item.querySelector('.name')?.textContent.toLowerCase() || '';
    item.style.display = name.includes(q) ? '' : 'none';
  });
});

// ===== 打开聊天 =====
async function openChat(chat, itemEl) {
  currentEntity = chat.entity;
  currentPeer = chat.dialog.inputPeer || chat.entity;

  // UI 切换
  document.querySelectorAll('.chat-item').forEach(i => i.classList.remove('active'));
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

  // 移动端
  if (window.innerWidth <= 768) {
    el.sidebar.classList.add('hidden-mobile');
    el.chatWindow.classList.add('active-mobile');
  }

  // 加载头像
  try {
    const photos = await client.getProfilePhotos(chat.entity);
    if (photos.length > 0) {
      const buf = await client.downloadMedia(photos[0], { thumb: 0 });
      if (buf && buf.length > 0) {
        const url = URL.createObjectURL(new Blob([buf], { type: 'image/jpeg' }));
        el.chatAvatar.innerHTML = `<img src="${url}" alt="" />`;
      }
    }
  } catch (e) {}

  // 加载消息
  el.messages.innerHTML = '<div class="loading-spinner"></div>';
  try {
    const messages = await client.getMessages(chat.entity, { limit: 50 });
    el.messages.innerHTML = '';
    let lastDate = '';
    for (const msg of messages.reverse()) {
      const date = formatDate(msg.date);
      if (date !== lastDate) {
        lastDate = date;
        const sep = document.createElement('div');
        sep.className = 'date-sep';
        sep.innerHTML = `<span>${date}</span>`;
        el.messages.appendChild(sep);
      }
      renderMessage(msg, chat);
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

  let mediaHtml = '';
  let textHtml = '';

  // 文本
  const text = msg.text || msg.message || '';
  if (text) textHtml = `<div class="text">${escapeHtml(text)}</div>`;

  // 媒体
  if (msg.media) {
    mediaHtml = renderMedia(msg);
  }

  // 发送者名称（群聊）
  let senderHtml = '';
  if (!isOut && chat.entity?.className === 'Channel' && msg.sender) {
    const senderName = msg.sender.firstName || msg.sender.title || '';
    if (senderName) senderHtml = `<div class="sender">${escapeHtml(senderName)}</div>`;
  }

  const time = formatTime(msg.date);
  div.innerHTML = `<div class="msg-bubble">${senderHtml}${mediaHtml}${textHtml}<div class="meta">${time}</div></div>`;
  el.messages.appendChild(div);
}

function renderMedia(msg) {
  const media = msg.media;
  const doc = msg.document || media?.document || (media?.webpage?.document);
  const photo = msg.photo || media?.photo || (media?.webpage?.photo);

  if (photo) {
    // 图片：加载缩略图
    const thumbId = `photo-${msg.id}`;
    loadThumb(photo, thumbId, msg, 'photo');
    return `<div class="msg-media" id="${thumbId}"><div style="width:300px;height:200px;background:#1a1a2e;display:flex;align-items:center;justify-content:center;border-radius:8px;">🖼️</div></div>`;
  }

  if (doc) {
    const mime = doc.mimeType || '';
    const attrs = doc.attributes || [];
    const fileNameAttr = attrs.find(a => a.fileName);
    const fileName = fileNameAttr?.fileName || `file_${msg.id}`;
    const size = formatSize(doc.size || 0);

    if (mime.startsWith('video/')) {
      const vidId = `video-${msg.id}`;
      loadVideoThumb(doc, vidId, msg);
      return `<div class="msg-media" id="${vidId}"><div style="width:300px;height:200px;background:#000;display:flex;align-items:center;justify-content:center;border-radius:8px;font-size:40px;">🎬</div></div>`;
    }

    if (mime.startsWith('audio/')) {
      const aid = `audio-${msg.id}`;
      loadAudio(doc, aid, msg);
      return `<div class="msg-media" id="${aid}"><div style="padding:8px;">🎵 加载中...</div></div>`;
    }

    if (mime.startsWith('image/')) {
      const iid = `img-${msg.id}`;
      loadThumb(doc, iid, msg, 'document');
      return `<div class="msg-media" id="${iid}"><div style="width:300px;height:200px;background:#1a1a2e;display:flex;align-items:center;justify-content:center;border-radius:8px;">🖼️</div></div>`;
    }

    // 其他文件
    const icon = mime === 'application/pdf' ? '📄' : mime.includes('zip') ? '🗜️' : '📦';
    return `<div class="msg-media"><div class="file-card">
      <div class="file-icon">${icon}</div>
      <div class="file-info"><div class="file-name">${escapeHtml(fileName)}</div><div class="file-size">${size}</div></div>
      <button class="file-dl-btn" data-msg-id="${msg.id}">下载</button>
    </div></div>`;
  }

  return '';
}

// 异步加载图片缩略图
async function loadThumb(media, elId, msg, type) {
  try {
    const buf = await client.downloadMedia(msg, { thumb: 1 });
    if (buf && buf.length > 0) {
      const url = URL.createObjectURL(new Blob([buf], { type: 'image/jpeg' }));
      const container = $(elId);
      if (container) {
        container.innerHTML = `<img src="${url}" alt="" loading="lazy" />`;
        container.querySelector('img')?.addEventListener('click', () => openPreview(url));
      }
      // 异步加载全尺寸
      const fullBuf = await client.downloadMedia(msg);
      if (fullBuf && fullBuf.length > 0) {
        const fullUrl = URL.createObjectURL(new Blob([fullBuf], { type: 'image/jpeg' }));
        const img = container?.querySelector('img');
        if (img) img.src = fullUrl;
      }
    }
  } catch (e) { console.log('thumb error', e); }
}

// 异步加载视频（内联播放）
async function loadVideoThumb(doc, elId, msg) {
  try {
    // 先加载缩略图
    const buf = await client.downloadMedia(msg, { thumb: 0 });
    if (buf && buf.length > 0) {
      const url = URL.createObjectURL(new Blob([buf], { type: 'image/jpeg' }));
      const container = $(elId);
      if (container) {
        container.innerHTML = `<div style="position:relative;cursor:pointer;"><img src="${url}" style="width:300px;display:block;border-radius:8px;" /><div style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-size:48px;">▶️</div></div>`;
        // 点击后加载完整视频内联播放
        container.querySelector('div')?.addEventListener('click', async () => {
          container.innerHTML = '<div style="padding:20px;">⏳ 加载视频...</div>';
          try {
            const fullBuf = await client.downloadMedia(msg);
            if (fullBuf) {
              const vUrl = URL.createObjectURL(new Blob([fullBuf], { type: doc.mimeType || 'video/mp4' }));
              container.innerHTML = `<video src="${vUrl}" controls autoplay style="max-width:360px;max-height:400px;border-radius:8px;"></video>`;
            }
          } catch (e) {
            container.innerHTML = `<div style="padding:8px;color:#ff6b6b;">加载失败</div>`;
          }
        });
      }
    }
  } catch (e) { console.log('video thumb error', e); }
}

// 异步加载音频
async function loadAudio(doc, elId, msg) {
  try {
    const buf = await client.downloadMedia(msg);
    if (buf && buf.length > 0) {
      const url = URL.createObjectURL(new Blob([buf], { type: doc.mimeType || 'audio/mpeg' }));
      const container = $(elId);
      if (container) container.innerHTML = `<audio src="${url}" controls style="width:100%;"></audio>`;
    }
  } catch (e) { console.log('audio error', e); }
}

// 图片预览
function openPreview(url) {
  el.previewImg.src = url;
  el.previewOverlay.classList.remove('hidden');
}
el.previewClose.addEventListener('click', () => el.previewOverlay.classList.add('hidden'));
el.previewOverlay.addEventListener('click', (e) => {
  if (e.target === el.previewOverlay) el.previewOverlay.classList.add('hidden');
});

// 文件下载按钮（事件委托）
el.messages.addEventListener('click', async (e) => {
  const btn = e.target.closest('.file-dl-btn');
  if (!btn) return;
  const msgId = parseInt(btn.dataset.msgId);
  btn.textContent = '...'; btn.disabled = true;
  try {
    const msgs = await client.getMessages(currentEntity, { ids: [msgId] });
    if (msgs[0]) {
      const buf = await client.downloadMedia(msgs[0]);
      if (buf) {
        const doc = msgs[0].document || msgs[0].media?.document;
        const blob = new Blob([buf], { type: doc?.mimeType || 'application/octet-stream' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        const attrs = doc?.attributes || [];
        const fa = attrs.find(x => x.fileName);
        a.href = url; a.download = fa?.fileName || `file_${msgId}`;
        a.click(); URL.revokeObjectURL(url);
      }
    }
    btn.textContent = '下载'; btn.disabled = false;
  } catch (err) {
    btn.textContent = '失败'; btn.disabled = false;
    console.error(err);
  }
});

// ===== 发送消息 =====
el.sendBtn.addEventListener('click', () => sendMessage());
el.msgInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
});
el.msgInput.addEventListener('input', () => {
  el.msgInput.style.height = 'auto';
  el.msgInput.style.height = Math.min(el.msgInput.scrollHeight, 120) + 'px';
});

async function sendMessage() {
  const text = el.msgInput.value.trim();
  if (!text || !currentEntity) return;
  el.msgInput.value = '';
  el.msgInput.style.height = 'auto';
  el.sendBtn.disabled = true;
  try {
    await client.sendMessage(currentEntity, { message: text });
    // 重新加载消息
    const messages = await client.getMessages(currentEntity, { limit: 1 });
    if (messages[0]) {
      renderMessage(messages[0], { entity: currentEntity });
      el.messages.scrollTop = el.messages.scrollHeight;
    }
  } catch (e) {
    alert('发送失败: ' + (e.message || e));
  }
  el.sendBtn.disabled = false;
}

// ===== 发送文件 =====
el.attachBtn.addEventListener('click', () => el.fileInput.click());
el.fileInput.addEventListener('change', async () => {
  const files = el.fileInput.files;
  if (!files.length || !currentEntity) return;
  for (const file of files) {
    try {
      await client.sendFile(currentEntity, { file, forceDocument: false });
    } catch (e) {
      alert('发送失败: ' + (e.message || e));
    }
  }
  el.fileInput.value = '';
  // 刷新消息
  const messages = await client.getMessages(currentEntity, { limit: 5 });
  el.messages.innerHTML = '';
  for (const msg of messages.reverse()) renderMessage(msg, { entity: currentEntity });
  el.messages.scrollTop = el.messages.scrollHeight;
});

// ===== 返回（移动端）=====
el.backBtn.addEventListener('click', () => {
  el.sidebar.classList.remove('hidden-mobile');
  el.chatWindow.classList.remove('active-mobile');
});

// ===== 设置面板 =====
el.menuBtn.addEventListener('click', () => el.settingsPanel.classList.add('open'));
el.settingsClose.addEventListener('click', () => el.settingsPanel.classList.remove('open'));

// 背景设置
document.querySelectorAll('.bg-option').forEach(opt => {
  opt.addEventListener('click', () => {
    const bg = opt.dataset.bg;
    if (bg === 'default') {
      el.messagesBg.style.background = '#0e1621';
      localStorage.removeItem('tg_bg');
    } else if (bg === 'telegram') {
      el.messagesBg.style.background = 'linear-gradient(135deg, #2b5278 0%, #0e1621 100%)';
      localStorage.setItem('tg_bg', 'telegram');
    }
  });
});

el.bgFileInput.addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (ev) => {
    const dataUrl = ev.target.result;
    localStorage.setItem('tg_bg', dataUrl);
    el.messagesBg.style.backgroundImage = `url(${dataUrl})`;
    el.messagesBg.style.backgroundSize = 'cover';
  };
  reader.readAsDataURL(file);
});

el.bgOpacity.addEventListener('input', (e) => {
  el.messagesBg.style.opacity = (e.target.value / 100);
  localStorage.setItem('tg_bg_opacity', e.target.value);
});

function loadBackground() {
  const bg = localStorage.getItem('tg_bg');
  const opacity = localStorage.getItem('tg_bg_opacity') || '8';
  el.bgOpacity.value = parseInt(opacity);
  el.messagesBg.style.opacity = (parseInt(opacity) / 100);
  if (bg === 'telegram') {
    el.messagesBg.style.background = 'linear-gradient(135deg, #2b5278 0%, #0e1621 100%)';
  } else if (bg && bg.startsWith('data:')) {
    el.messagesBg.style.backgroundImage = `url(${bg})`;
    el.messagesBg.style.backgroundSize = 'cover';
    el.messagesBg.style.backgroundPosition = 'center';
  } else {
    el.messagesBg.style.background = '#0e1621';
  }
}

// ===== 退出登录 =====
el.logoutBtn.addEventListener('click', () => {
  if (!confirm('确定退出登录？')) return;
  localStorage.removeItem('tg_session');
  location.reload();
});

// ===== 工具函数 =====
function formatSize(bytes) {
  if (!bytes) return '';
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
  if (bytes < 1073741824) return (bytes / 1048576).toFixed(1) + ' MB';
  return (bytes / 1073741824).toFixed(2) + ' GB';
}

function escapeHtml(s) {
  if (!s) return '';
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function formatTime(ts) {
  if (!ts) return '';
  const d = new Date(ts * 1000);
  return d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
}

function formatDate(ts) {
  if (!ts) return '';
  const d = new Date(ts * 1000);
  const today = new Date();
  if (d.toDateString() === today.toDateString()) return '今天';
  return d.toLocaleDateString('zh-CN', { month: 'long', day: 'numeric' });
}

// ===== 启动 =====
init();
