# Data, API and integration contracts

Proposed contracts; no endpoints or tables are implemented yet.

## 1. Source-of-truth split

Chain: permissioned positions, lock allocations, debt records, confirmations consumed, custody transitions and retirement identities. Private database: identity, membership, confidential documents, jobs and searchable chain projections. External institutions: bank balances, legal rights and physical control. None can be substituted for another with a UI flag.

Principal off-chain tables:

| Tables | Ownership / invariants |
|---|---|
| organisations, memberships, signer_links | Auth user ↔ organisation ↔ wallet; linking proof and revocation history; chain delegation separately required |
| evidence_objects, evidence_versions, evidence_access | Immutable object identity, content digest, uploader, original MIME/size, parent revision, ACL and retention policy |
| contract_refs, bank_evidence | Private institution/facility records; no bank account or legal-document body in public metadata |
| intake_drafts, manifest_drafts, release_drafts | Editable until signed intent; signed payload digest never changes |
| chain_events, account_projections, indexer_checkpoints | Deduplicated network/program/signature/index; projection revision and commitment |
| command_attempts | Request payload hash, submitted signature, expected accounts/revisions, outcome and reconciliation status |
| jobs, job_attempts, job_outputs | Idempotent dispatch, input manifest hash, bounded retries, reviewed output; no direct chain authority |
| report_versions, report_sources | Immutable state/evidence manifest and content hash; supersedes/stale flags without overwriting old content |
| route_observations, forecasts, forecast_inputs | Event time vs receive time; labelled source, uncertainty, freshness, synthetic-data flag |
| audit_events, validation_measurements | Restricted audit history and anonymised operational timings; no secret payload logging |

Apply RLS by authorised membership **and entity relationship**, not just a tenant ID from the request. Multi-company shipment access is an explicit relationship grant; it does not grant access to every document held by another participant. Service-key jobs perform the same scope checks, with auditable purpose. Private buckets prohibit public URLs and overwrites. Signed URLs are short-lived bearer access: revocation strategy and TTL must match the sensitivity; do not promise instant revocation of a distributed link.

## 2. Authentication and signing

Proposed login: Supabase Auth with verified email link/OTP for pilot members, invitation-controlled organisation membership. Link a wallet using a single-use server challenge containing domain, user/org, nonce, expiry and intended action. Verify signature and consume nonce atomically; no signature reuse for login and transactions. Device/key loss uses audited recovery and new on-chain delegation; server session recovery does not recover a wallet secret.

Every mutation preview returns network, program instance, expected account revisions, expiry, human-readable effects and canonical payload digest. Wallet clients validate instruction allowlist and account relationships locally before signing. No backend API receives seed phrases/private keys. Embedded-wallet provider remains an explicit phase-0 selection; if unsuitable, use normal user-controlled wallet signing for the web demo and disclose the onboarding difference.

## 3. API surface

All routes have versioned schemas, authenticated caller context and stable machine-readable error codes. Network-derived authority is never inferred from a body `user_id` or `lender_id`.

| Route | Contract |
|---|---|
| `GET /v1/work-items` | Caller-scoped queue, pagination, assignment and projection freshness |
| `GET /v1/lots/{id}` | Authorised dossier projection; public inspection has a separate minimal response |
| `POST /v1/evidence/uploads` | Scoped immutable upload identity; size/type policy and permitted purpose |
| `POST /v1/evidence/{id}/finalize` | Server computes digest of stored original; validates ownership/size/type; no caller-supplied hash trust |
| `POST /v1/commands/preview` | Allowlisted intent kind + entity IDs; validates scope and returns unsigned typed intent/preconditions |
| `POST /v1/commands/{id}/submit` | Signed transaction bytes if API relay selected; never modifies signed message; returns signature, not fabricated completion |
| `GET /v1/commands/{id}` | Original signature/outcome and reconciled state; repeat reads never mutate value |
| `POST /v1/payments/drafts` | Private bank-evidence review draft; cannot create an authoritative on-chain confirmation |
| `POST /v1/jobs` | Allowed analysis type, input versions and idempotency key; returns existing compatible job on duplicate |
| `GET /v1/jobs/{id}` | Scoped status, evidence-backed output and review requirement |
| `GET /v1/reports/{id}/versions/{version}` | Immutable historical report with authorisation and freshness warnings |
| `POST /v1/conversations/session` | Authorised short-lived provider session, tool policy and permitted data scope |

