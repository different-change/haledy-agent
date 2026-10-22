// One agent step: validate grants and releases, build the step's de-identified user content,
// guard it with scrub(), make one model call (or one scripted planner turn), run any
// server-side tool, and tell the browser what to do next. Stateless between steps.
import { FIELDS, modelValue, scrub, tokensIn } from '../public/phi.js';
import type { AgentEvent, AgentStepRequest, AgentStepResponse, ConsentRequest, Evidence, Grant, NetworkStatus, OutreachDraft, PresentOptions, Provider, RankedOption } from './types.ts';
import {
  AGENT_RECIPIENT, MODEL_FIELDS, PILOT_STATE, SERVER_TOOLS, TOOLS, areaFor, audit, cachedSources, clockUtc, loadGrants, nowIso,
  rememberProviders, runServerTool, safeText, type AgentEnv, type CompactCheck, type CompactProvider, type ToolContext,
} from './tools.ts';
import { searchProviders } from './sources/index.ts';

type Block = { type: string; [key: string]: unknown };
type Message = { role: 'user' | 'assistant'; content: Block[] };

const MAX_ASSISTANT_TURNS = 16;
const MAX_TOKENS = 4000;
const DISCLOSURE = 'This is Haledy, an AI assistant writing on behalf of {{first_name}}';
const STATUS_ORDER: Record<NetworkStatus, number> = { confirmed: 0, listed: 1, unverified: 2, not_found: 3 };
const AVAILABILITY_NOTE = 'Availability is unknown until a clinic answers.';
const NUDGE = 'Continue with the next tool call. Finish with present_options.';

export const SYSTEM_PROMPT = `You are Haledy, a patient-side access agent acting for one patient. You help the patient get care booked; you are not a clinician. Never give clinical advice, never diagnose, and never claim a provider heals fastest or is clinically better. You optimize access: network status, proximity, data freshness.

Privacy rules:
- You see only de-identified context. Never ask for, guess or invent identifiers (names, dates of birth, phone numbers, emails, member or group numbers, full ZIP codes). Refer to them only as tokens: {{first_name}}, {{full_name}}, {{date_of_birth}}, {{phone}}, {{email}}, {{member_id}}, {{group_number}}. The patient's device fills tokens after the patient approves.
- Before using any vault field, call request_consent. Ask only for what this task needs (minimum necessary): usually payer, plan_network, home_zip (you receive only its first three digits) and care_need, for about 30 minutes.
- Use only values shown as "Granted context". If a grant is denied, revoked or expired, stop using those fields at once and continue without them.

Workflow, one tool per turn:
1. request_consent.
2. search_providers: specialty physical_therapy, city "auto", state "CA", and zip3 only when home_zip is granted. The server picks the place; you never need a place name.
3. check_network on the best candidates (up to 8 NPIs) with the granted payer and plan_network.
4. draft_outreach once, to the top option. The body opens with "${DISCLOSURE}", asks for the earliest appointment and whether they take the patient's plan, uses tokens for every identifier, and stays under 120 words with no dates, phone numbers, emails or links.
5. present_options, then stop.

Honesty:
- Say plainly what each source can and cannot confirm. The NPI Registry confirms that a provider exists and where it practices, not network status or availability. A payer directory listing is the payer's own claim and may be stale. When no open directory covers the plan, network status is unverified.
- Availability is unknown until a clinic answers. Never claim an appointment slot exists.
- Rank by network evidence strength (confirmed, then listed, then unverified, then not_found), then ZIP3 match with the patient, then data freshness.
- Between tool calls, write one or two short plain sentences to the patient.`;

// ---------- small helpers ----------

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map(b => (b && typeof b === 'object' && (b as Block).type === 'text' ? String((b as Block).text ?? '') : '')).join('\n');
  return '';
}

function toolResult(toolUseId: unknown, content: string, isError: boolean): Block {
  return { type: 'tool_result', tool_use_id: String(toolUseId), content, ...(isError ? { is_error: true } : {}) };
}

function toolUses(message: Message | undefined): Block[] {
  return message && message.role === 'assistant' ? message.content.filter(b => b.type === 'tool_use') : [];
}

