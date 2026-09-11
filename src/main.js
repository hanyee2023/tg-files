import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions';
import { Api } from 'telegram/tl/api';

// ===== 配置 =====
const API_ID = parseInt(import.meta.env.VITE_API_ID || '0');
const API_HASH = import.meta.env.VITE_API_HASH || '';
const PROXY_DOMAIN = import.meta.env.VITE_PROXY_DOMAIN || '';

// ===== 代理 patch =====
if (PROXY_DOMAIN) {
  console.log('[Proxy] 代理启用:', PROXY_DOMAIN);
  const OrigWS = self.WebSocket;
  self.WebSocket = function (url, protocols) {
    if (typeof url === 'string' && url.includes('telegram.org')) {
      try { const u = new URL(url); url = `wss://${PROXY_DOMAIN}/${u.hostname}${u.pathname}`; console.log('[Proxy] WS:', u.hostname + u.pathname, '->', url); } catch (e) {}
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
let me = null;
let phoneCodeHash = '';
let currentEntity = null;
let currentPeer = null;
let allChats = [];
let loginStep = 'phone';
let driveChannelId = localStorage.getItem('drive_channel_id') || '';
let currentMode = 'drive'; // drive | chat

const COLORS = ['#e17076','#7bc862','#65aadd','#a695c7','#ee7aae','#6ec9cb','#faa774','#5b7b9a'];

// ===== DOM 引用 =====
const $ = id => document.getElementById(id);

// ===== 初始化 =====
let splashTimer = null;

async function init() {
  // 点击 splash 跳过
  $('splash-view')?.addEventListener('click', () => {
    if (splashTimer) { clearTimeout(splashTimer); splashTimer = null; }
    $('splash-view').classList.remove('show');
  });

  if (!API_ID || !API_HASH) {
    showLoginPage();
    $('login-status').className = 'login-status error';
    $('login-status').textContent = '请设置环境变量';
    return;
  }
  const saved = localStorage.getItem('tg_session');
  if (saved) {
    $('splash-view').classList.add('show');
    setSplashStatus('正在连接 Telegram...');

    // 30 秒超时，防止卡死
    splashTimer = setTimeout(() => {
      console.log('[Splash] 30秒超时，跳转登录页');
      try { client?.disconnect(); } catch(e) {}
      client = null;
      localStorage.removeItem('tg_session');
      showLoginPage();
      $('login-status').textContent = '连接超时，请重新登录';
    }, 30000);

    try {
      console.log('[Init] 创建 client, API_ID:', API_ID, 'PROXY:', PROXY_DOMAIN);
      client = new TelegramClient(new StringSession(saved), API_ID, API_HASH, { connectionRetries: 5, retryDelay: 2000 });
      console.log('[Init] 正在连接...');
      await client.connect();
      console.log('[Init] 连接成功，获取用户信息...');
      me = await client.getMe();
      console.log('[Init] 用户:', me?.firstName);
      if (splashTimer) { clearTimeout(splashTimer); splashTimer = null; }
      enterApp();
      return;
    } catch (e) {
      console.error('[Init] 连接失败:', e.message);
      if (splashTimer) { clearTimeout(splashTimer); splashTimer = null; }
      try { client?.disconnect(); } catch(e2) {}
      client = null;
      localStorage.removeItem('tg_session');
    }
  }
  console.log('[Init] 显示登录页');
  showLoginPage();
  $('login-status').textContent = '请输入手机号登录';
}

function setSplashStatus(text) {
  const el = $('splash-status');
  if (el) el.textContent = text;
}

function showLoginPage() {
  $('splash-view').classList.remove('show');
  $('login-view').style.display = 'flex';
  if (PROXY_DOMAIN && $('login-status')) {
    const cur = $('login-status').textContent;
    if (!cur.includes('代理')) {
      $('login-status').innerHTML = cur +
        `<div style="font-size:12px;color:#51cf66;margin-top:8px;">代理已启用: ${PROXY_DOMAIN}</div>`;
    }
  }
}

// ===== 登录流程 =====
$('main-btn').addEventListener('click', async () => {
  if (loginStep === 'phone') {
    const phone = $('phone').value.trim();
    if (!phone) return;
    $('main-btn').disabled = true;
    $('main-btn').textContent = '连接中...';
    $('login-status').className = 'login-status';
    $('login-status').textContent = '正在连接 Telegram...';
    try {
      // 总是创建新 client，避免复用坏掉的连接
      try { client?.disconnect(); } catch(e) {}
      client = new TelegramClient(new StringSession(''), API_ID, API_HASH, { connectionRetries: 5, retryDelay: 2000 });

      // 连接 + 发送验证码，20秒超时
      const connectPromise = client.connect();
      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('连接超时，请重试')), 20000)
      );
      await Promise.race([connectPromise, timeoutPromise]);

      $('login-status').textContent = '正在发送验证码...';
      const codePromise = client.sendCode({ apiId: API_ID, apiHash: API_HASH }, phone);
      const codeTimeout = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('发送验证码超时，请重试')), 20000)
      );
      const r = await Promise.race([codePromise, codeTimeout]);
      phoneCodeHash = r.phoneCodeHash;
      $('code-row').classList.remove('hidden');
      $('main-btn').textContent = '登录';
      $('main-btn').disabled = false;
      loginStep = 'code';
      $('login-status').className = 'login-status success';
      $('login-status').textContent = '验证码已发送到 Telegram';
    } catch (e) {
      console.error('Login error:', e);
      $('login-status').className = 'login-status error';
      $('login-status').textContent = e.message || String(e);
      $('main-btn').disabled = false;
      $('main-btn').textContent = '重新发送';
    }
  } else if (loginStep === 'code') {
    const code = $('code').value.trim();
    const phone = $('phone').value.trim();
    if (!code) return;
    $('main-btn').disabled = true;
    $('main-btn').textContent = '验证中...';
    try {
      await client.invoke(new Api.auth.SignIn({ phoneNumber: phone, phoneCodeHash, phoneCode: code }));
      me = await client.getMe();
      localStorage.setItem('tg_session', client.session.save());
      enterApp();
    } catch (e) {
      if (e.message?.includes('SESSION_PASSWORD_NEEDED')) {
        $('password-row').classList.remove('hidden');
        $('main-btn').textContent = '确认';
        loginStep = 'password';
        $('login-status').className = 'login-status';
        $('login-status').textContent = '请输入两步验证密码';
      } else {
        $('login-status').className = 'login-status error';
        $('login-status').textContent = e.message || String(e);
      }
      $('main-btn').disabled = false;
    }
  } else if (loginStep === 'password') {
    const pwd = $('password').value;
    if (!pwd) return;
    $('main-btn').disabled = true;
    $('main-btn').textContent = '验证中...';
    try {
      await client.signInWithPassword({ password: pwd });
      me = await client.getMe();
      localStorage.setItem('tg_session', client.session.save());
      enterApp();
    } catch (e) {
      $('login-status').className = 'login-status error';
      $('login-status').textContent = e.message || String(e);
      $('main-btn').disabled = false;
    }
  }
});

