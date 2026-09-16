import { TelegramClient, Api } from 'telegram';
import { StringSession } from 'telegram/sessions';
import { PromisedWebSockets } from 'telegram/extensions/PromisedWebSockets';
import { CustomFile } from 'telegram/client/uploads';
import { NewMessage } from 'telegram/events';

// ===== 配置 =====
const API_ID = parseInt(import.meta.env.VITE_API_ID || '0');
const API_HASH = import.meta.env.VITE_API_HASH || '';
const PROXY_DOMAIN = import.meta.env.VITE_PROXY_DOMAIN || '';

// ===== 代理：重写 GramJS 内部 WebSocket 地址 =====
class ProxiedWebSockets extends PromisedWebSockets {
  getWebSocketLink(ip, port, testServers) {
    const path = `/apiws${testServers ? '_test' : ''}`;
    if (PROXY_DOMAIN) {
      // https 页面用 wss，http（本地调试）用 ws
      const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
      return `${scheme}://${PROXY_DOMAIN}/${ip}${path}`;
    }
    return super.getWebSocketLink(ip, port, testServers);
  }
}
if (!PROXY_DOMAIN) console.warn('[tg] 未设置 VITE_PROXY_DOMAIN，将直连 Telegram（国内大概率失败）。');
if (PROXY_DOMAIN) {
  const origFetch = self.fetch;
  self.fetch = function (input, init) {
    let s = typeof input === 'string' ? input : (input?.url || '');
    if (s.includes('telegram.org') && !s.includes(PROXY_DOMAIN)) {
      try { const u = new URL(s); s = `https://${PROXY_DOMAIN}/${u.hostname}${u.pathname}${u.search}`; input = typeof input === 'string' ? s : new Request(s, input); } catch (e) {}
    }
    return origFetch.call(self, input, init);
  };
}

// ===== DOM =====
const $ = (id) => document.getElementById(id);
const el = {
  dialogs: $('dialogs'), searchInput: $('searchInput'),
  chatHeader: $('chatHeader'), chatAvatar: $('chatAvatar'),
  chatTitle: $('chatTitle'), chatStatus: $('chatStatus'),
  messages: $('messages'), composer: $('composer'),
  msgInput: $('msgInput'), btnSend: $('btnSend'), btnAttach: $('btnAttach'),
  fileInput: $('fileInput'), btnBack: $('btnBack'),
  btnMenu: $('btnMenu'), btnChatMenu: $('btnChatMenu'), btnSettingsClose: $('btnSettingsClose'),
  settings: $('settings'), accAvatar: $('accAvatar'), accName: $('accName'), accSub: $('accSub'),
  segTheme: $('segTheme'), segAccent: $('segAccent'),
  netdiskSelect: $('netdiskSelect'), btnEnterNetdisk: $('btnEnterNetdisk'), btnLogout: $('btnLogout'),
  bgFileInput: $('bgFileInput'), btnBgImage: $('btnBgImage'), btnBgReset: $('btnBgReset'),
  netdisk: $('netdisk'), netdiskTabs: $('netdiskTabs'), netdiskGrid: $('netdiskGrid'),
  btnNetdiskBack: $('btnNetdiskBack'), btnNetdiskClose: $('btnNetdiskClose'),
  btnNetdiskUpload: $('btnNetdiskUpload'), netdiskFileInput: $('netdiskFileInput'),
  viewer: $('viewer'), viewerMedia: $('viewerMedia'), viewerVideo: $('viewerVideo'),
  viewerCap: $('viewerCap'), viewerClose: $('viewerClose'),
  viewerDownload: $('viewerDownload'), viewerShare: $('viewerShare'),
  viewerPrev: $('viewerPrev'), viewerNext: $('viewerNext'),
  details: $('details'), detailsPlaceholder: $('detailsPlaceholder'),
  detailsContent: $('detailsContent'), dAvatar: $('dAvatar'), dName: $('dName'),
  dSub: $('dSub'), dAbout: $('dAbout'), dStat: $('dStat'), dStatMore: $('dStatMore'),
  chatMenu: $('chatMenu'), toast: $('toast'),
  mediaBrowser: $('mediaBrowser'), mediaBrowserGrid: $('mediaBrowserGrid'),
  mediaBrowserTitle: $('mediaBrowserTitle'), mediaBrowserClose: $('mediaBrowserClose'),
  btnNetdiskView: $('btnNetdiskView'), btnMediaView: $('btnMediaView'),
};

// ===== 状态 =====
let client = null, currentEntity = null, currentDialogs = [];
let currentMediaList = [], netdiskChannel = null, netdiskMediaList = [];
let viewerList = null, viewerIndex = 0, viewerMode = 'chat', viewerEntity = null;
let selfMe = null;
const senderCache = new Map();
const mediaCache = new Map();   // 媒体缓存：key -> blob URL（缩略图 / 完整视频）
let lazyObserver = null;
let netdiskView = 'list', currentNetdiskCat = 'all';
let mediaBrowserView = 'card', currentMediaBrowserType = 'video';
let oldestId = null, loadingOlder = false;
let lastFocusVideo = null;      // 当前正在播放/加载的视频消息，用于集中带宽

// ===== 视频下载串行化（同一时间只下载一条视频，集中带宽给正在播放的那条）=====
let _dlRunning = false;
const _dlQueue = [];
function enqueueDownload(task){
  return new Promise((resolve,reject)=>{
    _dlQueue.push({task,resolve,reject});
    _pumpDownloads();
  });
}
function _pumpDownloads(){
  if(_dlRunning)return;
  if(!_dlQueue.length)return;
  _dlRunning=true;
  const {task,resolve,reject}=_dlQueue.shift();
  Promise.resolve().then(task).then(resolve,e=>reject(e)).finally(()=>{_dlRunning=false;_pumpDownloads();});
}

