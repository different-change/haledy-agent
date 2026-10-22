// Shared by the browser and the Worker: one definition of what the model may see.
// HIPAA Safe Harbor, 45 CFR 164.514(b)(2)(i), lists 18 identifier categories (A-R).
// Haledy sends the model only Safe-Harbor de-identified context; identifiers stay on
// the patient's device and are filled into an outbound message only after approval.

/** @typedef {'never' | 'generalized' | 'with-consent'} ModelAccess */

/**
 * Vault fields. `model` says how the agent may use each one:
 * - never: identifier; the model sees only a {{token}}, the device fills it on send.
 * - generalized: released in Safe-Harbor form only (ZIP -> first three digits).
 * - with-consent: released as-is, only inside an active consent grant.
 * @type {Record<string, {label: string, group: string, model: ModelAccess, safeHarbor?: string, example: string}>}
 */
export const FIELDS = {
  first_name: { label: 'First name', group: 'Identity', model: 'never', safeHarbor: 'A · Names', example: 'Alex' },
  full_name: { label: 'Full legal name', group: 'Identity', model: 'never', safeHarbor: 'A · Names', example: 'Alex Rivera' },
  date_of_birth: { label: 'Date of birth', group: 'Identity', model: 'never', safeHarbor: 'C · Dates', example: '1990-04-12' },
  phone: { label: 'Phone', group: 'Identity', model: 'never', safeHarbor: 'D · Telephone numbers', example: '(415) 555-0134' },
  email: { label: 'Email', group: 'Identity', model: 'never', safeHarbor: 'F · Email addresses', example: 'alex@example.com' },
  home_zip: { label: 'Home ZIP', group: 'Location', model: 'generalized', safeHarbor: 'B · Geography smaller than a state', example: '94110' },
  payer: { label: 'Insurer', group: 'Coverage', model: 'with-consent', example: 'Cigna Healthcare' },
  plan_network: { label: 'Plan and network', group: 'Coverage', model: 'with-consent', example: 'PPO' },
  member_id: { label: 'Member ID', group: 'Coverage', model: 'never', safeHarbor: 'I · Health plan beneficiary numbers', example: 'XYZ000000000' },
  group_number: { label: 'Group number', group: 'Coverage', model: 'never', safeHarbor: 'J · Account numbers', example: '000000' },
  care_need: { label: 'Care you are looking for', group: 'Health', model: 'with-consent', example: 'Physical therapy for lower back pain' },
  availability: { label: 'When you can go', group: 'Preferences', model: 'with-consent', example: 'Weekday mornings' },
  travel_limit: { label: 'How far you will travel', group: 'Preferences', model: 'with-consent', example: '30 minutes by transit' },
  language: { label: 'Language', group: 'Preferences', model: 'with-consent', example: 'English' },
};

export const TOKEN_FIELDS = Object.keys(FIELDS).filter(name => FIELDS[name].model === 'never');

// Safe Harbor allows the first three ZIP digits unless that area has 20,000 people or fewer;
// these prefixes must become 000 (HHS de-identification guidance, list from 2000 Census data).
const RESTRICTED_ZIP3 = new Set(['036', '059', '063', '102', '203', '556', '692', '790', '821', '823', '830', '831', '878', '879', '884', '890', '893']);

// Safe Harbor B also covers city names. The model searches by ZIP3 alone, so a city typed
// into the request is removed; this list covers the Bay Area pilot, not every place name.
const CITIES = ['San Francisco', 'South San Francisco', 'Daly City', 'Oakland', 'Berkeley', 'Emeryville', 'Alameda', 'San Mateo', 'Burlingame', 'Redwood City', 'Palo Alto', 'Mountain View', 'Sunnyvale', 'Santa Clara', 'San Jose', 'Fremont', 'Hayward', 'Richmond', 'Walnut Creek', 'Sausalito', 'SF'];

export function zip3(zip) {
  const digits = String(zip || '').trim().slice(0, 3);
  if (!/^\d{3}$/.test(digits)) return '';
  return RESTRICTED_ZIP3.has(digits) ? '000' : digits;
}