// ===== 进入应用 =====
function enterApp() {
  $('login-view').style.display = 'none';
  $('splash-view').classList.remove('show');
  $('app-view').classList.add('active');
  loadUserInfo();
  loadChatList();
  // 默认网盘模式
  if (driveChannelId) {
    setTimeout(() => openDriveChannel(), 300);
  }
}

// ===== 用户信息 =====
async function loadUserInfo() {
  if (!me) return;
  const name = (me.firstName || '') + (me.lastName ? ' ' + me.lastName : '');
  const initial = (me.firstName || '?').charAt(0).toUpperCase();
  const phoneStr = '+' + me.phone;

  // 设置面板用户信息
  $('settings-name') && ($('settings-name').textContent = name);
  $('settings-phone') && ($('settings-phone').textContent = phoneStr);

  // 用户头像（所有 .user-avatar 元素）
  const avatars = document.querySelectorAll('.user-avatar');
  avatars.forEach(a => {
    a.innerHTML = initial;
    a.style.background = COLORS[0];
  });

  // 加载真实头像
  try {
    const photos = await client.getProfilePhotos(me);
    if (photos.length > 0) {
      const buf = await client.downloadMedia(photos[0], { thumb: 0 });
      if (buf && buf.length > 0) {
        const url = URL.createObjectURL(new Blob([buf], { type: 'image/jpeg' }));
        avatars.forEach(a => {
          a.innerHTML = `<img src="${url}" alt="" />`;
        });
        // 设置面板头像
        const setAv = $('settings-avatar');
        if (setAv) {
          setAv.innerHTML = `<img src="${url}" alt="" />`;
          setAv.style.background = 'transparent';
        }
      }
    }
  } catch (e) { console.log('avatar error', e); }

  // 更新网盘横幅
  updateDriveBanner();
}

// ===== 聊天列表 =====
async function loadChatList() {
  const list = $('chat-list');
  if (!list) return;
  list.innerHTML = '<div style="text-align:center;padding:20px;color:#708499;">加载中...</div>';
  try {
    const dialogs = await client.getDialogs({ limit: 100 });
    allChats = [];
    list.innerHTML = '';
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
      const isDrive = chat.id === driveChannelId;
      item.innerHTML = `
        <div class="avatar" style="background:${color}">${escapeHtml(name.charAt(0).toUpperCase())}</div>
        <div class="chat-info">
          <div class="chat-name">${escapeHtml(name)}</div>
          <div class="chat-preview">${escapeHtml(preview.slice(0, 40))}</div>
        </div>
        ${isDrive ? '<div class="pin-icon" title="网盘频道">⭐</div>' : ''}
      `;
      item.addEventListener('click', () => openChat(chat, item));
      list.appendChild(item);
    }
    // 异步加载头像
    for (let i = 0; i < allChats.length; i++) {
      loadChatAvatar(allChats[i], i);
    }
  } catch (e) {
    list.innerHTML = `<div style="padding:20px;color:#ff6b6b;">错误: ${escapeHtml(e.message)}</div>`;
  }
}