// ===== 工具 =====
const ICONS = {
  play: '<svg viewBox="0 0 24 24" fill="#fff"><path d="M8 5v14l11-7z"/></svg>',
  playSmall: '<svg viewBox="0 0 24 24" fill="#fff" width="14" height="14"><path d="M8 5v14l11-7z"/></svg>',
  download: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="M7 10l5 5 5-5"/><path d="M12 15V3"/></svg>',
  share: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><path d="m8.6 13.5 6.8 4M15.4 6.5 8.6 10.5"/></svg>',
  view: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/></svg>',
  del: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>',
  file: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/></svg>',
  video: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="6" width="20" height="12" rx="2"/><path d="m10 9 5 3-5 3z"/></svg>',
  image: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/></svg>',
  audio: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>',
  link: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>',
  refresh: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21.5 2v6h-6M2.5 22v-6h6M2 11.5a10 10 0 0 1 18.8-4.3M22 12.5a10 10 0 0 1-18.8 4.3"/></svg>',
  users: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>',
  volume: '<svg viewBox="0 0 24 24" fill="currentColor"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
  mute: '<svg viewBox="0 0 24 24" fill="currentColor"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><line x1="23" y1="9" x2="17" y2="15" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><line x1="17" y1="9" x2="23" y2="15" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
};
function escapeHtml(s){return String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
function getInitials(name){name=(name||'').trim();if(!name)return'?';const p=name.split(/\s+/);return (p[0]?.[0]||'')+(p[1]?.[0]||'');}
const AVCOL=['#e17076','#7bc862','#65aadd','#a695e7','#ee7aae','#6ec9cb','#faa774'];
function avatarBg(name){let h=0;for(const c of (name||''))h=(h*31+c.charCodeAt(0))>>>0;return AVCOL[h%AVCOL.length];}
function fmtSize(b){if(!b)return'';if(b<1024)return b+'B';if(b<1048576)return (b/1024).toFixed(1)+'KB';if(b<1073741824)return (b/1048576).toFixed(1)+'MB';return (b/1073741824).toFixed(2)+'GB';}
function getMediaKey(entity,msg,suffix){if(!entity||!msg)return null;return `${entity.id}:${msg.id}:${suffix}`;}
function setThumbFallback(node,info){
  if(!node||!info)return;
  const vbtn=node.querySelector('.vbtn');
  const overlay=node.querySelector('.play-overlay');
  const map={video:ICONS.video,image:ICONS.image,gif:ICONS.image,audio:ICONS.audio,file:ICONS.file};
  const icon=map[info.type]||ICONS.file;
  node.innerHTML='';
  const wrap=document.createElement('div');
  wrap.style.cssText='display:flex;flex-direction:column;align-items:center;gap:6px;color:var(--tg-sub);padding:10px;text-align:center;';
  wrap.innerHTML=`${icon}<span style="font-size:11px;max-width:100%;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(info.name)}</span>`;
  node.appendChild(wrap);
  if(vbtn)node.appendChild(vbtn);
  if(overlay)node.appendChild(overlay);
  node.style.background='var(--tg-attach)';
}
function fmtTime(ts){if(!ts)return'';const d=new Date(ts*1000);const p=n=>String(n).padStart(2,'0');return `${p(d.getMonth()+1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;}
function chatName(e){if(!e)return'';if(e.className==='User')return [e.firstName,e.lastName].filter(Boolean).join(' ')||e.username||e.phone||'用户';if(e.className==='Channel'||e.className==='Chat')return e.title||'';return'';}
function isGroup(e){return e && (e.className==='Channel'||e.className==='Chat');}
let toastTimer=null;
function toast(msg){el.toast.textContent=msg;el.toast.classList.add('show');clearTimeout(toastTimer);toastTimer=setTimeout(()=>el.toast.classList.remove('show'),2200);}

// ===== 媒体识别 =====
function mediaInfo(msg){
  const m=msg.media; if(!m)return null;
  if(m.photo) return {type:'image',name:'图片',size:0,mime:'image/jpeg'};  // photo 归到图片类统计
  if(m.document){
    const d=m.document;
    const fn=d.attributes?.find(a=>a.className==='DocumentAttributeFilename')?.fileName||'文件';
    const mime=d.mimeType||'application/octet-stream';
    const animated=d.attributes?.some(a=>a.className==='DocumentAttributeAnimated');
    const isVideo=mime.startsWith('video/'), isGif=mime==='image/gif'||animated,
          isImage=mime.startsWith('image/'), isAudio=mime.startsWith('audio/');
    const type=isVideo?'video':isGif?'gif':isImage?'image':isAudio?'audio':'file';
    return {type,name:fn,mime,size:d.size||0};
  }
  return {type:'unknown'};
}
function netdiskCategory(msg){
  const info=mediaInfo(msg); if(!info)return null;
  if(info.type==='video')return 'video';
  if(info.type==='image')return 'image';
  if(info.type==='gif')return 'gif';
  if(info.type==='audio')return 'audio';
  const ext=(info.name.split('.').pop()||'').toLowerCase();
  if(['apk','ipa','exe','dmg','deb','rpm','msi','app','xapk'].includes(ext))return 'software';
  return 'document';
}

// ===== 主题 =====
function applyTheme(){const t=localStorage.getItem('tg_theme')||'light';const a=localStorage.getItem('tg_accent')||'blue';document.documentElement.setAttribute('data-theme',t);document.documentElement.setAttribute('data-accent',a);
  el.segTheme.querySelectorAll('button').forEach(b=>b.classList.toggle('sel',b.dataset.v===t));
  el.segAccent.querySelectorAll('button').forEach(b=>b.classList.toggle('sel',b.dataset.v===a));}

// ===== 自定义聊天背景 =====
function applyChatBg(){
  const raw=localStorage.getItem('tg_chat_bg');
  const chat=document.getElementById('chat');
  chat.style.backgroundImage='var(--tg-chat-pattern)';chat.style.backgroundSize='';
  if(!raw){chat.style.background='';return;}
  try{const o=JSON.parse(raw);
    if(o.type==='color'){chat.style.backgroundImage='none';chat.style.background=o.value;}
    else if(o.type==='image'){chat.style.backgroundImage=`url(${o.value})`;chat.style.backgroundSize='cover';chat.style.backgroundPosition='center';}
  }catch(e){chat.style.background='';}
}

// ===== 头像（首字母保底 + 异步照片）=====
function loadAvatarInto(node, entity){
  if(!node)return;
  node.textContent='';node.style.backgroundImage='';
  if(entity){node.textContent=getInitials(chatName(entity));node.style.background=avatarBg(chatName(entity));}
  if(!client||!entity)return;
  client.downloadProfilePhoto(entity).then(buf=>{
    if(buf&&buf.length){const url=URL.createObjectURL(new Blob([buf],{type:'image/jpeg'}));node.style.backgroundImage=`url(${url})`;node.style.backgroundSize='cover';node.style.backgroundPosition='center';node.textContent='';}
  }).catch(()=>{});
}
async function getSender(msg){
  if(msg.sender&&msg.sender.className)return msg.sender;
  if(!msg.senderId)return null;
  if(senderCache.has(msg.senderId))return senderCache.get(msg.senderId);
  try{const u=await client.getEntity(msg.senderId);if(u){senderCache.set(msg.senderId,u);return u;}}catch(e){}
  return null;
}

// ===== 懒加载（root:视口，聊天/网盘通用）=====
function ensureObserver(){
  if(lazyObserver)return;
  lazyObserver=new IntersectionObserver((entries)=>{
    for(const e of entries){if(e.isIntersecting){const node=e.target;lazyObserver.unobserve(node);if(node._thumbMsg)loadThumb(node,node._thumbMsg);}}
  },{root:null,rootMargin:'300px'});
}
function applyThumb(node,url){
  const ph=node.querySelector('.lazy-ph');
  if(ph){ph.style.backgroundImage=`url(${url})`;}
  else {node.style.backgroundImage=`url(${url})`;node.style.backgroundSize='cover';node.style.backgroundPosition='center';}
  // 注意：不要在这里用自然宽高比覆盖 aspect-ratio，否则会破坏网盘正方形封面 / 列表布局的既定比例
}
// 从完整视频中提取首帧（用于没有服务端缩略图的视频，如本应用早期发送的文件型视频）
function extractFirstFrame(buf,mime){
  return new Promise((resolve)=>{
    try{
      const url=URL.createObjectURL(new Blob([buf],{type:mime}));
      const v=document.createElement('video');v.muted=true;v.preload='metadata';v.src=url;v.crossOrigin='anonymous';
      let done=false;const ok=(r)=>{if(done)return;done=true;URL.revokeObjectURL(url);resolve(r);};
      v.onloadeddata=()=>{try{v.currentTime=0.1;}catch(e){}};
      v.onseeked=()=>{try{const c=document.createElement('canvas');c.width=v.videoWidth||320;c.height=v.videoHeight||180;c.getContext('2d').drawImage(v,0,0,c.width,c.height);ok(c.toDataURL('image/jpeg',0.7));}catch(e){ok(null);}};
      v.onerror=()=>ok(null);
      setTimeout(()=>ok(null),9000);
    }catch(e){resolve(null);}
  });
}
async function loadThumb(node,msg){
  const info=mediaInfo(msg); if(!info)return;
  const entity=(node._entity||currentEntity);
  const key=(node._cacheKey||(getMediaKey(entity,msg,'thumb')));
  if(mediaCache.has(key)){applyThumb(node,mediaCache.get(key));return;}
  let url=null;
  // Telegram 的 downloadMedia 只接受数字索引或尺寸字符串（'s','m','x','y'），不接受 thumb:true
  const thumbSizes=['m','x','s','y',0];
  try{
    if(info.type==='image'){
      // 优先缩略图 'm'/'x'，失败则下载原图兜底
      for(const opt of thumbSizes){
        try{const buf=await client.downloadMedia(msg,{thumb:opt});if(buf&&buf.length){url=URL.createObjectURL(new Blob([buf],{type:'image/jpeg'}));break;}}catch(e){}
      }
      if(!url){try{const buf=await client.downloadMedia(msg);if(buf&&buf.length)url=URL.createObjectURL(new Blob([buf],{type:info.mime||'image/jpeg'}));}catch(e){}}
    }else if(info.type==='video'){
      // 1) 服务端缩略图即首帧（Telegram 为多数视频生成）
      for(const opt of thumbSizes){
        try{const buf=await client.downloadMedia(msg,{thumb:opt});if(buf&&buf.length){url=URL.createObjectURL(new Blob([buf],{type:'image/jpeg'}));break;}}catch(e){}
      }
      // 2) 仍无缩略图时：仅对小视频尝试下载并提取首帧，避免大视频长时间卡死
      if(!url && info.size && info.size < 30*1024*1024){
        try{
          const fb=await Promise.race([client.downloadMedia(msg),new Promise((_,rej)=>setTimeout(()=>rej(new Error('thumb timeout')),10000))]);
          if(fb&&fb.length)url=await extractFirstFrame(fb,info.mime);
        }catch(e){}
      }
    }else if(info.type==='gif'){
      for(const opt of thumbSizes){
        try{const buf=await client.downloadMedia(msg,{thumb:opt});if(buf&&buf.length){url=URL.createObjectURL(new Blob([buf],{type:'image/jpeg'}));break;}}catch(e){}
      }
    }
  }catch(e){}
  if(url){mediaCache.set(key,url);applyThumb(node,url);}
  else setThumbFallback(node,info);
}

// ===== 认证 =====
async function init(){
  applyTheme();
  applyChatBg();
  injectMobileCss();
  setupDetailsClose();
  const sessionStr=localStorage.getItem('tg_session')||'';
  if(!API_ID || !API_HASH){
    el.messages.innerHTML='<div class="empty-hint">未配置 API_ID / API_HASH。请在 Cloudflare Pages 的环境变量中设置 VITE_API_ID、VITE_API_HASH、VITE_PROXY_DOMAIN，然后重新部署。</div>';
    toast('缺少 API 配置'); return;
  }
  client=new TelegramClient(new StringSession(sessionStr),API_ID,API_HASH,{connectionRetries:5,retryDelay:2000,useWSS:true,networkSocket:ProxiedWebSockets});
  client.addEventHandler(onNewMessage,new NewMessage({}));
  const saved=localStorage.getItem('tg_self');
  if(saved){try{selfMe=JSON.parse(saved);showAccount(selfMe);}catch(e){}}
  if(!sessionStr||sessionStr.length<20){
    const phone=prompt('请输入手机号（含国家码，如 +8613800000000）：');
    if(!phone){el.messages.innerHTML='<div class="empty-hint">未登录</div>';return;}
    try{
      setConn('connecting');
      await client.connect();
      const sent=await client.sendCode({apiId:API_ID,apiHash:API_HASH,phoneNumber:phone});
      const code=prompt('请输入 Telegram 发来的验证码：');
      const sign=await client.signIn({phoneNumber:phone,phoneCodeHash:sent.phoneCodeHash,phoneCode:code});
      finishLogin(sign);
    }catch(e){setConn('error',e.message);alert('登录失败：'+e.message);}
    return;
  }
  try{
    setConn('connecting');
    await client.connect();
    const me=await client.getMe();
    finishLogin(me);
  }
  catch(e){setConn('error',e.message);toast('连接失败：'+e.message);el.messages.innerHTML='<div class="empty-hint">连接失败：'+(e&&e.message?e.message:'未知')+'</div>';}
}
// 连接状态指示（右上角固定小圆点，避免"空白但不知道卡在哪"）
function setConn(state,msg){
  let chip=document.getElementById('conn-chip');
  if(!chip){chip=document.createElement('div');chip.id='conn-chip';document.body.appendChild(chip);}
  const map={
    connecting:['conn-dot on','连接 Telegram 中…'],
    ok:['conn-dot ok','已连接'],
    error:['conn-dot err','连接失败：'+(msg||'')+'（将自动重试）'],
  };
  const [cls,text]=map[state]||map.connecting;
  chip.innerHTML=`<span class="${cls}"></span>${text}`;
  if(state==='ok'){setTimeout(()=>{chip.style.opacity='0';},2000);}
  else chip.style.opacity='1';
}
function finishLogin(me,silent){
  localStorage.setItem('tg_session',client.session.save());
  try{localStorage.setItem('tg_self',JSON.stringify({id:me.id,firstName:me.firstName,lastName:me.lastName,username:me.username,phone:me.phone}));}catch(e){}
  selfMe=me;setConn('ok');showAccount(me);loadDialogs();
}
function showAccount(me){
  if(!me)return;
  el.accName.textContent=[me.firstName,me.lastName].filter(Boolean).join(' ')||me.username||'用户';
  el.accSub.textContent=me.username?('@'+me.username):(me.phone||'');
  // me 本身即 User 对象（含 photo），直接用它加载头像，避免 getEntity 在大整数 ID 下偶发失败
  if(client)loadAvatarInto(el.accAvatar,me);
}

// ===== 对话列表（全部显示头像，贴近官方）=====
async function loadDialogs(){
  try{
    const dialogs=await client.getDialogs({limit:50});
    currentDialogs=dialogs.map(d=>({entity:d.entity,name:chatName(d.entity),message:d.message,id:d.entity.id,date:d.message?.date}));
    renderDialogs(currentDialogs);
    fillNetdiskSelect();
  }catch(e){toast('加载对话失败：'+e.message);}
}
function renderDialogs(list){
  el.dialogs.innerHTML='';
  if(!list.length){el.dialogs.innerHTML='<div class="empty-hint">没有对话</div>';return;}
  for(const d of list){
    const div=document.createElement('div');div.className='dialog';div.dataset.id=d.id;
    const av=document.createElement('div');av.className='avatar';div.appendChild(av);loadAvatarInto(av,d.entity);
    const meta=document.createElement('div');meta.className='meta';
    const name=document.createElement('div');name.className='name';name.textContent=d.name;
    const last=document.createElement('div');last.className='last';last.textContent=d.message?(d.message.message||(d.message.media?'[媒体]':'')):'';
    meta.append(name,last);
    const right=document.createElement('div');right.className='right';
    const time=document.createElement('div');time.className='time';time.textContent=d.date?fmtTime(d.date).split(' ')[1]:'';right.appendChild(time);
    if(d.joined===false){const jb=document.createElement('button');jb.className='join-btn';jb.textContent='加入';jb.onclick=(ev)=>{ev.stopPropagation();joinChannel(d.entity);};right.appendChild(jb);}
    div.append(meta,right);
    div.onclick=()=>openChat(d.entity);
    el.dialogs.appendChild(div);
  }
}
let searchTimer=null;
el.searchInput.addEventListener('input',()=>{clearTimeout(searchTimer);searchTimer=setTimeout(doSearch,250);});
async function doSearch(){
  const q=el.searchInput.value.trim();
  if(!q){renderDialogs(currentDialogs);return;}
  const local=currentDialogs.filter(d=>(d.name||'').toLowerCase().includes(q.toLowerCase()));
  let global=[];
  try{
    const r=await client.invoke(new Api.contacts.Search({q,limit:20}));
    const localIds=new Set(currentDialogs.map(d=>d.id));
    for(const ch of r.chats){if(!localIds.has(ch.id))global.push({entity:ch,name:chatName(ch),message:null,id:ch.id,joined:false});}
  }catch(e){}
  renderDialogs(local.concat(global));
}

// ===== 打开聊天 =====
async function openChat(entity){
  currentEntity=entity;currentMediaList=[];senderCache.clear();
  document.body.classList.add('chat-open');
  el.chatHeader.style.display='flex';el.composer.style.display='flex';
  el.chatTitle.textContent=chatName(entity);
  await loadAvatarInto(el.chatAvatar,entity);
  el.chatStatus.textContent=isGroup(entity)?(entity.className==='Channel'?(entity.megaGroup?'群组':'频道'):'群组'):'';
  el.messages.innerHTML='<div class="loading-spinner"></div>';
  await loadMessages();
  loadDetails(entity);
  document.querySelectorAll('.dialog').forEach(d=>d.classList.toggle('active',String(d.dataset.id)===String(entity.id)));
}
async function loadMessages(){
  try{
    const msgs=await client.getMessages(currentEntity,{limit:40});
    el.messages.innerHTML='';currentMediaList=[];
    for(const m of msgs.reverse())await appendMessage(m,false);
    oldestId=msgs.length?msgs[0].id:null;
    loadingOlder=false;
    el.messages.scrollTop=el.messages.scrollHeight;
  }catch(e){toast('加载消息失败：'+e.message);}
}
// 向上滚动加载更早的历史消息
async function loadOlder(){
  if(loadingOlder||!oldestId)return;
  loadingOlder=true;
  const prevH=el.messages.scrollHeight;
  const prevTop=el.messages.scrollTop;
  try{
    const msgs=await client.getMessages(currentEntity,{limit:40,offsetId:oldestId});
    if(msgs&&msgs.length){
      for(const m of msgs.reverse())await appendMessage(m,true);
      oldestId=msgs[0].id;
      // 保持滚动位置不跳动
      el.messages.scrollTop=prevTop+(el.messages.scrollHeight-prevH);
    }
  }catch(e){toast('加载更早消息失败：'+e.message);}
  loadingOlder=false;
}
el.messages.addEventListener('scroll',()=>{ if(el.messages.scrollTop<60) loadOlder(); });

// ===== 渲染单条消息 =====
async function appendMessage(msg, prepend){
  const info=mediaInfo(msg);
  const row=document.createElement('div');row.className='row '+(msg.out?'out':'in');
  const bubble=document.createElement('div');bubble.className='msg';bubble.dataset.id=msg.id;
  const grp=isGroup(currentEntity);
  if(!msg.out&&grp){
    const s=await getSender(msg);
    if(s){
      const sr=document.createElement('div');sr.className='sender-row';
      const sa=document.createElement('div');sa.className='avatar xs';loadAvatarInto(sa,s);
      const sn=document.createElement('div');sn.className='sender';sn.textContent=chatName(s);
      sr.append(sa,sn);bubble.appendChild(sr);
    }
  }
  if(msg.message&&typeof msg.message==='string'&&msg.message.trim())bubble.innerHTML+=`<div class="text">${escapeHtml(msg.message)}</div>`;
  if(info){
    const media=document.createElement('div');media.className='msg-media';
    const key=currentEntity.id+':'+msg.id;
    media._thumbMsg=msg;media._cacheKey=key;
    if(info.type==='image'||info.type==='video'||info.type==='gif'){
      const ph=document.createElement('div');ph.className='lazy-ph';media.appendChild(ph);
      if(info.type==='video'){
        // 左下角：圆形进度条 + 播放按钮 + 视频大小（去掉原来的居中大播放按钮）
        const vb=document.createElement('div');vb.className='vbtn';
        vb.innerHTML=`<span class="vbtn-bg"><svg viewBox="0 0 36 36" width="30" height="30"><circle cx="18" cy="18" r="15" fill="rgba(0,0,0,.45)"/><circle class="cp" cx="18" cy="18" r="15" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round" stroke-dasharray="94.2" stroke-dashoffset="94.2" transform="rotate(-90 18 18)"/></svg><span class="vplay">${ICONS.playSmall}</span></span>${info.size?`<span class="vsize">${fmtSize(info.size)}</span>`:''}`;
        media.appendChild(vb);
      }else if(info.type==='gif'){
        const ov=document.createElement('div');ov.className='play-overlay';ov.innerHTML=ICONS.play;media.appendChild(ov);
      }
      ensureObserver();lazyObserver.observe(media);
    }else{
      const fc=document.createElement('div');fc.className='file-card';
      fc.innerHTML=`<div class="fi">${ICONS.file}</div><div style="min-width:0"><div class="fn">${escapeHtml(info.name)}</div><div class="fs">${fmtSize(info.size)}</div></div>`;
      media.appendChild(fc);
    }
    bubble.appendChild(media);
    if(prepend)currentMediaList.unshift(msg);else currentMediaList.push(msg);
  }
  const acts=document.createElement('div');acts.className='msg-actions';
  acts.innerHTML=`<button class="act-btn" data-act="view" title="查看">${ICONS.view}</button><button class="act-btn" data-act="download" title="下载">${ICONS.download}</button><button class="act-btn" data-act="share" title="分享">${ICONS.share}</button><button class="act-btn del" data-act="delete" title="删除">${ICONS.del}</button>`;
  bubble.appendChild(acts);
  const mt=document.createElement('div');mt.className='mt';mt.textContent=fmtTime(msg.date).split(' ')[1]||'';bubble.appendChild(mt);
  row.appendChild(bubble);
  if(prepend)el.messages.insertBefore(row,el.messages.firstChild);else el.messages.appendChild(row);
}

