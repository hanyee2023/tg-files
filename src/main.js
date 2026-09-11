// ⚠️ proxy.js 必须第一个 import，确保 GramJS 加载前 patch 好 WebSocket 和 fetch
import './proxy.js';
import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions';
import { Api } from 'telegram/tl/api';
import { HTTPConnection } from 'telegram/network';

// ===== 配置 =====
const API_ID = parseInt(import.meta.env.VITE_API_ID || '0');
const API_HASH = import.meta.env.VITE_API_HASH || '';
const PROXY_DOMAIN = import.meta.env.VITE_PROXY_DOMAIN || '';

// ===== 状态 =====
let client = null;
let phoneCodeHash = '';
let me = null;
let currentMode = 'drive'; // 'drive' | 'chat'
let currentEntity = null;
let allChats = [];
let driveChannelId = localStorage.getItem('drive_channel') || null;
let loginStep = 'phone';
let filesCache = {}; // channelId -> file array

const COLORS = ['#e17076','#7bc862','#65aadd','#a695c7','#ee7aae','#6ec9cb','#faa774','#5b7b9a'];
const LOAD_LIMIT = 100;

// ===== DOM 引用 =====
const $ = id => document.getElementById(id);

// 全局错误捕获
window.addEventListener('error', (e) => {
  console.error('Global error:', e.error || e.message);
  const statusEl = $('login-status');
  if (statusEl && !statusEl.classList.contains('error')) {
    statusEl.className = 'login-status error';
    statusEl.textContent = '加载错误: ' + (e.error?.message || e.message || '未知错误');
  }
});

console.log('[Boot] API_ID:', API_ID ? '✓' : '✗', 'PROXY:', PROXY_DOMAIN || '(未设置)');

// ===== 启动（先显示 splash，再判断跳转） =====
let splashTimer = null;

function setSplashStatus(text) {
  const el = $('splash-status');
  if (el) el.textContent = text;
  console.log('[Splash]', text);
}

async function boot() {
  // 安全兜底：30秒后强制显示登录页，防止卡死
  // 注意：session 恢复需要 WebSocket 握手 + MTProto 鉴权，较慢
  splashTimer = setTimeout(() => {
    console.warn('Splash timeout, forcing login page');
    setSplashStatus('连接超时，跳转到登录页...');
    setTimeout(() => showLoginPage(), 800);
  }, 30000);

  // 点击 splash 也可以跳过
  $('splash-view').addEventListener('click', () => {
    showLoginPage();
  });

  if (!API_ID || !API_HASH) {
    showLoginPage();
    $('login-status').className = 'login-status error';
    $('login-status').textContent = '请设置环境变量';
    return;
  }

  const saved = localStorage.getItem('tg_session');
  if (!saved) {
    showLoginPage();
    $('login-status').textContent = '请输入手机号登录';
    return;
  }

  // 有 session，尝试恢复
  setSplashStatus('正在连接 Telegram...');
  try {
    client = new TelegramClient(new StringSession(saved), API_ID, API_HASH, {
      connection: HTTPConnection,
      connectionRetries: 2, retryDelay: 2000, autoReconnect: true,
    });
    await client.connect();
    setSplashStatus('连接成功，正在恢复会话...');
    // 给 getMe 加超时，防止 session 无效时卡死
    const getMeTimeout = new Promise((_, reject) => {
      setTimeout(() => reject(new Error('会话恢复超时')), 15000);
    });
    me = await Promise.race([client.getMe(), getMeTimeout]);
    clearTimeout(splashTimer);
    setSplashStatus('登录成功，进入应用...');
    // 即使 splash 已经超时跳去登录页，连接成功后也自动进入应用
    enterApp();
  } catch (e) {
    console.warn('Session restore failed:', e);
    setSplashStatus('会话失效，请重新登录');
    localStorage.removeItem('tg_session');
    setTimeout(() => {
      showLoginPage();
      $('login-status').textContent = '会话已过期，请重新登录';
    }, 1000);
  }
}