function parseMessages(raw: unknown): Message[] | null {
  if (!Array.isArray(raw) || raw.length > 80) return null;
  const out: Message[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') return null;
    const { role } = item as { role?: unknown };
    let { content } = item as { content?: unknown };
    if (role !== 'user' && role !== 'assistant') return null;
    if (typeof content === 'string') content = [{ type: 'text', text: content }];
    if (!Array.isArray(content) || !content.length) return null;
    if (content.some(b => !b || typeof b !== 'object' || typeof (b as Block).type !== 'string')) return null;
    // A user turn may carry only text and tool results: no images, documents or citations.
    if (role === 'user' && content.some(b => !['text', 'tool_result'].includes((b as Block).type) || (b as Block).citations)) return null;
    out.push({ role, content: content as Block[] });
  }
  if (out.length && out[0].role !== 'user') return null;
  return out;
}

/** Tool names by tool_use id, across the transcript. */
function toolNames(messages: Message[]): Map<string, { name: string; input: Record<string, unknown> }> {
  const names = new Map<string, { name: string; input: Record<string, unknown> }>();
  for (const m of messages) for (const b of toolUses(m)) names.set(String(b.id), { name: String(b.name), input: (b.input as Record<string, unknown>) || {} });
  return names;
}

/** The exact text of a user turn, as the "What the AI saw" panel shows it. */
function renderUserContent(message: Message, names: Map<string, { name: string }>): string {
  return message.content.map(b => {
    if (b.type === 'text') return String(b.text ?? '');
    if (b.type === 'tool_result') {
      const name = names.get(String(b.tool_use_id))?.name ?? 'tool';
      return `[${name} result${b.is_error ? ', error' : ''}]\n${textOf(b.content)}`;
    }
    return `[${b.type}]`;
  }).join('\n\n');
}

/** Provider NPIs (public) and source freshness dates are allowed inside server tool results. */
function maskToolResult(text: string): string {
  return text.replace(/\b\d{10}\b/g, 'NPI').replace(/\b20\d{2}-\d{2}-\d{2}\b/g, 'DATE');
}

function guardFindings(messages: Message[], strictTail: Message): string[] {
  const types = new Set<string>();
  const check = (text: string) => { for (const f of scrub(text).findings) types.add(f.type); };
  for (const m of messages) {
    if (m.role !== 'user') continue;
    for (const b of m.content) {
      if (b.type === 'text') check(String(b.text ?? ''));
      else if (b.type === 'tool_result') check(m === strictTail && !isServerToolResult(b, messages) ? textOf(b.content) : maskToolResult(textOf(b.content)));
    }
  }
  return [...types];
}

function isServerToolResult(block: Block, messages: Message[]): boolean {
  const entry = toolNames(messages).get(String(block.tool_use_id));
  return !!entry && SERVER_TOOLS.has(entry.name);
}

function manifest(): string {
  const lines = Object.entries(FIELDS).map(([name, f]) => {
    const access = f.model === 'never' ? 'never released; use {{' + name + '}}' : f.model === 'generalized' ? 'with consent, first three digits only' : 'with consent';
    return `- ${name}: ${access}`;
  });
  return `Context manifest (field names and model access only; values stay in the patient's encrypted vault):\n${lines.join('\n')}`;
}

// ---------- releases and grants ----------

interface Released { values: Record<string, string>; notices: string[] }

