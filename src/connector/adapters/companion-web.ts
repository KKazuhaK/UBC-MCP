import {DEFAULT_INSTALL_URL} from '../readiness.js';
/**
 * Step 2 of the connection page: connect this browser's UBC Course Capture extension.
 * The extension's bridge script answers on the default Hub; elsewhere the page offers the
 * address and a pairing code to type into the extension instead.
 */
export const companionStep=`<li class="step"><span class="num">2</span><div><h3>连接此浏览器</h3><p id="companion-line">正在检测 UBC Course Capture 扩展…</p>
<div class="actions"><button id="companion-connect" hidden>连接此浏览器</button><a id="companion-install" class="button-link" href="${DEFAULT_INSTALL_URL}" target="_blank" rel="noopener" hidden>安装浏览器扩展 ↗</a></div>
<details id="companion-manual"><summary>无法自动连接？</summary><p>打开扩展，展开「Another MCPHub, or a pairing code」，填写下面的地址和配对码。</p><div class="code-row"><code id="hub-address" class="endpoint">{{PLATFORM_ORIGIN}}</code><button id="copy-hub" class="secondary">复制地址</button></div>
<div class="actions" style="margin-top:12px"><button id="show-code" class="secondary">生成配对码</button></div><div id="code-box" class="pair-box" hidden><div class="code-row"><textarea id="pair-code" readonly aria-label="配对码"></textarea><button id="copy-code" class="secondary">复制</button></div><p class="pair-note subtle">配对码 5 分钟内有效，只能使用一次。</p></div></details></div></li>`;
export const companionStyle='.button-link{display:inline-flex;align-items:center;min-height:40px;padding:10px 16px;border-radius:8px;background:var(--navy);color:white;font-size:13px;font-weight:600}.button-link:hover{text-decoration:none;background:#115370}.button-link[hidden]{display:none}#companion-manual{margin-top:14px;padding-top:14px}';
/**
 * Expects the page script to define $, feedback, run, connected and companionHooks:
 * {pair():Promise<{code}>, startAccount():Promise<'redirect'|void>}.
 */
export const companionScript=String.raw`
const companion={state:'detecting',connected:false},CHANNEL='ubc-companion';let companionWaiting=null;
const hasWindow=typeof window!=='undefined'&&typeof window.addEventListener==='function'&&typeof window.postMessage==='function';
function companionPost(message){window.postMessage({channel:CHANNEL,from:'page',...message},location.origin);}
function companionRender(){
  const line=$('companion-line'),button=$('companion-connect'),install=$('companion-install');if(!line)return;
  button.hidden=companion.state!=='present';install.hidden=companion.state!=='absent';
  if(companion.state==='detecting')line.textContent='正在检测 UBC Course Capture 扩展…';
  else if(companion.state==='absent')line.textContent='未检测到扩展。安装后这个页面会自动打开，回来点一下「连接此浏览器」即可。';
  else if(companion.connected){line.textContent='此浏览器已连接，扩展会自动同步 Workday 数据。';if(!busy)button.textContent='重新连接此浏览器';button.classList.add('secondary');}
  else{line.textContent=connected?'已检测到扩展。点击下方按钮，此浏览器会自动完成配置并开始同步。':'已检测到扩展。点击下方按钮，先授权 MCPHub 账号，回来后自动完成配置。';if(!busy)button.textContent='连接此浏览器';button.classList.remove('secondary');}
}
function companionFlag(set){try{if(set===true)sessionStorage.setItem('ubc-companion-continue','1');else if(set===false)sessionStorage.removeItem('ubc-companion-continue');else return sessionStorage.getItem('ubc-companion-continue')==='1';}catch{return false;}}
async function companionConnect(){
  if(!connected){companionFlag(true);if(await companionHooks.startAccount()==='redirect')return;}
  const pairing=await companionHooks.pair();
  const result=await new Promise(resolve=>{companionWaiting=resolve;companionPost({type:'connect',code:pairing.code});setTimeout(()=>resolve({ok:false,error:'扩展没有响应。请刷新页面后重试。'}),20000);});
  companionWaiting=null;
  if(!result.ok)throw new Error(result.error||'连接失败，请重试。');
  companion.connected=true;
  feedback('此浏览器已连接。扩展已开始第一次同步，稍后点击「刷新状态」即可看到记录。','success');
}
function companionStart(){return run('companion-connect',companionConnect).then(companionRender);}
let continueTries=0;
function companionContinue(){
  if(!companionFlag()||companion.state!=='present'||!connected)return;
  if(busy){if(continueTries++<20)setTimeout(companionContinue,300);return;}
  companionFlag(false);if(!companion.connected)void companionStart();
}
$('companion-connect').onclick=companionStart;
$('show-code').onclick=()=>run('show-code',async()=>{
  if(!connected)throw new Error('请先完成第 1 步，连接 MCPHub 账号。');
  const pairing=await companionHooks.pair();$('pair-code').value=pairing.code;$('code-box').hidden=false;
  feedback('配对码已生成，5 分钟内在扩展中使用。','success');
});
$('copy-code').onclick=async()=>{try{await navigator.clipboard.writeText($('pair-code').value);$('copy-code').textContent='已复制';setTimeout(()=>{$('copy-code').textContent='复制';},2000);}catch{$('pair-code').select();feedback('请按 Ctrl+C 或 ⌘C 复制选中的配对码。');}};
if(hasWindow){
  window.addEventListener('message',event=>{
    if(event.source!==window||event.origin!==location.origin)return;
    const data=event.data;if(!data||data.channel!==CHANNEL||data.from!=='extension')return;
    if(data.type==='ready'){companion.state='present';companion.connected=!!data.connected;companionRender();companionContinue();}
    else if(data.type==='result'&&companionWaiting)companionWaiting(data);
  });
  companionPost({type:'hello'});
  setTimeout(()=>{if(companion.state==='detecting'){companion.state='absent';companionRender();}},1500);
}else companion.state='absent';
companionRender();`;