function showLoginPage() {
  clearTimeout(splashTimer);
  $('splash-view').classList.remove('show');
  $('login-view').style.display = 'flex';
  // 显示代理状态
  const proxyStatus = PROXY_DOMAIN
    ? `<div style="font-size:12px;color:#51cf66;margin-top:8px;">代理已启用: ${PROXY_DOMAIN}</div>`
    : `<div style="font-size:12px;color:#ff6b6b;margin-top:8px;">警告: 未配置代理</div>`;
  if ($('login-status').textContent === '请输入手机号登录') {
    $('login-status').innerHTML = '请输入手机号登录' + proxyStatus;
  }
}

function hideSplash() {
  clearTimeout(splashTimer);
  $('splash-view').classList.remove('show');
}

// ===== 带超时的连接辅助函数 =====
async function connectWithTimeout(c, timeoutMs = 20000) {
  let done = false;
  const timeoutP = new Promise((_, reject) => {
    setTimeout(() => {
      if (!done) reject(new Error('连接超时，请检查网络或代理'));
    }, timeoutMs);
  });
  const connectP = c.connect();
  const result = await Promise.race([connectP, timeoutP]);
  done = true;
  return result;
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
      // 登录时总是用全新的 client，避免复用 splash 阶段残留的 client 导致状态混乱
      if (client) {
        try { await client.disconnect(); } catch(_) {}
        client = null;
      }
      client = new TelegramClient(new StringSession(''), API_ID, API_HASH, {
        connection: HTTPConnection,
        connectionRetries: 1,
        retryDelay: 1000,
        autoReconnect: false,
      });
      $('login-status').textContent = '正在通过代理连接...';
      await connectWithTimeout(client, 20000);
      $('login-status').textContent = '正在发送验证码...';
      // 给 sendCode 加超时
      const sendCodeTimeout = new Promise((_, reject) => {
        setTimeout(() => reject(new Error('发送验证码超时，请重试')), 20000);
      });
      const r = await Promise.race([
        client.sendCode({ apiId: API_ID, apiHash: API_HASH }, phone),
        sendCodeTimeout
      ]);
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
      // 重置 client 以便重试
      try { if (client) { await client.disconnect(); } } catch(_) {}
      client = null;
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

// ===== 进入主界面 =====
function enterApp() {
  hideSplash();
  $('login-view').style.display = 'none';
  $('app-view').classList.add('active');
  updateUserInfo();
  loadBackground();
  loadChatList();
  updateDriveBanner();

  // 如果设置了网盘频道，自动打开
  if (driveChannelId) {
    setTimeout(() => openDriveChannel(), 300);
  }
}

function updateUserInfo() {
  const name = (me.firstName || '') + (me.lastName ? ' ' + me.lastName : '') || '用户';
  const initial = name.charAt(0).toUpperCase();
  const phone = '+' + (me.phone || '');

  // 侧边栏头像
  const ua = $('user-avatar');
  ua.innerHTML = initial;
  ua.style.background = COLORS[0];

  // 设置面板
  $('settings-name').textContent = name;
  $('settings-phone').textContent = phone;
  $('settings-avatar').textContent = initial;
  $('settings-avatar').style.background = COLORS[0];

  // 加载头像
  loadMyAvatar();
}

async function loadMyAvatar() {
  try {
    const photos = await client.getProfilePhotos(me);
    if (photos.length > 0) {
      const buf = await client.downloadMedia(photos[0], { thumb: 0 });
      if (buf && buf.length > 0) {
        const url = URL.createObjectURL(new Blob([buf], { type: 'image/jpeg' }));
        $('user-avatar').innerHTML = `<img src="${url}" alt="" />`;
        $('settings-avatar').innerHTML = `<img src="${url}" alt="" />`;
      }
    }
  } catch (e) {}
}

// ===== 模式切换 =====
document.querySelectorAll('.mode-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    const mode = tab.dataset.mode;
    if (mode === currentMode) return;
    currentMode = mode;
    document.querySelectorAll('.mode-tab').forEach(t => t.classList.toggle('active', t === tab));
    if (currentEntity) {
      renderCurrent();
    }
  });
});

