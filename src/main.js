import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions';

// ===== 配置 =====
const API_ID = parseInt(import.meta.env.VITE_API_ID || '0');
const API_HASH = import.meta.env.VITE_API_HASH || '';
const PROXY_DOMAIN = import.meta.env.VITE_PROXY_DOMAIN || '';

// ===== Monkey-patch WebSocket 和 fetch =====
if (PROXY_DOMAIN) {
  const OrigWS = self.WebSocket;
  self.WebSocket = function (url, protocols) {
    if (typeof url === 'string' && url.includes('telegram.org')) {
      try {
        const u = new URL(url);
        url = `wss://${PROXY_DOMAIN}/${u.hostname}${u.pathname}`;
        console.log('[Proxy] WS ->', url);
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
    let urlStr = typeof input === 'string' ? input : (input && input.url ? input.url : '');
    if (urlStr.includes('telegram.org')) {
      try {
        const u = new URL(urlStr);
        const newUrl = `https://${PROXY_DOMAIN}/${u.hostname}${u.pathname}${u.search}`;
        if (typeof input === 'string') {
          input = newUrl;
        } else {
          input = new Request(newUrl, input);
        }
      } catch (e) {}
    }
    return origFetch.call(self, input, init);
  };
}

// ===== 全局状态 =====
let client = null;
let phoneCodeHash = '';
let currentChat = null;
let allFiles = [];
let currentFilter = 'all';
let offsetId = 0;
let isLoadingMore = false;
let allChats = [];

const AVATAR_COLORS = ['#6ab3f3', '#51cf66', '#ff6b6b', '#fcc419', '#cc5de8', '#ff922b', '#22b8cf', '#845ef7'];

// ===== 初始化 =====
async function initClient() {
  const sessionData = localStorage.getItem('tg_session') || '';
  const session = new StringSession(sessionData);
  client = new TelegramClient(session, API_ID, API_HASH, {
    connectionRetries: 5, retryDelay: 2000, autoReconnect: true,
  });
  await client.connect();
  try {
    await client.getMe();
    localStorage.setItem('tg_session', session.save());
    showChats();
    return true;
  } catch { return false; }
}

// ===== 登录流程 =====
document.getElementById('send-code-btn').addEventListener('click', async () => {
  const phone = document.getElementById('phone').value.trim();
  if (!phone) return;
  const btn = document.getElementById('send-code-btn');
  const status = document.getElementById('login-status');
  btn.disabled = true; btn.textContent = '发送中...';
  status.className = 'status'; status.textContent = '正在连接 Telegram...';
  try {
    if (!client) await initClient();
    const result = await client.sendCode({ apiId: API_ID, apiHash: API_HASH }, phone);
    phoneCodeHash = result.phoneCodeHash;
    document.getElementById('code-row').classList.remove('hidden');
    btn.textContent = '重新发送'; btn.disabled = false;
    status.className = 'status success';
    status.textContent = '验证码已发送到你的 Telegram 客户端';
  } catch (e) {
    status.className = 'status error';
    status.textContent = '错误: ' + (e.message || e);
    btn.disabled = false; btn.textContent = '发送验证码';
  }
});

document.getElementById('sign-in-btn').addEventListener('click', async () => {
  const code = document.getElementById('code').value.trim();
  const phone = document.getElementById('phone').value.trim();
  const status = document.getElementById('login-status');
  if (!code) return;
  try {
    const { Api } = await import('telegram/tl/api');
    await client.invoke(new Api.auth.SignIn({
      phoneNumber: phone, phoneCodeHash, phoneCode: code,
    }));
    localStorage.setItem('tg_session', client.session.save());
    status.className = 'status success'; status.textContent = '登录成功！';
    showChats();
  } catch (e) {
    if (e.message?.includes('SESSION_PASSWORD_NEEDED')) {
      document.getElementById('password-row').classList.remove('hidden');
      status.className = 'status'; status.textContent = '需要两步验证密码';
    } else {
      status.className = 'status error';
      status.textContent = '错误: ' + (e.message || e);
    }
  }
});

document.getElementById('password-btn').addEventListener('click', async () => {
  const password = document.getElementById('password').value;
  const status = document.getElementById('login-status');
  try {
    await client.signInWithPassword({ password });
    localStorage.setItem('tg_session', client.session.save());
    status.className = 'status success'; status.textContent = '登录成功！';
    showChats();
  } catch (e) {
    status.className = 'status error';
    status.textContent = '错误: ' + (e.message || e);
  }
});

// ===== 聊天列表 =====
async function showChats() {
  document.getElementById('login-page').classList.add('hidden');
  document.getElementById('file-list-page').classList.add('hidden');
  document.getElementById('chat-list-page').classList.remove('hidden');
  document.getElementById('chat-list').innerHTML = '';
  document.getElementById('chat-status').textContent = '加载中...';
  allChats = [];
  try {
    const dialogs = await client.getDialogs({ limit: 100 });
    const list = document.getElementById('chat-list');
    let count = 0;
    for (const dialog of dialogs) {
      const entity = dialog.entity;
      const name = entity.title || entity.firstName || entity.username || 'Unknown';
      const sub = dialog.message?.text || dialog.message?.message || '';
      const initial = name.charAt(0).toUpperCase();
      const color = AVATAR_COLORS[count % AVATAR_COLORS.length];
      const chatData = { dialog, entity, name, sub, initial, color };
      allChats.push(chatData);
      count++;
    }
    renderChatList(allChats);
    document.getElementById('chat-status').textContent = count > 0 ? `共 ${count} 个对话` : '没有对话';
    // 异步加载头像
    loadChatPhotos(allChats);
  } catch (e) {
    document.getElementById('chat-status').className = 'status error';
    document.getElementById('chat-status').textContent = '错误: ' + (e.message || e);
  }
}

function renderChatList(chats) {
  const list = document.getElementById('chat-list');
  list.innerHTML = '';
  for (const chat of chats) {
    const item = document.createElement('div');
    item.className = 'chat-item';
    item.dataset.name = chat.name.toLowerCase();
    item.innerHTML = `
      <div class="avatar" style="background:${chat.color}">${escapeHtml(chat.initial)}</div>
      <div>
        <div class="chat-name">${escapeHtml(chat.name)}</div>
        <div class="chat-sub">${escapeHtml(chat.sub.slice(0, 50))}</div>
      </div>
    `;
    item.onclick = () => showFiles(chat.dialog);
    list.appendChild(item);
  }
}

// 搜索
document.getElementById('chat-search').addEventListener('input', (e) => {
  const q = e.target.value.toLowerCase();
  const items = document.querySelectorAll('.chat-item');
  items.forEach(item => {
    const name = item.dataset.name || '';
    item.style.display = name.includes(q) ? '' : 'none';
  });
});

// 异步加载聊天头像
async function loadChatPhotos(chats) {
  for (const chat of chats) {
    try {
      const buffer = await client.downloadProfilePhoto(chat.entity, { isBig: false });
      if (buffer && buffer.length > 0) {
        const blob = new Blob([buffer], { type: 'image/jpeg' });
        const url = URL.createObjectURL(blob);
        const item = document.querySelector(`.chat-item[data-name="${chat.name.toLowerCase()}"]`);
        if (item) {
          const avatar = item.querySelector('.avatar');
          avatar.innerHTML = `<img src="${url}" alt="" />`;
        }
      }
    } catch (e) {}
  }
}

// ===== 文件列表 =====
async function showFiles(dialog) {
  currentChat = dialog;
  const entity = dialog.entity;
  const name = entity.title || entity.firstName || entity.username || 'Unknown';
  document.getElementById('chat-list-page').classList.add('hidden');
  document.getElementById('file-list-page').classList.remove('hidden');
  document.getElementById('chat-title').textContent = name;

  // 设置聊天头像
  const avatarEl = document.getElementById('chat-avatar');
  avatarEl.innerHTML = name.charAt(0).toUpperCase();
  avatarEl.style.background = AVATAR_COLORS[0];
  try {
    const buffer = await client.downloadProfilePhoto(entity, { isBig: false });
    if (buffer && buffer.length > 0) {
      const blob = new Blob([buffer], { type: 'image/jpeg' });
      const url = URL.createObjectURL(blob);
      avatarEl.innerHTML = `<img src="${url}" alt="" />`;
    }
  } catch (e) {}

  document.getElementById('file-list').innerHTML = '';
  document.getElementById('file-status').textContent = '加载文件中...';
  document.getElementById('load-more').classList.add('hidden');
  allFiles = []; offsetId = 0; currentFilter = 'all';
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.filter === 'all'));
  await loadFiles(entity);
}

