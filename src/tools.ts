// Tool schemas the model sees, grant and audit helpers, and dispatch for the two
// server-side tools. Tool results sent to the model are built from whitelisted fields:
// provider ZIPs become ZIP3, phone numbers and URLs are dropped, free text is scrubbed.
import { FIELDS, scrub, zip3 } from '../public/phi.js';
import { checkNetwork, searchProviders } from './sources/index.ts';
import type { AgentEvent, Evidence, Grant, NetworkCheck, NetworkResult, Provider, SearchQuery, SearchResult } from './types.ts';

export type AgentEnv = Env & { ANTHROPIC_API_KEY?: string; MODEL?: string };
export type Actor = 'patient' | 'device' | 'agent' | 'server';

export const AGENT_RECIPIENT = 'haledy-agent';
export const FIELD_NAMES = Object.keys(FIELDS);
export const NEVER_FIELDS = FIELD_NAMES.filter(name => FIELDS[name as keyof typeof FIELDS].model === 'never');
export const MODEL_FIELDS = FIELD_NAMES.filter(name => FIELDS[name as keyof typeof FIELDS].model !== 'never');

export function nowIso(): string {
  return new Date().toISOString();
}

export function randomHex(bytes: number): string {
  return [...crypto.getRandomValues(new Uint8Array(bytes))].map(b => b.toString(16).padStart(2, '0')).join('');
}

/** "19:05 UTC" — a time without a calendar date, so it never trips the date guard. */
export function clockUtc(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return 'unknown time';
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')} UTC`;
}

// ---------- audit ----------

/** Write one audit row. `detail` must hold field names, hosts and counts, never values. */
export async function audit(env: AgentEnv, vaultId: string, actor: Actor, action: string, detail: Record<string, unknown> = {}): Promise<void> {
  await env.DB.prepare('INSERT INTO audit (vault_id, actor, action, detail) VALUES (?, ?, ?, ?)')
    .bind(vaultId, actor, action, JSON.stringify(detail)).run();
}

// ---------- grants ----------

interface GrantRow {
  id: string;
  fields: string;
  recipient: string;
  purpose: string;
  expires_at: string;
  status: string;
  created_at: string;
  revoked_at: string | null;
}

export function rowToGrant(row: GrantRow): Grant {
  let fields: string[] = [];
  try { const parsed = JSON.parse(row.fields); if (Array.isArray(parsed)) fields = parsed.filter(f => typeof f === 'string'); } catch { /* keep empty */ }
  const expired = row.status === 'active' && Date.parse(row.expires_at) <= Date.now();
  return {
    id: row.id,
    fields,
    recipient: row.recipient,
    purpose: row.purpose,
    expiresAt: row.expires_at,
    status: expired ? 'expired' : (row.status as Grant['status']),
    createdAt: row.created_at,
    revokedAt: row.revoked_at,
  };
}

/** All grants for a vault; active grants past their expiry are marked expired on read. */
export async function loadGrants(env: AgentEnv, vaultId: string): Promise<Grant[]> {
  await env.DB.prepare("UPDATE grants SET status = 'expired' WHERE vault_id = ? AND status = 'active' AND expires_at <= ?")
    .bind(vaultId, nowIso()).run();
  const { results } = await env.DB.prepare('SELECT id, fields, recipient, purpose, expires_at, status, created_at, revoked_at FROM grants WHERE vault_id = ? ORDER BY created_at')
    .bind(vaultId).all<GrantRow>();
  return (results || []).map(rowToGrant);
}

// ---------- tool schemas (CONTRACT.md "Tools exposed to the model") ----------

const evidenceSchema = {
  type: 'object',
  properties: { source: { type: 'string' }, claim: { type: 'string' }, asOf: { type: 'string' }, url: { type: 'string' } },
  required: ['source', 'claim'],
};

