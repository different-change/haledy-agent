// Haledy agent Worker: the encrypted vault (ciphertext only), consent grants, the audit
// trail, and the agent step. Same-origin JSON API; no bodies or values are ever logged.
import { FIELDS, scrub } from '../public/phi.js';
import { step } from './agent.ts';
import { AGENT_RECIPIENT, NEVER_FIELDS, audit, loadGrants, nowIso, randomHex, rowToGrant, type AgentEnv } from './tools.ts';
import type { AgentStepRequest, AuditEntry } from './types.ts';

const JSON_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
};

const SMALL_LIMIT = 16 * 1024;
const STEP_LIMIT = 64 * 1024;
const DEVICE_ACTIONS = new Set(['vault_unlocked', 'tokens_filled', 'scrubbed_locally', 'consent_denied']);

function json(body: unknown, status = 200, extra: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status, headers: { ...JSON_HEADERS, ...extra } });
}

class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

// Enforce the limit while reading, including requests without Content-Length.
async function readBody(request: Request, limit: number): Promise<Record<string, unknown>> {
  if (!request.headers.get('Content-Type')?.toLowerCase().startsWith('application/json')) throw new HttpError(415, 'Use a JSON request.');
  if (Number(request.headers.get('Content-Length')) > limit) throw new HttpError(413, 'Request too large.');
  const reader = request.body?.getReader();
  if (!reader) throw new HttpError(400, 'Please send a JSON body.');
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const result = await reader.read();
    if (result.done) break;
    length += result.value.byteLength;
    if (length > limit) { await reader.cancel(); throw new HttpError(413, 'Request too large.'); }
    chunks.push(result.value);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  let parsed: unknown;
  try { parsed = JSON.parse(new TextDecoder().decode(bytes)); } catch { throw new HttpError(400, 'Please check your request and try again.'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new HttpError(400, 'Please check your request and try again.');
  return parsed as Record<string, unknown>;
}

interface VaultRow { id: string; ciphertext: string; iv: string; kdf: string; created_at: string; updated_at: string }

function parseKdf(raw: string): unknown {
  try { return JSON.parse(raw); } catch { return raw; }
}

/** Ciphertext, IV and KDF parameters only: base64-ish strings and a small KDF description. */
function vaultFields(data: Record<string, unknown>): { ciphertext: string; iv: string; kdf: string } {
  const { ciphertext, iv, kdf } = data;
  if (typeof ciphertext !== 'string' || !ciphertext || ciphertext.length > 14_000 || !/^[A-Za-z0-9+/=_-]+$/.test(ciphertext)) throw new HttpError(400, 'The vault must be ciphertext (base64).');
  if (typeof iv !== 'string' || !iv || iv.length > 64 || !/^[A-Za-z0-9+/=_-]+$/.test(iv)) throw new HttpError(400, 'The vault needs its IV (base64).');
  if (kdf === undefined || kdf === null || (typeof kdf !== 'string' && typeof kdf !== 'object')) throw new HttpError(400, 'The vault needs its key-derivation parameters.');
  const kdfText = JSON.stringify(kdf);
  if (kdfText.length > 1024) throw new HttpError(400, 'Key-derivation parameters are too large.');
  return { ciphertext, iv, kdf: kdfText };
}

function auditRow(row: { id: number; actor: string; action: string; detail: string; created_at: string }): AuditEntry {
  let detail: Record<string, unknown> = {};
  try { const parsed = JSON.parse(row.detail); if (parsed && typeof parsed === 'object') detail = parsed; } catch { /* keep empty */ }
  return { id: row.id, actor: row.actor as AuditEntry['actor'], action: row.action, detail, createdAt: row.created_at };
}

const fieldList = (value: unknown): string[] => (Array.isArray(value) ? [...new Set(value.filter((f): f is string => typeof f === 'string' && f in FIELDS))] : []);

/** Device-side audit details: field names, short labels and category names only. */
function deviceDetail(action: string, detail: unknown): Record<string, unknown> {
  const d = (detail && typeof detail === 'object' && !Array.isArray(detail) ? detail : {}) as Record<string, unknown>;
  const label = (value: unknown) => (typeof value === 'string' && /^[A-Za-z0-9 _.'&-]{1,80}$/.test(value) && !scrub(value).findings.length ? value : undefined);
  if (action === 'tokens_filled') return { fields: fieldList(d.fields), ...(label(d.recipient) ? { recipient: label(d.recipient) } : {}) };
  if (action === 'scrubbed_locally') return { types: (Array.isArray(d.types) ? d.types : []).filter((t): t is string => typeof t === 'string' && /^[a-z0-9_-]{1,32}$/.test(t)).slice(0, 20) };
  if (action === 'consent_denied') return { fields: fieldList(d.fields) };
  if (action === 'vault_unlocked') return typeof d.method === 'string' && /^[a-z-]{1,20}$/.test(d.method) ? { method: d.method } : {};
  return {};
}

async function vaultFromHeader(request: Request, env: AgentEnv): Promise<VaultRow> {
  const id = request.headers.get('X-Vault') || '';
  if (!/^[a-f0-9]{64}$/.test(id)) throw new HttpError(401, 'Unlock your vault first.');
  const row = await env.DB.prepare('SELECT id, ciphertext, iv, kdf, created_at, updated_at FROM vaults WHERE id = ?').bind(id).first<VaultRow>();
  if (!row) throw new HttpError(404, 'This vault no longer exists.');
  return row;
}

async function route(request: Request, env: AgentEnv, url: URL): Promise<Response> {
  const path = url.pathname;
  const method = request.method;

  if (path === '/api/vault') {
    if (method === 'POST') {
      const fields = vaultFields(await readBody(request, SMALL_LIMIT));
      const id = randomHex(32);
      await env.DB.prepare('INSERT INTO vaults (id, ciphertext, iv, kdf) VALUES (?, ?, ?, ?)').bind(id, fields.ciphertext, fields.iv, fields.kdf).run();
      await audit(env, id, 'patient', 'vault_created', { bytes: fields.ciphertext.length });
      return json({ vaultId: id }, 201);
    }
    const vault = await vaultFromHeader(request, env);
    if (method === 'GET') return json({ ciphertext: vault.ciphertext, iv: vault.iv, kdf: parseKdf(vault.kdf), updatedAt: vault.updated_at });
    if (method === 'PUT') {
      const fields = vaultFields(await readBody(request, SMALL_LIMIT));
      const updatedAt = nowIso();
      await env.DB.prepare('UPDATE vaults SET ciphertext = ?, iv = ?, kdf = ?, updated_at = ? WHERE id = ?').bind(fields.ciphertext, fields.iv, fields.kdf, updatedAt, vault.id).run();
      await audit(env, vault.id, 'patient', 'vault_updated', { bytes: fields.ciphertext.length });
      return json({ ok: true, updatedAt });
    }
    if (method === 'DELETE') {
      await env.DB.batch([
        env.DB.prepare('DELETE FROM audit WHERE vault_id = ?').bind(vault.id),
        env.DB.prepare('DELETE FROM grants WHERE vault_id = ?').bind(vault.id),
        env.DB.prepare('DELETE FROM vaults WHERE id = ?').bind(vault.id),
      ]);
      return json({ ok: true });
    }
    return json({ error: 'Method not allowed.' }, 405, { Allow: 'GET, POST, PUT, DELETE' });
  }

  if (path === '/api/server-view') {
    if (method !== 'GET') return json({ error: 'Method not allowed.' }, 405, { Allow: 'GET' });
    const vault = await vaultFromHeader(request, env);
    const grants = await loadGrants(env, vault.id);
    const { results } = await env.DB.prepare('SELECT id, actor, action, detail, created_at FROM audit WHERE vault_id = ? ORDER BY id DESC LIMIT 500').bind(vault.id)
      .all<{ id: number; actor: string; action: string; detail: string; created_at: string }>();
    return json({
      vault: { bytes: vault.ciphertext.length, ciphertextPreview: vault.ciphertext.slice(0, 96), kdf: parseKdf(vault.kdf), createdAt: vault.created_at, updatedAt: vault.updated_at },
      grants,
      audit: (results || []).reverse().map(auditRow),
    });
  }

  if (path === '/api/audit') {
    const vault = await vaultFromHeader(request, env);
    if (method === 'GET') {
      const after = Math.max(0, Math.floor(Number(url.searchParams.get('after')) || 0));
      const { results } = await env.DB.prepare('SELECT id, actor, action, detail, created_at FROM audit WHERE vault_id = ? AND id > ? ORDER BY id LIMIT 200').bind(vault.id, after)
        .all<{ id: number; actor: string; action: string; detail: string; created_at: string }>();
      return json({ entries: (results || []).map(auditRow) });
    }
    if (method === 'POST') {
      const data = await readBody(request, SMALL_LIMIT);
      const action = typeof data.action === 'string' ? data.action : '';
      if (!DEVICE_ACTIONS.has(action)) return json({ error: 'Only device events can be logged here.' }, 400);
      await audit(env, vault.id, 'device', action, deviceDetail(action, data.detail));
      return json({ ok: true });
    }
    return json({ error: 'Method not allowed.' }, 405, { Allow: 'GET, POST' });
  }

  if (path === '/api/grants') {
    if (method !== 'POST') return json({ error: 'Method not allowed.' }, 405, { Allow: 'POST' });
    const vault = await vaultFromHeader(request, env);
    const data = await readBody(request, SMALL_LIMIT);
    const raw = Array.isArray(data.fields) ? data.fields : [];
    const fields = [...new Set(raw.filter((f): f is string => typeof f === 'string'))];
    const recipient = typeof data.recipient === 'string' ? data.recipient.trim() : '';
    const purpose = typeof data.purpose === 'string' ? data.purpose.replace(/\s+/g, ' ').trim() : '';
    const ttl = Number(data.ttlMinutes);
    if (!fields.length || fields.length !== raw.length || fields.length > FIELD_COUNT) return json({ error: 'Choose at least one field, each once.' }, 400);
    const unknown = fields.filter(f => !(f in FIELDS));
    if (unknown.length) return json({ error: 'Unknown fields in the grant.' }, 400);
    if (!/^[a-z0-9][a-z0-9 _.'&-]{0,63}$/i.test(recipient)) return json({ error: 'Name who the grant is for.' }, 400);
    if (!purpose || purpose.length > 200 || scrub(purpose).findings.length) return json({ error: 'Give a short purpose without personal details.' }, 400);
    if (!Number.isInteger(ttl) || ttl < 1 || ttl > 120) return json({ error: 'A grant lasts 1 to 120 minutes.' }, 400);
    const never = fields.filter(f => NEVER_FIELDS.includes(f));
    if (recipient === AGENT_RECIPIENT && never.length) {
      await audit(env, vault.id, 'server', 'grant_rejected', { fields: never, recipient, reason: 'identifier fields are never released to the agent' });
      return json({ error: `${never.join(', ')} ${never.length > 1 ? 'are identifiers' : 'is an identifier'}: the agent only ever sees a {{token}}.` }, 400);
    }
    const id = `g_${randomHex(8)}`;
    const createdAt = nowIso();
    const expiresAt = new Date(Date.now() + ttl * 60_000).toISOString();
    await env.DB.prepare('INSERT INTO grants (id, vault_id, fields, recipient, purpose, expires_at, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(id, vault.id, JSON.stringify(fields), recipient, purpose, expiresAt, 'active', createdAt).run();
    await audit(env, vault.id, 'patient', 'grant_created', { grantId: id, fields, recipient, ttlMinutes: ttl });
    return json({ id, fields, recipient, purpose, expiresAt, status: 'active', createdAt, revokedAt: null }, 201);
  }

  const revoke = /^\/api\/grants\/(g_[a-f0-9]{16})\/revoke$/.exec(path);
  if (revoke) {
    if (method !== 'POST') return json({ error: 'Method not allowed.' }, 405, { Allow: 'POST' });
    const vault = await vaultFromHeader(request, env);
    const grantId = revoke[1];
    const revokedAt = nowIso();
    const updated = await env.DB.prepare("UPDATE grants SET status = 'revoked', revoked_at = ? WHERE id = ? AND vault_id = ? AND status = 'active'").bind(revokedAt, grantId, vault.id).run();
    const row = await env.DB.prepare('SELECT id, fields, recipient, purpose, expires_at, status, created_at, revoked_at FROM grants WHERE id = ? AND vault_id = ?').bind(grantId, vault.id)
      .first<Parameters<typeof rowToGrant>[0]>();
    if (!row) return json({ error: 'No such grant.' }, 404);
    const grant = rowToGrant(row);
    if (updated.meta.changes) await audit(env, vault.id, 'patient', 'grant_revoked', { grantId, fields: grant.fields });
    return json(grant);
  }

  if (path === '/api/agent/step') {
    if (method !== 'POST') return json({ error: 'Method not allowed.' }, 405, { Allow: 'POST' });
    const vault = await vaultFromHeader(request, env);
    const data = await readBody(request, STEP_LIMIT);
    if (!Array.isArray(data.messages) || !Array.isArray(data.releases ?? [])) return json({ error: 'Please check your request and try again.' }, 400);
    const scripted = (request.headers.get('X-Haledy-Mode') || '').toLowerCase() === 'scripted';
    const result = await step({ ...(data as unknown as AgentStepRequest), releases: (data.releases as AgentStepRequest['releases']) || [] }, env, vault.id, { scripted });
    return json(result);
  }

  return json({ error: 'Not found.' }, 404);
}

const FIELD_COUNT = Object.keys(FIELDS).length;

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);
    if (!['GET', 'POST', 'PUT', 'DELETE'].includes(request.method)) return json({ error: 'Method not allowed.' }, 405);
    if (request.method !== 'GET') {
      const origin = request.headers.get('Origin');
      if (!origin || origin !== url.origin) return json({ error: 'Please use Haledy from its own page.' }, 403);
    }
    try {
      return await route(request, env as AgentEnv, url);
    } catch (error) {
      if (error instanceof HttpError) return json({ error: error.message }, error.status);
      // Never log a request body, vault id, grant value or model text.
      console.error(JSON.stringify({ event: 'api_error', path: url.pathname.replace(/g_[a-f0-9]{16}/, 'g_*'), method: request.method }));
      return json({ error: 'Something went wrong. Please try again shortly.' }, 503);
    }
  },
} satisfies ExportedHandler<Env>;