// ===== 聊天列表 =====
async function loadChatList() {
  $('chat-list').innerHTML = '<div class="loading-spinner"></div>';
  try {
    const dialogs = await client.getDialogs({ limit: 100 });
    allChats = [];
    $('chat-list').innerHTML = '';
    for (let i = 0; i < dialogs.length; i++) {
      const d = dialogs[i];
      const entity = d.entity;
      const name = entity.title || entity.firstName || entity.username || 'Unknown';
      const preview = d.message?.text || d.message?.message || '';
      const color = COLORS[i % COLORS.length];
      const chat = {
        dialog: d, entity, name, preview, color,
        id: entity.id?.toString() || '',
        isChannel: entity.className === 'Channel',
      };
      allChats.push(chat);
      renderChatItem(chat, i);
    }
    // 异步加载头像
    for (const chat of allChats) {
      loadChatAvatar(chat);
    }
  } catch (e) {
    $('chat-list').innerHTML = `<div style="padding:20px;color:#e17076;">错误: ${escapeHtml(e.message)}</div>`;
  }
}

function renderChatItem(chat, idx) {
  const item = document.createElement('div');
  item.className = 'chat-item';
  item.dataset.idx = idx;
  item.dataset.id = chat.id;
  item.innerHTML = `
    <div class="avatar" style="background:${chat.color}">${escapeHtml(chat.name.charAt(0).toUpperCase())}</div>
    <div class="chat-info">
      <div class="chat-name">${escapeHtml(chat.name)}</div>
      <div class="chat-preview">${escapeHtml(chat.preview.slice(0, 40))}</div>
    </div>
    ${chat.id === driveChannelId ? '<svg class="pin-icon" width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M16 12V4h1V2H7v2h1v8l-2 2v2h5.2v6h1.6v-6H18v-2l-2-2z"/></svg>' : ''}
  `;
  item.addEventListener('click', () => openChat(chat, item));
  $('chat-list').appendChild(item);
}

async function loadChatAvatar(chat) {
  try {
    const photos = await client.getProfilePhotos(chat.entity);
    if (photos.length > 0) {
      const buf = await client.downloadMedia(photos[0], { thumb: 0 });
      if (buf && buf.length > 0) {
        const url = URL.createObjectURL(new Blob([buf], { type: 'image/jpeg' }));
        const item = document.querySelector(`.chat-item[data-id="${chat.id}"] .avatar`);
        if (item) item.innerHTML = `<img src="${url}" alt="" />`;
      }
    }
  } catch (e) {}
}

// 搜索
$('search-input').addEventListener('input', (e) => {
  const q = e.target.value.toLowerCase();
  document.querySelectorAll('.chat-item').forEach(item => {
    const name = item.querySelector('.chat-name')?.textContent.toLowerCase() || '';
    item.style.display = name.includes(q) ? '' : 'none';
  });
});

// ===== 打开聊天/频道 =====
async function openChat(chat, itemEl) {
  currentEntity = chat.entity;

  // UI
  document.querySelectorAll('.chat-item').forEach(i => i.classList.remove('active'));
  if (itemEl) itemEl.classList.add('active');

  $('main-area').classList.remove('empty');
  $('main-area').querySelector('.empty-state')?.remove();
  $('topbar').classList.remove('hidden');
  $('topbar-name').textContent = chat.name;
  $('topbar-sub').textContent = chat.isChannel ? '频道' : '对话';
  $('topbar-avatar').textContent = chat.name.charAt(0).toUpperCase();
  $('topbar-avatar').style.background = chat.color;

  // 加载头像
  (async () => {
    try {
      const photos = await client.getProfilePhotos(chat.entity);
      if (photos.length > 0) {
        const buf = await client.downloadMedia(photos[0], { thumb: 0 });
        if (buf && buf.length > 0) {
          const url = URL.createObjectURL(new Blob([buf], { type: 'image/jpeg' }));
          $('topbar-avatar').innerHTML = `<img src="${url}" alt="" />`;
        }
      }
    } catch (e) {}
  })();

  // 移动端
  if (window.innerWidth <= 768) {
    $('sidebar').classList.add('hidden-mobile');
    $('main-area').classList.add('active-mobile');
  }

  renderCurrent();
}