async function loadFiles(entity) {
  if (isLoadingMore) return;
  isLoadingMore = true;
  try {
    const messages = await client.getMessages(entity, {
      limit: 50, offsetId: offsetId,
    });
    if (messages.length === 0) {
      document.getElementById('load-more').classList.add('hidden');
      if (allFiles.length === 0) {
        document.getElementById('file-status').innerHTML =
          '<div class="empty-state"><div class="icon">📭</div>此频道没有文件</div>';
      }
      return;
    }
    for (const msg of messages) {
      console.log('msg', msg.id, 'media:', msg.media?.className || 'none');
      const fi = parseFileInfo(msg);
      if (fi) {
        allFiles.push(fi);
        console.log('  -> file:', fi.name, fi.type);
      }
      offsetId = msg.id;
    }
    renderFiles();
    if (messages.length < 50) {
      document.getElementById('load-more').classList.add('hidden');
    } else {
      document.getElementById('load-more').classList.remove('hidden');
    }
    if (allFiles.length === 0) {
      document.getElementById('file-status').innerHTML =
        '<div class="empty-state"><div class="icon">📭</div>此频道没有文件</div>';
    } else {
      document.getElementById('file-status').textContent = `共 ${allFiles.length} 个文件`;
    }
  } catch (e) {
    document.getElementById('file-status').className = 'status error';
    document.getElementById('file-status').textContent = '错误: ' + (e.message || e);
    console.error('loadFiles error:', e);
  } finally {
    isLoadingMore = false;
  }
}

