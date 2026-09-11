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
let currentMode = 'chat'; // 'chat' | 'drive'
let driveChannelId = null;
let currentFileFilter = 'all';
let me = null;

// 缓存
const avatarCache = new Map();
const mediaCache = new Map();
const thumbCache = new Map();

const COLORS = ['#e17076','#7bc862','#65aadd','#a695c7','#ee7aae','#6ec9cb','#faa774','#5b7b9a'];

// ===== DOM 引用 =====
const $ = id => document.getElementById(id);
const el = {
  splash: $('splash'),
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
  // 新增
  modeTabs: document.querySelectorAll('.mode-tab'),
  placeholderText: $('placeholder-text'),
  fileFilterBar: $('file-filter-bar'),
  filterChips: document.querySelectorAll('.filter-chip'),
  userAvatar: $('user-avatar'),
  userName: $('user-name'),
  userPhone: $('user-phone'),
  driveChannelSelect: $('drive-channel-select'),
  driveChannelName: $('drive-channel-name'),
  channelSelectorOverlay: $('channel-selector-overlay'),
  channelSelectorClose: $('channel-selector-close'),
  channelSelectorList: $('channel-selector-list'),
  channelSearchInput: $('channel-search-input'),
  videoModal: $('video-modal'),
  modalVideo: $('modal-video'),
  vmClose: $('vm-close'),
};

// ===== 初始化（优化启动流程）=====
async function init() {
  // 先显示启动页
  if (!API_ID || !API_HASH) {
    hideSplash();
    showLogin();
    el.loginStatus.className = 'login-status error';
    el.loginStatus.textContent = '请设置环境变量 VITE_API_ID 和 VITE_API_HASH';
    return;
  }

  const saved = localStorage.getItem('tg_session');
  if (saved) {
    // 后台静默连接，有 session 时快速进入
    try {
      client = new TelegramClient(new StringSession(saved), API_ID, API_HASH, {
        connectionRetries: 3,
        retryDelay: 1500,
      });
      // 并行连接和预加载
      await client.connect();
      me = await client.getMe();
      enterApp();
      return;
    } catch (e) {
      console.log('Session expired or connect failed', e);
      localStorage.removeItem('tg_session');
    }
  }

  // 无 session 或连接失败，显示登录页
  hideSplash();
  showLogin();
}

function hideSplash() {
  el.splash.classList.add('hidden');
  setTimeout(() => {
    el.splash.style.display = 'none';
  }, 300);
}

function showLogin() {
  el.loginView.style.display = 'flex';
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
        client = new TelegramClient(new StringSession(''), API_ID, API_HASH, { connectionRetries: 3, retryDelay: 1500 });
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
      me = await client.getMe();
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
      me = await client.getMe();
      enterApp();
    } catch (e) {
      el.loginStatus.className = 'login-status error';
      el.loginStatus.textContent = e.message || String(e);
      el.mainBtn.disabled = false;
    }
  }
});

// ===== 进入主界面 =====
function enterApp() {
  hideSplash();
  el.loginView.style.display = 'none';
  el.appView.classList.add('active');

  // 加载用户信息
  loadUserInfo();

  // 加载网盘频道设置
  driveChannelId = localStorage.getItem('drive_channel_id');
  updateDriveChannelDisplay();

  // 加载聊天列表
  loadChatList();
  loadBackground();

  // 根据保存的模式切换
  const savedMode = localStorage.getItem('view_mode') || 'chat';
  switchMode(savedMode);
}

// ===== 用户信息 =====
async function loadUserInfo() {
  if (!me) return;
  const name = (me.firstName || '') + (me.lastName ? ' ' + me.lastName : '');
  el.userName.textContent = name || 'Unknown';
  el.userPhone.textContent = '+' + (me.phone || '');

  // 加载头像
  try {
    const avatarUrl = await getAvatarUrl(me);
    if (avatarUrl) {
      el.userAvatar.innerHTML = `<img src="${avatarUrl}" alt="" />`;
    } else {
      const initial = (me.firstName || me.username || 'U').charAt(0).toUpperCase();
      const color = COLORS[0];
      el.userAvatar.style.background = color;
      el.userAvatar.innerHTML = escapeHtml(initial);
    }
  } catch (e) {
    console.log('user avatar error', e);
  }
}

