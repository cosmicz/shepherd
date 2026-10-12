// Companion page (contract, demo-minimum scope): Start/Pause capture, cloud
// consent grant with the scope statement, the current explanation with Read
// aloud, and a link to /trace. Served by the runtime on its own loopback origin;
// the script imports the compiled browser-safe runtime from /dist.

// The durable scope statement (contract contract v2, Consent). Shown verbatim
// when the person grants cloud consent.
export const scopeStatement = 'Shepherd may send up to 2 KB of on-screen text with numbers, emails, addresses and web addresses removed to a cloud model when it is unsure. Nothing else leaves this computer.';
// With model-quote excerpts enabled (SHEPHERD_QUOTE_EXCERPTS=1) the statement says so (d3l).
export const scopeStatementWithQuotes = 'Shepherd may send up to 2 KB of on-screen text, and a short phrase the local model quotes from the screen, with numbers, emails, addresses and web addresses removed to a cloud model when it is unsure. Nothing else leaves this computer.';

export const companionPage = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>Shepherd</title>
<style>
  /* Companion design tokens (base contract; trq visual pass). No decorative motion. */
  :root {
    color-scheme: light;
    --page: #e9eff7; --paper: #fdfdfb; --ink: #14233d; --ink-soft: #46546b; --line: #cfd8e5;
    --control: #1d3b6a; --control-ink: #ffffff; --focus: #f2a900;
    --concern: #9a4a00; --concern-wash: #fff3e2; --clear: #1f5e2e; --clear-wash: #ecf6ee; --unsure: #6b4e00; --unsure-wash: #fbf5e3;
    --radius: 14px; --target: 48px;
  }
  * { box-sizing: border-box; }
  body { margin: 0; font: 18px/1.55 -apple-system, "Helvetica Neue", Arial, sans-serif; color: var(--ink); background: var(--page); }
  main { max-width: 780px; margin: 0 auto; padding: 28px 20px 56px; }
  header { margin-bottom: 18px; }
  h1 { font-size: 30px; letter-spacing: -0.01em; margin: 0 0 4px; }
  h2 { font-size: 20px; margin: 0 0 10px; }
  .lede { color: var(--ink-soft); margin: 0; }
  .strip { display: flex; flex-wrap: wrap; align-items: center; gap: 10px 18px; margin: 0 0 18px; padding: 10px 16px;
    background: var(--paper); border: 1px solid var(--line); border-radius: 999px; font-size: 16px; color: var(--ink-soft); }
  .strip p { margin: 0; }
  .chip { display: inline-flex; align-items: center; gap: 8px; }
  .chip::before { content: ""; width: 10px; height: 10px; border-radius: 50%; background: var(--clear); }
  .controls { display: flex; flex-wrap: wrap; gap: 12px; margin-bottom: 20px; }
  button { font: inherit; font-weight: 600; min-height: var(--target); padding: 10px 22px; border-radius: 12px; border: 2px solid var(--control);
    background: var(--paper); color: var(--control); cursor: pointer; }
  button.primary { background: var(--control); color: var(--control-ink); }
  button:disabled { opacity: .45; cursor: not-allowed; }
  button:focus-visible, a:focus-visible { outline: 3px solid var(--focus); outline-offset: 3px; }
  section { background: var(--paper); border: 1px solid var(--line); border-radius: var(--radius); padding: 20px 22px; margin-bottom: 16px; }
  section.focal { padding: 28px 28px 24px; border-width: 2px; box-shadow: 0 1px 0 var(--line); }
  .state { font-size: 22px; font-weight: 700; margin: 0 0 8px; display: inline-block; padding: 4px 14px; border-radius: 999px; background: var(--page); }
  .concern { color: var(--concern); background: var(--concern-wash); }
  .no_signal { color: var(--clear); background: var(--clear-wash); }
  .inconclusive { color: var(--unsure); background: var(--unsure-wash); }
  .unavailable, .idle { color: var(--ink-soft); }
  #message { font-size: 30px; line-height: 1.3; font-weight: 600; margin: 6px 0 14px; }
  .focal .controls { margin: 16px 0 0; }
  .scope { background: #eef3fa; border-left: 4px solid var(--control); padding: 12px 16px; border-radius: 0 10px 10px 0; margin: 0 0 14px; }
  .muted { color: var(--ink-soft); font-size: 16px; }
  .secondary { display: grid; gap: 16px; }
  footer { margin-top: 8px; }
  a { color: var(--control); }
</style></head>
<body><main>
  <header>
    <h1>Shepherd</h1>
    <p class="lede">Watches the window you choose and tells you, in plain words, when something is trying to rush you.</p>
  </header>
  <div class="controls">
    <button id="start" class="primary" type="button">Start watching a window</button>
    <button id="pause" type="button" disabled>Pause</button>
  </div>
  <div class="strip" role="status">
    <span class="chip">On this Mac</span>
    <p id="tiers" aria-live="polite"></p>
  </div>
  <section class="focal" aria-live="polite" aria-atomic="true">
    <p id="state" class="state idle">Paused. Nothing is being watched.</p>
    <p id="message">Choose Start, then pick the window or tab to watch.</p>
    <p id="reasons" class="muted"></p>
    <div class="controls"><button id="read" class="primary" type="button" disabled>Read aloud</button></div>
  </section>
  <div class="secondary">
    <section>
      <h2>Ask a cloud model when Shepherd is unsure</h2>
      <p class="scope" id="scope"></p>
      <div class="controls" style="margin:0">
        <button id="grant" type="button" disabled>Allow for this session</button>
        <button id="revoke" type="button" disabled>Stop allowing</button>
      </div>
      <p id="consent" class="muted">Not allowed. Shepherd only uses this computer.</p>
    </section>
    <section>
      <h2>Family alerts</h2>
      <div class="controls" style="margin:0"><button id="family-test" type="button">Send a test message</button></div>
      <p id="family" class="muted" aria-live="polite">Alerts go only to the family contact set up on this computer.</p>
    </section>
    <section>
      <h2>Local observation journal</h2>
      <div class="controls" style="margin:0"><button id="journal" type="button" disabled>Turn on local recording</button><button id="journal-delete" type="button" disabled>Delete all retained records</button></div>
      <p id="journal-status" class="muted">Off. When available, this keeps full screenshots and OCR only on this Mac; it accumulates until you delete it.</p>
    </section>
  </div>
  <footer><p class="muted"><a href="/trace" target="_blank" rel="noopener">Open the routing trace</a> (for judges: what ran, what it cost, what left the machine).</p></footer>
</main><script type="module" src="/companion.js"></script></body></html>`;

export const companionScriptFor = (quotes: boolean) => `import { Session, HttpAnalyzer, HttpFamilyAlert, LocalHistory, demoPersona, speechKind, speechText, patternOf, patternLabels, mediumOf } from '/dist/index.js';
const SCOPE = ${JSON.stringify(quotes ? scopeStatementWithQuotes : scopeStatement)};
const $ = (id) => document.getElementById(id);
const origin = location.origin;
const sessionId = crypto.randomUUID();
let grant = null;
let current = null;
let stream = null;
let journal = { available: false, enabled: false };

$('scope').textContent = SCOPE;
const labels = { concern: 'Pause and check', no_signal: 'No warning signs found', inconclusive: 'Not sure', unavailable: 'Could not check this screen' };
const reasonText = { support_pressure: 'a fake support warning', payment_pressure: 'pressure to pay in gift cards or crypto', credential_pressure: 'a request for a password or code',
  investment_pressure: 'investment pressure', impersonation: 'someone pretending to be a company or person', remote_access: 'a request for remote access',
  family_emergency: 'a family emergency request', prize_claim: 'a prize claim', ai_instruction: 'text that tries to instruct an AI',
  other_concern: 'Other / unclassified concern' };

async function token() { return (await (await fetch('/api/session')).json()).token; }
// Grant lifetime: one hour (tests may shorten it via window.__shepherdGrantMs).
const grantMs = () => (typeof window.__shepherdGrantMs === 'number' ? window.__shepherdGrantMs : 3600_000);
let expired = false;
// d29: cloud permission is a session preference the person can set before Start.
// It becomes a real Grant (bound to source and generation) only when capture
// starts; Stop allowing or Pause revokes the grant and clears it, so nothing
// binds later.
let cloudPreferred = false;
// True while the live grant came from the preference: its line repeats the scope.
let boundFromPreference = false;
// Set when the person allows during capture, so the bind is not shown as deferred.
let userAllowedDuringCapture = false;
// Bumped by Stop allowing, Pause and Start: a registration that returns to a
// different epoch was overtaken and is revoked at once, never kept (the team race).
let consentEpoch = 0;
const captureSource = () => (stream?.getVideoTracks()[0].getSettings().displaySurface === 'browser' ? 'tab' : 'window');
async function bindPreferredGrant() {
  if (!cloudPreferred || grant || session.state.phase !== 'active' || !stream) return;
  const fromPreference = !userAllowedDuringCapture;
  userAllowedDuringCapture = false;
  const epoch = consentEpoch;
  let registered;
  try { expired = false; registered = await registerGrant(captureSource()); }
  catch { if (epoch === consentEpoch) { cloudPreferred = false; $('consent').textContent = 'Could not record the permission. Shepherd only uses this computer.'; } return; }
  if (epoch !== consentEpoch || !cloudPreferred || grant || session.state.phase !== 'active') {
    // Overtaken while registering: withdraw it so it can never be attached to a frame.
    await fetch('/api/consent/' + encodeURIComponent(registered.id), { method: 'DELETE', headers: { 'X-Shepherd-Token': await token() } }).catch(() => {});
    return;
  }
  grant = registered;
  boundFromPreference = fromPreference;
  renderConsent();
}
async function registerGrant(source) {
  const now = new Date();
  const value = { id: crypto.randomUUID(), session_id: sessionId, generation: session.state.generation, source, scope: 'redacted-text', max_bytes: 2048, version: 1,
    granted_at: now.toISOString(), expires_at: new Date(now.getTime() + grantMs()).toISOString() };
  const response = await fetch('/api/consent', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Shepherd-Token': await token() }, body: JSON.stringify(value) });
  if (!response.ok) throw Error('Grant not registered');
  return value;
}
async function revokeGrant() {
  if (!grant) return;
  const id = grant.id;
  grant = null;
  boundFromPreference = false;
  renderConsent();
  await fetch('/api/consent/' + encodeURIComponent(id), { method: 'DELETE', headers: { 'X-Shepherd-Token': await token() } }).catch(() => {});
}
function renderConsent() {
  $('consent').textContent = grant ? 'Allowed for this session until ' + new Date(grant.expires_at).toLocaleTimeString() + '.' + (boundFromPreference ? ' ' + SCOPE : '')
    : cloudPreferred ? 'Allowed once you start watching. When it starts: ' + SCOPE
      : expired ? 'Cloud permission expired. Shepherd only uses this computer until you extend it.' : 'Not allowed. Shepherd only uses this computer.';
  $('grant').textContent = expired && !grant ? 'Extend for this session' : 'Allow for this session';
  $('grant').disabled = !!grant || cloudPreferred;
  $('revoke').disabled = !grant && !cloudPreferred;
}
function renderJournal() {
  const button = $('journal');
  button.disabled = !journal.available;
  $('journal-delete').disabled = !journal.available;
  button.textContent = journal.enabled ? 'Turn off local recording' : 'Turn on local recording';
  $('journal-status').textContent = !journal.available ? 'Local journal is unavailable. No screenshots or OCR are being retained.'
    : journal.enabled ? 'Recording locally. Full screenshots and available OCR stay on this Mac and accumulate until you delete them.'
      : 'Off. Turning this on keeps full screenshots and available OCR only on this Mac; it accumulates until you delete it.';
}
async function refreshJournal() {
  try {
    const response = await fetch('/api/journal', { headers: { 'X-Shepherd-Token': await token() } });
    journal = response.ok ? await response.json() : { available: false, enabled: false };
  } catch { journal = { available: false, enabled: false }; }
  renderJournal();
}
async function toggleJournal() {
  if (!journal.available) return;
  const response = await fetch('/api/journal', { method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-Shepherd-Token': await token() }, body: JSON.stringify({ enabled: !journal.enabled }) });
  journal = response.ok ? await response.json() : { available: false, enabled: false };
  renderJournal();
}
async function deleteJournal() {
  if (!journal.available || !confirm('Delete all locally retained screenshots, OCR, and journal records?')) return;
  const response = await fetch('/api/journal', { method: 'DELETE', headers: { 'X-Shepherd-Token': await token() } });
  if (response.ok) await refreshJournal();
}
// Surface expiry instead of silently falling back to the no-consent rows.
setInterval(() => {
  // An expired grant also clears the preference: extending is the person's choice.
  if (grant && Date.now() >= Date.parse(grant.expires_at)) { grant = null; expired = true; cloudPreferred = false; renderConsent(); }
}, 500);
function spokenText(a) {
  const kind = speechKind(a);
  if (!kind) return a.message;
  try { return speechText(kind, patternOf(a), demoPersona, mediumOf(a)); } catch { return speechText('suspicious', patternOf(a), demoPersona, mediumOf(a)); }
}
const PREFERRED_VOICES = ['Ava', 'Zoe', 'Allison', 'Samantha', 'Evan', 'Nathan', 'Tom', 'Karen', 'Moira', 'Daniel'];
function pickVoice() {
  const voices = speechSynthesis.getVoices().filter((v) => v.localService && /^en/i.test(v.lang));
  const premium = voices.filter((v) => /premium|enhanced/i.test(v.name));
  for (const name of PREFERRED_VOICES) {
    const hit = premium.find((v) => v.name.startsWith(name)) || voices.find((v) => v.name.startsWith(name));
    if (hit) return hit;
  }
  return premium[0] || voices.find((v) => v.default) || voices[0];
}
if ('speechSynthesis' in window) speechSynthesis.addEventListener('voiceschanged', () => { speechSynthesis.getVoices(); });
function speak(text) {
  if (!('speechSynthesis' in window)) return;
  speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(text);
  // A natural local voice when the Mac has one (Apple's enhanced voices), never a
  // network voice: speech stays on this computer. Slightly slower than default.
  const voice = pickVoice();
  if (voice) utterance.voice = voice;
  utterance.rate = 0.92;
  utterance.pitch = 1;
  speechSynthesis.speak(utterance);
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
  notifyFamily: (pattern, medium) => family.notify(pattern, medium),
  showBanner: (kind, pattern, medium) => family.banner(kind, pattern, medium),
  onFamilyResult: (status) => { if (status === 'unavailable') $('family').textContent = 'Family alert could not be sent. Check the family contact on this computer.'; },
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
  consentEpoch += 1;
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
  await bindPreferredGrant();
});
// Pause ends the session's cloud permission too; allowing again is the person's choice.
$('pause').addEventListener('click', async () => { session.pause(); consentEpoch += 1; cloudPreferred = false; await revokeGrant(); render(session.state); });
$('read').addEventListener('click', () => { if (current) speak(spokenText(current)); });
$('grant').addEventListener('click', async () => {
  expired = false;
  cloudPreferred = true;
  // Before Start this only records the preference; during capture it binds now.
  if (session.state.phase === 'active' && stream) { userAllowedDuringCapture = true; await bindPreferredGrant(); }
  else renderConsent();
});
$('revoke').addEventListener('click', () => { consentEpoch += 1; expired = false; cloudPreferred = false; renderConsent(); return revokeGrant(); });
$('family-test').addEventListener('click', async () => {
  $('family').textContent = 'Sending a test message…';
  const status = await family.test();
  $('family').textContent = status === 'sent' ? 'Test message sent to the family contact.' : 'Test message could not be sent. Check the family contact on this computer.';
});
$('journal').addEventListener('click', () => { void toggleJournal(); });
$('journal-delete').addEventListener('click', () => { void deleteJournal(); });
render(session.state);
void refreshJournal();
// Local model state (managed llama-server: starting, warming, ready, unavailable).
async function refreshTiers() {
  try {
    const { analyzers } = await (await fetch('/api/capabilities')).json();
    const local = analyzers.find((a) => a.id === 'local-model');
    if (!local) { $('tiers').textContent = 'Local model not configured'; return; }
    const status = local.limitation ?? (local.available ? 'Local model ready' : 'Local model unavailable');
    // Capability metadata names the configured model, not a verified server identity.
    // Display only the file/identifier leaf; never expose a configured local path.
    const model = typeof local.model === 'string' ? local.model.replaceAll(String.fromCharCode(92), '/').split('/').pop().trim().slice(0, 160) : '';
    $('tiers').textContent = status + ' · Configured model: ' + (model || 'not reported');
  } catch { $('tiers').textContent = 'Local runtime not reachable'; }
}
void refreshTiers();
setInterval(refreshTiers, 3000);
`;