// 点击：播放 / 操作 / 查看器
el.messages.addEventListener('click',async(e)=>{
  const actBtn=e.target.closest('.act-btn');
  if(actBtn){const id=parseInt(actBtn.closest('.msg').dataset.id);const msg=currentMediaList.find(m=>m.id===id)||await findMsg(id);if(!msg)return;
    const act=actBtn.dataset.act;
    if(act==='view'){const idx=currentMediaList.findIndex(m=>m.id===id);if(idx>=0)openViewer(currentMediaList,idx,'chat',currentEntity);}
    else if(act==='download')downloadMedia(msg);
    else if(act==='share')shareMedia(msg);
    else if(act==='delete')deleteMessage(id);
    return;}
  const vbtn=e.target.closest('.vbtn');
  if(vbtn){const host=vbtn.closest('.msg-media');const id=parseInt(vbtn.closest('.msg').dataset.id);const msg=currentMediaList.find(m=>m.id===id);if(msg)playVideo(host,msg,currentEntity);return;}
  const play=e.target.closest('.play-overlay');
  if(play){const host=play.closest('.msg-media');const id=parseInt(play.closest('.msg').dataset.id);const msg=currentMediaList.find(m=>m.id===id);if(msg)playVideo(host,msg,currentEntity);return;}
  const media=e.target.closest('.msg-media');
  if(media&&!e.target.closest('.msg-actions')){const id=parseInt(media.closest('.msg').dataset.id);const idx=currentMediaList.findIndex(m=>m.id===id);if(idx>=0)openViewer(currentMediaList,idx,'chat',currentEntity);}
});
async function findMsg(id){try{const m=await client.getMessages(currentEntity,{ids:[id]});return m[0];}catch(e){return null;}}

