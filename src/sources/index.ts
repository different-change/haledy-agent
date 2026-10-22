// Public data sources for the agent's server-side tools. Every call is a fetch with an
// 8 s timeout; a failing source shows up as sources[].ok=false with a note, and the
// exported functions never throw. Query URLs carry only public parameters (taxonomy,
// city, state, ZIP3, provider NPI or name), never anything from the patient's vault.
import type { Evidence, NetworkCheck, NetworkQuery, NetworkResult, Provider, SearchQuery, SearchResult } from '../types.ts';
import {
  NPPES_BASE,
  displayName,
  errorNote,
  formatAddress,
  formatPhone,
  isPhysicalTherapist,
  locationAddress,
  nppesEvidence,
  nppesLookup,
  nppesNpiUrl,
  nppesSearch,
  primaryTaxonomy,
  remember,
  titleCase,
  type NppesRecord,
} from './nppes.ts';
import { addressKey, cmsClinicians, cmsEvidenceForIndividual, cmsEvidenceForOrganization, type CmsRow } from './cms.ts';
import { CIGNA_BASE, REGENCE_BASE, checkCigna, checkRegence, isBluePlan, limitationFor, payerKey, type PayerCheck } from './payer.ts';

const MAX_PROVIDERS = 25;
const MAX_CHECKS = 10;

function cleanZip3(zip3?: string): string | undefined {
  const z = String(zip3 || '').trim();
  return /^\d{3}$/.test(z) && z !== '000' ? z : undefined;
}

