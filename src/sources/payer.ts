// Payer provider directories (CMS-mandated Da Vinci Plan-Net FHIR R4), probed live 2026-10-22.
// Only two answer without a registered client today:
// - Cigna / Evernorth: open, commercial networks. No search by NPI, so we search by name
//   and match the NPI on the returned identifiers.
// - Regence BlueShield (Cambia, HealthSparq): free public token, search by ?npi=. For
//   providers outside Regence states it shows only BCBSA Medicare Advantage networks.
// Blue Shield of California, Anthem (Medicaid-only endpoint, HTTP 500), Aetna (OAuth client
// required) and BlueCard as a programme have no open directory we could query, so those
// plans come back `unverified` with the limitation stated; we never guess.
import type { Evidence, NetworkStatus } from '../types.ts';
import { USER_AGENT, TIMEOUT_MS, errorNote, type NppesRecord } from './nppes.ts';

export const CIGNA_BASE = 'https://p-hi2.digitaledge.cigna.com/ProviderDirectory/v1';
export const REGENCE_BASE = 'https://providers.regence.com/api/provider-fhir-service/v1/fhir';
const REGENCE_TOKEN_URL = 'https://providers.regence.com/api/healthsparq-public-login-service/v1/token';
const NPI_SYSTEM = 'http://hl7.org/fhir/sid/us-npi';

export type PayerKey = 'cigna' | 'regence' | 'blue_shield_ca' | 'anthem' | 'aetna' | 'uhc' | 'humana' | 'kaiser' | 'other';

export function payerKey(payer: string): PayerKey {
  const p = payer.toLowerCase();
  if (/cigna|evernorth/.test(p)) return 'cigna';
  if (/regence|cambia/.test(p)) return 'regence';
  if (/blue\s*shield.*(california|\bca\b)|bsc\b/.test(p)) return 'blue_shield_ca';
  if (/anthem|elevance/.test(p)) return 'anthem';
  if (/aetna/.test(p)) return 'aetna';
  if (/united|uhc|optum/.test(p)) return 'uhc';
  if (/humana/.test(p)) return 'humana';
  if (/kaiser/.test(p)) return 'kaiser';
  return 'other';
}

export function isBluePlan(payer: string, planNetwork: string): boolean {
  return /blue|bcbs|anthem|regence|premera|highmark|wellmark|carefirst/i.test(`${payer} ${planNetwork}`);
}

/** Why no open directory can answer for this payer and plan. */
export function limitationFor(key: PayerKey, payer: string, planNetwork: string): string {
  const plan = `${payer} ${planNetwork}`.trim();
  const call = "Haledy would confirm by calling the payer's provider line before booking.";
  const blueCard = /bluecard/i.test(planNetwork)
    ? ' BlueCard participation in California is held by the host Blue plans (Anthem Blue Cross, Blue Shield of California); neither publishes it in an open API.'
    : '';
  switch (key) {
    case 'blue_shield_ca':
      return `No public directory API covers ${plan}: Blue Shield of California lists a provider-directory API on its developer portal but publishes no open endpoint.${blueCard} ${call}`;
    case 'anthem':
      return `No public directory API covers ${plan}: Anthem's open Plan-Net endpoint is Medicaid-only and returned server errors on 2026-10-22.${blueCard} ${call}`;
    case 'aetna':
      return `No public directory API covers ${plan}: Aetna's directory requires a registered OAuth client. ${call}`;
    case 'uhc':
      return `No public directory API covers ${plan}: UnitedHealthcare's open directory covers Medicare Advantage, Community Plan and exchange plans, not employer PPOs. ${call}`;
    case 'humana':
      return `No public directory API covers ${plan}: Humana's open directory covers Medicare Advantage and Part D only. ${call}`;
    case 'kaiser':
      return `Kaiser Permanente is a closed system; its directory lists KP clinicians, so ${plan} coverage at outside clinics needs a call. ${call}`;
    default:
      return `No public directory API covers ${plan}.${blueCard} ${call}`;
  }
}

// ---------- shared FHIR helpers ----------

interface FhirResource {
  resourceType: string;
  id: string;
  name?: string;
  meta?: { lastUpdated?: string };
  identifier?: { system?: string; value?: string }[];
  extension?: { url?: string; valueReference?: { reference?: string; display?: string } }[];
  network?: { reference?: string; display?: string }[];
}

interface Bundle {
  resourceType: 'Bundle';
  total?: number;
  entry?: { resource: FhirResource; search?: { mode?: string } }[];
}