export const TOOLS = [
  {
    name: 'request_consent',
    description: 'Ask the patient for a scoped, time-boxed consent grant before using any vault field. The patient may approve a subset or deny. Ask only for the fields this task needs (minimum necessary). Identifier fields are never released to you; refer to them only as {{tokens}}. The recipient is always haledy-agent.',
    input_schema: {
      type: 'object',
      properties: {
        fields: { type: 'array', items: { type: 'string', enum: MODEL_FIELDS }, minItems: 1, description: 'Vault field names to release.' },
        purpose: { type: 'string', description: 'Short purpose shown on the consent card, e.g. "Find in-network physical therapy near you".' },
        ttl_minutes: { type: 'number', minimum: 1, maximum: 120, description: 'How long the grant lasts, in minutes.' },
        why: { type: 'string', description: 'One or two plain sentences: why each field is needed.' },
      },
      required: ['fields', 'purpose', 'ttl_minutes', 'why'],
    },
  },
  {
    name: 'search_providers',
    description: 'Search public provider directories (CMS NPPES NPI Registry, CMS Doctors and Clinicians) for physical therapy providers. Use zip3 (first three ZIP digits) only when the patient has granted home_zip; it must equal the granted value. Returns providers with NPI, name, kind, taxonomy, ZIP3 and the sources that listed them. Says nothing about availability or insurance networks.',
    input_schema: {
      type: 'object',
      properties: {
        specialty: { type: 'string', enum: ['physical_therapy'] },
        zip3: { type: 'string', pattern: '^\\d{3}$', description: 'First three digits of the patient ZIP, from the granted home_zip.' },
        city: { type: 'string', description: 'Pass "auto". The server sets the city from the granted ZIP3 or the pilot service area, so no place name reaches you.' },
        state: { type: 'string', description: 'Pass "CA".' },
        limit: { type: 'number', minimum: 1, maximum: 50 },
      },
      required: ['specialty', 'city', 'state'],
    },
  },
  {
    name: 'check_network',
    description: 'Reconcile in-network status for up to 20 NPIs against the payer directory for the granted payer and plan network. Requires active grants covering payer and plan_network. Returns per-NPI status (confirmed, listed, unverified, not_found) with evidence (source, claim, as-of date) and the limitations of each source.',
    input_schema: {
      type: 'object',
      properties: {
        npis: { type: 'array', items: { type: 'string', pattern: '^\\d{10}$' }, minItems: 1, maxItems: 20 },
        payer: { type: 'string' },
        plan_network: { type: 'string' },
      },
      required: ['npis', 'payer', 'plan_network'],
    },
  },
  {
    name: 'draft_outreach',
    description: 'Draft one outbound message to a clinic for the patient to approve. Identifiers must appear only as {{tokens}} ({{first_name}}, {{full_name}}, {{date_of_birth}}, {{phone}}, {{email}}, {{member_id}}, {{group_number}}); the device fills them after approval. The body must open with: "This is Haledy, an AI assistant writing on behalf of {{first_name}}". Haledy never sends it; the patient does.',
    input_schema: {
      type: 'object',
      properties: {
        npi: { type: 'string', pattern: '^\\d{10}$' },
        recipient_name: { type: 'string' },
        channel: { type: 'string', enum: ['email', 'web_form', 'phone_script'] },
        body: { type: 'string' },
      },
      required: ['npi', 'recipient_name', 'channel', 'body'],
    },
  },
  {
    name: 'present_options',
    description: 'Finish the run: present ranked options. Rank by network evidence strength (confirmed, listed, unverified, not_found), then ZIP3 proximity, then data freshness. The server attaches full addresses, phones and source evidence by NPI, so keep each option short. State limitations plainly; availability is unknown until a clinic answers.',
    input_schema: {
      type: 'object',
      properties: {
        summary: { type: 'string' },
        options: {
          type: 'array',
          maxItems: 10,
          items: {
            type: 'object',
            properties: {
              rank: { type: 'number' },
              npi: { type: 'string', pattern: '^\\d{10}$' },
              name: { type: 'string' },
              address: { type: 'string' },
              zip: { type: 'string' },
              phone: { type: 'string' },
              network: { type: 'string', enum: ['confirmed', 'listed', 'unverified', 'not_found'] },
              evidence: { type: 'array', items: evidenceSchema },
              why: { type: 'string', description: 'One sentence: why this rank.' },
            },
            required: ['rank', 'npi', 'name', 'network', 'why'],
          },
        },
        limitations: { type: 'array', items: { type: 'string' } },
        nextSteps: { type: 'array', items: { type: 'string' } },
      },
      required: ['summary', 'options', 'limitations', 'nextSteps'],
    },
  },
];

