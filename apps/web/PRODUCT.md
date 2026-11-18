# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Desk-based staff of the organisations that share one inland mineral corridor, each working inside
their own organisation's context (docs/product.md §2):

- **Lender** (primary for the web demo): reviews pending advances, payment evidence and release
  requests; watches exposure and approves loading hand-offs.
- **Exporter (owner)**: manages positions, financing, release requests and shipment preparation.
- **Port terminal**, **buyer** and **accreditor** use web workspaces too. Custodians, hauliers
  and inspectors work mainly on the Android app.

One person may hold several roles, but they must deliberately switch organisation context.

**Scene (confirmed):** mostly office desktops during long review sessions at a bank credit desk
or exporter office, but also laptops at the stockyard or port office, sometimes in bright outdoor
light. The lender desk is the centre of the web demo; the exporter view comes second.

## Product Purpose

Thetis coordinates evidence, collateral locks, payment-confirmed releases and custody of mineral
lots (chrome first, manganese second) on the journey from inland stockpile to port. One exporter,
one independent custodian, one terminal and one professional lender share a registry (a Solana
Anchor program) that proves its own state transitions. Success is a lender who can release part
of a pledged lot against a confirmed payment without losing track of debt, collateral or custody.

## Positioning

The registry refuses what a shared spreadsheet or portal would allow: duplicate pledges, release
without a matching lender payment attestation, sale while ore is moving, and custody handovers
without both parties' signatures. It records who attested what, when, and against which document
version. It does not prove lawful origin, assays, possession, legal priority or bank settlement,
and the interface must never imply it does.

## Operating Context

- The web app opens on **work requiring attention**: each organisation's queue of missing
  evidence, awaiting signatures, unpaid release requests, arrival exceptions and loading
  approvals. A corridor map is only a secondary view.
- Core documents: weighbridge tickets, assay certificates, origin attestations, manifests, bills
  of lading, bank payment evidence.
- Two independent state dimensions are always visible. Custody: Stored, Awaiting departure, In
  transit, Partly arrived, Arrived, Loaded, Collected. Finance: Available, Pledged, Recovery,
  External hand-off, Repaid. Restrictions: Normal, Review required, Disputed, Frozen.
- Chain lifecycle: draft, awaiting signatures, submitted, confirmed, finalized, failed, outcome
  unknown. Third-party agreement is pending until completed; chain submission is pending until
  confirmed.

## Capabilities and Constraints

- Next.js + shadcn/ui on the web (a locked stack choice); Expo Android is a separate lane.
- Quantities are integer kilograms shown as tonnes; money is integer minor units. Large
  integers never pass through JavaScript `Number` (packages/domain).
- Release previews come from `@thetis/domain` `previewRelease`, the same deterministic
  calculation as the program.
- **Not yet available:** deployed program, API, Supabase auth, indexer. Until they exist the web
  app is a labelled design reference reading synthetic fixtures through one data adapter.

## Brand Commitments

- Name: Thetis. No logo or visual identity exists yet.
- Owner's standing preferences: no gold/amber/orange-yellow accents; no grid, graph-paper or
  blueprint backgrounds.

## Evidence on Hand

- Synthetic demo scenario: fixtures/web/demo-scenario.json (5,000 t chrome lot; USD 200/t; USD 600,000
  advance; 2,000 t sold for USD 400,000; generic east-coast port; synthetic parties).
- Release fixtures: fixtures/domain/release-examples.json.
- **Absent, never to be fabricated:** program addresses, transaction signatures, chain slots,
  real organisations, customers, market prices, savings claims.

## Product Principles

1. Never show a lot, lock, release or handover as done unless the program confirms it.
2. Every work item names its blocker, its next actor and the consequence of acting.
3. Keep separate facts separate: payment reported by lender vs release recorded on chain;
   registry retired vs debt repaid; checkpoint observed vs custody transferred.
4. Exact numbers with units, never rounded away or hidden in tooltips.
5. Touch, keyboard and typed paths always exist beside voice.

## Accessibility & Inclusion

WCAG AA. Never use colour alone for state; pair labels, icons and amounts. Keyboard and focus
order, screen-reader labels, zoom, and long entity names must all work (docs/product.md §5).
