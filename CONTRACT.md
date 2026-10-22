# Haledy agent — build contract (hackathon, 2026-10-22, due 17:00 PT)

Track: **Personal agents & data privacy** ("demonstrate a meaningful privacy or consent control in action").
Rubric: user value 25 · technical execution 25 · originality 20 · track alignment & responsible data 20 · usability & demo clarity 10.

## The story the demo must tell (3 minutes)

1. Patient unlocks a vault **encrypted in the browser** (AES-GCM-256; key from passphrase via PBKDF2-SHA256 600k, or a passkey PRF). The server stores ciphertext under a random id; it has no name, email or account.
2. Patient says it once: *"My back hurts, I need physical therapy this week."*
3. The agent asks for a **scoped, time-boxed consent grant**: which fields, for whom, why, for how long. Patient approves a subset.
4. The agent searches **real public data** (CMS NPPES NPI Registry, CMS Doctors & Clinicians, a payer FHIR directory if one is open) and **reconciles** network status with provenance: who said what, when, and how sure.
5. Ranked options with evidence; a draft outreach message whose identifiers are `{{tokens}}` filled **on the device** only after approval.
6. Live panels: **Audit log**, **What the AI saw** (exact de-identified text per step), **What our server holds** (ciphertext, grants, audit). **Revoke** a grant mid-run and the agent stops using those fields. **Forget me** deletes everything.