async function validateReleases(req: AgentStepRequest, grants: Grant[], env: AgentEnv, vaultId: string, events: AgentEvent[], transcript: string): Promise<Released> {
  const values: Record<string, string> = {};
  const notices: string[] = [];
  const byId = new Map(grants.map(g => [g.id, g]));
  const inactiveReleased = new Set<string>();
  const rejected: { grantId: string; fields: string[]; reason: string }[] = [];
  for (const rel of (Array.isArray(req.releases) ? req.releases : []).slice(0, 20)) {
    if (!rel || typeof rel !== 'object' || typeof rel.grantId !== 'string' || !rel.values || typeof rel.values !== 'object') continue;
    const relFields = Object.keys(rel.values).filter(f => typeof rel.values[f] === 'string').slice(0, 20);
    const grantId = /^g_[a-f0-9]{16}$/.test(rel.grantId) ? rel.grantId : 'invalid';
    const g = byId.get(rel.grantId);
    if (!g) { rejected.push({ grantId, fields: relFields.filter(f => f in FIELDS), reason: 'unknown grant' }); continue; }
    if (g.recipient !== AGENT_RECIPIENT) { rejected.push({ grantId, fields: relFields.filter(f => f in FIELDS), reason: 'grant is for the device, not the agent' }); continue; }
    if (g.status !== 'active') { inactiveReleased.add(g.id); rejected.push({ grantId, fields: g.fields, reason: g.status }); continue; }
    for (const field of relFields) {
      if (!g.fields.includes(field)) { rejected.push({ grantId, fields: field in FIELDS ? [field] : [], reason: 'field not in grant' }); continue; }
      const value = modelValue(field, rel.values[field]);
      if (value == null) continue;
      values[field] = String(value).replace(/\s+/g, ' ').trim().slice(0, 200);
    }
  }
  for (const r of rejected) await audit(env, vaultId, 'server', 'grant_rejected', r);
  if (rejected.length) events.push({ at: nowIso(), kind: 'grant', title: 'Dropped values without an active grant', detail: [...new Set(rejected.map(r => r.reason))].join(' · '), fields: [...new Set(rejected.flatMap(r => r.fields))] });

  for (const g of grants) {
    if (g.recipient !== AGENT_RECIPIENT || g.status === 'active') continue;
    if (!inactiveReleased.has(g.id) && !transcript.includes(g.id)) continue;
    if (transcript.includes(`Grant ${g.id} was ${g.status}`)) continue; // the model was told already
    const fields = g.fields.filter(f => !(f in values));
    const when = g.status === 'revoked' ? `revoked by the patient at ${clockUtc(g.revokedAt || nowIso())}` : `expired at ${clockUtc(g.expiresAt)}`;
    notices.push(`Grant ${g.id} was ${when}; do not use ${fields.join(', ') || 'its fields'} from it.`);
    events.push({ at: nowIso(), kind: 'grant', title: `Grant ${g.status}: the agent stops using ${fields.join(', ') || 'those fields'}`, fields });
  }
  return { values, notices };
}

function consentResult(answer: NonNullable<AgentStepRequest['consentAnswer']>, use: Block, grants: Grant[]): string {
  if (answer.denied || !answer.grantId) return 'Patient denied this consent request. Do not use those fields; continue without them and say what that limits.';
  const g = grants.find(x => x.id === answer.grantId);
  if (!g || g.status !== 'active' || g.recipient !== AGENT_RECIPIENT) return 'No active grant came back for this request; treat it as denied and continue without those fields.';
  const requested = Array.isArray((use.input as Record<string, unknown>)?.fields) ? ((use.input as Record<string, unknown>).fields as unknown[]).map(String) : [];
  const notGranted = requested.filter(f => !g.fields.includes(f));
  return `Patient approved grant ${g.id} for fields [${g.fields.join(', ')}] until ${clockUtc(g.expiresAt)}.${notGranted.length ? ` Not approved: [${notGranted.join(', ')}]; do not use them.` : ''}`;
}

// ---------- model call ----------

class ModelError extends Error {}

async function callModel(env: AgentEnv, messages: Message[]): Promise<{ content: Block[]; stopReason: string; model: string }> {
  const model = env.MODEL || 'claude-opus-5-5';
  const send = (withFallbacks: boolean) => fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': env.ANTHROPIC_API_KEY as string,
      'anthropic-version': '2026-10-21',
      ...(withFallbacks ? { 'anthropic-beta': 'server-side-fallback-2026-07-01' } : {}),
    },
    body: JSON.stringify({
      model,
      max_tokens: MAX_TOKENS,
      system: SYSTEM_PROMPT,
      tools: TOOLS,
      tool_choice: { type: 'auto', disable_parallel_tool_use: true },
      output_config: { effort: 'low' },
      cache_control: { type: 'ephemeral' },
      ...(withFallbacks ? { fallbacks: 'default' } : {}),
      messages,
    }),
    signal: AbortSignal.timeout(90_000),
  });
  let res: Response;
  try {
    res = await send(true);
    if (res.status === 400) {
      const text = await res.clone().text();
      if (/fallback/i.test(text)) res = await send(false);
    }
  } catch {
    throw new ModelError('The model did not answer in time. Try again, or use scripted mode.');
  }
  if (!res.ok) {
    if (res.status === 401 || res.status === 403) throw new ModelError('The model API key was rejected.');
    if (res.status === 429) throw new ModelError('The model is rate limited. Try again in a minute, or use scripted mode.');
    if (res.status >= 500) throw new ModelError('The model service is unavailable right now. Try again, or use scripted mode.');
    throw new ModelError(`The model request failed (status ${res.status}).`);
  }
  const data = await res.json() as { content?: Block[]; stop_reason?: string; model?: string };
  return { content: Array.isArray(data.content) ? data.content : [], stopReason: String(data.stop_reason || ''), model: String(data.model || model) };
}