export const SERVER_TOOLS = new Set(['search_providers', 'check_network']);

// ---------- model-safe projection of source data ----------

/** Scrub provider free text, keeping 10-digit NPIs (public provider identifiers) intact. */
export function safeText(text: unknown, max = 200): string {
  const raw = String(text ?? '').slice(0, max * 2);
  const npis: string[] = [];
  // Taxonomy codes such as (225100000X) are public specialty codes, not identifiers.
  const days: string[] = [];
  // ISO days in source text are record dates (when a directory last updated), not patient dates.
  const masked = raw.replace(/\s*\(\d{3}[0-9A-Z]{6}X\)/g, '')
    .replace(/\b\d{10}\b/g, m => { npis.push(m); return `npiref${String.fromCharCode(97 + ((npis.length - 1) % 26))}`; })
    .replace(/\b\d{4}-\d{2}-\d{2}\b/g, m => { days.push(m); return `dayref${String.fromCharCode(97 + ((days.length - 1) % 26))}`; });
  let out = scrub(masked).text;
  out = out.replace(/npiref([a-z])/g, (_m, c: string) => npis[c.charCodeAt(0) - 97] ?? '')
    .replace(/dayref([a-z])/g, (_m, c: string) => days[c.charCodeAt(0) - 97] ?? '');
  return out.slice(0, max);
}

/** ISO day only (YYYY-MM-DD); data-freshness dates are about sources, not the patient. */
export function dayOnly(value: unknown): string {
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(String(value ?? ''));
  return m ? m[1] : '';
}

export interface CompactProvider { npi: string; name: string; kind: string; taxonomy: string; zip3: string; listedBy: string[] }
export interface CompactEvidence { source: string; claim: string; asOf: string }
export interface CompactCheck { npi: string; status: NetworkCheck['status']; evidence: CompactEvidence[] }

function compactEvidence(items: Evidence[] | undefined): CompactEvidence[] {
  return (items || []).slice(0, 3).map(e => ({ source: safeText(e.source, 80), claim: safeText(e.claim, 240), asOf: dayOnly(e.asOf) }));
}

export function compactProvider(p: Provider): CompactProvider {
  // No street, city or full ZIP: the model ranks by ZIP3; the server attaches addresses for the patient.
  return {
    npi: /^\d{10}$/.test(p.npi) ? p.npi : '',
    name: safeText(p.name, 120),
    kind: p.kind === 'individual' ? 'individual' : 'organization',
    taxonomy: safeText(p.taxonomy, 80),
    zip3: zip3(p.zip) || '',
    listedBy: [...new Set((p.evidence || []).map(e => safeText(e.source, 60)))].slice(0, 4),
  };
}

function hostsOf(urls: (string | undefined)[]): string[] {
  const hosts = new Set<string>();
  for (const u of urls) { try { if (u) hosts.add(new URL(u).hostname); } catch { /* skip */ } }
  return [...hosts];
}

// Public provider data from the latest search and check, per vault, so present_options can
// attach full addresses and source URLs. Holds no patient data; best effort, per isolate.
const sourceCache = new Map<string, { at: number; providers: Map<string, Provider>; checks: Map<string, NetworkCheck> }>();

export function cachedSources(vaultId: string) {
  const entry = sourceCache.get(vaultId);
  if (!entry || Date.now() - entry.at > 2 * 60 * 60 * 1000) return null;
  return entry;
}

function cacheFor(vaultId: string) {
  let entry = cachedSources(vaultId);
  if (!entry) {
    if (sourceCache.size > 200) sourceCache.delete(sourceCache.keys().next().value as string);
    entry = { at: Date.now(), providers: new Map(), checks: new Map() };
    sourceCache.set(vaultId, entry);
  }
  entry.at = Date.now();
  return entry;
}