// 文件分类标签
document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    currentFilter = tab.dataset.filter;
    document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t === tab));
    renderFiles();
  });
});

// 加载更多
document.getElementById('load-more-btn').addEventListener('click', () => {
  if (currentChat) loadFiles(currentChat.entity);
});

// 返回
document.getElementById('back-btn').addEventListener('click', () => {
  document.getElementById('file-list-page').classList.add('hidden');
  document.getElementById('chat-list-page').classList.remove('hidden');
});

// ===== 文件信息解析（恢复原始逻辑） =====
function parseFileInfo(msg) {
  // 检查是否有媒体
  const media = msg.media;
  if (!media) return null;

  let doc = null;
  let photo = null;

  // 尝试多种方式获取 document
  if (msg.document) {
    doc = msg.document;
  } else if (media.document) {
    doc = media.document;
  } else if (media.webpage && media.webpage.document) {
    doc = media.webpage.document;
  }

  // 尝试多种方式获取 photo
  if (msg.photo) {
    photo = msg.photo;
  } else if (media.photo) {
    photo = media.photo;
  } else if (media.webpage && media.webpage.photo) {
    photo = media.webpage.photo;
  }

  if (!doc && !photo) return null;

  let name = '', size = 0, type = 'default', mime = '';

  if (photo) {
    name = `photo_${msg.id}.jpg`;
    type = 'photo'; mime = 'image/jpeg';
  } else if (doc) {
    const attrs = doc.attributes || [];
    const fileNameAttr = attrs.find(a => a.fileName || a.classType === 'DocumentAttributeFilename');
    name = fileNameAttr?.fileName || `file_${msg.id}`;
    size = doc.size || 0;
    mime = doc.mimeType || '';
    if (mime.startsWith('image/')) type = 'photo';
    else if (mime.startsWith('video/')) type = 'video';
    else if (mime.startsWith('audio/')) type = 'audio';
    else if (mime === 'application/pdf') type = 'doc';
    else if (mime.includes('zip') || mime.includes('rar') || mime.includes('7z') || mime.includes('tar')) type = 'doc';
    else type = 'doc';
  }

  return { msg, name, size, type, mime, sizeText: formatSize(size) };
}