// ===== 头像获取（带缓存）=====
async function getAvatarUrl(entity) {
  const id = entity.id?.toString();
  if (!id) return null;
  if (avatarCache.has(id)) return avatarCache.get(id);

  try {
    const photos = await client.getProfilePhotos(entity, { limit: 1 });
    if (photos.length > 0) {
      const buf = await client.downloadMedia(photos[0], { thumb: 0 });
      if (buf && buf.length > 0) {
        const url = URL.createObjectURL(new Blob([buf], { type: 'image/jpeg' }));
        avatarCache.set(id, url);
        return url;
      }
    }
  } catch (e) {}
  return null;
}

// ===== 模式切换 =====
function switchMode(mode) {
  currentMode = mode;
  localStorage.setItem('view_mode', mode);

  el.modeTabs.forEach(tab => {
    tab.classList.toggle('active', tab.dataset.mode === mode);
  });

  // 重置视图
  resetChatWindow();

  if (mode === 'drive') {
    el.placeholderText.textContent = driveChannelId ? '加载网盘中...' : '请先在设置中选择网盘频道';
    el.fileFilterBar.classList.remove('hidden');
    el.inputBar.classList.add('hidden'); // 网盘模式隐藏输入栏

    if (driveChannelId) {
      openDriveChannel();
    }
  } else {
    el.placeholderText.textContent = '选择一个对话开始';
    el.fileFilterBar.classList.add('hidden');
    loadChatList();
  }
}

el.modeTabs.forEach(tab => {
  tab.addEventListener('click', () => switchMode(tab.dataset.mode));
});

// ===== 文件筛选 =====
el.filterChips.forEach(chip => {
  chip.addEventListener('click', () => {
    el.filterChips.forEach(c => c.classList.remove('active'));
    chip.classList.add('active');
    currentFileFilter = chip.dataset.filter;
    filterMessages();
  });
});

function filterMessages() {
  const msgs = el.messages.querySelectorAll('.msg');
  msgs.forEach(msg => {
    if (currentFileFilter === 'all') {
      msg.style.display = '';
      return;
    }
    const type = msg.dataset.mediaType;
    msg.style.display = (type === currentFileFilter) ? '' : 'none';
  });
}

// ===== 网盘频道 =====
function updateDriveChannelDisplay() {
  if (driveChannelId) {
    const chat = allChats.find(c => c.id === driveChannelId);
    el.driveChannelName.textContent = chat?.name || '已选择频道';
  } else {
    el.driveChannelName.textContent = '未选择';
  }
}

el.driveChannelSelect.addEventListener('click', openChannelSelector);
el.channelSelectorClose.addEventListener('click', () => {
  el.channelSelectorOverlay.classList.add('hidden');
});
el.channelSelectorOverlay.addEventListener('click', (e) => {
  if (e.target === el.channelSelectorOverlay) {
    el.channelSelectorOverlay.classList.add('hidden');
  }
});

async function openChannelSelector() {
  el.channelSelectorOverlay.classList.remove('hidden');
  el.channelSelectorList.innerHTML = '<div class="loading-spinner"></div>';
  el.channelSearchInput.value = '';

  try {
    // 只显示频道和超级群
    const channels = allChats.filter(c =>
      c.entity.className === 'Channel' || c.entity.className === 'Chat'
    );

    if (channels.length === 0) {
      // 重新加载一次确保有数据
      await loadChatListPromise();
      const ch2 = allChats.filter(c =>
        c.entity.className === 'Channel' || c.entity.className === 'Chat'
      );
      renderChannelSelectorList(ch2);
    } else {
      renderChannelSelectorList(channels);
    }
  } catch (e) {
    el.channelSelectorList.innerHTML = `<div style="padding:20px;color:#ff6b6b;">加载失败</div>`;
  }
}

