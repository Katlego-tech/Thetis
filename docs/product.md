# Product and interaction design

This specification defines task flows and information hierarchy. It is not a visual mockup or a functioning app. The design serves the revised inland workflow; the combined research supplies hypotheses to measure.

## 1. Core experience

Open on **work requiring attention**, not a global map or token-price dashboard. Each organisation sees its queues: missing intake evidence, awaiting signatures, unpaid release requests, arrival exceptions or loading approvals. A corridor map is a secondary shipment view; it must distinguish reported locations from forecasts.

Every work item names the lot, quantity/grade, location, current organisation, next required actor, deadline and reason it is blocked. The next action explains its consequence: “Review payment evidence”, “Sign receipt of 34 t”, “Approve external hand-off”. Never imply a blockchain transaction is physical verification.

The two most important distinctions stay visible:

- **Custody:** Stored / Awaiting departure / In transit / Partly arrived / Arrived / Loaded / Collected.
- **Finance:** Available / Pledged / Recovery / External hand-off / Repaid. A Stored lot can be pledged; a Loaded record can still show outstanding debt.

Third-party agreement is pending until completed, and chain submission is pending until confirmed. Backend errors never become cached success. Ordinary touch/type interaction is always available beside voice.

## 2. Role workspaces

| Workspace | Primary queue and actions | Essential information |
|---|---|---|
| Custodian mobile | Intake, evidence review, dispatch, arrival, discrepancies | Site, quantity basis, origin/assay status, capacity, who will co-sign |
| Exporter web/mobile | Positions, financing, release requests, shipment preparation | Available/locked quantities, debt, value basis, payment allocation, shipment exceptions |
| Lender web | Pending advances/payments, releases, exposure, hand-off approvals | Facility currency, verified evidence, collateral coverage, reference freshness, authorised signers |
| Haulier mobile | Assigned batches, collection/delivery, delay observations | Manifest, vehicle/load identities, recipient, stage, connection state |
| Terminal mobile/web | Arrivals, stock balance, loading and collection | Accepted quantity, batch discrepancies, lender hand-off state, transport/collection evidence |
| Buyer web | Review purchase, payment instructions/evidence status, resulting position | Exact quantity, grade, price, debt-first allocation, documents, collection restrictions |
| Inspector mobile | Assigned observations and review requests | Method, measured result, tolerance policy, evidence; no automatic ownership mutation |
| Accreditor web | Organisations, sites, delegates, relationships and policies | Effective dates, scope, revocations, recovery requests, audit trail |

One person may have multiple roles, but must deliberately switch organisation context. Never infer permission because a screen can be opened. Public lock inspection is separate from access to private contracts and identity-linked financial records.

## 3. Screen contracts

### Work queue

Filters: organisation/site, task, state, overdue, assigned to me. Each row has one primary action and a specific blocker. Empty state explains the role's first useful task; error state offers refresh and support reference without losing drafts. Show projection freshness when stale.

### Lot dossier

Header: human label, root/child relationship, grade, atomic quantity basis, location, custody and finance states. Tabs: Overview, Evidence, Financing, Custody, Activity. Persistent actions are role/state-dependent. Display available, pledged, shipment-committed and discrepancy quantities without summing overlapping commitments as extra ore.

Overview emphasises what needs to happen next. Evidence distinguishes Uploaded, Extracted draft, Human-attested, Superseded, Revoked and Expired. Activity links signatures and source versions. Lender views show debt and coverage; public views show only public registry facts without private enrichment.

### Intake mobile

Select site/class → capture weighbridge/assay/origin originals → enter or review extracted values → confirm units and lawful-origin evidence → review issuer/owner/quantity → wallet signature → confirmed receipt. Missing mandatory origin prevents issuance with an actionable explanation. Duplicate intake shows the existing record instead of offering a new ID as an automatic workaround.

Files can upload later when offline; the draft remains explicitly unissued. AI highlights uncertain fields and where each value came from. An image is never declared genuine because extraction succeeded.

### Finance and release review