PHI doctrine (judge asked about HIPAA): the model only ever sees HIPAA Safe-Harbor de-identified context (45 CFR 164.514(b)(2)). `public/phi.js` is the single definition, imported by browser and Worker:
- `FIELDS[name].model`: `never` (identifier → `{{token}}` only), `generalized` (ZIP → first 3 digits), `with-consent`.
- `scrub(text, known)`: removes identifiers from free text (browser passes the patient's own values in `known`; Worker runs it again without `known` as defense in depth and **refuses the model call** if anything remains, logging an audit event).
- `fillTokens(text, values)`: device-side fill of an approved outbound draft.

Never put real patient data in code, fixtures or tests. The demo persona is fictional (`FIELDS[*].example`).

## Files and owners

| Path | Owner |
|---|---|
| `public/phi.js` | done (shared) |
| `public/index.html`, `public/styles.css`, `public/app.js`, `public/vault.js` | UI builder |
| `src/worker.ts` (routes, D1, audit, grants), `src/agent.ts` (model step + scripted fallback), `src/tools.ts` (tool schemas + dispatch) | agent builder |
| `src/sources/nppes.ts`, `src/sources/cms.ts`, `src/sources/payer.ts`, `src/sources/index.ts` | data builder |
| `src/types.ts` | done (shared) |
| `migrations/0001_vault.sql`, `wrangler.jsonc`, `scripts/build.mjs` | done |

## HTTP API (all JSON, same-origin only, `Cache-Control: no-store`)

A vault id is a 32-byte random hex capability created by the server; the browser keeps it in `localStorage` (`haledy.vaultId`). Every vault-scoped call passes it in the `X-Vault` header.

| Method & path | Body → Response |
|---|---|
| `POST /api/vault` | `{ciphertext, iv, kdf}` → `201 {vaultId}` (audit: `vault_created`) |
| `GET /api/vault` | → `{ciphertext, iv, kdf, updatedAt}` |
| `PUT /api/vault` | `{ciphertext, iv, kdf}` → `{ok, updatedAt}` (audit: `vault_updated`, detail `{bytes}`) |
| `DELETE /api/vault` | → `{ok}`; deletes vault, grants, audit rows (explicit deletes, not only cascade) |
| `GET /api/server-view` | → `{vault: {bytes, ciphertextPreview (first 96 chars), kdf, createdAt, updatedAt}, grants: Grant[], audit: AuditEntry[]}` — everything the server holds for this vault |
| `GET /api/audit?after=<id>` | → `{entries: AuditEntry[]}` |
| `POST /api/audit` | `{action, detail}` for device-side events only: `vault_unlocked`, `tokens_filled` (detail `{fields, recipient}`), `scrubbed_locally` (detail `{types}`), `consent_denied` → `{ok}`; actor `device` |
| `POST /api/grants` | `{fields: string[], recipient, purpose, ttlMinutes (1..120)}` → `201 Grant`; rejects any field whose `model` is `never` unless `recipient !== 'haledy-agent'` (device-fill grants for outbound drafts) |
| `POST /api/grants/:id/revoke` | → `Grant` (status `revoked`) |
| `POST /api/agent/step` | `AgentStepRequest` → `AgentStepResponse` (see `src/types.ts`) |

Body limit 64 KB for `/api/agent/step`, 16 KB elsewhere. Errors: `{error: string}` with 4xx/5xx.

## Agent loop (browser drives, server is stateless between steps)

- Browser holds the transcript (`messages`, Anthropic Messages format) and resends it each step with `releases` (values for active grants) — values are **never stored** server-side.
- Each step the Worker: validates every release against D1 (`active`, unexpired, field ∈ grant); converts values through `modelValue()`; builds the step's new user content; runs `scrub()` on all text going to the model and refuses if findings remain; makes **one** model call; executes any server-side tool calls (`search_providers`, `check_network`), appending results; returns `status`:
  - `running` → browser calls step again immediately (shows progress);
  - `needs_consent` → browser shows the consent card for `consentRequest`, creates a grant on approve (or logs `consent_denied`), then steps again with `consentAnswer`;
  - `needs_approval` → an outbound `draft` with `{{tokens}}` for the patient to approve and fill on device;
  - `done` → `result` (ranked options) to render;
  - `error`.
- If a release references a revoked/expired grant, the Worker drops those values, tells the model in that step's user content ("Grant g… was revoked by the patient at T; do not use zip/plan_network"), and emits an event.
- Every step returns `modelView`: the exact de-identified text the model received this step (excluding the fixed system prompt), and `events` for the activity feed. The Worker writes audit rows for model calls (`model_call`, detail `{model, fields}`), tool calls (`tool_call`, detail `{tool, host, fields, results}`), grant checks (`grant_rejected`), and PHI guard blocks (`phi_blocked`, detail `{types}`).
- No `ANTHROPIC_API_KEY` → `mode: 'scripted'`: a deterministic planner producing the same sequence (consent → search → check network → present) so the demo never dies. UI labels the mode.

### Tools exposed to the model

| Tool | Executed by | Input |
|---|---|---|
| `request_consent` | browser (pause) | `{fields: string[], purpose: string, ttl_minutes: number, why: string}` (recipient is always `haledy-agent`) |
| `search_providers` | Worker | `{specialty: 'physical_therapy', zip3?: string, city: string, state: string, limit?: number}` — requires an active grant covering `home_zip` if `zip3` is used |
| `check_network` | Worker | `{npis: string[], payer: string, plan_network: string}` — requires grant covering `payer`, `plan_network` |
| `draft_outreach` | browser (pause) | `{npi, recipient_name, channel: 'email'|'web_form'|'phone_script', body}` — body must use `{{first_name}}`, `{{member_id}}` etc. for identifiers; must open with the AI disclosure "This is Haledy, an AI assistant writing on behalf of {{first_name}}" |
| `present_options` | terminal | `PresentOptions` (see types) |

System prompt rules: access agent, not clinician (no clinical advice, no "heals fastest"); never ask for identifiers, never invent them; request consent before using any vault field; say plainly what each source can and cannot confirm; availability is unknown until a clinic answers; rank by network evidence strength, then proximity (zip3 match), then data freshness.

## Ranking and honesty

Network status per option: `confirmed` (payer directory lists NPI in the named network), `listed` (payer directory lists NPI, network unclear), `unverified` (no open directory for this plan — state the limitation), `not_found`. Every evidence item: `{source, claim, asOf, url}`. The browser may re-rank on device using the full ZIP (exact match first) — the model never needs it.