async function loadChatAvatar(chat, idx) {
  try {
    const photos = await client.getProfilePhotos(chat.entity);
    if (photos.length > 0) {
      const buf = await client.downloadMedia(photos[0], { thumb: 0 });
      if (buf && buf.length > 0) {
        const url = URL.createObjectURL(new Blob([buf], { type: 'image/jpeg' }));
        const items = document.querySelectorAll('.chat-item');
        const item = items[idx];
        if (item) {
          const av = item.querySelector('.avatar');
          if (av) av.innerHTML = `<img src="${url}" alt="" />`;
        }
      }
    }
  } catch (e) {}
}

// 搜索
$('search-input')?.addEventListener('input', (e) => {
  const q = e.target.value.toLowerCase();
  document.querySelectorAll('.chat-item').forEach((item, i) => {
    const chat = allChats[i];
    const name = chat?.name?.toLowerCase() || '';
    item.style.display = name.includes(q) ? '' : 'none';
  });
});

// ===== 模式切换 =====
document.querySelectorAll('.mode-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.mode-tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    currentMode = tab.dataset.mode;
    if (currentMode === 'drive') {
      $('input-bar')?.classList.add('hidden');
      if (driveChannelId) {
        openDriveChannel();
      } else {
        showEmptyState('选择网盘频道', '点击左侧星标按钮将频道设为网盘');
      }
    } else {
      // 聊天模式
      $('input-bar')?.classList.remove('hidden');
      if (currentEntity) {
        loadMessages();
      } else {
        showEmptyState('选择一个对话', '从左侧列表选择开始聊天');
      }
    }
  });
});

function showEmptyState(title, desc) {
  const mainArea = $('main-area');
  if (!mainArea) return;
  mainArea.classList.add('empty');
  $('topbar')?.classList.add('hidden');
  $('files-grid')?.classList.add('hidden');
  $('messages-wrap')?.classList.add('hidden');
  $('input-bar')?.classList.add('hidden');
  // 更新 empty state 文字
  const emptyState = mainArea.querySelector('.empty-state');
  if (emptyState) {
    emptyState.innerHTML = `
      <svg class="icon-lg" viewBox="0 0 24 24" style="color:#2b5278;margin-bottom:12px;"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path></svg>
      <div style="font-size:18px;font-weight:500;margin-bottom:4px;">${escapeHtml(title)}</div>
      <div style="font-size:14px;color:#708499;">${escapeHtml(desc)}</div>
    `;
  }
}

// ===== 网盘频道 =====
function updateDriveBanner() {
  if (driveChannelId) {
    const chat = allChats.find(c => c.id === driveChannelId);
    $('drive-subtitle') && ($('drive-subtitle').textContent = chat?.name || '已设置');
    $('drive-channel-value') && ($('drive-channel-value').textContent = chat?.name || '已设置');
  } else {
    $('drive-subtitle') && ($('drive-subtitle').textContent = '点击设置网盘频道');
    $('drive-channel-value') && ($('drive-channel-value').textContent = '未设置');
  }
}

function setDriveChannel(chatId) {
  if (driveChannelId === chatId) {
    driveChannelId = '';
    localStorage.removeItem('drive_channel_id');
  } else {
    driveChannelId = chatId;
    localStorage.setItem('drive_channel_id', chatId);
  }
  // 更新UI - 星标
  document.querySelectorAll('.chat-item').forEach((item, i) => {
    const chat = allChats[i];
    const oldPin = item.querySelector('.pin-icon');
    if (oldPin) oldPin.remove();
    if (chat && chat.id === driveChannelId) {
      const pin = document.createElement('div');
      pin.className = 'pin-icon';
      pin.title = '网盘频道';
      pin.textContent = '⭐';
      item.appendChild(pin);
    }
  });
  updateDriveBanner();
  if (driveChannelId && currentMode === 'drive') {
    openDriveChannel();
  }
}

$('drive-banner')?.addEventListener('click', () => {
  if (driveChannelId) {
    openDriveChannel();
  }
});

$('set-drive-btn')?.addEventListener('click', () => {
  alert('请在左侧聊天列表中点击星标 ⭐ 按钮设置网盘频道');
});

$('clear-drive-btn')?.addEventListener('click', () => {
  if (driveChannelId) {
    setDriveChannel('');
    alert('已清除网盘频道设置');
  }
});

function openDriveChannel() {
  const chat = allChats.find(c => c.id === driveChannelId);
  if (chat) {
    document.querySelectorAll('.mode-tab').forEach(t => t.classList.remove('active'));
    document.querySelector('.mode-tab[data-mode="drive"]')?.classList.add('active');
    currentMode = 'drive';
    openChat(chat, null);
  }
}