function renderCurrent() {
  $('files-grid').classList.add('hidden');
  $('messages-wrap').classList.add('hidden');
  $('input-bar').classList.add('hidden');

  if (currentMode === 'drive') {
    $('files-grid').classList.remove('hidden');
    loadFilesGrid();
  } else {
    $('messages-wrap').classList.remove('hidden');
    $('input-bar').classList.remove('hidden');
    loadChatMessages();
  }
}

// ===== 网盘：文件网格 =====
async function loadFilesGrid() {
  if (!currentEntity) return;
  const cid = currentEntity.id?.toString();

  // 如果有缓存，直接渲染
  if (filesCache[cid] && filesCache[cid].length > 0) {
    renderFilesGrid(filesCache[cid]);
    return;
  }

  $('files-grid').innerHTML = '<div style="grid-column:1/-1;text-align:center;padding:40px;"><div class="loading-spinner"></div></div>';

  try {
    const messages = await client.getMessages(currentEntity, { limit: LOAD_LIMIT });
    const files = [];
    for (const msg of messages) {
      const fi = parseFileInfo(msg);
      if (fi) files.push(fi);
    }
    filesCache[cid] = files;
    renderFilesGrid(files);
  } catch (e) {
    $('files-grid').innerHTML = `<div style="grid-column:1/-1;text-align:center;padding:40px;color:#e17076;">加载失败: ${escapeHtml(e.message)}</div>`;
    console.error('loadFilesGrid error:', e);
  }
}

function renderFilesGrid(files) {
  const grid = $('files-grid');
  grid.innerHTML = '';
  if (files.length === 0) {
    grid.innerHTML = `<div style="grid-column:1/-1;text-align:center;padding:60px;color:#708499;">
      <div style="font-size:48px;margin-bottom:12px;opacity:0.3;">📭</div>
      此频道没有文件
    </div>`;
    return;
  }

  for (const fi of files) {
    const card = document.createElement('div');
    card.className = 'file-card';
    const icon = fi.type === 'photo' ? '🖼️'
      : fi.type === 'video' ? '🎬'
      : fi.type === 'audio' ? '🎵'
      : fi.type === 'doc' ? '📄' : '📦';

    const hasPreview = fi.type === 'photo' || fi.type === 'video';
    const isVideo = fi.type === 'video';

    card.innerHTML = `
      <div class="file-thumb" data-id="${fi.id}">
        ${hasPreview ? `<div class="placeholder">${icon}</div>` : `<div class="placeholder">${icon}</div>`}
        ${isVideo ? `<div class="play-overlay"><div class="play-btn"><svg viewBox="0 0 24 24"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg></div></div>` : ''}
      </div>
      <div class="file-info">
        <div class="file-name">${escapeHtml(fi.name)}</div>
        <div class="file-meta"><span>${fi.sizeText}</span></div>
      </div>
    `;

    // 图片：点击预览
    if (fi.type === 'photo') {
      card.querySelector('.file-thumb').addEventListener('click', () => previewImage(fi));
    }
    // 视频：点击播放
    else if (fi.type === 'video') {
      card.querySelector('.file-thumb').addEventListener('click', () => playVideo(fi));
    }
    // 其他：点击下载
    else {
      card.addEventListener('click', () => downloadFile(fi));
    }

    grid.appendChild(card);

    // 异步加载缩略图
    if (hasPreview) {
      loadThumbAsync(fi);
    }
  }
}

