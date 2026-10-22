// Tests for the agent step's transcript helpers: withdrawn-value redaction and the server guard.
// Values are the fictional demo persona from public/phi.js or made-up patterns.
import test from 'node:test';
import assert from 'node:assert/strict';
import { guardFindings, redactWithdrawn, stripThinking, withdrawnFields } from '../src/agent.ts';

const GRANT = 'g_0123456789abcdef';
const NPI_A = '1941234567'; // contains 941, not as a word
const NPI_B = '1234567941';

function revokedGrant(fields = ['payer', 'plan_network', 'home_zip', 'care_need']) {
  return { id: GRANT, fields, recipient: 'haledy-agent', purpose: 'Find PT', expiresAt: '2026-10-22T20:00:00Z', status: 'revoked', createdAt: '2026-10-22T19:00:00Z', revokedAt: '2026-10-22T19:10:00Z' };
}

function transcript() {
  return [
    { role: 'user', content: [{ type: 'text', text: 'Patient request (scrubbed on the patient\'s device): "PT this week, my PPO plan"' }] },
    { role: 'assistant', content: [
      { type: 'thinking', thinking: '', signature: 'c2lnbmF0dXJlLTE=' },
      { type: 'text', text: 'I need your consent first.' },
      { type: 'tool_use', id: 'toolu_01', name: 'request_consent', input: { fields: ['payer', 'plan_network', 'home_zip', 'care_need'], purpose: 'Find PT', ttl_minutes: 30, why: 'To search.' } },
    ] },
    { role: 'user', content: [
      { type: 'tool_result', tool_use_id: 'toolu_01', content: `Patient approved grant ${GRANT} for fields [payer, plan_network, home_zip, care_need] until 19:35 UTC.` },
      { type: 'text', text: 'Granted context: payer=Cigna Healthcare\nGranted context: plan_network=PPO\nGranted context: home_zip=941 (first three digits only)\nGranted context: care_need=Physical therapy for lower back pain' },
    ] },
    { role: 'assistant', content: [
      { type: 'thinking', thinking: 'Searching ZIP area 941 next.', signature: 'c2lnbmF0dXJlLTI=' },
      { type: 'text', text: 'Searching in ZIP area 941 for physical therapy for lower back pain.' },
      { type: 'tool_use', id: 'toolu_02', name: 'search_providers', input: { specialty: 'physical_therapy', zip3: '941', city: 'auto', state: 'CA' } },
    ] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_02', content: JSON.stringify({ area: 'Searched ZIP3 941.', providers: [{ npi: NPI_A, name: 'Example PT', zip3: '941' }, { npi: NPI_B, name: 'Other PT', zip3: '946' }] }) }] },
    { role: 'assistant', content: [
      { type: 'tool_use', id: 'toolu_03', name: 'check_network', input: { npis: [NPI_A, NPI_B], payer: 'Cigna Healthcare', plan_network: 'PPO' } },
    ] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_03', content: JSON.stringify({ checks: [{ npi: NPI_A, status: 'listed', evidence: [{ source: 'Payer directory', claim: 'This matches the plan "PPO"', asOf: '2026-09-30' }] }] }) }] },
  ];
}

const text = messages => JSON.stringify(messages);

test('withdrawnFields lists ended agent grants minus fields still released', () => {
  assert.deepEqual(withdrawnFields([revokedGrant()], {}), ['care_need', 'home_zip', 'payer', 'plan_network']);
  assert.deepEqual(withdrawnFields([revokedGrant()], { payer: 'Cigna Healthcare', plan_network: 'PPO' }), ['care_need', 'home_zip']);
  assert.deepEqual(withdrawnFields([{ ...revokedGrant(), status: 'active' }], {}), []);
  assert.deepEqual(withdrawnFields([{ ...revokedGrant(), recipient: 'device' }], {}), []);
});

test('redaction replaces withdrawn values in text, tool_use input and tool_result', () => {
  const messages = transcript();
  const mentions = redactWithdrawn(messages, withdrawnFields([revokedGrant()], {}));
  assert.ok(mentions > 0);
  const all = text(messages);
  for (const value of ['Cigna Healthcare', 'PPO', 'ZIP area 941', '"941"', 'ZIP3 941', 'Physical therapy for lower back pain']) {
    assert.ok(!all.toLowerCase().includes(value.toLowerCase()), `${value} is still there`);
  }
  // The server's grant lines say what was withdrawn, not what it was.
  assert.match(messages[2].content[1].text, /^Granted context: payer=\[withdrawn by the patient\]$/m);
  assert.match(messages[2].content[1].text, /^Granted context: home_zip=\[withdrawn by the patient\]$/m);
  // User request text, assistant text, tool inputs and tool results.
  assert.equal(messages[0].content[0].text, 'Patient request (scrubbed on the patient\'s device): "PT this week, my [withdrawn] plan"');
  assert.equal(messages[3].content.find(b => b.type === 'text').text, 'Searching in ZIP area [withdrawn] for [withdrawn].');
  assert.equal(messages[3].content.find(b => b.type === 'tool_use').input.zip3, '[withdrawn]');
  assert.deepEqual(messages[5].content[0].input, { npis: [NPI_A, NPI_B], payer: '[withdrawn]', plan_network: '[withdrawn]' });
  const search = JSON.parse(messages[4].content[0].content);
  assert.equal(search.area, 'Searched ZIP3 [withdrawn].');
  assert.equal(search.providers[0].zip3, '[withdrawn]');
  assert.equal(search.providers[1].zip3, '946');
  assert.equal(JSON.parse(messages[6].content[0].content).checks[0].evidence[0].claim, 'This matches the plan "[withdrawn]"');
  // The edit invalidates thinking signatures, so thinking blocks are gone.
  assert.ok(!all.includes('"thinking"'));
});

test('redaction never touches NPIs, and keeps values still released', () => {
  const messages = transcript();
  redactWithdrawn(messages, ['home_zip'], { payer: 'Cigna Healthcare', plan_network: 'PPO', care_need: 'Physical therapy for lower back pain' });
  const all = text(messages);
  assert.ok(all.includes(NPI_A) && all.includes(NPI_B));
  assert.deepEqual(messages[5].content[0].input.npis, [NPI_A, NPI_B]);
  assert.ok(all.includes('Cigna Healthcare') && all.includes('PPO'));
  assert.ok(!/(?<!\d)941(?!\d)/.test(all), 'a ZIP3 941 mention is left');
});

test('redaction is idempotent', () => {
  const messages = transcript();
  const withdrawn = withdrawnFields([revokedGrant()], {});
  assert.ok(redactWithdrawn(messages, withdrawn) > 0);
  const once = structuredClone(messages);
  assert.equal(redactWithdrawn(messages, withdrawn), 0);
  assert.deepEqual(messages, once);
});

test('redaction is a no-op when nothing is withdrawn', () => {
  const messages = transcript();
  const before = structuredClone(messages);
  assert.equal(redactWithdrawn(messages, []), 0);
  assert.equal(redactWithdrawn(messages, withdrawnFields([{ ...revokedGrant(), status: 'active' }], {})), 0);
  assert.deepEqual(messages, before);
  // Withdrawn fields that were never granted in this transcript change nothing either.
  assert.equal(redactWithdrawn(messages, ['language']), 0);
  assert.deepEqual(messages, before);
});

test('stripThinking drops thinking blocks and keeps text and tool calls', () => {
  const messages = transcript();
  stripThinking(messages);
  assert.deepEqual(messages[1].content.map(b => b.type), ['text', 'tool_use']);
  assert.deepEqual(messages[3].content.map(b => b.type), ['text', 'tool_use']);
});

test('guard flags a phone number in an assistant text block', () => {
  const messages = [
    { role: 'user', content: [{ type: 'text', text: 'hi' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'Call them at (415) 555-0134.' }, { type: 'tool_use', id: 't1', name: 'draft_outreach', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] },
  ];
  const found = guardFindings(messages, messages[2]);
  assert.ok(found.assistant.includes('phone'));
  assert.deepEqual(found.user, []);
});

test('guard flags a phone number in an assistant tool input', () => {
  const messages = [
    { role: 'user', content: [{ type: 'text', text: 'hi' }] },
    { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'draft_outreach', input: { npi: NPI_A, body: 'Reach me at 415-555-0134' } }] },
  ];
  assert.ok(guardFindings(messages, messages[0]).assistant.includes('phone'));
});

test('guard flags a phone number nested inside a tool_result, even a server tool result', () => {
  const messages = [
    { role: 'user', content: [{ type: 'text', text: 'hi' }] },
    { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'search_providers', input: { specialty: 'physical_therapy', city: 'auto', state: 'CA' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: [
      { type: 'text', text: 'ok' },
      { type: 'search_result', source: 'x', content: [{ type: 'text', text: 'call (415) 555-0134' }] },
    ] }] },
    { role: 'assistant', content: [{ type: 'text', text: 'Next.' }, { type: 'tool_use', id: 't2', name: 'check_network', input: { npis: [NPI_A] } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't2', content: 'ok' }] },
  ];
  assert.ok(guardFindings(messages, messages[4]).user.includes('phone'));
});

test('guard still masks NPIs and source dates in server tool results and model text', () => {
  const messages = [
    { role: 'user', content: [{ type: 'text', text: 'hi' }] },
    { role: 'assistant', content: [{ type: 'text', text: `Checking ${NPI_A}, listed as of 2026-09-30.` }, { type: 'tool_use', id: 't1', name: 'check_network', input: { npis: [NPI_A, NPI_B], payer: 'Cigna Healthcare', plan_network: 'PPO' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: JSON.stringify({ checks: [{ npi: NPI_A, status: 'listed', evidence: [{ source: 'Payer directory', claim: 'Listed', asOf: '2026-09-30' }] }] }) }] },
  ];
  assert.deepEqual(guardFindings(messages, messages[2]), { user: [], assistant: [] });
});