// 自定义视频播放器：无默认 controls，仅左下角圆形进度 + 播放/暂停 + 文件名 + 倒计时 + 静音
async function playVideo(host,msg,entity){
  if(!entity)entity=currentEntity;
  lastFocusVideo=msg;
  const key=getMediaKey(entity,msg,'full');
  const info=mediaInfo(msg);
  const mime=(msg.video&&msg.video.mimeType)||(msg.document&&msg.document.mimeType)||'video/mp4';

  host.innerHTML='';host.classList.add('playing');
  const wrap=document.createElement('div');wrap.className='vp-wrap';
  const v=document.createElement('video');v.className='vp-video';v.playsInline=true;v.preload='auto';v.muted=true; // 静音自动播放，规避浏览器自动播放限制（一次点击即播）
  wrap.appendChild(v);

  const ctrl=document.createElement('div');ctrl.className='vp-controls';
  const left=document.createElement('div');left.className='vp-left';
  const playBtn=document.createElement('button');playBtn.className='vp-play';
  playBtn.innerHTML=`<span class="vp-icon">▶</span><span class="vp-ring"><svg viewBox="0 0 36 36"><circle cx="18" cy="18" r="15" fill="none" stroke="rgba(255,255,255,.35)" stroke-width="3"/><circle class="vp-ring-cp cp" cx="18" cy="18" r="15" fill="none" stroke-width="3" stroke-linecap="round" stroke-dasharray="94.2" stroke-dashoffset="94.2" transform="rotate(-90 18 18)"/></svg></span>`;
  left.appendChild(playBtn);

  const infoBox=document.createElement('div');infoBox.className='vp-info';
  const nameSpan=document.createElement('div');nameSpan.className='vp-name';nameSpan.textContent=info?info.name:'';
  const timeSpan=document.createElement('span');timeSpan.className='vp-time';timeSpan.textContent='0:00';
  infoBox.append(nameSpan,timeSpan);

  const right=document.createElement('div');right.className='vp-right';
  const muteBtn=document.createElement('button');muteBtn.className='vp-mute';muteBtn.innerHTML=ICONS.mute; // 初始静音
  right.appendChild(muteBtn);

  ctrl.append(left,infoBox,right);wrap.appendChild(ctrl);host.appendChild(wrap);

  const cp=playBtn.querySelector('.vp-ring-cp');
  const icon=playBtn.querySelector('.vp-icon');
  wrap.addEventListener('click',e=>e.stopPropagation());
  // 左下角圆形进度 = 实时下载进度（不再有中间大进度条）
  function setLoadProgress(p){const t=Math.max(0,Math.min(1,p));cp.style.strokeDashoffset=String(94.2*(1-t));}
  function fmtDur(s){if(!s||!isFinite(s))return '0:00';const m=Math.floor(s/60);const sec=Math.floor(s%60);return m+':'+String(sec).padStart(2,'0');}
  function updateTime(){timeSpan.textContent='-'+fmtDur(Math.max(0,(v.duration||0)-v.currentTime));}
  function syncIcon(){icon.textContent=v.paused?'▶':'⏸';}
  async function safePlay(){try{await v.play();}catch(e){if(e&&e.name!=='AbortError')console.warn('play error',e);}}

  playBtn.onclick=(e)=>{e.stopPropagation();if(v.paused){safePlay();}else{v.pause();}};
  muteBtn.onclick=(e)=>{e.stopPropagation();v.muted=!v.muted;muteBtn.innerHTML=v.muted?ICONS.mute:ICONS.volume;};
  v.onclick=(e)=>{e.stopPropagation();if(v.paused)safePlay();else v.pause();};
  v.addEventListener('play',syncIcon);v.addEventListener('pause',syncIcon);
  v.addEventListener('timeupdate',updateTime);v.addEventListener('loadedmetadata',updateTime);
  v.addEventListener('ended',()=>{icon.textContent='↻';});

  if(mediaCache.has(key)){ // 已缓存：直接即播，进度置满
    const url=mediaCache.get(key);v.src=url;setLoadProgress(1);safePlay();return;
  }
  try{
    // 串行化下载：正在播放本条时，其它视频下载排队等待，集中流量给本条
    const buf=await enqueueDownload(()=>client.downloadMedia(msg,{progressCallback:p=>{if(lastFocusVideo===msg)setLoadProgress(p);}}));
    if(lastFocusVideo!==msg)return; // 已切走，丢弃
    if(!buf||!buf.length){host.innerHTML='❌ 播放失败';return;}
    const url=URL.createObjectURL(new Blob([buf],{type:mime}));mediaCache.set(key,url);
    v.src=url;setLoadProgress(1);
    safePlay();   // 已静音，不受自动播放限制，一次点击即播
  }catch(e){host.innerHTML='❌ 播放失败';}
}