// ===== 打开聊天/频道 =====
async function openChat(chat, itemEl) {
  currentEntity = chat.entity;
  currentPeer = chat.dialog.inputPeer || chat.entity;

  // 高亮选中
  document.querySelectorAll('.chat-item').forEach(i => i.classList.remove('active'));
  if (itemEl) itemEl.classList.add('active');

  // 显示主区域
  $('main-area')?.classList.remove('empty');
  $('topbar')?.classList.remove('hidden');

  // 顶部栏信息
  $('topbar-name') && ($('topbar-name').textContent = chat.name);
  $('topbar-sub') && ($('topbar-sub').textContent = chat.entity?.className?.replace('Channel', '频道').replace('User', '用户') || '');
  const topAvatar = $('topbar-avatar');
  if (topAvatar) {
    topAvatar.innerHTML = escapeHtml(chat.name.charAt(0).toUpperCase());
    topAvatar.style.background = chat.color;
  }

  // 更新 pin 按钮状态
  const pinBtn = $('pin-btn');
  if (pinBtn) {
    const isDrive = chat.id === driveChannelId;
    pinBtn.style.color = isDrive ? 'var(--tg-blue)' : '';
    pinBtn.title = isDrive ? '取消网盘' : '设为网盘';
    pinBtn.onclick = () => setDriveChannel(chat.id);
  }

  // 加载频道头像到顶部
  try {
    const photos = await client.getProfilePhotos(chat.entity);
    if (photos.length > 0) {
      const buf = await client.downloadMedia(photos[0], { thumb: 0 });
      if (buf && buf.length > 0 && topAvatar) {
        const url = URL.createObjectURL(new Blob([buf], { type: 'image/jpeg' }));
        topAvatar.innerHTML = `<img src="${url}" alt="" />`;
      }
    }
  } catch (e) {}

  // 移动端
  if (window.innerWidth <= 768) {
    $('sidebar')?.classList.add('hidden-mobile');
    $('main-area')?.classList.add('active-mobile');
  }

  // 加载内容
  loadMessages();
}

// ===== 加载消息/文件 =====
async function loadMessages() {
  if (!currentEntity) return;

  const msgsEl = $('messages');
  const gridEl = $('files-grid');
  const wrapEl = $('messages-wrap');

  if (currentMode === 'drive') {
    // 网盘模式：显示文件网格
    wrapEl?.classList.add('hidden');
    gridEl?.classList.remove('hidden');
    $('input-bar')?.classList.add('hidden');
    if (gridEl) {
      gridEl.innerHTML = '<div class="loading-spinner" style="grid-column:1/-1;"></div>';
    }
    try {
      const messages = await client.getMessages(currentEntity, { limit: 100 });
      renderDriveGrid(messages);
    } catch (e) {
      if (gridEl) gridEl.innerHTML = `<div style="grid-column:1/-1;padding:20px;color:#ff6b6b;text-align:center;">加载失败: ${escapeHtml(e.message)}</div>`;
    }
  } else {
    // 聊天模式
    gridEl?.classList.add('hidden');
    wrapEl?.classList.remove('hidden');
    $('input-bar')?.classList.remove('hidden');
    if (msgsEl) {
      msgsEl.innerHTML = '<div class="loading-spinner"></div>';
    }
    try {
      const messages = await client.getMessages(currentEntity, { limit: 50 });
      msgsEl.innerHTML = '';
      let lastDate = '';
      for (const msg of messages.reverse()) {
        const date = formatDate(msg.date);
        if (date !== lastDate) {
          lastDate = date;
          const sep = document.createElement('div');
          sep.className = 'date-sep';
          sep.innerHTML = `<span>${date}</span>`;
          msgsEl.appendChild(sep);
        }
        renderMessage(msg);
      }
      msgsEl.scrollTop = msgsEl.scrollHeight;
    } catch (e) {
      if (msgsEl) msgsEl.innerHTML = `<div style="padding:20px;color:#ff6b6b;">加载失败: ${escapeHtml(e.message)}</div>`;
    }
  }
}

// ===== 网盘网格视图 =====
function renderDriveGrid(messages) {
  const grid = $('files-grid');
  if (!grid) return;
  grid.innerHTML = '';
  let count = 0;
  for (const msg of messages) {
    if (msg.className === 'MessageEmpty') continue;
    const card = createFileCard(msg);
    if (card) {
      grid.appendChild(card);
      count++;
    }
  }
  if (count === 0) {
    grid.innerHTML = '<div style="grid-column:1/-1;text-align:center;padding:40px;color:#708499;">该频道暂无媒体文件</div>';
  }
}