// ---------- reading the transcript's own tool results ----------

interface Seen {
  providers: CompactProvider[];
  checks: Map<string, CompactCheck>;
  searchInput?: Record<string, unknown>;
  searchFailed: boolean;
  checkFailed: boolean;
  limitations: string[];
  used: Set<string>;
  consentDenied: boolean;
}

function readTranscript(messages: Message[]): Seen {
  const names = toolNames(messages);
  const seen: Seen = { providers: [], checks: new Map(), searchFailed: false, checkFailed: false, limitations: [], used: new Set(), consentDenied: false };
  for (const { name } of names.values()) seen.used.add(name);
  for (const m of messages) {
    if (m.role !== 'user') continue;
    for (const b of m.content) {
      if (b.type !== 'tool_result') continue;
      const entry = names.get(String(b.tool_use_id));
      if (!entry) continue;
      const text = textOf(b.content);
      if (entry.name === 'request_consent' && /denied/i.test(text)) seen.consentDenied = true;
      if (entry.name === 'search_providers') {
        if (b.is_error) { seen.searchFailed = true; continue; }
        try { const parsed = JSON.parse(text); seen.providers = Array.isArray(parsed.providers) ? parsed.providers : []; seen.searchInput = entry.input; seen.searchFailed = false; } catch { /* not ours */ }
      }
      if (entry.name === 'check_network') {
        if (b.is_error) { seen.checkFailed = true; continue; }
        try {
          const parsed = JSON.parse(text);
          for (const c of Array.isArray(parsed.checks) ? parsed.checks : []) if (c && /^\d{10}$/.test(c.npi)) seen.checks.set(c.npi, c);
          seen.limitations = Array.isArray(parsed.limitations) ? parsed.limitations.map(String) : [];
          seen.checkFailed = false;
        } catch { /* not ours */ }
      }
    }
  }
  return seen;
}

function freshness(check?: CompactCheck): string {
  return (check?.evidence || []).map(e => e.asOf || '').sort().pop() || '';
}

// Providers that were never checked rank after every checked one: a "not found in the
// directory" answer is still evidence, and unchecked rows must not crowd the checked out.
const UNCHECKED = Object.keys(STATUS_ORDER).length;

function rankProviders(seen: Seen, patientZip3?: string) {
  return seen.providers.map((p, index) => ({ p, index, c: seen.checks.get(p.npi) }))
    .sort((a, b) =>
      (a.c ? STATUS_ORDER[a.c.status] : UNCHECKED) - (b.c ? STATUS_ORDER[b.c.status] : UNCHECKED)
      || Number(!!patientZip3 && b.p.zip3 === patientZip3) - Number(!!patientZip3 && a.p.zip3 === patientZip3)
      || freshness(b.c).localeCompare(freshness(a.c))
      || a.index - b.index);
}

// ---------- scripted planner (same tool_use sequence, no model) ----------

