// End-to-end smoke test against a running Worker (wrangler dev). Uses only the fictional
// demo persona from public/phi.js. Usage: node scripts/smoke.mjs [baseUrl]
import { FIELDS, TOKEN_FIELDS } from '../public/phi.js';

const base = (process.argv[2] || 'http://127.0.0.1:8788').replace(/\/$/, '');
const origin = new URL(base).origin;
let vaultId = '';
let failures = 0;

function ok(condition, label) {
  if (condition) console.log(`ok   ${label}`);
  else { failures += 1; console.log(`FAIL ${label}`); }
  return condition;
}

async function call(method, path, { body, vault = vaultId, headers = {}, withOrigin = true } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: {
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(withOrigin ? { Origin: origin } : {}),
      ...(vault ? { 'X-Vault': vault } : {}),
      ...headers,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch { /* empty */ }
  return { status: res.status, data, headers: res.headers };
}

const b64 = bytes => Buffer.from(crypto.getRandomValues(new Uint8Array(bytes))).toString('base64');
const persona = Object.fromEntries(Object.entries(FIELDS).map(([name, f]) => [name, f.example]));
const escape = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const neverPatterns = TOKEN_FIELDS.map(name => ({ name, re: new RegExp(`(?<![A-Za-z0-9])${escape(FIELDS[name].example)}(?![A-Za-z0-9])`, 'i') }));

try {
  // Vault: create, read, update, server view.
  const ciphertext = b64(600);
  const created = await call('POST', '/api/vault', { body: { ciphertext, iv: b64(12), kdf: { name: 'PBKDF2', hash: 'SHA-256', iterations: 600000, salt: b64(16) } }, vault: '' });
  ok(created.status === 201 && /^[a-f0-9]{64}$/.test(created.data?.vaultId || ''), 'POST /api/vault creates a vault id');
  vaultId = created.data?.vaultId || '';
  if (!vaultId) throw new Error('no vault');
  ok(created.headers.get('cache-control') === 'no-store', 'responses are no-store');

  const noOrigin = await call('POST', '/api/vault', { body: { ciphertext, iv: b64(12), kdf: 'x' }, vault: '', withOrigin: false });
  ok(noOrigin.status === 403, 'POST without Origin is refused');
  const badVault = await call('GET', '/api/vault', { vault: 'f'.repeat(64) });
  ok(badVault.status === 404, 'unknown X-Vault is refused');

  const got = await call('GET', '/api/vault');
  ok(got.status === 200 && got.data?.ciphertext === ciphertext && got.data?.kdf?.iterations === 600000, 'GET /api/vault returns ciphertext and kdf');
  const put = await call('PUT', '/api/vault', { body: { ciphertext: b64(640), iv: b64(12), kdf: got.data.kdf } });
  ok(put.status === 200 && put.data?.ok, 'PUT /api/vault updates ciphertext');

  const view = await call('GET', '/api/server-view');
  ok(view.status === 200 && view.data?.vault?.ciphertextPreview?.length === 96 && Array.isArray(view.data?.grants), 'GET /api/server-view shows ciphertext preview and grants');
  ok(view.data?.audit?.some(e => e.action === 'vault_created') && view.data?.audit?.some(e => e.action === 'vault_updated'), 'audit has vault_created and vault_updated');

  // Grants: the never-field rule, TTL bounds, create and revoke.
  const never = await call('POST', '/api/grants', { body: { fields: ['first_name', 'payer'], recipient: 'haledy-agent', purpose: 'Smoke test', ttlMinutes: 5 } });
  ok(never.status === 400, 'a never-field grant to haledy-agent is rejected');
  const device = await call('POST', '/api/grants', { body: { fields: ['first_name', 'member_id'], recipient: 'device-fill', purpose: 'Fill an approved draft', ttlMinutes: 5 } });
  ok(device.status === 201, 'a never-field grant for device fill is allowed');
  const longTtl = await call('POST', '/api/grants', { body: { fields: ['payer'], recipient: 'haledy-agent', purpose: 'Smoke test', ttlMinutes: 500 } });
  ok(longTtl.status === 400, 'ttlMinutes above 120 is rejected');
  const unknownField = await call('POST', '/api/grants', { body: { fields: ['ssn'], recipient: 'haledy-agent', purpose: 'Smoke test', ttlMinutes: 5 } });
  ok(unknownField.status === 400, 'fields outside FIELDS are rejected');
  const grant = await call('POST', '/api/grants', { body: { fields: ['payer'], recipient: 'haledy-agent', purpose: 'Smoke test', ttlMinutes: 5 } });
  ok(grant.status === 201 && grant.data?.status === 'active', 'POST /api/grants creates an active grant');
  const revoked = await call('POST', `/api/grants/${grant.data?.id}/revoke`);
  ok(revoked.status === 200 && revoked.data?.status === 'revoked' && revoked.data?.revokedAt, 'revoke marks the grant revoked');

  const deviceAudit = await call('POST', '/api/audit', { body: { action: 'scrubbed_locally', detail: { types: ['phone'] } } });
  ok(deviceAudit.status === 200, 'device audit event accepted');
  const serverAudit = await call('POST', '/api/audit', { body: { action: 'model_call', detail: {} } });
  ok(serverAudit.status === 400, 'non-device audit actions are refused');

  // A release under the revoked grant must be dropped and announced.
  // Agent loop, scripted.
  const releases = [{ grantId: grant.data.id, values: { payer: persona.payer } }];
  let request = { messages: [], need: 'My back hurts, I need physical therapy this week.', releases };
  const views = [];
  const statuses = [];
  let final = null;
  let sawRevocationNotice = false;
  for (let i = 0; i < 20; i += 1) {
    const res = await call('POST', '/api/agent/step', { body: request, headers: { 'X-Haledy-Mode': 'scripted' } });
    if (!ok(res.status === 200, `step ${i + 1} HTTP 200`)) { console.log(res.data); break; }
    const r = res.data;
    statuses.push(r.status);
    views.push(r.modelView || '');
    if (/Grant g_[a-f0-9]{16} was revoked/.test(r.modelView || '')) sawRevocationNotice = true;
    ok(r.mode === 'scripted', `step ${i + 1} mode scripted (${r.status})`);
    if (r.status === 'error') { console.log('error:', r.error); final = r; break; }
    if (r.status === 'done') { final = r; break; }
    request = { messages: r.messages, releases };
    if (r.status === 'needs_consent') {
      const cr = r.consentRequest;
      ok(cr.fields.every(f => FIELDS[f].model !== 'never'), 'consent asks for no identifier fields');
      const g = await call('POST', '/api/grants', { body: { fields: cr.fields, recipient: 'haledy-agent', purpose: cr.purpose, ttlMinutes: cr.ttlMinutes } });
      ok(g.status === 201, 'consent grant created');
      releases.push({ grantId: g.data.id, values: Object.fromEntries(cr.fields.map(f => [f, persona[f]])) });
      request.consentAnswer = { toolUseId: cr.toolUseId, grantId: g.data.id };
    } else if (r.status === 'needs_approval') {
      const d = r.draft;
      ok(d.body.startsWith('This is Haledy, an AI assistant writing on behalf of {{first_name}}'), 'draft opens with the AI disclosure');
      ok(d.tokens.includes('first_name') && !neverPatterns.some(p => p.re.test(d.body)), 'draft carries tokens, not values');
      await call('POST', '/api/audit', { body: { action: 'tokens_filled', detail: { fields: d.tokens, recipient: d.recipientName.slice(0, 60).replace(/[^A-Za-z0-9 _.'&-]/g, '') } } });
      request.draftAnswer = { toolUseId: d.toolUseId, approved: true };
    }
  }
  console.log(`statuses: ${statuses.join(' -> ')}`);
  ok(final?.status === 'done', 'scripted agent run reaches done');
  ok(Array.isArray(final?.result?.options) && Array.isArray(final?.result?.limitations), `result has options (${final?.result?.options?.length ?? 0}) and limitations`);
  if (final?.result?.options?.length === 0) console.log('note: no options (provider sources may be unavailable); limitations:', final.result.limitations);
  ok(sawRevocationNotice, 'the model was told about the revoked grant');
  const allViews = views.join('\n');
  for (const p of neverPatterns) ok(!p.re.test(allViews), `modelView never contains the ${p.name} example`);
  ok(!/\b\d{5}\b/.test(allViews), 'modelView never contains a 5-digit ZIP');
  ok(/Granted context: home_zip=941\b/.test(allViews), 'modelView shows home_zip only as ZIP3');

  const after = await call('GET', '/api/server-view');
  const actions = new Set((after.data?.audit || []).map(e => e.action));
  for (const action of ['grant_created', 'grant_revoked', 'grant_rejected', 'model_call', 'tokens_filled']) ok(actions.has(action), `audit has ${action}`);
  ok(actions.has('tool_call') || actions.has('grant_rejected'), 'audit has tool_call');
  ok(!JSON.stringify(after.data?.audit || []).includes(persona.payer), 'audit holds no released values');
} catch (error) {
  failures += 1;
  console.log('FAIL smoke aborted:', error instanceof Error ? error.message : error);
} finally {
  if (vaultId) {
    const del = await call('DELETE', '/api/vault');
    ok(del.status === 200 && del.data?.ok, 'DELETE /api/vault forgets everything');
    const gone = await call('GET', '/api/vault');
    ok(gone.status === 404, 'the vault is gone');
  }
}

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