function createFileCard(msg) {
  const doc = msg.document || msg.media?.document;
  const photo = msg.photo || msg.media?.photo;

  // 图片
  if (photo || (doc && doc.mimeType?.startsWith('image/'))) {
    const card = document.createElement('div');
    card.className = 'file-card';
    card.innerHTML = `
      <div class="file-thumb">
        <div class="placeholder">🖼️</div>
      </div>
      <div class="file-info">
        <div class="file-name">图片_${msg.id}</div>
        <div class="file-meta">
          <span>图片</span>
        </div>
      </div>
      <div class="file-actions">
        <button class="file-action-btn" data-action="preview">
          <svg viewBox="0 0 24 24"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path><circle cx="12" cy="12" r="3"></circle></svg>
          预览
        </button>
        <button class="file-action-btn" data-action="download">
          <svg viewBox="0 0 24 24"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>
          下载
        </button>
      </div>
    `;
    // 异步加载缩略图
    client.downloadMedia(msg, { thumb: 1 }).then(buf => {
      if (buf && buf.length > 0) {
        const url = URL.createObjectURL(new Blob([buf], { type: 'image/jpeg' }));
        const thumb = card.querySelector('.file-thumb');
        if (thumb) thumb.innerHTML = `<img src="${url}" alt="" loading="lazy" />`;
      }
    }).catch(() => {});

    // 文件名
    if (doc) {
      const fn = doc.attributes?.find(a => a.fileName)?.fileName;
      if (fn) card.querySelector('.file-name').textContent = fn;
      const sz = formatSize(doc.size);
      if (sz) card.querySelector('.file-meta span').textContent = sz;
    }

    // 事件
    card.querySelector('[data-action="preview"]')?.addEventListener('click', (e) => {
      e.stopPropagation();
      openImagePreview(msg);
    });
    card.querySelector('[data-action="download"]')?.addEventListener('click', (e) => {
      e.stopPropagation();
      downloadFile(msg);
    });
    card.querySelector('.file-thumb')?.addEventListener('click', () => openImagePreview(msg));
    return card;
  }

  // 视频
  if (doc && doc.mimeType?.startsWith('video/')) {
    const fileName = doc.attributes?.find(a => a.fileName)?.fileName || `video_${msg.id}`;
    const size = formatSize(doc.size || 0);
    const card = document.createElement('div');
    card.className = 'file-card';
    card.innerHTML = `
      <div class="file-thumb">
        <div class="placeholder">🎬</div>
        <div class="play-overlay">
          <div class="play-btn">
            <svg viewBox="0 0 24 24"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg>
          </div>
        </div>
      </div>
      <div class="file-info">
        <div class="file-name">${escapeHtml(fileName)}</div>
        <div class="file-meta">
          <span>${size}</span>
        </div>
      </div>
      <div class="file-actions">
        <button class="file-action-btn" data-action="play">
          <svg viewBox="0 0 24 24"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg>
          播放
        </button>
        <button class="file-action-btn" data-action="download">
          <svg viewBox="0 0 24 24"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>
          下载
        </button>
      </div>
    `;
    // 异步加载缩略图（首帧）
    client.downloadMedia(msg, { thumb: 0 }).then(buf => {
      if (buf && buf.length > 0) {
        const url = URL.createObjectURL(new Blob([buf], { type: 'image/jpeg' }));
        const thumb = card.querySelector('.file-thumb');
        if (thumb) {
          const placeholder = thumb.querySelector('.placeholder');
          if (placeholder) placeholder.remove();
          const img = document.createElement('img');
          img.src = url;
          img.loading = 'lazy';
          thumb.insertBefore(img, thumb.firstChild);
        }
      }
    }).catch(() => {});

    card.querySelector('[data-action="play"]')?.addEventListener('click', (e) => {
      e.stopPropagation();
      playVideo(msg, doc);
    });
    card.querySelector('[data-action="download"]')?.addEventListener('click', (e) => {
      e.stopPropagation();
      downloadFile(msg);
    });
    card.querySelector('.file-thumb')?.addEventListener('click', () => playVideo(msg, doc));
    return card;
  }

  // 其他文件
  if (doc) {
    const fileName = doc.attributes?.find(a => a.fileName)?.fileName || `file_${msg.id}`;
    const size = formatSize(doc.size || 0);
    const mime = doc.mimeType || '';
    const icon = mime === 'application/pdf' ? '📄' : mime.includes('zip') || mime.includes('rar') || mime.includes('7z') ? '🗜️' : mime.includes('audio') ? '🎵' : '📦';

    const card = document.createElement('div');
    card.className = 'file-card';
    card.innerHTML = `
      <div class="file-thumb">
        <div class="placeholder" style="font-size:48px;">${icon}</div>
      </div>
      <div class="file-info">
        <div class="file-name">${escapeHtml(fileName)}</div>
        <div class="file-meta">
          <span>${size}</span>
        </div>
      </div>
      <div class="file-actions">
        <button class="file-action-btn" data-action="download">
          <svg viewBox="0 0 24 24"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>
          下载
        </button>
      </div>
    `;

    card.querySelector('[data-action="download"]')?.addEventListener('click', (e) => {
      e.stopPropagation();
      downloadFile(msg);
    });
    return card;
  }

  return null;
}