function renderChannelSelectorList(channels) {
  el.channelSelectorList.innerHTML = '';
  if (channels.length === 0) {
    el.channelSelectorList.innerHTML = '<div style="padding:20px;text-align:center;color:var(--text-secondary);">暂无频道</div>';
    return;
  }
  channels.forEach((chat, idx) => {
    const item = document.createElement('div');
    item.className = 'chat-item';
    item.style.borderRadius = '8px';
    item.innerHTML = `
      <div class="avatar" style="background:${chat.color};width:44px;height:44px;font-size:16px;">${escapeHtml(chat.name.charAt(0).toUpperCase())}</div>
      <div class="chat-info">
        <div class="name">${escapeHtml(chat.name)}</div>
        <div class="channel-badge">
          <svg class="icon icon-sm" style="width:12px;height:12px;" viewBox="0 0 24 24"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>
          频道
        </div>
      </div>
    `;
    item.addEventListener('click', () => {
      driveChannelId = chat.id;
      localStorage.setItem('drive_channel_id', chat.id);
      updateDriveChannelDisplay();
      el.channelSelectorOverlay.classList.add('hidden');
      if (currentMode === 'drive') {
        openDriveChannel();
      }
    });
    el.channelSelectorList.appendChild(item);

    // 异步加载头像
    loadAvatarForSelector(chat, item);
  });
}

async function loadAvatarForSelector(chat, itemEl) {
  try {
    const url = await getAvatarUrl(chat.entity);
    if (url) {
      const av = itemEl.querySelector('.avatar');
      if (av) av.innerHTML = `<img src="${url}" alt="" />`;
    }
  } catch (e) {}
}

el.channelSearchInput.addEventListener('input', (e) => {
  const q = e.target.value.toLowerCase();
  const items = el.channelSelectorList.querySelectorAll('.chat-item');
  items.forEach(item => {
    const name = item.querySelector('.name')?.textContent.toLowerCase() || '';
    item.style.display = name.includes(q) ? '' : 'none';
  });
});

async function openDriveChannel() {
  if (!driveChannelId) return;
  const chat = allChats.find(c => c.id === driveChannelId);
  if (!chat) {
    // 尝试重新加载
    await loadChatListPromise();
    const chat2 = allChats.find(c => c.id === driveChannelId);
    if (chat2) {
      openChat(chat2, null);
    }
    return;
  }
  openChat(chat, null);
}

let chatListLoadPromise = null;
function loadChatListPromise() {
  if (chatListLoadPromise) return chatListLoadPromise;
  chatListLoadPromise = loadChatList();
  return chatListLoadPromise;
}

// ===== 聊天列表 =====
async function loadChatList() {
  if (currentMode === 'drive') return; // 网盘模式不刷新列表

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
    // 批量异步加载头像（带节流）
    loadAvatarsBatch(allChats.slice(0, 20));
    // 懒加载剩余头像
    requestAnimationFrame(() => {
      if (allChats.length > 20) {
        setTimeout(() => loadAvatarsBatch(allChats.slice(20, 50)), 500);
        setTimeout(() => loadAvatarsBatch(allChats.slice(50)), 1500);
      }
    });
  } catch (e) {
    el.chatList.innerHTML = `<div style="padding:20px;color:#ff6b6b;">错误: ${escapeHtml(e.message)}</div>`;
  }
  chatListLoadPromise = null;
}

async function loadAvatarsBatch(chats) {
  for (const chat of chats) {
    try {
      const url = await getAvatarUrl(chat.entity);
      if (url) {
        const idx = allChats.indexOf(chat);
        const item = el.chatList.querySelector(`.chat-item[data-idx="${idx}"]`);
        const av = item?.querySelector('.avatar');
        if (av) av.innerHTML = `<img src="${url}" alt="" />`;
      }
    } catch (e) {}
  }
}

// 搜索
el.searchInput.addEventListener('input', (e) => {
  const q = e.target.value.toLowerCase();
  document.querySelectorAll('.chat-item').forEach(item => {
    const name = item.querySelector('.name')?.textContent.toLowerCase() || '';
    item.style.display = name.includes(q) ? '' : 'none';
  });
});

