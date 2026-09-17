import { TelegramClient, Api } from 'telegram';
import { StringSession } from 'telegram/sessions';
import { PromisedWebSockets } from 'telegram/extensions/PromisedWebSockets';
import { CustomFile } from 'telegram/client/uploads';
import { NewMessage } from 'telegram/events';

// ===== 安全存储兜底（必须在所有 localStorage 访问之前）=====
// 部分手机浏览器/WebView（隐私模式、拦截 Cookie、国内"极速"内核）访问 localStorage 会直接抛
// SecurityError；一旦在模块顶层抛出，整个应用都不会运行（屏显表现为 build=undefined）。
// 这里统一兜底：读不到→内存，写不进→内存，绝不在顶层抛错。
const _memStore={};
// cookie 兜底：手机隐私模式下 localStorage 常被禁/不持久，cookie 通常仍能跨刷新保留关键配置与登录态
function _cGet(k){ try{ const m=document.cookie.match('(^|; )'+k+'=([^;]*)'); if(m)return decodeURIComponent(m[2]); }catch(e){} return null; }
function _cSet(k,v){ try{ document.cookie=k+'='+encodeURIComponent(v)+';path=/;max-age='+(365*86400)+';samesite=lax'; }catch(e){} }
function sGet(k){ try{ const v=window.localStorage.getItem(k); if(v!==null&&v!==undefined)return v; }catch(e){} const c=_cGet(k); if(c!==null)return c; return (k in _memStore)?_memStore[k]:null; }
function sSet(k,v){ try{ window.localStorage.setItem(k,String(v)); }catch(e){} _cSet(k,String(v)); _memStore[k]=String(v); }
function sDel(k){ try{ window.localStorage.removeItem(k); }catch(e){} try{ document.cookie=k+'=;path=/;max-age=0'; }catch(e){} delete _memStore[k]; }

// ===== 配置 =====
// 版本标记：F12 控制台看这行日志即可确认部署是否更新（应与最新发布说明一致）
const BUILD='v2026.09.18.2';
console.log('[tg] build', BUILD, '· 修复登录根因：sendCode 参数签名错误(手机号传成了undefined) + client.signIn不存在改用auth.SignIn + 两步验证支持');
// 配置三级回退：构建期环境变量(VITE_*) → 页面全局 window.__TG_CONFIG → localStorage/内存
// 这样即便直接上传未带密钥的 dist，也能在登录卡片里填一次 API_ID/HASH/代理，免去反复重新打包
function _readCfg(){
  const env=import.meta.env||{};
  const w=(typeof window!=='undefined'&&window.__TG_CONFIG)||{};
  return {
    apiId: env.VITE_API_ID||w.apiId||sGet('tg_api_id')||'',
    apiHash: env.VITE_API_HASH||w.apiHash||sGet('tg_api_hash')||'',
    proxy: env.VITE_PROXY_DOMAIN||w.proxy||sGet('tg_proxy')||'',
  };
}
const _cfg=_readCfg();
// 注意：用 let 而非 const —— 表单保存时要在运行时更新（手机端 localStorage 不稳定，不能依赖刷新页面来重新读取）
let API_ID = parseInt(_cfg.apiId||'0',10)||0;
let API_HASH = _cfg.apiHash||'';
let PROXY_DOMAIN = _cfg.proxy||'';
// 暴露配置状态到全局，供页面上的“屏显诊断”读取（无需 F12）
function _syncCfg(){
  window.__CFG={build:BUILD, api:!!API_ID, hash:!!API_HASH, proxy:PROXY_DOMAIN||'(未设置)'};
  try{ const t=document.getElementById('buildTag'); if(t)t.textContent='build '+BUILD+' · API:'+(API_ID?'✓':'✗')+' 代理:'+(PROXY_DOMAIN?PROXY_DOMAIN.slice(0,18):'未设'); }catch(e){}
}
_syncCfg();
// 设置栏底部可点击版本号（构建版本 + 配置状态），点击显示环境诊断（只读，不再弹输入框）
try{
  let t=document.getElementById('buildTag');
  if(!t){ // 兜底：动态插到设置面板底部
    const pb=document.querySelector('#settings .panel-body');
    t=document.createElement('div'); t.id='buildTag';
    if(pb) pb.appendChild(t); else document.body.appendChild(t);
  }
  t.style.pointerEvents='auto'; t.style.cursor='pointer';
  t.onclick=function(){showEnvMissing(true);};
  _syncCfg();
}catch(e){}

// ===== 代理：重写 GramJS 内部 WebSocket 地址 =====
class ProxiedWebSockets extends PromisedWebSockets {
  getWebSocketLink(ip, port, testServers) {
    const path = `/apiws${testServers ? '_test' : ''}`;
    if (PROXY_DOMAIN) {
      // https 页面用 wss，http（本地调试）用 ws
      const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
      const url = `${scheme}://${PROXY_DOMAIN}/${ip}${path}`;
      console.info('[tg] WebSocket →', url);
      return url;
    }
    const direct = super.getWebSocketLink(ip, port, testServers);
    console.warn('[tg] WebSocket 直连（未走代理）→', direct, '—— 国内环境大概率连接超时！');
    return direct;
  }
  // 覆盖 connect：显式把二进制类型设为 arraybuffer（移动端 WebView 默认是 blob，
  // 配合下方 receive() 直接 Buffer.from(arraybuffer)，避免 new Response(blob) 在部分移动端解析异常）
  async connect(port, ip, testServers = false) {
    const p = await super.connect(port, ip, testServers);
    try { this.client && (this.client.binaryType = 'arraybuffer'); } catch (e) {}
    return p;
  }
  // 覆盖 receive：健壮地把 WS 收到的二进制转成 Buffer，兼容 ArrayBuffer / Blob / 字符串，
  // 不再依赖 new Response(message.data).arrayBuffer()（部分移动端 WebView 不支持）
  async receive() {
    const self = this;
    if (!this.client) return;
    this.client.onmessage = async (message) => {
      let data;
      try {
        const md = message.data;
        if (typeof ArrayBuffer !== 'undefined' && md instanceof ArrayBuffer) {
          data = Buffer.from(md);
        } else if (typeof Blob !== 'undefined' && md instanceof Blob) {
          data = Buffer.from(await md.arrayBuffer());
        } else if (typeof md === 'string') {
          data = Buffer.from(md, 'binary');
        } else if (md && md.buffer) {
          // Uint8Array / Buffer
          data = Buffer.from(md);
        } else {
          data = Buffer.from(md);
        }
      } catch (e) {
        console.warn('[tg] WS 数据解析失败（已忽略该包）：', e && e.message);
        return;
      }
      this.stream = Buffer.concat([this.stream, data]);
      if (this.resolveRead) this.resolveRead(true);
    };
  }
}
if (!PROXY_DOMAIN) console.warn('[tg] 未设置 VITE_PROXY_DOMAIN，将直连 Telegram（国内大概率失败）。');
// 代理按“调用时”读取 PROXY_DOMAIN，保证表单里改了代理也能立即生效（不再依赖刷新）
const _origFetch = self.fetch;
self.fetch = function (input, init) {
  let s = typeof input === 'string' ? input : (input?.url || '');
  if (PROXY_DOMAIN && s.includes('telegram.org') && !s.includes(PROXY_DOMAIN)) {
    try { const u = new URL(s); s = `https://${PROXY_DOMAIN}/${u.hostname}${u.pathname}${u.search}`; input = typeof input === 'string' ? s : new Request(s, input); } catch (e) {}
  }
  return _origFetch.call(self, input, init);
};