// ===== 渲染文件列表 =====
function renderFiles() {
  const list = document.getElementById('file-list');
  list.innerHTML = '';
  const filtered = currentFilter === 'all'
    ? allFiles
    : allFiles.filter(f => f.type === currentFilter);

  for (const fi of filtered) {
    const card = document.createElement('div');
    card.className = 'file-card';
    const showPreview = ['photo', 'video', 'audio'].includes(fi.type);
    const icon = fi.type === 'photo' ? '🖼️'
      : fi.type === 'video' ? '🎬'
      : fi.type === 'audio' ? '🎵'
      : fi.type === 'doc' ? '📄'
      : '📦';

    let thumbHtml = '';
    if (showPreview) {
      thumbHtml = `<div class="file-thumb${fi.type === 'video' ? ' video-badge' : ''}"><div class="placeholder">${icon}</div></div>`;
    } else {
      thumbHtml = `<div class="file-thumb"><div class="placeholder">${icon}</div></div>`;
    }

    card.innerHTML = `
      ${thumbHtml}
      <div class="file-info">
        <div class="file-name">${escapeHtml(fi.name)}</div>
        <div class="file-meta">
          <span class="file-size">${fi.sizeText}</span>
          ${showPreview ? '<button class="file-btn btn-pre">预览</button>' : ''}
          <button class="file-btn btn-dl">下载</button>
        </div>
      </div>
    `;

    const thumb = card.querySelector('.file-thumb');
    if (showPreview && thumb) {
      thumb.addEventListener('click', () => previewFile(fi));
    }
    const preBtn = card.querySelector('.btn-pre');
    if (preBtn) preBtn.addEventListener('click', () => previewFile(fi));
    card.querySelector('.btn-dl').addEventListener('click', () => downloadFile(fi));
    list.appendChild(card);
  }
}

// ===== 在线预览 =====
async function previewFile(fi) {
  const overlay = document.getElementById('preview-overlay');
  const content = document.getElementById('preview-content');
  overlay.classList.remove('hidden');
  content.innerHTML = '<div class="loading-spinner"></div>';
  try {
    const buffer = await client.downloadMedia(fi.msg);
    if (!buffer) { content.innerHTML = '<p style="color:#999">下载失败</p>'; return; }
    const blob = new Blob([buffer], { type: fi.mime || 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    if (fi.type === 'photo') {
      content.innerHTML = `<img src="${url}" alt="${escapeHtml(fi.name)}" />`;
    } else if (fi.type === 'video') {
      content.innerHTML = `<video src="${url}" controls autoplay style="background:#000"></video>`;
    } else if (fi.type === 'audio') {
      content.innerHTML = `<audio src="${url}" controls autoplay style="margin-top:20vh"></audio>`;
    }
  } catch (e) {
    content.innerHTML = `<p style="color:#ff6b6b">加载失败: ${escapeHtml(e.message || String(e))}</p>`;
    console.error('preview error:', e);
  }
}

// 关闭预览
document.getElementById('preview-overlay').addEventListener('click', (e) => {
  if (e.target.id !== 'preview-overlay' && !e.target.classList.contains('preview-close') && e.target.textContent !== '×') return;
  const content = document.getElementById('preview-content');
  const media = content.querySelector('img, video, audio');
  if (media && media.src) URL.revokeObjectURL(media.src);
  content.innerHTML = '';
  document.getElementById('preview-overlay').classList.add('hidden');
});

// ===== 下载 =====
async function downloadFile(fi) {
  try {
    const buffer = await client.downloadMedia(fi.msg);
    if (!buffer) return;
    const blob = new Blob([buffer], { type: fi.mime || 'application/octet-stream' });
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
  if (!bytes || bytes === 0) return '';
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
  if (bytes < 1073741824) return (bytes / 1048576).toFixed(1) + ' MB';
  return (bytes / 1073741824).toFixed(2) + ' GB';
}

function escapeHtml(s) {
  if (!s) return '';
  return String(s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

// ===== 启动 =====
if (!API_ID || !API_HASH) {
  document.getElementById('login-status').className = 'status error';
  document.getElementById('login-status').textContent = '请先设置环境变量';
} else {
  initClient().then((loggedIn) => {
    if (!loggedIn) {
      document.getElementById('login-status').textContent = '请输入手机号登录';
    }
  }).catch((e) => {
    document.getElementById('login-status').className = 'status error';
    document.getElementById('login-status').textContent = '连接失败: ' + (e.message || e);
  });
}
