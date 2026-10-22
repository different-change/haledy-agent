// Tests for the shared PHI definition. Values are the fictional demo persona or made-up patterns.
import test from 'node:test';
import assert from 'node:assert/strict';
import { FIELDS, TOKEN_FIELDS, fillTokens, modelValue, scrub, tokensIn, zip3 } from '../public/phi.js';

const types = text => scrub(text).findings.map(f => f.type);

test('scrub removes phone numbers', () => {
  for (const phone of ['(415) 555-0134', '415-555-0134', '415.555.0134', '+1 415 555 0134']) {
    const out = scrub(`Call me at ${phone} please`);
    assert.ok(types(`Call me at ${phone}`).includes('phone'), phone);
    assert.ok(!out.text.includes('555'), phone);
  }
});

test('scrub removes email addresses', () => {
  const out = scrub('Write to alex@example.com today');
  assert.deepEqual(out.findings.map(f => f.type), ['email']);
  assert.equal(out.text, 'Write to [email removed] today');
});

test('scrub removes Social Security numbers', () => {
  const out = scrub('SSN 123-45-6789');
  assert.ok(types('SSN 123-45-6789').includes('ssn'));
  assert.ok(!out.text.includes('6789'));
});

test('scrub removes dates in common formats', () => {
  for (const date of ['1990-04-12', '04/12/1990', '4.12.90', 'April 12, 1990', 'apr 12th 1990']) {
    const out = scrub(`born ${date}`);
    assert.ok(out.findings.some(f => f.type === 'date'), date);
    assert.ok(!/1990|\b90\b/.test(out.text), `${date} -> ${out.text}`);
  }
});

test('scrub generalizes a 5-digit ZIP to ZIP3', () => {
  const out = scrub('I live in 94110');
  assert.equal(out.text, 'I live in 941xx');
  assert.equal(out.findings[0].type, 'zip');
  assert.equal(scrub('ZIP 94110-1234').text, 'ZIP 941xx');
  assert.equal(scrub('ZIP 03601').text, 'ZIP 000xx', 'restricted prefixes become 000');
});

test('scrub removes member-id-like and long numbers', () => {
  assert.ok(types('member XYZ000000000').includes('id-number'));
  assert.ok(types('account AB12-34CD-56').includes('id-number'));
  assert.ok(types('number 123456789012').includes('long-number'));
  assert.ok(!scrub('member XYZ000000000').text.includes('XYZ000000000'));
});

test('scrub replaces the patient\'s known identifiers with tokens', () => {
  // Order matters in scrub(): pass full_name before first_name, or "Alex" is tokenized first and
  // the surname is left behind (see the order-sensitivity test below).
  const known = { full_name: FIELDS.full_name.example, first_name: FIELDS.first_name.example, payer: FIELDS.payer.example };
  const out = scrub('Hi, I am Alex Rivera. alex wants PT with Blue Shield of California.', known);
  assert.ok(out.text.includes('{{full_name}}'));
  assert.ok(out.text.includes('{{first_name}}'), 'case-insensitive match');
  assert.ok(!/alex/i.test(out.text.replace(/\{\{\w+\}\}/g, '')));
  assert.ok(out.text.includes('Blue Shield of California'), 'with-consent fields are not tokenized');
  assert.ok(out.findings.every(f => !('value' in f)), 'findings never carry the value');
});

test('scrub with first_name before full_name still removes the first name (surname may remain)', () => {
  const out = scrub('I am Alex Rivera', { first_name: 'Alex', full_name: 'Alex Rivera' });
  assert.ok(!out.text.includes('Alex'));
  // Known gap in phi.js: known values are applied in the caller's order, not longest first.
  // Callers should list full_name before first_name.
});

test('scrub leaves tokens and clean text alone', () => {
  const text = 'This is Haledy, an AI assistant writing on behalf of {{first_name}}. Member {{member_id}}.';
  assert.deepEqual(scrub(text), { text, findings: [] });
  assert.deepEqual(scrub('My back hurts, I need physical therapy this week.').findings, []);
});

test('modelValue never returns never-fields', () => {
  assert.ok(TOKEN_FIELDS.length >= 5);
  for (const name of TOKEN_FIELDS) {
    assert.equal(FIELDS[name].model, 'never');
    assert.equal(modelValue(name, FIELDS[name].example), null, name);
  }
  assert.equal(modelValue('home_zip', '94110'), '941');
  assert.equal(modelValue('payer', 'Blue Shield of California'), 'Blue Shield of California');
  assert.equal(modelValue('not_a_field', 'x'), null);
  assert.equal(modelValue('payer', ''), null);
});

test('zip3 maps restricted prefixes to 000', () => {
  assert.equal(zip3('94110'), '941');
  assert.equal(zip3('03601'), '000');
  assert.equal(zip3('69201'), '000');
  assert.equal(zip3('89301-1234'), '000');
  assert.equal(zip3('12'), '');
  assert.equal(zip3('abcde'), '');
  assert.equal(zip3(undefined), '');
});

test('fillTokens fills known tokens on the device and leaves the rest', () => {
  const text = 'This is Haledy, an AI assistant writing on behalf of {{first_name}}. ID {{member_id}}. {{unknown}}';
  const filled = fillTokens(text, { first_name: 'Alex', member_id: 'XYZ000000000' });
  assert.equal(filled, 'This is Haledy, an AI assistant writing on behalf of Alex. ID XYZ000000000. {{unknown}}');
  assert.equal(fillTokens('{{first_name}}', {}), '{{first_name}}');
});

test('tokensIn lists each token once', () => {
  assert.deepEqual(tokensIn('{{first_name}} {{member_id}} {{first_name}}'), ['first_name', 'member_id']);
  assert.deepEqual(tokensIn('no tokens'), []);
});

test('scrub removes city names in any case', () => {
  for (const text of ['I need PT in sf this week', 'I live in san francisco', 'near Daly City']) {
    assert.ok(types(text).includes('city'), text);
  }
});

test('scrub removes street addresses but not distances or frequencies', () => {
  for (const text of ['near 1640 Valencia St', 'at 500 3rd St', '2001 Van Ness Ave.', '1 Market Street']) {
    assert.ok(types(text).includes('address'), text);
  }
  for (const text of ['2 miles each way', 'I can do 3 days a week', '30 minutes by transit', 'PT 2-3 times a week']) {
    assert.deepEqual(types(text), [], text);
  }
});

test('scrub keeps restricted ZIP3 prefixes and the 941 area straight', () => {
  assert.equal(zip3('94110'), '941');
  for (const zip of ['03601', '06390', '79012', '83001', '83101']) assert.equal(zip3(zip), '000', zip);
});