function scriptedTurn(messages: Message[], values: Record<string, string>): Block[] {
  const seen = readTranscript(messages);
  const n = messages.reduce((count, m) => count + toolUses(m).length, 0) + 1;
  const id = `toolu_scripted_${String(n).padStart(2, '0')}`;
  const turn = (text: string, name: string, input: Record<string, unknown>): Block[] => [{ type: 'text', text }, { type: 'tool_use', id, name, input }];

  if (!seen.used.has('request_consent')) {
    return turn('To find in-network physical therapy near you, I need your insurer and plan, your ZIP area (first three digits only) and the care you want. I will not see your name, birth date, member ID or contact details.',
      'request_consent', { fields: ['payer', 'plan_network', 'home_zip', 'care_need'], purpose: 'Find in-network physical therapy near you', ttl_minutes: 30, why: 'Insurer and plan to check networks; the first three ZIP digits to search nearby; the care you want to search the right specialty.' });
  }
  if (!seen.used.has('search_providers')) {
    const input: Record<string, unknown> = { specialty: 'physical_therapy', city: 'auto', state: PILOT_STATE, limit: 20 };
    if (values.home_zip) input.zip3 = values.home_zip;
    return turn(`Searching the public NPI Registry and CMS data for physical therapy ${values.home_zip ? `in ZIP area ${values.home_zip}` : 'in the pilot area'}.`, 'search_providers', input);
  }
  const ranked = rankProviders(seen, values.home_zip);
  if (!seen.used.has('check_network') && values.payer && values.plan_network && ranked.length) {
    return turn('Checking network status for the top 8 providers against the payer directory for your plan.', 'check_network',
      { npis: ranked.slice(0, 8).map(r => r.p.npi), payer: values.payer, plan_network: values.plan_network });
  }
  if (!seen.used.has('draft_outreach') && ranked.length) {
    const top = ranked[0].p;
    return turn('I drafted a message to the top option. Identifiers stay as tokens until you approve it on your device.', 'draft_outreach', {
      npi: top.npi, recipient_name: top.name, channel: 'email',
      body: `${DISCLOSURE}. {{first_name}} is looking for {{care_need}} and would like your earliest available appointment this week. Could you confirm whether you are in network for {{payer}} ({{plan_network}})? Their member ID is {{member_id}}. Please reply to {{email}} or call {{phone}}. Thank you.`,
    });
  }
  const shown = ranked.slice(0, 8);
  const counts = shown.reduce<Record<string, number>>((acc, r) => { const s = r.c?.status ?? 'unverified'; acc[s] = (acc[s] || 0) + 1; return acc; }, {});
  const limitations = [
    'The NPI Registry confirms that a provider exists and where it practices; it says nothing about networks or availability.',
    ...seen.limitations,
    ...(!values.payer || !values.plan_network ? ['Network status was not checked because your insurer and plan were not shared (or the grant ended).'] : []),
    ...(seen.checkFailed ? ['The payer directory did not answer, so network status is unverified.'] : []),
    ...(seen.searchFailed ? ['The public provider directories did not answer, so there are no options yet.'] : []),
    AVAILABILITY_NOTE,
  ];
  const summary = shown.length
    ? `I found ${seen.providers.length} physical therapy providers${values.home_zip ? ` in ZIP area ${values.home_zip}` : ' in the pilot area'}. Of the top ${shown.length}: ${Object.entries(counts).map(([k, v]) => `${v} ${k.replace('_', ' ')}`).join(', ')}. ${AVAILABILITY_NOTE}`
    : `I could not find providers to show yet. ${AVAILABILITY_NOTE}`;
  return turn('Here are your options, ranked by network evidence, then ZIP area, then how fresh the data is.', 'present_options', {
    summary,
    options: shown.map((r, i) => ({
      rank: i + 1, npi: r.p.npi, name: r.p.name, network: r.c?.status ?? 'unverified',
      why: `${r.c ? `Network: ${r.c.status.replace('_', ' ')}` : 'Network not checked'}; ${values.home_zip && r.p.zip3 === values.home_zip ? 'in your ZIP area' : 'outside your ZIP area or unknown'}${freshness(r.c) ? `; data as of ${freshness(r.c)}` : ''}.`,
    })),
    limitations,
    nextSteps: shown.length ? ['Approve and send the drafted message, or call the top option.', 'Before booking, ask the clinic to confirm they take your plan.'] : ['Try again in a few minutes.'],
  });
}

// ---------- present_options: validate and attach public provider data ----------

function isStatus(value: unknown): value is NetworkStatus {
  return typeof value === 'string' && value in STATUS_ORDER;
}