// 异步加载缩略图（不阻塞渲染）
async function loadThumbAsync(fi) {
  try {
    const buf = await client.downloadMedia(fi.msg, { thumb: 1 });
    if (buf && buf.length > 0) {
      const url = URL.createObjectURL(new Blob([buf], { type: 'image/jpeg' }));
      const thumbEl = document.querySelector(`.file-thumb[data-id="${fi.id}"]`);
      if (thumbEl) {
        thumbEl.innerHTML = `
          <img src="${url}" alt="" loading="lazy" />
          ${fi.type === 'video' ? `<div class="play-overlay"><div class="play-btn"><svg viewBox="0 0 24 24"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg></div></div>` : ''}
        `;
        // 重新绑定事件
        if (fi.type === 'photo') {
          thumbEl.addEventListener('click', () => previewImage(fi));
        } else if (fi.type === 'video') {
          thumbEl.addEventListener('click', () => playVideo(fi));
        }
      }
    }
  } catch (e) {}
}

// ===== 图片预览 =====
function previewImage(fi) {
  // 先显示缩略图，再加载原图
  client.downloadMedia(fi.msg).then(buf => {
    if (buf && buf.length > 0) {
      const url = URL.createObjectURL(new Blob([buf], { type: fi.mime || 'image/jpeg' }));
      $('preview-img').src = url;
    }
  }).catch(e => console.error('preview error:', e));

  $('preview-overlay').classList.remove('hidden');
}

$('preview-close').addEventListener('click', () => {
  $('preview-overlay').classList.add('hidden');
  setTimeout(() => { $('preview-img').src = ''; }, 300);
});
$('preview-overlay').addEventListener('click', (e) => {
  if (e.target === $('preview-overlay')) {
    $('preview-overlay').classList.add('hidden');
    setTimeout(() => { $('preview-img').src = ''; }, 300);
  }
});

// ===== 视频播放（浮窗） =====
let currentVideoFile = null;

function playVideo(fi) {
  currentVideoFile = fi;
  $('vp-title').textContent = fi.name;
  $('video-player').classList.remove('hidden');
  const video = $('vp-video');
  video.src = '';
  video.innerHTML = '';

  // 先显示 loading
  video.poster = '';

  // 懒加载：点击才下载
  client.downloadMedia(fi.msg).then(buf => {
    if (buf && buf.length > 0) {
      const url = URL.createObjectURL(new Blob([buf], { type: fi.mime || 'video/mp4' }));
      video.src = url;
      video.play().catch(() => {});
    }
  }).catch(e => {
    console.error('video error:', e);
    alert('视频加载失败: ' + e.message);
  });
}

$('vp-close').addEventListener('click', () => {
  const video = $('vp-video');
  video.pause();
  video.src = '';
  $('video-player').classList.add('hidden');
  currentVideoFile = null;
});

// ===== 聊天模式：消息列表 =====
async function loadChatMessages() {
  if (!currentEntity) return;
  $('messages').innerHTML = '<div class="loading-spinner"></div>';
  try {
    const messages = await client.getMessages(currentEntity, { limit: 50 });
    $('messages').innerHTML = '';
    let lastDate = '';
    for (const msg of messages.reverse()) {
      if (msg.className === 'MessageEmpty') continue;
      const date = formatDate(msg.date);
      if (date !== lastDate) {
        lastDate = date;
        const sep = document.createElement('div');
        sep.className = 'date-sep';
        sep.innerHTML = `<span>${date}</span>`;
        $('messages').appendChild(sep);
      }
      renderChatMessage(msg);
    }
    $('messages').scrollTop = $('messages').scrollHeight;
  } catch (e) {
    $('messages').innerHTML = `<div style="padding:20px;color:#e17076;">加载失败: ${escapeHtml(e.message)}</div>`;
  }
}

function renderChatMessage(msg) {
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

  const time = formatTime(msg.date);
  div.innerHTML = `<div class="msg-bubble">${mediaHtml}${textHtml}<div class="msg-time">${time}</div></div>`;
  $('messages').appendChild(div);
}