// ===== 发送（含上传圆形进度）=====
el.btnSend.addEventListener('click',sendText);
el.msgInput.addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();sendText();}});
async function sendText(){const t=el.msgInput.value.trim();if(!t||!currentEntity)return;el.msgInput.value='';
  try{const m=await client.sendMessage(currentEntity,{message:t});appendMessage(m,false);el.messages.scrollTop=el.messages.scrollHeight;}catch(e){toast('发送失败：'+e.message);}}
el.btnAttach.addEventListener('click',()=>el.fileInput.click());
el.fileInput.addEventListener('change',e=>{if(e.target.files.length)sendFiles(e.target.files);e.target.value='';});

function makeCircle(){
  const wrap=document.createElement('div');wrap.className='circ';
  wrap.innerHTML=`<svg viewBox="0 0 36 36" width="34" height="34"><circle cx="18" cy="18" r="15" fill="none" stroke="var(--tg-border)" stroke-width="4"/><circle class="cp" cx="18" cy="18" r="15" fill="none" stroke="var(--tg-blue)" stroke-width="4" stroke-linecap="round" stroke-dasharray="94.2" stroke-dashoffset="94.2" transform="rotate(-90 18 18)"/></svg>`;
  const cp=wrap.querySelector('.cp');
  return {el:wrap,set(p){cp.style.strokeDashoffset=String(94.2*(1-Math.max(0,Math.min(1,p))));}};
}
function getUploads(){
  let u=document.getElementById('uploads');
  if(!u){u=document.createElement('div');u.id='uploads';u.style.cssText='position:absolute;left:0;right:0;bottom:64px;display:flex;flex-direction:column;gap:6px;padding:0 12px;z-index:6;pointer-events:none;';document.getElementById('chat').appendChild(u);}
  return u;
}
async function sendFiles(files){
  if(!currentEntity)return;
  for(const f of files){
    const isImage=/^image\//.test(f.type||'');
    const isVideo=/^video\//.test(f.type||'');
    const card=document.createElement('div');card.className='up-card';card.style.pointerEvents='auto';
    const circ=makeCircle();const name=document.createElement('div');name.className='up-name';name.textContent=f.name;
    card.append(circ.el,name);getUploads().appendChild(card);
    try{
      // 把浏览器 File 读成 ArrayBuffer 再包成 CustomFile（gramJS 最稳路径），带进度
      const buf=await f.arrayBuffer();
      const cf=new CustomFile(f.name,buf.byteLength,'',buf);
      const opts={file:cf,progressCallback:p=>circ.set(p)};
      if(isVideo){opts.mimeType=f.type||'video/mp4';opts.supportsStreaming=true;}
      else if(isImage){opts.mimeType=f.type;}
      else {opts.forceDocument=true;}
      const m=await client.sendFile(currentEntity,opts);
      card.remove();
      if(m)appendMessage(m,false);
      el.messages.scrollTop=el.messages.scrollHeight;
    }catch(err){
      // 回退：去掉流式/视频属性再发一次
      try{
        const buf2=await f.arrayBuffer();
        const cf2=new CustomFile(f.name,buf2.byteLength,'',buf2);
        const m=await client.sendFile(currentEntity,{file:cf2,forceDocument:!isImage&&!isVideo});
        card.remove();if(m)appendMessage(m,false);el.messages.scrollTop=el.messages.scrollHeight;
      }catch(err2){card.remove();toast('发送失败：'+(err2&&err2.message?err2.message:err2));}
    }
  }
}

// ===== 删除 =====
async function deleteMessage(id){
  if(!confirm('确定删除这条消息？'))return;
  try{await client.deleteMessages(currentEntity,[id],{revoke:true});
    const row=[...el.messages.querySelectorAll('.msg')].find(b=>b.dataset.id==id);
    if(row)row.closest('.row').remove();toast('已删除');
  }catch(e){toast('删除失败：'+e.message);}
}

// ===== 下载 / 分享 =====
async function downloadMedia(msg){
  try{const info=mediaInfo(msg);const name=info?info.name:'file';
    const buf=await client.downloadMedia(msg);if(!buf||!buf.length){toast('下载为空');return;}
    const mime=info?info.mime:'application/octet-stream';
    const url=URL.createObjectURL(new Blob([buf],{type:mime}));
    const a=document.createElement('a');a.href=url;a.download=name;a.click();
    setTimeout(()=>URL.revokeObjectURL(url),10000);
  }catch(e){toast('下载失败：'+e.message);}
}
async function shareMedia(msg){
  const info=mediaInfo(msg);const name=info?info.name:'文件';
  if(navigator.share){try{const buf=await client.downloadMedia(msg);const file=new File([buf],name,{type:info?info.mime:'application/octet-stream'});await navigator.share({files:[file],title:name});return;}catch(e){}}
  let link='';if(msg.chat&&msg.chat.username)link=`https://t.me/${msg.chat.username}/${msg.id}`;else if(currentEntity&&currentEntity.username)link=`https://t.me/${currentEntity.username}/${msg.id}`;
  if(link){await navigator.clipboard.writeText(link);toast('链接已复制');}else toast('该消息无可分享链接');
}