export async function searchProviders(query: SearchQuery): Promise<SearchResult> {
  const city = String(query?.city || '').trim();
  const state = String(query?.state || '').trim().toUpperCase();
  const zip3 = cleanZip3(query?.zip3);
  const limit = Math.max(1, Math.min(MAX_PROVIDERS, Number(query?.limit) || MAX_PROVIDERS));
  if (!city || !/^[A-Z]{2}$/.test(state) || (query?.specialty && query.specialty !== 'physical_therapy')) {
    return { providers: [], sources: [{ name: 'CMS NPPES NPI Registry', url: NPPES_BASE, count: 0, ok: false, note: 'Search needs specialty physical_therapy, a city and a two-letter state.' }] };
  }

  const [orgs, people, cms] = await Promise.all([
    nppesSearch('NPI-2', city, state, zip3).then(v => ({ ok: true as const, ...v }), e => ({ ok: false as const, error: errorNote(e) })),
    nppesSearch('NPI-1', city, state, zip3).then(v => ({ ok: true as const, ...v }), e => ({ ok: false as const, error: errorNote(e) })),
    cmsClinicians(city, state),
  ]);

  const byNpi = new Map<string, CmsRow[]>();
  const byAddr = new Map<string, CmsRow[]>();
  for (const row of cms.rows) {
    byNpi.set(row.npi, [...(byNpi.get(row.npi) || []), row]);
    const k = addressKey(row.address, row.zip5);
    byAddr.set(k, [...(byAddr.get(k) || []), row]);
  }

  const wantCity = city.toUpperCase();
  const keep = (r: NppesRecord): boolean => {
    const loc = locationAddress(r);
    if (!loc || !isPhysicalTherapist(r)) return false;
    if ((r.basic?.status || 'A') !== 'A') return false;
    if (String(loc.city || '').toUpperCase() !== wantCity || String(loc.state || '').toUpperCase() !== state) return false;
    return !zip3 || String(loc.postal_code || '').startsWith(zip3);
  };

  type Candidate = { provider: Provider; cms: boolean; updated: string };
  const seen = new Set<string>();
  const build = (r: NppesRecord, url: string): Candidate | null => {
    if (seen.has(r.number) || !keep(r)) return null;
    seen.add(r.number);
    remember(r);
    const loc = locationAddress(r)!;
    const kind = r.enumeration_type === 'NPI-2' ? 'organization' : 'individual';
    const evidence: Evidence[] = [nppesEvidence(r, url)];
    let cmsRows: CmsRow[] = [];
    let practice: CmsRow | undefined;
    if (kind === 'individual') {
      cmsRows = byNpi.get(r.number) || [];
      const sameZip = cmsRows.find(c => c.zip5 === String(loc.postal_code || '').slice(0, 5)) || cmsRows[0];
      if (sameZip) evidence.push(cmsEvidenceForIndividual(sameZip, cms.url));
      // CMS (released monthly) is fresher than most NPPES records; use its practice address
      // when it stays inside the requested ZIP3. The NPPES address remains in the evidence.
      if (sameZip && (!zip3 || sameZip.zip5.startsWith(zip3))) practice = sameZip;
    } else {
      cmsRows = byAddr.get(addressKey(String(loc.address_1 || ''), String(loc.postal_code || ''))) || [];
      if (cmsRows.length) evidence.push(cmsEvidenceForOrganization(cmsRows, cms.url));
    }
    const tax = primaryTaxonomy(r);
    return {
      provider: {
        npi: r.number,
        name: displayName(r),
        kind,
        taxonomy: `${tax?.desc || 'Physical Therapist'} (${tax?.code || '225100000X'})`,
        address: practice ? `${titleCase(practice.address)}, ${titleCase(city)}, ${state} ${practice.zip5}` : formatAddress(loc),
        city: titleCase(loc.city || city),
        zip: practice ? practice.zip5 : String(loc.postal_code || '').slice(0, 5),
        phone: (practice && formatPhone(practice.phone)) || formatPhone(loc.telephone_number) || formatPhone(cmsRows[0]?.phone),
        evidence,
      },
      cms: cmsRows.length > 0,
      updated: r.basic?.last_updated || '',
    };
  };

  const rank = (a: Candidate, b: Candidate) => Number(b.cms) - Number(a.cms) || b.updated.localeCompare(a.updated);
  const orgList = orgs.ok ? orgs.records.map(r => build(r, orgs.url)).filter((c): c is Candidate => !!c).sort(rank) : [];
  const peopleList = people.ok ? people.records.map(r => build(r, people.url)).filter((c): c is Candidate => !!c).sort(rank) : [];

  // Prefer clinics, but keep some individual clinicians in view (about 60/40), filling from either side.
  const orgQuota = Math.min(orgList.length, Math.max(limit - peopleList.length, Math.ceil(limit * 0.6)));
  const picked = [...orgList.slice(0, orgQuota), ...peopleList.slice(0, limit - orgQuota)].slice(0, limit);
  const providers = picked.map(c => c.provider);

  const cmsMatched = picked.filter(c => c.cms).length;
  const sources: SearchResult['sources'] = [
    orgs.ok
      ? { name: 'CMS NPPES NPI Registry, organizations (NPI-2)', url: orgs.url, count: orgList.length, ok: true, note: `${orgs.records.length} returned, ${orgList.length} with primary taxonomy Physical Therapist and a practice address in ${titleCase(city)}${zip3 ? ` ${zip3}xx` : ''}. No insurance or network data.` }
      : { name: 'CMS NPPES NPI Registry, organizations (NPI-2)', url: NPPES_BASE, count: 0, ok: false, note: orgs.error },
    people.ok
      ? { name: 'CMS NPPES NPI Registry, individuals (NPI-1)', url: people.url, count: peopleList.length, ok: true, note: `First ${people.records.length} records searched, ${peopleList.length} kept. No insurance or network data.` }
      : { name: 'CMS NPPES NPI Registry, individuals (NPI-1)', url: NPPES_BASE, count: 0, ok: false, note: people.error },
    { name: 'CMS Doctors and Clinicians (Medicare enrolment)', url: cms.url, count: cmsMatched, ok: cms.ok, note: cms.ok ? `${cms.note} ${cmsMatched} of ${providers.length} providers matched.` : cms.note },
  ];
  return { providers, sources };
}