function renderMsgMedia(msg) {
  const doc = msg.document || msg.media?.document;
  const photo = msg.photo || msg.media?.photo;

  if (photo) {
    const id = `msg-photo-${msg.id}`;
    (async () => {
      try {
        const buf = await client.downloadMedia(msg, { thumb: 1 });
        if (buf) {
          const url = URL.createObjectURL(new Blob([buf], { type: 'image/jpeg' }));
          const el = $(id);
          if (el) {
            el.src = url;
            el.addEventListener('click', () => {
              client.downloadMedia(msg).then(fullBuf => {
                if (fullBuf) {
                  const fullUrl = URL.createObjectURL(new Blob([fullBuf], { type: 'image/jpeg' }));
                  $('preview-img').src = fullUrl;
                  $('preview-overlay').classList.remove('hidden');
                }
              });
            });
          }
        }
      } catch (e) {}
    })();
    return `<div class="msg-media"><img id="${id}" src="" alt="加载中..." style="min-height:80px;"/></div>`;
  }

  if (doc) {
    const mime = doc.mimeType || '';
    const attrs = doc.attributes || [];
    const fa = attrs.find(a => a.fileName);
    const fileName = fa?.fileName || `file_${msg.id}`;
    const size = formatSize(doc.size || 0);

    if (mime.startsWith('video/')) {
      const vid = `msg-vid-${msg.id}`;
      (async () => {
        try {
          const buf = await client.downloadMedia(msg, { thumb: 0 });
          if (buf) {
            const url = URL.createObjectURL(new Blob([buf], { type: 'image/jpeg' }));
            const container = $(vid);
            if (container) {
              container.innerHTML = `<div style="position:relative;cursor:pointer;">
                <img src="${url}" style="width:100%;border-radius:8px;"/>
                <div style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;">
                  <div style="width:44px;height:44px;border-radius:50%;background:rgba(0,0,0,0.7);display:flex;align-items:center;justify-content:center;">
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="#fff"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg>
                  </div>
                </div>
              </div>`;
              container.querySelector('div').addEventListener('click', () => {
                playVideo({ msg, name: fileName, mime });
              });
            }
          }
        } catch (e) {}
      })();
      return `<div class="msg-media" id="${vid}"><div style="width:240px;height:135px;background:#000;border-radius:8px;display:flex;align-items:center;justify-content:center;">🎬</div></div>`;
    }

    if (mime.startsWith('audio/')) {
      const aid = `msg-aud-${msg.id}`;
      (async () => {
        try {
          const buf = await client.downloadMedia(msg);
          if (buf) {
            const url = URL.createObjectURL(new Blob([buf], { type: mime }));
            const el = $(aid);
            if (el) el.innerHTML = `<audio src="${url}" controls style="width:100%;"></audio>`;
          }
        } catch (e) {}
      })();
      return `<div class="msg-media" id="${aid}"><div style="padding:8px;">🎵 加载中...</div></div>`;
    }

    const icon = mime === 'application/pdf' ? '📄' : mime.includes('zip') ? '🗜️' : '📦';
    return `<div class="msg-media"><div class="file-row">
      <div class="file-icon">${icon}</div>
      <div class="file-text"><div class="n">${escapeHtml(fileName)}</div><div class="s">${size}</div></div>
    </div></div>`;
  }

  return '';
}

// ===== 发送消息 =====
$('send-btn').addEventListener('click', () => sendMessage());
$('msg-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
});
$('msg-input').addEventListener('input', () => {
  $('msg-input').style.height = 'auto';
  $('msg-input').style.height = Math.min($('msg-input').scrollHeight, 120) + 'px';
});

async function sendMessage() {
  const text = $('msg-input').value.trim();
  if (!text || !currentEntity) return;
  $('msg-input').value = '';
  $('msg-input').style.height = 'auto';
  $('send-btn').disabled = true;
  try {
    await client.sendMessage(currentEntity, { message: text });
    loadChatMessages();
  } catch (e) {
    alert('发送失败: ' + (e.message || e));
  }
  $('send-btn').disabled = false;
}