// ===== 媒体查看器 =====
function openViewer(list,idx,mode,entity){viewerList=list;viewerIndex=idx;viewerMode=mode;viewerEntity=entity||currentEntity;renderViewer();el.viewer.classList.add('open');prefetchAround();}
// 预取相邻媒体（上一条/下一条），左右切换时秒开、不卡
function prefetchAround(){
  const mimeFor=d=>(d.video&&d.video.mimeType)||(d.document&&d.document.mimeType)||'video/mp4';
  for(const d of [viewerList[viewerIndex-1],viewerList[viewerIndex+1]]){
    if(!d)continue;
    const k=getMediaKey(viewerEntity,d,'full');
    if(mediaCache.has(k))continue;
    const i=mediaInfo(d);
    if(i&&(i.type==='video'||i.type==='gif'||i.type==='image')){
      enqueueDownload(()=>client.downloadMedia(d)).then(buf=>{
        if(buf&&buf.length)mediaCache.set(k,URL.createObjectURL(new Blob([buf],{type:i.type==='image'?'image/jpeg':mimeFor(d)})));
      }).catch(()=>{});
    }
  }
}
let viewerToken=0;
function renderViewer(){
  const msg=viewerList[viewerIndex];if(!msg){closeViewer();return;}
  const info=mediaInfo(msg);const key=getMediaKey(viewerEntity,msg,'full');
  const myToken=++viewerToken;                 // 防抖：仅最新一次导航的下载生效，避免左右切换卡顿/串片
  el.viewerVideo.style.display='none';el.viewerMedia.style.display='none';el.viewerCap.textContent='';
  try{el.viewerVideo.pause();el.viewerVideo.removeAttribute('src');el.viewerVideo.poster='';}catch(e){}
  async function safePlay(v){try{await v.play();}catch(e){if(e&&e.name!=='AbortError')console.warn('viewer play error',e);}}
  // 进度遮罩（复用）
  let prog=document.getElementById('viewerProgress');
  if(!prog){prog=document.createElement('div');prog.id='viewerProgress';prog.innerHTML='<i></i>';el.viewer.appendChild(prog);}
  const setP=(p)=>{prog.style.display='block';prog.firstChild.style.width=Math.max(0,Math.min(100,p*100))+'%';};
  prog.style.display='none';

  if(info&&(info.type==='video'||info.type==='gif')){
    el.viewerVideo.style.display='block';
    if(mediaCache.has(key)){prog.style.display='none';el.viewerVideo.src=mediaCache.get(key);safePlay(el.viewerVideo);return;}
    const mime=(msg.video&&msg.video.mimeType)||(msg.document&&msg.document.mimeType)||'video/mp4';
    // 先快速拉缩略图作占位，切换时立即可见，不再“等十几秒黑屏”
    client.downloadMedia(msg,{thumb:'m'}).then(buf=>{if(buf&&buf.length&&myToken===viewerToken){el.viewerVideo.poster=URL.createObjectURL(new Blob([buf],{type:'image/jpeg'}));}}).catch(()=>{});
    setP(0);
    enqueueDownload(()=>client.downloadMedia(msg,{progressCallback:p=>{if(myToken===viewerToken)setP(p);}})).then(buf=>{
      if(myToken!==viewerToken)return;
      if(!buf||!buf.length){prog.style.display='none';el.viewerCap.textContent='❌ 加载失败';return;}
      const url=URL.createObjectURL(new Blob([buf],{type:mime}));mediaCache.set(key,url);
      prog.style.display='none';el.viewerVideo.src=url;safePlay(el.viewerVideo);
    }).catch(()=>{if(myToken===viewerToken){prog.style.display='none';el.viewerCap.textContent='❌ 加载失败';}});
  }else if(info&&info.type==='image'){
    el.viewerMedia.style.display='block';
    if(mediaCache.has(key)){el.viewerMedia.src=mediaCache.get(key);return;}
    client.downloadMedia(msg,{progressCallback:p=>{if(myToken===viewerToken)setP(p);}}).then(buf=>{if(myToken!==viewerToken)return;if(buf&&buf.length){const url=URL.createObjectURL(new Blob([buf],{type:'image/jpeg'}));mediaCache.set(key,url);el.viewerMedia.src=url;}}).catch(()=>{if(myToken===viewerToken){prog.style.display='none';el.viewerCap.textContent='❌ 加载失败';}});
  }else if(info&&info.type==='audio'){
    el.viewerVideo.style.display='block';el.viewerVideo.controls=true;
    if(mediaCache.has(key)){prog.style.display='none';el.viewerVideo.src=mediaCache.get(key);safePlay(el.viewerVideo);return;}
    setP(0);
    client.downloadMedia(msg,{progressCallback:p=>{if(myToken===viewerToken)setP(p);}}).then(buf=>{if(myToken!==viewerToken)return;if(buf&&buf.length){const url=URL.createObjectURL(new Blob([buf],{type:info.mime||'audio/mpeg'}));mediaCache.set(key,url);prog.style.display='none';el.viewerVideo.src=url;safePlay(el.viewerVideo);}}).catch(()=>{if(myToken===viewerToken){prog.style.display='none';el.viewerCap.textContent='❌ 加载失败';}});
  }else{
    el.viewerMedia.style.display='block';el.viewerMedia.alt='[文件] '+(info?info.name:'');el.viewerCap.textContent=(info?info.name:'')+'  ·  '+fmtSize(info?info.size:0);
  }
}
function closeViewer(){el.viewer.classList.remove('open');try{el.viewerVideo.pause();el.viewerVideo.removeAttribute('src');}catch(e){}const p=document.getElementById('viewerProgress');if(p)p.style.display='none';}
el.viewerClose.onclick=closeViewer;
el.viewerPrev.onclick=()=>{if(viewerIndex>0){viewerIndex--;renderViewer();}};
el.viewerNext.onclick=()=>{if(viewerIndex<viewerList.length-1){viewerIndex++;renderViewer();}};
el.viewerDownload.onclick=()=>{if(viewerList&&viewerList[viewerIndex])downloadMedia(viewerList[viewerIndex]);};
el.viewerShare.onclick=()=>{if(viewerList&&viewerList[viewerIndex])shareMedia(viewerList[viewerIndex]);};
let touchX=null;
el.viewer.addEventListener('touchstart',e=>touchX=e.touches[0].clientX);
el.viewer.addEventListener('touchend',e=>{if(touchX===null)return;const dx=e.changedTouches[0].clientX-touchX;if(dx>60&&viewerIndex>0){viewerIndex--;renderViewer();}else if(dx<-60&&viewerIndex<viewerList.length-1){viewerIndex++;renderViewer();}touchX=null;});
document.addEventListener('keydown',e=>{if(!el.viewer.classList.contains('open'))return;if(e.key==='ArrowLeft'&&viewerIndex>0){viewerIndex--;renderViewer();}if(e.key==='ArrowRight'&&viewerIndex<viewerList.length-1){viewerIndex++;renderViewer();}if(e.key==='Escape')closeViewer();});

// ===== 媒体浏览器（全部视频/图片）=====
el.mediaBrowserClose.onclick=()=>el.mediaBrowser.classList.remove('open');
async function openMediaBrowser(type){
  if(!currentEntity)return;
  currentMediaBrowserType=type;
  el.mediaBrowserTitle.textContent=(type==='video'?'全部视频':type==='image'?'全部图片':type==='gif'?'全部GIF':type==='audio'?'全部音频':'全部文件');
  el.mediaBrowserGrid.className=mediaBrowserView==='list'?'list-mode':'';
  el.mediaBrowserGrid.innerHTML='<div class="loading-spinner"></div>';
  el.mediaBrowser.classList.add('open');
  try{
    // 分页抓取，避免最近 100 条里没图片/视频就显示为空
    const list=[];
    let offsetId=null,total=0;
    const MAX_TOTAL=500,TARGET=30;
    while(total<MAX_TOTAL && list.length<TARGET){
      const opts={limit:100};if(offsetId)opts.offsetId=offsetId;
      const msgs=await client.getMessages(currentEntity,opts);
      if(!msgs||!msgs.length)break;
      total+=msgs.length;
      for(const m of msgs){
        const i=mediaInfo(m);if(!i)continue;
        if(type==='video'&&i.type!=='video')continue;
        if(type==='image'&&i.type!=='image'&&i.type!=='gif')continue;
        if(type==='gif'&&i.type!=='gif')continue;
        if(type==='audio'&&i.type!=='audio')continue;
        if(type==='file'&&i.type!=='file')continue;
        list.push(m);
      }
      offsetId=msgs[msgs.length-1].id;
      if(msgs.length<100)break;  // 已到底
    }
    el.mediaBrowserGrid.innerHTML='';
    if(!list.length){el.mediaBrowserGrid.innerHTML='<div class="empty-hint">暂无</div>';return;}
    list.forEach((msg,i)=>{
      const info=mediaInfo(msg);
      if(mediaBrowserView==='list'){
        const row=document.createElement('div');row.className='nk-row';
        const th=document.createElement('div');th.className='nk-thumb sm';
        if(info.type==='video')th.classList.add('play');else if(info.type!=='image'&&info.type!=='gif')th.innerHTML=ICONS.file;
        th._thumbMsg=msg;th._cacheKey='mb:'+msg.id;th._entity=currentEntity;
        const meta=document.createElement('div');meta.className='nk-meta';
        meta.innerHTML=`<div class="nk-name">${escapeHtml(info.name)}</div><div class="nk-sub">${info.type} · ${fmtSize(info.size)}</div>`;
        row.append(th,meta);row.onclick=()=>{el.mediaBrowser.classList.remove('open');openViewer(list,i,'browser',currentEntity);};
        el.mediaBrowserGrid.appendChild(row);
        if(th._thumbMsg)loadThumb(th,msg);
      }else{
        const card=document.createElement('div');card.className='mb-card';
        const titleBar=document.createElement('div');titleBar.className='mb-name-bar';titleBar.textContent=chatName(currentEntity);
        const th=document.createElement('div');th.className='mb-thumb';
        if(info.type==='video'||info.type==='gif')th.classList.add('play');
        th._thumbMsg=msg;th._cacheKey='mb:'+msg.id;th._entity=currentEntity;
        const footer=document.createElement('div');footer.className='mb-footer';
        const nm=document.createElement('div');nm.className='mb-name';nm.textContent=info.name;
        const tm=document.createElement('div');tm.className='mb-time';tm.textContent=msg.date?fmtTime(msg.date).split(' ')[1]:'';
        footer.append(nm,tm);
        card.append(titleBar,th,footer);
        card.onclick=()=>{el.mediaBrowser.classList.remove('open');openViewer(list,i,'browser',currentEntity);};
        el.mediaBrowserGrid.appendChild(card);
        loadThumb(th,msg);
      }
    });
  }catch(e){el.mediaBrowserGrid.innerHTML='<div class="empty-hint">加载失败</div>';}
}