// ===== 重置聊天窗口 =====
function resetChatWindow() {
  currentEntity = null;
  currentPeer = null;
  el.chatWindow.classList.add('no-chat');
  el.chatHeader.classList.add('hidden');
  el.messagesWrap.classList.add('hidden');
  el.inputBar.classList.add('hidden');
  el.fileFilterBar.classList.add('hidden');
  el.messages.innerHTML = '';
  document.querySelectorAll('.chat-item').forEach(i => i.classList.remove('active'));
}

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

  if (currentMode === 'drive') {
    el.fileFilterBar.classList.remove('hidden');
    el.inputBar.classList.add('hidden');
  } else {
    el.inputBar.classList.remove('hidden');
  }

  el.chatName.textContent = chat.name;
  el.chatStatus.textContent = chat.entity.className === 'Channel' ? '频道' : '在线';
  el.chatAvatar.innerHTML = escapeHtml(chat.name.charAt(0).toUpperCase());
  el.chatAvatar.style.background = chat.color;

  // 移动端
  if (window.innerWidth <= 768) {
    el.sidebar.classList.add('hidden-mobile');
    el.chatWindow.classList.add('active-mobile');
  }

  // 加载头像
  getAvatarUrl(chat.entity).then(url => {
    if (url) {
      el.chatAvatar.innerHTML = `<img src="${url}" alt="" />`;
    }
  });

  // 加载消息
  el.messages.innerHTML = '<div class="loading-spinner"></div>';
  try {
    const messages = await client.getMessages(chat.entity, { limit: currentMode === 'drive' ? 100 : 50 });
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

    // 网盘模式下应用筛选
    if (currentMode === 'drive') {
      filterMessages();
    }
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

  // 检测媒体类型（用于筛选）
  const mediaType = getMediaType(msg);
  div.dataset.mediaType = mediaType;

  let mediaHtml = '';
  let textHtml = '';

  // 文本
  const text = msg.text || msg.message || '';
  if (text) textHtml = `<div class="text">${escapeHtml(text)}</div>`;

  // 媒体
  if (msg.media) {
    mediaHtml = renderMedia(msg, mediaType);
  }

  // 发送者名称（群聊/频道）
  let senderHtml = '';
  if (!isOut && (chat.entity?.className === 'Channel' || chat.entity?.className === 'Chat') && msg.sender) {
    const senderName = msg.sender.firstName || msg.sender.title || '';
    if (senderName) senderHtml = `<div class="sender">${escapeHtml(senderName)}</div>`;
  }

  const time = formatTime(msg.date);
  div.innerHTML = `<div class="msg-bubble">${senderHtml}${mediaHtml}${textHtml}<div class="meta">${time}</div></div>`;
  el.messages.appendChild(div);

  // 懒加载媒体缩略图
  if (mediaType === 'photo' || mediaType === 'video' || mediaType === 'file') {
    lazyLoadMedia(msg, div, mediaType);
  }
}

function getMediaType(msg) {
  if (!msg.media) return 'text';
  const photo = msg.photo || msg.media?.photo || (msg.media?.webpage?.photo);
  if (photo) return 'photo';

  const doc = msg.document || msg.media?.document || (msg.media?.webpage?.document);
  if (doc) {
    const mime = doc.mimeType || '';
    if (mime.startsWith('video/')) return 'video';
    if (mime.startsWith('audio/')) return 'audio';
    if (mime.startsWith('image/')) return 'photo';
    return 'file';
  }
  return 'text';
}