// 发送文件
$('attach-btn').addEventListener('click', () => $('file-input').click());
$('file-input').addEventListener('change', async () => {
  const files = $('file-input').files;
  if (!files.length || !currentEntity) return;
  for (const file of files) {
    try {
      await client.sendFile(currentEntity, { file });
    } catch (e) {
      alert('发送失败: ' + (e.message || e));
    }
  }
  $('file-input').value = '';
  loadChatMessages();
  // 清除缓存
  const cid = currentEntity.id?.toString();
  delete filesCache[cid];
});

// ===== 网盘频道功能 =====
function updateDriveBanner() {
  if (driveChannelId) {
    const chat = allChats.find(c => c.id === driveChannelId);
    if (chat) {
      $('drive-subtitle').textContent = chat.name;
    } else {
      $('drive-subtitle').textContent = '已设置';
    }
  } else {
    $('drive-subtitle').textContent = '点击设置网盘频道';
  }
  $('drive-channel-value').textContent = driveChannelId
    ? (allChats.find(c => c.id === driveChannelId)?.name || '已设置')
    : '未设置';
}

$('pin-btn').addEventListener('click', () => {
  if (!currentEntity) return;
  const id = currentEntity.id?.toString();
  if (driveChannelId === id) {
    driveChannelId = null;
    localStorage.removeItem('drive_channel');
  } else {
    driveChannelId = id;
    localStorage.setItem('drive_channel', id);
  }
  updateDriveBanner();
  // 刷新列表标记
  document.querySelectorAll('.chat-item .pin-icon').forEach(e => e.remove());
  if (driveChannelId) {
    const item = document.querySelector(`.chat-item[data-id="${driveChannelId}"]`);
    if (item) {
      const info = item.querySelector('.chat-info');
      if (info) {
        info.insertAdjacentHTML('afterend',
          '<svg class="pin-icon" width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M16 12V4h1V2H7v2h1v8l-2 2v2h5.2v6h1.6v-6H18v-2l-2-2z"/></svg>');
      }
    }
  }
});

$('drive-banner').addEventListener('click', () => {
  if (driveChannelId) {
    const chat = allChats.find(c => c.id === driveChannelId);
    if (chat) {
      const item = document.querySelector(`.chat-item[data-id="${driveChannelId}"]`);
      openChat(chat, item);
    }
  } else {
    // 提示选择频道
    alert('请先从左侧列表选择一个频道，然后点击右上角的星标按钮设为网盘');
  }
});

$('clear-drive-btn').addEventListener('click', () => {
  driveChannelId = null;
  localStorage.removeItem('drive_channel');
  updateDriveBanner();
  document.querySelectorAll('.chat-item .pin-icon').forEach(e => e.remove());
});

async function openDriveChannel() {
  const chat = allChats.find(c => c.id === driveChannelId);
  if (chat) {
    const item = document.querySelector(`.chat-item[data-id="${driveChannelId}"]`);
    openChat(chat, item);
  }
}

// ===== 设置面板 =====
$('user-avatar').addEventListener('click', () => $('settings-panel').classList.add('open'));
$('settings-close').addEventListener('click', () => $('settings-panel').classList.remove('open'));

// 背景设置
document.querySelectorAll('.bg-option').forEach(opt => {
  opt.addEventListener('click', () => {
    document.querySelectorAll('.bg-option').forEach(o => o.classList.remove('active'));
    opt.classList.add('active');
    const bg = opt.dataset.bg;
    if (bg === 'default') {
      $('messages-bg').style.background = 'linear-gradient(135deg, #0e1621, #1a2a3a)';
      $('messages-bg').style.backgroundImage = '';
    } else if (bg === 'tg') {
      $('messages-bg').style.background = 'linear-gradient(135deg, #2b5278, #0e1621)';
      $('messages-bg').style.backgroundImage = '';
    } else if (bg === 'dark') {
      $('messages-bg').style.background = '#0e1621';
      $('messages-bg').style.backgroundImage = '';
    }
    localStorage.setItem('tg_bg', bg);
  });
});