export async function checkNetwork(query: NetworkQuery): Promise<NetworkResult> {
  const payer = String(query?.payer || '').trim();
  const planNetwork = String(query?.planNetwork || '').trim();
  const all = [...new Set((query?.npis || []).map(n => String(n).trim()))];
  const npis = all.filter(n => /^\d{10}$/.test(n)).slice(0, MAX_CHECKS);
  const key = payerKey(payer);
  const blue = isBluePlan(payer, planNetwork);
  const limitations = new Set<string>();
  const failures = { nppes: 0, payer: 0, lastPayerError: '', lastNppesError: '' };

  const directory = key === 'cigna' ? 'cigna' : key === 'regence' || blue ? 'regence' : null;
  if (key !== 'cigna' && key !== 'regence') limitations.add(limitationFor(key, payer || 'this payer', planNetwork));
  if (key === 'regence' && /bluecard/i.test(planNetwork)) {
    limitations.add(`Regence's open directory does not publish BlueCard PPO participation for providers outside Regence states; for ${planNetwork} out of area, Haledy would confirm by calling the payer's provider line.`);
  }
  if (directory) limitations.add('Payer directories are self-reported, can be out of date, and do not guarantee benefits; Haledy confirms with the payer before booking.');
  if (all.length > npis.length) limitations.add(`Checked ${npis.length} of ${all.length} NPIs (at most ${MAX_CHECKS} valid 10-digit NPIs per call).`);

  const checkOne = async (npi: string): Promise<NetworkCheck> => {
    const evidence: Evidence[] = [];
    let record: NppesRecord | null = null;
    try {
      record = await nppesLookup(npi);
      evidence.push(
        record
          ? nppesEvidence(record, nppesNpiUrl(npi))
          : { source: 'CMS NPPES NPI Registry', claim: `No NPPES record for NPI ${npi}.`, asOf: new Date().toISOString().slice(0, 10), url: nppesNpiUrl(npi) },
      );
    } catch (e) {
      failures.nppes++;
      failures.lastNppesError = errorNote(e);
      evidence.push({ source: 'CMS NPPES NPI Registry', claim: `NPI lookup failed (${failures.lastNppesError}).`, asOf: '', url: nppesNpiUrl(npi) });
    }
    const kind = record?.enumeration_type === 'NPI-2' ? 'organization' : 'individual';

    let result: PayerCheck = { status: 'unverified', evidence: [] };
    try {
      if (key === 'cigna') result = await checkCigna(npi, record, planNetwork);
      else if (key === 'regence') result = await checkRegence(npi, kind, planNetwork, true);
      else if (blue) {
        // Supplementary only: another Blue plan's directory never upgrades the status.
        const extra = await checkRegence(npi, kind, planNetwork, false);
        result = { status: 'unverified', evidence: extra.evidence };
      }
    } catch (e) {
      failures.payer++;
      failures.lastPayerError = errorNote(e);
      result = { status: 'unverified', evidence: [{ source: directory === 'cigna' ? 'Cigna provider directory' : 'Regence BlueShield provider directory', claim: `Directory query failed (${failures.lastPayerError}); status left unverified.`, asOf: '', url: directory === 'cigna' ? CIGNA_BASE : REGENCE_BASE }] };
    }
    return { npi, status: result.status, evidence: [...evidence, ...result.evidence] };
  };

  const checks = await Promise.all(npis.map(checkOne));
  for (const bad of all.filter(n => !/^\d{10}$/.test(n))) {
    checks.push({ npi: bad, status: 'unverified', evidence: [{ source: 'Haledy input check', claim: 'Not a 10-digit NPI; not looked up.', asOf: new Date().toISOString().slice(0, 10), url: NPPES_BASE }] });
  }

  const sources: NetworkResult['sources'] = [
    { name: 'CMS NPPES NPI Registry', url: NPPES_BASE, ok: failures.nppes === 0, note: failures.nppes ? `${failures.nppes} lookup(s) failed: ${failures.lastNppesError}` : 'Confirms the NPI is active and a physical therapist; says nothing about networks.' },
  ];
  if (directory === 'cigna') {
    sources.push({ name: 'Cigna provider directory (Plan-Net FHIR R4)', url: CIGNA_BASE, ok: failures.payer === 0, note: failures.payer ? `${failures.payer} check(s) failed: ${failures.lastPayerError}` : 'Open CMS-mandated directory of Cigna commercial networks; searched by name, matched on NPI.' });
  } else if (directory === 'regence') {
    sources.push({
      name: 'Regence BlueShield provider directory (HealthSparq Plan-Net FHIR)',
      url: REGENCE_BASE,
      ok: failures.payer === 0,
      note: failures.payer
        ? `${failures.payer} check(s) failed: ${failures.lastPayerError}`
        : key === 'regence'
          ? "The patient's payer's own open directory. Outside Regence states it shows BCBSA Medicare Advantage networks, not BlueCard PPO."
          : "Supplementary: another Blue plan's open directory (BCBSA national networks). It cannot confirm this plan, so statuses stay unverified.",
    });
  }
  return { checks, limitations: [...limitations], sources };
}
