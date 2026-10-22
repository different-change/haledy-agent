// Live tests for the public data sources (NPPES, CMS, payer directories).
// They call real public APIs and skip when the network is unavailable.
// Run: node --test tests/sources.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { searchProviders, checkNetwork } from '../src/sources/index.ts';

const STATUSES = new Set(['confirmed', 'listed', 'unverified', 'not_found']);

async function online() {
  try {
    const res = await fetch('https://npiregistry.cms.hhs.gov/api/?version=2.1&number=1174662803', { signal: AbortSignal.timeout(8000) });
    return res.ok;
  } catch {
    return false;
  }
}

const isOnline = await online();
let search;

function assertEvidence(list, where) {
  assert.ok(Array.isArray(list) && list.length > 0, `${where}: at least one evidence item`);
  for (const e of list) {
    for (const key of ['source', 'claim', 'asOf', 'url']) assert.equal(typeof e[key], 'string', `${where}: evidence.${key} is a string`);
    assert.ok(e.source && e.claim && e.url, `${where}: evidence has source, claim and url`);
  }
}

test('searchProviders: San Francisco physical therapists from NPPES with evidence', { skip: !isOnline && 'offline' }, async () => {
  const t0 = Date.now();
  search = await searchProviders({ specialty: 'physical_therapy', city: 'San Francisco', state: 'CA', zip3: '941' });
  const ms = Date.now() - t0;
  assert.ok(search.providers.length > 0, 'returns providers');
  assert.ok(search.providers.length <= 25, 'capped at 25');
  const npis = new Set();
  for (const p of search.providers) {
    assert.match(p.npi, /^\d{10}$/, 'NPI is 10 digits');
    assert.ok(!npis.has(p.npi), 'deduped by NPI');
    npis.add(p.npi);
    assert.ok(p.name, 'has a name');
    assert.ok(p.address, 'has an address');
    assert.match(p.zip, /^941\d{2}$/, 'zip inside the requested ZIP3');
    assert.ok(['organization', 'individual'].includes(p.kind));
    assertEvidence(p.evidence, p.npi);
    assert.ok(p.evidence[0].url.startsWith('https://npiregistry.cms.hhs.gov/api/'), 'first evidence is the NPPES query');
  }
  assert.ok(search.providers.some(p => p.kind === 'organization'), 'includes clinics');
  for (const s of search.sources) assert.equal(typeof s.ok, 'boolean');
  assert.ok(search.sources.some(s => s.ok && s.count > 0), 'at least one source answered');
  // Query URLs carry only public parameters.
  for (const s of search.sources) assert.doesNotMatch(s.url, /member|dob|first_name|last_name|email|phone/i);
  console.log(`  search: ${search.providers.length} providers in ${ms} ms; sources ${search.sources.map(s => `${s.name}=${s.ok ? s.count : 'FAIL'}`).join(', ')}`);
});

test('checkNetwork: one valid check per NPI, NPPES evidence on each', { skip: !isOnline && 'offline' }, async () => {
  assert.ok(search?.providers?.length >= 3, 'search ran first and returned at least 3 providers');
  const npis = search.providers.slice(0, 3).map(p => p.npi);
  const t0 = Date.now();
  const result = await checkNetwork({ npis, payer: 'Blue Shield of California', planNetwork: 'PPO · BlueCard' });
  const ms = Date.now() - t0;
  assert.equal(result.checks.length, 3, 'one check per NPI');
  assert.deepEqual(result.checks.map(c => c.npi).sort(), [...npis].sort());
  for (const c of result.checks) {
    assert.ok(STATUSES.has(c.status), `valid status ${c.status}`);
    assert.equal(c.status, 'unverified', 'no open directory covers Blue Shield of California PPO, so nothing is confirmed');
    assertEvidence(c.evidence, c.npi);
    assert.ok(c.evidence.some(e => e.source === 'CMS NPPES NPI Registry'), 'has NPPES evidence');
  }
  assert.ok(result.limitations.some(l => /No public directory API covers Blue Shield of California/.test(l)), 'states the limitation');
  console.log(`  check (Blue Shield CA): ${result.checks.map(c => c.status).join(', ')} in ${ms} ms`);
});

test('checkNetwork: Cigna directory confirms a listed PPO provider', { skip: !isOnline && 'offline' }, async () => {
  // 1851648133: a San Francisco PT that Cigna's open directory listed in "CALIFORNIA PPO-PPA DIRECT" on 2026-10-22.
  const result = await checkNetwork({ npis: ['1851648133'], payer: 'Cigna', planNetwork: 'PPO' });
  assert.equal(result.checks.length, 1);
  const [c] = result.checks;
  assert.ok(STATUSES.has(c.status));
  assertEvidence(c.evidence, c.npi);
  const cigna = result.sources.find(s => /Cigna/.test(s.name));
  if (cigna?.ok) assert.ok(['confirmed', 'listed'].includes(c.status), `Cigna lists this NPI (got ${c.status})`);
  console.log(`  check (Cigna PPO): ${c.status}; ${c.evidence.at(-1).claim}`);
});

test('checkNetwork: bad input never throws', async () => {
  const result = await checkNetwork({ npis: ['abc'], payer: 'Unknown Health', planNetwork: 'HMO' });
  assert.equal(result.checks.length, 1);
  assert.equal(result.checks[0].status, 'unverified');
  assertEvidence(result.checks[0].evidence, 'abc');
  const empty = await searchProviders({ specialty: 'physical_therapy', city: '', state: 'CA' });
  assert.deepEqual(empty.providers, []);
  assert.equal(empty.sources[0].ok, false);
});