function renderMedia(msg, mediaType) {
  const media = msg.media;
  const msgId = msg.id;

  if (mediaType === 'photo') {
    return `<div class="msg-media" id="photo-${msgId}">
      <div class="media-skeleton">
        <svg class="icon icon-sm" viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>
      </div>
    </div>`;
  }

  if (mediaType === 'video') {
    const doc = msg.document || media?.document;
    const attrs = doc?.attributes || [];
    const videoAttr = attrs.find(a => a.className === 'DocumentAttributeVideo');
    let duration = '';
    if (videoAttr?.duration) {
      const mins = Math.floor(videoAttr.duration / 60);
      const secs = videoAttr.duration % 60;
      duration = `${mins}:${secs.toString().padStart(2, '0')}`;
    }

    return `<div class="msg-media" id="video-${msgId}">
      <div class="video-card" data-msg-id="${msgId}">
        <div class="media-skeleton" style="position:relative;">
          <svg class="icon icon-sm" viewBox="0 0 24 24"><polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2" ry="2"/></svg>
        </div>
        ${duration ? `<div class="duration">${duration}</div>` : ''}
        <button class="fullscreen-btn" data-action="fullscreen" data-msg-id="${msgId}" title="全屏播放">
          <svg class="icon icon-sm" viewBox="0 0 24 24"><path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3"/></svg>
        </button>
      </div>
    </div>`;
  }

  if (mediaType === 'audio') {
    return `<div class="msg-media" id="audio-${msgId}"><div style="padding:8px;color:var(--text-secondary);">🎵 加载中...</div></div>`;
  }

  if (mediaType === 'file') {
    const doc = msg.document || media?.document;
    const attrs = doc?.attributes || [];
    const fileNameAttr = attrs.find(a => a.fileName);
    const fileName = fileNameAttr?.fileName || `file_${msgId}`;
    const size = formatSize(doc?.size || 0);
    const mime = doc?.mimeType || '';

    return `<div class="msg-media"><div class="file-card">
      <div class="file-icon">
        <svg class="icon icon-sm" viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
      </div>
      <div class="file-info"><div class="file-name">${escapeHtml(fileName)}</div><div class="file-size">${size}</div></div>
      <button class="file-dl-btn" data-msg-id="${msgId}">
        <svg class="icon icon-sm" style="width:14px;height:14px;color:#fff;" viewBox="0 0 24 24"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
      </button>
    </div></div>`;
  }

  return '';
}

// 懒加载媒体
function lazyLoadMedia(msg, div, mediaType) {
  const msgId = msg.id;

  // 使用 IntersectionObserver 实现懒加载
  if ('IntersectionObserver' in window) {
    const observer = new IntersectionObserver((entries) => {
      entries.forEach(entry => {
        if (entry.isIntersecting) {
          observer.unobserve(entry.target);
          loadMediaContent(msg, mediaType);
        }
      });
    }, { rootMargin: '200px' });
    observer.observe(div);
  } else {
    // 不支持则直接加载
    loadMediaContent(msg, mediaType);
  }
}

async function loadMediaContent(msg, mediaType) {
  const msgId = msg.id;

  if (mediaType === 'photo') {
    loadPhotoThumb(msg);
  } else if (mediaType === 'video') {
    loadVideoThumb(msg);
  } else if (mediaType === 'audio') {
    // 音频点击再加载
  }
}

// 加载图片缩略图（优化：先加载小缩略图，不加载全尺寸）
async function loadPhotoThumb(msg) {
  const msgId = msg.id;
  const cacheKey = `photo_${msgId}`;

  if (thumbCache.has(cacheKey)) {
    renderPhoto(msgId, thumbCache.get(cacheKey));
    return;
  }

  try {
    // 只加载缩略图级别 1（中等大小）
    const buf = await client.downloadMedia(msg, { thumb: 1 });
    if (buf && buf.length > 0) {
      const url = URL.createObjectURL(new Blob([buf], { type: 'image/jpeg' }));
      thumbCache.set(cacheKey, url);
      renderPhoto(msgId, url);

      // 视口内的图片再异步加载全尺寸
      const container = $(`photo-${msgId}`);
      if (container && isInViewport(container)) {
        loadFullPhoto(msg, msgId);
      }
    }
  } catch (e) { console.log('photo thumb error', e); }
}

async function loadFullPhoto(msg, msgId) {
  const cacheKey = `photo_full_${msgId}`;
  if (mediaCache.has(cacheKey)) {
    const img = document.querySelector(`#photo-${msgId} img`);
    if (img) img.src = mediaCache.get(cacheKey);
    return;
  }

  try {
    const fullBuf = await client.downloadMedia(msg);
    if (fullBuf && fullBuf.length > 0) {
      const fullUrl = URL.createObjectURL(new Blob([fullBuf], { type: 'image/jpeg' }));
      mediaCache.set(cacheKey, fullUrl);
      const img = document.querySelector(`#photo-${msgId} img`);
      if (img) img.src = fullUrl;
    }
  } catch (e) {}
}

