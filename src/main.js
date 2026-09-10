import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions';

// ===== 配置（从环境变量读取，也可手动填写）=====
const API_ID = parseInt(import.meta.env.VITE_API_ID || '0');
const API_HASH = import.meta.env.VITE_API_HASH || '';
const PROXY_DOMAIN = import.meta.env.VITE_PROXY_DOMAIN || '';

// ===== Monkey-patch WebSocket 和 fetch，实现代理 =====
if (PROXY_DOMAIN) {
  const OrigWS = self.WebSocket;
  self.WebSocket = function (url, protocols) {
    if (typeof url === 'string' && url.includes('telegram.org')) {
      try {
        const u = new URL(url);
        const newUrl = `wss://${PROXY_DOMAIN}/${u.hostname}${u.pathname}`;
        console.log('[Proxy] WS:', url, '->', newUrl);
        url = newUrl;
      } catch (e) {
        console.error('[Proxy] WS rewrite error:', e);
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
    let urlStr = typeof input === 'string' ? input : (input && input.url ? input.url : '');
    if (urlStr.includes('telegram.org')) {
      try {
        const u = new URL(urlStr);
        const newUrl = `https://${PROXY_DOMAIN}/${u.hostname}${u.pathname}${u.search}`;
        console.log('[Proxy] HTTP:', urlStr, '->', newUrl);
        if (typeof input === 'string') {
          input = newUrl;
        } else {
          const newReq = new Request(newUrl, input);
          input = newReq;
        }
      } catch (e) {
        console.error('[Proxy] HTTP rewrite error:', e);
      }
    }
    return origFetch.call(self, input, init);
  };
}

// ===== 全局状态 =====
let client = null;
let phoneCodeHash = '';
let currentChat = null;

// ===== 初始化 Telegram 客户端 =====
async function initClient() {
  const sessionData = localStorage.getItem('tg_session') || '';
  const session = new StringSession(sessionData);

  client = new TelegramClient(session, API_ID, API_HASH, {
    connectionRetries: 5,
    retryDelay: 2000,
    autoReconnect: true,
  });

  await client.connect();

  // 检查是否已登录
  try {
    const me = await client.getMe();
    console.log('已登录:', me.firstName || me.username || me.id?.toString());
    localStorage.setItem('tg_session', session.save());
    showChats();
    return true;
  } catch {
    return false;
  }
}

// ===== 登录流程 =====
window.sendCode = async function () {
  const phone = document.getElementById('phone').value.trim();
  if (!phone) return;
  const btn = document.getElementById('send-code-btn');
  const status = document.getElementById('login-status');
  btn.disabled = true;
  btn.textContent = '发送中...';
  status.className = 'status';
  status.textContent = '正在连接 Telegram...';

  try {
    if (!client) {
      await initClient();
    }
    const result = await client.sendCode({
      apiId: API_ID,
      apiHash: API_HASH,
    }, phone);
    phoneCodeHash = result.phoneCodeHash;
    document.getElementById('code-row').classList.remove('hidden');
    btn.textContent = '重新发送';
    btn.disabled = false;
    status.className = 'status success';
    status.textContent = '验证码已发送到你的 Telegram 客户端';
  } catch (e) {
    status.className = 'status error';
    status.textContent = '错误: ' + (e.message || e);
    btn.disabled = false;
    btn.textContent = '发送验证码';
  }
};

window.signIn = async function () {
  const code = document.getElementById('code').value.trim();
  const phone = document.getElementById('phone').value.trim();
  const status = document.getElementById('login-status');
  if (!code) return;

  try {
    await client.invoke(
      new (await import('telegram/tl/api')).Api.auth.SignIn({
        phoneNumber: phone,
        phoneCodeHash,
        phoneCode: code,
      })
    );
    const session = client.session;
    localStorage.setItem('tg_session', session.save());
    status.className = 'status success';
    status.textContent = '登录成功！';
    showChats();
  } catch (e) {
    if (e.message && e.message.includes('SESSION_PASSWORD_NEEDED')) {
      document.getElementById('password-row').classList.remove('hidden');
      status.className = 'status';
      status.textContent = '需要两步验证密码';
    } else {
      status.className = 'status error';
      status.textContent = '错误: ' + (e.message || e);
    }
  }
};

window.signInWithPassword = async function () {
  const password = document.getElementById('password').value;
  const status = document.getElementById('login-status');
  try {
    await client.signInWithPassword({ password });
    const session = client.session;
    localStorage.setItem('tg_session', session.save());
    status.className = 'status success';
    status.textContent = '登录成功！';
    showChats();
  } catch (e) {
    status.className = 'status error';
    status.textContent = '错误: ' + (e.message || e);
  }
};

// ===== 聊天/频道列表 =====
window.showChats = async function () {
  document.getElementById('login-page').classList.add('hidden');
  document.getElementById('file-list-page').classList.add('hidden');
  document.getElementById('chat-list-page').classList.remove('hidden');
  document.getElementById('chat-list').innerHTML = '';
  document.getElementById('chat-status').textContent = '加载中...';

  try {
    const dialogs = await client.getDialogs({ limit: 100 });
    const list = document.getElementById('chat-list');
    let count = 0;
    for (const dialog of dialogs) {
      const entity = dialog.entity;
      const name = entity.title || entity.firstName || entity.username || 'Unknown';
      const sub = dialog.message?.text || dialog.message?.message || '';
      const initial = name.charAt(0).toUpperCase();

      const item = document.createElement('div');
      item.className = 'chat-item';
      item.innerHTML = `
        <div class="avatar">${initial}</div>
        <div>
          <div class="chat-name">${escapeHtml(name)}</div>
          <div class="chat-sub">${escapeHtml(sub.slice(0, 50))}</div>
        </div>
      `;
      item.onclick = () => showFiles(dialog);
      list.appendChild(item);
      count++;
    }
    document.getElementById('chat-status').textContent = `共 ${count} 个对话`;
  } catch (e) {
    document.getElementById('chat-status').className = 'status error';
    document.getElementById('chat-status').textContent = '错误: ' + (e.message || e);
  }
};

// ===== 文件列表 =====
window.showFiles = async function (dialog) {
  currentChat = dialog;
  const entity = dialog.entity;
  const name = entity.title || entity.firstName || entity.username || 'Unknown';

  document.getElementById('chat-list-page').classList.add('hidden');
  document.getElementById('file-list-page').classList.remove('hidden');
  document.getElementById('chat-title').textContent = name;
  document.getElementById('file-list').innerHTML = '';
  document.getElementById('file-status').textContent = '加载文件中...';

  try {
    const messages = await client.getMessages(entity, { limit: 200 });
    const list = document.getElementById('file-list');
    let count = 0;

    for (const msg of messages) {
      const media = msg.media || msg.document || msg.photo;
      if (!media) continue;

      let fileName = 'unknown';
      let fileSize = 0;
      let dlFunc = null;

      if (msg.document) {
        const attr = msg.document.attributes?.find(a => a.fileName);
        fileName = attr?.fileName || 'document_' + msg.id;
        fileSize = msg.document.size || 0;
        dlFunc = () => downloadDocument(msg);
      } else if (msg.photo) {
        fileName = 'photo_' + msg.id + '.jpg';
        dlFunc = () => downloadPhoto(msg);
      } else if (msg.media && msg.media.document) {
        const attr = msg.media.document.attributes?.find(a => a.fileName);
        fileName = attr?.fileName || 'file_' + msg.id;
        fileSize = msg.media.document.size || 0;
        dlFunc = () => downloadDocument(msg);
      }

      if (!dlFunc) continue;

      const item = document.createElement('div');
      item.className = 'file-item';
      item.innerHTML = `
        <div class="file-name">${escapeHtml(fileName)}</div>
        <div class="file-size">${formatSize(fileSize)}</div>
        <button class="file-dl">下载</button>
      `;
      item.querySelector('.file-dl').onclick = () => dlFunc();
      list.appendChild(item);
      count++;
    }

    document.getElementById('file-status').textContent = count > 0
      ? `共 ${count} 个文件`
      : '此频道没有文件';
  } catch (e) {
    document.getElementById('file-status').className = 'status error';
    document.getElementById('file-status').textContent = '错误: ' + (e.message || e);
  }
};

// ===== 文件下载 =====
async function downloadDocument(msg) {
  try {
    const buffer = await client.downloadMedia(msg);
    if (!buffer) return;
    const blob = new Blob([buffer], { type: 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    const attr = msg.document?.attributes?.find(x => x.fileName);
    a.download = attr?.fileName || 'download';
    a.click();
    URL.revokeObjectURL(url);
  } catch (e) {
    alert('下载失败: ' + (e.message || e));
  }
}

async function downloadPhoto(msg) {
  try {
    const buffer = await client.downloadMedia(msg);
    if (!buffer) return;
    const blob = new Blob([buffer], { type: 'image/jpeg' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'photo.jpg';
    a.click();
    URL.revokeObjectURL(url);
  } catch (e) {
    alert('下载失败: ' + (e.message || e));
  }
}

// ===== 工具函数 =====
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
  document.getElementById('login-status').textContent =
    '请先设置 VITE_API_ID 和 VITE_API_HASH 环境变量';
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