async function buildResult(input: Record<string, unknown>, ctx: ToolContext, messages: Message[]): Promise<PresentOptions> {
  const seen = readTranscript(messages);
  let cache = cachedSources(ctx.vaultId);
  if ((!cache || !cache.providers.size) && seen.searchInput) {
    // Another isolate ran the search: fetch the same public query again for addresses and phones.
    try {
      const area = areaFor(ctx.values.home_zip && ctx.values.home_zip === seen.searchInput.zip3 ? ctx.values.home_zip : undefined);
      const again = await searchProviders({ specialty: 'physical_therapy', state: PILOT_STATE, limit: 20, ...area });
      rememberProviders(ctx.vaultId, (again.providers || []) as Provider[]);
      cache = cachedSources(ctx.vaultId);
    } catch { /* keep what the transcript has */ }
  }
  const compact = new Map(seen.providers.map(p => [p.npi, p]));
  const options: RankedOption[] = [];
  const used = new Set<string>();
  for (const raw of (Array.isArray(input.options) ? input.options : []).slice(0, 10)) {
    if (!raw || typeof raw !== 'object') continue;
    const o = raw as Record<string, unknown>;
    const npi = String(o.npi ?? '');
    if (!/^\d{10}$/.test(npi) || used.has(npi)) continue;
    used.add(npi);
    const full = cache?.providers.get(npi);
    const cp = compact.get(npi);
    const fullCheck = cache?.checks.get(npi);
    const cc = seen.checks.get(npi);
    // Network status comes from the check that ran, never from the model's say-so.
    const network: NetworkStatus = fullCheck?.status ?? cc?.status ?? 'unverified';
    let evidence: Evidence[] = [...(full?.evidence || []), ...(fullCheck?.evidence || [])];
    if (!evidence.length) {
      evidence = [
        ...(cp?.listedBy || []).map(source => ({ source, claim: 'Listed as a physical therapy provider', asOf: '', url: '' })),
        ...(cc?.evidence || []).map(e => ({ ...e, url: '' })),
      ];
    }
    const address = full ? (full.city && !full.address.includes(full.city) ? `${full.address}, ${full.city}` : full.address) : '';
    options.push({
      rank: options.length + 1,
      npi,
      name: full?.name || cp?.name || safeText(o.name, 120),
      address,
      zip: full?.zip || (cp?.zip3 ? `${cp.zip3}xx` : ''),
      ...(full?.phone ? { phone: full.phone } : {}),
      network,
      evidence: evidence.filter((e, i, all) => all.findIndex(x => x.source === e.source && x.claim === e.claim) === i).slice(0, 6),
      why: safeText(o.why, 300),
    });
  }
  const list = (value: unknown, max: number) => (Array.isArray(value) ? value : []).filter(v => typeof v === 'string' && v.trim()).slice(0, max).map(v => safeText(v, 300));
  const limitations = list(input.limitations, 8);
  if (!limitations.some(l => /availab/i.test(l))) limitations.push(AVAILABILITY_NOTE);
  return { summary: safeText(input.summary, 600), options, limitations, nextSteps: list(input.nextSteps, 6) };
}

// ---------- the step ----------

export interface StepOptions { scripted: boolean }

