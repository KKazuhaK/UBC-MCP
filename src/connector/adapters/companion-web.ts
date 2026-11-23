import {DEFAULT_INSTALL_URL} from '../readiness.js';
/**
 * Step 2 of the connection page: connect this browser's UBC Course Capture extension.
 * The extension's bridge script answers on the default Hub; elsewhere the page offers the
 * address and a pairing code to type into the extension instead.
 */
export const companionStep=`<li class="step"><span class="num">2</span><div><h3><span data-zh="连接此浏览器">Connect this browser</span></h3><p id="companion-line"><span data-zh="正在检测 UBC Course Capture 扩展…">Looking for the UBC Course Capture extension…</span></p>
<p id="companion-sync-line" class="subtle" hidden></p>
<div class="actions"><button id="companion-sync" hidden><span data-zh="立即同步">Sync now</span></button><button id="companion-connect" hidden><span data-zh="连接此浏览器">Connect this browser</span></button><a id="companion-install" class="button-link" href="${DEFAULT_INSTALL_URL}" target="_blank" rel="noopener" hidden><span data-zh="安装浏览器扩展 ↗">Install the browser extension ↗</span></a></div>
<details id="companion-manual"><summary><span data-zh="无法自动连接？">Can't connect automatically?</span></summary><p><span data-zh="打开扩展，展开「Another MCPHub, or a pairing code」，填写下面的地址和配对码。">Open the extension, expand “MCPHub address, or a pairing code”, and enter the address and pairing code below.</span></p><div class="code-row"><code id="hub-address" class="endpoint">{{PLATFORM_ORIGIN}}</code><button id="copy-hub" class="secondary"><span data-zh="复制地址">Copy address</span></button></div>
<div class="actions" style="margin-top:12px"><button id="show-code" class="secondary"><span data-zh="生成配对码">Generate a pairing code</span></button></div><div id="code-box" class="pair-box" hidden><div class="code-row"><textarea id="pair-code" readonly aria-label="Pairing code" data-zh-label="配对码"></textarea><button id="copy-code" class="secondary"><span data-zh="复制">Copy</span></button></div><p class="pair-note subtle"><span data-zh="配对码 5 分钟内有效，只能使用一次。">The pairing code works once, within 5 minutes.</span></p></div></details></div></li>`;
export const companionStyle='.button-link{display:inline-flex;align-items:center;min-height:40px;padding:10px 16px;border-radius:8px;background:var(--navy);color:white;font-size:13px;font-weight:600}.button-link:hover{text-decoration:none;background:#115370}.button-link[hidden]{display:none}#companion-manual{margin-top:14px;padding-top:14px}';
/**
 * Expects the page script to define $, feedback, run, connected and companionHooks:
 * {pair():Promise<{code}>, startAccount():Promise<'redirect'|void>, refresh?():Promise<void>}.
 */