$('bg-opacity').addEventListener('input', (e) => {
  $('messages-bg').style.opacity = (e.target.value / 100);
  localStorage.setItem('tg_bg_opacity', e.target.value);
});

$('bg-file-input').addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (ev) => {
    const dataUrl = ev.target.result;
    localStorage.setItem('tg_bg', 'custom');
    localStorage.setItem('tg_bg_custom', dataUrl);
    $('messages-bg').style.backgroundImage = `url(${dataUrl})`;
    $('messages-bg').style.backgroundSize = 'cover';
    document.querySelectorAll('.bg-option').forEach(o => o.classList.remove('active'));
  };
  reader.readAsDataURL(file);
});

function loadBackground() {
  const bg = localStorage.getItem('tg_bg');
  const opacity = localStorage.getItem('tg_bg_opacity') || '8';
  $('bg-opacity').value = parseInt(opacity);
  $('messages-bg').style.opacity = (parseInt(opacity) / 100);

  if (bg === 'tg') {
    $('messages-bg').style.background = 'linear-gradient(135deg, #2b5278, #0e1621)';
    document.querySelector('.bg-option[data-bg="tg"]')?.classList.add('active');
    document.querySelector('.bg-option[data-bg="default"]')?.classList.remove('active');
  } else if (bg === 'dark') {
    $('messages-bg').style.background = '#0e1621';
    document.querySelector('.bg-option[data-bg="dark"]')?.classList.add('active');
    document.querySelector('.bg-option[data-bg="default"]')?.classList.remove('active');
  } else if (bg === 'custom') {
    const custom = localStorage.getItem('tg_bg_custom');
    if (custom) {
      $('messages-bg').style.backgroundImage = `url(${custom})`;
      $('messages-bg').style.backgroundSize = 'cover';
    }
  }
}

// 退出登录
$('logout-btn').addEventListener('click', () => {
  if (!confirm('确定退出登录？')) return;
  localStorage.removeItem('tg_session');
  location.reload();
});

// 返回
$('back-btn').addEventListener('click', () => {
  $('sidebar').classList.remove('hidden-mobile');
  $('main-area').classList.remove('active-mobile');
});

// ===== 文件信息解析 =====
function parseFileInfo(msg) {
  const media = msg.media;
  if (!media) return null;

  let doc = null;
  let photo = null;

  if (msg.document) doc = msg.document;
  else if (media.document) doc = media.document;
  else if (media.webpage?.document) doc = media.webpage.document;

  if (msg.photo) photo = msg.photo;
  else if (media.photo) photo = media.photo;
  else if (media.webpage?.photo) photo = media.webpage.photo;

  if (!doc && !photo) return null;

  let name = '', size = 0, type = 'default', mime = '';

  if (photo) {
    name = `photo_${msg.id}.jpg`;
    type = 'photo'; mime = 'image/jpeg';
  } else if (doc) {
    const attrs = doc.attributes || [];
    const fa = attrs.find(a => a.fileName || a.classType === 'DocumentAttributeFilename');
    name = fa?.fileName || `file_${msg.id}`;
    size = doc.size || 0;
    mime = doc.mimeType || '';
    if (mime.startsWith('image/')) type = 'photo';
    else if (mime.startsWith('video/')) type = 'video';
    else if (mime.startsWith('audio/')) type = 'audio';
    else type = 'doc';
  }

  return { id: `f-${msg.id}`, msg, name, size, type, mime, sizeText: formatSize(size) };
}

// ===== 下载 =====
async function downloadFile(fi) {
  try {
    const buf = await client.downloadMedia(fi.msg);
    if (!buf) return;
    const blob = new Blob([buf], { type: fi.mime || 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = fi.name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (e) {
    alert('下载失败: ' + (e.message || e));
  }
}

// ===== 工具 =====
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
boot();
