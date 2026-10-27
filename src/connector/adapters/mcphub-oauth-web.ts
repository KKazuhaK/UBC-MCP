import {page as legacyPage} from './mcphub-web.js';
// Reuse the look of the existing connection page without touching it.
const style=/<style>[\s\S]*?<\/style>/.exec(legacyPage)?.[0]??'';
export const page=`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>UBC MCP · 连接管理</title>
${style}
<div class="shell"><nav><div class="brand"><span class="mark" aria-hidden="true">U</span><span>UBC Course Capture</span></div><a class="navlink" href="/">返回 MCPHub ↗</a></nav>
<header class="hero"><div><p class="eyebrow">UBC COURSE CONNECTION</p><h1>连接 UBC 课程数据</h1><p class="subtle">同步课表与班次，在 MCP 中随时查询。</p></div><button id="refresh" class="ghost">刷新状态</button></header>
<p id="status" role="status" aria-live="polite" aria-atomic="true" data-state="loading">正在检查连接…</p>
<section id="extension-login" class="card" hidden><h2>连接 UBC Course Capture 扩展</h2><p>当前 MCPHub 账号：<strong id="extension-account">正在验证…</strong></p><p>使用当前 MCPHub 账号连接此浏览器。扩展会根据设置同步课程快照，不会读取 MCPHub 或 Workday 的密码与 Cookie。</p><button id="extension-authorize">授权并连接扩展</button><p id="extension-result" class="subtle"></p><output id="ubc-extension-authorization" hidden></output></section>
<main class="layout"><div class="stack"><section class="card"><div class="card-head"><div><h2>设置你的连接</h2><span class="subtle">通过标准 OAuth 授权，本服务不会读取你的 MCPHub 登录 Cookie。</span></div><span id="account-state" class="badge">检查中</span></div>
<ol class="steps"><li class="step"><span class="num first">1</span><div><h3>连接 MCPHub 账号</h3><p id="account-line">授权后创建仅属于你的连接，数据只供这个账号查询。</p><div class="actions"><button id="connect">Connect with MCPHub</button><button id="forget" class="secondary" hidden>忘记此浏览器</button></div></div></li>
<li class="step"><span class="num">2</span><div><h3>连接浏览器扩展</h3><p>在扩展中填写当前 MCPHub 地址，点击 Connect with MCPHub，并在此站点确认连接。</p><details id="manual"><summary>手动配对（兼容旧版扩展）</summary><button id="pair" class="secondary">生成配对码</button><section id="pairing" class="pair-box" hidden><div class="pair-title"><h3>一次性配对码</h3><span id="expires">5 分钟内有效</span></div><div class="code-row"><textarea id="code" aria-label="一次性配对码" readonly spellcheck="false"></textarea><button id="copy" class="secondary" disabled>复制</button></div><p class="pair-note">只能使用一次，请勿分享给其他人。生成新码后，旧码立即失效。</p></section></details></div></li>
<li class="step"><span class="num">3</span><div><h3>同步课程数据</h3><p>保持浏览器运行并登录 Workday；注册信息可自动同步，课程搜索结果在对应页面打开时同步。</p></div></li></ol></section>
<section class="card"><div class="card-head"><div><h2 class="sync-title">最近同步 <span id="period-count" class="counter">0 个记录</span></h2><span class="subtle">这里显示服务器保存的最新快照。</span></div></div><div id="scopes">连接后显示同步记录</div></section></div>
<aside class="card"><p class="aside-title">关于这条连接</p><div class="info-row"><strong>密码留在浏览器</strong><p>无需向服务器提供 Workday 密码或 Cookie。注册记录不包含你的姓名和学号。</p></div><div class="info-row"><strong>授权范围</strong><p>仅允许写入你自己的 {{SERVER_NAME}} 凭证；访问令牌用完即丢弃，不会保存。</p></div><div class="info-row"><strong>连接到 MCP 客户端</strong><p>在支持远程 MCP 的客户端中添加：</p><code class="endpoint">{{PLATFORM_ORIGIN}}/mcp/{{SERVER_NAME}}</code></div><details><summary>连接管理</summary><p>断开需要重新向 MCPHub 授权，随后撤销所有读写凭证，并删除当前快照。历史备份按服务器保留策略处理。</p><button id="disconnect" class="danger">断开并删除我的数据</button></details></aside></main>
<footer><span>此项目为独立项目，与 UBC 或 Workday 无隶属关系。</span><span>快照查询 · 不会自动选课</span></footer></div>
<script src="/ubc/app.js" defer></script></html>`;
export const script=String.raw`const $=id=>document.getElementById(id);let busy=false,connected=false,csrf='';
const extensionState=/^#extension-auth=([a-f0-9]{64})$/.exec(typeof location==='undefined'?'':location.hash)?.[1];
const query=new URLSearchParams(typeof location==='undefined'?'':location.search);
const labels={'extension-authorize':'正在连接扩展…',pair:'正在生成配对码…',refresh:'正在检查连接…',forget:'正在清除…',disconnect:'正在跳转到 MCPHub…'};
const notices={disconnected:['已断开连接，并删除了服务器上的快照与凭证。','success'],'disconnected-warning':['连接已撤销，但未能删除 MCPHub 中保存的凭证。请在 MCPHub 的凭证页面手动移除。','error']};
function feedback(text,state='info'){$('status').textContent=text;$('status').dataset.state=state;}
function controls(){document.querySelectorAll('button').forEach(b=>b.disabled=busy||(!connected&&['pair','disconnect','forget'].includes(b.id))||(b.id==='copy'&&!$('code').value));document.body.setAttribute('aria-busy',String(busy));document.body.dataset.connected=String(connected);$('account-state').textContent=connected?'已连接':'未连接';$('forget').hidden=!connected;$('connect').classList.toggle('secondary',connected);if(!busy)$('connect').textContent=connected?'重新连接 MCPHub':'Connect with MCPHub';}
async function api(action,post){const r=await fetch('/ubc/'+action,{method:post?'POST':'GET',credentials:'same-origin',redirect:'error',signal:AbortSignal.timeout(15000),headers:post?{'Content-Type':'application/json','X-CSRF-Token':csrf}:{},...(post?{body:JSON.stringify(post===true?{}:post)}:{})});let x;try{x=await r.json();}catch{throw new Error('服务返回异常，请重试。');}if(!r.ok)throw new Error(r.status===401||r.status===403?'登录已过期，请重新连接 MCPHub。':x.message||'请求失败，请重试。');return x;}
async function status(){const x=await api('api/status');connected=x.authenticated===true;csrf=x.csrf||'';$('extension-account').textContent=x.username||'';$('period-count').textContent=(x.scopes||[]).length+' 个记录';
 if(connected)$('account-line').textContent='当前账号：'+x.username;
 feedback(connected?'MCPHub 账号已连接。扩展的连接和同步状态可在扩展中查看。':'尚未连接。点击「Connect with MCPHub」开始。',connected?'success':'info');
 $('scopes').textContent=(x.scopes||[]).length?x.scopes.map(s=>s.campus+' · '+s.period+' · '+s.kind+' · '+s.sections+' 班次 · '+s.capturedAt).join('\n'):'尚无同步数据';}
async function run(action,work){if(busy)return;busy=true;controls();const b=$(action),original=b.textContent;b.textContent=labels[action];b.setAttribute('aria-busy','true');feedback(labels[action],'loading');try{await work();}catch(e){feedback(['TimeoutError','AbortError'].includes(e.name)?'连接超时，请检查网络后重试。':e.message||'请求失败，请重试。','error');}finally{b.textContent=original;b.removeAttribute('aria-busy');busy=false;controls();}}
let expiryTimer;
function startExpiry(expires){if(expiryTimer)clearInterval(expiryTimer);const update=()=>{const seconds=Math.max(0,Math.ceil((expires-Date.now())/1000));$('expires').textContent=seconds?'剩余 '+Math.floor(seconds/60)+':'+String(seconds%60).padStart(2,'0'):'已过期，请重新生成';if(!seconds){$('code').value='';$('copy').disabled=true;if(expiryTimer)clearInterval(expiryTimer);}};if(!Number.isFinite(expires)){$('expires').textContent='5 分钟内有效';return;}update();if(typeof setInterval==='function')expiryTimer=setInterval(update,1000);}
async function showPairing(){const p=await api('api/pair',true);$('copy').textContent='复制';$('code').value=p.code;$('pairing').hidden=false;$('manual').open=true;startExpiry(p.expires);feedback('配对码已生成，5 分钟内有效。复制到扩展完成配对。','success');}
$('connect').onclick=()=>{if(busy)return;location.assign('/ubc/oauth/start'+(extensionState?'?ext='+extensionState:''));};
$('refresh').onclick=()=>run('refresh',status);
$('pair').onclick=()=>run('pair',showPairing);
$('forget').onclick=()=>run('forget',async()=>{await api('api/forget',true);$('pairing').hidden=true;$('code').value='';await status();});
$('disconnect').onclick=()=>{if(busy||!confirm('断开 UBC 并删除服务器保存的当前快照？需要先向 MCPHub 重新授权，扩展凭证也将失效。'))return;return run('disconnect',async()=>{const x=await api('oauth/start',{intent:'disconnect'});if(!/^https?:\/\//.test(x.authorizeUrl||''))throw new Error('请求失败，请重试。');location.assign(x.authorizeUrl);});};
$('copy').onclick=async()=>{if(busy||!$('code').value)return;try{await navigator.clipboard.writeText($('code').value);$('copy').textContent='已复制';feedback('配对码已复制。打开扩展，粘贴后点击 Pair extension。','success');}catch{$('code').focus();$('code').select();feedback('请按 Ctrl+C 或 ⌘C 复制选中的配对码。');}};
if(extensionState){
  $('extension-login').hidden=false;document.querySelector('main.layout').style.display='none';
  document.querySelector('h1').textContent='连接你的 UBC 扩展';
  const output=$('ubc-extension-authorization');
  $('extension-authorize').onclick=()=>{if(!connected){location.assign('/ubc/oauth/start?ext='+extensionState);return;}return run('extension-authorize',async()=>{const p=await api('api/pair',true);
    output.textContent=JSON.stringify({state:extensionState,code:p.code});
    $('extension-result').textContent='正在等待扩展完成连接…';feedback('正在等待扩展完成连接…','loading');});};
  new MutationObserver(()=>{if(output.dataset.result==='connected'){
    $('extension-authorize').disabled=true;$('extension-result').textContent='已连接。可以关闭此页面，回到扩展同步课程。';feedback('扩展已连接。','success');
  }else if(output.dataset.result==='error')feedback(output.dataset.message||'连接失败，请从扩展重新开始。','error');}).observe(output,{attributes:true});
}
void run('refresh',async()=>{await status();const notice=notices[query.get('notice')||''];if(notice)feedback(notice[0],notice[1]);else if(connected&&query.get('connected')==='1'&&!extensionState)await showPairing();});`;