export async function step(req: AgentStepRequest, env: AgentEnv, vaultId: string, opts: StepOptions): Promise<AgentStepResponse> {
  const mode: AgentStepResponse['mode'] = opts.scripted || !env.ANTHROPIC_API_KEY ? 'scripted' : 'model';
  const events: AgentEvent[] = [];
  const parsed = parseMessages(req.messages);
  if (!parsed) return { messages: Array.isArray(req.messages) ? req.messages : [], status: 'error', mode, modelView: '', events, error: 'The transcript is not valid. Start a new request.' };
  const original: Message[] = structuredClone(parsed);
  const messages = parsed;
  const fail = (error: string, modelView = '', keep = false): AgentStepResponse => ({ messages: keep ? messages : original, status: 'error', mode, modelView, events, error });

  if (messages.filter(m => m.role === 'assistant').length >= MAX_ASSISTANT_TURNS) return fail('This run reached its step limit. Start a new request.');

  const grants = await loadGrants(env, vaultId);
  const transcriptText = JSON.stringify(messages);
  const { values, notices } = await validateReleases(req, grants, env, vaultId, events, transcriptText);

  // 1. The user turn this step sends: the need, the answer to a paused tool, or pending tool results.
  let pending: Message;
  if (!messages.length) {
    const need = typeof req.need === 'string' ? req.need.replace(/\s+/g, ' ').trim().slice(0, 1000) : '';
    if (!need) return fail('Say what you need first.');
    pending = { role: 'user', content: [{ type: 'text', text: `Patient request (scrubbed on the patient's device): "${need}"\n\n${manifest()}` }] };
    messages.push(pending);
  } else {
    const last = messages[messages.length - 1];
    if (last.role === 'user') {
      pending = last; // server tool results or a nudge, not yet seen by the model
    } else {
      const uses = toolUses(last);
      const results: Block[] = [];
      for (const [index, use] of uses.entries()) {
        if (index > 0) { results.push(toolResult(use.id, 'Only one tool call per turn; this one was not run.', true)); continue; }
        if (use.name === 'request_consent') {
          if (!req.consentAnswer || req.consentAnswer.toolUseId !== use.id) return fail('Waiting for your answer to the consent request.');
          results.push(toolResult(use.id, consentResult(req.consentAnswer, use, grants), false));
        } else if (use.name === 'draft_outreach') {
          if (!req.draftAnswer || req.draftAnswer.toolUseId !== use.id) return fail('Waiting for your answer on the draft.');
          results.push(toolResult(use.id, req.draftAnswer.approved
            ? 'Patient approved the draft. The device filled the tokens locally and the patient sends it; Haledy never saw the values. Next: present_options.'
            : 'Patient discarded the draft. Do not draft again. Next: present_options.', false));
        } else if (use.name === 'present_options') {
          return fail('This run is finished. Start a new request.');
        } else {
          results.push(toolResult(use.id, 'This tool call was not run.', true));
        }
      }
      pending = { role: 'user', content: results.length ? results : [{ type: 'text', text: NUDGE }] };
      messages.push(pending);
    }
  }
  for (const notice of notices) pending.content.push({ type: 'text', text: notice });
  const granted = Object.entries(values);
  if (granted.length) {
    pending.content.push({ type: 'text', text: granted.map(([f, v]) => `Granted context: ${f}=${v}${f === 'home_zip' ? ' (first three digits only)' : ''}`).join('\n') });
  }

  // 2. Guard: nothing identifying reaches the model, whatever the browser sent.
  const names = toolNames(messages);
  const modelView = renderUserContent(pending, names);
  const findings = guardFindings(messages, pending);
  if (findings.length) {
    await audit(env, vaultId, 'server', 'phi_blocked', { types: findings });
    events.push({ at: nowIso(), kind: 'guard', title: 'Stopped before the model call', detail: `Identifiers found: ${findings.join(', ')}. Nothing was sent.` });
    return fail(`Haledy stopped before sending anything to the model: the text still contained identifiers (${findings.join(', ')}).`);
  }

  // 3. One model call, or one scripted planner turn.
  const fieldsSent = Object.keys(values);
  let content: Block[];
  let stopReason = 'tool_use';
  let modelName = 'scripted-planner';
  if (mode === 'scripted') {
    await audit(env, vaultId, 'agent', 'model_call', { model: modelName, fields: fieldsSent });
    content = scriptedTurn(messages, values);
  } else {
    modelName = env.MODEL || 'claude-opus-5-5';
    await audit(env, vaultId, 'agent', 'model_call', { model: modelName, fields: fieldsSent });
    try {
      const reply = await callModel(env, messages);
      content = reply.content;
      stopReason = reply.stopReason;
      modelName = reply.model;
    } catch (error) {
      events.push({ at: nowIso(), kind: 'note', title: 'Model call failed' });
      return fail(error instanceof ModelError ? error.message : 'The model call failed.', modelView);
    }
    if (stopReason === 'refusal') {
      events.push({ at: nowIso(), kind: 'note', title: 'The model declined this step' });
      return fail('The model declined this step. Try again, or use scripted mode.', modelView);
    }
  }

  const assistant: Message = { role: 'assistant', content };
  messages.push(assistant);
  for (const b of content) {
    if (b.type === 'text' && String(b.text ?? '').trim()) events.push({ at: nowIso(), kind: 'model', title: mode === 'scripted' ? 'Haledy (scripted)' : 'Haledy', detail: String(b.text).slice(0, 800) });
  }
  const respond = (status: AgentStepResponse['status'], extra: Partial<AgentStepResponse> = {}): AgentStepResponse => ({ messages, status, mode, modelView, events, ...extra });
  const continueWith = (blocks: Block[]) => { messages.push({ role: 'user', content: blocks }); return respond('running'); };

  // 4. Act on the tool call.
  const uses = toolUses(assistant);
  if (stopReason === 'max_tokens' && uses.length) return fail('The model ran out of room in this step. Try again.', modelView);
  if (!uses.length) {
    const previous = messages.slice(0, -1).reverse().find(m => m.role === 'assistant');
    if (previous && !toolUses(previous).length) return respond('error', { error: 'The agent stopped without presenting options. Start a new request.' });
    return continueWith([{ type: 'text', text: NUDGE }]);
  }
  const use = uses[0];
  const input = (use.input && typeof use.input === 'object' ? use.input : {}) as Record<string, unknown>;
  const extraResults = uses.slice(1).map(u => toolResult(u.id, 'Only one tool call per turn; this one was not run.', true));
  const ctx: ToolContext = { env, vaultId, values, events };

  if (SERVER_TOOLS.has(String(use.name))) {
    const outcome = await runServerTool(String(use.name), input, ctx);
    return continueWith([toolResult(use.id, outcome.content, outcome.isError), ...extraResults]);
  }

  if (use.name === 'request_consent') {
    const requested = [...new Set((Array.isArray(input.fields) ? input.fields : []).map(String))];
    const fields = requested.filter(f => MODEL_FIELDS.includes(f));
    if (!fields.length) {
      return continueWith([toolResult(use.id, `Not asked: ${requested.filter(f => f in FIELDS).join(', ') || 'those fields'} cannot be released to the agent. Identifiers stay as {{tokens}}; ask only for fields the manifest marks "with consent".`, true), ...extraResults]);
    }
    const consentRequest: ConsentRequest = {
      toolUseId: String(use.id),
      fields,
      purpose: safeText(input.purpose, 160) || 'Find care for you',
      ttlMinutes: Math.min(Math.max(Math.round(Number(input.ttl_minutes) || 30), 1), 120),
      why: safeText(input.why, 400),
    };
    events.push({ at: nowIso(), kind: 'consent', title: 'Asking for consent', detail: consentRequest.purpose, fields });
    return respond('needs_consent', { consentRequest });
  }

  if (use.name === 'draft_outreach') {
    let body = String(input.body ?? '').trim().slice(0, 2000);
    if (!body.toLowerCase().startsWith(DISCLOSURE.toLowerCase())) body = `${DISCLOSURE}. ${body}`;
    const npi = String(input.npi ?? '');
    const channel = (['email', 'web_form', 'phone_script'] as const).find(c => c === input.channel) ?? 'email';
    const tokens = tokensIn(body);
    const unknownTokens = tokens.filter(t => !(t in FIELDS));
    const flagged = [...new Set(scrub(body).findings.map(f => f.type))];
    if (flagged.length) {
      await audit(env, vaultId, 'server', 'phi_blocked', { types: flagged, tool: 'draft_outreach' });
      events.push({ at: nowIso(), kind: 'guard', title: 'Draft rejected: it contained identifiers', detail: flagged.join(', ') });
      return continueWith([toolResult(use.id, `Draft rejected: it contained ${flagged.join(', ')}. Use {{tokens}} for identifiers and leave out dates, numbers and links.`, true), ...extraResults]);
    }
    if (!/^\d{10}$/.test(npi) || unknownTokens.length) {
      return continueWith([toolResult(use.id, unknownTokens.length ? `Draft rejected: unknown tokens ${unknownTokens.join(', ')}. Use only vault field names.` : 'Draft rejected: npi must be a ten-digit NPI from the search results.', true), ...extraResults]);
    }
    // The model saw provider names with place names removed; the patient sees the directory name.
    const recipientName = cachedSources(vaultId)?.providers.get(npi)?.name || safeText(input.recipient_name, 120);
    const draft: OutreachDraft = { toolUseId: String(use.id), npi, recipientName, channel, body, tokens };
    events.push({ at: nowIso(), kind: 'consent', title: 'Draft ready for your approval', detail: `${tokens.length} tokens stay on your device until you approve`, fields: tokens });
    return respond('needs_approval', { draft });
  }

  if (use.name === 'present_options') {
    const result = await buildResult(input, ctx, messages);
    await audit(env, vaultId, 'agent', 'options_presented', { options: result.options.length });
    events.push({ at: nowIso(), kind: 'note', title: 'Options ready', detail: `${result.options.length} ranked options` });
    return respond('done', { result });
  }

  return continueWith([toolResult(use.id, `Unknown tool ${String(use.name)}.`, true), ...extraResults]);
}