export function rememberProviders(vaultId: string, providers: Provider[]) {
  const entry = cacheFor(vaultId);
  for (const p of providers) if (p?.npi) entry.providers.set(p.npi, p);
}

// ---------- dispatch ----------

export interface ToolContext {
  env: AgentEnv;
  vaultId: string;
  /** Model-form values released under active haledy-agent grants (home_zip is already ZIP3). */
  values: Record<string, string>;
  events: AgentEvent[];
}

export interface ToolOutcome { content: string; isError: boolean }

async function reject(ctx: ToolContext, tool: string, fields: string[], reason: string, message: string): Promise<ToolOutcome> {
  await audit(ctx.env, ctx.vaultId, 'server', 'grant_rejected', { tool, fields, reason });
  ctx.events.push({ at: nowIso(), kind: 'grant', title: `Blocked ${tool}: no active grant`, detail: reason, fields });
  return { content: message, isError: true };
}

function str(value: unknown, max: number): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

export async function runServerTool(name: string, input: Record<string, unknown>, ctx: ToolContext): Promise<ToolOutcome> {
  if (name === 'search_providers') return runSearch(input, ctx);
  if (name === 'check_network') return runCheck(input, ctx);
  return { content: `Unknown tool ${name}.`, isError: true };
}

// The model never sees a place name (phi.js treats city names as identifiers), so the
// server picks the public query's city from the granted ZIP3, or the pilot service area.
export const PILOT_CITY = 'San Francisco';
export const PILOT_STATE = 'CA';
const ZIP3_CITY: Record<string, string> = { '941': 'San Francisco', '946': 'Oakland', '947': 'Berkeley', '943': 'Palo Alto', '951': 'San Jose' };

/** The public query area for a granted ZIP3: its city, or the pilot area without a ZIP filter. */
export function areaFor(granted?: string): { city: string; zip3?: string } {
  return granted && ZIP3_CITY[granted] ? { city: ZIP3_CITY[granted], zip3: granted } : { city: PILOT_CITY };
}

