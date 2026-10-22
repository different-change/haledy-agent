// CMS NPPES NPI Registry API v2.1 (public, no auth, no CORS: call from the Worker).
// Recon 2026-10-22: 0.15-0.85 s per call; limit is capped at 200; postal_code accepts
// a wildcard ("941*"); taxonomy_description matches any taxonomy on the record and the
// city filter can return records whose practice address is elsewhere, so we filter on
// the primary taxonomy (2251*) and the LOCATION address ourselves.
import type { Evidence } from '../types.ts';

export const NPPES_BASE = 'https://npiregistry.cms.hhs.gov/api/';
export const USER_AGENT = 'Haledy/0.1 (patient-side care-access agent demo; public provider data only)';
export const TIMEOUT_MS = 8000;

export interface NppesAddress {
  address_1?: string;
  address_2?: string;
  address_purpose?: string;
  city?: string;
  state?: string;
  postal_code?: string;
  telephone_number?: string;
}

export interface NppesTaxonomy {
  code?: string;
  desc?: string;
  primary?: boolean;
  state?: string;
  license?: string;
}

export interface NppesRecord {
  number: string;
  enumeration_type: 'NPI-1' | 'NPI-2' | string;
  basic: {
    first_name?: string;
    last_name?: string;
    credential?: string;
    organization_name?: string;
    status?: string;
    last_updated?: string;
    enumeration_date?: string;
  };
  addresses?: NppesAddress[];
  taxonomies?: NppesTaxonomy[];
}

interface NppesResponse {
  result_count?: number;
  results?: NppesRecord[];
  Errors?: { description?: string }[];
}

export async function getJson<T>(url: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: { accept: 'application/json', 'user-agent': USER_AGENT, ...(init.headers || {}) },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${new URL(url).host}`);
  return (await res.json()) as T;
}

export function errorNote(err: unknown): string {
  const e = err as { name?: string; message?: string };
  if (e?.name === 'TimeoutError' || e?.name === 'AbortError') return `timed out after ${TIMEOUT_MS / 1000} s`;
  return String(e?.message || err).slice(0, 160);
}

/** The exact public query URL: taxonomy, city, state and (optionally) a ZIP3 wildcard. Nothing else. */
export function nppesSearchUrl(kind: 'NPI-1' | 'NPI-2', city: string, state: string, zip3?: string): string {
  const p = new URLSearchParams({
    version: '2.1',
    taxonomy_description: 'Physical Therapist',
    city,
    state,
    enumeration_type: kind,
    limit: '200',
  });
  if (zip3) p.set('postal_code', `${zip3}*`);
  return `${NPPES_BASE}?${p.toString()}`;
}

export function nppesNpiUrl(npi: string): string {
  return `${NPPES_BASE}?version=2.1&number=${encodeURIComponent(npi)}`;
}

export async function nppesSearch(kind: 'NPI-1' | 'NPI-2', city: string, state: string, zip3?: string): Promise<{ url: string; records: NppesRecord[] }> {
  const url = nppesSearchUrl(kind, city, state, zip3);
  const body = await getJson<NppesResponse>(url);
  if (body.Errors?.length) throw new Error(body.Errors.map(e => e.description).join('; ').slice(0, 160));
  return { url, records: body.results || [] };
}

// Public provider records are not patient data; a per-isolate cache saves subrequests
// when check_network follows search_providers in the same isolate.
const cache = new Map<string, NppesRecord>();

export function remember(record: NppesRecord): void {
  if (cache.size > 2000) cache.clear();
  cache.set(record.number, record);
}

export async function nppesLookup(npi: string): Promise<NppesRecord | null> {
  const hit = cache.get(npi);
  if (hit) return hit;
  const body = await getJson<NppesResponse>(nppesNpiUrl(npi));
  const record = body.results?.[0] || null;
  if (record) remember(record);
  return record;
}

export function primaryTaxonomy(r: NppesRecord): NppesTaxonomy | undefined {
  return r.taxonomies?.find(t => t.primary) || r.taxonomies?.[0];
}

export function isPhysicalTherapist(r: NppesRecord): boolean {
  return (primaryTaxonomy(r)?.code || '').startsWith('2251');
}

export function locationAddress(r: NppesRecord): NppesAddress | undefined {
  return r.addresses?.find(a => a.address_purpose === 'LOCATION') || r.addresses?.[0];
}

export function displayName(r: NppesRecord): string {
  const b = r.basic || {};
  if (r.enumeration_type === 'NPI-2') return titleCase(b.organization_name || `NPI ${r.number}`);
  const name = [b.first_name, b.last_name].filter(Boolean).map(s => titleCase(String(s))).join(' ');
  const cred = (b.credential || '').replace(/[.\s]/g, '').toUpperCase();
  return cred ? `${name}, ${cred}` : name || `NPI ${r.number}`;
}

export function titleCase(text: string): string {
  return text
    .toLowerCase()
    .replace(/\b([a-z])([a-z']*)/g, (_m, a: string, b: string) => a.toUpperCase() + b)
    .replace(/\b(Pt|Dpt|Llc|Pc|Ii|Iii|Usa|Ucsf|Sf)\b/g, m => m.toUpperCase());
}

export function formatAddress(a?: NppesAddress): string {
  if (!a) return '';
  const street = [a.address_1, a.address_2].filter(Boolean).map(s => titleCase(String(s))).join(', ');
  return [street, titleCase(a.city || ''), `${a.state || ''} ${(a.postal_code || '').slice(0, 5)}`.trim()].filter(Boolean).join(', ');
}

export function formatPhone(raw?: string): string | undefined {
  const d = String(raw || '').replace(/\D/g, '');
  if (d.length === 10) return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
  if (d.length === 11 && d.startsWith('1')) return formatPhone(d.slice(1));
  return raw || undefined;
}

export function nppesEvidence(r: NppesRecord, url: string): Evidence {
  const tax = primaryTaxonomy(r);
  const loc = locationAddress(r);
  const status = r.basic?.status === 'A' ? 'Active' : `Status ${r.basic?.status || 'unknown'}`;
  const kind = r.enumeration_type === 'NPI-2' ? 'organization' : 'individual';
  return {
    source: 'CMS NPPES NPI Registry',
    claim: `${status} ${kind} NPI ${r.number}, primary taxonomy ${tax?.desc || 'unknown'} (${tax?.code || '?'}), practice location ${formatAddress(loc) || 'not listed'}, phone ${formatPhone(loc?.telephone_number) || 'not listed'}; record last updated ${r.basic?.last_updated || 'unknown'}.`,
    asOf: r.basic?.last_updated || '',
    url,
  };
}