/** The value of a field in the form the model may see, or null when it may not. */
export function modelValue(name, value) {
  const field = FIELDS[name];
  if (!field || value == null || value === '') return null;
  if (field.model === 'never') return null;
  if (field.model === 'generalized') return name === 'home_zip' ? zip3(value) || null : null;
  return String(value);
}

const PATTERNS = [
  { type: 'email', safeHarbor: 'F · Email addresses', re: /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi },
  { type: 'ssn', safeHarbor: 'G · Social Security numbers', re: /\b\d{3}-\d{2}-\d{4}\b/g },
  { type: 'phone', safeHarbor: 'D · Telephone numbers', re: /(?:\+?1[\s.-]?)?\(?\b\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/g },
  { type: 'url', safeHarbor: 'N · URLs', re: /\bhttps?:\/\/\S+/gi },
  { type: 'ip', safeHarbor: 'O · IP addresses', re: /\b(?:\d{1,3}\.){3}\d{1,3}\b/g },
  { type: 'date', safeHarbor: 'C · Dates', re: /\b(?:\d{4}-\d{1,2}-\d{1,2}|\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}|\d{1,2}\/\d{1,2}|(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+\d{1,2}(?:st|nd|rd|th)?(?:,?\s+\d{4})?|\d{1,2}(?:st|nd|rd|th)?\s+(?:of\s+)?(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*(?:,?\s+\d{4})?)\b/gi },
  { type: 'city', safeHarbor: 'B · Geography smaller than a state', re: new RegExp(`\\b(?:${CITIES.sort((a, b) => b.length - a.length).join('|')})\\b`, 'g') },
  { type: 'zip', safeHarbor: 'B · Geography smaller than a state', re: /\b\d{5}(?:-\d{4})?\b/g },
  { type: 'id-number', safeHarbor: 'I/J/R · Member, account or other ID numbers', re: /\b(?=[A-Z0-9-]*\d)(?=[A-Z0-9-]*[A-Z])[A-Z0-9-]{8,20}\b/g },
  { type: 'long-number', safeHarbor: 'R · Other unique numbers', re: /\b\d{8,}\b/g },
];

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Remove Safe Harbor identifiers from free text before it can reach the model.
 * `known` maps vault field names to the patient's own values (browser only), so a
 * name typed into the request is caught even though no pattern could recognise it.
 * Findings carry the category and a masked hint, never the value itself.
 * @param {string} text
 * @param {Record<string, string>} [known]
 * @returns {{ text: string, findings: {type: string, safeHarbor: string, replacement: string}[] }}
 */
export function scrub(text, known = {}) {
  let out = String(text || '');
  const findings = [];
  // Longest first, so "Alex Rivera" becomes {{full_name}} before "Alex" can strand the surname.
  const entries = Object.entries(known).sort((a, b) => String(b[1] || '').length - String(a[1] || '').length);
  for (const [name, value] of entries) {
    const field = FIELDS[name];
    if (!field || field.model !== 'never' || !value || String(value).trim().length < 2) continue;
    const re = new RegExp(`\\b${escapeRegExp(String(value).trim())}\\b`, 'gi');
    out = out.replace(re, () => {
      findings.push({ type: name, safeHarbor: field.safeHarbor, replacement: `{{${name}}}` });
      return `{{${name}}}`;
    });
  }
  for (const pattern of PATTERNS) {
    out = out.replace(pattern.re, match => {
      if (/^\{\{\w+\}\}$/.test(match)) return match;
      const replacement = pattern.type === 'zip' ? `${zip3(match) || '000'}xx` : `[${pattern.type} removed]`;
      findings.push({ type: pattern.type, safeHarbor: pattern.safeHarbor, replacement });
      return replacement;
    });
  }
  return { text: out, findings };
}

/** Fill {{tokens}} on the device, for an outbound message the patient approved. */
export function fillTokens(text, values) {
  return String(text || '').replace(/\{\{(\w+)\}\}/g, (match, name) => (values[name] ? String(values[name]) : match));
}

export function tokensIn(text) {
  return [...new Set([...String(text || '').matchAll(/\{\{(\w+)\}\}/g)].map(m => m[1]))];
}