// ===== 渲染消息（聊天模式）=====
function renderMessage(msg) {
  if (msg.className === 'MessageEmpty') return;
  const isOut = msg.out || false;
  const div = document.createElement('div');
  div.className = `msg ${isOut ? 'out' : 'in'}`;

  let mediaHtml = '';
  let textHtml = '';

  const text = msg.text || msg.message || '';
  if (text) textHtml = `<div class="msg-text">${escapeHtml(text)}</div>`;

  if (msg.media) {
    mediaHtml = renderMsgMedia(msg);
  }

  let senderHtml = '';
  if (!isOut && currentEntity?.className === 'Channel' && msg.sender) {
    const senderName = msg.sender.firstName || msg.sender.title || '';
    if (senderName) senderHtml = `<div class="msg-sender">${escapeHtml(senderName)}</div>`;
  }

  const time = formatTime(msg.date);
  div.innerHTML = `<div class="msg-bubble">${senderHtml}${mediaHtml}${textHtml}<div class="msg-time">${time}</div></div>`;
  $('messages')?.appendChild(div);
}

function renderMsgMedia(msg) {
  const doc = msg.document || msg.media?.document;
  const photo = msg.photo || msg.media?.photo;

  if (photo) {
    const phId = `ph-${msg.id}`;
    client.downloadMedia(msg, { thumb: 1 }).then(buf => {
      if (buf) {
        const url = URL.createObjectURL(new Blob([buf], { type: 'image/jpeg' }));
        const el = $(phId);
        if (el) el.innerHTML = `<img src="${url}" alt="" style="max-width:320px;border-radius:8px;cursor:pointer;" />`;
        el?.querySelector('img')?.addEventListener('click', () => openImagePreview(msg));
      }
    }).catch(() => {});
    return `<div class="msg-media" id="${phId}"><div style="width:300px;height:200px;background:#1a1a2e;display:flex;align-items:center;justify-content:center;border-radius:8px;">🖼️ 加载中...</div></div>`;
  }

  if (doc) {
    const mime = doc.mimeType || '';
    const fileName = doc.attributes?.find(a => a.fileName)?.fileName || `file_${msg.id}`;
    const size = formatSize(doc.size || 0);

    if (mime.startsWith('video/')) {
      const vidId = `vid-${msg.id}`;
      client.downloadMedia(msg, { thumb: 0 }).then(buf => {
        if (buf) {
          const url = URL.createObjectURL(new Blob([buf], { type: 'image/jpeg' }));
          const el = $(vidId);
          if (el) {
            el.innerHTML = `
              <div style="position:relative;cursor:pointer;max-width:320px;">
                <img src="${url}" style="width:100%;border-radius:8px;" />
                <div style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,0.3);">
                  <div style="width:48px;height:48px;border-radius:50%;background:rgba(0,0,0,0.6);display:flex;align-items:center;justify-content:center;">
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="white"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg>
                  </div>
                </div>
              </div>
            `;
            el.querySelector('div')?.addEventListener('click', () => playVideo(msg, doc));
          }
        }
      }).catch(() => {});
      return `<div class="msg-media" id="${vidId}"><div style="width:300px;height:200px;background:#000;display:flex;align-items:center;justify-content:center;border-radius:8px;">🎬 加载中...</div></div>`;
    }

    if (mime.startsWith('audio/')) {
      const aid = `aud-${msg.id}`;
      client.downloadMedia(msg).then(buf => {
        if (buf) {
          const url = URL.createObjectURL(new Blob([buf], { type: mime }));
          const el = $(aid);
          if (el) el.innerHTML = `<audio src="${url}" controls style="width:260px;"></audio>`;
        }
      }).catch(() => {});
      return `<div class="msg-media" id="${aid}"><div style="padding:12px;width:280px;">🎵 加载中...</div></div>`;
    }

    if (mime.startsWith('image/')) {
      const iid = `imgd-${msg.id}`;
      client.downloadMedia(msg, { thumb: 1 }).then(buf => {
        if (buf) {
          const url = URL.createObjectURL(new Blob([buf], { type: 'image/jpeg' }));
          const el = $(iid);
          if (el) el.innerHTML = `<img src="${url}" alt="" style="max-width:320px;border-radius:8px;cursor:pointer;" />`;
          el?.querySelector('img')?.addEventListener('click', () => openImagePreview(msg));
        }
      }).catch(() => {});
      return `<div class="msg-media" id="${iid}"><div style="width:300px;height:200px;background:#1a1a2e;display:flex;align-items:center;justify-content:center;border-radius:8px;">🖼️ 加载中...</div></div>`;
    }

    // 普通文件
    const icon = mime === 'application/pdf' ? '📄' : mime.includes('zip') ? '🗜️' : '📦';
    return `<div class="msg-media">
      <div class="file-row">
        <div class="file-icon">${icon}</div>
        <div class="file-text">
          <div class="n">${escapeHtml(fileName)}</div>
          <div class="s">${size}</div>
        </div>
        <button class="file-dl-btn" data-msg-id="${msg.id}" style="background:var(--tg-blue);color:#fff;border:none;border-radius:6px;padding:6px 12px;cursor:pointer;font-size:13px;">下载</button>
      </div>
    </div>`;
  }

  return '';
}

