const unavailableHeading = "This shared session is unavailable.";
const unavailableDescription =
  "This link was revoked, expired, or does not exist. Ask the owner for a new link.";

const faviconLinks = `<link rel="icon" type="image/png" sizes="32x32" href="/favicon-32x32.png" media="(prefers-color-scheme: light)" />
<link rel="icon" type="image/png" sizes="32x32" href="/favicon-32x32-dark.png" media="(prefers-color-scheme: dark)" />`;

function escapeAttribute(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function openGraphMeta(imageUrl: string): string {
  return `<meta property="og:title" content="Shared session" />
<meta property="og:type" content="website" />
<meta property="og:image" content="${escapeAttribute(imageUrl)}" />
<meta property="og:image:type" content="image/png" />
<meta property="og:image:width" content="1200" />
<meta property="og:image:height" content="630" />
<meta name="twitter:card" content="summary_large_image" />`;
}

function minimalPage(
  title: string,
  heading: string,
  description: string | null,
): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>${title}</title>
${faviconLinks}
<style>
*{box-sizing:border-box}html{color-scheme:dark}body{min-height:100vh;margin:0;display:grid;align-items:start;padding:max(24px,env(safe-area-inset-top)) max(20px,env(safe-area-inset-right)) max(24px,env(safe-area-inset-bottom)) max(20px,env(safe-area-inset-left));background:#09090b;color:#e4e4e7;font:14px/1.6 Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;-webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility}main{width:min(720px,100%);margin:20vh auto 0}h1{margin:0;font-size:18px;line-height:1.35;font-weight:550;letter-spacing:-.015em}p{max-width:520px;margin:8px 0 0;color:#a1a1aa}
</style>
</head>
<body><main><h1>${heading}</h1>${description ? `<p>${description}</p>` : ""}</main></body>
</html>`;
}

export const LANDING_PAGE_HTML = minimalPage(
  "AI chat session sharing",
  "AI chat session sharing",
  "Private, temporary links for sharing AI conversations.",
);

export function renderUnavailablePage(): string {
  return minimalPage(
    "Shared session unavailable",
    unavailableHeading,
    unavailableDescription,
  );
}

export function renderGuestPage(
  authenticated: boolean,
  reviewEnabled: boolean,
  openGraphImageUrl: string,
): string {
  return String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>Shared session</title>
${faviconLinks}
${openGraphMeta(openGraphImageUrl)}
${reviewEnabled ? '<link rel="stylesheet" href="./pinpoint-styles.css" />' : ""}
<style>
:root{color-scheme:light;--canvas:#fafafa;--surface:#fff;--raised:#f4f4f5;--line:#e4e4e7;--ink:#27272a;--muted:#71717a;--subtle:#a1a1aa;--accent:#4f46e5;--danger:#dc2626;--success:#16a34a;--shadow:0 24px 70px rgba(24,24,27,.08)}
@media(prefers-color-scheme:dark){:root{color-scheme:dark;--canvas:#09090b;--surface:#111113;--raised:#18181b;--line:#27272a;--ink:#e4e4e7;--muted:#a1a1aa;--subtle:#71717a;--accent:#a5b4fc;--danger:#fb7185;--success:#4ade80;--shadow:0 24px 80px rgba(0,0,0,.38)}}
*{box-sizing:border-box}html{min-height:100%;scroll-behavior:auto}body{min-height:100vh;margin:0;background:var(--canvas);color:var(--ink);font:14px/1.65 Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;-webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility;font-feature-settings:"kern","liga","cv05","cv10"}button,input,textarea{font:inherit}.hidden{display:none!important}.boot{position:fixed;inset:0;z-index:80;display:grid;place-items:center;background:var(--canvas);color:var(--muted);font-size:13px}body:not(.booting)>.boot{display:none}
.login{position:fixed;inset:0;z-index:20;display:block;padding:max(24px,env(safe-area-inset-top)) max(20px,env(safe-area-inset-right)) max(24px,env(safe-area-inset-bottom)) max(20px,env(safe-area-inset-left));background:var(--canvas)}.login-inner{width:min(720px,100%);margin:20vh auto 0}.login h1{margin:0;font-size:18px;line-height:1.35;font-weight:550;letter-spacing:-.015em}.login p{max-width:520px;margin:8px 0 26px;color:var(--muted);line-height:1.6}.field,.primary,.login-error{width:min(360px,100%)}.field{display:block}.field span{display:block;margin-bottom:8px;color:var(--muted);font-size:13px}.field input{width:100%;height:44px;padding:0 13px;border:1px solid var(--line);border-radius:10px;background:var(--surface);color:var(--ink);outline:none;box-shadow:0 1px 2px rgba(0,0,0,.03);font-size:16px;letter-spacing:.02em}.field input:focus{border-color:var(--muted);box-shadow:0 0 0 3px color-mix(in srgb,var(--muted) 15%,transparent)}.primary{display:flex;align-items:center;justify-content:center;min-height:42px;margin-top:12px;border:0;border-radius:10px;background:var(--ink);color:var(--canvas);font-weight:550;cursor:pointer}.primary:hover{opacity:.9}.primary:active{scale:.98}.primary:disabled{cursor:wait;opacity:.5}.login-error{min-height:22px;margin-top:10px;color:var(--danger);font-size:13px}
.site-header{position:sticky;top:0;z-index:5;display:flex;align-items:center;justify-content:space-between;gap:20px;width:100%;height:48px;padding:0 20px;border-bottom:1px solid var(--line);background:color-mix(in srgb,var(--canvas) 88%,transparent);backdrop-filter:blur(14px)}.session-title{display:flex;min-width:0;align-items:center;gap:8px}.session-title strong{display:block;overflow:hidden;font-size:14px;font-weight:540;text-overflow:ellipsis;white-space:nowrap}.active-dot{width:7px;height:7px;flex-shrink:0;border-radius:50%;background:var(--success);box-shadow:0 0 0 4px color-mix(in srgb,var(--success) 12%,transparent)}.expiry{color:var(--muted);font-size:13px;font-variant-numeric:tabular-nums;white-space:nowrap}
.layout{display:grid;grid-template-columns:minmax(0,1120px);justify-content:center;gap:64px;width:min(1180px,100%);margin:0 auto;padding:30px 28px 100px}.timeline{min-width:0}.message{position:relative;padding:30px 0;border-top:1px solid var(--line)}.message:first-child{border-top:0}.message .role{margin-bottom:10px;color:var(--subtle);font-size:11px;font-weight:550;letter-spacing:.08em;text-transform:uppercase}.message.user .body{color:var(--muted)}.message .body{overflow-wrap:anywhere}.message.assistant .body>:not(bb-table-scroll){max-width:720px}.message .body>:first-child{margin-top:0}.message .body>:last-child{margin-bottom:0}.message .body p,.message .body ul,.message .body ol,.message .body pre,.message .body blockquote{margin:0 0 18px}.message .body p{line-height:1.72}.message .body h1,.message .body h2,.message .body h3,.message .body h4{margin:34px 0 12px;line-height:1.3;font-weight:540;letter-spacing:-.015em}.message .body h1{font-size:22px}.message .body h2{font-size:19px}.message .body h3{font-size:16px}.message .body ul,.message .body ol{padding-left:1.4em}.message .body pre{overflow:auto;padding:16px;border:1px solid var(--line);border-radius:10px;background:transparent;white-space:pre}.message .body code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.9em}.message .body :not(pre)>code{padding:2px 5px;border-radius:4px;background:var(--raised)}.message .body a{color:inherit;text-decoration-color:var(--subtle);text-decoration-thickness:1px;text-underline-offset:3px}.message .body blockquote{padding-left:16px;border-left:2px solid var(--line);color:var(--muted)}bb-table-scroll{display:block;width:100%;margin:4px 0 22px;overflow-x:auto;border:1px solid var(--line);border-radius:10px;background:var(--surface);scrollbar-gutter:stable}bb-table-scroll:focus-visible{outline:2px solid var(--accent);outline-offset:2px}.message .body table{width:100%;min-width:760px;border-collapse:separate;border-spacing:0;font-size:13px;line-height:1.55;overflow-wrap:break-word;word-break:normal}.message .body th,.message .body td{min-width:144px;max-width:480px;padding:11px 13px;border-right:1px solid var(--line);border-bottom:1px solid var(--line);text-align:left;vertical-align:top}.message .body th:first-child,.message .body td:first-child{min-width:112px}.message .body th:last-child,.message .body td:last-child{border-right:0}.message .body tbody tr:last-child td{border-bottom:0}.message .body th{background:var(--raised);font-weight:600;line-height:1.4}.message .body tbody tr:hover td{background:color-mix(in srgb,var(--raised) 45%,transparent)}.empty{padding:18vh 0;text-align:center;color:var(--muted)}
.message{margin:0 0 16px;padding:20px;border:1px solid var(--line);border-radius:12px;background:var(--surface)}.message:first-child{border-top:1px solid var(--line)}.message.user{width:fit-content;max-width:88%;margin-left:auto;background:var(--raised)}.message.user .body{color:var(--ink)}.message .role{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}.message .body h1,.message .body h2,.message .body h3,.message .body h4{margin-top:26px}
.message.assistant{width:100%;max-width:none;margin-right:auto;padding:20px 0 28px;border:0;border-radius:0;background:transparent}.message.user{max-width:min(82%,720px)}
.new-activity{position:fixed;left:50%;bottom:24px;z-index:10;translate:-50% 0;border:1px solid var(--line);border-radius:999px;background:var(--surface);color:var(--ink);box-shadow:var(--shadow);padding:9px 14px;font-size:12px;font-weight:520;cursor:pointer}.new-activity:hover{background:var(--raised)}
.pinpoint-stage{position:fixed;inset:0;z-index:10;background:var(--canvas)}.pinpoint-root{width:100%;height:100%}
.unavailable{position:fixed;inset:0;z-index:30;display:block;padding:max(24px,env(safe-area-inset-top)) max(20px,env(safe-area-inset-right)) max(24px,env(safe-area-inset-bottom)) max(20px,env(safe-area-inset-left));background:var(--canvas)}.unavailable-inner{width:min(720px,100%);margin:20vh auto 0}.unavailable h1{margin:0;font-size:18px;line-height:1.35;font-weight:550;letter-spacing:-.015em}.unavailable p{max-width:520px;margin:8px 0 0;color:var(--muted)}
.proxy-error{position:fixed;top:12px;left:50%;z-index:60;width:min(680px,calc(100% - 24px));translate:-50% 0;padding:11px 14px;border:1px solid color-mix(in srgb,var(--danger) 45%,var(--line));border-radius:10px;background:var(--surface);color:var(--danger);box-shadow:var(--shadow);font-size:13px;font-weight:500}
@media(max-width:850px){.site-header{height:44px;padding:0 14px}.layout{display:block;padding:18px 14px 72px}.message{padding:18px}.message.assistant{padding:16px 0 24px}}
@media(prefers-reduced-motion:reduce){*{scroll-behavior:auto!important}.primary:active{scale:1}}
</style>
</head>
<body class="booting">
<div id="boot" class="boot" role="status"><span id="boot-status">Opening shared session…</span></div>
<div id="login" class="login${authenticated ? " hidden" : ""}">
  <form id="login-form" class="login-inner">
    <h1>Private session</h1><p>Enter the access code that came with this link.</p>
    <label class="field" for="access-code"><span>Access code</span><input id="access-code" name="accessCode" type="text" autocomplete="one-time-code" autocapitalize="none" spellcheck="false" required autofocus placeholder="quiet-river-4821" /></label>
    <button class="primary" type="submit">Continue</button><div id="login-error" class="login-error" role="alert"></div>
  </form>
</div>
<div id="unavailable" class="unavailable hidden"><div class="unavailable-inner"><h1>${unavailableHeading}</h1><p>${unavailableDescription}</p></div></div>
<div id="proxy-error" class="proxy-error hidden" role="alert"></div>
<div id="shared-session" class="shell${authenticated && !reviewEnabled ? "" : " hidden"}">
  <header class="site-header"><div class="session-title"><span id="active-dot" class="active-dot hidden" aria-label="Agent active"></span><strong id="title">Shared session</strong></div><span id="expiry" class="expiry">Connecting…</span></header>
  <main id="layout" class="layout"><section id="timeline" class="timeline"><div class="empty">Connecting…</div></section></main>
</div>
<div id="pinpoint-stage" class="pinpoint-stage${authenticated && reviewEnabled ? "" : " hidden"}"><div id="pinpoint-root" class="pinpoint-root"></div></div>
<button id="new-activity" class="new-activity hidden" type="button">Jump to latest</button>
${reviewEnabled ? '<script src="./pinpoint-controller.js"></script>' : ""}
<script>
const bootStatus=document.getElementById('boot-status'),login=document.getElementById('login'),loginForm=document.getElementById('login-form'),accessCode=document.getElementById('access-code'),loginError=document.getElementById('login-error'),unavailable=document.getElementById('unavailable'),proxyError=document.getElementById('proxy-error'),sharedSession=document.getElementById('shared-session'),timeline=document.getElementById('timeline'),title=document.getElementById('title'),expiry=document.getElementById('expiry'),activeDot=document.getElementById('active-dot'),pinpointStage=document.getElementById('pinpoint-stage'),pinpointRoot=document.getElementById('pinpoint-root'),newActivity=document.getElementById('new-activity');
let csrf='',lastMaxSeq=-1,hasLoaded=false,stopped=false,knownExpiresAt=0;
const reducedMotion=window.matchMedia('(prefers-reduced-motion: reduce)');
function finishBoot(){document.body.classList.remove('booting')}
function showUnavailable(){stopped=true;login.classList.add('hidden');sharedSession.classList.add('hidden');pinpointStage.classList.add('hidden');newActivity.classList.add('hidden');unavailable.classList.remove('hidden');document.title='Shared session unavailable';finishBoot()}
function atBottom(){return window.innerHeight+window.scrollY>=document.documentElement.scrollHeight-120}
function scrollToLatest(behavior=reducedMotion.matches?'auto':'smooth'){newActivity.classList.add('hidden');requestAnimationFrame(()=>window.scrollTo({top:document.documentElement.scrollHeight,behavior}))}
window.addEventListener('scroll',()=>{if(atBottom())newActivity.classList.add('hidden')},{passive:true});
newActivity.addEventListener('click',()=>scrollToLatest());
function firstVisibleMessage(){for(const card of timeline.querySelectorAll('.message')){const rect=card.getBoundingClientRect();if(rect.bottom>0)return{id:card.id,top:rect.top}}return null}
function renderMessages(messages){const initial=!hasLoaded,follow=initial||atBottom(),anchor=follow?null:firstVisibleMessage();timeline.replaceChildren();if(!messages.length){const empty=document.createElement('div');empty.className='empty';empty.textContent='This session has no messages yet.';timeline.append(empty)}else{for(const message of messages){const card=document.createElement('article');card.className='message '+message.role;card.id='message-'+message.id;const role=document.createElement('div');role.className='role';role.textContent=message.role;const body=document.createElement('div');body.className='body';body.innerHTML=message.html;card.append(role,body);timeline.append(card)}}hasLoaded=true;requestAnimationFrame(()=>{if(follow){window.scrollTo({top:document.documentElement.scrollHeight,behavior:initial||reducedMotion.matches?'auto':'smooth'});newActivity.classList.add('hidden');return}if(anchor){const restored=document.getElementById(anchor.id);if(restored)window.scrollBy({top:restored.getBoundingClientRect().top-anchor.top,behavior:'auto'})}newActivity.classList.remove('hidden')})}
async function loadState(){
  const response=await fetch('./api/state',{cache:'no-store'});
  if(response.status===404||response.status===410){showUnavailable();return}
  if(response.status===401){
    sharedSession.classList.add('hidden');pinpointStage.classList.add('hidden');login.classList.remove('hidden');finishBoot();return;
  }
  if(!response.ok)throw new Error('Unable to load the shared session.');
  const data=await response.json();
  knownExpiresAt=Number(data.share.expiresAt)||0;
  login.classList.add('hidden');
  csrf=data.csrfToken;
  proxyError.textContent=data.proxyError||'';
  proxyError.classList.toggle('hidden',!data.proxyError);
  const isReview=data.share.mode==='review'&&data.share.previewUrl;
  if(isReview){
    sharedSession.classList.add('hidden');newActivity.classList.add('hidden');pinpointStage.classList.remove('hidden');
    const target=String(data.navigation&&data.navigation.url||data.share.previewUrl);
    const proxyBase='./sandbox/'+encodeURIComponent(String(data.proxyToken))+'/proxy';
    if(!window.PinpointPublicReview)throw new Error('Pinpoint review controller did not load.');
    window.PinpointPublicReview.mount({
      isolationVersion:1,
      permissions:{capture:true,reply:true,delete:true},
      root:pinpointRoot,threadId:data.share.threadId,target,csrf,proxyBase,
      stateUrl:'./api/state',feedbackUrl:'./api/feedback',navigationUrl:'./api/navigation',
      screenshotUrl:'./api/pinpoint-screenshot',screenshotUploadUrl:'./api/preview-screenshot-upload'
    });
    if(window.PinpointPublicReview.updateState)window.PinpointPublicReview.updateState(data);
    finishBoot();return;
  }
  pinpointStage.classList.add('hidden');sharedSession.classList.remove('hidden');
  title.textContent=data.share.title;expiry.textContent=data.expiresIn;
  activeDot.classList.toggle('hidden',data.thread.status!=='active');
  if(data.maxSeq!==lastMaxSeq){lastMaxSeq=data.maxSeq;renderMessages(data.messages)}
  finishBoot();
}
async function poll(){try{await loadState()}catch{if(knownExpiresAt>0&&Date.now()>=knownExpiresAt)showUnavailable();else if(document.body.classList.contains('booting'))bootStatus.textContent='Reconnecting…';else expiry.textContent='Reconnecting…'}finally{if(!stopped)setTimeout(poll,2000)}}
loginForm.addEventListener('submit',async(event)=>{event.preventDefault();loginError.textContent='';const response=await fetch('./api/unlock',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({accessCode:accessCode.value.trim()})});if(!response.ok){const data=await response.json().catch(()=>({error:'Could not unlock this session.'}));loginError.textContent=data.error;return}accessCode.value='';hasLoaded=false;await loadState()});
poll();
</script>
</body>
</html>`;
}
