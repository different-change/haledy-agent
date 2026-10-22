# Haledy

**Say it once. Your agent does the rest.**

Haledy (HAY-leh-dee) is a patient-side agent that finds physical therapy you can book, and shows you every piece of your data it touches. Built in one day at the super{set} National Renaissance Hackathon (San Francisco, 2026-10-22), track *Personal agents & data privacy*.

Live: https://haledy-agent.different-change.workers.dev

## Why

On September 16 the founder needed physical therapy in San Francisco on a PPO plan. A matching service put him on a "broadcast list", texted "hang in there" every two days for four weeks, then removed him with no match. A dozen clinic calls later, with name, plan and member ID repeated on each one, he still had no appointment. Haledy holds that context once, for the patient, and does the searching.

## What happens in the demo

1. **Vault.** The patient's context (insurer, plan, ZIP, care need, identifiers) is encrypted in the browser with AES-GCM-256. The key comes from a passphrase (PBKDF2-SHA256, 600,000 iterations) or a passkey (WebAuthn PRF). The server stores ciphertext under a random id: no account, no name, no email.
2. **Say it once.** "My back hurts, I need physical therapy this week." Identifiers typed into the request are removed on the device first.
3. **Consent grant.** The agent asks for specific fields, for a stated purpose, for a set time. Each field shows exactly what the AI would see (ZIP `94110` becomes `941`). The patient approves a subset and can revoke it mid-run; the next step drops those values and tells the agent.
4. **Search and reconcile, on public data.** CMS NPPES NPI Registry and CMS Doctors & Clinicians for providers; the Cigna and Regence public FHIR provider directories (CMS-mandated Plan-Net) for network status. Every claim carries its source, query URL and date.
5. **Ranked options** by network evidence, then ZIP area, then data freshness. The browser re-ranks with the full ZIP, which the AI never had.
6. **Outreach draft.** It opens with "This is Haledy, an AI assistant writing on behalf of {{first_name}}". Identifiers stay as `{{tokens}}` until the patient approves; the device fills them in.
7. **Transparency panels.** Audit log (field names, never values), *What the AI saw* (the exact text of every model step), *What our server holds*, and *Consent grants* with countdowns. *Forget me* deletes everything.

## Privacy model

- The model receives context with the HIPAA Safe Harbor identifiers removed (45 CFR 164.514(b)(2)): names, dates, phone, email, member and group numbers, city, and ZIP cut to three digits. `public/phi.js` is the single definition, used by the browser and the Worker.
- The Worker runs the scrubber again on every patient-originated message and refuses the model call, with an audit entry, if anything remains.
- Approved values travel with each step and are not stored. D1 holds ciphertext, grant metadata and the audit trail.
- Haledy acts for the patient; no clinic or plan has hired it. We do not claim HIPAA compliance. We build to its standards and treat the FTC Health Breach Notification Rule and California's CMIA as applying. Before any clinic or payer contract: BAAs (including the model provider), a Security Rule risk analysis and a SOC 2 plan.

## What the public data cannot tell you

| Source | Can confirm | Cannot confirm |
|---|---|---|
| CMS NPPES | A licensed physical therapist practices at this address | Insurance networks; records can be years old |
| CMS Doctors & Clinicians | Medicare enrolment, practice phone | Commercial plans |
| Cigna Plan-Net directory | Listed in a named Cigna network | That the listing is current, or benefits |
| Regence directory | Its own networks; SF providers appear only for Medicare Advantage | BlueCard PPO status: no public API has it |
| Any source | — | Open appointments: only the clinic knows |

When no public source can confirm, Haledy says "unverified". The next step is calling the payer and the clinic.

## Architecture

```
browser (vault, scrub, consent, token fill)  ->  Cloudflare Worker (grant checks, PHI guard, Claude tool loop, audit)  ->  CMS + payer FHIR APIs
                                                  D1: ciphertext, grants, audit (no values)
```

The browser drives the agent loop one step at a time; the Worker is stateless between steps and re-checks every grant on each step. Claude (Anthropic) plans and calls tools; without an API key a scripted planner runs the same tool sequence.

## Run it

Node 24+.

```
npm ci
npm run build
npx wrangler d1 migrations apply haledy-agent --local
npm run dev            # http://127.0.0.1:8788
npm test               # PHI scrubber + live public-data tests
node scripts/smoke.mjs # end-to-end against a running Worker
```

Add `ANTHROPIC_API_KEY` to `.dev.vars` (see `.dev.vars.example`) for model mode.

## Credits

All code in this repository was written during the event, by the founder working with Claude Code. The Haledy name, ladybug mark and the Instrument Serif / Manrope pairing predate the event. Fonts are under the SIL Open Font License. Provider data: CMS NPPES, CMS Provider Data Catalog, Cigna and Regence public provider directories.
