// Shared shapes for the Worker, the agent loop and the data sources. See CONTRACT.md.

export type GrantStatus = 'active' | 'revoked' | 'expired';

export interface Grant {
  id: string;
  fields: string[];
  recipient: string;
  purpose: string;
  expiresAt: string;
  status: GrantStatus;
  createdAt: string;
  revokedAt?: string | null;
}

export interface AuditEntry {
  id: number;
  actor: 'patient' | 'device' | 'agent' | 'server';
  action: string;
  detail: Record<string, unknown>;
  createdAt: string;
}

export interface Evidence {
  source: string;
  claim: string;
  asOf: string;
  url: string;
}

export interface Provider {
  npi: string;
  name: string;
  kind: 'organization' | 'individual';
  taxonomy: string;
  address: string;
  city: string;
  zip: string;
  phone?: string;
  evidence: Evidence[];
}

export type NetworkStatus = 'confirmed' | 'listed' | 'unverified' | 'not_found';

export interface NetworkCheck {
  npi: string;
  status: NetworkStatus;
  evidence: Evidence[];
}

export interface SearchQuery {
  specialty: 'physical_therapy';
  zip3?: string;
  city: string;
  state: string;
  limit?: number;
}

export interface SearchResult {
  providers: Provider[];
  sources: { name: string; url: string; count: number; ok: boolean; note?: string }[];
}

export interface NetworkQuery {
  npis: string[];
  payer: string;
  planNetwork: string;
}

export interface NetworkResult {
  checks: NetworkCheck[];
  limitations: string[];
  sources: { name: string; url: string; ok: boolean; note?: string }[];
}

export interface RankedOption {
  rank: number;
  npi: string;
  name: string;
  address: string;
  zip: string;
  phone?: string;
  network: NetworkStatus;
  evidence: Evidence[];
  why: string;
}

export interface PresentOptions {
  summary: string;
  options: RankedOption[];
  limitations: string[];
  nextSteps: string[];
}

export interface ConsentRequest {
  toolUseId: string;
  fields: string[];
  purpose: string;
  ttlMinutes: number;
  why: string;
}

export interface OutreachDraft {
  toolUseId: string;
  npi: string;
  recipientName: string;
  channel: 'email' | 'web_form' | 'phone_script';
  body: string;
  tokens: string[];
}

export interface AgentEvent {
  at: string;
  kind: 'model' | 'tool' | 'consent' | 'guard' | 'grant' | 'note';
  title: string;
  detail?: string;
  fields?: string[];
  source?: { name: string; url: string };
}

export interface Release {
  grantId: string;
  values: Record<string, string>;
}

export interface AgentStepRequest {
  // Anthropic Messages-format transcript, as returned by the previous step.
  messages: unknown[];
  // First step only: the patient's request, already scrubbed in the browser.
  need?: string;
  releases: Release[];
  // Answer to a paused request_consent: the grant created, or a denial.
  consentAnswer?: { toolUseId: string; grantId?: string; denied?: boolean };
  // Answer to a paused draft_outreach.
  draftAnswer?: { toolUseId: string; approved: boolean };
}

export interface AgentStepResponse {
  messages: unknown[];
  status: 'running' | 'needs_consent' | 'needs_approval' | 'done' | 'error';
  mode: 'model' | 'scripted';
  modelView: string;
  events: AgentEvent[];
  consentRequest?: ConsentRequest;
  draft?: OutreachDraft;
  result?: PresentOptions;
  error?: string;
}