async function runSearch(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolOutcome> {
  const fields: string[] = [];
  const query: SearchQuery = {
    specialty: 'physical_therapy',
    city: PILOT_CITY,
    state: PILOT_STATE,
    limit: Math.min(Math.max(Math.round(Number(input.limit) || 20), 1), 50),
  };
  let areaNote = 'Searched the pilot service area.';
  if (input.zip3 !== undefined && input.zip3 !== null && input.zip3 !== '') {
    const requested = String(input.zip3);
    if (!ctx.values.home_zip) return reject(ctx, 'search_providers', ['home_zip'], 'zip3 used without an active grant covering home_zip', 'Rejected: zip3 requires an active patient grant covering home_zip. Search by city and state only, or request consent for home_zip.');
    if (ctx.values.home_zip !== requested) return reject(ctx, 'search_providers', ['home_zip'], 'zip3 does not match the granted value', 'Rejected: zip3 must equal the ZIP3 the patient granted.');
    fields.push('home_zip');
    if (ZIP3_CITY[requested]) {
      query.zip3 = requested;
      query.city = ZIP3_CITY[requested];
      areaNote = `Searched ZIP3 ${requested}.`;
    } else {
      areaNote = `ZIP3 ${requested} is outside the pilot service area; searched the pilot area instead.`;
    }
  }
  let result: SearchResult;
  try {
    result = await searchProviders(query);
  } catch {
    await audit(ctx.env, ctx.vaultId, 'agent', 'tool_call', { tool: 'search_providers', host: [], fields, results: 0, ok: false });
    ctx.events.push({ at: nowIso(), kind: 'tool', title: 'Provider search failed', detail: 'The public directory search did not answer. Continuing without results.', fields });
    return { content: 'Provider search failed: the public directories did not answer. Continue with what you have and say so plainly.', isError: true };
  }
  const providers = (result.providers || []).filter(p => p && /^\d{10}$/.test(p.npi));
  rememberProviders(ctx.vaultId, providers);
  const top = providers.slice(0, 20).map(compactProvider);
  const sources = (result.sources || []).map(s => ({ name: safeText(s.name, 80), ok: !!s.ok, count: Number(s.count) || 0, ...(s.note ? { note: safeText(s.note, 160) } : {}) }));
  const host = hostsOf((result.sources || []).map(s => s.url));
  await audit(ctx.env, ctx.vaultId, 'agent', 'tool_call', { tool: 'search_providers', host, fields, results: providers.length });
  for (const s of result.sources || []) {
    // Events go to the patient's own browser, not the model: source notes stay as written.
    ctx.events.push({ at: nowIso(), kind: 'tool', title: `${s.ok ? 'Searched' : 'Could not search'} ${String(s.name).slice(0, 80)}`, detail: `${Number(s.count) || 0} results${s.note ? ` · ${String(s.note).slice(0, 240)}` : ''}`, fields, source: { name: String(s.name).slice(0, 80), url: s.url } });
  }
  if (!(result.sources || []).length) ctx.events.push({ at: nowIso(), kind: 'tool', title: 'Searched provider directories', detail: `${providers.length} results`, fields });
  return { content: JSON.stringify({ area: areaNote, total: providers.length, shown: top.length, providers: top, sources }), isError: false };
}

async function runCheck(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolOutcome> {
  const missing = ['payer', 'plan_network'].filter(f => !ctx.values[f]);
  if (missing.length) return reject(ctx, 'check_network', missing, `no active grant covering ${missing.join(', ')}`, `Rejected: checking networks needs active patient grants covering ${missing.join(' and ')}. Rank without network verification and say so, or request consent.`);
  const npis = [...new Set((Array.isArray(input.npis) ? input.npis : []).map(String).filter(n => /^\d{10}$/.test(n)))].slice(0, 20);
  if (!npis.length) return { content: 'Rejected: provide 1 to 20 ten-digit NPIs from the search results.', isError: true };
  const fields = ['payer', 'plan_network'];
  let result: NetworkResult;
  try {
    // The granted values are authoritative; the model's spelling of them is not used.
    result = await checkNetwork({ npis, payer: ctx.values.payer, planNetwork: ctx.values.plan_network });
  } catch {
    await audit(ctx.env, ctx.vaultId, 'agent', 'tool_call', { tool: 'check_network', host: [], fields, results: 0, ok: false });
    ctx.events.push({ at: nowIso(), kind: 'tool', title: 'Network check failed', detail: 'The payer directory did not answer. Network status stays unverified.', fields });
    return { content: 'Network check failed: no directory answered. Treat every provider as unverified and say so plainly.', isError: true };
  }
  const entry = cacheFor(ctx.vaultId);
  for (const c of result.checks || []) if (c?.npi) entry.checks.set(c.npi, c);
  const checks: CompactCheck[] = (result.checks || []).filter(c => /^\d{10}$/.test(c.npi)).slice(0, 20)
    .map(c => ({ npi: c.npi, status: c.status, evidence: compactEvidence(c.evidence) }));
  const sources = (result.sources || []).map(s => ({ name: safeText(s.name, 80), ok: !!s.ok, ...(s.note ? { note: safeText(s.note, 160) } : {}) }));
  const limitations = (result.limitations || []).slice(0, 6).map(l => safeText(l, 240));
  const host = hostsOf((result.sources || []).map(s => s.url));
  await audit(ctx.env, ctx.vaultId, 'agent', 'tool_call', { tool: 'check_network', host, fields, results: checks.length });
  const counts = checks.reduce<Record<string, number>>((acc, c) => { acc[c.status] = (acc[c.status] || 0) + 1; return acc; }, {});
  for (const s of result.sources || []) {
    ctx.events.push({ at: nowIso(), kind: 'tool', title: `${s.ok ? 'Checked' : 'Could not check'} ${String(s.name).slice(0, 80)}`, detail: s.note ? String(s.note).slice(0, 240) : undefined, fields, source: { name: String(s.name).slice(0, 80), url: s.url } });
  }
  ctx.events.push({ at: nowIso(), kind: 'tool', title: 'Network reconciliation', detail: Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(' · ') || 'no results', fields });
  return { content: JSON.stringify({ checks, limitations, sources }), isError: false };
}