// ===== 图片预览 =====
function openImagePreview(msg) {
  const overlay = $('preview-overlay');
  const img = $('preview-img');
  if (!overlay || !img) return;
  overlay.classList.remove('hidden');
  img.src = '';
  img.alt = '加载中...';
  client.downloadMedia(msg).then(buf => {
    if (buf && buf.length > 0) {
      const url = URL.createObjectURL(new Blob([buf], { type: 'image/jpeg' }));
      img.src = url;
    }
  }).catch(e => {
    console.error('preview error', e);
    img.alt = '加载失败';
  });
}

$('preview-close')?.addEventListener('click', () => $('preview-overlay')?.classList.add('hidden'));
$('preview-overlay')?.addEventListener('click', (e) => {
  if (e.target.id === 'preview-overlay') $('preview-overlay')?.classList.add('hidden');
});

// ===== 视频播放（浮窗）=====
function playVideo(msg, doc) {
  const player = $('video-player');
  const video = $('vp-video');
  if (!player || !video) return;

  player.classList.remove('hidden');
  $('vp-title') && ($('vp-title').textContent = doc?.attributes?.find(a => a.fileName)?.fileName || '视频');

  video.src = '';
  video.poster = '';

  // 先加载缩略图作为海报
  client.downloadMedia(msg, { thumb: 0 }).then(buf => {
    if (buf && buf.length > 0) {
      video.poster = URL.createObjectURL(new Blob([buf], { type: 'image/jpeg' }));
    }
  }).catch(() => {});

  // 下载完整视频并播放
  client.downloadMedia(msg).then(buf => {
    if (buf && buf.length > 0) {
      const url = URL.createObjectURL(new Blob([buf], { type: doc.mimeType || 'video/mp4' }));
      video.src = url;
      video.play().catch(() => {});
    }
  }).catch(e => {
    console.error('video error:', e);
    alert('视频加载失败: ' + e.message);
  });
}

$('vp-close')?.addEventListener('click', () => {
  $('video-player')?.classList.add('hidden');
  const v = $('vp-video');
  if (v) { v.pause(); v.src = ''; v.poster = ''; }
});

// ===== 下载文件 =====
async function downloadFile(msg) {
  const doc = msg.document || msg.media?.document;
  const fileName = doc?.attributes?.find(a => a.fileName)?.fileName ||
                   (msg.photo ? `photo_${msg.id}.jpg` : `file_${msg.id}`);

  // 显示下载提示
  const toast = showToast(`正在下载: ${fileName}`);

  try {
    const buf = await client.downloadMedia(msg);
    if (buf) {
      const mimeType = doc?.mimeType || (msg.photo ? 'image/jpeg' : 'application/octet-stream');
      const blob = new Blob([buf], { type: mimeType });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = fileName;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      toast.textContent = `✓ 下载完成: ${fileName}`;
      setTimeout(() => toast.remove(), 2000);
    }
  } catch (err) {
    console.error('download error:', err);
    toast.textContent = `✗ 下载失败: ${err.message}`;
    toast.style.background = '#e17076';
    setTimeout(() => toast.remove(), 3000);
  }
}

function showToast(text) {
  const toast = document.createElement('div');
  toast.style.cssText = `
    position: fixed; bottom: 80px; left: 50%; transform: translateX(-50%);
    background: rgba(0,0,0,0.8); color: #fff; padding: 10px 20px;
    border-radius: 8px; font-size: 14px; z-index: 10000;
    max-width: 80vw; word-break: break-all;
  `;
  toast.textContent = text;
  document.body.appendChild(toast);
  return toast;
}

// 聊天模式文件下载（事件委托）
$('messages')?.addEventListener('click', async (e) => {
  const btn = e.target.closest('.file-dl-btn');
  if (!btn) return;
  const msgId = parseInt(btn.dataset.msgId);
  const origText = btn.textContent;
  btn.textContent = '...';
  btn.disabled = true;
  try {
    const msgs = await client.getMessages(currentEntity, { ids: [msgId] });
    if (msgs[0]) await downloadFile(msgs[0]);
    btn.textContent = origText;
    btn.disabled = false;
  } catch (err) {
    btn.textContent = '失败';
    btn.disabled = false;
    setTimeout(() => { btn.textContent = origText; btn.disabled = false; }, 2000);
    console.error(err);
  }
});

// ===== 返回（移动端）=====
$('back-btn')?.addEventListener('click', () => {
  $('sidebar')?.classList.remove('hidden-mobile');
  $('main-area')?.classList.remove('active-mobile');
});