Idempotency key is scoped by caller/organisation/action with canonical payload digest. Same key plus changed payload returns `IDEMPOTENCY_CONFLICT`. Database deduplication never substitutes for program-level consumed identities. Document schema examples use decimal strings, ISO timestamps and explicit versions, e.g. `amount_minor: "40000000", currency: "USD", quantity_atomic: "2000000", quantity_unit: "kg"`.

Error families: `NOT_AUTHORISED`, `STATE_CHANGED`, `VALUATION_STALE`, `CURRENCY_MISMATCH`, `EVIDENCE_REQUIRED`, `PAYMENT_ALREADY_CONSUMED`, `RESIDUAL_LIMIT_EXCEEDED`, `MANIFEST_INCOMPLETE`, `HANDOFF_NOT_ACCEPTED`, `TRANSACTION_OUTCOME_UNKNOWN`. User messages name the recoverable condition without exposing secrets.

## 4. Immutable evidence

Hash actual stored bytes, preserve the original, use content-addressed or versioned immutable object keys, and bind attestations to version plus digest. A correction creates a new object and supersession relationship. Existing signatures continue to point to the old original. Policies decide whether a new version invalidates a pending operation; execution checks current revocation and required version.

Scanned PDFs/photos are untrusted input. Quarantine unsupported formats, enforce bounds, scan/sanitise presentation, and do not execute embedded content. Extracted text is data, never instructions to tools. Restrict originals and derived outputs equally. External-processing permissions apply before sending any private bytes or field values to an AI provider.

On-chain evidence commitments include canonical schema version and subject binding. A document hash mismatch establishes different bytes, not forgery; reused bytes may be legitimate across lots, so source identity and applicability checks remain distinct from similarity alerts.

## 5. Voice and AI contracts

Keep the revised tools: `navigate_to`, `set_view_filters`, `prepare_form`, `get_lot_summary`, `get_shipment_status`, `get_document_requirements`, `get_loan_status`, `request_analysis`. Server resolves session and permissions independently of model arguments. Client tools use allowlisted screen/entity identifiers; no arbitrary URL or script.

Tool outputs carry allowed fields, evidence references, observation/chain time and freshness. Agent responses identify uncertainty and cannot imply loan approval. Sensitive lookups are minimised/redacted according to policy; when blocked, navigate to the private UI without exposing the data to the provider. Navigation/lookups authorised by the user's request do not trigger repetitive approvals; attestations and financial mutations always use the signed UI flow.

Job graph: extract → deterministic schema/unit validation → evidence consistency review → human review where required → snapshot-bound dossier draft. Logistics explanation uses authorised observations and computed ETA, never invents a route event. Bound retries, concurrency, elapsed time and spend; poison inputs terminate with visible failure. Job cancellation does not roll back chain events.

Store model/provider/version, template version, input digests, output references and evaluation result. Choose extraction models from labelled fixtures rather than marketing claims. Measure field-level accuracy separately from review rate and harmful false acceptance; 90% aggregate accuracy cannot justify unattended critical financial fields.

## 6. Reports, prices and forecasting

Each dossier version binds exact original evidence versions, chain revisions/slot, policy/valuation version and generated output hash. Corrections make the current report stale; regenerate to a new version and preserve authorised historic access.

Firecrawl jobs collect permitted public reference pages only. Record source URL, date, grade, unit, currency and delivery basis. No access to an index licence is assumed, and a failed scrape does not update lender valuation. Reference refresh and underwriting updates are distinct jobs.

ETA requires observed stage events, route version, historical samples and uncertainty. No usable history means “estimate unavailable” or a labelled synthetic demo interval. Evaluate historical replay error and interval coverage; expose late/out-of-order events and stale-input degradation. ETA never changes debt, custody or incident liability.
