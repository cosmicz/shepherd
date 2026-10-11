// Companion page: Start/Pause capture, cloud
// consent grant with the scope statement, the current explanation with Read
// aloud, and a link to /trace. Served by the runtime on its own loopback origin;
// the script imports the compiled browser-safe runtime from /dist.

// The durable scope statement. Shown verbatim
// when the person grants cloud consent.
export const scopeStatement = 'Shepherd may send up to 2 KB of on-screen text with numbers, emails, addresses and web addresses removed to a cloud model when it is unsure. Nothing else leaves this computer.';

export const companionPage = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>Shepherd</title>
<style>
  :root { color-scheme: light; }
  body { margin: 0; font: 18px/1.5 -apple-system, "Helvetica Neue", Arial, sans-serif; color: #111; background: #f7f7f5; }
  main { max-width: 760px; margin: 0 auto; padding: 24px 20px 48px; }
  h1 { font-size: 28px; margin: 0 0 4px; } .lede { color: #444; margin: 0 0 20px; }
  .controls { display: flex; flex-wrap: wrap; gap: 12px; margin-bottom: 20px; }
  button { font: inherit; padding: 10px 18px; border-radius: 8px; border: 2px solid #1d3b6a; background: #fff; color: #1d3b6a; cursor: pointer; }
  button.primary { background: #1d3b6a; color: #fff; }
  button:disabled { opacity: .5; cursor: not-allowed; }
  button:focus-visible, a:focus-visible { outline: 3px solid #f2a900; outline-offset: 2px; }
  section { background: #fff; border: 1px solid #d6d6d0; border-radius: 10px; padding: 18px 20px; margin-bottom: 16px; }
  .state { font-size: 22px; font-weight: 700; margin: 0 0 6px; }
  .concern { color: #a3121c; } .no_signal { color: #1f5e2e; } .inconclusive { color: #7a4b00; } .unavailable, .idle { color: #444; }
  .scope { background: #eef3fa; border-left: 4px solid #1d3b6a; padding: 10px 14px; }
  .muted { color: #555; font-size: 16px; }
</style></head>
<body><main>
  <h1>Shepherd</h1>
  <p class="lede">Watches the window you choose and tells you, in plain words, when something is trying to rush you.</p>
  <div class="controls">
    <button id="start" class="primary" type="button">Start watching a window</button>
    <button id="pause" type="button" disabled>Pause</button>
    <button id="read" type="button" disabled>Read aloud</button>
  </div>
  <section aria-live="polite" aria-atomic="true">
    <p id="state" class="state idle">Paused. Nothing is being watched.</p>
    <p id="message">Choose Start, then pick the window or tab to watch.</p>
    <p id="reasons" class="muted"></p>
  </section>
  <section>
    <h2 style="font-size:20px;margin:0 0 8px">Ask a cloud model when Shepherd is unsure</h2>
    <p class="scope" id="scope"></p>
    <div class="controls" style="margin:0">
      <button id="grant" type="button" disabled>Allow for this session</button>
      <button id="revoke" type="button" disabled>Stop allowing</button>
    </div>
    <p id="consent" class="muted">Not allowed. Shepherd only uses this computer.</p>
  </section>
  <p class="muted"><a href="/trace" target="_blank" rel="noopener">Open the routing trace</a> (for judges: what ran, what it cost, what left the machine).</p>
</main><script type="module" src="/companion.js"></script></body></html>`;

export const companionScript = `import { Session, HttpAnalyzer, HttpFamilyAlert, LocalHistory, demoPersona, speechKind, speechText, patternOf, patternLabels } from '/dist/index.js';
const SCOPE = ${JSON.stringify(scopeStatement)};
const $ = (id) => document.getElementById(id);
const origin = location.origin;
const sessionId = crypto.randomUUID();
let grant = null;
let current = null;
let stream = null;

$('scope').textContent = SCOPE;
const labels = { concern: 'Pause and check', no_signal: 'No warning signs found', inconclusive: 'Not sure', unavailable: 'Could not check this screen' };
const reasonText = { support_pressure: 'a fake support warning', payment_pressure: 'pressure to pay in gift cards or crypto', credential_pressure: 'a request for a password or code',
  investment_pressure: 'investment pressure', impersonation: 'someone pretending to be a company or person', remote_access: 'a request for remote access',
  family_emergency: 'a family emergency request', prize_claim: 'a prize claim', ai_instruction: 'text that tries to instruct an AI' };

async function token() { return (await (await fetch('/api/session')).json()).token; }
async function registerGrant(source) {
  const now = new Date();
  const value = { id: crypto.randomUUID(), session_id: sessionId, generation: session.state.generation, source, scope: 'redacted-text', max_bytes: 2048, version: 1,
    granted_at: now.toISOString(), expires_at: new Date(now.getTime() + 3600_000).toISOString() };
  const response = await fetch('/api/consent', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Shepherd-Token': await token() }, body: JSON.stringify(value) });
  if (!response.ok) throw Error('Grant not registered');
  return value;
}
async function revokeGrant() {
  if (!grant) return;
  const id = grant.id;
  grant = null;
  renderConsent();
  await fetch('/api/consent/' + encodeURIComponent(id), { method: 'DELETE', headers: { 'X-Shepherd-Token': await token() } }).catch(() => {});
}
function renderConsent() {
  $('consent').textContent = grant ? 'Allowed for this session until ' + new Date(grant.expires_at).toLocaleTimeString() + '.' : 'Not allowed. Shepherd only uses this computer.';
  $('grant').disabled = !!grant || !stream;
  $('revoke').disabled = !grant;
}
function spokenText(a) {
  const kind = speechKind(a);
  if (!kind) return a.message;
  try { return speechText(kind, patternOf(a), demoPersona); } catch { return speechText('suspicious', patternOf(a), demoPersona); }
}
function speak(text) {
  if (!('speechSynthesis' in window)) return;
  speechSynthesis.cancel();
  speechSynthesis.speak(new SpeechSynthesisUtterance(text));
}

const capture = (video, source) => ({
  source,
  frame: async () => {
    const width = Math.min(video.videoWidth, 2560);
    const height = Math.round(video.videoHeight * (width / video.videoWidth));
    const canvas = Object.assign(document.createElement('canvas'), { width, height });
    canvas.getContext('2d').drawImage(video, 0, 0, width, height);
    const frame = { frame_id: crypto.randomUUID(), source, image: canvas.toDataURL('image/png'), session_id: sessionId, generation: session.state.generation };
    // A grant binds one session generation and source; a stale one is never attached.
    if (grant && grant.generation === frame.generation && grant.source === source) frame.consent = grant;
    return frame;
  },
  stop: () => { for (const track of video.srcObject?.getTracks() ?? []) track.stop(); video.srcObject = null; stream = null; },
  onEnded: (callback) => { for (const track of video.srcObject.getTracks()) track.addEventListener('ended', callback); },
});

const analyzer = new HttpAnalyzer(origin);
const family = new HttpFamilyAlert(origin);
let storage = null;
try { storage = window.localStorage; } catch {}
const history = storage ? new LocalHistory(storage) : null;
const session = new Session({
  analyze: (frame, signal) => analyzer.analyze(frame, signal),
  append: (event) => history?.append(event),
  speak,
  cancelSpeech: () => { if ('speechSynthesis' in window) speechSynthesis.cancel(); },
  onChange: (state) => render(state),
  persona: demoPersona,
  notifyFamily: (pattern) => family.notify(pattern),
  interval_ms: 5000,
});
session.setPreferences(demoPersona.preferences);

function render(state) {
  current = state.assessment;
  const watching = state.phase === 'active' || state.phase === 'requesting';
  $('start').disabled = watching;
  $('pause').disabled = !watching;
  $('read').disabled = !current;
  const el = $('state');
  if (!current) {
    el.className = 'state idle';
    el.textContent = state.phase === 'requesting' ? 'Waiting for you to pick a window…' : watching ? 'Watching. Checking the first view…' : 'Paused. Nothing is being watched.';
    $('message').textContent = state.error ?? (watching ? '' : 'Choose Start, then pick the window or tab to watch.');
    $('reasons').textContent = '';
  } else {
    el.className = 'state ' + current.status;
    el.textContent = labels[current.status];
    $('message').textContent = spokenText(current);
    $('reasons').textContent = current.reasons.length ? 'Noticed: ' + current.reasons.map((r) => reasonText[r] ?? r).join(', ') + '.' : '';
  }
  renderConsent();
}

$('start').addEventListener('click', async () => {
  await revokeGrant();
  await session.start(async () => {
    const media = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
    const video = Object.assign(document.createElement('video'), { srcObject: media, muted: true });
    await video.play();
    stream = media;
    const surface = media.getVideoTracks()[0].getSettings().displaySurface;
    return capture(video, surface === 'browser' ? 'tab' : 'window');
  });
  render(session.state);
});
$('pause').addEventListener('click', async () => { session.pause(); await revokeGrant(); render(session.state); });
$('read').addEventListener('click', () => { if (current) speak(spokenText(current)); });
$('grant').addEventListener('click', async () => {
  try { grant = await registerGrant(session.state.phase === 'active' ? (stream?.getVideoTracks()[0].getSettings().displaySurface === 'browser' ? 'tab' : 'window') : 'window'); }
  catch { grant = null; $('consent').textContent = 'Could not record the permission. Shepherd only uses this computer.'; }
  renderConsent();
});
$('revoke').addEventListener('click', () => revokeGrant());
render(session.state);
`;