Show old debt, sold quantity, payment, top-up, new debt, remaining quantity, lender valuation, resulting coverage and any seller-surplus obligation. Include the exact currency and value timestamp. Display “Payment reported received by lender” separately from “Release recorded on chain”. A rejected residual-LTV check should show the additional amount required using the same deterministic calculation as the program preview.

For a stale preview: disable signing, fetch new state and show changed fields. Never retain an old signature for revised terms. Buyer sees the actual release terms before approving. Bank account details come only from the authorised institution's verified workflow; an agent cannot invent or substitute them.

### Handover mobile

Large sender/recipient names, load identities, quantity, grade, manifest summary, current stage and “What this signature confirms”. Scan QR → inspect message → verify wallet/org/network → sign → submit → show pending/confirmed receipt on both devices. Wrong-party rejection explains the required role without leaking unrelated accounts.

Separate **Report checkpoint** from **Transfer custody**. At a border where no new party takes possession, record an observation; do not ask an imagined border custodian to sign. A safe hands-free query answers status only; the driver does not sign or use an interactive screen while driving.

### Arrival and loading

Arrival lists expected, received and missing batches. “Partly arrived” does not enable lot-wide sale. After all batches reconcile, allow Stored operations, including the revised 2,000 t sale at port.

Loading review lists exact document version, quantity, owner, terminal, each lender acceptance and remaining debt. A missing acceptance blocks completion. The final screen distinguishes registry retirement from repayment and records the external hand-off. Stockyard collection is a different action with holder/custodian signatures and a weighbridge ticket.

### Exceptions

One queue groups uncertain transaction outcome, unmatched payment, expired signature, missing batch, changed evidence, disputed quantity, stale valuation and rejected hand-off. Each case has an owner, reason, next action and immutable history. “Retry” never means resubmit value blindly. All financial correction actions open a new reviewed intent.

## 4. Voice, reports and ETA

“What is missing?” retrieves deterministic requirements and permitted evidence status. “Open shipment X” navigates after resolving ambiguity. “Draft delay report” creates a marked draft. “Why is this amber?” explains computed loan health with value/date references. None of these instructions signs, changes custody, attests documents or transfers money.

Agent failures show actual status; navigation success requires client acknowledgment. Sensitive records are filtered before any provider call. Public navigation does not need repeated permission; private data-sharing follows the configured external-processing policy. The same role-based UI completes tasks when the audio service fails.

Dossiers show snapshot time, evidence manifest and state revision. Corrections mark older reports stale but do not edit them. An exported historical dossier visibly identifies itself as historical. ETA shows an interval, latest observation, assumptions and freshness; no estimate is preferable to fabricated precision. Delay observation is not proof of custody or automatic evidence of shortage.

## 5. Interaction and accessibility defaults

Design for outdoor Android use, readable numeric columns and substantial touch targets (target at least 48 dp on mobile). Do not use colour alone for state; pair labels, icons and amounts. Test keyboard/focus order on web, screen-reader labels, contrast, zoom and long translated/entity names. Do not hide units or negative consequences behind tooltips.

Financial values use grouped locale display with currency code; editing uses explicit decimal rules and server validation. Show tonnes plus the chosen dry/wet basis. Confirmation text uses concrete quantities and parties, not “Are you sure?”. Preserve drafts on navigation and recover after session expiry without preserving expired authority.

## 6. Pilot instrumentation

Capture task-start, evidence-ready, submitted, lender-reviewed, payment-attested, release-confirmed and physical-release timestamps separately. Distinguish system time from user-reported observation time. Record organisation/role and event category, not document bodies, voice transcripts, bank details or wallet secrets in general analytics.

Measure handling time, correction cycles, missing evidence, repeated manual work, failed signatures, on/offline delay and actual usable-funds time. Compare matched dossiers with an ordinary portal. Interview outcomes and paid acceptance are separate data from product activity. A shorter on-chain transaction does not demonstrate faster bank credit or physical delivery.

Commercial targets inherited from the research are hypotheses: lower median preparation/review labour, bounded field burden, positive full-cost customer benefit and a paid renewal. Do not optimise the demo to hide third-party work that the product merely displaced.