// ===== 右侧详情 + 媒体统计 =====
async function loadDetails(entity){
  el.detailsPlaceholder.style.display='none';el.detailsContent.classList.add('show');
  el.dName.textContent=chatName(entity);
  el.dSub.textContent=entity.className==='User'?(entity.username?('@'+entity.username):(entity.phone||'')):(entity.className==='Channel'?(entity.megaGroup?'群组':'频道'):'群组');
  await loadAvatarInto(el.dAvatar,entity);
  el.dAbout.textContent='加载中…';el.dStat.innerHTML='';
  let members=0;
  try{
    let about='';
    if(entity.className==='User'){const r=await client.invoke(new Api.users.GetFullUser({id:await client.getInputEntity(entity)}));about=r.fullUser.about||'';}
    else{const r=await client.invoke(new Api.channels.GetFullChannel({channel:await client.getInputEntity(entity)}));about=r.fullChat.about||'';members=r.fullChat.participantsCount||0;}
    el.dAbout.textContent=about||'暂无简介';
  }catch(e){el.dAbout.textContent='';}
  loadMediaStats(entity,false,members);
}
let mediaStatsState={video:{c:0,s:0},image:{c:0,s:0},gif:{c:0,s:0},audio:{c:0,s:0},file:{c:0,s:0},link:0,total:0,lastId:null,loading:false,entity:null,members:0};
async function loadMediaStats(entity,loadMore=false,members=0){
  if(!loadMore){
    mediaStatsState={video:{c:0,s:0},image:{c:0,s:0},gif:{c:0,s:0},audio:{c:0,s:0},file:{c:0,s:0},link:0,total:0,lastId:null,loading:false,entity,members,done:false};
    el.dStat.innerHTML='<div class="stat-row"><div class="stat-label">'+ICONS.refresh+'<span>正在统计…</span></div><div class="stat-val">—</div></div>';
    el.dStatMore.innerHTML='';el.dStatMore.style.display='none';
  }
  if(mediaStatsState.loading||mediaStatsState.total>=2000||mediaStatsState.done)return;
  mediaStatsState.loading=true;
  try{
    const opts={limit:100};if(mediaStatsState.lastId)opts.offsetId=mediaStatsState.lastId;
    const msgs=await client.getMessages(entity,opts);
    if(!msgs||!msgs.length){mediaStatsState.done=true;renderMediaStats(true);mediaStatsState.loading=false;return;}
    for(const m of msgs){
      const i=mediaInfo(m);
      if(i){mediaStatsState.total++;const st=mediaStatsState[i.type];if(st){st.c++;st.s+=i.size||0;}}
      if(m.message&&/https?:\/\//.test(m.message))mediaStatsState.link++;
    }
    mediaStatsState.lastId=msgs[msgs.length-1].id;
    renderMediaStats(false);
    // 自动继续统计，直到 2000 条、已到底或用户停止
    if(mediaStatsState.total<2000&&msgs.length>=100){setTimeout(()=>loadMediaStats(entity,true),30);}
    else{mediaStatsState.done=true;renderMediaStats(true);}
  }catch(e){
    el.dStatMore.innerHTML=`<span class="stat-sub" style="color:var(--tg-danger);">统计出错：${escapeHtml(e.message||e)}</span>`;
    el.dStatMore.style.display='block';
  }
  mediaStatsState.loading=false;
}
function renderMediaStats(done){
  const s=mediaStatsState;
  const rows=[
    ...(s.members?[{k:'members',l:'成员',icon:ICONS.users,clickable:false}]:[]),
    {k:'video',l:'视频',icon:ICONS.video,clickable:true},
    {k:'image',l:'图片',icon:ICONS.image,clickable:true},
    {k:'gif',l:'GIF',icon:ICONS.image,clickable:true},
    {k:'audio',l:'音频',icon:ICONS.audio,clickable:true},
    {k:'file',l:'文件',icon:ICONS.file,clickable:true},
    {k:'link',l:'链接',icon:ICONS.link,clickable:false},
  ];
  el.dStat.innerHTML=rows.map(r=>{
    let val,size='';
    if(r.k==='members'){val=s.members;}
    else if(r.k==='link'){val=s.link;}
    else{val=s[r.k].c;size=fmtSize(s[r.k].s);}
    const cls=r.clickable?'stat-row clickable':'stat-row';
    const data=r.clickable?`data-t="${r.k}"`:'',
          sizeHtml=size?`<div class="stat-sub">${size}</div>`:'';
    return `<div class="${cls}" ${data}><div class="stat-label">${r.icon}<span>${r.l}</span></div><div style="text-align:right;"><div class="stat-val">${val}</div>${sizeHtml}</div></div>`;
  }).join('');
  el.dStat.querySelectorAll('.clickable').forEach(d=>d.onclick=()=>openMediaBrowser(d.dataset.t));
  if(done||s.total>=2000){
    el.dStatMore.innerHTML=`<span class="stat-sub">已统计 ${s.total} 条消息${s.total>=2000?'（已达上限）':''}</span>`;
    el.dStatMore.style.display='block';
  }else{
    el.dStatMore.innerHTML=`<span class="stat-sub">已统计 ${s.total} 条… <button id="btnLoadMoreStats" style="color:var(--tg-blue);font-weight:600;">立即继续</button></span>`;
    el.dStatMore.style.display='block';
    const btn=$('btnLoadMoreStats');if(btn)btn.onclick=()=>loadMediaStats(mediaStatsState.entity,true);
  }
}

// ===== 聊天菜单：加入 / 退出 / 删除 / 详情 =====
el.btnChatMenu.onclick=(ev)=>{
  if(!currentEntity)return;const m=el.chatMenu;m.innerHTML='';
  if(isGroup(currentEntity)){
    if(currentEntity.className==='Channel'&&!currentEntity.megaGroup){const b=document.createElement('button');b.textContent=currentEntity.left?'加入频道':'退出频道';b.onclick=()=>{currentEntity.left?joinChannel(currentEntity):leaveChannel(currentEntity);hideMenu();};m.appendChild(b);}
    else{const b=document.createElement('button');b.textContent='退出群组';b.className='danger';b.onclick=()=>{leaveChannel(currentEntity);hideMenu();};m.appendChild(b);}
  }else{const b=document.createElement('button');b.textContent='删除对话';b.className='danger';b.onclick=()=>{deleteChat(currentEntity);hideMenu();};m.appendChild(b);}
  const b2=document.createElement('button');b2.textContent='查看详情';b2.onclick=()=>{hideMenu();openDetailsMobile();};m.appendChild(b2);
  const r=ev.target.getBoundingClientRect();m.style.top=(r.bottom+6)+'px';m.style.left=(r.left-160)+'px';m.classList.add('open');
};
function openDetailsMobile(){el.details.classList.add('mobile-open');loadDetails(currentEntity);}
function hideMenu(){el.chatMenu.classList.remove('open');}
document.addEventListener('click',e=>{if(!e.target.closest('#btnChatMenu')&&!e.target.closest('#chatMenu'))hideMenu();});
async function joinChannel(entity){try{await client.invoke(new Api.channels.JoinChannel({channel:await client.getInputEntity(entity)}));toast('已加入');loadDialogs();}catch(e){toast('加入失败：'+e.message);}}
async function leaveChannel(entity){if(!confirm('确定退出？'))return;try{await client.invoke(new Api.channels.LeaveChannel({channel:await client.getInputEntity(entity)}));toast('已退出');backToSidebar();loadDialogs();}catch(e){toast('退出失败：'+e.message);}}
async function deleteChat(entity){if(!confirm('确定删除该对话？'))return;try{await client.invoke(new Api.messages.DeleteHistory({peer:await client.getInputEntity(entity),maxId:0}));toast('已删除');backToSidebar();loadDialogs();}catch(e){toast('删除失败：'+e.message);}}

// ===== 设置面板（左侧）=====
el.btnMenu.onclick=()=>el.settings.classList.add('open');
el.btnSettingsClose.onclick=()=>el.settings.classList.remove('open');
el.segTheme.querySelectorAll('button').forEach(b=>b.onclick=()=>{localStorage.setItem('tg_theme',b.dataset.v);applyTheme();});
el.segAccent.querySelectorAll('button').forEach(b=>b.onclick=()=>{localStorage.setItem('tg_accent',b.dataset.v);applyTheme();});
document.querySelectorAll('.bg-swatch').forEach(s=>s.onclick=()=>{localStorage.setItem('tg_chat_bg',JSON.stringify({type:'color',value:s.dataset.bg}));applyChatBg();});
el.btnBgImage.onclick=()=>el.bgFileInput.click();
el.bgFileInput.onchange=async(e)=>{const f=e.target.files[0];if(!f)return;const url=await new Promise(r=>{const fr=new FileReader();fr.onload=()=>r(fr.result);fr.readAsDataURL(f);});localStorage.setItem('tg_chat_bg',JSON.stringify({type:'image',value:url}));applyChatBg();e.target.value='';};
el.btnBgReset.onclick=()=>{localStorage.removeItem('tg_chat_bg');applyChatBg();};
el.btnLogout.onclick=()=>{if(confirm('退出登录将清除本地登录态')){localStorage.removeItem('tg_session');localStorage.removeItem('tg_self');location.reload();}};

// ===== 网盘（全屏）=====
function fillNetdiskSelect(){
  const saved=localStorage.getItem('tg_netdisk')||'';
  el.netdiskSelect.innerHTML='<option value="">— 请选择频道 —</option>';
  for(const d of currentDialogs){if(d.entity.className==='Channel'){const o=document.createElement('option');o.value=String(d.id);o.textContent=chatName(d.entity);el.netdiskSelect.appendChild(o);}}
  if(saved)el.netdiskSelect.value=saved;
}
el.btnEnterNetdisk.onclick=()=>{
  let id=el.netdiskSelect.value||localStorage.getItem('tg_netdisk');
  if(!id){toast('请先在上方选择网盘频道');return;}
  const ent=currentDialogs.find(d=>String(d.id)===id)?.entity;if(!ent){toast('未找到该频道');return;}
  netdiskChannel=ent;localStorage.setItem('tg_netdisk',id);
  el.settings.classList.remove('open');
  el.netdisk.classList.add('open');
  loadNetdisk(el.netdiskTabs.querySelector('.sel').dataset.cat);
};
el.btnNetdiskBack.onclick=el.btnNetdiskClose.onclick=()=>el.netdisk.classList.remove('open');
el.netdiskTabs.addEventListener('click',e=>{const b=e.target.closest('button');if(!b)return;el.netdiskTabs.querySelectorAll('button').forEach(x=>x.classList.remove('sel'));b.classList.add('sel');loadNetdisk(b.dataset.cat);});
el.btnNetdiskView.onclick=()=>{netdiskView=netdiskView==='card'?'list':'card';el.btnNetdiskView.textContent=netdiskView==='card'?'☰ 列表':'▦ 卡片';renderNetdisk(currentNetdiskCat);};
el.btnMediaView.onclick=()=>{mediaBrowserView=mediaBrowserView==='card'?'list':'card';el.btnMediaView.textContent=mediaBrowserView==='card'?'☰ 列表':'▦ 卡片';openMediaBrowser(currentMediaBrowserType);};
async function loadNetdisk(cat){
  if(!netdiskChannel)return;
  currentNetdiskCat=cat;
  el.netdiskGrid.innerHTML='<div class="loading-spinner"></div>';
  try{const msgs=await client.getMessages(netdiskChannel,{limit:100});netdiskMediaList=msgs.filter(m=>mediaInfo(m));renderNetdisk(cat);}
  catch(e){el.netdiskGrid.innerHTML='<div class="empty-hint">加载失败：'+e.message+'</div>';}
}
function renderNetdisk(cat){
  const list=cat==='all'?netdiskMediaList:netdiskMediaList.filter(m=>netdiskCategory(m)===cat);
  el.netdiskGrid.className=netdiskView==='list'?'list-mode':'';
  el.netdiskGrid.innerHTML='';
  if(!list.length){el.netdiskGrid.innerHTML='<div class="empty-hint">暂无文件</div>';return;}
  const chName=chatName(netdiskChannel);
  list.forEach((msg,i)=>{
    const info=mediaInfo(msg);
    if(netdiskView==='list'){
      const row=document.createElement('div');row.className='nk-row';
      const th=document.createElement('div');th.className='nk-thumb sm';
      th._thumbMsg=msg;th._cacheKey=netdiskChannel.id+':'+msg.id;th._entity=netdiskChannel;
      if(info.type==='video')th.classList.add('play');else if(info.type!=='image'&&info.type!=='gif')th.innerHTML=ICONS.file;
      const meta=document.createElement('div');meta.className='nk-meta';
      meta.innerHTML=`<div class="nk-name">${escapeHtml(info.name)}</div><div class="nk-sub">${info.type} · ${fmtSize(info.size)}</div>`;
      row.append(th,meta);row.onclick=()=>openViewer(list,i,'netdisk',netdiskChannel);
      el.netdiskGrid.appendChild(row);
      loadThumb(th,msg);
    }else{
      const card=document.createElement('div');card.className='nk-card';
      const nameBar=document.createElement('div');nameBar.className='nk-name-bar';nameBar.textContent=chName;
      const th=document.createElement('div');th.className='nk-thumb';
      th._thumbMsg=msg;th._cacheKey=netdiskChannel.id+':'+msg.id;th._entity=netdiskChannel;
      if(info.type==='video')th.classList.add('play');else if(info.type!=='image'&&info.type!=='gif')th.innerHTML=ICONS.file;
      const footer=document.createElement('div');footer.className='nk-footer';
      const nm=document.createElement('div');nm.className='nk-name';nm.textContent=info.name;
      const tm=document.createElement('div');tm.className='nk-time';tm.textContent=msg.date?fmtTime(msg.date).split(' ')[1]:'';
      footer.append(nm,tm);
      card.append(nameBar,th,footer);card.onclick=()=>openViewer(list,i,'netdisk',netdiskChannel);
      el.netdiskGrid.appendChild(card);
      loadThumb(th,msg);
    }
  });
}
el.btnNetdiskUpload.onclick=()=>el.netdiskFileInput.click();
el.netdiskFileInput.addEventListener('change',async(e)=>{
  if(!netdiskChannel)return;
  for(const f of e.target.files){
    try{
      const isImage=/^image\//.test(f.type||'');const isVideo=/^video\//.test(f.type||'');
      const buf=await f.arrayBuffer();
      const cf=new CustomFile(f.name,buf.byteLength,'',buf);
      const opts={file:cf};
      if(isVideo){opts.mimeType=f.type||'video/mp4';opts.supportsStreaming=true;}
      else if(isImage){opts.mimeType=f.type;}
      else {opts.forceDocument=true;}
      await client.sendFile(netdiskChannel,opts);
    }catch(err){
      try{const buf2=await f.arrayBuffer();const cf2=new CustomFile(f.name,buf2.byteLength,'',buf2);await client.sendFile(netdiskChannel,{file:cf2,forceDocument:!isImage&&!isVideo});}
      catch(err2){toast('上传失败：'+(err2&&err2.message?err2.message:err2));}
    }
  }
  e.target.value='';loadNetdisk(el.netdiskTabs.querySelector('.sel').dataset.cat);
});

// ===== 实时消息 =====
async function onNewMessage(event){
  const msg=event.message;if(!msg||!msg.message&&!msg.media)return;
  if(currentEntity&&msg.chat&&msg.chat.id===currentEntity.id){appendMessage(msg,false);el.messages.scrollTop=el.messages.scrollHeight;}
  if(netdiskChannel&&msg.chat&&msg.chat.id===netdiskChannel.id){if(mediaInfo(msg)){netdiskMediaList.unshift(msg);renderNetdisk(el.netdiskTabs.querySelector('.sel').dataset.cat);}}
}

// ===== 移动端：详情关闭按钮 / 额外样式 =====
function setupDetailsClose(){
  const head=document.createElement('div');head.className='panel-head';head.style.cssText='display:none;';
  head.innerHTML=`<button class="icon-btn" id="detailsBack"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M19 12H5"/><path d="m12 19-7-7 7-7"/></svg></button> 详情`;
  el.details.insertBefore(head,el.details.firstChild);
  $('detailsBack').onclick=()=>el.details.classList.remove('mobile-open');
}
function injectMobileCss(){
  const s=document.createElement('style');
  s.textContent=`@media(max-width:768px){#details.mobile-open{display:flex !important;}#details.mobile-open .panel-head{display:flex !important;}#details .panel-head{background:var(--tg-panel);border-bottom:1px solid var(--tg-border);}}`;
  document.head.appendChild(s);
}

// ===== 返回（移动端）=====
function backToSidebar(){currentEntity=null;document.body.classList.remove('chat-open');el.chatHeader.style.display='none';el.composer.style.display='none';el.messages.innerHTML='<div class="empty-hint">选择左侧对话开始聊天</div>';el.detailsContent.classList.remove('show');el.detailsPlaceholder.style.display='flex';el.details.classList.remove('mobile-open');}
el.btnBack.onclick=backToSidebar;

init();