export const companionScript=String.raw`
const companion={state:'detecting',connected:false,pending:false,lastSyncAt:null,syncError:null},CHANNEL='ubc-companion';let companionWaiting=null,companionSyncWaiting=null,autoSynced=false;
/** Opening the page syncs by itself when the data is older than this. */
const AUTO_SYNC_MS=60*60_000;
const hasWindow=typeof window!=='undefined'&&typeof window.addEventListener==='function'&&typeof window.postMessage==='function';
function companionPost(message){window.postMessage({channel:CHANNEL,from:'page',...message},location.origin);}
function companionRender(){
  const line=$('companion-line'),button=$('companion-connect'),install=$('companion-install');if(!line)return;
  button.hidden=companion.state!=='present';install.hidden=companion.state!=='absent';
  const linked=companion.state==='present'&&companion.connected,sync=$('companion-sync'),syncLine=$('companion-sync-line');
  sync.hidden=!linked;syncLine.hidden=!linked;
  if(linked)syncLine.textContent=(companion.lastSyncAt?L('Last sync: ','上次同步：')+companionAgo(companion.lastSyncAt):L('Not synced yet','尚未同步'))+(companion.syncError?L('. Last problem: ','。上次的问题：')+companion.syncError:'');
  if(companion.state==='detecting')line.textContent=L('Looking for the UBC Course Capture extension…','正在检测 UBC Course Capture 扩展…');
  else if(companion.state==='absent')line.textContent=L('The extension isn\'t connected yet. After installing UBC Course Capture, click its icon in the browser toolbar on this page and allow access; the page then finishes connecting by itself.','还没连上扩展。装好 UBC Course Capture 后，在这个页面点浏览器工具栏里的扩展图标，按提示允许访问，页面就会自动完成连接。');
  else if(companion.connected){line.textContent=L('This browser is connected; the extension syncs Workday data automatically.','此浏览器已连接，扩展会自动同步 Workday 数据。');if(!busy)button.textContent=L('Reconnect this browser','重新连接此浏览器');button.classList.add('secondary');}
  else{line.textContent=connected?L('Extension found. Click the button below and this browser sets itself up and starts syncing.','已检测到扩展。点击下方按钮，此浏览器会自动完成配置并开始同步。'):L('Extension found. Click the button below to authorize your MCPHub account first; setup finishes when you come back.','已检测到扩展。点击下方按钮，先授权 MCPHub 账号，回来后自动完成配置。');if(!busy)button.textContent=L('Connect this browser','连接此浏览器');button.classList.remove('secondary');}
}
function companionAgo(iso){const ms=Date.now()-Date.parse(iso);if(!Number.isFinite(ms))return L('unknown','未知');const m=Math.round(ms/60000);if(m<1)return L('just now','刚刚');if(m<60)return m+L(' min ago',' 分钟前');const h=Math.round(m/60);if(h<48)return h+L(' h ago',' 小时前');return Math.round(h/24)+L(' d ago',' 天前');}
async function companionSync(){
  feedback(L('Syncing Workday data through the extension…','正在通过扩展同步 Workday 数据…'),'loading');
  const result=await new Promise(resolve=>{companionSyncWaiting=resolve;companionPost({type:'sync'});setTimeout(()=>resolve({ok:false,error:L('The sync timed out. Make sure you\'re signed in to Workday in this browser, then try again.','同步超时。请确认已在此浏览器登录 Workday 后重试。')}),90000);});
  companionSyncWaiting=null;
  if(!result.ok)throw new Error(result.error||L('Sync failed. Please try again.','同步失败，请重试。'));
  companion.lastSyncAt=new Date().toISOString();companion.syncError=null;
  if(companionHooks.refresh)await companionHooks.refresh();
  feedback(result.count?L('Synced ','已同步 ')+result.count+L(' snapshots.',' 个快照。'):L('Sync finished; nothing had changed.','同步完成，数据没有变化。'),'success');
}
function companionStartSync(){return run('companion-sync',companionSync).then(companionRender);}
let autoTries=0;
function companionAutoSync(){
  if(autoSynced||companion.state!=='present'||!companion.connected||companionFlag())return;
  const last=Date.parse(companion.lastSyncAt||'');
  if(Number.isFinite(last)&&Date.now()-last<AUTO_SYNC_MS)return;
  if(busy){if(autoTries++<20)setTimeout(companionAutoSync,300);return;}
  autoSynced=true;void companionStartSync();
}
function companionFlag(set){try{if(set===true)sessionStorage.setItem('ubc-companion-continue','1');else if(set===false)sessionStorage.removeItem('ubc-companion-continue');else return sessionStorage.getItem('ubc-companion-continue')==='1';}catch{return false;}}
async function companionConnect(){
  if(!connected){companionFlag(true);if(await companionHooks.startAccount()==='redirect')return;}
  const pairing=await companionHooks.pair();
  const result=await new Promise(resolve=>{companionWaiting=resolve;companionPost({type:'connect',code:pairing.code});setTimeout(()=>resolve({ok:false,error:L('The extension did not answer. Reload the page and try again.','扩展没有响应。请刷新页面后重试。')}),20000);});
  companionWaiting=null;
  if(!result.ok)throw new Error(result.error||L('Connection failed. Please try again.','连接失败，请重试。'));
  companion.connected=true;autoSynced=true;
  feedback(L('This browser is connected. The extension started its first sync; click “Refresh status” in a moment to see the records.','此浏览器已连接。扩展已开始第一次同步，稍后点击「刷新状态」即可看到记录。'),'success');
}
function companionStart(){return run('companion-connect',companionConnect).then(companionRender);}
let continueTries=0;
// The person chose this Hub from the extension's popup: finish connecting without another click.
let autoConnected=false;
function companionAutoConnect(){
  if(autoConnected||!companion.pending||companion.connected||companion.state!=='present')return;
  if(busy){setTimeout(companionAutoConnect,300);return;}
  autoConnected=true;void companionStart();
}
function companionContinue(){
  if(!companionFlag()||companion.state!=='present'||!connected)return;
  if(busy){if(continueTries++<20)setTimeout(companionContinue,300);return;}
  companionFlag(false);if(!companion.connected)void companionStart();
}
$('companion-connect').onclick=companionStart;
$('companion-sync').onclick=companionStartSync;
$('show-code').onclick=()=>run('show-code',async()=>{
  if(!connected)throw new Error(L('Finish step 1 first: connect your MCPHub account.','请先完成第 1 步，连接 MCPHub 账号。'));
  const pairing=await companionHooks.pair();$('pair-code').value=pairing.code;$('code-box').hidden=false;
  feedback(L('Pairing code generated. Use it in the extension within 5 minutes.','配对码已生成，5 分钟内在扩展中使用。'),'success');
});
$('copy-code').onclick=async()=>{try{await navigator.clipboard.writeText($('pair-code').value);$('copy-code').textContent=L('Copied','已复制');setTimeout(()=>{$('copy-code').textContent=L('Copy','复制');},2000);}catch{$('pair-code').select();feedback(L('Press Ctrl+C or ⌘C to copy the selected pairing code.','请按 Ctrl+C 或 ⌘C 复制选中的配对码。'));}};
if(hasWindow){
  window.addEventListener('message',event=>{
    if(event.source!==window||event.origin!==location.origin)return;
    const data=event.data;if(!data||data.channel!==CHANNEL||data.from!=='extension')return;
    if(data.type==='ready'){companion.state='present';companion.connected=!!data.connected;companion.pending=!!data.pending;companion.lastSyncAt=typeof data.lastSyncAt==='string'?data.lastSyncAt:null;companion.syncError=typeof data.syncError==='string'?data.syncError:null;companionRender();companionContinue();companionAutoConnect();companionAutoSync();}
    else if(data.type==='result'&&companionWaiting)companionWaiting(data);
    else if(data.type==='synced'&&companionSyncWaiting)companionSyncWaiting(data);
  });
  companionPost({type:'hello'});
  setTimeout(()=>{if(companion.state==='detecting'){companion.state='absent';companionRender();}},1500);
}else companion.state='absent';
companionRender();`;