function renderPhoto(msgId, url) {
  const container = $(`photo-${msgId}`);
  if (container) {
    container.innerHTML = `<img src="${url}" alt="" loading="lazy" />`;
    container.querySelector('img')?.addEventListener('click', () => {
      // 点击时加载全尺寸并预览
      const fullKey = `photo_full_${msgId}`;
      if (mediaCache.has(fullKey)) {
        openPreview(mediaCache.get(fullKey));
      } else {
        openPreview(url); // 先用缩略图预览
      }
    });
  }
}

// 加载视频缩略图（Telegram 文档缩略图）
async function loadVideoThumb(msg) {
  const msgId = msg.id;
  const cacheKey = `video_thumb_${msgId}`;

  if (thumbCache.has(cacheKey)) {
    renderVideoCard(msgId, thumbCache.get(cacheKey), msg);
    return;
  }

  try {
    // 下载 Telegram 提供的视频缩略图
    const buf = await client.downloadMedia(msg, { thumb: 0 });
    if (buf && buf.length > 0) {
      const url = URL.createObjectURL(new Blob([buf], { type: 'image/jpeg' }));
      thumbCache.set(cacheKey, url);
      renderVideoCard(msgId, url, msg);
    }
  } catch (e) {
    console.log('video thumb error', e);
    // 如果 Telegram 缩略图失败，用占位图
  }
}

function renderVideoCard(msgId, thumbUrl, msg) {
  const container = $(`video-${msgId}`);
  if (!container) return;

  const doc = msg.document || msg.media?.document;
  const attrs = doc?.attributes || [];
  const videoAttr = attrs.find(a => a.className === 'DocumentAttributeVideo');
  let duration = '';
  if (videoAttr?.duration) {
    const mins = Math.floor(videoAttr.duration / 60);
    const secs = videoAttr.duration % 60;
    duration = `${mins}:${secs.toString().padStart(2, '0')}`;
  }

  container.innerHTML = `
    <div class="video-card" data-msg-id="${msgId}">
      <img class="thumb" src="${thumbUrl}" alt="" />
      <div class="play-overlay" data-action="play-inline">
        <div class="play-btn">
          <svg class="icon" viewBox="0 0 24 24"><polygon points="5 3 19 12 5 21 5 3"/></svg>
        </div>
      </div>
      ${duration ? `<div class="duration">${duration}</div>` : ''}
      <button class="fullscreen-btn" data-action="fullscreen" title="全屏播放">
        <svg class="icon icon-sm" viewBox="0 0 24 24"><path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3"/></svg>
      </button>
    </div>
  `;

  const card = container.querySelector('.video-card');

  // 点击播放（内联）
  card.querySelector('.play-overlay').addEventListener('click', (e) => {
    e.stopPropagation();
    playVideoInline(msgId, msg, doc);
  });

  // 全屏按钮
  card.querySelector('.fullscreen-btn').addEventListener('click', (e) => {
    e.stopPropagation();
    playVideoFullscreen(msg, doc);
  });
}

// 内联播放视频（点击才加载）
async function playVideoInline(msgId, msg, doc) {
  const container = $(`video-${msgId}`);
  if (!container) return;

  const cacheKey = `video_full_${msgId}`;
  let videoUrl = mediaCache.get(cacheKey);

  if (!videoUrl) {
    container.innerHTML = `
      <div class="video-player">
        <div style="padding:40px;text-align:center;color:var(--text-secondary);">
          <div class="loading-spinner"></div>
          <div style="margin-top:8px;font-size:13px;">加载视频中...</div>
        </div>
      </div>
    `;

    try {
      const fullBuf = await client.downloadMedia(msg);
      if (fullBuf) {
        videoUrl = URL.createObjectURL(new Blob([fullBuf], { type: doc.mimeType || 'video/mp4' }));
        mediaCache.set(cacheKey, videoUrl);
      }
    } catch (e) {
      container.innerHTML = `<div style="padding:20px;color:#ff6b6b;text-align:center;">加载失败</div>`;
      return;
    }
  }

  if (videoUrl) {
    container.innerHTML = `
      <div class="video-player">
        <video src="${videoUrl}" controls autoplay style="max-width:360px;max-height:400px;border-radius:8px;"></video>
        <div class="player-controls">
          <button class="fs-btn" title="全屏">
            <svg class="icon icon-sm" viewBox="0 0 24 24"><path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3"/></svg>
          </button>
        </div>
      </div>
    `;

    const video = container.querySelector('video');
    const fsBtn = container.querySelector('.fs-btn');
    fsBtn.addEventListener('click', () => {
      openVideoModal(videoUrl);
      video.pause();
    });
  }
}