async function fhir(url: string, headers: Record<string, string> = {}): Promise<Bundle> {
  const res = await fetch(url, {
    headers: { accept: 'application/fhir+json, application/json', 'user-agent': USER_AGENT, ...headers },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${new URL(url).host}`);
  return (await res.json()) as Bundle;
}

function hasNpi(r: FhirResource, npi: string): boolean {
  return (r.identifier || []).some(i => i.value === npi && (!i.system || i.system === NPI_SYSTEM || /npi/i.test(i.system)));
}

/** Network names attached to roles/affiliations, resolved through _include'd Organizations. */
function networksOf(bundle: Bundle): { names: string[]; lastUpdated: string } {
  const orgNames = new Map<string, string>();
  for (const e of bundle.entry || []) if (e.resource.resourceType === 'Organization' && e.resource.name) orgNames.set(`Organization/${e.resource.id}`, e.resource.name);
  const names = new Set<string>();
  let lastUpdated = '';
  for (const e of bundle.entry || []) {
    const r = e.resource;
    if (r.resourceType !== 'PractitionerRole' && r.resourceType !== 'OrganizationAffiliation') continue;
    const refs = [
      ...(r.extension || []).filter(x => /network-reference/.test(x.url || '')).map(x => x.valueReference || {}),
      ...(r.network || []),
    ];
    for (const ref of refs) {
      const name = (ref.reference && orgNames.get(ref.reference)) || ref.display;
      if (name) names.add(name);
    }
    const lu = r.meta?.lastUpdated || '';
    if (lu > lastUpdated) lastUpdated = lu;
  }
  return { names: [...names], lastUpdated: lastUpdated.slice(0, 10) };
}

const STOP = new Set(['plan', 'network', 'the', 'and', 'of', 'insurance', 'health', 'healthcare', 'blue', 'shield', 'cross', 'california', 'ca', 'cigna', 'regence', 'direct', 'national', 'commercial']);

function tokens(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/open\s+access\s+plus/g, 'oap')
    .split(/[^a-z0-9]+/)
    .filter(t => t && !STOP.has(t));
}

/** A directory network matches the patient's plan when every plan token appears in it and the line of business agrees. */
export function networkMatches(networkName: string, planNetwork: string): boolean {
  const plan = tokens(planNetwork);
  if (!plan.length) return false;
  const net = new Set(tokens(networkName));
  const govLine = /medicare|medicaid|medi-cal|advantage/i;
  if (govLine.test(networkName) && !govLine.test(planNetwork)) return false;
  return plan.every(t => net.has(t));
}

export interface PayerCheck {
  status: NetworkStatus;
  evidence: Evidence[];
}

function judge(found: boolean, names: string[], planNetwork: string, authoritative: boolean): NetworkStatus {
  if (!found) return authoritative ? 'not_found' : 'unverified';
  if (!authoritative) return 'unverified';
  return names.some(n => networkMatches(n, planNetwork)) ? 'confirmed' : 'listed';
}

// ---------- Cigna ----------

function nameQuery(r: NppesRecord): string | null {
  if (r.enumeration_type === 'NPI-2') {
    const words = String(r.basic.organization_name || '').replace(/[^A-Za-z0-9 ]/g, ' ').split(/\s+/).filter(Boolean).slice(0, 3);
    return words.length ? `Organization?name=${encodeURIComponent(words.join(' '))}&_count=20` : null;
  }
  const family = String(r.basic.last_name || '').trim();
  const given = String(r.basic.first_name || '').trim();
  return family ? `Practitioner?family=${encodeURIComponent(family)}&given=${encodeURIComponent(given)}&_count=20` : null;
}

export async function checkCigna(npi: string, record: NppesRecord | null, planNetwork: string): Promise<PayerCheck> {
  const source = 'Cigna provider directory (Plan-Net FHIR)';
  if (!record) return { status: 'unverified', evidence: [{ source, claim: 'Not searched: Cigna has no NPI search and the NPPES record (for the name) was unavailable.', asOf: '', url: CIGNA_BASE }] };
  const q = nameQuery(record);
  if (!q) return { status: 'unverified', evidence: [{ source, claim: 'Not searched: no provider name to search by.', asOf: '', url: CIGNA_BASE }] };
  const searchUrl = `${CIGNA_BASE}/${q}`;
  const found = (await fhir(searchUrl)).entry?.map(e => e.resource).find(r => hasNpi(r, npi));
  const today = new Date().toISOString().slice(0, 10);
  if (!found) {
    return {
      status: judge(false, [], planNetwork, true),
      evidence: [{ source, claim: `Searched Cigna's public directory by provider name; no entry carries NPI ${npi}. Name searches can miss renamed practices.`, asOf: today, url: searchUrl }],
    };
  }
  const roleUrl =
    found.resourceType === 'Organization'
      ? `${CIGNA_BASE}/OrganizationAffiliation?participating-organization=${encodeURIComponent(found.id)}&_include=OrganizationAffiliation:network&_count=20`
      : `${CIGNA_BASE}/PractitionerRole?practitioner=${encodeURIComponent(found.id)}&_include=PractitionerRole:network&_count=20`;
  const { names, lastUpdated } = networksOf(await fhir(roleUrl));
  const status = judge(true, names, planNetwork, true);
  const listed = names.length ? `in Cigna network${names.length > 1 ? 's' : ''} ${names.map(n => `"${n}"`).join(', ')}` : 'with no network attached';
  return {
    status,
    evidence: [
      {
        source,
        claim: `Cigna's directory lists NPI ${npi} ${listed}. ${status === 'confirmed' ? `This matches the plan "${planNetwork}".` : `None of these is clearly the plan "${planNetwork}".`} Directory listings can be out of date and do not guarantee benefits.`,
        asOf: lastUpdated || found.meta?.lastUpdated?.slice(0, 10) || today,
        url: roleUrl,
      },
    ],
  };
}

