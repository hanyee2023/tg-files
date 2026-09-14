import { TelegramClient, Api } from 'telegram';
import { StringSession } from 'telegram/sessions';
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
if (PROXY_DOMAIN) {
  const origFetch = self.fetch;
  self.fetch = function (input, init) {
    let s = typeof input === 'string' ? input : (input?.url || '');
    if (s.includes('telegram.org') && !s.includes(PROXY_DOMAIN)) {
      try {
        const u = new URL(s);
        s = `https://${PROXY_DOMAIN}/${u.hostname}${u.pathname}${u.search}`;
        input = typeof input === 'string' ? s : new Request(s, input);
      } catch (e) {}
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
  btnMenu: $('btnMenu'), btnNetdisk: $('btnNetdisk'), btnChatMenu: $('btnChatMenu'),
  settings: $('settings'), accountHeader: $('accountHeader'),
  accAvatar: $('accAvatar'), accName: $('accName'), accSub: $('accSub'),
  segTheme: $('segTheme'), segAccent: $('segAccent'),
  netdiskSelect: $('netdiskSelect'), btnEnterNetdisk: $('btnEnterNetdisk'),
  btnLogout: $('btnLogout'),
  netdisk: $('netdisk'), netdiskTabs: $('netdiskTabs'), netdiskGrid: $('netdiskGrid'),
  btnNetdiskBack: $('btnNetdiskBack'), btnNetdiskClose: $('btnNetdiskClose'),
  btnNetdiskUpload: $('btnNetdiskUpload'), netdiskFileInput: $('netdiskFileInput'),
  viewer: $('viewer'), viewerMedia: $('viewerMedia'), viewerVideo: $('viewerVideo'),
  viewerCap: $('viewerCap'), viewerClose: $('viewerClose'),
  viewerDownload: $('viewerDownload'), viewerShare: $('viewerShare'),
  viewerPrev: $('viewerPrev'), viewerNext: $('viewerNext'),
  details: $('details'), detailsPlaceholder: $('detailsPlaceholder'),
  detailsContent: $('detailsContent'), dAvatar: $('dAvatar'), dName: $('dName'),
  dSub: $('dSub'), dAbout: $('dAbout'), dStat: $('dStat'),
  chatMenu: $('chatMenu'), toast: $('toast'),
};

// ===== 状态 =====
let client = null;
let currentEntity = null;
let currentDialogs = [];
let currentMediaList = [];
let netdiskChannel = null;
let netdiskMediaList = [];
let viewerList = null, viewerIndex = 0, viewerMode = 'chat';
const senderCache = new Map();
let lazyObserver = null;

// ===== 工具 =====
const ICONS = {
  play: '<svg viewBox="0 0 24 24" fill="#fff"><path d="M8 5v14l11-7z"/></svg>',
  download: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="M7 10l5 5 5-5"/><path d="M12 15V3"/></svg>',
  share: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><path d="m8.6 13.5 6.8 4M15.4 6.5 8.6 10.5"/></svg>',
  view: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/></svg>',
  del: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>',
  file: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/></svg>',
};
function escapeHtml(s){return String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
function getInitials(name){name=(name||'').trim();if(!name)return'?';const p=name.split(/\s+/);return (p[0]?.[0]||'')+(p[1]?.[0]||'');}
const AVCOL=['#e17076','#7bc862','#65aadd','#a695e7','#ee7aae','#6ec9cb','#faa774'];
function avatarBg(name){let h=0;for(const c of (name||''))h=(h*31+c.charCodeAt(0))>>>0;return AVCOL[h%AVCOL.length];}
function fmtSize(b){if(!b)return'';if(b<1024)return b+'B';if(b<1048576)return (b/1024).toFixed(1)+'KB';if(b<1073741824)return (b/1048576).toFixed(1)+'MB';return (b/1073741824).toFixed(2)+'GB';}
function fmtTime(ts){if(!ts)return'';const d=new Date(ts*1000);const p=n=>String(n).padStart(2,'0');return `${p(d.getMonth()+1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;}
function chatName(e){if(!e)return'';if(e.className==='User')return [e.firstName,e.lastName].filter(Boolean).join(' ')||e.username||e.phone||'用户';if(e.className==='Channel'||e.className==='Chat')return e.title||'';return'';}
function isGroup(e){return e && (e.className==='Channel'||e.className==='Chat');}
let toastTimer=null;
function toast(msg){el.toast.textContent=msg;el.toast.classList.add('show');clearTimeout(toastTimer);toastTimer=setTimeout(()=>el.toast.classList.remove('show'),2200);}

// ===== 媒体识别 =====
function mediaInfo(msg){
  const m=msg.media; if(!m)return null;
  if(m.photo) return {type:'photo',name:'图片',size:0,mime:'image/jpeg'};
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
// 网盘分类判断（按扩展名/类型）
function netdiskCategory(msg){
  const info=mediaInfo(msg); if(!info)return null;
  if(info.type==='video')return 'video';
  if(info.type==='image')return 'image';
  if(info.type==='gif')return 'gif';
  if(info.type==='audio')return null;
  const ext=(info.name.split('.').pop()||'').toLowerCase();
  if(['apk','ipa','exe','dmg','deb','rpm','msi','app','xapk'].includes(ext))return 'software';
  if(['pdf','doc','docx','xls','xlsx','ppt','pptx','txt','md','csv','epub','zip','rar','7z'].includes(ext))return 'document';
  return 'document';
}

// ===== 主题 =====
function applyTheme(){const t=localStorage.getItem('tg_theme')||'light';const a=localStorage.getItem('tg_accent')||'blue';document.documentElement.setAttribute('data-theme',t);document.documentElement.setAttribute('data-accent',a);
  el.segTheme.querySelectorAll('button').forEach(b=>b.classList.toggle('sel',b.dataset.v===t));
  el.segAccent.querySelectorAll('button').forEach(b=>b.classList.toggle('sel',b.dataset.v===a));}

// ===== 头像 =====
async function loadAvatarInto(node, entity){
  if(!node||!entity)return;
  try{
    const buf=await client.downloadProfilePhoto(entity);
    if(buf&&buf.length){const url=URL.createObjectURL(new Blob([buf],{type:'image/jpeg'}));node.style.backgroundImage=`url(${url})`;node.style.backgroundSize='cover';node.textContent='';node.style.background=node.style.background;return;}
  }catch(e){}
  node.style.backgroundImage='';node.textContent=getInitials(chatName(entity));node.style.background=avatarBg(chatName(entity));
}
async function getSender(msg){
  if(msg.sender&&msg.sender.className)return msg.sender;
  if(!msg.senderId)return null;
  if(senderCache.has(msg.senderId))return senderCache.get(msg.senderId);
  try{const u=await client.getEntity(msg.senderId);if(u){senderCache.set(msg.senderId,u);return u;}}catch(e){}
  return null;
}

// ===== 懒加载（进入视口才拉缩略图/首帧）=====
function ensureObserver(){
  if(lazyObserver)return;
  lazyObserver=new IntersectionObserver((entries)=>{
    for(const e of entries){if(e.isIntersecting){const node=e.target;lazyObserver.unobserve(node);if(node._thumbMsg)loadThumb(node,node._thumbMsg);}}
  },{root:el.messages,rootMargin:'200px'});
}
async function loadThumb(node,msg){
  try{
    const info=mediaInfo(msg);
    if(!info)return;
    const buf=await client.downloadMedia(msg,{thumb:true});
    if(buf&&buf.length){
      const url=URL.createObjectURL(new Blob([buf],{type:'image/jpeg'}));
      if(info.type==='gif'){
        const g=document.createElement('img');g.src=url;g.style.maxWidth='200px';g.style.borderRadius='8px';
        if(node.querySelector('.lazy-ph'))node.querySelector('.lazy-ph').replaceWith(g);else node.appendChild(g);
      }else{
        node.style.backgroundImage=`url(${url})`;node.style.backgroundSize='cover';
      }
    }
  }catch(e){}
}

// ===== 认证 =====
async function init(){
  applyTheme();
  const sessionStr=localStorage.getItem('tg_session')||'';
  client=new TelegramClient(new StringSession(sessionStr),API_ID,API_HASH,{connectionRetries:5,retryDelay:2000,useWSS:true,networkSocket:ProxiedWebSockets});
  client.addEventHandler(onNewMessage,new NewMessage({}));
  const saved=localStorage.getItem('tg_self');
  if(saved){try{const me=JSON.parse(saved);showAccount(me);}catch(e){}}
  if(!sessionStr||sessionStr.length<20){
    const phone=prompt('请输入手机号（含国家码，如 +8613800000000）：');
    if(!phone){el.messages.innerHTML='<div class="empty-hint">未登录</div>';return;}
    try{
      await client.connect();
      const sent=await client.sendCode({apiId:API_ID,apiHash:API_HASH,phoneNumber:phone});
      const code=prompt('请输入 Telegram 发来的验证码：');
      const sign=await client.signIn({phoneNumber:phone,phoneCodeHash:sent.phoneCodeHash,phoneCode:code});
      finishLogin(sign);
    }catch(e){alert('登录失败：'+e.message);}
    return;
  }
  try{
    await client.connect();
    const me=await client.getMe();
    finishLogin(me,true);
  }catch(e){toast('连接失败：'+e.message);el.messages.innerHTML='<div class="empty-hint">连接失败</div>';}
}
function finishLogin(me,silent){
  localStorage.setItem('tg_session',client.session.save());
  try{localStorage.setItem('tg_self',JSON.stringify({id:me.id,firstName:me.firstName,lastName:me.lastName,username:me.username,phone:me.phone}));}catch(e){}
  showAccount(me);
  loadDialogs();
}
function showAccount(me){
  el.accName.textContent=[me.firstName,me.lastName].filter(Boolean).join(' ')||me.username||'用户';
  el.accSub.textContent=me.username?('@'+me.username):(me.phone||'');
  if(typeof me.id==='number'){client&&client.getEntity(me).then(e=>loadAvatarInto(el.accAvatar,e)).catch(()=>{});}
}

// ===== 对话列表 =====
async function loadDialogs(){
  try{
    const dialogs=await client.getDialogs({limit:50});
    currentDialogs=dialogs.map(d=>({entity:d.entity,name:chatName(d.entity),message:d.message,id:d.entity.id,date:d.message?.date}));
    renderDialogs(currentDialogs);
    fillNetdiskSelect(dialogs.map(d=>d.entity));
  }catch(e){toast('加载对话失败：'+e.message);}
}
function renderDialogs(list){
  el.dialogs.innerHTML='';
  if(!list.length){el.dialogs.innerHTML='<div class="empty-hint">没有对话</div>';return;}
  for(const d of list){
    const div=document.createElement('div');div.className='dialog';div.dataset.id=d.id;
    const av=document.createElement('div');av.className='avatar';
    const meta=document.createElement('div');meta.className='meta';
    const name=document.createElement('div');name.className='name';name.textContent=d.name;
    const last=document.createElement('div');last.className='last';
    last.textContent=d.message?(d.message.message||(d.message.media?'[媒体]':'')):'';
    meta.append(name,last);
    const right=document.createElement('div');right.style.display='flex';right.style.flexDirection='column';right.style.alignItems='flex-end';
    const time=document.createElement('div');time.className='time';time.textContent=d.date?fmtTime(d.date).split(' ')[1]:'';
    right.appendChild(time);
    if(d.joined===false){
      const jb=document.createElement('button');jb.className='join-btn';jb.textContent='加入';
      jb.onclick=(ev)=>{ev.stopPropagation();joinChannel(d.entity);};
      right.appendChild(jb);
    }
    div.append(av,meta,right);
    div.onclick=()=>openChat(d.entity);
    el.dialogs.appendChild(div);
    loadAvatarInto(av,d.entity);
  }
}

// 搜索：本地过滤 + 全局频道搜索（可加入）
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
  currentEntity=entity;
  currentMediaList=[];
  senderCache.clear();
  el.chatHeader.style.display='flex';
  el.composer.style.display='flex';
  el.chatTitle.textContent=chatName(entity);
  await loadAvatarInto(el.chatAvatar,entity);
  const grp=isGroup(entity);
  el.chatStatus.textContent=grp?(entity.className==='Channel'?(entity.megaGroup?'群组':'频道'):'群组'):'';
  renderMessages();
  loadMessages();
  loadDetails(entity);
  document.querySelectorAll('.dialog').forEach(d=>d.classList.toggle('active',String(d.dataset.id)===String(entity.id)));
}
async function loadMessages(){
  try{
    const msgs=await client.getMessages(currentEntity,{limit:40});
    el.messages.innerHTML='';
    currentMediaList=[];
    for(const m of msgs.reverse())await appendMessage(m,false);
    el.messages.scrollTop=el.messages.scrollHeight;
  }catch(e){toast('加载消息失败：'+e.message);}
}
function renderMessages(){el.messages.innerHTML='<div class="loading-spinner"></div>';}

// ===== 渲染单条消息 =====
async function appendMessage(msg, prepend){
  const info=mediaInfo(msg);
  const row=document.createElement('div');row.className='row '+(msg.out?'out':'in');
  const bubble=document.createElement('div');bubble.className='msg';
  bubble.dataset.id=msg.id;
  const grp=isGroup(currentEntity);
  if(!msg.out&&grp){
    const s=await getSender(msg);
    if(s){
      const sa=document.createElement('div');sa.className='avatar sm inline';
      await loadAvatarInto(sa,s);
      bubble.appendChild(sa);
      const sn=document.createElement('div');sn.className='sender';sn.textContent=chatName(s);bubble.appendChild(sn);
    }
  }
  let html='';
  if(msg.message&&typeof msg.message==='string'&&msg.message.trim())html+=`<div class="text">${escapeHtml(msg.message)}</div>`;
  bubble.innerHTML+=html;
  if(info){
    const media=document.createElement('div');media.className='msg-media';
    if(info.type==='photo'||info.type==='video'||info.type==='gif'){
      media.classList.add('lazy-ph-host');
      media._thumbMsg=msg;
      media.innerHTML='<div class="lazy-ph" style="width:200px;height:150px;background:var(--tg-attach);border-radius:8px;"></div>';
      if(info.type!=='photo'){
        const ov=document.createElement('div');ov.className='play-overlay';ov.innerHTML=ICONS.play;
        media.appendChild(ov);
      }
      ensureObserver();lazyObserver.observe(media);
    }else{
      const fc=document.createElement('div');fc.className='file-card';
      fc.innerHTML=`<div class="fi">${ICONS.file}</div><div style="min-width:0"><div class="fn">${escapeHtml(info.name)}</div><div class="fs">${fmtSize(info.size)}</div></div>`;
      media.appendChild(fc);
    }
    bubble.appendChild(media);
    currentMediaList.push(msg);
  }
  // 操作按钮：查看/下载/分享/删除
  const acts=document.createElement('div');acts.className='msg-actions';
  acts.innerHTML=`
    <button class="act-btn" data-act="view" title="查看">${ICONS.view}</button>
    <button class="act-btn" data-act="download" title="下载">${ICONS.download}</button>
    <button class="act-btn" data-act="share" title="分享">${ICONS.share}</button>
    <button class="act-btn del" data-act="delete" title="删除">${ICONS.del}</button>`;
  bubble.appendChild(acts);
  const mt=document.createElement('div');mt.className='mt';mt.textContent=fmtTime(msg.date).split(' ')[1]||'';bubble.appendChild(mt);
  row.appendChild(bubble);
  if(prepend)el.messages.insertBefore(row,el.messages.firstChild);else el.messages.appendChild(row);
}

// 点击处理：播放 / 操作按钮 / 打开查看器
el.messages.addEventListener('click',async(e)=>{
  const actBtn=e.target.closest('.act-btn');
  if(actBtn){
    const id=parseInt(actBtn.closest('.msg').dataset.id);
    const msg=currentMediaList.find(m=>m.id===id)||await findMsg(id);
    if(!msg)return;
    const act=actBtn.dataset.act;
    if(act==='view'){const idx=currentMediaList.findIndex(m=>m.id===id);if(idx>=0)openViewer(currentMediaList,idx,'chat');}
    else if(act==='download')downloadMedia(msg);
    else if(act==='share')shareMedia(msg);
    else if(act==='delete')deleteMessage(id);
    return;
  }
  const play=e.target.closest('.play-overlay');
  if(play){const host=play.closest('.msg-media');const id=parseInt(play.closest('.msg').dataset.id);const msg=currentMediaList.find(m=>m.id===id);if(msg)playVideo(host,msg);return;}
  const media=e.target.closest('.msg-media');
  if(media&&!e.target.closest('.msg-actions')){const id=parseInt(media.closest('.msg').dataset.id);const idx=currentMediaList.findIndex(m=>m.id===id);if(idx>=0)openViewer(currentMediaList,idx,'chat');}
});
async function findMsg(id){try{const m=await client.getMessages(currentEntity,{ids:[id]});return m[0];}catch(e){return null;}}

// 视频：带进度条下载后播放
async function playVideo(host,msg){
  const info=mediaInfo(msg);
  const mime=(msg.video&&msg.video.mimeType)||(msg.document&&msg.document.mimeType)||'video/mp4';
  host.innerHTML=`<div class="progress"><i></i></div>`;
  try{
    const buf=await client.downloadMedia(msg,{progressCallback:p=>{const bar=host.querySelector('.progress > i');if(bar)bar.style.width=Math.round(p*100)+'%';}});
    if(!buf||!buf.length){host.innerHTML='❌ 播放失败';return;}
    const url=URL.createObjectURL(new Blob([buf],{type:mime}));
    host.innerHTML=`<video controls autoplay src="${url}" style="max-width:300px;max-height:340px;border-radius:10px;background:#000;"></video>`;
  }catch(e){host.innerHTML='❌ 播放失败';}
}

// ===== 发送 =====
el.btnSend.addEventListener('click',sendText);
el.msgInput.addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();sendText();}});
async function sendText(){
  const t=el.msgInput.value.trim();if(!t||!currentEntity)return;
  el.msgInput.value='';
  try{const m=await client.sendMessage(currentEntity,{message:t});appendMessage(m,false);el.messages.scrollTop=el.messages.scrollHeight;}catch(e){toast('发送失败：'+e.message);}
}
el.btnAttach.addEventListener('click',()=>el.fileInput.click());
el.fileInput.addEventListener('change',e=>{if(e.target.files.length)sendFiles(e.target.files);e.target.value='';});

// ⭐ 修复核心：File → ArrayBuffer → CustomFile（buffer 必须是 ArrayBuffer，不能是 File 对象）
async function sendFiles(files){
  if(!currentEntity)return;
  for(const f of files){
    try{
      const isImage=/^image\//.test(f.type||'');
      const arrBuf=await f.arrayBuffer();
      const cf=new CustomFile(f.name,arrBuf.byteLength,'',arrBuf);
      await client.sendFile(currentEntity,{file:cf,forceDocument:!isImage,caption:f.name});
      toast('已发送：'+f.name);
    }catch(err){toast('发送失败：'+(err&&err.message?err.message:err));}
  }
  loadMessages();
}

// ===== 删除消息 =====
async function deleteMessage(id){
  if(!confirm('确定删除这条消息？'))return;
  try{
    await client.deleteMessages(currentEntity,[id],{revoke:true});
    const row=[...el.messages.querySelectorAll('.msg')].find(b=>b.dataset.id==id);
    if(row)row.closest('.row').remove();
    toast('已删除');
  }catch(e){toast('删除失败：'+e.message);}
}

// ===== 下载 / 分享 =====
async function downloadMedia(msg){
  try{
    const info=mediaInfo(msg);const name=info?info.name:'file';
    const buf=await client.downloadMedia(msg);if(!buf||!buf.length){toast('下载为空');return;}
    const mime=info?info.mime:'application/octet-stream';
    const url=URL.createObjectURL(new Blob([buf],{type:mime}));
    const a=document.createElement('a');a.href=url;a.download=name;a.click();
    setTimeout(()=>URL.revokeObjectURL(url),10000);
  }catch(e){toast('下载失败：'+e.message);}
}
async function shareMedia(msg){
  const info=mediaInfo(msg);const name=info?info.name:'文件';
  if(navigator.share){
    try{const buf=await client.downloadMedia(msg);const file=new File([buf],name,{type:info?info.mime:'application/octet-stream'});await navigator.share({files:[file],title:name});return;}catch(e){}
  }
  let link='';
  if(msg.chat&&msg.chat.username)link=`https://t.me/${msg.chat.username}/${msg.id}`;
  else if(currentEntity&&currentEntity.username)link=`https://t.me/${currentEntity.username}/${msg.id}`;
  if(link){await navigator.clipboard.writeText(link);toast('链接已复制');}
  else toast('该消息无可分享链接');
}

// ===== 媒体查看器 =====
function openViewer(list,idx,mode){viewerList=list;viewerIndex=idx;viewerMode=mode;renderViewer();el.viewer.classList.add('open');}
function renderViewer(){
  const msg=viewerList[viewerIndex];if(!msg){closeViewer();return;}
  const info=mediaInfo(msg);
  el.viewerVideo.style.display='none';el.viewerMedia.style.display='none';el.viewerCap.textContent='';
  if(info&&(info.type==='video'||info.type==='gif')){
    el.viewerMedia.style.display='none';el.viewerVideo.style.display='block';
    el.viewerVideo.innerHTML='<div class="progress" style="width:300px"><i></i></div>';
    client.downloadMedia(msg,{progressCallback:p=>{const b=el.viewerVideo.querySelector('.progress > i');if(b)b.style.width=Math.round(p*100)+'%';}}).then(buf=>{
      if(!buf||!buf.length){el.viewerVideo.innerHTML='❌';return;}
      const mime=(msg.video&&msg.video.mimeType)||(msg.document&&msg.document.mimeType)||'video/mp4';
      const url=URL.createObjectURL(new Blob([buf],{type:mime}));
      el.viewerVideo.src=url;el.viewerVideo.play();
    }).catch(()=>{el.viewerVideo.innerHTML='❌';});
  }else if(info&&info.type==='image'){
    el.viewerMedia.style.display='block';
    client.downloadMedia(msg).then(buf=>{if(buf&&buf.length)el.viewerMedia.src=URL.createObjectURL(new Blob([buf],{type:'image/jpeg'}));}).catch(()=>{});
  }else{
    el.viewerMedia.style.display='block';el.viewerMedia.alt='[文件] '+ (info?info.name:'');
    el.viewerCap.textContent=(info?info.name:'')+'  ·  '+fmtSize(info?info.size:0);
  }
}
function closeViewer(){el.viewer.classList.remove('open');el.viewerVideo.pause();el.viewerVideo.removeAttribute('src');}
el.viewerClose.onclick=closeViewer;
el.viewerPrev.onclick=()=>{if(viewerIndex>0){viewerIndex--;renderViewer();}};
el.viewerNext.onclick=()=>{if(viewerIndex<viewerList.length-1){viewerIndex++;renderViewer();}};
el.viewerDownload.onclick=()=>{if(viewerList&&viewerList[viewerIndex])downloadMedia(viewerList[viewerIndex]);};
el.viewerShare.onclick=()=>{if(viewerList&&viewerList[viewerIndex])shareMedia(viewerList[viewerIndex]);};
// 触摸左右滑动
let touchX=null;
el.viewer.addEventListener('touchstart',e=>touchX=e.touches[0].clientX);
el.viewer.addEventListener('touchend',e=>{if(touchX===null)return;const dx=e.changedTouches[0].clientX-touchX;if(dx>60&&viewerIndex>0){viewerIndex--;renderViewer();}else if(dx<-60&&viewerIndex<viewerList.length-1){viewerIndex++;renderViewer();}touchX=null;});
document.addEventListener('keydown',e=>{if(!el.viewer.classList.contains('open'))return;if(e.key==='ArrowLeft'&&viewerIndex>0){viewerIndex--;renderViewer();}if(e.key==='ArrowRight'&&viewerIndex<viewerList.length-1){viewerIndex++;renderViewer();}if(e.key==='Escape')closeViewer();});

// ===== 右侧详情面板 =====
async function loadDetails(entity){
  el.detailsPlaceholder.style.display='none';el.detailsContent.classList.add('show');
  el.dName.textContent=chatName(entity);
  el.dSub.textContent=entity.className==='User'?(entity.username?('@'+entity.username):(entity.phone||'')):(entity.className==='Channel'?(entity.megaGroup?'群组':'频道'):'群组');
  await loadAvatarInto(el.dAvatar,entity);
  el.dAbout.textContent='加载中…';el.dStat.innerHTML='';
  try{
    let about='',stat='';
    if(entity.className==='User'){
      const r=await client.invoke(new Api.users.GetFullUser({id:await client.getInputEntity(entity)}));
      about=r.fullUser.about||'';
    }else{
      const r=await client.invoke(new Api.channels.GetFullChannel({channel:await client.getInputEntity(entity)}));
      about=r.fullChat.about||'';
      const pc=r.fullChat.participantsCount;
      stat=`<div><b>${pc||'—'}</b><span>成员</span></div>`;
    }
    el.dAbout.textContent=about||'暂无简介';
    if(stat)el.dStat.innerHTML=stat;
  }catch(e){el.dAbout.textContent='';}
}

// ===== 聊天菜单：加入 / 退出 / 删除 =====
el.btnChatMenu.onclick=(ev)=>{
  if(!currentEntity)return;
  const m=el.chatMenu;m.innerHTML='';
  const grp=isGroup(currentEntity);
  if(grp){
    if(currentEntity.className==='Channel'&&!currentEntity.megaGroup){
      // 频道：已加入可退出
      const b=document.createElement('button');b.textContent=currentEntity.left?'加入频道':'退出频道';
      b.onclick=()=>{currentEntity.left?joinChannel(currentEntity):leaveChannel(currentEntity);hideMenu();};
      m.appendChild(b);
    }else{
      const b=document.createElement('button');b.textContent='退出群组';b.className='danger';
      b.onclick=()=>{leaveChannel(currentEntity);hideMenu();};m.appendChild(b);
    }
  }else{
    const b=document.createElement('button');b.textContent='删除对话';b.className='danger';
    b.onclick=()=>{deleteChat(currentEntity);hideMenu();};m.appendChild(b);
  }
  const b2=document.createElement('button');b2.textContent='查看详情';b2.onclick=()=>{hideMenu();loadDetails(currentEntity);};m.appendChild(b2);
  const r=ev.target.getBoundingClientRect();m.style.top=(r.bottom+6)+'px';m.style.right=(window.innerWidth-r.right)+'px';m.classList.add('open');
};
function hideMenu(){el.chatMenu.classList.remove('open');}
document.addEventListener('click',e=>{if(!e.target.closest('#btnChatMenu')&&!e.target.closest('#chatMenu'))hideMenu();});
async function joinChannel(entity){try{await client.invoke(new Api.channels.JoinChannel({channel:await client.getInputEntity(entity)}));toast('已加入');loadDialogs();}catch(e){toast('加入失败：'+e.message);}}
async function leaveChannel(entity){if(!confirm('确定退出？'))return;try{await client.invoke(new Api.channels.LeaveChannel({channel:await client.getInputEntity(entity)}));toast('已退出');currentEntity=null;el.chatHeader.style.display='none';el.composer.style.display='none';el.messages.innerHTML='<div class="empty-hint">选择左侧对话开始聊天</div>';el.detailsContent.classList.remove('show');el.detailsPlaceholder.style.display='flex';loadDialogs();}catch(e){toast('退出失败：'+e.message);}}
async function deleteChat(entity){if(!confirm('确定删除该对话？'))return;try{await client.invoke(new Api.messages.DeleteHistory({peer:await client.getInputEntity(entity),maxId:0}));toast('已删除');currentEntity=null;el.chatHeader.style.display='none';el.composer.style.display='none';el.messages.innerHTML='<div class="empty-hint">选择左侧对话开始聊天</div>';loadDialogs();}catch(e){toast('删除失败：'+e.message);}}

// ===== 设置面板 =====
el.btnMenu.onclick=()=>el.settings.classList.add('open');
el.segTheme.querySelectorAll('button').forEach(b=>b.onclick=()=>{localStorage.setItem('tg_theme',b.dataset.v);applyTheme();});
el.segAccent.querySelectorAll('button').forEach(b=>b.onclick=()=>{localStorage.setItem('tg_accent',b.dataset.v);applyTheme();});
el.btnLogout.onclick=()=>{if(confirm('退出登录将清除本地登录态')){localStorage.removeItem('tg_session');localStorage.removeItem('tg_self');location.reload();}};

// ===== 网盘 =====
function fillNetdiskSelect(entities){
  el.netdiskSelect.innerHTML='<option value="">— 请选择频道 —</option>';
  for(const e of entities){if(e.className==='Channel'){const o=document.createElement('option');o.value=String(e.id);o.textContent=chatName(e);el.netdiskSelect.appendChild(o);}}
}
el.btnNetdisk.onclick=()=>el.netdisk.classList.add('open');
el.btnNetdiskClose.onclick=el.btnNetdiskBack.onclick=()=>el.netdisk.classList.remove('open');
el.btnEnterNetdisk.onclick=()=>{
  const id=el.netdiskSelect.value;if(!id){toast('请先选择频道');return;}
  const ent=currentDialogs.find(d=>String(d.id)===id)?.entity;if(!ent){toast('未找到该频道');return;}
  netdiskChannel=ent;el.netdisk.classList.add('open');loadNetdisk('all');
};
el.netdiskTabs.addEventListener('click',e=>{const b=e.target.closest('button');if(!b)return;el.netdiskTabs.querySelectorAll('button').forEach(x=>x.classList.remove('sel'));b.classList.add('sel');loadNetdisk(b.dataset.cat);});
async function loadNetdisk(cat){
  if(!netdiskChannel)return;
  el.netdiskGrid.innerHTML='<div class="loading-spinner"></div>';
  try{
    const msgs=await client.getMessages(netdiskChannel,{limit:80});
    netdiskMediaList=msgs.filter(m=>mediaInfo(m));
    renderNetdisk(cat);
  }catch(e){el.netdiskGrid.innerHTML='<div class="empty-hint">加载失败：'+e.message+'</div>';}
}
function renderNetdisk(cat){
  const list=cat==='all'?netdiskMediaList:netdiskMediaList.filter(m=>netdiskCategory(m)===cat);
  el.netdiskGrid.innerHTML='';
  if(!list.length){el.netdiskGrid.innerHTML='<div class="empty-hint">暂无文件</div>';return;}
  list.forEach((msg,i)=>{
    const info=mediaInfo(msg);const card=document.createElement('div');card.className='nk-card';
    const th=document.createElement('div');th.className='nk-thumb';
    if(info.type==='photo'||info.type==='gif')th._thumbMsg=msg;
    else if(info.type==='video'){th.classList.add('play');th.textContent='🎬';th._thumbMsg=msg;}
    else th.innerHTML=ICONS.file;
    const nm=document.createElement('div');nm.className='nk-name';nm.textContent=info.name;
    card.append(th,nm);
    card.onclick=()=>openViewer(list,i,'netdisk');
    el.netdiskGrid.appendChild(card);
    if(th._thumbMsg){ensureObserver();lazyObserver.observe(th);}
  });
}
el.btnNetdiskUpload.onclick=()=>el.netdiskFileInput.click();
el.netdiskFileInput.addEventListener('change',async(e)=>{
  if(!netdiskChannel)return;
  for(const f of e.target.files){
    try{
      const isImage=/^image\//.test(f.type||'');
      const arrBuf=await f.arrayBuffer();
      const cf=new CustomFile(f.name,arrBuf.byteLength,'',arrBuf);
      await client.sendFile(netdiskChannel,{file:cf,forceDocument:!isImage,caption:f.name});
    }catch(err){toast('上传失败：'+(err&&err.message?err.message:err));}
  }
  e.target.value='';loadNetdisk(el.netdiskTabs.querySelector('.sel').dataset.cat);
});

// ===== 实时消息 =====
async function onNewMessage(event){
  const msg=event.message;if(!msg||!msg.message&&!msg.media)return;
  if(currentEntity&&msg.chat&&msg.chat.id===currentEntity.id){
    appendMessage(msg,false);el.messages.scrollTop=el.messages.scrollHeight;
  }
  if(netdiskChannel&&msg.chat&&msg.chat.id===netdiskChannel.id){
    if(mediaInfo(msg)){netdiskMediaList.unshift(msg);renderNetdisk(el.netdiskTabs.querySelector('.sel').dataset.cat);}
  }
}

// ===== 返回（移动端）=====
el.btnBack.onclick=()=>{
  if(window.innerWidth<900&&currentEntity){currentEntity=null;el.chatHeader.style.display='none';el.composer.style.display='none';el.messages.innerHTML='<div class="empty-hint">选择左侧对话开始聊天</div>';el.detailsContent.classList.remove('show');el.detailsPlaceholder.style.display='flex';}
};

init();