// 全屏播放视频
async function playVideoFullscreen(msg, doc) {
  const msgId = msg.id;
  const cacheKey = `video_full_${msgId}`;
  let videoUrl = mediaCache.get(cacheKey);

  if (!videoUrl) {
    // 显示加载状态
    el.videoModal.classList.remove('hidden');
    el.modalVideo.style.display = 'none';
    const spinner = document.createElement('div');
    spinner.className = 'loading-spinner';
    spinner.id = 'modal-spinner';
    spinner.style.marginTop = '45vh';
    el.videoModal.appendChild(spinner);

    try {
      const fullBuf = await client.downloadMedia(msg);
      if (fullBuf) {
        videoUrl = URL.createObjectURL(new Blob([fullBuf], { type: doc.mimeType || 'video/mp4' }));
        mediaCache.set(cacheKey, videoUrl);
      }
    } catch (e) {
      spinner.remove();
      const err = document.createElement('div');
      err.style.color = '#ff6b6b';
      err.style.textAlign = 'center';
      err.style.marginTop = '45vh';
      err.textContent = '加载失败';
      el.videoModal.appendChild(err);
      setTimeout(() => {
        err.remove();
        el.videoModal.classList.add('hidden');
      }, 2000);
      return;
    }

    spinner.remove();
  }

  openVideoModal(videoUrl);
}

function openVideoModal(url) {
  el.videoModal.classList.remove('hidden');
  el.modalVideo.style.display = '';
  el.modalVideo.src = url;
  el.modalVideo.play();
}

el.vmClose.addEventListener('click', () => {
  el.modalVideo.pause();
  el.modalVideo.src = '';
  el.videoModal.classList.add('hidden');
});

// 工具函数：判断元素是否在视口内
function isInViewport(el) {
  const rect = el.getBoundingClientRect();
  return (
    rect.top >= -200 &&
    rect.left >= 0 &&
    rect.bottom <= (window.innerHeight + 200 || document.documentElement.clientHeight + 200) &&
    rect.right <= (window.innerWidth || document.documentElement.clientWidth)
  );
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
  btn.disabled = true;
  btn.innerHTML = '<div class="loading-spinner" style="width:14px;height:14px;border-width:2px;margin:0;"></div>';
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
    btn.disabled = false;
    btn.innerHTML = `<svg class="icon icon-sm" style="width:14px;height:14px;color:#fff;" viewBox="0 0 24 24"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>`;
  } catch (err) {
    btn.disabled = false;
    btn.innerHTML = '失败';
    setTimeout(() => {
      btn.innerHTML = `<svg class="icon icon-sm" style="width:14px;height:14px;color:#fff;" viewBox="0 0 24 24"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>`;
    }, 2000);
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
    // 重新加载最新消息
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
      el.messagesBg.style.backgroundImage = '';
      localStorage.removeItem('tg_bg');
    } else if (bg === 'telegram') {
      el.messagesBg.style.background = 'linear-gradient(135deg, #2b5278 0%, #0e1621 100%)';
      el.messagesBg.style.backgroundImage = '';
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
  localStorage.removeItem('drive_channel_id');
  localStorage.removeItem('view_mode');
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
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  if (d.toDateString() === yesterday.toDateString()) return '昨天';
  return d.toLocaleDateString('zh-CN', { month: 'long', day: 'numeric' });
}

// ===== 启动 =====
init();