// ===== DOM =====
const $ = (id) => document.getElementById(id);
const _elRaw = {
  dialogs: $('dialogs'), searchInput: $('searchInput'),
  chatHeader: $('chatHeader'), chatAvatar: $('chatAvatar'),
  chatTitle: $('chatTitle'), chatStatus: $('chatStatus'),
  messages: $('messages'), composer: $('composer'),
  msgInput: $('msgInput'), btnSend: $('btnSend'), btnAttach: $('btnAttach'),
  fileInput: $('fileInput'), btnBack: $('btnBack'),
  btnMenu: $('btnMenu'), btnChatMenu: $('btnChatMenu'), btnSettingsClose: $('btnSettingsClose'),
  settings: $('settings'), accAvatar: $('accAvatar'), accName: $('accName'), accSub: $('accSub'),
  segAccent: $('segAccent'),
  netdiskSelect: $('netdiskSelect'), btnEnterNetdisk: $('btnEnterNetdisk'), btnLogout: $('btnLogout'),
  bgFileInput: $('bgFileInput'), btnBgImage: $('btnBgImage'), btnBgReset: $('btnBgReset'),
  netdisk: $('netdisk'), netdiskTabs: $('netdiskTabs'), netdiskGrid: $('netdiskGrid'),
  btnNetdiskMenu: $('btnNetdiskMenu'),
  btnNetdiskUpload: $('btnNetdiskUpload'), netdiskFileInput: $('netdiskFileInput'),
  viewer: $('viewer'), viewerMedia: $('viewerMedia'), viewerVideo: $('viewerVideo'),
  viewerCap: $('viewerCap'), viewerClose: $('viewerClose'),
  viewerDownload: $('viewerDownload'), viewerShare: $('viewerShare'),
  viewerPrev: $('viewerPrev'), viewerNext: $('viewerNext'),
  details: $('details'), detailsPlaceholder: $('detailsPlaceholder'),
  detailsContent: $('detailsContent'), dAvatar: $('dAvatar'), dName: $('dName'),
  dSub: $('dSub'), dAbout: $('dAbout'), dStat: $('dStat'), dStatMore: $('dStatMore'),
  chatMenu: $('chatMenu'), toast: $('toast'),
  btnChatSearch: $('btnChatSearch'),
  chatSearch: $('chatSearch'), chatSearchInput: $('chatSearchInput'),
  chatSearchResults: $('chatSearchResults'), chatSearchClose: $('chatSearchClose'), chatSearchLoading: $('chatSearchLoading'),
  login: $('login'), loginPhone: $('loginPhone'), loginSend: $('loginSend'),
  loginStepPhone: $('loginStepPhone'), loginStepCode: $('loginStepCode'), loginCode: $('loginCode'),
  loginVerify: $('loginVerify'), loginBack: $('loginBack'), loginErr: $('loginErr'),
  mediaBrowser: $('mediaBrowser'), mediaBrowserGrid: $('mediaBrowserGrid'),
  mediaBrowserTitle: $('mediaBrowserTitle'), mediaBrowserClose: $('mediaBrowserClose'),
  btnNetdiskView: $('btnNetdiskView'), btnMediaView: $('btnMediaView'),
  btnNetdiskMenu: $('btnNetdiskMenu'),
};
// 防御：HTML 中若缺失某元素，返回 no-op 桩而非 undefined/null，
// 避免单个绑定报错导致整段脚本中断、整页白屏（缺失项仅静默失效 + 控制台告警）
const _elStub = new Proxy(function(){}, {
  get(){ return new Proxy(function(){}, { get(){ return _elStub; }, apply(){ return _elStub; } }); },
  apply(){ return _elStub; },
});
const el = new Proxy(_elRaw, {
  get(t, p){ if(typeof p === 'symbol') return t[p]; if(p in t) return t[p];
    console.warn('[tg] 元素缺失：el.'+String(p)+' 不存在于 DOM，相关功能已跳过'); return _elStub; },
  set(t, p, v){ t[p] = v; return true; }
});

// ===== 状态 =====
let client = null, currentEntity = null, currentDialogs = [];
let currentMediaList = [], netdiskChannel = null, netdiskMediaList = [];
let viewerList = null, viewerIndex = 0, viewerMode = 'chat', viewerEntity = null;
let selfMe = null;
const senderCache = new Map();
const mediaCache = new Map();   // 媒体缓存：key -> blob URL（缩略图 / 完整视频）
let lazyObserver = null;
let netdiskView = 'list', currentNetdiskCat = 'all';
let mediaBrowserView = 'list', currentMediaBrowserType = 'video';
let oldestId = null, loadingOlder = false;
let lastFocusVideo = null;      // 当前正在播放/加载的视频消息，用于集中带宽

