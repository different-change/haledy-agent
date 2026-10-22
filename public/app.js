// Haledy agent UI. The vault is decrypted only here; the server and the model get ciphertext,
// consent-scoped Safe Harbor values, and {{tokens}}. See CONTRACT.md for the API.
import { FIELDS, TOKEN_FIELDS, zip3, modelValue, scrub, fillTokens, tokensIn } from './phi.js';
import {
  createVault, unlockVault, encryptProfile, ciphertextBytes,
  passkeyAvailable, createPasskeyVault, unlockPasskeyVault,
} from './vault.js';

const VAULT_KEY = 'haledy.vaultId';
const AGENT = 'haledy-agent';
const MAX_STEPS = 30;
const $ = id => document.getElementById(id);
const reducedMotion = () => window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

// ---------- small helpers ----------

function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else if (v === true) el.setAttribute(k, '');
      else el.setAttribute(k, String(v));
    }
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

const store = {
  get() { try { return localStorage.getItem(VAULT_KEY); } catch { return null; } },
  set(v) { try { localStorage.setItem(VAULT_KEY, v); } catch { /* private mode: id lives in memory */ } },
  clear() { try { localStorage.removeItem(VAULT_KEY); } catch { /* ignore */ } },
};

function clock(iso) {
  const d = iso ? new Date(iso) : new Date();
  if (Number.isNaN(d.getTime())) return String(iso || '');
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function remaining(ms) {
  if (ms <= 0) return '0:00';
  const s = Math.floor(ms / 1000);
  const hh = Math.floor(s / 3600);
  const mm = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return hh ? `${hh}:${String(mm).padStart(2, '0')}:${ss}` : `${mm}:${ss}`;
}

function safeHarborLetter(name) {
  const sh = FIELDS[name] && FIELDS[name].safeHarbor;
  return sh ? sh.split(' ')[0] : '';
}

function fieldLabel(name) {
  return FIELDS[name] ? FIELDS[name].label : name;
}

function parseKdf(kdf) {
  if (typeof kdf === 'string') { try { return JSON.parse(kdf); } catch { return {}; } }
  return kdf || {};
}

function scrollIntoView(el) {
  try { el.scrollIntoView({ block: 'nearest', behavior: reducedMotion() ? 'auto' : 'smooth' }); } catch { /* old browsers */ }
}

const FINDING_LABELS = {
  first_name: 'your first name', full_name: 'your full name', date_of_birth: 'your date of birth',
  phone: 'phone number', email: 'email address', member_id: 'member ID', group_number: 'group number',
  ssn: 'Social Security number', url: 'web address', ip: 'IP address', date: 'date',
  zip: 'ZIP code (cut to 3 digits)', 'id-number': 'ID number', 'long-number': 'long number',
};

const NETWORK = {
  confirmed: { label: 'In network · confirmed by the payer directory', order: 0 },
  listed: { label: 'Listed by the payer · network not confirmed', order: 1 },
  unverified: { label: 'Network not verified · see evidence', order: 2 },
  not_found: { label: 'Not found in the payer’s directory', order: 3 },
};

const KIND_LABELS = { model: 'Model', tool: 'Tool', consent: 'Consent', guard: 'Guard', grant: 'Grant', note: 'Note' };

// ---------- state ----------

function emptyProfile() {
  return Object.fromEntries(Object.keys(FIELDS).map(name => [name, '']));
}

const state = {
  vaultId: store.get(),
  record: null,
  key: null,
  kdf: null,
  profile: emptyProfile(),
  persona: false,
  dirty: false,
  busy: false,
  messages: [],
  renderedMsgs: 0,
  stepNo: 0,
  mode: null,
  grants: [],
  usedGrants: new Set(),
  notifiedGrants: new Set(),
  views: [],
  lastAuditId: 0,
  auditBusy: false,
  auditTimer: null,
  auditCount: 0,
};

// ---------- API ----------

async function api(method, path, body) {
  const headers = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (state.vaultId) headers['X-Vault'] = state.vaultId;
  const res = await fetch(path, {
    method, headers, cache: 'no-store', credentials: 'same-origin',
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data = null;
  try { data = await res.json(); } catch { /* empty body */ }
  if (!res.ok) {
    const err = new Error((data && data.error) || `${method} ${path} failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return data || {};
}

function audit(action, detail) {
  return api('POST', '/api/audit', { action, detail }).then(() => pollAudit()).catch(() => { /* audit is best effort from the device */ });
}

// ---------- vault column ----------

function setVaultStatus(text, kind) {
  const el = $('vault-status');
  el.textContent = text || '';
  el.className = `status${kind ? ` ${kind}` : ''}`;
}

function setSaveStatus(text, kind) {
  const el = $('save-status');
  el.textContent = text || '';
  el.className = `save-status${kind ? ` ${kind}` : ''}`;
}

function accessBadge(name, value) {
  const field = FIELDS[name];
  if (field.model === 'never') return { cls: 'access-never', text: `AI never sees this · Safe Harbor ${safeHarborLetter(name)}` };
  if (field.model === 'generalized') {
    const z = name === 'home_zip' ? zip3(value) : '';
    return { cls: 'access-generalized', text: z ? `AI sees only ${z}` : 'AI sees only the first 3 digits' };
  }
  return { cls: 'access-with-consent', text: 'AI sees it only with your consent' };
}

function buildEditor() {
  const root = $('editor-fields');
  root.replaceChildren();
  const groups = new Map();
  for (const [name, field] of Object.entries(FIELDS)) {
    if (!groups.has(field.group)) groups.set(field.group, []);
    groups.get(field.group).push(name);
  }
  for (const [group, names] of groups) {
    const fs = h('fieldset', null, h('legend', { text: group }));
    for (const name of names) {
      const id = `f-${name}`;
      const badge = h('span', { class: 'access', id: `b-${name}` });
      const input = h('input', {
        id, type: 'text', autocomplete: 'off', spellcheck: 'false',
        placeholder: FIELDS[name].example, 'aria-describedby': `b-${name}`,
      });
      input.addEventListener('input', () => {
        state.profile[name] = input.value;
        state.dirty = true;
        updateBadge(name);
        if (state.key) setSaveStatus('Unsaved changes. Save to encrypt them on this device.');
      });
      fs.append(h('div', { class: 'field' },
        h('div', { class: 'field-top' }, h('label', { class: 'field-label', for: id, text: FIELDS[name].label }), badge),
        input));
    }
    root.append(fs);
  }
  fillEditor();
}

function updateBadge(name) {
  const b = accessBadge(name, state.profile[name]);
  const el = $(`b-${name}`);
  if (el) { el.className = `access ${b.cls}`; el.textContent = b.text; }
}

function fillEditor() {
  for (const name of Object.keys(FIELDS)) {
    const input = $(`f-${name}`);
    if (input) input.value = state.profile[name] || '';
    updateBadge(name);
  }
  $('persona-note').hidden = !state.persona;
}

function renderVault() {
  const open = !!state.key;
  const hasVault = !!state.vaultId;
  const kdf = parseKdf(state.record && state.record.kdf);
  $('start-create').hidden = hasVault;
  $('start-unlock').hidden = !hasVault || open;
  $('unlock-form').hidden = kdf.kind === 'prf';
  $('passkey-unlock').hidden = kdf.kind !== 'prf';
  $('passkey-create').hidden = !passkeyAvailable();
  $('editor').hidden = hasVault && !open;
  $('save-btn').hidden = !open;
  $('demo-btn-2').hidden = !open;
  $('vault-tools').hidden = !hasVault;
  $('lock-btn').hidden = !open;
  const pill = $('vault-state');
  pill.textContent = open ? 'Unlocked on this device' : hasVault ? 'Locked' : 'No vault yet';
  pill.className = `pill ${open ? 'pill-open' : 'pill-locked'}`;
  if (!hasVault && !open) setSaveStatus('These values are encrypted on this device when you create the vault.');
  updateNeedForm();
}

function loadPersona() {
  state.profile = Object.fromEntries(Object.entries(FIELDS).map(([name, f]) => [name, f.example]));
  state.persona = true;
  state.dirty = true;
  fillEditor();
  if (state.key) setSaveStatus('Fictional demo persona loaded. Save to encrypt it on this device.');
  else setVaultStatus('Fictional demo persona loaded. Choose a passphrase to encrypt it.', 'ok');
}

async function fetchRecord() {
  const rec = await api('GET', '/api/vault');
  rec.kdf = parseKdf(rec.kdf);
  return rec;
}

async function onCreate(e) {
  e.preventDefault();
  const p1 = $('pass1').value;
  const p2 = $('pass2').value;
  if (p1 !== p2) return setVaultStatus('The two passphrases are different.', 'error');
  if (p1.length < 8) return setVaultStatus('Use a passphrase of at least 8 characters.', 'error');
  await createWith(() => createVault(p1, state.profile), 'passphrase');
}

async function onPasskeyCreate() {
  await createWith(() => createPasskeyVault(state.profile), 'passkey');
}

async function createWith(make, method) {
  const buttons = document.querySelectorAll('#start-create button');
  buttons.forEach(b => { b.disabled = true; });
  setVaultStatus(method === 'passkey'
    ? 'Waiting for your passkey (Windows Hello or your phone)…'
    : 'Deriving a key on this device (PBKDF2-SHA256, 600,000 rounds)…');
  try {
    const v = await make();
    const body = { ciphertext: v.ciphertext, iv: v.iv, kdf: v.kdf };
    state.vaultId = null;
    const res = await api('POST', '/api/vault', body);
    if (!res.vaultId) throw new Error('The server did not return a vault id.');
    state.vaultId = res.vaultId;
    store.set(res.vaultId);
    state.key = v.key;
    state.kdf = v.kdf;
    state.record = { ...body };
    state.dirty = false;
    $('pass1').value = '';
    $('pass2').value = '';
    setVaultStatus(`Vault created with a ${method}. ${ciphertextBytes(v.ciphertext)} bytes of ciphertext went to our server; the key stayed here.`, 'ok');
    setSaveStatus(`Encrypted on this device · ${ciphertextBytes(v.ciphertext)} bytes`, 'ok');
    onOpened();
  } catch (err) {
    setVaultStatus(err.message || String(err), 'error');
  } finally {
    buttons.forEach(b => { b.disabled = false; });
  }
}

async function onUnlock(e) {
  e.preventDefault();
  const pass = $('unlock-pass').value;
  await unlockWith(rec => unlockVault(rec, pass), 'passphrase');
}

async function unlockWith(open, method) {
  const buttons = document.querySelectorAll('#start-unlock button');
  buttons.forEach(b => { b.disabled = true; });
  setVaultStatus(method === 'passkey' ? 'Waiting for your passkey…' : 'Deriving the key on this device…');
  try {
    if (!state.record) state.record = await fetchRecord();
    const { profile, key } = await open(state.record);
    state.key = key;
    state.kdf = parseKdf(state.record.kdf);
    state.profile = { ...emptyProfile(), ...profile };
    state.persona = false;
    state.dirty = false;
    $('unlock-pass').value = '';
    fillEditor();
    setVaultStatus('Unlocked on this device. Our server never saw the key.', 'ok');
    setSaveStatus(`Encrypted on this device · ${ciphertextBytes(state.record.ciphertext)} bytes`, 'ok');
    audit('vault_unlocked', { method });
    onOpened();
  } catch (err) {
    setVaultStatus(err.message || String(err), 'error');
  } finally {
    buttons.forEach(b => { b.disabled = false; });
  }
}

async function onSave(e) {
  e.preventDefault();
  if (!state.key) return;
  const btn = $('save-btn');
  btn.disabled = true;
  try {
    const rec = await encryptProfile(state.key, state.profile, state.kdf);
    const res = await api('PUT', '/api/vault', rec);
    state.record = { ...rec, updatedAt: res.updatedAt };
    state.dirty = false;
    setSaveStatus(`Encrypted on this device · ${ciphertextBytes(rec.ciphertext)} bytes · saved ${clock()}`, 'ok');
    refreshServerView();
    pollAudit();
  } catch (err) {
    setSaveStatus(err.message || String(err), 'error');
  } finally {
    btn.disabled = false;
  }
}

function onOpened() {
  renderVault();
  startAuditPolling();
  refreshServerView();
}

function lock() {
  state.key = null;
  state.kdf = null;
  state.profile = emptyProfile();
  state.persona = false;
  state.dirty = false;
  fillEditor();
  stopAuditPolling();
  resetRun();
  setVaultStatus('Locked. The key and the decrypted vault were dropped from memory.', 'ok');
  setSaveStatus('');
  renderVault();
}

async function forgetMe() {
  const ok = window.confirm('Forget me: delete the encrypted vault, every consent grant and the whole audit log from our server, and clear this browser. This cannot be undone.');
  if (!ok) return;
  const btn = $('forget-btn');
  btn.disabled = true;
  try {
    if (state.vaultId) {
      try { await api('DELETE', '/api/vault'); } catch (err) { if (err.status !== 404) throw err; }
    }
    store.clear();
    stopAuditPolling();
    Object.assign(state, {
      vaultId: null, record: null, key: null, kdf: null, profile: emptyProfile(), persona: false, dirty: false,
      grants: [], views: [], lastAuditId: 0, auditCount: 0, mode: null,
    });
    resetRun();
    fillEditor();
    $('audit-list').replaceChildren();
    setMode(null);
    renderGrants();
    renderSaw();
    renderServerEmpty('Deleted. Our server holds nothing for you now.');
    renderAuditEmpty();
    setVaultStatus('Forgotten. The vault, grants and audit log were deleted from our server, and this browser was cleared.', 'ok');
    setSaveStatus('');
    renderVault();
  } catch (err) {
    setVaultStatus(err.message || String(err), 'error');
  } finally {
    btn.disabled = false;
  }
}

// ---------- conversation ----------

function updateNeedForm() {
  const open = !!state.key;
  $('need').disabled = !open || state.busy;
  $('need-send').disabled = !open || state.busy;
  $('need-hint').textContent = !open
    ? 'Unlock your vault first. Identifiers are removed on this device before anything is sent.'
    : state.busy
      ? 'The agent is working…'
      : 'Identifiers you type (name, phone, member ID…) are removed on this device before anything is sent.';
}

function setMode(mode) {
  state.mode = mode;
  const el = $('mode-badge');
  el.dataset.mode = mode || 'idle';
  el.textContent = mode === 'model' ? 'Agent: Claude' : mode === 'scripted' ? 'Agent: Scripted planner (no model key)' : 'Agent mode: not started';
}

function thread() { return $('thread'); }

function addToThread(el) {
  thread().append(el);
  scrollIntoView(el);
  return el;
}

function resetRun() {
  state.messages = [];
  state.renderedMsgs = 0;
  state.stepNo = 0;
  state.usedGrants.clear();
  state.notifiedGrants.clear();
  state.views = [];
  thread().replaceChildren();
  renderSaw();
}

function addPatientBubble(raw, sent) {
  const bubble = h('div', { class: 'msg msg-patient' }, raw);
  if (sent !== raw) bubble.append(h('span', { class: 'sent-as' }, 'Sent as: ', sent));
  addToThread(bubble);
}

function addScrubNote(findings) {
  const seen = new Map();
  for (const f of findings) if (!seen.has(f.type)) seen.set(f.type, f);
  const parts = [...seen.values()].map(f => `${FINDING_LABELS[f.type] || f.type} (Safe Harbor ${String(f.safeHarbor || '').split(' ')[0]})`);
  addToThread(h('div', { class: 'scrub-note', role: 'status' }, `Removed before anything left this device: ${parts.join(', ')}.`));
  return [...seen.keys()];
}

function addStepLine(text) {
  return addToThread(h('div', { class: 'step-line live' }, text));
}

function addError(text) {
  addToThread(h('div', { class: 'error-card', role: 'alert' }, text));
}

function addEvents(events) {
  if (!Array.isArray(events) || !events.length) return;
  const list = h('ul', { class: 'events' });
  for (const ev of events) {
    // The agent's own words already appear above the events; a model event would repeat them.
    if (ev.kind === 'model') continue;
    const kind = KIND_LABELS[ev.kind] ? ev.kind : 'note';
    const body = h('span', { class: 'event-body' }, h('strong', null, ev.title || ''));
    if (ev.detail) body.append(' ', h('span', { class: 'event-detail' }, `· ${ev.detail}`));
    if (Array.isArray(ev.fields) && ev.fields.length) body.append(' ', h('span', { class: 'event-detail' }, `· fields: ${ev.fields.map(fieldLabel).join(', ')}`));
    if (ev.source && ev.source.name) {
      body.append(' ', h('span', { class: 'event-detail' }, '· '));
      if (/^https?:\/\//.test(ev.source.url || '')) body.append(h('a', { href: ev.source.url, target: '_blank', rel: 'noopener noreferrer', text: ev.source.name }));
      else body.append(h('span', { class: 'event-detail', text: ev.source.name }));
    }
    list.append(h('li', { class: 'event' }, h('span', { class: `kind kind-${kind}`, text: KIND_LABELS[kind] }), body));
  }
  addToThread(list);
}

function assistantText(message) {
  if (!message || message.role !== 'assistant') return '';
  if (typeof message.content === 'string') return message.content;
  if (!Array.isArray(message.content)) return '';
  return message.content.filter(b => b && b.type === 'text' && b.text).map(b => b.text).join('\n\n');
}

function renderNewAssistantText() {
  for (let i = state.renderedMsgs; i < state.messages.length; i++) {
    const text = assistantText(state.messages[i]).trim();
    if (text) addToThread(h('div', { class: 'msg msg-agent' }, h('span', { class: 'who', text: 'Haledy' }), text));
  }
  state.renderedMsgs = state.messages.length;
}

function buildReleases() {
  const now = Date.now();
  const out = [];
  for (const g of state.grants) {
    if (g.recipient !== AGENT) continue;
    const live = g.status === 'active' && Date.parse(g.expiresAt) > now;
    if (live) {
      const values = {};
      for (const field of g.fields || []) {
        const v = modelValue(field, state.profile[field]);
        if (v != null) values[field] = v;
      }
      out.push({ grantId: g.id, values });
      state.usedGrants.add(g.id);
    } else if (state.usedGrants.has(g.id) && !state.notifiedGrants.has(g.id)) {
      // Revoked or expired mid-run: send the id once, with no values, so the agent is told to stop using it.
      out.push({ grantId: g.id, values: {} });
      state.notifiedGrants.add(g.id);
    }
  }
  return out;
}

const STATUS_TEXT = {
  running: 'working', needs_consent: 'asks for your consent', needs_approval: 'asks you to approve a message',
  done: 'done', error: 'stopped with an error',
};

function handleResponse(res, line) {
  if (Array.isArray(res.messages)) state.messages = res.messages;
  if (res.mode) setMode(res.mode);
  line.textContent = `Step ${state.stepNo} · ${STATUS_TEXT[res.status] || res.status || 'no status'}`;
  if (typeof res.modelView === 'string' && res.modelView) {
    state.views.push({ at: new Date().toISOString(), step: state.stepNo, text: res.modelView, mode: res.mode });
    renderSaw();
  }
  renderNewAssistantText();
  addEvents(res.events);
  refreshServerView();
}

async function runSteps(extra) {
  state.busy = true;
  updateNeedForm();
  let body = extra || {};
  try {
    for (let guard = 0; guard < MAX_STEPS; guard++) {
      state.stepNo += 1;
      const line = addStepLine(`Step ${state.stepNo} · waiting for the agent…`);
      let res;
      try {
        res = await api('POST', '/api/agent/step', { messages: state.messages, releases: buildReleases(), ...body });
      } finally {
        line.classList.remove('live');
      }
      body = {};
      handleResponse(res, line);
      if (res.status === 'running') continue;
      if (res.status === 'needs_consent' && res.consentRequest) renderConsent(res.consentRequest);
      else if (res.status === 'needs_approval' && res.draft) renderDraft(res.draft);
      else if (res.status === 'done') renderResult(res.result);
      else addError(res.error || `The agent stopped (${res.status || 'no status'}).`);
      return;
    }
    addError(`Stopped after ${MAX_STEPS} steps without an answer.`);
  } catch (err) {
    addError(err.message || String(err));
  } finally {
    state.busy = false;
    updateNeedForm();
    pollAudit();
  }
}

async function onNeed(e) {
  e.preventDefault();
  if (!state.key || state.busy) return;
  const raw = $('need').value.trim();
  if (!raw) return;
  const known = {};
  for (const name of TOKEN_FIELDS) if (state.profile[name]) known[name] = state.profile[name];
  const { text, findings } = scrub(raw, known);
  resetRun();
  addPatientBubble(raw, text);
  if (findings.length) {
    const types = addScrubNote(findings);
    audit('scrubbed_locally', { types });
  }
  $('need').value = '';
  await runSteps({ need: text });
}

// ---------- consent card ----------

function renderConsent(req) {
  const fields = Array.isArray(req.fields) ? req.fields : [];
  const list = h('ul', { class: 'consent-fields' });
  for (const name of fields) {
    const field = FIELDS[name];
    const id = `c-${req.toolUseId}-${name}`.replace(/[^\w-]/g, '_');
    const value = state.profile[name];
    const mv = field ? modelValue(name, value) : null;
    let grantable = !!field && field.model !== 'never' && mv != null;
    let sees;
    if (!field) {
      sees = h('span', { class: 'sees' }, 'Not a vault field. It cannot be granted.');
    } else if (field.model === 'never') {
      sees = h('span', { class: 'sees' }, `An identifier (Safe Harbor ${safeHarborLetter(name)}). It cannot be granted to the AI; it is filled on this device only, in a message you approve.`);
    } else if (mv == null) {
      sees = h('span', { class: 'sees' }, 'Empty in your vault, so there is nothing to share.');
      grantable = false;
    } else {
      sees = h('span', { class: 'sees' }, 'The AI would see: ', h('code', { text: mv }));
      if (field.model === 'generalized' && String(value).trim() !== mv) sees.append(` (not ${String(value).trim()}: the full ZIP stays on this device)`);
    }
    const box = h('input', { type: 'checkbox', id, value: name, checked: grantable, disabled: !grantable });
    list.append(h('li', { class: `consent-field${grantable ? '' : ' locked'}` }, box,
      h('label', { for: id }, h('span', { class: 'name', text: fieldLabel(name) }), sees)));
  }

  const ttlOptions = [15, 30, 60];
  const requested = Number(req.ttlMinutes) || 30;
  if (!ttlOptions.includes(requested) && requested >= 1 && requested <= 120) ttlOptions.push(requested);
  ttlOptions.sort((a, b) => a - b);
  const selectId = `ttl-${req.toolUseId}`.replace(/[^\w-]/g, '_');
  const ttl = h('select', { id: selectId }, ttlOptions.map(m => h('option', { value: m, selected: m === requested, text: `${m} minutes` })));

  const status = h('p', { class: 'status', role: 'status' });
  const approve = h('button', { class: 'button button-dark', type: 'button' }, 'Approve selected');
  const deny = h('button', { class: 'button button-ghost', type: 'button' }, 'Deny');
  const card = h('section', { class: 'action-card', 'aria-label': 'Consent request' },
    h('span', { class: 'card-eyebrow', text: 'The agent asks for your consent' }),
    h('h3', { text: 'Share these with Haledy, for this search only?' }),
    h('p', { class: 'purpose' }, h('strong', null, 'Purpose: '), req.purpose || 'not stated'),
    h('p', { class: 'why' }, req.why || ''),
    list,
    h('div', { class: 'card-row' },
      h('label', { class: 'field-label', for: selectId, text: 'For how long' }), ttl,
      h('span', { class: 'note', text: `Recipient: ${AGENT} (this AI agent only)` })),
    h('div', { class: 'card-actions' }, approve, deny),
    status);

  const finish = text => {
    approve.disabled = true;
    deny.disabled = true;
    list.querySelectorAll('input').forEach(i => { i.disabled = true; });
    ttl.disabled = true;
    card.append(h('p', { class: 'done-note', text }));
  };

  approve.addEventListener('click', async () => {
    const chosen = [...list.querySelectorAll('input:checked')].map(i => i.value);
    if (!chosen.length) { status.textContent = 'Choose at least one field, or Deny.'; status.className = 'status error'; return; }
    approve.disabled = true;
    deny.disabled = true;
    try {
      const grant = await api('POST', '/api/grants', { fields: chosen, recipient: AGENT, purpose: req.purpose || 'Find care', ttlMinutes: Number(ttl.value) });
      upsertGrant(grant);
      renderGrants();
      const shown = chosen.map(n => `${fieldLabel(n)} as “${modelValue(n, state.profile[n])}”`).join(', ');
      finish(`Granted for ${ttl.value} minutes: ${shown}. Revoke any time in Consent grants.`);
      await runSteps({ consentAnswer: { toolUseId: req.toolUseId, grantId: grant.id } });
    } catch (err) {
      status.textContent = err.message || String(err);
      status.className = 'status error';
      approve.disabled = false;
      deny.disabled = false;
    }
  });

  deny.addEventListener('click', async () => {
    finish('Denied. Nothing was shared.');
    audit('consent_denied', { fields });
    await runSteps({ consentAnswer: { toolUseId: req.toolUseId, denied: true } });
  });

  addToThread(card);
}

// ---------- draft approval ----------

function tokenized(body) {
  const out = [];
  let last = 0;
  for (const m of String(body || '').matchAll(/\{\{(\w+)\}\}/g)) {
    if (m.index > last) out.push(body.slice(last, m.index));
    out.push(h('span', { class: 'token', title: `${fieldLabel(m[1])}: filled on this device only`, text: m[0] }));
    last = m.index + m[0].length;
  }
  if (last < String(body || '').length) out.push(String(body).slice(last));
  return out;
}

const CHANNELS = { email: 'Email', web_form: 'Web form', phone_script: 'Phone script' };

function renderDraft(draft) {
  const fill = h('button', { class: 'button button-dark', type: 'button' }, 'Fill on this device & copy');
  const discard = h('button', { class: 'button button-ghost', type: 'button' }, 'Discard');
  const card = h('section', { class: 'action-card', 'aria-label': 'Draft message for approval' },
    h('span', { class: 'card-eyebrow', text: 'Draft for your approval' }),
    h('h3', { text: `Message to ${draft.recipientName || 'the clinic'}` }),
    h('p', { class: 'draft-meta' }, `${CHANNELS[draft.channel] || draft.channel || 'Message'}${draft.npi ? ` · NPI ${draft.npi}` : ''} · identifiers are tokens, filled only on this device`),
    h('div', { class: 'draft-body' }, tokenized(draft.body)),
    h('div', { class: 'card-actions' }, fill, discard));

  fill.addEventListener('click', async () => {
    fill.disabled = true;
    discard.disabled = true;
    const filled = fillTokens(draft.body, state.profile);
    let copied = false;
    try { await navigator.clipboard.writeText(filled); copied = true; } catch { /* clipboard may be blocked */ }
    const missing = tokensIn(filled);
    card.append(h('div', { class: 'filled' },
      h('span', { class: 'card-eyebrow', text: `Filled on this device only${copied ? ' · copied to your clipboard' : ''}` }),
      h('pre', { text: filled }),
      h('p', { class: 'note', text: missing.length
        ? `Still empty in your vault: ${missing.map(fieldLabel).join(', ')}.`
        : 'This filled text was not sent to our server or to the AI.' })));
    audit('tokens_filled', { fields: tokensIn(draft.body), recipient: draft.recipientName || '' });
    await runSteps({ draftAnswer: { toolUseId: draft.toolUseId, approved: true } });
  });

  discard.addEventListener('click', async () => {
    fill.disabled = true;
    discard.disabled = true;
    card.append(h('p', { class: 'done-note', text: 'Discarded. Nothing was filled or sent.' }));
    await runSteps({ draftAnswer: { toolUseId: draft.toolUseId, approved: false } });
  });

  addToThread(card);
}

// ---------- results ----------

function evidenceList(items) {
  const ul = h('ul');
  for (const ev of items || []) {
    const li = h('li', null, h('span', { class: 'src', text: ev.source || 'Source' }), ': ', ev.claim || '');
    if (ev.asOf) li.append(' ', h('span', { class: 'asof', text: `(as of ${ev.asOf})` }));
    if (/^https?:\/\//.test(ev.url || '')) {
      let host = ev.url;
      try { host = new URL(ev.url).hostname; } catch { /* keep raw */ }
      li.append(' ', h('a', { href: ev.url, target: '_blank', rel: 'noopener noreferrer', text: host }));
    }
    ul.append(li);
  }
  return ul;
}

function renderResult(result) {
  if (!result) { addError('The agent finished without options.'); return; }
  const homeZip = String(state.profile.home_zip || '').trim().slice(0, 5);
  const options = (result.options || []).map((o, i) => ({
    ...o, orig: i, inZip: !!homeZip && String(o.zip || '').slice(0, 5) === homeZip,
  }));
  const sorted = [...options].sort((a, b) =>
    ((NETWORK[a.network] || { order: 9 }).order - (NETWORK[b.network] || { order: 9 }).order)
    || (Number(b.inZip) - Number(a.inZip))
    || ((a.rank ?? a.orig) - (b.rank ?? b.orig)));
  const anyInZip = sorted.some(o => o.inZip);

  const wrap = h('section', { class: 'results', 'aria-label': 'Ranked options' },
    h('div', { class: 'results-head' },
      h('span', { class: 'card-eyebrow', text: 'Your options' }),
      h('h3', { text: `${sorted.length} option${sorted.length === 1 ? '' : 's'}, ranked by network evidence` }),
      result.summary ? h('p', { text: result.summary }) : null),
    h('p', { class: 'availability', text: 'Availability unknown until the clinic answers.' }));
  if (anyInZip) wrap.append(h('p', { class: 'rerank-note', text: `Marked “In your ZIP” on this device using your full ZIP. The AI only knew ${zip3(homeZip) || 'the first 3 digits'}.` }));

  sorted.forEach((o, i) => {
    const net = NETWORK[o.network] || { label: o.network || 'unknown' };
    const details = h('details', { class: 'evidence', open: i === 0 },
      h('summary', { text: `Evidence (${(o.evidence || []).length}): who said what, when` }),
      evidenceList(o.evidence));
    wrap.append(h('article', { class: 'option', dataset: { network: o.network || '' } },
      h('div', { class: 'option-top' },
        h('span', { class: 'rank', text: String(i + 1) }),
        h('div', null,
          h('h4', { text: o.name || `NPI ${o.npi}` }),
          h('p', { class: 'addr', text: [o.address, o.zip && !String(o.address || '').includes(o.zip) ? o.zip : '', o.phone].filter(Boolean).join(' · ') }),
          h('div', { class: 'tags' },
            h('span', { class: `net net-${o.network}`, text: net.label }),
            o.inZip ? h('span', { class: 'in-zip', text: 'In your ZIP' }) : null,
            o.npi ? h('span', { class: 'note', text: `NPI ${o.npi}` }) : null))),
      o.why ? h('p', { class: 'why', text: o.why }) : null,
      details));
  });

  if (Array.isArray(result.limitations) && result.limitations.length) {
    wrap.append(h('div', { class: 'list-block' }, h('h4', { text: 'What these sources cannot confirm' }),
      h('ul', null, result.limitations.map(t => h('li', { text: t })))));
  }
  if (Array.isArray(result.nextSteps) && result.nextSteps.length) {
    wrap.append(h('div', { class: 'list-block' }, h('h4', { text: 'Next steps' }),
      h('ul', null, result.nextSteps.map(t => h('li', { text: t })))));
  }
  addToThread(wrap);
}

// ---------- transparency: tabs ----------

function selectTab(name) {
  for (const tab of document.querySelectorAll('.tab')) {
    const on = tab.dataset.tab === name;
    tab.setAttribute('aria-selected', String(on));
    tab.tabIndex = on ? 0 : -1;
    $(tab.getAttribute('aria-controls')).hidden = !on;
  }
  if (name === 'server') refreshServerView();
}

function bindTabs() {
  const tabs = [...document.querySelectorAll('.tab')];
  tabs.forEach((tab, i) => {
    tab.addEventListener('click', () => selectTab(tab.dataset.tab));
    tab.addEventListener('keydown', e => {
      if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
      const next = tabs[(i + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
      next.focus();
      selectTab(next.dataset.tab);
    });
  });
}

// ---------- What the AI saw ----------

function highlighted(text) {
  const z = zip3(state.profile.home_zip);
  const parts = ['\\{\\{\\w+\\}\\}', '\\b\\d{3}xx\\b'];
  if (z) parts.push(`\\b${z}\\b`);
  const re = new RegExp(parts.join('|'), 'g');
  const out = [];
  let last = 0;
  for (const m of text.matchAll(re)) {
    if (m.index > last) out.push(text.slice(last, m.index));
    out.push(h('mark', { class: m[0].startsWith('{{') ? 'hl-token' : 'hl-zip', text: m[0] }));
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

function renderSaw() {
  const root = $('saw-list');
  root.replaceChildren();
  if (!state.views.length) {
    root.append(h('p', { class: 'empty', text: 'Nothing yet. Each agent step will show the exact de-identified text the model received.' }));
    return;
  }
  for (const v of [...state.views].reverse()) {
    root.append(h('article', { class: 'saw-item' },
      h('h4', { text: `Exactly what the model received at ${clock(v.at)} · step ${v.step}${v.mode === 'scripted' ? ' · scripted planner' : ''}` }),
      h('pre', null, highlighted(v.text))));
  }
}

// ---------- What our server holds ----------

function renderServerEmpty(text) {
  $('server-view').replaceChildren(
    h('h3', { class: 'server-head', text: 'Everything our server holds about you' }),
    h('p', { class: 'empty', text: text || 'No vault yet, so nothing at all.' }));
}

let serverViewInFlight = false;
async function refreshServerView() {
  if (!state.vaultId || serverViewInFlight) return;
  serverViewInFlight = true;
  try {
    const view = await api('GET', '/api/server-view');
    if (Array.isArray(view.grants)) { view.grants.forEach(upsertGrant); renderGrants(); }
    renderServerView(view);
  } catch (err) {
    if (err.status === 404) renderServerEmpty('Our server has no vault under this id.');
  } finally {
    serverViewInFlight = false;
  }
}

function renderServerView(view) {
  const v = view.vault || {};
  const kdf = parseKdf(v.kdf);
  const kdfText = kdf.kind === 'pbkdf2'
    ? `PBKDF2-${kdf.hash || 'SHA-256'} · ${Number(kdf.iterations || 0).toLocaleString()} rounds · salt ${kdf.salt || ''}`
    : kdf.kind === 'prf' ? `Passkey PRF → HKDF-SHA-256 · salt ${kdf.salt || ''}` : JSON.stringify(kdf);
  const grants = Array.isArray(view.grants) ? view.grants : [];
  const entries = Array.isArray(view.audit) ? view.audit : [];
  const grantList = grants.length
    ? h('ul', { class: 'server-grants' }, grants.map(g => h('li', { class: 'grant-meta' },
      h('strong', { text: (g.fields || []).map(fieldLabel).join(', ') }),
      ` · ${g.recipient} · ${g.status} · until ${clock(g.expiresAt)}`)))
    : h('p', { class: 'note', text: 'No grants.' });
  $('server-view').replaceChildren(
    h('h3', { class: 'server-head', text: 'Everything our server holds about you' }),
    h('p', { class: 'server-sub', text: `Fetched from the server at ${clock()}. This is the whole record, not a summary.` }),
    h('p', { class: 'server-section', text: 'Encrypted vault' }),
    h('div', { class: 'cipher', text: `${v.ciphertextPreview || ''}…` }),
    h('dl', { class: 'kv' },
      h('dt', { text: 'Size' }), h('dd', { text: `${v.bytes ?? '?'} bytes of ciphertext` }),
      h('dt', { text: 'Key derivation' }), h('dd', { text: kdfText }),
      h('dt', { text: 'Cipher' }), h('dd', { text: 'AES-GCM-256, key never leaves this device' }),
      h('dt', { text: 'Created' }), h('dd', { text: v.createdAt || '' }),
      h('dt', { text: 'Updated' }), h('dd', { text: v.updatedAt || '' })),
    h('p', { class: 'server-section', text: `Consent grants (${grants.length})` }),
    grantList,
    h('p', { class: 'server-section', text: `Audit log (${entries.length} entries)` }),
    h('p', { class: 'note', text: 'Field names, hosts and counts. Never values.' }),
    h('p', { class: 'server-section', text: 'Not held' }),
    h('ul', { class: 'not-held' },
      h('li', { text: 'Your name, email, phone or any account' }),
      h('li', { text: 'Your passphrase or encryption key' }),
      h('li', { text: 'Your vault in readable form' }),
      h('li', { text: 'Values released to the agent: they travel with each step and are not stored' })));
}

// ---------- Audit log ----------

function renderAuditEmpty() {
  $('audit-list').replaceChildren(h('li', { class: 'empty', text: 'Open a vault to see every action taken for you.' }));
}

function auditItem(entry, fresh) {
  const actor = ['patient', 'device', 'agent', 'server'].includes(entry.actor) ? entry.actor : 'server';
  let detail = '';
  if (entry.detail && typeof entry.detail === 'object' && Object.keys(entry.detail).length) detail = JSON.stringify(entry.detail);
  else if (typeof entry.detail === 'string' && entry.detail !== '{}') detail = entry.detail;
  if (detail.length > 320) detail = `${detail.slice(0, 320)}…`;
  const li = h('li', { class: `audit-item${fresh ? ' fresh' : ''}` },
    h('div', { class: 'audit-top' },
      h('span', { class: `actor actor-${actor}`, text: actor }),
      h('span', { class: 'audit-action', text: entry.action }),
      h('span', { class: 'audit-time', text: clock(entry.createdAt) })),
    detail ? h('div', { class: 'audit-detail', text: detail }) : null);
  if (fresh) setTimeout(() => li.classList.remove('fresh'), 4000);
  return li;
}

async function pollAudit() {
  if (!state.vaultId || !state.key || state.auditBusy) return;
  state.auditBusy = true;
  try {
    const { entries } = await api('GET', `/api/audit?after=${encodeURIComponent(state.lastAuditId)}`);
    if (Array.isArray(entries) && entries.length) {
      const list = $('audit-list');
      if (state.auditCount === 0) list.replaceChildren();
      const fresh = state.auditCount > 0;
      for (const entry of [...entries].sort((a, b) => a.id - b.id)) {
        if (entry.id <= state.lastAuditId) continue;
        state.lastAuditId = entry.id;
        state.auditCount += 1;
        list.prepend(auditItem(entry, fresh));
      }
    } else if (state.auditCount === 0) {
      $('audit-list').replaceChildren(h('li', { class: 'empty', text: 'No actions yet.' }));
    }
  } catch { /* transient: next poll retries */ } finally {
    state.auditBusy = false;
  }
}

function startAuditPolling() {
  stopAuditPolling();
  pollAudit();
  state.auditTimer = setInterval(pollAudit, 2000);
}

function stopAuditPolling() {
  if (state.auditTimer) clearInterval(state.auditTimer);
  state.auditTimer = null;
}

// ---------- Consent grants ----------

function upsertGrant(grant) {
  if (!grant || !grant.id) return;
  const i = state.grants.findIndex(g => g.id === grant.id);
  if (i === -1) state.grants.push(grant);
  else state.grants[i] = { ...state.grants[i], ...grant };
}

function grantLive(g) {
  return g.status === 'active' && Date.parse(g.expiresAt) > Date.now();
}

function renderGrants() {
  const root = $('grant-list');
  root.replaceChildren();
  const agentGrants = [...state.grants].sort((a, b) => Number(grantLive(b)) - Number(grantLive(a)) || String(b.createdAt).localeCompare(String(a.createdAt)));
  const live = agentGrants.filter(grantLive).length;
  const count = $('grant-count');
  count.hidden = !live;
  count.textContent = String(live);
  if (!agentGrants.length) {
    root.append(h('p', { class: 'empty', text: 'No grants. The agent has asked for nothing yet.' }));
    return;
  }
  for (const g of agentGrants) {
    const isLive = grantLive(g);
    const status = isLive ? 'active' : g.status === 'revoked' ? 'revoked' : 'expired';
    const revoke = isLive ? h('button', { class: 'button button-danger button-small', type: 'button', text: 'Revoke' }) : null;
    if (revoke) revoke.addEventListener('click', () => revokeGrant(g, revoke));
    const fields = (g.fields || []).map(n => {
      const mv = state.key ? modelValue(n, state.profile[n]) : null;
      return mv != null ? `${fieldLabel(n)} (as “${mv}”)` : fieldLabel(n);
    }).join(', ');
    root.append(h('article', { class: 'grant', dataset: { status } },
      h('div', { class: 'grant-top' },
        h('span', { class: 'grant-fields', text: fields }),
        h('span', { class: 'countdown', dataset: { expires: g.expiresAt, id: g.id }, text: isLive ? remaining(Date.parse(g.expiresAt) - Date.now()) : status }),
        revoke),
      h('p', { class: 'grant-meta', text: `For ${g.recipient} · ${g.purpose}` }),
      h('p', { class: 'grant-meta', text: status === 'revoked'
        ? `Revoked at ${clock(g.revokedAt || undefined)}`
        : `${isLive ? 'Expires' : 'Expired'} at ${clock(g.expiresAt)} · grant ${String(g.id).slice(0, 10)}` })));
  }
}

async function revokeGrant(grant, button) {
  button.disabled = true;
  try {
    const updated = await api('POST', `/api/grants/${encodeURIComponent(grant.id)}/revoke`, {});
    upsertGrant({ ...grant, ...updated, status: 'revoked', revokedAt: updated.revokedAt || new Date().toISOString() });
    renderGrants();
    if (thread().childElementCount) {
      addToThread(h('ul', { class: 'events' }, h('li', { class: 'event' },
        h('span', { class: 'kind kind-grant', text: 'Grant' }),
        h('span', { class: 'event-body' }, h('strong', { text: 'You revoked a grant.' }),
          ' ', h('span', { class: 'event-detail', text: `· the next step goes without: ${(grant.fields || []).map(fieldLabel).join(', ')}` })))));
    }
    refreshServerView();
    pollAudit();
  } catch (err) {
    button.disabled = false;
    window.alert(err.message || String(err));
  }
}

function tick() {
  let changed = false;
  for (const el of document.querySelectorAll('.countdown[data-expires]')) {
    const g = state.grants.find(x => x.id === el.dataset.id);
    if (!g || g.status !== 'active') continue;
    const left = Date.parse(el.dataset.expires) - Date.now();
    if (left <= 0) changed = true;
    else el.textContent = remaining(left);
  }
  if (changed) renderGrants();
}

// ---------- boot ----------

function bind() {
  $('create-form').addEventListener('submit', onCreate);
  $('unlock-form').addEventListener('submit', onUnlock);
  $('editor').addEventListener('submit', onSave);
  $('demo-btn').addEventListener('click', loadPersona);
  $('demo-btn-2').addEventListener('click', loadPersona);
  $('passkey-create').addEventListener('click', onPasskeyCreate);
  $('passkey-unlock').addEventListener('click', () => unlockWith(rec => unlockPasskeyVault(rec), 'passkey'));
  $('lock-btn').addEventListener('click', lock);
  $('forget-btn').addEventListener('click', forgetMe);
  $('need-form').addEventListener('submit', onNeed);
  $('need').addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); $('need-form').requestSubmit(); }
  });
  for (const chip of document.querySelectorAll('.chip')) {
    chip.addEventListener('click', () => { $('need').value = chip.dataset.need; $('need').focus(); });
  }
  bindTabs();
}

async function init() {
  buildEditor();
  bind();
  setMode(null);
  renderGrants();
  renderSaw();
  renderAuditEmpty();
  renderServerEmpty();
  if (state.vaultId) {
    try {
      state.record = await fetchRecord();
      refreshServerView();
    } catch (err) {
      if (err.status === 404 || err.status === 401 || err.status === 403) {
        store.clear();
        state.vaultId = null;
        setVaultStatus('That vault no longer exists on our server. Create a new one.');
      } else {
        setVaultStatus(`Could not reach the server: ${err.message}`, 'error');
      }
    }
  }
  renderVault();
  setInterval(tick, 1000);
}

init();