// ===== 设置面板 =====
$('user-avatar')?.addEventListener('click', () => $('settings-panel')?.classList.add('open'));
$('settings-close')?.addEventListener('click', () => $('settings-panel')?.classList.remove('open'));

// 退出登录
$('logout-btn')?.addEventListener('click', () => {
  if (!confirm('确定退出登录？')) return;
  localStorage.removeItem('tg_session');
  location.reload();
});

// ===== 背景设置 =====
let bgOpacity = parseInt(localStorage.getItem('bg_opacity') || '8');
$('bg-opacity') && ($('bg-opacity').value = bgOpacity);

function updateBgOpacity() {
  const bg = $('messages-bg');
  if (bg) bg.style.opacity = (bgOpacity / 100).toString();
}

$('bg-opacity')?.addEventListener('input', (e) => {
  bgOpacity = parseInt(e.target.value);
  localStorage.setItem('bg_opacity', bgOpacity);
  updateBgOpacity();
});

// 预设背景
document.querySelectorAll('.bg-option').forEach(opt => {
  opt.addEventListener('click', () => {
    document.querySelectorAll('.bg-option').forEach(o => o.classList.remove('active'));
    opt.classList.add('active');
    const bg = opt.dataset.bg;
    const bgEl = $('messages-bg');
    if (bgEl) {
      if (bg === 'default') {
        bgEl.style.background = 'linear-gradient(135deg, #0e1621, #1a2a3a)';
        bgEl.style.backgroundImage = '';
      } else if (bg === 'tg') {
        bgEl.style.background = 'linear-gradient(135deg, #2b5278, #0e1621)';
        bgEl.style.backgroundImage = '';
      } else if (bg === 'dark') {
        bgEl.style.background = '#0e1621';
        bgEl.style.backgroundImage = '';
      }
      localStorage.setItem('bg_type', bg);
    }
  });
});

// 自定义背景图
$('bg-file-input')?.addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (ev) => {
    const bgEl = $('messages-bg');
    if (bgEl) {
      bgEl.style.backgroundImage = `url(${ev.target.result})`;
      bgEl.style.backgroundSize = 'cover';
      bgEl.style.backgroundPosition = 'center';
      localStorage.setItem('bg_custom', ev.target.result);
      localStorage.setItem('bg_type', 'custom');
      document.querySelectorAll('.bg-option').forEach(o => o.classList.remove('active'));
    }
  };
  reader.readAsDataURL(file);
});

// 恢复背景设置
function restoreBgSettings() {
  const bgType = localStorage.getItem('bg_type') || 'default';
  const bgCustom = localStorage.getItem('bg_custom');
  const bgEl = $('messages-bg');
  if (!bgEl) return;

  if (bgType === 'custom' && bgCustom) {
    bgEl.style.backgroundImage = `url(${bgCustom})`;
    bgEl.style.backgroundSize = 'cover';
    bgEl.style.backgroundPosition = 'center';
  } else if (bgType === 'tg') {
    bgEl.style.background = 'linear-gradient(135deg, #2b5278, #0e1621)';
  } else if (bgType === 'dark') {
    bgEl.style.background = '#0e1621';
  } else {
    bgEl.style.background = 'linear-gradient(135deg, #0e1621, #1a2a3a)';
  }
  updateBgOpacity();
}

// ===== 发送消息 =====
$('send-btn')?.addEventListener('click', sendMessage);
$('msg-input')?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
});

async function sendMessage() {
  const input = $('msg-input');
  if (!input || !currentEntity) return;
  const text = input.value.trim();
  if (!text) return;

  const btn = $('send-btn');
  btn.disabled = true;
  input.value = '';

  try {
    await client.sendMessage(currentEntity, { message: text });
    // 重新加载消息
    loadMessages();
  } catch (e) {
    console.error('send error:', e);
    alert('发送失败: ' + e.message);
    input.value = text;
  }
  btn.disabled = false;
}

// 发送文件
$('attach-btn')?.addEventListener('click', () => $('file-input')?.click());
$('file-input')?.addEventListener('change', async (e) => {
  const files = e.target.files;
  if (!files || !files.length || !currentEntity) return;

  const btn = $('attach-btn');
  btn.disabled = true;

  for (const file of files) {
    try {
      showToast(`正在上传: ${file.name}`);
      await client.sendFile(currentEntity, { file });
    } catch (err) {
      console.error('upload error:', err);
      alert(`上传失败 ${file.name}: ${err.message}`);
    }
  }
  e.target.value = '';
  btn.disabled = false;
  loadMessages();
});

// ===== 工具函数 =====
function formatSize(bytes) {
  if (!bytes) return '0 B';
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

// 进入应用后恢复背景
const origEnterApp = enterApp;
// 在 enterApp 后调用恢复背景
const observer = new MutationObserver(() => {
  if ($('app-view')?.classList.contains('active')) {
    restoreBgSettings();
    observer.disconnect();
  }
});
if ($('app-view')) observer.observe($('app-view'), { attributes: true, attributeFilter: ['class'] });