// ===== 视频下载串行化（同一时间只下载一条视频，集中带宽给正在播放的那条）=====
let _dlRunning = false;
const _dlQueue = [];
let streamHold=false;   // 边下边播进行中：普通/预取下载暂停排队，带宽全部让给正在播放的视频
// priority: 2=正在播放（最优先） 1=普通 0=预取（最低，让路给播放）
function enqueueDownload(task,priority=1){
  return new Promise((resolve,reject)=>{
    _dlQueue.push({task,resolve,reject,priority});
    _dlQueue.sort((a,b)=>b.priority-a.priority);   // 高优先级插队，正在播放的视频永远先下
    _pumpDownloads();
  });
}
// 全局：同一时间只允许一个视频发声（新视频开播自动暂停其它视频，避免多音源混播）
document.addEventListener('play',e=>{
  const t=e.target;
  if(t&&t.tagName==='VIDEO'){document.querySelectorAll('video').forEach(v=>{if(v!==t&&!v.paused)v.pause();});}
},true);
function _pumpDownloads(){
  if(_dlRunning)return;
  if(!_dlQueue.length)return;
  if(streamHold&&_dlQueue[0].priority<2)return;   // 流式播放中，只放行"正在播放"级别任务
  _dlRunning=true;
  const {task,resolve,reject}=_dlQueue.shift();
  Promise.resolve().then(task).then(resolve,e=>reject(e)).finally(()=>{_dlRunning=false;_pumpDownloads();});
}
// ===== 准流式播放：分段下载视频，头部(约1.5MB)到达立即开播，其余后台续传，完成后无缝换源 =====
const STREAM_HEAD=1.5*1024*1024;
async function streamVideo(msg,entity,{isStale,onProgress,onPartial,onFull,onError}){
  streamHold=true;
  try{
    const iter=client.iterDownload({file:msg.media,requestSize:524288,msgData:[entity,msg.id]});
    const chunks=[];let got=0;let partialDone=false;let stale=false;
    const info=mediaInfo(msg);const mime=(info&&info.mime)||'video/mp4';
    const total=info?info.size:0;
    for await(const chunk of iter){
      if(isStale()){stale=true;try{await iter.close();}catch(e){}break;}
      chunks.push(chunk);got+=chunk.length;
      if(onProgress)onProgress(total?got/total:0,got);
      if(!partialDone&&got>=STREAM_HEAD&&total-got>262144){
        partialDone=true;
        if(onPartial)onPartial(new Blob(chunks,{type:mime}),got);
      }
    }
    if(stale)return;
    if(onFull)onFull(new Blob(chunks,{type:mime}));
  }catch(e){
    console.warn('[tg] streamVideo error',e);
    if(onError)onError(e);
  }finally{
    streamHold=false;_pumpDownloads();
  }
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
  reply: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 17l-5-5 5-5"/><path d="M4 12h11a5 5 0 0 1 0 10h-3"/></svg>',
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
// 取消息所属“天”的键（本地时区），用于跨天判断与分隔条
function dayKeyOf(ts){if(!ts)return'';const d=new Date(ts*1000);const p=n=>String(n).padStart(2,'0');return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}`;}
// 日期分隔标签：按需求显示完整日期（xx年xx月xx日），不使用“今天/周X”
function dayLabel(ts){
  if(!ts)return'';const d=new Date(ts*1000);
  return `${d.getFullYear()}年${d.getMonth()+1}月${d.getDate()}日`;
}
function chatName(e){if(!e)return'';if(e.className==='User')return [e.firstName,e.lastName].filter(Boolean).join(' ')||e.username||e.phone||'用户';if(e.className==='Channel'||e.className==='Chat')return e.title||'';return'';}
function isGroup(e){return e && (e.className==='Channel'||e.className==='Chat');}
// gramJS 频道字段是蛇形 megagroup（非 megaGroup），务必两者都判断，否则超级群组会被误判为"频道"
function isChannel(e){return !!(e&&e.className==='Channel');}
function isBroadcast(e){return !!(e&&e.className==='Channel'&&!(e.megagroup||e.megaGroup));}
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
  if(info.type==='image'||info.type==='gif')return 'image';   // GIF 归入图片（GIF 分类已移除）
  if(info.type==='audio')return 'audio';
  const ext=(info.name.split('.').pop()||'').toLowerCase();
  const docExts=['pdf','doc','docx','xls','xlsx','ppt','pptx','txt','md','csv','epub','pages','numbers','key'];
  const fileExts=['apk','ipa','exe','dmg','deb','rpm','msi','app','xapk','zip','rar','7z','tar','gz','iso','bin'];
  if(docExts.includes(ext))return 'document';
  return 'file';   // 其余（含安装包/压缩包/未知类型）归入文件
}
// 网盘显示名：Telegram 不能直接改文件的真实文件名，用消息 caption 作为“重命名”后的名字
function displayName(msg){
  const t=(msg.message||'').trim(); if(t)return t;
  const i=mediaInfo(msg); return i?i.name:'文件';
}

// ===== 主题 =====
function applyTheme(){const t=sGet('tg_theme')||'light';const a=sGet('tg_accent')||'blue';document.documentElement.setAttribute('data-theme',t);document.documentElement.setAttribute('data-accent',a);
  const chk=document.getElementById('chkDark'); if(chk)chk.checked=(t==='dark');
  const sa=document.getElementById('segAccent'); if(sa)sa.querySelectorAll('button').forEach(b=>b.classList.toggle('sel',b.dataset.v===a));}

// ===== 自定义聊天背景 =====
function applyChatBg(){
  const raw=sGet('tg_chat_bg');
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
  setupLogin();
  setupChatSearch();
  const sessionStr=sGet('tg_session')||'';
  if(!API_ID || !API_HASH){
    // 环境变量未注入：不再弹输入框，改为屏显明确诊断（让用户去 Cloudflare 修正配置）
    showEnvMissing();
    return;
  }
  createClient(sessionStr);
  const saved=sGet('tg_self');
  if(saved){try{selfMe=JSON.parse(saved);showAccount(selfMe);}catch(e){}}
  if(!sessionStr||sessionStr.length<20){
    showLogin();   // 未登录 → 显示登录页（主页被覆盖）；有登录记录则自动进入主页
    return;
  }
  tryConnect();
}
let connAttempt=0;
function createClient(sessionStr){
  client=new TelegramClient(new StringSession(sessionStr),API_ID,API_HASH,{connectionRetries:3,retryDelay:1500,useWSS:true,networkSocket:ProxiedWebSockets,requestRetries:2});
  client.addEventHandler(onNewMessage,new NewMessage({}));
}
// 登录态失效（AUTH_KEY_UNREGISTERED 等）时：清除本地旧会话，退回重新输手机号登录
function resetToFreshLogin(reason){
  try{ sDel('tg_session'); sDel('tg_self'); }catch(e){}
  try{
    client=new TelegramClient(new StringSession(''),API_ID,API_HASH,{connectionRetries:3,retryDelay:1500,useWSS:true,networkSocket:ProxiedWebSockets,requestRetries:2});
    client.addEventHandler(onNewMessage,new NewMessage({}));
  }catch(e){}
  connAttempt=0;
  showLogin();
  if(el.loginStepCode)el.loginStepCode.style.display='none';
  if(el.loginStepPhone)el.loginStepPhone.style.display='flex';
  if(el.loginErr)el.loginErr.textContent=reason||'登录态已失效，请重新输入手机号登录';
  setConn('idle');
}
// 连接前探测代理域名是否可达（no-cors opaque 请求，可达即 resolve）
async function probeProxy(){
  if(!PROXY_DOMAIN)return 'DIRECT';
  try{
    const c=new AbortController();const t=setTimeout(()=>c.abort(),6000);
    await fetch('https://'+PROXY_DOMAIN+'/',{mode:'no-cors',signal:c.signal,cache:'no-store'});
    clearTimeout(t);return 'OK';
  }catch(e){return 'FAIL';}
}
// 带超时/重试/诊断的连接：把"永远连接中"变成 15 秒内给出明确结论
async function tryConnect(){
  connAttempt++;
  setConn('connecting');
  const probe=await probeProxy();
  if(probe==='FAIL'){
    showConnFail('代理域名 '+PROXY_DOMAIN+' 无法访问（6 秒内无响应）。请检查该 Worker 是否在线、域名 DNS 是否生效。');
    return;
  }
  if(probe==='DIRECT'){
    showConnFail('构建产物中缺少 VITE_PROXY_DOMAIN，前端正在直连 Telegram（国内会被墙黑洞，永远卡住）。请用源码 + Cloudflare Pages 环境变量（VITE_API_ID / VITE_API_HASH / VITE_PROXY_DOMAIN=tele.reader.cc.cd）重新构建部署，不要上传未带环境变量编译的 dist。');
    return;
  }
  const t0=Date.now();
  try{
    await Promise.race([
      client.connect(),
      new Promise((_,rej)=>setTimeout(()=>rej(new Error('连接超时（15 秒内 Worker 未回包，握手卡住）')),15000)),
    ]);
    const me=await client.getMe();
    finishLogin(me);
  }catch(e){
    const dt=((Date.now()-t0)/1000).toFixed(1);
    console.error('[tg] 连接失败（'+dt+'s）：',e);
    // 保存完整错误（含堆栈），供屏显诊断 / 复制给开发者
    window.__lastConnectError = (e && (e.stack || (e.message + (e.cause ? ('\n'+(e.cause.stack||e.cause.message)) : '')))) || String(e);
    const em=(e&&e.message)||'';
    // 登录态失效（换了代理/DC 后旧会话密钥不被服务器认）：自动清掉旧会话，退回重新输手机号，无需手动清缓存
    if(/AUTH_KEY_(UNREGISTERED|INVALID|DUP)/.test(em)){
      resetToFreshLogin('登录态已失效（AUTH_KEY_UNREGISTERED）：已自动清除旧会话，请重新输入手机号登录');
      return;
    }
    if(connAttempt<3){
      setConn('error',e.message);
      toast('连接失败，3 秒后自动重试（第 '+connAttempt+'/3 次）');
      setTimeout(async()=>{try{await Promise.race([client.disconnect(),new Promise(r=>setTimeout(r,3000))]);}catch(_){/**/}createClient(sGet('tg_session')||'');tryConnect();},3000);
    }else{
      // 把完整错误（消息 + 堆栈）打到屏显诊断面板，手机端无 F12 也能看到根因
      showConnectDiag(e);
    }
  }
}
// 环境变量未注入时的屏显诊断（不再弹输入框）：明确告诉用户是 Cloudflare 配置问题，而非代码崩
function showEnvMissing(force){
  const cfg=window.__CFG||{};
  const detail='[构建] build='+BUILD
    +'\n[检测到] API_ID='+(cfg.api?'已注入 ✓':'缺失 ✗')+'  API_HASH='+(cfg.hash?'已注入 ✓':'缺失 ✗')+'  代理='+(PROXY_DOMAIN||'缺失 ✗')
    +'\n\nCloudflare Pages 环境变量未生效，常见原因（按概率）：'
    +'\n1. 变量名缺少 VITE_ 前缀（必须是 VITE_API_ID / VITE_API_HASH / VITE_PROXY_DOMAIN，少一个字母都不行）'
    +'\n2. 只在 Production 作用域设置，却访问 Preview / *.pages.dev（反之亦然）——两个作用域都要加'
    +'\n3. 设完变量没有重新构建：Deployments → 最新一次 → Retry / Redeploy'
    +'\n4. 用的是“上传 zip”直传（静态），根本不跑 npm run build —— 必须连 Git 仓库或 wrangler 构建'
    +'\n\n修正后重新部署，打开即自动登录，无需填任何信息。';
  console.warn('[tg] 环境变量未注入\n'+detail);
  let d=document.getElementById('__envMissing');
  if(!d){
    d=document.createElement('div');d.id='__envMissing';
    d.style.cssText='position:fixed;left:0;right:0;top:0;background:#1b1b1f;color:#ffd479;font:12px/1.6 monospace;padding:14px;z-index:99999;max-height:70vh;overflow:auto;box-shadow:0 2px 12px rgba(0,0,0,.5);white-space:pre-wrap;';
    document.body.appendChild(d);
  }
  d.innerHTML='<b>⚠ 缺少 Telegram API 配置（环境变量未注入）</b>\n'
    +detail.split('\n').map(l=>l.replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]))).join('\n')
    +'\n\n<button id="__envCopy" style="margin-top:10px;padding:5px 12px;background:#ffd479;color:#1b1b1f;border:0;border-radius:6px;">复制说明</button>'
    +'<button id="__envClose" style="margin-top:10px;margin-left:8px;padding:5px 12px;background:#333;color:#fff;border:0;border-radius:6px;">关闭</button>';
  const cp=document.getElementById('__envCopy');
  if(cp)cp.onclick=()=>{try{navigator.clipboard.writeText(d.innerText);toast('已复制');}catch(_){}};
  const cl=document.getElementById('__envClose');
  if(cl)cl.onclick=()=>{d.remove();};
}
// 屏显连接诊断：把完整错误信息（消息+堆栈）显示为可复制的浮层，便于在无 DevTools 的手机端定位根因
function showConnectDiag(e){
  const err=e||{};
  const msg=err.message||String(e);
  const stack=err.stack||(err.cause&&(err.cause.stack||err.cause.message))||'(无堆栈)';
  const cfg=window.__CFG||{};
  const detail='[错误] '+msg+'\n\n[堆栈]\n'+stack+'\n\n[配置] build='+cfg.build
    +' API='+(cfg.api?'已填':'缺失')+' HASH='+(cfg.hash?'已填':'缺失')+' 代理='+cfg.proxy;
  console.warn('[tg] 连接诊断\n'+detail);
  let d=document.getElementById('__connDiag');
  if(!d){
    d=document.createElement('div');d.id='__connDiag';
    d.style.cssText='position:fixed;left:0;right:0;top:0;background:#1b1b1f;color:#ffb4ab;font:12px/1.5 monospace;padding:12px 14px;z-index:99999;max-height:55vh;overflow:auto;box-shadow:0 2px 10px rgba(0,0,0,.4);white-space:pre-wrap;';
    document.body.appendChild(d);
  }
  d.innerHTML='<b>⚠ 连接 Telegram 失败（已重试 3 次）</b>\n'
    +detail.split('\n').map(l=>l.replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]))).join('\n')
    +'\n\n<button id="__diagCopy" style="margin-top:8px;padding:4px 10px;background:#ffb4ab;color:#1b1b1f;border:0;border-radius:6px;">复制完整错误</button> '
    +'<button id="__diagRetry" style="margin-top:8px;padding:4px 10px;background:#3a7afe;color:#fff;border:0;border-radius:6px;">重新连接</button>';
  const cp=document.getElementById('__diagCopy');
  if(cp)cp.onclick=()=>{try{navigator.clipboard.writeText(d.innerText);toast('已复制');}catch(_){}};
  const rt=document.getElementById('__diagRetry');
  if(rt)rt.onclick=()=>{connAttempt=0;createClient(sGet('tg_session')||'');tryConnect();};
}
function showConnFail(reason){
  setConn('error',reason.length>40?reason.slice(0,40)+'…':reason);
  const ov=document.getElementById('connOverlay');
  if(ov)ov.innerHTML='<div class="box"><b>连接 Telegram 失败</b><br>'+reason
    +'<br><br><b>自查清单：</b>'
    +'<br>1. F12 控制台搜索 <code>[tg]</code>，确认 WebSocket 地址是否为 <code>wss://'+PROXY_DOMAIN+'/…/apiws</code>'
    +'<br>2. 若显示「直连」：说明本次构建没带 <code>VITE_PROXY_DOMAIN</code>，需在 Cloudflare Pages 环境变量中补齐后重新部署'
    +'<br>3. 若代理地址正确仍失败：浏览器直接打开 <code>https://'+PROXY_DOMAIN+'/</code> 确认 Worker 在线'
    +'<br><br><button class="recon" onclick="location.reload()">重新连接</button></div>';
  if(ov)ov.classList.remove('hidden');
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
  sSet('tg_session',client.session.save());
  try{sSet('tg_self',JSON.stringify({id:me.id,firstName:me.firstName,lastName:me.lastName,username:me.username,phone:me.phone}));}catch(e){}
  selfMe=me;setConn('ok');showAccount(me);loadDialogs();
}
function showAccount(me){
  if(!me)return;
  el.accName.textContent=[me.firstName,me.lastName].filter(Boolean).join(' ')||me.username||'用户';
  el.accSub.textContent=me.username?('@'+me.username):(me.phone||'');
  // me 本身即 User 对象（含 photo），直接用它加载头像，避免 getEntity 在大整数 ID 下偶发失败
  if(client)loadAvatarInto(el.accAvatar,me);
}

// ===== 页面内登录（替代 prompt，未登录显示登录页，有登录记录自动进主页）=====
let loginPhoneCodeHash=null;
let loginPwMode=false; // 两步验证模式：验证码输入框此时收集云密码
function showLogin(){el.login.classList.remove('hidden');}
function hideLogin(){el.login.classList.add('hidden');}
function setupLogin(){
  el.loginSend.onclick=async()=>{
    const phone=el.loginPhone.value.trim();
    if(!phone){el.loginErr.textContent='请输入手机号';return;}
    el.loginErr.textContent='连接中…';
    try{
      setConn('connecting');
      await Promise.race([
        client.connect(),
        new Promise((_,rej)=>setTimeout(()=>rej(new Error('连接超时（15 秒）')),15000)),
      ]);
      // gramJS 2.26.22 签名：sendCode(apiCredentials, phoneNumber, forceSMS)
      // 手机号必须是第二个参数！之前把它塞进第一个对象里，phoneNumber=undefined，
      // 序列化时 serializeBytes(undefined) 抛 "Cannot read properties of undefined (reading 'constructor')"
      const sent=await client.sendCode({apiId:API_ID,apiHash:API_HASH},phone);
      loginPhoneCodeHash=sent.phoneCodeHash;
      loginPwMode=false;
      el.loginStepPhone.style.display='none';
      el.loginStepCode.style.display='flex';
      el.loginErr.textContent='';
    }catch(e){setConn('error',e.message);el.loginErr.textContent='发送失败：'+(e&&e.message?e.message:e);}
  };
  el.loginVerify.onclick=async()=>{
    const code=el.loginCode.value.trim();
    if(!code){el.loginErr.textContent='请输入验证码';return;}
    el.loginErr.textContent='登录中…';
    try{
      // 两步验证：用 signInWithPassword（gramJS 2.26.22 没有 client.signIn 方法！）
      if(loginPwMode){
        const me=await client.signInWithPassword({apiId:API_ID,apiHash:API_HASH},{password:async()=>code,onError:async(err)=>{throw err;}});
        hideLogin();loginPwMode=false;finishLogin(me);return;
      }
      // 直接调原始 API：auth.SignIn（gramJS 2.26.22 的 client.signInUser 是交互式循环，不适合页内表单）
      const sign=await client.invoke(new Api.auth.SignIn({phoneNumber:el.loginPhone.value.trim(),phoneCodeHash:loginPhoneCodeHash,phoneCode:code}));
      if(sign instanceof Api.auth.AuthorizationSignUpRequired){
        el.loginErr.textContent='该手机号尚未注册 Telegram，请先在官方 Telegram 客户端注册后再登录';return;
      }
      const me=await client.getMe();
      hideLogin();finishLogin(me);
    }catch(e){
      const em=(e&&e.message)||String(e||'');
      if(/SESSION_PASSWORD_NEEDED/.test(em)){
        loginPwMode=true;
        el.loginErr.textContent='账号开启了两步验证：请在上方输入框中输入你的云密码（不是验证码），再点登录';
        return;
      }
      el.loginErr.textContent='登录失败：'+(e&&e.message?e.message:e);
    }
  };
  el.loginBack.onclick=()=>{el.loginStepCode.style.display='none';el.loginStepPhone.style.display='flex';el.loginErr.textContent='';loginPwMode=false;};
  el.loginPhone.addEventListener('keydown',e=>{if(e.key==='Enter')el.loginSend.click();});
  el.loginCode.addEventListener('keydown',e=>{if(e.key==='Enter')el.loginVerify.click();});
}

// ===== 群内搜索（搜索当前对话的历史聊天记录 / 媒体）=====
function setupChatSearch(){
  el.btnChatSearch.onclick=()=>{
    if(!currentEntity)return;
    el.chatSearch.classList.remove('hidden');
    el.chatSearchResults.innerHTML='';
    el.chatSearchInput.value='';
    setTimeout(()=>el.chatSearchInput.focus(),50);
    runChatSearch('');
  };
  el.chatSearchClose.onclick=()=>el.chatSearch.classList.add('hidden');
  let csTimer=null;
  el.chatSearchInput.addEventListener('input',()=>{clearTimeout(csTimer);csTimer=setTimeout(()=>runChatSearch(el.chatSearchInput.value.trim()),300);});
}
async function runChatSearch(q){
  if(!currentEntity)return;
  if(!q){el.chatSearchResults.innerHTML='<div class="cs-empty">输入关键词搜索此对话的聊天记录</div>';return;}
  el.chatSearchLoading.style.display='flex';
  el.chatSearchResults.innerHTML='';
  try{
    const r=await client.invoke(new Api.messages.Search({peer:currentEntity, q, limit:60, filter:new Api.InputMessagesFilterEmpty()}));
    const msgs=(r.messages||[]).filter(m=>m&&(m.message||m.media));
    el.chatSearchLoading.style.display='none';
    if(!msgs.length){el.chatSearchResults.innerHTML='<div class="cs-empty">未找到匹配的记录</div>';return;}
    const list=[];
    for(const m of msgs){
      const info=mediaInfo(m);
      const sender=await getSender(m);
      const name=sender?chatName(sender):(m.out?'我':chatName(currentEntity));
      let prev=m.message?m.message:'';
      const th=document.createElement('div');th.className='cs-thumb';
      if(info&&(info.type==='image'||info.type==='video'||info.type==='gif')){th.classList.add('play');prev='['+(info.type==='video'?'视频':info.type==='gif'?'GIF':'图片')+'] '+(prev||info.name);}
      else if(info&&info.type==='audio'){prev='[音频] '+(prev||info.name);}
      else if(info&&info.type==='file'){prev='[文件] '+(prev||info.name);}
      const meta=document.createElement('div');meta.className='cs-meta';
      meta.innerHTML=`<div class="cs-name">${escapeHtml(name)}</div><div class="cs-prev">${escapeHtml(prev||'')}</div>`;
      const row=document.createElement('div');row.className='cs-item';row.append(th,meta);
      const idx=list.length;list.push(m);
      row.onclick=()=>{el.chatSearch.classList.add('hidden');openViewer(list,idx,'chat',currentEntity);};
      el.chatSearchResults.appendChild(row);
      if(info&&(info.type==='image'||info.type==='video'||info.type==='gif')){th._thumbMsg=m;th._cacheKey=currentEntity.id+':'+m.id;ensureObserver();lazyObserver.observe(th);loadThumb(th,m);}
    }
  }catch(e){
    el.chatSearchLoading.style.display='none';
    el.chatSearchResults.innerHTML='<div class="cs-empty">搜索失败：'+(e&&e.message?e.message:e)+'</div>';
  }
}

// ===== 对话列表（全部显示头像，贴近官方）=====
async function loadDialogs(){
  try{
    const dialogs=await client.getDialogs({limit:50});
    currentDialogs=dialogs.map(d=>({entity:d.entity,name:chatName(d.entity),message:d.message,id:d.entity.id,date:d.message?.date}));
    renderDialogs(currentDialogs);
    fillNetdiskSelect();   // 仅填充设置里的网盘频道下拉；主页保持聊天模式，网盘只从「设置 → 进入网盘」进入
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
  const ql=q.toLowerCase();
  const local=currentDialogs.filter(d=>(d.name||'').toLowerCase().includes(ql));
  let global=[];
  try{
    const r=await client.invoke(new Api.contacts.Search({q,limit:20}));
    const seen=new Set(local.map(d=>d.id));
    for(const ch of (r.chats||[])){if(!seen.has(ch.id)){global.push({entity:ch,name:chatName(ch),message:null,id:ch.id,joined:false});seen.add(ch.id);}}
    for(const u of (r.users||[])){if(!seen.has(u.id)){global.push({entity:u,name:chatName(u),message:null,id:u.id,joined:false});seen.add(u.id);}}
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
  el.chatStatus.textContent=entity&&entity.className==='User'?'':(isBroadcast(entity)?'频道':'群组');
  el.messages.innerHTML='<div class="loading-spinner"></div>';
  await loadMessages();
  loadDetails(entity);
  document.querySelectorAll('.dialog').forEach(d=>d.classList.toggle('active',String(d.dataset.id)===String(entity.id)));
}
async function loadMessages(){
  // 单条消息渲染失败（个别异常消息/无权限）不应拖垮整页；逐条守卫
  const tryOnce=async()=>{
    const msgs=await client.getMessages(currentEntity,{limit:40});
    el.messages.innerHTML='';currentMediaList=[];newMsgCount=0;refreshScrollBtn();
    let ok=0;
    for(const m of msgs.reverse()){
      try{ await appendMessage(m,false); ok++; }
      catch(e){ console.warn('[tg] 单条消息渲染失败，已跳过：',e&&e.message?e.message:e); }
    }
    flushAlbum(false);
    oldestId=msgs.length?msgs[0].id:null;
    el.messages.scrollTop=el.messages.scrollHeight;
    return ok;
  };
  let lastErr=null;
  for(let attempt=1;attempt<=3;attempt++){
    try{
      const ok=await tryOnce();
      if(ok>0||attempt===3){loadingOlder=false;return;}  // 已加载出消息则停止重试
    }catch(e){
      lastErr=e;
      console.warn(`[tg] 加载消息失败（第 ${attempt}/3 次）：`,e);
      if(attempt<3)await new Promise(r=>setTimeout(r,1500*attempt));
    }
  }
  loadingOlder=false;
  const detail=lastErr&&lastErr.message?lastErr.message:String(lastErr||'未知错误');
  el.messages.innerHTML='<div class="empty-hint">加载消息失败：'+detail+'<br><br>多为该频道接口瞬时错误或被限制（FLOOD_WAIT）。请稍后重试，或 F12 控制台查看 [tg] 日志。</div>';
  toast('加载消息失败：'+detail);
}
// 向上滚动加载更早的历史消息
async function loadOlder(){
  if(loadingOlder||!oldestId)return;
  loadingOlder=true;
  const prevH=el.messages.scrollHeight;
  const prevTop=el.messages.scrollTop;
  const doFetch=async()=>{
    const msgs=await client.getMessages(currentEntity,{limit:40,offsetId:oldestId});
    if(msgs&&msgs.length){
      // getMessages 返回最新→最旧；预插入需按最新→最旧遍历（insertBefore 首条），顺序才正确
      for(const m of msgs){ try{ await appendMessage(m,true); }catch(e){ console.warn('[tg] 历史单条渲染失败，已跳过：',e&&e.message?e.message:e); } }
      flushAlbum(true);
      oldestId=msgs[msgs.length-1].id;
      el.messages.scrollTop=prevTop+(el.messages.scrollHeight-prevH);
    }
  };
  try{ await doFetch(); }
  catch(e){
    console.warn('[tg] 加载更早消息失败，1.5s 后重试：',e);
    try{ await new Promise(r=>setTimeout(r,1500)); await doFetch(); }
    catch(e2){ toast('加载更早消息失败：'+(e2&&e2.message?e2.message:e2)); }
  }
  loadingOlder=false;
}
// ===== 回到底部悬浮按钮（Telegram 风格：浏览历史时左下角出现，带未读计数）=====
let newMsgCount=0;let _sbBtn=null;
function scrollBottomBtn(){ return _sbBtn||(_sbBtn=document.getElementById('btnScrollBottom')); }
function isAtBottom(){ return el.messages.scrollHeight-el.messages.scrollTop-el.messages.clientHeight<80; }
function refreshScrollBtn(){
  const btn=scrollBottomBtn(); if(!btn)return;
  if(isAtBottom()){ newMsgCount=0; btn.classList.remove('show','has-new'); return; }
  btn.classList.add('show');
  if(newMsgCount>0){ btn.classList.add('has-new'); const b=btn.querySelector('.badge'); if(b)b.textContent=newMsgCount>99?'99+':String(newMsgCount); }
  else btn.classList.remove('has-new');
}
el.messages.addEventListener('scroll',()=>{ if(el.messages.scrollTop<60) loadOlder(); refreshScrollBtn(); });
const _sb=scrollBottomBtn();
if(_sb)_sb.addEventListener('click',()=>{ newMsgCount=0; el.messages.scrollTo({top:el.messages.scrollHeight,behavior:'smooth'}); refreshScrollBtn(); });

// ===== 渲染单条消息 =====
// 一条消息含多条媒体（相册）时合并为一张拼图卡
let pendingAlbum=null;
async function appendMessage(msg, prepend){
  // 关键：gramJS 的 groupedId 是 Long 对象，必须转字符串比较，否则永远不相等 → 相册被拆成多卡
  const gid=msg.groupedId!=null?String(msg.groupedId):null;
  if(gid){
    if(pendingAlbum && pendingAlbum.id===gid) pendingAlbum.msgs.push(msg);
    else { flushAlbum(prepend); pendingAlbum={id:gid, msgs:[msg]}; }
  }else{
    flushAlbum(prepend);
    await renderItem([msg], prepend);
  }
}
function flushAlbum(prepend){
  if(!pendingAlbum)return;
  const items=pendingAlbum.msgs; pendingAlbum=null;
  renderItem(items, prepend);
}
async function renderItem(items, prepend){
  const first=items[0];
  const row=document.createElement('div');row.className='row '+(first.out?'out':'in');
  const bubble=document.createElement('div');bubble.className='msg';bubble.dataset.id=first.id;
  const grp=isGroup(currentEntity);
  if(!first.out&&grp){
    const s=await getSender(first);
    if(s){
      const sr=document.createElement('div');sr.className='sender-row';
      const sa=document.createElement('div');sa.className='avatar xs';loadAvatarInto(sa,s);
      const sn=document.createElement('div');sn.className='sender';sn.textContent=chatName(s);
      sr.append(sa,sn);bubble.appendChild(sr);
    }
  }
  const text=items.map(m=>m.message||'').filter(Boolean).join('\n');
  if(text)bubble.innerHTML+=`<div class="text">${escapeHtml(text)}</div>`;
  // 注册底层消息（供查看器 / 点击播放导航）；记住第一条索引
  const startIdx=currentMediaList.length;
  if(prepend){ for(let i=items.length-1;i>=0;i--)currentMediaList.unshift(items[i]); }
  else { for(const m of items)currentMediaList.push(m); }
  // 纯文字消息 mediaInfo 返回 null，必须判空：否则下方 info.type 会抛 TypeError，
  // 被 loadMessages 的单条 try/catch 吞掉 → 整条文字消息被静默跳过
  const info0=items.length===1?mediaInfo(items[0]):null;
  const hasMedia=items.length>1||info0!=null;
  if(hasMedia){
    const media=document.createElement('div');media.className='msg-media'+(items.length>1?' album':'');
    if(items.length===1){
      const msg=items[0];const info=info0;
      const key=currentEntity.id+':'+msg.id;
      media._thumbMsg=msg;media._cacheKey=key;
      if(info&&(info.type==='image'||info.type==='video'||info.type==='gif')){
      const ph=document.createElement('div');ph.className='lazy-ph';media.appendChild(ph);
      if(info.type==='video'){
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
  }else{
    for(const m of items){
      const info=mediaInfo(m);
      const cell=document.createElement('div');cell.className='album-cell';
      if(info&&(info.type==='video'||info.type==='gif'))cell.classList.add('play');
      cell._thumbMsg=m;cell._cacheKey=currentEntity.id+':'+m.id;
      media.appendChild(cell);
      ensureObserver();lazyObserver.observe(cell);
    }
  }
  bubble.appendChild(media);
  }
  const acts=document.createElement('div');acts.className='msg-actions';
  acts.innerHTML=`<button class="act-btn" data-act="view" title="查看">${ICONS.view}</button><button class="act-btn" data-act="reply" title="回复">${ICONS.reply}</button><button class="act-btn" data-act="download" title="下载">${ICONS.download}</button><button class="act-btn" data-act="share" title="分享">${ICONS.share}</button><button class="act-btn del" data-act="delete" title="删除">${ICONS.del}</button>`;
  bubble.appendChild(acts);
  // 参考官方样式：气泡底部 = 浏览量（眼睛图标）+ 时间
  const foot=document.createElement('div');foot.className='msg-foot';
  const views=(first.views!=null&&first.views>0)?`<span class="vf-views"><svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/></svg>${first.views>=1000?(first.views/1000).toFixed(1)+'K':first.views}</span>`:'';
  foot.innerHTML=`${views}<span class="vf-time">${fmtTime(first.date).split(' ')[1]||''}</span>`;
  bubble.appendChild(foot);
  row.appendChild(bubble);
  // 仿 Telegram：与“相邻已渲染消息”不是同一天时，在当天第一条消息上方插入“今天/昨天/日期”分隔条。
  // 关键修复：prepend（向上浏览历史）模式下，原代码先 insertBefore(firstChild) 插 sep、再插 row，
  // 导致 row 被推到 sep 之上 —— 分隔条被压到消息下方、跨天还会堆叠，这正是“日期对不上 / 自建频道没分隔”的根因。
  // 现改为：先放消息、再把 sep 压到消息之上；并改用 first/lastElementChild 跳过文本/空白节点更稳健。
  // 防御：日期分隔仅是视觉辅助，任何异常都绝不能影响消息本身渲染（否则表现为“内容不显示”）
  try{
    const dayKey=dayKeyOf(first.date);
    row.dataset.day=dayKey;
    const neighbor=prepend?el.messages.firstElementChild:el.messages.lastElementChild;
    const neighborDay=neighbor&&neighbor.dataset?neighbor.dataset.day:null;
    let sep=null;
    if(neighborDay!==dayKey){
      sep=document.createElement('div');sep.className='date-sep';sep.dataset.day=dayKey;
      sep.innerHTML=`<span>${dayLabel(first.date)}</span>`;
    }
    if(prepend){
      el.messages.insertBefore(row, el.messages.firstChild);   // 消息先置顶
      if(sep)el.messages.insertBefore(sep, row);              // 分隔条压到消息之上
    }else{
      if(sep)el.messages.insertBefore(sep, row);              // 分隔条在消息之上
      el.messages.appendChild(row);                           // 消息置底
    }
  }catch(e){
    console.warn('[tg] 日期分隔插入失败（不影响消息）：',e&&e.message?e.message:e);
    try{ if(prepend)el.messages.insertBefore(row,el.messages.firstChild); else el.messages.appendChild(row); }catch(_){}
  }
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
    else if(act==='reply'){el.msgInput.value='回复 #'+id+' ';el.msgInput.focus();}
    return;}
  const cell=e.target.closest('.album-cell');
  if(cell){const msg=cell._thumbMsg;const idx=currentMediaList.indexOf(msg);if(idx>=0)openViewer(currentMediaList,idx,'chat',currentEntity);return;}
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

  const right=document.createElement('div');right.className='vp-right';
  const timeSpan=document.createElement('span');timeSpan.className='vp-time';timeSpan.textContent='0:00';
  const muteBtn=document.createElement('button');muteBtn.className='vp-mute';muteBtn.innerHTML=ICONS.mute; // 初始静音
  right.append(timeSpan,muteBtn);

  ctrl.append(left,right);wrap.appendChild(ctrl);host.appendChild(wrap);

  const cp=playBtn.querySelector('.vp-ring-cp');
  const icon=playBtn.querySelector('.vp-icon');
  wrap.addEventListener('click',e=>e.stopPropagation());
  // 左下角圆形进度 = 实时下载进度（不再有中间大进度条）
  function setLoadProgress(p){const t=Math.max(0,Math.min(1,p));cp.style.strokeDashoffset=String(94.2*(1-t));}
  function fmtDur(s){if(!s||!isFinite(s))return '0:00';const m=Math.floor(s/60);const sec=Math.floor(s%60);return m+':'+String(sec).padStart(2,'0');}
  function updateTime(){timeSpan.textContent='-'+fmtDur(Math.max(0,(v.duration||0)-v.currentTime));}
  function syncIcon(){icon.textContent=v.paused?'▶':'⏸';}
  async function safePlay(){try{await v.play();}catch(e){
    // 浏览器拒绝有声自动播放时，静音后重试，保证"进度走完即开播"
    if(e&&e.name==='NotAllowedError'){v.muted=true;muteBtn.innerHTML=ICONS.mute;try{await v.play();}catch(_){}}
    else if(e&&e.name!=='AbortError')console.warn('play error',e);
  }}

  playBtn.onclick=(e)=>{e.stopPropagation();if(v.paused){safePlay();}else{v.pause();}};
  muteBtn.onclick=(e)=>{e.stopPropagation();v.muted=!v.muted;muteBtn.innerHTML=v.muted?ICONS.mute:ICONS.volume;};
  v.onclick=(e)=>{e.stopPropagation();if(v.paused)safePlay();else v.pause();};
  v.addEventListener('play',syncIcon);v.addEventListener('pause',syncIcon);
  v.addEventListener('timeupdate',updateTime);v.addEventListener('loadedmetadata',updateTime);
  v.addEventListener('ended',()=>{icon.textContent='↻';});

  if(mediaCache.has(key)){ // 已缓存：直接即播，进度置满
    const url=mediaCache.get(key);v.src=url;setLoadProgress(1);safePlay();return;
  }
  // 准流式：头部到达即开播（不用等整段下载完），进度环同时显示真实下载进度
  streamVideo(msg,entity,{
    isStale:()=>lastFocusVideo!==msg,
    onProgress:(p)=>{if(lastFocusVideo===msg)setLoadProgress(p);},
    onPartial:(blob)=>{
      if(lastFocusVideo!==msg)return;
      v.src=URL.createObjectURL(blob);safePlay();   // 边下边播：先播已到的部分
    },
    onFull:(blob)=>{
      if(lastFocusVideo!==msg)return;
      const url=URL.createObjectURL(blob);mediaCache.set(key,url);
      const t=v.currentTime||0;
      v.src=url;v.addEventListener('loadedmetadata',()=>{try{v.currentTime=t;}catch(e){}},{once:true});
      setLoadProgress(1);safePlay();   // 无缝换完整源，播放位置不跳
    },
    onError:()=>{if(lastFocusVideo===msg)host.innerHTML='<div class="empty-hint">❌ 播放失败</div>';}
  });
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
async function downloadMedia(msg,nameOverride){
  const dl=document.getElementById('dlToast');
  const setDl=(pct,txt)=>{ if(!dl)return; dl.classList.add('show'); dl.querySelector('.dl-name').textContent=txt; dl.querySelector('.dl-pct').textContent=Math.round(pct)+'%'; dl.querySelector('.dl-bar > i').style.width=pct+'%'; };
  try{
    const info=mediaInfo(msg);const name=nameOverride||(info?info.name:'file');
    const mime=info?info.mime:'application/octet-stream';
    // 分段流下载（复用已验证的 iterDownload 通道），边下边更新底部进度条，避免一次性缓冲大文件卡死/失败
    const chunks=[];let got=0;const total=info?info.size:0;
    setDl(0,'开始下载：'+name);
    const iter=client.iterDownload({file:msg.media,requestSize:524288,msgData:[msg.chat,msg.id]});
    for await(const chunk of iter){ chunks.push(chunk); got+=chunk.length; setDl(total?got/total*100:0,name); }
    if(!chunks.length){ if(dl)dl.classList.remove('show'); toast('下载为空'); return; }
    const url=URL.createObjectURL(new Blob(chunks,{type:mime}));
    const a=document.createElement('a');a.href=url;a.download=name;a.style.display='none';
    document.body.appendChild(a);
    try{ a.click(); }catch(e){}
    document.body.removeChild(a);
    // 设置中开启“下载后自动打开”则新标签页打开（手机可直接预览/长按保存）；iOS 兜底打开
    if(sGet('tg_autoopen')==='1'){ try{ window.open(url,'_blank'); }catch(e){} }
    else { try{ const ua=navigator.userAgent||''; if(/iP(ad|hone|od)/.test(ua)) window.open(url,'_blank'); }catch(e){} }
    setDl(100,name);
    setTimeout(()=>{ if(dl)dl.classList.remove('show'); },1600);
    setTimeout(()=>URL.revokeObjectURL(url),60000);
    toast('下载完成：'+name);
  }catch(e){ if(dl)dl.classList.remove('show'); toast('下载失败：'+e.message); }
}
async function shareMedia(msg,nameOverride){
  const info=mediaInfo(msg);const name=nameOverride||(info?info.name:'文件');
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
      // priority 0：预取任务让路给正在播放/观看的媒体
      enqueueDownload(()=>client.downloadMedia(d),0).then(buf=>{
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
  async function safePlay(v){try{await v.play();}catch(e){
    if(e&&e.name==='NotAllowedError'){v.muted=true;try{await v.play();}catch(_){}}
    else if(e&&e.name!=='AbortError')console.warn('viewer play error',e);
  }}
  // 进度遮罩已移除（按需求：弹窗不显示加载进度条）；保留 setP 占位避免其余回调改动
  const setP=()=>{};

  if(info&&(info.type==='video'||info.type==='gif')){
    el.viewerVideo.style.display='block';el.viewerVideo.controls=true;el.viewerVideo.muted=true;
    if(mediaCache.has(key)){el.viewerVideo.src=mediaCache.get(key);safePlay(el.viewerVideo);return;}
    // 先快速拉缩略图作占位，切换瞬间即可看到画面
    client.downloadMedia(msg,{thumb:'m'}).then(buf=>{if(buf&&buf.length&&myToken===viewerToken){el.viewerVideo.poster=URL.createObjectURL(new Blob([buf],{type:'image/jpeg'}));}}).catch(()=>{});
    el.viewerCap.textContent='缓冲中…';
    // 准流式：头部到达即开播，不等整段下载；百分比实时显示
    streamVideo(msg,viewerEntity,{
      isStale:()=>myToken!==viewerToken,
      onProgress:(p)=>{if(myToken===viewerToken)el.viewerCap.textContent='缓冲中 '+Math.round(Math.min(1,p)*100)+'%';},
      onPartial:(blob)=>{
        if(myToken!==viewerToken)return;
        el.viewerVideo.src=URL.createObjectURL(blob);el.viewerCap.textContent='';
        safePlay(el.viewerVideo);   // 边下边播
      },
      onFull:(blob)=>{
        if(myToken!==viewerToken)return;
        const url=URL.createObjectURL(blob);mediaCache.set(key,url);
        const t=el.viewerVideo.currentTime||0;const muted=el.viewerVideo.muted;
        el.viewerVideo.src=url;el.viewerVideo.muted=muted;
        if(t>0)el.viewerVideo.addEventListener('loadedmetadata',()=>{try{el.viewerVideo.currentTime=t;}catch(e){}},{once:true});
        el.viewerCap.textContent='';
        safePlay(el.viewerVideo);   // 无缝换完整源，播放位置不跳
      },
      onError:()=>{if(myToken===viewerToken)el.viewerCap.textContent='❌ 加载失败';}
    });
  }else if(info&&info.type==='image'){
    el.viewerMedia.style.display='block';
    if(mediaCache.has(key)){el.viewerMedia.src=mediaCache.get(key);return;}
    client.downloadMedia(msg,{progressCallback:p=>{if(myToken===viewerToken)setP(p);}}).then(buf=>{if(myToken!==viewerToken)return;if(buf&&buf.length){const url=URL.createObjectURL(new Blob([buf],{type:'image/jpeg'}));mediaCache.set(key,url);el.viewerMedia.src=url;}}).catch(()=>{if(myToken===viewerToken){el.viewerCap.textContent='❌ 加载失败';}});
  }else if(info&&info.type==='audio'){
    el.viewerVideo.style.display='block';el.viewerVideo.controls=true;el.viewerVideo.muted=true;
    if(mediaCache.has(key)){el.viewerVideo.src=mediaCache.get(key);safePlay(el.viewerVideo);return;}
    setP(0);
    client.downloadMedia(msg,{progressCallback:p=>{if(myToken===viewerToken)setP(p);}}).then(buf=>{if(myToken!==viewerToken)return;if(buf&&buf.length){const url=URL.createObjectURL(new Blob([buf],{type:info.mime||'audio/mpeg'}));mediaCache.set(key,url);el.viewerVideo.src=url;safePlay(el.viewerVideo);}}).catch(()=>{if(myToken===viewerToken){el.viewerCap.textContent='❌ 加载失败';}});
  }else{
    el.viewerMedia.style.display='block';el.viewerMedia.alt='[文件] '+(info?info.name:'');el.viewerCap.textContent=(info?info.name:'')+'  ·  '+fmtSize(info?info.size:0);
  }
}
function closeViewer(){el.viewer.classList.remove('open');try{el.viewerVideo.pause();el.viewerVideo.removeAttribute('src');}catch(e){}}
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
  el.mediaBrowserGrid.className='list-mode';
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
      const row=document.createElement('div');row.className='nk-row';
      const th=document.createElement('div');th.className='nk-thumb sm';
      if(info.type==='video')th.classList.add('play');else if(info.type!=='image'&&info.type!=='gif')th.innerHTML=ICONS.file;
      th._thumbMsg=msg;th._cacheKey='mb:'+msg.id;th._entity=currentEntity;
      const meta=document.createElement('div');meta.className='nk-meta';
      meta.innerHTML=`<div class="nk-name">${escapeHtml(info.name)}</div><div class="nk-sub">${info.type} · ${fmtSize(info.size)}</div>`;
      row.append(th,meta);row.onclick=()=>{el.mediaBrowser.classList.remove('open');openViewer(list,i,'browser',currentEntity);};
      el.mediaBrowserGrid.appendChild(row);
      if(th._thumbMsg)loadThumb(th,msg);
    });
  }catch(e){el.mediaBrowserGrid.innerHTML='<div class="empty-hint">加载失败</div>';}
}

// ===== 右侧详情 + 媒体统计 =====
async function loadDetails(entity){
  el.detailsPlaceholder.style.display='none';el.detailsContent.classList.add('show');
  el.dName.textContent=chatName(entity);
  el.dSub.textContent=entity.className==='User'?(entity.username?('@'+entity.username):(entity.phone||'')):(isBroadcast(entity)?'频道':'群组');
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
    if(isBroadcast(currentEntity)){const b=document.createElement('button');b.textContent=currentEntity.left?'加入频道':'退出频道';b.onclick=()=>{currentEntity.left?joinChannel(currentEntity):leaveChannel(currentEntity);hideMenu();};m.appendChild(b);}
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
el.segAccent.querySelectorAll('button').forEach(b=>b.onclick=()=>{sSet('tg_accent',b.dataset.v);applyTheme();});
const chkDark=document.getElementById('chkDark');
if(chkDark)chkDark.onchange=()=>{sSet('tg_theme',chkDark.checked?'dark':'light');applyTheme();};
const chkAutoOpen=document.getElementById('chkAutoOpen');
if(chkAutoOpen){ chkAutoOpen.checked=(sGet('tg_autoopen')==='1'); chkAutoOpen.onchange=()=>sSet('tg_autoopen',chkAutoOpen.checked?'1':'0'); }
// 设置面板：滚动时账号头部紧凑化（更贴合移动端）
const accHeader=document.getElementById('accountHeader');
const panelBody=document.querySelector('#settings .panel-body');
if(accHeader&&panelBody)panelBody.addEventListener('scroll',()=>accHeader.classList.toggle('compact',panelBody.scrollTop>10));
document.querySelectorAll('.bg-swatch').forEach(s=>s.onclick=()=>{sSet('tg_chat_bg',JSON.stringify({type:'color',value:s.dataset.bg}));applyChatBg();});
el.btnBgImage.onclick=()=>el.bgFileInput.click();
el.bgFileInput.onchange=async(e)=>{const f=e.target.files[0];if(!f)return;const url=await new Promise(r=>{const fr=new FileReader();fr.onload=()=>r(fr.result);fr.readAsDataURL(f);});sSet('tg_chat_bg',JSON.stringify({type:'image',value:url}));applyChatBg();e.target.value='';};
el.btnBgReset.onclick=()=>{sDel('tg_chat_bg');applyChatBg();};
el.btnLogout.onclick=()=>{if(confirm('退出登录将清除本地登录态')){sDel('tg_session');sDel('tg_self');location.reload();}};

// ===== 网盘（全屏）=====
function fillNetdiskSelect(){
  const saved=sGet('tg_netdisk')||'';
  el.netdiskSelect.innerHTML='<option value="">— 请选择频道 —</option>';
  for(const d of currentDialogs){if(d.entity.className==='Channel'){const o=document.createElement('option');o.value=String(d.id);o.textContent=chatName(d.entity);el.netdiskSelect.appendChild(o);}}
  if(saved)el.netdiskSelect.value=saved;
}
el.btnEnterNetdisk.onclick=()=>{
  let id=el.netdiskSelect.value||sGet('tg_netdisk');
  if(!id){toast('请先在上方选择网盘频道');return;}
  const ent=currentDialogs.find(d=>String(d.id)===id)?.entity;if(!ent){toast('未找到该频道');return;}
  netdiskChannel=ent;sSet('tg_netdisk',id);
  el.settings.classList.remove('open');
  el.netdisk.classList.add('open');
  loadNetdisk(el.netdiskTabs.querySelector('.sel').dataset.cat);
};
el.btnNetdiskMenu.onclick=()=>{el.netdisk.classList.remove('open');el.settings.classList.add('open');};
el.netdiskTabs.addEventListener('click',e=>{const b=e.target.closest('button');if(!b)return;el.netdiskTabs.querySelectorAll('button').forEach(x=>x.classList.remove('sel'));b.classList.add('sel');loadNetdisk(b.dataset.cat);});
$('netdiskSearchInput').addEventListener('input',()=>renderNetdisk(currentNetdiskCat));
async function loadNetdisk(cat){
  if(!netdiskChannel)return;
  currentNetdiskCat=cat;
  el.netdiskGrid.innerHTML='<div class="loading-spinner"></div>';
  try{
    // 分页拉全量历史（此前只取 100 条导致网盘显示不全）
    const all=[];let offsetId=0;
    for(let guard=0;guard<20;guard++){           // 上限 2000 条，防卡死
      const opts={limit:100};if(offsetId)opts.offsetId=offsetId;
      const msgs=await client.getMessages(netdiskChannel,opts);
      if(!msgs||!msgs.length)break;
      all.push(...msgs);
      if(msgs.length<100)break;
      offsetId=msgs[msgs.length-1].id;
    }
    netdiskMediaList=all.filter(m=>mediaInfo(m)).sort((a,b)=>(b.date||0)-(a.date||0)); // 网盘：从新到旧
    renderNetdisk(cat);
  }
  catch(e){el.netdiskGrid.innerHTML='<div class="empty-hint">加载失败：'+e.message+'</div>';}
}
function renderNetdisk(cat){
  const q=($('netdiskSearchInput').value||'').trim().toLowerCase();
  let list=cat==='all'?netdiskMediaList:netdiskMediaList.filter(m=>netdiskCategory(m)===cat);
  if(q)list=list.filter(m=>displayName(m).toLowerCase().includes(q));
  el.netdiskGrid.className='list-mode';
  el.netdiskGrid.innerHTML='';
  if(!list.length){el.netdiskGrid.innerHTML='<div class="empty-hint">'+(q?'未找到匹配的文件':'暂无文件')+'</div>';return;}
  let lastDayKey='';
  list.forEach((msg,i)=>{
    const info=mediaInfo(msg);
    const name=displayName(msg);
    // 网盘列表按天分组：当天首条消息前插入“xx年xx月xx日”分隔条（聊天视图已有，这里补齐自建频道场景）
    const dayKey=dayKeyOf(msg.date);
    if(dayKey && dayKey!==lastDayKey){
      const sep=document.createElement('div');sep.className='date-sep';sep.innerHTML=`<span>${dayLabel(msg.date)}</span>`;
      el.netdiskGrid.appendChild(sep);
      lastDayKey=dayKey;
    }
    const more=document.createElement('button');more.className='nk-act';more.textContent='⋯';more.title='更多';
    more.onclick=(ev)=>{ev.stopPropagation();openCardMenu(more,msg);};
    const row=document.createElement('div');row.className='nk-row';
    const th=document.createElement('div');th.className='nk-thumb sm';
    th._thumbMsg=msg;th._cacheKey=netdiskChannel.id+':'+msg.id;th._entity=netdiskChannel;
    if(info.type==='video')th.classList.add('play');else if(info.type!=='image'&&info.type!=='gif')th.innerHTML=ICONS.file;
    const meta=document.createElement('div');meta.className='nk-meta';
    meta.innerHTML=`<div class="nk-name">${escapeHtml(name)}</div><div class="nk-sub">${info.type} · ${fmtSize(info.size)}</div>`;
    row.append(th,meta,more);row.onclick=()=>openViewer(list,i,'netdisk',netdiskChannel);
    el.netdiskGrid.appendChild(row);
    loadThumb(th,msg);
  });
}
// 卡片「⋯」弹出菜单：下载 / 重命名 / 分享 / 删除
function openCardMenu(anchor,msg){
  const menu=$('nkCardMenu');menu.innerHTML='';
  const acts=[['下载',()=>downloadMedia(msg,displayName(msg))],['重命名',()=>renameItem(msg)],['分享',()=>shareMedia(msg,displayName(msg))],['删除',()=>deleteNetdiskItem(msg)]];
  acts.forEach(([label,fn])=>{const b=document.createElement('button');b.textContent=label;if(label==='删除')b.className='danger';b.onclick=()=>{menu.classList.remove('open');fn();};menu.appendChild(b);});
  const r=anchor.getBoundingClientRect();
  menu.style.top=Math.min(r.bottom+6,innerHeight-170)+'px';
  menu.style.left=Math.max(8,Math.min(r.left,innerWidth-162))+'px';
  menu.classList.add('open');
}
document.addEventListener('click',e=>{ if(!e.target.closest('.card-menu')&&!e.target.closest('.nk-act')){const m=$('nkCardMenu');if(m)m.classList.remove('open');} });
// 重命名 = 编辑消息 caption（Telegram 无法直接改文件底层文件名，caption 即显示名/下载名）
async function renameItem(msg){
  const cur=displayName(msg);
  const nn=prompt('重命名（将作为显示名与下载名）：',cur);
  if(nn==null)return; const name=nn.trim(); if(!name)return;
  try{ await client.editMessage(netdiskChannel,{message:msg.id,text:name}); msg.message=name; toast('已重命名'); renderNetdisk(currentNetdiskCat); }
  catch(e){ toast('重命名失败：'+e.message); }
}
async function deleteNetdiskItem(msg){
  if(!confirm('确定删除「'+displayName(msg)+'」？'))return;
  try{ await client.deleteMessages(netdiskChannel,[msg.id],{revoke:true});
    netdiskMediaList=netdiskMediaList.filter(m=>m.id!==msg.id);
    renderNetdisk(currentNetdiskCat); toast('已删除'); }
  catch(e){ toast('删除失败：'+e.message); }
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
  if(currentEntity&&msg.chat&&msg.chat.id===currentEntity.id){
    const wasBottom=isAtBottom();
    await appendMessage(msg,false);flushAlbum(false);
    if(wasBottom)el.messages.scrollTop=el.messages.scrollHeight; else newMsgCount++;
    refreshScrollBtn();
  }
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