// ---------- Regence (HealthSparq) ----------

let regenceToken: { value: string; at: number } | null = null;

async function regenceAuth(): Promise<string> {
  if (regenceToken && Date.now() - regenceToken.at < 10 * 60 * 1000) return regenceToken.value;
  const res = await fetch(REGENCE_TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json', 'user-agent': USER_AGENT },
    body: JSON.stringify({ insurerCode: 'RG_I', brandCode: 'RG_WW' }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const value = res.headers.get('subject-token');
  if (!res.ok || !value) throw new Error(`Regence public token: HTTP ${res.status}`);
  regenceToken = { value, at: Date.now() };
  return value;
}

/** `authoritative`: true when the patient's payer is Regence itself. */
export async function checkRegence(npi: string, kind: 'organization' | 'individual', planNetwork: string, authoritative: boolean): Promise<PayerCheck> {
  const source = 'Regence BlueShield provider directory (HealthSparq Plan-Net FHIR)';
  const token = await regenceAuth();
  const h = { 'Subject-Token': token };
  const resource = kind === 'organization' ? 'Organization' : 'Practitioner';
  const searchUrl = `${REGENCE_BASE}/${resource}?npi=${encodeURIComponent(npi)}`;
  const found = (await fhir(searchUrl, h)).entry?.map(e => e.resource).find(r => r.resourceType === resource);
  const today = new Date().toISOString().slice(0, 10);
  const scope = authoritative ? '' : " This is another Blue plan's directory (it carries BCBSA national networks), not the patient's own plan's.";
  if (!found) {
    const outOfArea = /bluecard/i.test(planNetwork) ? ' Regence lists BlueCard providers outside its own states only for Medicare Advantage, so absence here is not proof.' : '';
    return {
      status: authoritative && !outOfArea ? 'not_found' : 'unverified',
      evidence: [{ source, claim: `Regence's public directory has no ${resource.toLowerCase()} with NPI ${npi}.${outOfArea}${scope}`, asOf: today, url: searchUrl }],
    };
  }
  const roleUrl =
    kind === 'organization'
      ? `${REGENCE_BASE}/OrganizationAffiliation?participating-organization=Organization/${encodeURIComponent(found.id)}` // _include here returns 400; network refs carry display names
      : `${REGENCE_BASE}/PractitionerRole?practitioner=Practitioner/${encodeURIComponent(found.id)}&_include=PractitionerRole:network`;
  const { names, lastUpdated } = networksOf(await fhir(roleUrl, h));
  const status = judge(true, names, planNetwork, authoritative);
  const listed = names.length ? `only in network${names.length > 1 ? 's' : ''} ${names.map(n => `"${n}"`).join(', ')}` : 'with no network attached';
  return {
    status,
    evidence: [
      {
        source,
        claim: `Regence's directory lists NPI ${npi} ${listed}. ${names.some(n => networkMatches(n, planNetwork)) ? `This matches "${planNetwork}".` : `No commercial network matching "${planNetwork}" appears.`}${scope}`,
        asOf: lastUpdated || found.meta?.lastUpdated?.slice(0, 10) || today,
        url: roleUrl,
      },
    ],
  };
}

export { errorNote };
