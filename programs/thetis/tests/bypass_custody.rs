//! The custody bypass sweep (program-custody.md §9 `tests/bypass_custody.rs`, §11.1 and the 28 Nov
//! pre-check folds). Eleven tests against the Phase 3 custody instructions:
//!
//! * the direct Token-2022 cases of `tests/bypass.rs`, run against the vaults and the
//!   mint of a lot `InTransit`, as Alice (`Owner`) and as Mallory (`Outsider`);
//! * accounts of a second protocol instance (only the `protocol` field rewritten);
//! * the §9 last-byte line mutation of every signed text (`prepare_shipment`,
//!   `cancel_shipment`, `handover`, `record_observation`, `attest_shortfall`,
//!   `create_loading_intent`, `record_loading`);
//! * the two `*_fits_1232_bytes` size tests: the widest `handover` and `record_loading` as v0
//!   transactions against a lookup table of the whole fixture inventory (§11.1 item 3), with
//!   and without the compute-unit price, and the relay's shape (services/api `compile.ts`).
//!
//! Demo quantities, money and names are the demo's (5,000 t, 3,000 t, USD600,000, 20 c/kg,
//! haircut 0, LTV 60%, 1,200 bps) plus the bounds `u64::MAX`; the shortfall readings are §6.2's
//! labelled synthetic inputs (4,990 t observed, 50 bps tolerance). The demo cast is synthetic;
//! `Inspector Test Org` is the test-only inspector of §10, never seeded, and the second
//! terminal uses the harness's generated test name. Incident and shipment ids, digests, site
//! codes, nonces and expiries are deterministic synthetic test inputs.

mod common;

use anchor_lang::{
    __private::base64::{engine::general_purpose::STANDARD, Engine},
    error::ErrorCode as AnchorError,
    prelude::Pubkey,
    AccountSerialize, Event,
};
use anchor_spl::{
    associated_token::{
        get_associated_token_address_with_program_id,
        spl_associated_token_account::instruction::create_associated_token_account,
    },
    token_2022::spl_token_2022::{
        error::TokenError,
        extension::{BaseStateWithExtensions, StateWithExtensions},
        instruction::{self as token, AuthorityType},
        state::{Account as TokenAccount, AccountState, Mint},
    },
};
use common::{Actor::*, *};
use litesvm::types::TransactionMetadata;
use solana_message::{AddressLookupTableAccount, VersionedMessage};
use solana_transaction::{
    versioned::VersionedTransaction, AccountMeta, Instruction, InstructionError, TransactionError,
};
use thetis::{
    accounts,
    error::ThetisError::*,
    events, instruction,
    intent::message::{
        advance_message, cancel_shipment_message, custody_handover_message, issue_message,
        loading_intent_message, observation_message, pledge_message, prepare_shipment_message,
        record_loading_message, redeem_message, shortfall_message, split_message, transfer_message,
    },
    lending_math::accrue,
    manifest::{batch_leaf, node},
    state::*,
    ID,
};

const TOKEN_2022: Pubkey = anchor_spl::token_2022::ID;
const ASSOCIATED_TOKEN: Pubkey = anchor_spl::associated_token::ID;
const INSTRUCTIONS_SYSVAR: Pubkey = solana_sdk_ids::sysvar::instructions::ID;
const ED25519: Pubkey = solana_sdk_ids::ed25519_program::ID;
const COMPUTE_BUDGET: Pubkey = solana_sdk_ids::compute_budget::ID;
const PACKET_DATA_SIZE: usize = 1232;
const COMPUTE_UNIT_LIMIT: u32 = 400_000;

const DAY: i64 = 86_400;
const YEAR: i64 = 31_536_000;
const LOT_VALIDITY: i64 = 30 * DAY;
const AUTHORITY_LIFETIME: i64 = 2 * YEAR;
const VALUATION_VALIDITY: i64 = 2 * YEAR;
const DOCUMENT_VALIDITY: i64 = 10 * DAY;
/// The signing window the custody texts use, inside the 600 s custody window.
const CUSTODY_WINDOW: i64 = 570;
/// The signing window the money texts use, inside the 300 s money window.
const MONEY_WINDOW: i64 = 240;
/// A loading intent's lifetime in these tests.
const INTENT_LIFETIME: i64 = 2 * DAY;

/// The second protocol instance, initialised for real (16 × 0x02).
const OTHER_INSTANCE: [u8; 16] = [2; 16];

const CLASS_CODE: &str = "CHROME";
const GRADES: [&str; 2] = ["A", "B"];
const SOURCE_SITE: &str = "INLAND-YARD";
const TERMINAL_SITE: &str = "PORT-T1";
const OTHER_TERMINAL_SITE: &str = "PORT-T2";
/// Fixture capacities: the source holds two demo lots, the terminal exactly one (PORT-T1's
/// custodian class is 5,000 t).
const SOURCE_CAPACITY: u64 = 10_000_000;
const TERMINAL_CAPACITY: u64 = 5_000_000;

const LOT_ID: &str = "CR-0001";
const CHILD_LOT_ID: &str = "CR-0002";
const TWO_THOUSAND_T: u64 = 2_000_000;
/// The observation fixture: a border crossing photographed a minute before it is signed.
const LOCATION: &str = "BORDER-1";
const EVIDENCE: [u8; 32] = [0x77; 32];
const PHOTO_AGE: i64 = 60;
const INTAKE_DIGEST: [u8; 32] = [0x0a; 32];
const LOT_KG: u64 = 5_000_000;
const THREE_THOUSAND_T: u64 = 3_000_000;
const DEPARTURE_SHA: [u8; 32] = [0xdd; 32];
const COLLECTION_TICKET: [u8; 32] = [0xc7; 32];
/// The bill-of-lading digest: the vectors' 32 × 0xaa.
const LOADING_DOCUMENT: [u8; 32] = [0xaa; 32];

const USD: [u8; 3] = *b"USD";
const CENTS: u8 = 2;
const RATE_BPS: u16 = 1_200;
const MAX_LTV_BPS: u16 = 6_000;
/// 20 c/kg in cents.
const VALUE_PER_KG: u64 = 20;
const TERMS_DIGEST: [u8; 32] = [0x7d; 32];
const SOURCE_DIGEST: [u8; 32] = [0x5e; 32];
const FACILITY_ONE: [u8; 16] = [0x11; 16];

const OWNER_ID: u8 = 1;
const CUSTODIAN_ID: u8 = 2;
const TRANSPORTER_ID: u8 = 3;
const BUYER_ID: u8 = 4;
const TERMINAL_ID: u8 = 5;
const LENDER_ID: u8 = 7;
const INSPECTOR_ID: u8 = 9;
const OTHER_TERMINAL_ID: u8 = 10;

const OWNER_NAME: &str = "Khunou Ore Exports";
const CUSTODIAN_NAME: &str = "Kopano Stockyard Custody";
const TRANSPORTER_NAME: &str = "Mosela Haulage";
const BUYER_NAME: &str = "Buyer Smelter Co";
const TERMINAL_NAME: &str = "Port Terminal T1";
const LENDER_NAME: &str = "Lender One Bank";
const INSPECTOR_NAME: &str = "Inspector Test Org";

/// §6.2's synthetic shortfall inputs: incident id 16 × 0x88, method `WEIGH`, evidence
/// 32 × 0x99, 4,990 t observed against 5,000 t at 50 bps (within tolerance), observed 300 s
/// before the signing time.
const INCIDENT_ONE: [u8; 16] = [0x88; 16];
const INCIDENT_TWO: [u8; 16] = [0x89; 16];
const METHOD: &str = "WEIGH";
const SHORTFALL_EVIDENCE: [u8; 32] = [0x99; 32];
const OBSERVED_KG: u64 = 4_990_000;
const TOLERANCE_BPS: u16 = 50;

/// Account sizes, discriminator included (§7).
const LOADING_INTENT_SPACE: usize = 283;
const ACCEPTANCE_SPACE: usize = 213;
const INCIDENT_SPACE: usize = 227;

// ------------------------------------------------------------------ helpers ----

fn accredit(f: &mut Fixture, id: u8, role: Role, name: &str) -> Pubkey {
    let accredit = f.accredit(Accreditor, id, role, name);
    f.ok(accredit, Accreditor);
    f.organisation(id)
}

fn other_protocol() -> Pubkey {
    pda(&[b"protocol", &OTHER_INSTANCE])
}

fn compute_unit_limit() -> Instruction {
    Instruction {
        program_id: COMPUTE_BUDGET,
        accounts: vec![],
        data: [vec![2], COMPUTE_UNIT_LIMIT.to_le_bytes().to_vec()].concat(),
    }
}

fn sorted(mut keys: Vec<Pubkey>) -> Vec<Pubkey> {
    keys.sort();
    keys
}

fn serialized<T: AccountSerialize>(value: &T) -> Vec<u8> {
    let mut data = Vec::new();
    value.try_serialize(&mut data).unwrap();
    data
}

/// Account values compared by their serialised bytes (the account types derive no `PartialEq`).
fn assert_same<T: AccountSerialize>(actual: &T, expected: &T) {
    assert_eq!(serialized(actual), serialized(expected));
}

fn bump_of(seeds: &[&[u8]]) -> u8 {
    Pubkey::find_program_address(seeds, &ID).1
}

fn intent_key(position: Pubkey, nonce: u64) -> Pubkey {
    pda(&[b"loading", position.as_ref(), &nonce.to_le_bytes()])
}

fn acceptance_key(intent: Pubkey, loan: Pubkey) -> Pubkey {
    pda(&[b"handoff", intent.as_ref(), loan.as_ref()])
}

/// The events of a transaction, in log order, must be exactly `expected`.
fn assert_events(tx: &TransactionMetadata, expected: Vec<Vec<u8>>) {
    let expected: Vec<String> = expected.iter().map(|data| STANDARD.encode(data)).collect();
    assert_eq!(event_data(tx).collect::<Vec<_>>(), expected);
}

/// One manifest leaf (§6.3 "Merkle manifest").
#[derive(Clone, Debug)]
struct Leaf {
    index: u8,
    quantity_kg: u64,
    carrier: Pubkey,
    load_digest: [u8; 32],
    manifest_digest: [u8; 32],
}

/// A manifest, its root and each leaf's 4-level proof, built with the program's `batch_leaf`
/// and `node` over a 16-leaf tree padded with zero leaves.
#[derive(Clone, Debug)]
struct Manifest {
    root: [u8; 32],
    proofs: Vec<[[u8; 32]; 4]>,
}

impl Manifest {
    fn new(leaves: Vec<Leaf>) -> Self {
        let mut level: Vec<[u8; 32]> = leaves
            .iter()
            .map(|leaf| {
                batch_leaf(
                    leaf.index,
                    leaf.quantity_kg,
                    &leaf.carrier,
                    &leaf.load_digest,
                    &leaf.manifest_digest,
                )
            })
            .collect();
        level.resize(16, [0; 32]);
        let mut levels = vec![level];
        while levels.last().unwrap().len() > 1 {
            let below = levels.last().unwrap();
            let above = below
                .chunks_exact(2)
                .map(|pair| node(&pair[0], &pair[1]))
                .collect();
            levels.push(above);
        }
        let root = levels[4][0];
        let proofs = (0..leaves.len())
            .map(|index| {
                let mut proof = [[0; 32]; 4];
                for (depth, sibling) in proof.iter_mut().enumerate() {
                    *sibling = levels[depth][(index >> depth) ^ 1];
                }
                proof
            })
            .collect();
        Self { root, proofs }
    }
}

/// A lender organisation, its signing wallet and its facility to Khunou Ore Exports.
#[derive(Clone, Copy)]
struct Lender {
    actor: Actor,
    org: Pubkey,
    name: &'static str,
    facility_id: [u8; 16],
    facility: Pubkey,
}

/// One `create_loading_intent` call, with every input a test may vary.
#[derive(Clone)]
struct IntentArgs {
    holder: Pubkey,
    nonce: u64,
    document: [u8; 32],
    expires_at: i64,
    expected_revision: u64,
    valid_until: i64,
    custodian_class: Pubkey,
    terminal_org: Pubkey,
}

/// One `accept_loading` call.
#[derive(Clone, Copy)]
struct AcceptArgs {
    lender: Lender,
    loan: Pubkey,
    lock: Pubkey,
    intent: Pubkey,
    expected_revision: u64,
}

/// One accepted loan passed to `record_loading`.
#[derive(Clone, Copy, Debug, PartialEq)]
struct Triple {
    acceptance: Pubkey,
    loan: Pubkey,
    lock: Pubkey,
}

/// One `record_loading` call, with every input a test may vary.
#[derive(Clone)]
struct RecordArgs {
    intent: Pubkey,
    holder: Pubkey,
    triples: Vec<Triple>,
    /// The `Loan acceptances:` count printed in the signed text.
    loans_accepted: u8,
    expected_revision: u64,
    valid_until: i64,
    terminal_org: Pubkey,
    terminal_signer: Actor,
}

/// One `prepare_shipment` call, with every input a test may vary.
#[derive(Clone)]
struct PrepareArgs {
    holder: Pubkey,
    destination: Pubkey,
    document: Pubkey,
    shipment_id: [u8; 16],
    shipment: Pubkey,
    leaf: Leaf,
    manifest: Manifest,
    expected_revision: u64,
    valid_until: i64,
}

/// One `handover` call, with every input a test may vary.
#[derive(Clone)]
struct HandoverArgs {
    batch: Pubkey,
    to_org: Pubkey,
    expected_sequence: u64,
    valid_until: i64,
}

/// One `record_observation` call, with every input a test may vary.
#[derive(Clone)]
struct ObserveArgs {
    batch: Pubkey,
    shipment: Pubkey,
    lot: Pubkey,
    observer_signer: Actor,
    observer_org: Pubkey,
    holder_org: Pubkey,
    kind: ObservationKind,
    location_code: String,
    evidence_digest: [u8; 32],
    observed_at: i64,
    expected_observation: u32,
    valid_until: i64,
}

fn handover_key(batch: Pubkey, sequence: u64) -> Pubkey {
    pda(&[b"handover", batch.as_ref(), &sequence.to_le_bytes()])
}

/// A fiat protocol and a second, unused instance, with the demo cast plus `Inspector Test Org`;
/// a source site of Kopano Stockyard Custody and the terminal site PORT-T1 of Port Terminal T1
/// in the chrome class; CR-0001 (5,000 t, grade A) issued at the source to Khunou Ore Exports;
/// Lender One Bank. The driver's Authority holds `CARRY | OBSERVE`.
struct World {
    f: Fixture,
    now: i64,
    inspector: Pubkey,
    owner: Pubkey,
    custodian: Pubkey,
    transporter: Pubkey,
    buyer: Pubkey,
    terminal: Pubkey,
    other_terminal: Pubkey,
    lender_one: Lender,
    class_policy: Pubkey,
    source: Pubkey,
    terminal_class: Pubkey,
    /// The lot the loading helpers act on, its id and its family root when it is a child.
    lot: Pubkey,
    lot_id: String,
    root: Option<Pubkey>,
    lots: Vec<Pubkey>,
    shipments: Vec<Pubkey>,
    classes: Vec<Pubkey>,
    /// Every loan the world pledged, with its lock.
    loans: Vec<(Pubkey, Pubkey)>,
    trips: u8,
    document_versions: Vec<(Pubkey, u32)>,
    /// The organisations and Authorities the world created.
    orgs: Vec<Pubkey>,
    authorities: Vec<Pubkey>,
    /// Accounts the world's instructions created, for the lookup-table inventory.
    documents: Vec<Pubkey>,
    batches: Vec<Pubkey>,
    valuations: Vec<Pubkey>,
    intents: Vec<Pubkey>,
    acceptances: Vec<Pubkey>,
    /// Vaults a test has set to Frozen in the ledger.
    frozen: Vec<Pubkey>,
}

impl World {
    /// CR-0001 at the source, fiat.
    fn new() -> Self {
        let mut f = Fixture::new();
        let init = f.initialize_instance(INSTANCE, SettlementMode::FiatAttestationTest, Admin);
        f.ok(init, Admin);
        // A second protocol instance, initialised for real: the cross-protocol cases take their
        // `protocol` value from it.
        let other =
            f.initialize_instance(OTHER_INSTANCE, SettlementMode::FiatAttestationTest, Admin);
        f.ok(other, Admin);
        let register =
            f.register_with_origin(Accreditor, CLASS_CODE, 1, &GRADES, LOT_VALIDITY, false);
        f.ok(register, Accreditor);
        let class_policy = f.class(CLASS_CODE, 1);

        let owner = accredit(&mut f, OWNER_ID, Role::Exporter, OWNER_NAME);
        let custodian = accredit(&mut f, CUSTODIAN_ID, Role::Custodian, CUSTODIAN_NAME);
        let transporter = accredit(&mut f, TRANSPORTER_ID, Role::Transporter, TRANSPORTER_NAME);
        let buyer = accredit(&mut f, BUYER_ID, Role::Buyer, BUYER_NAME);
        let terminal = accredit(&mut f, TERMINAL_ID, Role::Terminal, TERMINAL_NAME);
        let lender_org = accredit(&mut f, LENDER_ID, Role::Lender, LENDER_NAME);
        let inspector = accredit(&mut f, INSPECTOR_ID, Role::Inspector, INSPECTOR_NAME);
        let other_terminal = f.add_org(OTHER_TERMINAL_ID, Role::Terminal);

        for (org, site, capacity) in [
            (custodian, SOURCE_SITE, SOURCE_CAPACITY),
            (terminal, TERMINAL_SITE, TERMINAL_CAPACITY),
            (other_terminal, OTHER_TERMINAL_SITE, TERMINAL_CAPACITY),
        ] {
            let accredit = f.accredit_site(Accreditor, org, class_policy, site, capacity);
            f.ok(accredit, Accreditor);
        }
        let source = f.site(custodian, class_policy, SOURCE_SITE);
        let terminal_class = f.site(terminal, class_policy, TERMINAL_SITE);
        let other_terminal_class = f.site(other_terminal, class_policy, OTHER_TERMINAL_SITE);

        let expires_at = NOW + AUTHORITY_LIFETIME;
        let mut authorities = Vec::new();
        for (org, wallet, scopes) in [
            (
                owner,
                Owner,
                scope::TRANSFER | scope::SPLIT | scope::REDEEM | scope::PLEDGE | scope::SHIP,
            ),
            (
                custodian,
                Custodian,
                scope::ISSUE | scope::REDEEM | scope::CARRY | scope::ATTEST_TRANSPORT,
            ),
            (
                terminal,
                Custodian2,
                scope::CARRY | scope::LOAD | scope::ATTEST_TRANSPORT,
            ),
            (other_terminal, Outsider, scope::CARRY | scope::LOAD),
            (transporter, Driver, scope::CARRY | scope::OBSERVE),
            (buyer, Buyer, scope::TRANSFER | scope::BUY | scope::SHIP),
            (lender_org, Lender, scope::LEND | scope::POOL),
            (inspector, Inspector, scope::INSPECT),
        ] {
            let delegate = f.delegate(OrgAdmin, org, f.key(wallet), scopes, expires_at);
            f.ok(delegate, OrgAdmin);
            authorities.push(f.authority(f.key(wallet)));
        }

        let protocol = f.protocol;
        let facility = |lender: Pubkey, id: &[u8; 16]| {
            pda(&[b"facility", protocol.as_ref(), lender.as_ref(), id])
        };
        let lot = pda(&[b"lot", protocol.as_ref(), LOT_ID.as_bytes()]);
        let mut world = Self {
            f,
            now: NOW,
            inspector,
            owner,
            custodian,
            transporter,
            buyer,
            terminal,
            other_terminal,
            lender_one: Lender {
                actor: Lender,
                org: lender_org,
                name: LENDER_NAME,
                facility_id: FACILITY_ONE,
                facility: facility(lender_org, &FACILITY_ONE),
            },
            class_policy,
            source,
            terminal_class,
            lot,
            lot_id: LOT_ID.into(),
            root: None,
            lots: Vec::new(),
            shipments: Vec::new(),
            classes: vec![source, terminal_class, other_terminal_class],
            loans: Vec::new(),
            trips: 0,
            document_versions: Vec::new(),
            orgs: vec![
                owner,
                custodian,
                transporter,
                buyer,
                terminal,
                other_terminal,
                lender_org,
                inspector,
            ],
            authorities,
            documents: Vec::new(),
            batches: Vec::new(),
            valuations: Vec::new(),
            intents: Vec::new(),
            acceptances: Vec::new(),
            frozen: Vec::new(),
        };
        world.issue_lot();
        world.assert_invariants();
        world
    }

    /// CR-0001 shipped to Port Terminal T1 and fully arrived there: `Stored` at PORT-T1, the
    /// owner the sole holder.
    fn at_terminal() -> Self {
        let mut world = Self::new();
        world.ship_to(world.terminal_class);
        world
    }

    fn authority_of(&self, actor: Actor) -> Pubkey {
        self.f.authority(self.f.key(actor))
    }

    fn position_key(lot: Pubkey, org: Pubkey) -> Pubkey {
        pda(&[b"position", lot.as_ref(), org.as_ref()])
    }

    fn position(&self) -> Pubkey {
        Self::position_key(self.lot, self.owner)
    }

    fn mint(lot: Pubkey) -> Pubkey {
        pda(&[b"mint", lot.as_ref()])
    }

    fn vault_authority(position: Pubkey) -> Pubkey {
        pda(&[b"vault", position.as_ref()])
    }

    fn vault(lot: Pubkey, position: Pubkey) -> Pubkey {
        get_associated_token_address_with_program_id(
            &Self::vault_authority(position),
            &Self::mint(lot),
            &TOKEN_2022,
        )
    }

    /// Kopano's intake identity for CR-0001 (the issuing custodian's PDA).
    fn intake(&self) -> Pubkey {
        pda(&[
            b"intake",
            self.f.protocol.as_ref(),
            self.custodian.as_ref(),
            &INTAKE_DIGEST,
        ])
    }

    fn name(&self, org: Pubkey) -> String {
        self.f.read::<Organisation>(org).display_name
    }

    fn lot_state(&self) -> Lot {
        self.f.read(self.lot)
    }

    fn position_state(&self) -> Position {
        self.f.read(self.position())
    }

    fn class_state(&self, class: Pubkey) -> CustodianClass {
        self.f.read(class)
    }

    fn loan_state(&self, loan: Pubkey) -> Loan {
        self.f.read(loan)
    }

    fn lock_state(&self, lock: Pubkey) -> LockAllocation {
        self.f.read(lock)
    }

    fn intent_state(&self, intent: Pubkey) -> LoadingIntent {
        self.f.read(intent)
    }

    /// The wallet the world delegated for `org`.
    fn signer_for(&self, org: Pubkey) -> Actor {
        if org == self.owner {
            Owner
        } else if org == self.buyer {
            Buyer
        } else if org == self.custodian {
            Custodian
        } else if org == self.transporter {
            Driver
        } else if org == self.terminal {
            Custodian2
        } else if org == self.other_terminal {
            Outsider
        } else if org == self.inspector {
            Inspector
        } else {
            panic!("no signer for {org}")
        }
    }

    /// Issues CR-0001 (5,000 t, grade A) at the source to Khunou Ore Exports.
    fn issue_lot(&mut self) {
        let valid_until = self.now + CUSTODY_WINDOW;
        let lot = self.lot;
        let position = self.position();
        let mint = Self::mint(lot);
        let text = issue_message(
            &ID,
            &INSTANCE,
            LOT_ID,
            CLASS_CODE,
            1,
            GRADES[0],
            LOT_KG,
            OWNER_NAME,
            CUSTODIAN_NAME,
            SOURCE_SITE,
            &INTAKE_DIGEST,
            None,
            valid_until,
        );
        let verify = ed25519_instruction(&[(self.f.signer(Custodian), text.as_slice())]);
        let issue = ix(
            accounts::IssueLot {
                sponsor: self.f.payer(),
                protocol: self.f.protocol,
                authority: self.authority_of(Custodian),
                owner: self.owner,
                custodian: self.custodian,
                class_policy: self.class_policy,
                custodian_class: self.source,
                origin: None,
                origin_issuer: None,
                intake: self.intake(),
                lot,
                mint,
                mint_authority: pda(&[b"mint_authority", mint.as_ref()]),
                position,
                vault_authority: Self::vault_authority(position),
                vault: Self::vault(lot, position),
                instructions: INSTRUCTIONS_SYSVAR,
                token_program: TOKEN_2022,
                associated_token_program: ASSOCIATED_TOKEN,
                system_program: SYSTEM,
            },
            instruction::IssueLot {
                lot_id: LOT_ID.into(),
                grade: GRADES[0].into(),
                quantity_kg: LOT_KG,
                intake_digest: INTAKE_DIGEST,
                valid_until,
            },
        );
        self.f.sponsored_ok(&[verify, issue]);
        assert_eq!(self.lot_state().state, LotState::Stored);
        self.lots.push(lot);
    }

    // ------------------------------------------------------------ shipments ----

    /// A departure document for the world's lot, attested by the organisation holding the lot's
    /// site (its next version).
    fn attest_departure(&mut self) -> Pubkey {
        let lot = self.lot;
        let site = self.class_state(self.lot_state().custodian_class);
        let version = match self
            .document_versions
            .iter_mut()
            .find(|(key, _)| *key == lot)
        {
            Some((_, version)) => {
                *version += 1;
                *version
            }
            None => {
                self.document_versions.push((lot, 1));
                1
            }
        };
        let issuer = site.custodian;
        let attest = self.f.attest(
            self.signer_for(issuer),
            issuer,
            DocumentKind::Departure,
            lot.to_bytes(),
            version,
            DEPARTURE_SHA,
            self.now + DOCUMENT_VALIDITY,
        );
        self.f.ok(attest, self.signer_for(issuer));
        let document = self
            .f
            .document(DocumentKind::Departure, lot.to_bytes(), version);
        self.documents.push(document);
        document
    }

    /// A departure document and the `holder`'s `prepare_shipment` of the world's lot to
    /// `destination` in one batch carried by Mosela Haulage, at the lot's current revision. The
    /// holder is the organisation whose position the lot is in (the owner, or the buyer after a
    /// transfer).
    fn prepare_args(&mut self, holder: Pubkey, destination: Pubkey) -> PrepareArgs {
        let document = self.attest_departure();
        let trip = self.trips;
        self.trips += 1;
        let lot = self.lot_state();
        let leaf = Leaf {
            index: 0,
            quantity_kg: lot.supply_kg,
            carrier: self.transporter,
            load_digest: [0x33_u8.wrapping_add(0x10 * trip); 32],
            manifest_digest: [0x44; 32],
        };
        let manifest = Manifest::new(vec![leaf.clone()]);
        let shipment_id = [0x22 + trip; 16];
        PrepareArgs {
            holder,
            destination,
            document,
            shipment_id,
            shipment: pda(&[b"shipment", self.f.protocol.as_ref(), &shipment_id]),
            leaf,
            manifest,
            expected_revision: lot.revision,
            valid_until: self.now + CUSTODY_WINDOW,
        }
    }

    /// The "Prepare shipment" text the program rebuilds from the accounts and the arguments.
    fn prepare_text(&self, args: &PrepareArgs) -> Vec<u8> {
        let lot = self.lot_state();
        let destination = self.class_state(args.destination);
        let document: DocumentAttestation = self.f.read(args.document);
        prepare_shipment_message(
            &ID,
            &INSTANCE,
            &lot.lot_id,
            &args.shipment_id,
            args.leaf.quantity_kg,
            &self.name(args.holder),
            &self.name(destination.custodian),
            &destination.site_code,
            1,
            &args.manifest.root,
            (&document.sha256, document.version),
            args.expected_revision,
            args.valid_until,
        )
    }

    fn prepare_instruction(&self, args: &PrepareArgs) -> Instruction {
        let lot = self.lot_state();
        let source = self.class_state(lot.custodian_class);
        let destination = self.class_state(args.destination);
        let position = Self::position_key(self.lot, args.holder);
        ix(
            accounts::PrepareShipment {
                sponsor: self.f.payer(),
                protocol: self.f.protocol,
                owner_org: args.holder,
                owner_authority: self.authority_of(self.signer_for(args.holder)),
                lot: self.lot,
                position,
                source_class: lot.custodian_class,
                destination_class: args.destination,
                destination_org: destination.custodian,
                departure_document: args.document,
                departure_issuer: source.custodian,
                shipment: args.shipment,
                instructions: INSTRUCTIONS_SYSVAR,
                system_program: SYSTEM,
            },
            instruction::PrepareShipment {
                shipment_id: args.shipment_id,
                batch_count: 1,
                manifest_root: args.manifest.root,
                expected_revision: args.expected_revision,
                valid_until: args.valid_until,
            },
        )
    }

    /// The holder's signature over `text`, then the instruction.
    fn prepare_signed(&self, args: &PrepareArgs, text: &[u8]) -> [Instruction; 2] {
        let signer = self.f.signer(self.signer_for(args.holder));
        [
            ed25519_instruction(&[(signer, text)]),
            self.prepare_instruction(args),
        ]
    }

    fn prepare_instructions(&self, args: &PrepareArgs) -> [Instruction; 2] {
        self.prepare_signed(args, &self.prepare_text(args))
    }

    /// The batch PDA of a prepared shipment's one leaf.
    fn batch_key(&self, args: &PrepareArgs) -> Pubkey {
        pda(&[b"batch", self.f.protocol.as_ref(), &args.leaf.load_digest])
    }

    /// `register_batch` of the one leaf of a prepared shipment.
    fn register_instruction(&self, args: &PrepareArgs) -> Instruction {
        ix(
            accounts::RegisterBatch {
                payer: self.f.payer(),
                protocol: self.f.protocol,
                shipment: args.shipment,
                batch: self.batch_key(args),
                system_program: SYSTEM,
            },
            instruction::RegisterBatch {
                index: 0,
                quantity_kg: args.leaf.quantity_kg,
                carrier: args.leaf.carrier,
                load_digest: args.leaf.load_digest,
                manifest_digest: args.leaf.manifest_digest,
                proof: args.manifest.proofs[0],
            },
        )
    }

    /// Prepares the world's lot from `holder` to `destination` in one batch carried by Mosela
    /// Haulage and registers it. Returns the shipment and its batch.
    fn prepare_from(&mut self, holder: Pubkey, destination: Pubkey) -> (Pubkey, Pubkey) {
        let args = self.prepare_args(holder, destination);
        let instructions = self.prepare_instructions(&args);
        self.f.sponsored_ok(&instructions);
        self.shipments.push(args.shipment);
        let batch = self.batch_key(&args);
        let register = self.register_instruction(&args);
        self.f.sponsored_ok(&[register]);
        self.batches.push(batch);
        assert_eq!(self.lot_state().state, LotState::Prepared);
        self.assert_invariants();
        (args.shipment, batch)
    }

    /// Prepares the world's lot from the owner to `destination`.
    fn prepare_to(&mut self, destination: Pubkey) -> (Pubkey, Pubkey) {
        self.prepare_from(self.owner, destination)
    }

    /// One handover of `batch` from its holder to `to_org`, at the batch's current sequence.
    fn handover_args(&self, batch: Pubkey, to_org: Pubkey) -> HandoverArgs {
        let stored: ManifestBatch = self.f.read(batch);
        HandoverArgs {
            batch,
            to_org,
            expected_sequence: stored.sequence,
            valid_until: self.now + CUSTODY_WINDOW,
        }
    }

    /// The "Hand over custody" text the program rebuilds from the accounts and the arguments.
    fn handover_text(&self, args: &HandoverArgs) -> Vec<u8> {
        let stored: ManifestBatch = self.f.read(args.batch);
        let shipment: Shipment = self.f.read(stored.shipment);
        let lot: Lot = self.f.read(stored.lot);
        let stage = if stored.stage == BatchStage::AtSource {
            HandoverStage::Departure
        } else {
            HandoverStage::Arrival
        };
        custody_handover_message(
            &ID,
            &INSTANCE,
            &lot.lot_id,
            &shipment.shipment_id,
            stored.index + 1,
            stored.batch_count,
            stored.quantity_kg,
            &self.name(stored.holder),
            &self.name(args.to_org),
            stage,
            &stored.manifest_digest,
            args.expected_sequence,
            args.valid_until,
        )
    }

    fn handover_instruction(&self, args: &HandoverArgs) -> Instruction {
        let stored: ManifestBatch = self.f.read(args.batch);
        let shipment: Shipment = self.f.read(stored.shipment);
        let at_source = stored.stage == BatchStage::AtSource;
        ix(
            accounts::Handover {
                sponsor: self.f.payer(),
                protocol: self.f.protocol,
                shipment: stored.shipment,
                batch: args.batch,
                lot: stored.lot,
                from_org: stored.holder,
                from_authority: self.authority_of(self.signer_for(stored.holder)),
                to_org: args.to_org,
                to_authority: self.authority_of(self.signer_for(args.to_org)),
                source_class: shipment.source,
                destination_class: shipment.destination,
                departure_document: at_source.then_some(shipment.departure_document),
                handover: handover_key(args.batch, args.expected_sequence),
                instructions: INSTRUCTIONS_SYSVAR,
                system_program: SYSTEM,
            },
            instruction::Handover {
                manifest_digest: stored.manifest_digest,
                expected_sequence: args.expected_sequence,
                valid_until: args.valid_until,
            },
        )
    }

    /// One Ed25519 instruction with two entries over one shared text, the holder first.
    fn handover_signed(&self, args: &HandoverArgs, text: &[u8]) -> [Instruction; 2] {
        let stored: ManifestBatch = self.f.read(args.batch);
        let signers = [
            self.f.signer(self.signer_for(stored.holder)),
            self.f.signer(self.signer_for(args.to_org)),
        ];
        [
            ed25519_shared_instruction(&signers, text),
            self.handover_instruction(args),
        ]
    }

    fn handover_instructions(&self, args: &HandoverArgs) -> [Instruction; 2] {
        self.handover_signed(args, &self.handover_text(args))
    }

    /// One handover of `batch` from its holder to `to_org`.
    fn hand_over(&mut self, batch: Pubkey, to_org: Pubkey) {
        let args = self.handover_args(batch, to_org);
        let instructions = self.handover_instructions(&args);
        self.f.sponsored_ok(&instructions);
        self.assert_invariants();
    }

    /// Prepares, registers, departs and arrives: the world's lot moves to `destination` and is
    /// `Stored` there.
    fn ship_to(&mut self, destination: Pubkey) -> Pubkey {
        let (shipment, batch) = self.prepare_to(destination);
        self.hand_over(batch, self.transporter);
        let destination_org = self.class_state(destination).custodian;
        self.hand_over(batch, destination_org);
        let lot = self.lot_state();
        assert_eq!(lot.state, LotState::Stored);
        assert_eq!(lot.custodian_class, destination);
        shipment
    }

    // -------------------------------------------------- Phase 1 instructions ----

    /// A `redeem` of `quantity_kg` of `lot` (with `root` when it is a child) from the owner's
    /// position, with `custodian` (signed by `signer`) at `site`, at the position's revision.
    fn redeem_instructions(
        &self,
        lot: Pubkey,
        root: Option<Pubkey>,
        quantity_kg: u64,
        signer: Actor,
        custodian: Pubkey,
        site: Pubkey,
    ) -> [Instruction; 2] {
        let position = Self::position_key(lot, self.owner);
        let revision = self.f.read::<Position>(position).revision;
        let lot_id = self.f.read::<Lot>(lot).lot_id;
        let valid_until = self.now + CUSTODY_WINDOW;
        let text = redeem_message(
            &ID,
            &INSTANCE,
            &lot_id,
            quantity_kg,
            OWNER_NAME,
            &self.name(custodian),
            &COLLECTION_TICKET,
            revision,
            valid_until,
        );
        let redeem = ix(
            accounts::Redeem {
                sponsor: self.f.payer(),
                protocol: self.f.protocol,
                owner_authority: self.authority_of(Owner),
                custodian_authority: self.authority_of(signer),
                owner: self.owner,
                custodian,
                custodian_class: site,
                lot,
                root,
                intake: self.intake(),
                mint: Self::mint(lot),
                position,
                vault_authority: Self::vault_authority(position),
                vault: Self::vault(lot, position),
                instructions: INSTRUCTIONS_SYSVAR,
                token_program: TOKEN_2022,
            },
            instruction::Redeem {
                quantity_kg,
                collection_ticket: COLLECTION_TICKET,
                expected_revision: revision,
                valid_until,
            },
        );
        let signers = [self.f.signer(Owner), self.f.signer(signer)];
        [ed25519_shared_instruction(&signers, &text), redeem]
    }

    // ----------------------------------------------------------------- lending ----

    /// The lender's facility to Khunou Ore Exports.
    fn open_facility(&mut self, lender: Lender) {
        let open = ix(
            accounts::OpenFacility {
                lender: self.f.key(lender.actor),
                payer: self.f.payer(),
                protocol: self.f.protocol,
                authority: self.authority_of(lender.actor),
                lender_org: lender.org,
                borrower_org: self.owner,
                facility: lender.facility,
                pool: None,
                system_program: SYSTEM,
            },
            instruction::OpenFacility {
                facility_id: lender.facility_id,
                currency: USD,
                currency_decimals: CENTS,
                terms_version: 1,
                rate_bps: RATE_BPS,
                max_ltv_bps: MAX_LTV_BPS,
                terms_digest: TERMS_DIGEST,
            },
        );
        self.f.signed_ok(&[open], lender.actor);
    }

    /// The lender's 20 c/kg valuation (haircut 0) of grade A at `class`.
    fn set_valuation(&mut self, lender: Lender, class: Pubkey) -> Pubkey {
        let valuation = pda(&[
            b"valuation",
            lender.facility.as_ref(),
            self.class_policy.as_ref(),
            GRADES[0].as_bytes(),
            class.as_ref(),
        ]);
        let set = ix(
            accounts::SetValuation {
                lender: self.f.key(lender.actor),
                payer: self.f.payer(),
                protocol: self.f.protocol,
                authority: self.authority_of(lender.actor),
                lender_org: lender.org,
                facility: lender.facility,
                class_policy: self.class_policy,
                custodian_class: class,
                valuation,
                system_program: SYSTEM,
            },
            instruction::SetValuation {
                grade: GRADES[0].into(),
                value_per_kg: VALUE_PER_KG,
                haircut_bps: 0,
                valid_until: NOW + VALUATION_VALIDITY,
                source_digest: SOURCE_DIGEST,
            },
        );
        self.f.signed_ok(&[set], lender.actor);
        self.valuations.push(valuation);
        valuation
    }

    /// A pledge of `quantity_kg` of the owner's position in the world's lot as the facility's
    /// next loan. Returns the loan and its lock.
    fn pledge(&mut self, lender: Lender, quantity_kg: u64) -> (Pubkey, Pubkey) {
        let facility: Facility = self.f.read(lender.facility);
        let loan_index = facility.loan_count;
        let loan = pda(&[b"loan", lender.facility.as_ref(), &loan_index.to_le_bytes()]);
        let lock = pda(&[b"lock", loan.as_ref()]);
        let revision = self.position_state().revision;
        let valid_until = self.now + MONEY_WINDOW;
        let text = pledge_message(
            &ID,
            &INSTANCE,
            &self.lot_id,
            quantity_kg,
            OWNER_NAME,
            lender.name,
            &lender.facility_id,
            loan_index,
            &USD,
            RATE_BPS,
            MAX_LTV_BPS,
            1,
            revision,
            valid_until,
        );
        let pledge = ix(
            accounts::Pledge {
                sponsor: self.f.payer(),
                protocol: self.f.protocol,
                lot: self.lot,
                position: self.position(),
                borrower_org: self.owner,
                borrower_authority: self.authority_of(Owner),
                lender_org: lender.org,
                lender_authority: self.authority_of(lender.actor),
                facility: lender.facility,
                loan,
                lock,
                instructions: INSTRUCTIONS_SYSVAR,
                system_program: SYSTEM,
            },
            instruction::Pledge {
                loan_index,
                quantity_kg,
                expected_revision: revision,
                valid_until,
            },
        );
        let signers = [self.f.signer(Owner), self.f.signer(lender.actor)];
        self.f
            .sponsored_ok(&[ed25519_shared_instruction(&signers, &text), pledge]);
        assert_eq!(self.lock_state(lock).quantity_kg, quantity_kg);
        self.loans.push((loan, lock));
        self.assert_invariants();
        (loan, lock)
    }

    /// A fiat `record_advance` of `amount` on `loan`, valued by `valuation`, at the loan's
    /// current revision.
    fn advance_instructions(
        &self,
        lender: Lender,
        loan: Pubkey,
        valuation: Pubkey,
        amount: u64,
    ) -> [Instruction; 2] {
        let stored = self.loan_state(loan);
        let valid_until = self.now + MONEY_WINDOW;
        let text = advance_message(
            &ID,
            &INSTANCE,
            &self.lot_id,
            OWNER_NAME,
            lender.name,
            &lender.facility_id,
            stored.index,
            amount,
            stored.principal + amount,
            &USD,
            CENTS,
            RATE_BPS,
            1,
            stored.revision,
            valid_until,
        );
        let advance = ix(
            accounts::RecordAdvance {
                lender: self.f.key(lender.actor),
                protocol: self.f.protocol,
                lender_authority: self.authority_of(lender.actor),
                lender_org: lender.org,
                facility: lender.facility,
                loan,
                lock: pda(&[b"lock", loan.as_ref()]),
                lot: self.lot,
                valuation,
                borrower_org: self.owner,
                borrower_authority: self.authority_of(Owner),
                instructions: INSTRUCTIONS_SYSVAR,
            },
            instruction::RecordAdvance {
                amount,
                currency: USD,
                expected_revision: stored.revision,
                valid_until,
            },
        );
        [
            ed25519_instruction(&[(self.f.signer(Owner), text.as_slice())]),
            advance,
        ]
    }

    fn advance(&mut self, lender: Lender, loan: Pubkey, valuation: Pubkey, amount: u64) {
        let instructions = self.advance_instructions(lender, loan, valuation, amount);
        self.f.signed_ok(&instructions, lender.actor);
    }

    // ----------------------------------------------------------------- loading ----

    /// A loading intent for `holder`'s position in the world's lot at the lot's current site,
    /// at the position's current revision.
    fn intent_args(&self, holder: Pubkey, nonce: u64, document: [u8; 32]) -> IntentArgs {
        let position: Position = self.f.read(Self::position_key(self.lot, holder));
        let class = self.lot_state().custodian_class;
        IntentArgs {
            holder,
            nonce,
            document,
            expires_at: self.now + INTENT_LIFETIME,
            expected_revision: position.revision,
            valid_until: self.now + CUSTODY_WINDOW,
            custodian_class: class,
            terminal_org: self.class_state(class).custodian,
        }
    }

    /// The "Prepare loading" text the program rebuilds from the accounts and the arguments.
    fn intent_text(&self, args: &IntentArgs) -> Vec<u8> {
        let position: Position = self.f.read(Self::position_key(self.lot, args.holder));
        loading_intent_message(
            &ID,
            &INSTANCE,
            &self.lot_state().lot_id,
            position.quantity_kg,
            &self.name(args.holder),
            &self.name(args.terminal_org),
            &self.class_state(args.custodian_class).site_code,
            &args.document,
            args.nonce,
            args.expires_at,
            args.expected_revision,
            args.valid_until,
        )
    }

    fn intent_instruction(&self, args: &IntentArgs) -> Instruction {
        let position = Self::position_key(self.lot, args.holder);
        ix(
            accounts::CreateLoadingIntent {
                sponsor: self.f.payer(),
                protocol: self.f.protocol,
                owner_org: args.holder,
                owner_authority: self.authority_of(self.signer_for(args.holder)),
                lot: self.lot,
                position,
                custodian_class: args.custodian_class,
                terminal_org: args.terminal_org,
                intent: intent_key(position, args.nonce),
                instructions: INSTRUCTIONS_SYSVAR,
                system_program: SYSTEM,
            },
            instruction::CreateLoadingIntent {
                nonce: args.nonce,
                document_sha256: args.document,
                expires_at: args.expires_at,
                expected_revision: args.expected_revision,
                valid_until: args.valid_until,
            },
        )
    }

    fn intent_instructions(&self, args: &IntentArgs) -> [Instruction; 2] {
        let text = self.intent_text(args);
        let signer = self.f.signer(self.signer_for(args.holder));
        [
            ed25519_instruction(&[(signer, text.as_slice())]),
            self.intent_instruction(args),
        ]
    }

    /// Creates the intent and checks the LoadingIntent, the position (revision + 1 only), the
    /// event and the invariants.
    fn create_intent_ok(&mut self, args: &IntentArgs) -> Pubkey {
        let position_key = Self::position_key(self.lot, args.holder);
        let intent = intent_key(position_key, args.nonce);
        let position_before: Position = self.f.read(position_key);
        let untouched = self.snapshot(&[
            self.lot,
            args.custodian_class,
            args.terminal_org,
            args.holder,
            Self::vault(self.lot, position_key),
        ]);
        let instructions = self.intent_instructions(args);
        let tx = self.f.sponsored_ok(&instructions);
        let mut position = position_before.clone();
        position.revision += 1;
        assert_same(&self.f.read::<Position>(position_key), &position);
        let expected = LoadingIntent {
            protocol: self.f.protocol,
            lot: self.lot,
            position: position_key,
            owner: args.holder,
            terminal: args.terminal_org,
            custodian_class: args.custodian_class,
            nonce: args.nonce,
            quantity_kg: position_before.quantity_kg,
            locked_kg: position_before.locked_kg,
            document_sha256: args.document,
            position_revision: args.expected_revision + 1,
            expires_at: args.expires_at,
            status: LoadingStatus::Open,
            executed_at: None,
            bump: bump_of(&[b"loading", position_key.as_ref(), &args.nonce.to_le_bytes()]),
        };
        assert_same(&self.intent_state(intent), &expected);
        self.intents.push(intent);
        assert_eq!(
            self.f.owner_and_data_len(intent),
            Some((ID, LOADING_INTENT_SPACE))
        );
        self.assert_unchanged(&untouched);
        assert_event(
            &tx,
            events::LoadingIntentCreated {
                intent,
                lot: self.lot,
                position: position_key,
                owner: args.holder,
                terminal: args.terminal_org,
                quantity_kg: position_before.quantity_kg,
                locked_kg: position_before.locked_kg,
                document_sha256: args.document,
                expires_at: args.expires_at,
                position_revision: args.expected_revision + 1,
            },
        );
        self.assert_invariants();
        intent
    }

    /// The owner's intent `nonce` with the vectors' bill of lading.
    fn create_intent(&mut self, nonce: u64) -> Pubkey {
        let args = self.intent_args(self.owner, nonce, LOADING_DOCUMENT);
        self.create_intent_ok(&args)
    }

    fn accept_args(&self, lender: Lender, loan: Pubkey, intent: Pubkey) -> AcceptArgs {
        AcceptArgs {
            lender,
            loan,
            lock: pda(&[b"lock", loan.as_ref()]),
            intent,
            expected_revision: self.loan_state(loan).revision,
        }
    }

    fn accept_instruction(&self, args: &AcceptArgs) -> Instruction {
        let intent = self.intent_state(args.intent);
        ix(
            accounts::AcceptLoading {
                lender: self.f.key(args.lender.actor),
                payer: self.f.payer(),
                protocol: self.f.protocol,
                authority: self.authority_of(args.lender.actor),
                lender_org: args.lender.org,
                facility: args.lender.facility,
                loan: args.loan,
                lock: args.lock,
                lot: intent.lot,
                position: intent.position,
                intent: args.intent,
                acceptance: acceptance_key(args.intent, args.loan),
                system_program: SYSTEM,
            },
            instruction::AcceptLoading {
                expected_revision: args.expected_revision,
            },
        )
    }

    /// Accepts and checks the HandoffAcceptance (the stored debt snapshot, no accrual), that
    /// no loan, lock or position changes, the event and the invariants.
    fn accept_ok(&mut self, args: &AcceptArgs) -> Pubkey {
        let acceptance = acceptance_key(args.intent, args.loan);
        let version_before = if self.f.account_exists(acceptance) {
            self.f.read::<HandoffAcceptance>(acceptance).version
        } else {
            0
        };
        let intent = self.intent_state(args.intent);
        let untouched = self.snapshot(&[
            args.loan,
            args.lock,
            intent.position,
            intent.lot,
            args.intent,
            args.lender.facility,
        ]);
        let loan = self.loan_state(args.loan);
        let lock = self.lock_state(args.lock);
        let tx = self
            .f
            .signed_ok(&[self.accept_instruction(args)], args.lender.actor);
        let expected = HandoffAcceptance {
            protocol: self.f.protocol,
            intent: args.intent,
            loan: args.loan,
            lock: args.lock,
            lender: args.lender.org,
            lock_quantity_kg: lock.quantity_kg,
            loan_revision: loan.revision,
            principal: loan.principal,
            booked_interest: loan.booked_interest,
            accepted_at: self.now,
            version: version_before + 1,
            bump: bump_of(&[b"handoff", args.intent.as_ref(), args.loan.as_ref()]),
        };
        assert_same(&self.f.read::<HandoffAcceptance>(acceptance), &expected);
        self.acceptances.push(acceptance);
        assert_eq!(
            self.f.owner_and_data_len(acceptance),
            Some((ID, ACCEPTANCE_SPACE))
        );
        self.assert_unchanged(&untouched);
        assert_event(
            &tx,
            events::LoadingAccepted {
                acceptance,
                intent: args.intent,
                loan: args.loan,
                lender: args.lender.org,
                lock_quantity_kg: lock.quantity_kg,
                loan_revision: loan.revision,
                principal: loan.principal,
                booked_interest: loan.booked_interest,
                version: version_before + 1,
            },
        );
        self.assert_invariants();
        acceptance
    }

    fn accept(&mut self, lender: Lender, loan: Pubkey, intent: Pubkey) -> Pubkey {
        let args = self.accept_args(lender, loan, intent);
        self.accept_ok(&args)
    }

    /// What the relay sends (field-app.md §6.3): for each of the position's locks with a
    /// positive quantity, its loan and the acceptance PDA when that exists, ascending raw loan
    /// key; `k` is the number of triples; the position's current revision.
    fn record_args(&self, holder: Pubkey, intent: Pubkey) -> RecordArgs {
        let position = Self::position_key(self.lot, holder);
        let mut triples: Vec<Triple> = self
            .loans
            .iter()
            .filter(|(_, lock)| {
                let lock = self.lock_state(*lock);
                lock.position == position && lock.quantity_kg > 0
            })
            .map(|(loan, lock)| Triple {
                acceptance: acceptance_key(intent, *loan),
                loan: *loan,
                lock: *lock,
            })
            .filter(|triple| self.f.account_exists(triple.acceptance))
            .collect();
        triples.sort_by_key(|triple| triple.loan);
        let stored = self.intent_state(intent);
        RecordArgs {
            intent,
            holder,
            loans_accepted: u8::try_from(triples.len()).unwrap(),
            triples,
            expected_revision: self.f.read::<Position>(position).revision,
            valid_until: self.now + CUSTODY_WINDOW,
            terminal_org: stored.terminal,
            terminal_signer: self.signer_for(stored.terminal),
        }
    }

    /// The "Record loading" text the program rebuilds from the accounts and the arguments.
    fn record_text(&self, args: &RecordArgs) -> Vec<u8> {
        let intent = self.intent_state(args.intent);
        record_loading_message(
            &ID,
            &INSTANCE,
            &self.lot_state().lot_id,
            intent.quantity_kg,
            &self.name(args.holder),
            &self.name(args.terminal_org),
            &intent.document_sha256,
            intent.nonce,
            intent.locked_kg,
            args.loans_accepted,
            args.expected_revision,
            args.valid_until,
        )
    }

    fn record_instruction(&self, args: &RecordArgs) -> Instruction {
        let position = Self::position_key(self.lot, args.holder);
        let mut instruction = ix(
            accounts::RecordLoading {
                sponsor: self.f.payer(),
                protocol: self.f.protocol,
                owner_org: args.holder,
                owner_authority: self.authority_of(self.signer_for(args.holder)),
                terminal_org: args.terminal_org,
                terminal_authority: self.authority_of(args.terminal_signer),
                custodian_class: self.lot_state().custodian_class,
                lot: self.lot,
                root: self.root,
                intake: self.intake(),
                mint: Self::mint(self.lot),
                position,
                vault_authority: Self::vault_authority(position),
                vault: Self::vault(self.lot, position),
                intent: args.intent,
                instructions: INSTRUCTIONS_SYSVAR,
                token_program: TOKEN_2022,
            },
            instruction::RecordLoading {
                expected_revision: args.expected_revision,
                valid_until: args.valid_until,
            },
        );
        for triple in &args.triples {
            instruction.accounts.extend([
                AccountMeta::new_readonly(triple.acceptance, false),
                AccountMeta::new(triple.loan, false),
                AccountMeta::new(triple.lock, false),
            ]);
        }
        instruction
    }

    /// One Ed25519 instruction with two entries over one shared text, the owner first.
    fn record_signed(&self, args: &RecordArgs, text: &[u8]) -> [Instruction; 2] {
        let signers = [
            self.f.signer(self.signer_for(args.holder)),
            self.f.signer(args.terminal_signer),
        ];
        [
            ed25519_shared_instruction(&signers, text),
            self.record_instruction(args),
        ]
    }

    fn record_instructions(&self, args: &RecordArgs) -> [Instruction; 2] {
        self.record_signed(args, &self.record_text(args))
    }

    /// Records the loading and checks every effect of §6.1 "record_loading effect": the burn,
    /// the position, lot, site, family, each loan and lock, the intent, the balances, the
    /// events in order and the invariants.
    fn record_ok(&mut self, args: &RecordArgs) -> TransactionMetadata {
        let position_key = Self::position_key(self.lot, args.holder);
        let class_key = self.lot_state().custodian_class;
        let position_before: Position = self.f.read(position_key);
        let lot_before = self.lot_state();
        let class_before = self.class_state(class_key);
        let root_before: Option<Lot> = self.root.map(|root| self.f.read(root));
        let intake_before: IntakeIdentity = self.f.read(self.intake());
        let intent_before = self.intent_state(args.intent);
        let loans_before: Vec<(Loan, LockAllocation)> = args
            .triples
            .iter()
            .map(|triple| (self.loan_state(triple.loan), self.lock_state(triple.lock)))
            .collect();
        let mut untouched = vec![args.holder, args.terminal_org, args.intent];
        untouched.retain(|key| *key != args.intent);
        untouched.extend(args.triples.iter().map(|triple| triple.acceptance));
        let untouched = self.snapshot(&untouched);
        let instructions = self.record_instructions(args);
        let tx = self.f.sponsored_ok(&instructions);
        let now = self.now;
        let q = position_before.quantity_kg;

        let mut position = position_before.clone();
        position.quantity_kg = 0;
        position.locked_kg = 0;
        position.revision += 1;
        assert_same(&self.f.read::<Position>(position_key), &position);
        let mut lot = lot_before.clone();
        lot.supply_kg -= q;
        lot.revision += 1;
        let lot_loaded = lot.supply_kg == 0;
        if lot_loaded {
            lot.state = LotState::Loaded;
        }
        assert_same(&self.lot_state(), &lot);
        let mut class = class_before.clone();
        class.occupied_kg -= q;
        assert_same(&self.class_state(class_key), &class);
        let mut intake = intake_before.clone();
        match root_before {
            Some(mut root) => {
                if lot_loaded {
                    root.live_children -= 1;
                }
                intake.retired = root.supply_kg == 0 && root.live_children == 0;
                assert_same(&self.f.read::<Lot>(self.root.unwrap()), &root);
            }
            None => intake.retired = lot.supply_kg == 0 && lot.live_children == 0,
        }
        assert_same(&self.f.read::<IntakeIdentity>(self.intake()), &intake);
        let mut intent = intent_before.clone();
        intent.status = LoadingStatus::Executed;
        intent.executed_at = Some(now);
        assert_same(&self.intent_state(args.intent), &intent);
        assert_eq!(self.f.token_amount(Self::vault(self.lot, position_key)), 0);
        assert_eq!(self.f.mint_supply(Self::mint(self.lot)), lot.supply_kg);

        let mut expected_events = vec![events::LoadingRecorded {
            intent: args.intent,
            lot: self.lot,
            position: position_key,
            owner: args.holder,
            terminal: args.terminal_org,
            quantity_kg: q,
            document_sha256: intent_before.document_sha256,
            loans_accepted: u8::try_from(args.triples.len()).unwrap(),
            lot_loaded,
            lot_revision: lot.revision,
            position_revision: position.revision,
        }
        .data()];
        for (triple, (loan_before, lock_before)) in args.triples.iter().zip(&loans_before) {
            let accrual = accrue(loan_before, now).unwrap();
            let mut loan = loan_before.clone();
            loan.booked_interest = accrual.booked_interest;
            loan.accrual_remainder = accrual.accrual_remainder;
            loan.accrued_at = now;
            let external_handoff = loan.principal > 0 || loan.booked_interest > 0;
            if external_handoff {
                loan.status = LoanStatus::ExternalHandoff;
            }
            loan.revision += 1;
            assert_same(&self.loan_state(triple.loan), &loan);
            let mut lock = lock_before.clone();
            lock.quantity_kg = 0;
            assert_same(&self.lock_state(triple.lock), &lock);
            expected_events.push(
                events::LoanHandedOff {
                    loan: triple.loan,
                    intent: args.intent,
                    released_kg: lock_before.quantity_kg,
                    principal: loan.principal,
                    booked_interest: loan.booked_interest,
                    external_handoff,
                    revision: loan.revision,
                }
                .data(),
            );
        }
        self.assert_unchanged(&untouched);
        assert_events(&tx, expected_events);
        self.assert_invariants();
        tx
    }

    // ------------------------------------------------------------ invariants ----

    fn snapshot(&self, keys: &[Pubkey]) -> Vec<(Pubkey, Option<RawAccount>)> {
        keys.iter()
            .map(|key| (*key, self.f.raw_account(*key)))
            .collect()
    }

    fn assert_unchanged(&self, snapshot: &[(Pubkey, Option<RawAccount>)]) {
        for (key, account) in snapshot {
            assert_eq!(&self.f.raw_account(*key), account, "{key} changed");
        }
    }

    /// Sends a refused transaction through `send` and asserts every account it names, other
    /// than the sponsor, is byte-identical afterwards (an absent one stays absent), §9.
    fn refused_untouched(
        &mut self,
        instructions: &[Instruction],
        send: impl FnOnce(&mut Fixture, &[Instruction]),
    ) {
        let payer = self.f.payer();
        let mut keys: Vec<Pubkey> = instructions
            .iter()
            .flat_map(|instruction| &instruction.accounts)
            .map(|meta| meta.pubkey)
            .filter(|key| *key != payer)
            .collect();
        keys.sort();
        keys.dedup();
        let before = self.snapshot(&keys);
        send(&mut self.f, instructions);
        self.assert_unchanged(&before);
    }

    /// §3 invariants: supply equals the sum of positions and each vault holds its position;
    /// `locked_kg` is the sum of the position's locks over non-`Closed` loans and within its
    /// quantity; `reserved_kg` stays 0; a lot is `Prepared` or `InTransit` exactly while it has
    /// one open shipment; each class's occupancy and reservation equal its ordinary stock plus
    /// the contributions of every open shipment touching it, within capacity; an
    /// `ExternalHandoff` loan's lock is `Pledged` and zero.
    fn assert_invariants(&self) {
        let open: Vec<Shipment> = self
            .shipments
            .iter()
            .map(|key| self.f.read::<Shipment>(*key))
            .filter(|shipment| {
                matches!(
                    shipment.status,
                    ShipmentStatus::Prepared | ShipmentStatus::InTransit
                )
            })
            .collect();
        for lot_key in &self.lots {
            let lot: Lot = self.f.read(*lot_key);
            let mut total = 0;
            for owner in [self.owner, self.buyer] {
                let position_key = Self::position_key(*lot_key, owner);
                if !self.f.account_exists(position_key) {
                    continue;
                }
                let position: Position = self.f.read(position_key);
                assert_eq!(position.reserved_kg, 0);
                assert!(position.locked_kg <= position.quantity_kg);
                let locked: u64 = self
                    .loans
                    .iter()
                    .map(|(loan, lock)| (self.loan_state(*loan), self.lock_state(*lock)))
                    .filter(|(loan, lock)| {
                        lock.position == position_key && loan.status != LoanStatus::Closed
                    })
                    .map(|(_, lock)| lock.quantity_kg)
                    .sum();
                assert_eq!(position.locked_kg, locked, "{position_key}");
                assert_eq!(
                    self.f.token_amount(Self::vault(*lot_key, position_key)),
                    position.quantity_kg
                );
                total += position.quantity_kg;
            }
            assert_eq!(total, lot.supply_kg);
            assert_eq!(self.f.mint_supply(Self::mint(*lot_key)), lot.supply_kg);
            let shipping = open
                .iter()
                .filter(|shipment| shipment.lot == *lot_key)
                .count();
            assert!(shipping <= 1);
            assert_eq!(
                matches!(lot.state, LotState::Prepared | LotState::InTransit),
                shipping == 1
            );
        }
        for (loan, lock) in &self.loans {
            let loan = self.loan_state(*loan);
            let lock = self.lock_state(*lock);
            if loan.status == LoanStatus::ExternalHandoff {
                assert_eq!(lock.control, LockControl::Pledged);
                assert_eq!(lock.quantity_kg, 0);
            }
        }
        for class_key in &self.classes {
            let class = self.class_state(*class_key);
            let ordinary: u64 = self
                .lots
                .iter()
                .map(|key| self.f.read::<Lot>(*key))
                .filter(|lot| lot.state == LotState::Stored && lot.custodian_class == *class_key)
                .map(|lot| lot.supply_kg)
                .sum();
            let leaving: u64 = open
                .iter()
                .filter(|shipment| shipment.source == *class_key)
                .map(|shipment| shipment.committed_kg - shipment.departed_kg)
                .sum();
            let arrived: u64 = open
                .iter()
                .filter(|shipment| shipment.destination == *class_key)
                .map(|shipment| shipment.arrived_kg)
                .sum();
            let reserved: u64 = open
                .iter()
                .filter(|shipment| shipment.destination == *class_key)
                .map(|shipment| shipment.committed_kg - shipment.arrived_kg)
                .sum();
            assert_eq!(
                class.occupied_kg,
                ordinary + leaving + arrived,
                "{class_key}"
            );
            assert_eq!(class.reserved_inbound_kg, reserved, "{class_key}");
            assert!(class.occupied_kg + class.reserved_inbound_kg <= class.approved_capacity_kg);
        }
    }
}

/// At PORT-T1 with Lender One Bank's loan 0 locking `quantity_kg` of the owner's position (no
/// advance) and a fresh Lender One valuation of the terminal's class.
fn terminal_with_lock(quantity_kg: u64) -> (World, Pubkey, Pubkey, Pubkey) {
    let mut w = World::at_terminal();
    let lender = w.lender_one;
    w.open_facility(lender);
    let valuation = w.set_valuation(lender, w.terminal_class);
    let (loan, lock) = w.pledge(lender, quantity_kg);
    (w, loan, lock, valuation)
}

// ============================================================ shortfall helpers ====

/// One `attest_shortfall` call, with every input a test may vary.
#[derive(Clone)]
struct ShortfallArgs {
    signer: Actor,
    inspector_org: Pubkey,
    incident_id: [u8; 16],
    batch: Option<Pubkey>,
    observed_kg: u64,
    tolerance_bps: u16,
    method_code: String,
    evidence_digest: [u8; 32],
    observed_at: i64,
    valid_until: i64,
}

fn incident_key(protocol: Pubkey, incident_id: &[u8; 16]) -> Pubkey {
    pda(&[b"incident", protocol.as_ref(), incident_id])
}

/// `shortfall × 10,000 <= expected × tolerance`, in `u128`, computed independently (§6.3).
fn within(expected_kg: u64, observed_kg: u64, tolerance_bps: u16) -> bool {
    u128::from(expected_kg - observed_kg) * 10_000
        <= u128::from(expected_kg) * u128::from(tolerance_bps)
}

impl World {
    /// Inspector Test Org's reading of §6.2's inputs (4,990 t observed, 50 bps) for `batch` or
    /// the whole lot, observed now and signed now.
    fn shortfall_args(&self, batch: Option<Pubkey>) -> ShortfallArgs {
        ShortfallArgs {
            signer: Inspector,
            inspector_org: self.inspector,
            incident_id: INCIDENT_ONE,
            batch,
            observed_kg: OBSERVED_KG,
            tolerance_bps: TOLERANCE_BPS,
            method_code: METHOD.into(),
            evidence_digest: SHORTFALL_EVIDENCE,
            observed_at: self.now,
            valid_until: self.now + CUSTODY_WINDOW,
        }
    }

    fn incident(&self, incident_id: &[u8; 16]) -> Pubkey {
        incident_key(self.f.protocol, incident_id)
    }

    /// The batch's quantity when a batch is named, else the lot's supply (§6.3).
    fn expected_kg(&self, args: &ShortfallArgs) -> u64 {
        match args.batch {
            Some(batch) => self.f.read::<ManifestBatch>(batch).quantity_kg,
            None => self.lot_state().supply_kg,
        }
    }

    /// The "Attest shortfall" text the program rebuilds from the accounts and the arguments.
    fn shortfall_text(&self, args: &ShortfallArgs) -> Vec<u8> {
        let batch: Option<ManifestBatch> = args.batch.map(|batch| self.f.read(batch));
        shortfall_message(
            &ID,
            &INSTANCE,
            &self.lot_state().lot_id,
            &args.incident_id,
            batch
                .as_ref()
                .map(|batch| (batch.index + 1, batch.batch_count, &batch.load_digest)),
            &self.name(args.inspector_org),
            &args.method_code,
            self.expected_kg(args),
            args.observed_kg,
            args.tolerance_bps,
            &args.evidence_digest,
            args.observed_at,
            args.valid_until,
        )
    }

    fn shortfall_instruction(&self, args: &ShortfallArgs) -> Instruction {
        ix(
            accounts::AttestShortfall {
                sponsor: self.f.payer(),
                protocol: self.f.protocol,
                inspector_org: args.inspector_org,
                inspector_authority: self.authority_of(args.signer),
                lot: self.lot,
                batch: args.batch,
                incident: self.incident(&args.incident_id),
                instructions: INSTRUCTIONS_SYSVAR,
                system_program: SYSTEM,
            },
            instruction::AttestShortfall {
                incident_id: args.incident_id,
                observed_kg: args.observed_kg,
                tolerance_bps: args.tolerance_bps,
                method_code: args.method_code.clone(),
                evidence_digest: args.evidence_digest,
                observed_at: args.observed_at,
                valid_until: args.valid_until,
            },
        )
    }

    fn shortfall_signed(&self, args: &ShortfallArgs, text: &[u8]) -> [Instruction; 2] {
        [
            ed25519_instruction(&[(self.f.signer(args.signer), text)]),
            self.shortfall_instruction(args),
        ]
    }

    fn shortfall_instructions(&self, args: &ShortfallArgs) -> [Instruction; 2] {
        self.shortfall_signed(args, &self.shortfall_text(args))
    }

    /// Attests and checks the Incident (every field), the lot (restriction and revision only,
    /// and only when a `Normal` lot is outside tolerance), that the inspector, its Authority,
    /// the batch and the lot's positions, vaults and mint are untouched, the event and the
    /// invariants. Returns the incident.
    fn attest_ok(&mut self, args: &ShortfallArgs) -> Pubkey {
        let incident = self.incident(&args.incident_id);
        let expected_kg = self.expected_kg(args);
        let lot_before = self.lot_state();
        let mut untouched = vec![
            args.inspector_org,
            self.authority_of(args.signer),
            Self::mint(self.lot),
        ];
        untouched.extend(args.batch);
        for owner in [self.owner, self.buyer] {
            let position = Self::position_key(self.lot, owner);
            untouched.extend([position, Self::vault(self.lot, position)]);
        }
        let untouched = self.snapshot(&untouched);
        let instructions = self.shortfall_instructions(args);
        let tx = self.f.sponsored_ok(&instructions);

        let within_tolerance = within(expected_kg, args.observed_kg, args.tolerance_bps);
        let mut lot = lot_before.clone();
        if !within_tolerance && lot_before.restriction == Restriction::Normal {
            lot.restriction = Restriction::ReviewRequired;
            lot.revision += 1;
        }
        assert_same(&self.lot_state(), &lot);
        let expected = Incident {
            protocol: self.f.protocol,
            incident_id: args.incident_id,
            lot: self.lot,
            batch: args.batch,
            inspector: args.inspector_org,
            method_code: args.method_code.clone(),
            expected_kg,
            observed_kg: args.observed_kg,
            tolerance_bps: args.tolerance_bps,
            within_tolerance,
            evidence_digest: args.evidence_digest,
            observed_at: args.observed_at,
            restriction_after: lot.restriction,
            status: IncidentStatus::Open,
            bump: bump_of(&[b"incident", self.f.protocol.as_ref(), &args.incident_id]),
        };
        assert_same(&self.f.read::<Incident>(incident), &expected);
        assert_eq!(
            self.f.owner_and_data_len(incident),
            Some((ID, INCIDENT_SPACE))
        );
        self.assert_unchanged(&untouched);
        assert_events(
            &tx,
            vec![events::ShortfallAttested {
                incident,
                lot: self.lot,
                batch: args.batch,
                inspector: args.inspector_org,
                expected_kg,
                observed_kg: args.observed_kg,
                tolerance_bps: args.tolerance_bps,
                within_tolerance,
                restriction: lot.restriction,
                lot_revision: lot.revision,
            }
            .data()],
        );
        self.assert_invariants();
        incident
    }
}

// ============================================================ custody helpers ====

impl World {
    // ---------------------------------------------------------------- cancel ----

    /// The "Cancel shipment" text the program rebuilds from the accounts and the arguments.
    fn cancel_text(&self, shipment: Pubkey) -> Vec<u8> {
        let stored: Shipment = self.f.read(shipment);
        let destination = self.class_state(stored.destination);
        cancel_shipment_message(
            &ID,
            &INSTANCE,
            &self.lot_id,
            &stored.shipment_id,
            &self.name(self.owner),
            &self.name(stored.destination_custodian),
            &destination.site_code,
            stored.revision,
            self.now + CUSTODY_WINDOW,
        )
    }

    fn cancel_instruction(&self, shipment: Pubkey) -> Instruction {
        let stored: Shipment = self.f.read(shipment);
        ix(
            accounts::CancelShipment {
                sponsor: self.f.payer(),
                protocol: self.f.protocol,
                owner_org: self.owner,
                owner_authority: self.authority_of(Owner),
                lot: stored.lot,
                shipment,
                destination_class: stored.destination,
                destination_org: stored.destination_custodian,
                instructions: INSTRUCTIONS_SYSVAR,
            },
            instruction::CancelShipment {
                expected_revision: stored.revision,
                valid_until: self.now + CUSTODY_WINDOW,
            },
        )
    }

    fn cancel_signed(&self, shipment: Pubkey, text: &[u8]) -> [Instruction; 2] {
        [
            ed25519_instruction(&[(self.f.signer(Owner), text)]),
            self.cancel_instruction(shipment),
        ]
    }

    fn cancel_instructions(&self, shipment: Pubkey) -> [Instruction; 2] {
        self.cancel_signed(shipment, &self.cancel_text(shipment))
    }

    // ----------------------------------------------------------- observation ----

    /// An observation of `batch` by `observer_org` (signed by `observer_signer`) at the
    /// batch's current holder and observation count, photographed `PHOTO_AGE` seconds ago.
    fn observe_args(
        &self,
        batch: Pubkey,
        observer_signer: Actor,
        observer_org: Pubkey,
        kind: ObservationKind,
    ) -> ObserveArgs {
        let stored: ManifestBatch = self.f.read(batch);
        ObserveArgs {
            batch,
            shipment: stored.shipment,
            lot: stored.lot,
            observer_signer,
            observer_org,
            holder_org: stored.holder,
            kind,
            location_code: LOCATION.into(),
            evidence_digest: EVIDENCE,
            observed_at: self.now - PHOTO_AGE,
            expected_observation: stored.observation_count,
            valid_until: self.now + CUSTODY_WINDOW,
        }
    }

    /// Mosela Haulage records the border crossing of a batch it holds (the demo beat).
    fn border_args(&self, batch: Pubkey) -> ObserveArgs {
        self.observe_args(batch, Driver, self.transporter, ObservationKind::Border)
    }

    /// The "Record observation" text the program rebuilds from the accounts and arguments.
    fn observation_text(&self, args: &ObserveArgs) -> Vec<u8> {
        let batch: ManifestBatch = self.f.read(args.batch);
        let shipment: Shipment = self.f.read(args.shipment);
        let lot: Lot = self.f.read(args.lot);
        observation_message(
            &ID,
            &INSTANCE,
            &lot.lot_id,
            &shipment.shipment_id,
            batch.index + 1,
            batch.batch_count,
            &self.name(args.holder_org),
            &self.name(args.observer_org),
            args.kind,
            &args.location_code,
            &args.evidence_digest,
            args.observed_at,
            args.expected_observation,
            args.valid_until,
        )
    }

    fn observation_instruction(&self, args: &ObserveArgs) -> Instruction {
        ix(
            accounts::RecordObservation {
                sponsor: self.f.payer(),
                protocol: self.f.protocol,
                observer_org: args.observer_org,
                observer_authority: self.authority_of(args.observer_signer),
                holder_org: args.holder_org,
                shipment: args.shipment,
                batch: args.batch,
                lot: args.lot,
                instructions: INSTRUCTIONS_SYSVAR,
            },
            instruction::RecordObservation {
                kind: args.kind,
                location_code: args.location_code.clone(),
                evidence_digest: args.evidence_digest,
                observed_at: args.observed_at,
                expected_observation: args.expected_observation,
                valid_until: args.valid_until,
            },
        )
    }

    /// One Ed25519 entry: the observer's signature over `text`.
    fn observation_signed(&self, args: &ObserveArgs, text: &[u8]) -> [Instruction; 2] {
        [
            ed25519_instruction(&[(self.f.signer(args.observer_signer), text)]),
            self.observation_instruction(args),
        ]
    }

    // ------------------------------------------------------ Phase 1 transfer ----

    /// A `transfer` of `quantity_kg` from the owner's position to Buyer Smelter Co, signed at
    /// the owner position's current revision.
    fn transfer_instructions(&self, quantity_kg: u64) -> [Instruction; 2] {
        let position = self.position();
        let revision = self.position_state().revision;
        let valid_until = self.now + CUSTODY_WINDOW;
        let text = transfer_message(
            &ID,
            &INSTANCE,
            &self.lot_id,
            quantity_kg,
            OWNER_NAME,
            BUYER_NAME,
            revision,
            valid_until,
        );
        let to_position = Self::position_key(self.lot, self.buyer);
        let transfer = ix(
            accounts::Transfer {
                sponsor: self.f.payer(),
                protocol: self.f.protocol,
                authority: self.authority_of(Owner),
                lot: self.lot,
                mint: Self::mint(self.lot),
                owner: self.owner,
                from_position: position,
                from_vault_authority: Self::vault_authority(position),
                from_vault: Self::vault(self.lot, position),
                recipient: self.buyer,
                to_position,
                to_vault_authority: Self::vault_authority(to_position),
                to_vault: Self::vault(self.lot, to_position),
                instructions: INSTRUCTIONS_SYSVAR,
                token_program: TOKEN_2022,
                associated_token_program: ASSOCIATED_TOKEN,
                system_program: SYSTEM,
            },
            instruction::Transfer {
                quantity_kg,
                expected_revision: revision,
                valid_until,
            },
        );
        [
            ed25519_instruction(&[(self.f.signer(Owner), text.as_slice())]),
            transfer,
        ]
    }

    /// A child lot of `quantity_kg` split from CR-0001 at the source, owned by the owner.
    /// Returns the child lot.
    fn split_child(&mut self, quantity_kg: u64) -> Pubkey {
        let root = self.lot;
        let lot = self.lot_state();
        let position = self.position();
        let child = pda(&[b"lot", self.f.protocol.as_ref(), CHILD_LOT_ID.as_bytes()]);
        let child_mint = Self::mint(child);
        let child_position = Self::position_key(child, self.owner);
        let valid_until = self.now + CUSTODY_WINDOW;
        let text = split_message(
            &ID,
            &INSTANCE,
            LOT_ID,
            CHILD_LOT_ID,
            quantity_kg,
            OWNER_NAME,
            CUSTODIAN_NAME,
            lot.revision,
            valid_until,
        );
        let split = ix(
            accounts::Split {
                sponsor: self.f.payer(),
                protocol: self.f.protocol,
                owner_authority: self.authority_of(Owner),
                custodian_authority: self.authority_of(Custodian),
                lot: root,
                root: None,
                class_policy: self.class_policy,
                custodian_class: self.source,
                owner: self.owner,
                custodian: self.custodian,
                mint: Self::mint(root),
                position,
                vault_authority: Self::vault_authority(position),
                vault: Self::vault(root, position),
                child_lot: child,
                child_mint,
                child_mint_authority: pda(&[b"mint_authority", child_mint.as_ref()]),
                child_position,
                child_vault_authority: Self::vault_authority(child_position),
                child_vault: Self::vault(child, child_position),
                instructions: INSTRUCTIONS_SYSVAR,
                token_program: TOKEN_2022,
                associated_token_program: ASSOCIATED_TOKEN,
                system_program: SYSTEM,
            },
            instruction::Split {
                child_lot_id: CHILD_LOT_ID.into(),
                quantity_kg,
                expected_revision: lot.revision,
                valid_until,
            },
        );
        let signers = [self.f.signer(Owner), self.f.signer(Custodian)];
        self.f
            .sponsored_ok(&[ed25519_shared_instruction(&signers, &text), split]);
        self.lots.push(child);
        child
    }

    // ------------------------------------------------------------ inventory ----

    /// §11.1 item 3's size-test inventory: every account the fixture world created, the fixed
    /// program and sysvar keys, and the Phase 3 accounts (the HandoverRecord PDAs for each
    /// batch's current sequence and for `u64::MAX`). At most 256 keys, as a table holds.
    fn inventory(&self) -> Vec<Pubkey> {
        let mut keys = vec![
            self.f.protocol,
            self.class_policy,
            SYSTEM,
            TOKEN_2022,
            ASSOCIATED_TOKEN,
            INSTRUCTIONS_SYSVAR,
            self.intake(),
        ];
        keys.extend(&self.classes);
        keys.extend(&self.orgs);
        keys.extend(&self.authorities);
        keys.extend(&self.documents);
        keys.extend(&self.shipments);
        keys.extend(&self.batches);
        keys.extend(&self.valuations);
        keys.extend(&self.intents);
        keys.extend(&self.acceptances);
        keys.push(self.lender_one.facility);
        for (loan, lock) in &self.loans {
            keys.extend([*loan, *lock]);
        }
        for lot in &self.lots {
            let mint = Self::mint(*lot);
            keys.extend([*lot, mint, pda(&[b"mint_authority", mint.as_ref()])]);
            for org in [self.owner, self.buyer] {
                let position = Self::position_key(*lot, org);
                keys.extend([
                    position,
                    Self::vault_authority(position),
                    Self::vault(*lot, position),
                ]);
            }
        }
        for batch in &self.batches {
            let sequence = self.f.read::<ManifestBatch>(*batch).sequence;
            keys.extend([
                handover_key(*batch, sequence),
                handover_key(*batch, u64::MAX),
            ]);
        }
        keys.sort();
        keys.dedup();
        assert!(keys.len() <= 256, "{} keys", keys.len());
        keys
    }
}

// ============================================== direct Token-2022 attacks, in transit ====

/// Everything decoded from a Token-2022 mint that an attack could change.
#[derive(Debug, PartialEq)]
struct MintState {
    is_initialized: bool,
    decimals: u8,
    supply: u64,
    mint_authority: Option<Pubkey>,
    freeze_authority: Option<Pubkey>,
}

/// Everything decoded from a Token-2022 account that an attack could change.
#[derive(Debug, PartialEq)]
struct VaultState {
    mint: Pubkey,
    owner: Pubkey,
    amount: u64,
    delegate: Option<Pubkey>,
    delegated_amount: u64,
    state: AccountState,
    close_authority: Option<Pubkey>,
}

#[derive(Debug, PartialEq)]
struct PositionView {
    owner: Pubkey,
    quantity_kg: u64,
    locked_kg: u64,
    reserved_kg: u64,
    revision: u64,
}

#[derive(Debug, PartialEq)]
struct LotView {
    mint: Pubkey,
    supply_kg: u64,
    state: LotState,
    restriction: Restriction,
    revision: u64,
    live_children: u32,
    expires_at: i64,
}

/// What a refused call must leave exactly as it was: every watched account whole, plus the
/// decoded mint, vaults, Positions and Lot (the sponsor is not watched; its fee is checked
/// apart).
#[derive(Debug, PartialEq)]
struct TokenState {
    accounts: Vec<(Pubkey, Option<RawAccount>)>,
    mint: MintState,
    lot: LotView,
    /// The owner's (Alice's) and the buyer's Position.
    positions: [Option<PositionView>; 2],
    /// The vaults of the same two organisations, in the same order.
    vaults: [Option<VaultState>; 2],
    /// Alice's personal associated token account, when it exists.
    personal: Option<VaultState>,
    /// Mallory's associated token account, when it exists.
    mallory: Option<VaultState>,
}

/// Where a refusal must come from: the instruction index, the `Custom` code and the program
/// that raises it.
struct Refusal {
    index: u8,
    code: u32,
    program: Pubkey,
}

impl World {
    /// The Token-2022 associated token account of a token owner for the lot's mint.
    fn ata_of(&self, token_owner: Pubkey) -> Pubkey {
        get_associated_token_address_with_program_id(
            &token_owner,
            &Self::mint(self.lot),
            &TOKEN_2022,
        )
    }

    /// An organisation's vault for the world's lot.
    fn vault_of(&self, org: Pubkey) -> Pubkey {
        Self::vault(self.lot, Self::position_key(self.lot, org))
    }

    fn mint_authority(&self) -> Pubkey {
        pda(&[b"mint_authority", Self::mint(self.lot).as_ref()])
    }

    /// Alice's personal associated token account for the lot's mint (not a vault).
    fn personal_ata(&self) -> Pubkey {
        self.ata_of(self.f.key(Owner))
    }

    /// Mallory's associated token account for the lot's mint.
    fn mallory_ata(&self) -> Pubkey {
        self.ata_of(self.f.key(Outsider))
    }

    /// An associated token account of `wallet`, created by the sponsor, asserted initialised
    /// and empty.
    fn create_ata(&mut self, wallet: Pubkey) {
        let create = create_associated_token_account(
            &self.f.payer(),
            &wallet,
            &Self::mint(self.lot),
            &TOKEN_2022,
        );
        self.f.sponsored_ok(&[create]);
        let account = self
            .read_token(self.ata_of(wallet))
            .expect("the token account exists");
        assert_eq!(account.mint, Self::mint(self.lot));
        assert_eq!(account.owner, wallet);
        assert_eq!(account.amount, 0);
        assert_eq!(account.state, AccountState::Initialized);
        assert_eq!(account.delegate, None);
        assert_eq!(account.close_authority, None);
    }

    /// Sets a vault to Frozen in the ledger, so a thaw has something to thaw.
    fn freeze_vault(&mut self, vault: Pubkey) {
        self.f.freeze_token_account(vault);
        self.frozen.push(vault);
        let frozen = self.read_token(vault).expect("the frozen vault");
        assert_eq!(frozen.state, AccountState::Frozen);
    }

    fn read_token(&self, address: Pubkey) -> Option<VaultState> {
        let account = self.f.raw_account(address)?;
        assert_eq!(
            account.owner, TOKEN_2022,
            "{address} is a Token-2022 account"
        );
        let token = StateWithExtensions::<TokenAccount>::unpack(&account.data)
            .expect("a Token-2022 account")
            .base;
        Some(VaultState {
            mint: token.mint,
            owner: token.owner,
            amount: token.amount,
            delegate: token.delegate.into(),
            delegated_amount: token.delegated_amount,
            state: token.state,
            close_authority: token.close_authority.into(),
        })
    }

    fn read_position_view(&self, org: Pubkey) -> Option<PositionView> {
        let address = Self::position_key(self.lot, org);
        if !self.f.account_exists(address) {
            return None;
        }
        let position: Position = self.f.read(address);
        Some(PositionView {
            owner: position.owner,
            quantity_kg: position.quantity_kg,
            locked_kg: position.locked_kg,
            reserved_kg: position.reserved_kg,
            revision: position.revision,
        })
    }

    /// Every account a direct token call could reach or a custody change would touch: the
    /// protocol, the organisations, the classes, the shipments, batches and departure
    /// documents, every HandoverRecord the batches have (and the next, absent one), the lot,
    /// mint and its authority, the Authorities, both personal accounts, and the position, vault
    /// authority and vault of the owner and the buyer; plus the writable accounts of the
    /// instruction (such as the wallet receiving lamports from a close attempt). The sponsor's
    /// fee is checked separately.
    fn watched(&self, instructions: &[Instruction]) -> Vec<Pubkey> {
        let mut keys = vec![
            self.f.protocol,
            self.class_policy,
            self.lot,
            Self::mint(self.lot),
            self.mint_authority(),
            self.intake(),
            self.personal_ata(),
            self.mallory_ata(),
        ];
        keys.extend(&self.orgs);
        keys.extend(&self.authorities);
        keys.extend(&self.classes);
        keys.extend(&self.shipments);
        keys.extend(&self.batches);
        keys.extend(&self.documents);
        for batch in &self.batches {
            let sequence = self.f.read::<ManifestBatch>(*batch).sequence;
            keys.extend((0..=sequence).map(|used| handover_key(*batch, used)));
        }
        for org in [self.owner, self.buyer] {
            let position = Self::position_key(self.lot, org);
            keys.extend([
                position,
                Self::vault_authority(position),
                Self::vault(self.lot, position),
            ]);
        }
        let payer = self.f.payer();
        keys.extend(
            instructions
                .iter()
                .flat_map(|instruction| &instruction.accounts)
                .filter(|account| account.is_writable && account.pubkey != payer)
                .map(|account| account.pubkey),
        );
        keys.sort_unstable();
        keys.dedup();
        keys
    }

    fn capture_tokens(&self, instructions: &[Instruction]) -> TokenState {
        let mint_account = self
            .f
            .raw_account(Self::mint(self.lot))
            .expect("the lot's mint");
        assert_eq!(mint_account.owner, TOKEN_2022);
        let mint = StateWithExtensions::<Mint>::unpack(&mint_account.data).expect("a mint");
        assert!(
            mint.get_extension_types().unwrap().is_empty(),
            "the receipt mint has no Token-2022 extension"
        );
        let mint = MintState {
            is_initialized: mint.base.is_initialized,
            decimals: mint.base.decimals,
            supply: mint.base.supply,
            mint_authority: mint.base.mint_authority.into(),
            freeze_authority: mint.base.freeze_authority.into(),
        };
        let lot = self.lot_state();
        let orgs = [self.owner, self.buyer];
        TokenState {
            accounts: self
                .watched(instructions)
                .into_iter()
                .map(|key| (key, self.f.raw_account(key)))
                .collect(),
            mint,
            lot: LotView {
                mint: lot.mint,
                supply_kg: lot.supply_kg,
                state: lot.state,
                restriction: lot.restriction,
                revision: lot.revision,
                live_children: lot.live_children,
                expires_at: lot.expires_at,
            },
            positions: orgs.map(|org| self.read_position_view(org)),
            vaults: orgs.map(|org| self.read_token(self.vault_of(org))),
            personal: self.read_token(self.personal_ata()),
            mallory: self.read_token(self.mallory_ata()),
        }
    }

    /// The ADR 0001 configuration, asserted on a captured state of a lot in transit: the mint
    /// has no extension and the PDA is both its mint and freeze authority; every vault is held
    /// by its own PDA with no delegate and no close authority and holds what its Position
    /// says; the supply is the Lot's and the sum of the Positions; the personal accounts are
    /// empty and their owners'.
    fn assert_token_invariants(&self, state: &TokenState) {
        let pda = Some(self.mint_authority());
        assert_eq!(state.lot.state, LotState::InTransit);
        assert!(state.mint.is_initialized);
        assert_eq!(state.mint.decimals, 0);
        assert_eq!(state.mint.mint_authority, pda);
        assert_eq!(state.mint.freeze_authority, pda);
        assert_eq!(state.lot.mint, Self::mint(self.lot));
        assert_eq!(state.mint.supply, state.lot.supply_kg);
        let held: u64 = state
            .positions
            .iter()
            .flatten()
            .map(|p| p.quantity_kg)
            .sum();
        assert_eq!(state.mint.supply, held);

        let orgs = [self.owner, self.buyer];
        for ((org, position), vault) in orgs.iter().zip(&state.positions).zip(&state.vaults) {
            match (position, vault) {
                (Some(position), Some(vault)) => {
                    assert_eq!(position.owner, *org);
                    assert_eq!(position.reserved_kg, 0);
                    assert_eq!(vault.mint, Self::mint(self.lot));
                    assert_eq!(
                        vault.owner,
                        Self::vault_authority(Self::position_key(self.lot, *org))
                    );
                    assert_eq!(vault.amount, position.quantity_kg);
                    assert_eq!(vault.delegate, None);
                    assert_eq!(vault.delegated_amount, 0);
                    assert_eq!(vault.close_authority, None);
                    let expected = if self.frozen.contains(&self.vault_of(*org)) {
                        AccountState::Frozen
                    } else {
                        AccountState::Initialized
                    };
                    assert_eq!(vault.state, expected);
                }
                (None, None) => {}
                _ => panic!("a Position and its vault exist together or not at all"),
            }
        }
        // The owner always holds a Position, and so a vault, even at zero.
        assert!(state.positions[0].is_some() && state.vaults[0].is_some());

        for (personal, wallet) in [
            (&state.personal, self.f.key(Owner)),
            (&state.mallory, self.f.key(Outsider)),
        ] {
            if let Some(personal) = personal {
                assert_eq!(personal.mint, Self::mint(self.lot));
                assert_eq!(personal.owner, wallet);
                assert_eq!(personal.amount, 0);
                assert_eq!(personal.delegate, None);
                assert_eq!(personal.delegated_amount, 0);
                assert_eq!(personal.close_authority, None);
                assert_eq!(personal.state, AccountState::Initialized);
            }
        }
    }

    /// Sends `instructions` signed by the sponsor and `actor`, and asserts the transaction
    /// fails at `index` with `Custom(code)` raised by `program` (and no other program), that
    /// nothing but the sponsor's fee changed, and that no event was emitted.
    fn refuse(
        &mut self,
        label: &str,
        instructions: &[Instruction],
        actor: Actor,
        expected: Refusal,
    ) {
        let Refusal {
            index,
            code,
            program,
        } = expected;
        let before = self.capture_tokens(instructions);
        self.assert_token_invariants(&before);
        let payer = self.f.payer();
        let payer_before = self.f.balance(payer);

        let failure = match self.f.send_signed(instructions, actor) {
            Err(failure) => failure,
            Ok(success) => panic!("{label} unexpectedly succeeded: {:?}", success.logs),
        };
        let logs = failure.meta.pretty_logs();

        assert_eq!(
            failure.err,
            TransactionError::InstructionError(index, InstructionError::Custom(code)),
            "{label}\n{logs}"
        );
        let failed: Vec<&String> = failure
            .meta
            .logs
            .iter()
            .filter(|line| line.contains(" failed: "))
            .collect();
        assert_eq!(
            failed,
            [&format!(
                "Program {program} failed: custom program error: {code:#x}"
            )],
            "{label} failed in the wrong program\n{logs}"
        );
        assert!(
            event_data(&failure.meta).next().is_none(),
            "{label} emitted an event\n{logs}"
        );

        // The sponsor pays the fee for a refused transaction and nothing else.
        assert!(failure.meta.fee > 0);
        assert_eq!(
            self.f.balance(payer) + failure.meta.fee,
            payer_before,
            "{label} cost the sponsor more than its fee"
        );
        let after = self.capture_tokens(instructions);
        assert_eq!(before, after, "{label} changed receipt state\n{logs}");
        self.assert_token_invariants(&after);
    }

    /// Runs one direct Token-2022 call twice, as Alice and then as Mallory, each as a separate
    /// transaction. `build` makes the instruction for the signer, who is named as the
    /// authority in it. Both must fail in the token program with `expected` and change nothing.
    fn refuse_token(
        &mut self,
        label: &str,
        expected: TokenError,
        build: impl Fn(&World, Pubkey) -> Instruction,
    ) {
        let name = format!("{expected:?}");
        let code = expected as u32;
        for (who, actor) in [("Alice", Owner), ("Mallory", Outsider)] {
            let signer = self.f.key(actor);
            let instruction = build(self, signer);
            assert_eq!(instruction.program_id, TOKEN_2022);
            let label = format!("{label} ({who}) -> {name}");
            let expected = Refusal {
                index: 0,
                code,
                program: TOKEN_2022,
            };
            self.refuse(&label, &[instruction], actor, expected);
        }
    }
}
/// One copy of `text` per line, with that line's last byte replaced by `a` (or `b` if it was
/// `a`), §9.
fn line_mutations(text: &[u8]) -> Vec<Vec<u8>> {
    let mut ends: Vec<usize> = text
        .iter()
        .enumerate()
        .filter(|(_, byte)| **byte == b'\n')
        .map(|(index, _)| index - 1)
        .collect();
    ends.push(text.len() - 1);
    ends.into_iter()
        .map(|end| {
            let mut mutated = text.to_vec();
            mutated[end] = if mutated[end] == b'a' { b'b' } else { b'a' };
            mutated
        })
        .collect()
}

// ================================================================== fixtures ====

/// A world at PORT-T1 with one 3,000 t lock of Lender One Bank (loan 0), the intent not yet
/// created. Returns the world and the loan.
fn loading_fixture() -> (World, Pubkey) {
    let (w, loan, _, _) = terminal_with_lock(THREE_THOUSAND_T);
    (w, loan)
}

/// As `loading_fixture`, with the owner's intent 1 created and the lender's acceptance of it:
/// `record_loading` is ready, with one triple.
fn accepted_fixture() -> (World, Pubkey) {
    let (mut w, loan) = loading_fixture();
    let intent = w.create_intent(1);
    let lender = w.lender_one;
    w.accept(lender, loan, intent);
    (w, intent)
}

// ============================================================ in-transit tokens ====

#[test]
fn in_transit_vault_direct_token_paths_refused() {
    // Fixture A: CR-0001 prepared to PORT-T1, registered and departed (Kopano Stockyard Custody
    // to Mosela Haulage): InTransit, Khunou Ore Exports the sole holder.
    let mut w = World::new();
    let (_, batch) = w.prepare_to(w.terminal_class);
    w.hand_over(batch, w.transporter);
    assert_eq!(w.lot_state().state, LotState::InTransit);
    assert_eq!(w.lot_state().supply_kg, LOT_KG);
    assert_eq!(w.position_state().quantity_kg, LOT_KG);
    let vault = w.vault_of(w.owner);
    assert_eq!(w.f.token_amount(vault), LOT_KG);
    // Mallory's account is the destination of the transfers and the delegate is her wallet;
    // Alice's personal account takes the two personal-account cases.
    let (alice, mallory) = (w.f.key(Owner), w.f.key(Outsider));
    w.create_ata(alice);
    w.create_ata(mallory);

    w.refuse_token("Transfer", TokenError::OwnerMismatch, |w, signer| {
        #[allow(deprecated)]
        let transfer = token::transfer(
            &TOKEN_2022,
            &w.vault_of(w.owner),
            &w.mallory_ata(),
            &signer,
            &[],
            1,
        );
        transfer.unwrap()
    });
    w.refuse_token("TransferChecked", TokenError::OwnerMismatch, |w, signer| {
        token::transfer_checked(
            &TOKEN_2022,
            &w.vault_of(w.owner),
            &World::mint(w.lot),
            &w.mallory_ata(),
            &signer,
            &[],
            1,
            0,
        )
        .unwrap()
    });
    w.refuse_token("Burn", TokenError::OwnerMismatch, |w, signer| {
        token::burn(
            &TOKEN_2022,
            &w.vault_of(w.owner),
            &World::mint(w.lot),
            &signer,
            &[],
            1,
        )
        .unwrap()
    });
    w.refuse_token("BurnChecked", TokenError::OwnerMismatch, |w, signer| {
        token::burn_checked(
            &TOKEN_2022,
            &w.vault_of(w.owner),
            &World::mint(w.lot),
            &signer,
            &[],
            1,
            0,
        )
        .unwrap()
    });
    w.refuse_token("Approve", TokenError::OwnerMismatch, |w, signer| {
        token::approve(
            &TOKEN_2022,
            &w.vault_of(w.owner),
            &w.f.key(Outsider),
            &signer,
            &[],
            1,
        )
        .unwrap()
    });
    w.refuse_token("ApproveChecked", TokenError::OwnerMismatch, |w, signer| {
        token::approve_checked(
            &TOKEN_2022,
            &w.vault_of(w.owner),
            &World::mint(w.lot),
            &w.f.key(Outsider),
            &signer,
            &[],
            1,
            0,
        )
        .unwrap()
    });
    w.refuse_token(
        "CloseAccount",
        TokenError::NonNativeHasBalance,
        |w, signer| {
            token::close_account(&TOKEN_2022, &w.vault_of(w.owner), &signer, &signer, &[]).unwrap()
        },
    );
    w.refuse_token(
        "SetAuthority vault owner",
        TokenError::OwnerMismatch,
        |w, signer| {
            token::set_authority(
                &TOKEN_2022,
                &w.vault_of(w.owner),
                Some(&signer),
                AuthorityType::AccountOwner,
                &signer,
                &[],
            )
            .unwrap()
        },
    );
    w.refuse_token(
        "SetAuthority vault close",
        TokenError::OwnerMismatch,
        |w, signer| {
            token::set_authority(
                &TOKEN_2022,
                &w.vault_of(w.owner),
                Some(&signer),
                AuthorityType::CloseAccount,
                &signer,
                &[],
            )
            .unwrap()
        },
    );
    w.refuse_token(
        "SetAuthority mint",
        TokenError::OwnerMismatch,
        |w, signer| {
            token::set_authority(
                &TOKEN_2022,
                &World::mint(w.lot),
                Some(&signer),
                AuthorityType::MintTokens,
                &signer,
                &[],
            )
            .unwrap()
        },
    );
    w.refuse_token(
        "SetAuthority freeze",
        TokenError::OwnerMismatch,
        |w, signer| {
            token::set_authority(
                &TOKEN_2022,
                &World::mint(w.lot),
                Some(&signer),
                AuthorityType::FreezeAccount,
                &signer,
                &[],
            )
            .unwrap()
        },
    );
    w.refuse_token("MintTo", TokenError::OwnerMismatch, |w, signer| {
        token::mint_to(
            &TOKEN_2022,
            &World::mint(w.lot),
            &w.vault_of(w.owner),
            &signer,
            &[],
            1,
        )
        .unwrap()
    });
    w.refuse_token("FreezeAccount", TokenError::OwnerMismatch, |w, signer| {
        token::freeze_account(
            &TOKEN_2022,
            &w.vault_of(w.owner),
            &World::mint(w.lot),
            &signer,
            &[],
        )
        .unwrap()
    });
    w.refuse_token(
        "TransferChecked to Alice's ATA",
        TokenError::OwnerMismatch,
        |w, signer| {
            token::transfer_checked(
                &TOKEN_2022,
                &w.vault_of(w.owner),
                &World::mint(w.lot),
                &w.personal_ata(),
                &signer,
                &[],
                1,
                0,
            )
            .unwrap()
        },
    );
    assert_eq!(w.read_token(w.personal_ata()).unwrap().amount, 0);
    w.refuse_token(
        "MintTo Alice's ATA",
        TokenError::OwnerMismatch,
        |w, signer| {
            token::mint_to(
                &TOKEN_2022,
                &World::mint(w.lot),
                &w.personal_ata(),
                &signer,
                &[],
                1,
            )
            .unwrap()
        },
    );
    assert_eq!(w.read_token(w.personal_ata()).unwrap().amount, 0);
    assert_eq!(w.read_token(w.mallory_ata()).unwrap().amount, 0);
    // The vault is frozen last, since a frozen vault changes the other cases' errors; the
    // baseline is taken after that.
    w.freeze_vault(vault);
    w.refuse_token("ThawAccount", TokenError::OwnerMismatch, |w, signer| {
        token::thaw_account(
            &TOKEN_2022,
            &w.vault_of(w.owner),
            &World::mint(w.lot),
            &signer,
            &[],
        )
        .unwrap()
    });
    assert_eq!(w.read_token(vault).unwrap().state, AccountState::Frozen);
    assert_eq!(w.lot_state().state, LotState::InTransit);

    // Fixture B: Khunou Ore Exports transfers all 5,000 t to Buyer Smelter Co, which prepares
    // and departs the lot, so Alice's zeroed vault exists while the lot is in transit.
    let mut w = World::new();
    let transfer = w.transfer_instructions(LOT_KG);
    w.f.sponsored_ok(&transfer);
    w.assert_invariants();
    let (buyer, terminal_class) = (w.buyer, w.terminal_class);
    let (_, batch) = w.prepare_from(buyer, terminal_class);
    w.hand_over(batch, w.transporter);
    assert_eq!(w.lot_state().state, LotState::InTransit);
    let vault = w.vault_of(w.owner);
    assert!(w.f.account_exists(vault));
    assert_eq!(w.f.token_amount(vault), 0);
    assert_eq!(w.position_state().quantity_kg, 0);
    w.refuse_token(
        "CloseAccount empty vault",
        TokenError::OwnerMismatch,
        |w, signer| {
            token::close_account(&TOKEN_2022, &w.vault_of(w.owner), &signer, &signer, &[]).unwrap()
        },
    );
    assert!(w.f.account_exists(vault));
    assert_eq!(w.lot_state().state, LotState::InTransit);
}

// ================================================================ other protocol ====

#[test]
fn custody_accounts_from_other_protocol_refused() {
    // (a) The Shipment in cancel_shipment.
    let mut w = World::new();
    let (shipment, _) = w.prepare_to(w.terminal_class);
    let honest = w.cancel_instructions(shipment);
    let original: Shipment = w.f.read(shipment);
    assert_eq!(original.protocol, w.f.protocol);
    let foreign = Shipment {
        protocol: other_protocol(),
        ..original.clone()
    };
    w.f.set_program_account(shipment, &foreign);
    w.refused_untouched(&honest, |f, ix| {
        f.sponsored_refused(ix, 1, WrongOrganisation)
    });
    assert_same(&w.f.read::<Shipment>(shipment), &foreign);
    w.f.set_program_account(shipment, &original);
    w.f.sponsored_ok(&honest);
    assert_eq!(w.lot_state().state, LotState::Stored);

    // (b) The ManifestBatch in the departure handover.
    let mut w = World::new();
    let (_, batch) = w.prepare_to(w.terminal_class);
    let args = w.handover_args(batch, w.transporter);
    let honest = w.handover_instructions(&args);
    let record = handover_key(batch, 0);
    let original: ManifestBatch = w.f.read(batch);
    assert_eq!(original.protocol, w.f.protocol);
    let foreign = ManifestBatch {
        protocol: other_protocol(),
        ..original.clone()
    };
    w.f.set_program_account(batch, &foreign);
    w.refused_untouched(&honest, |f, ix| {
        f.sponsored_refused(ix, 1, WrongOrganisation)
    });
    assert_same(&w.f.read::<ManifestBatch>(batch), &foreign);
    assert!(!w.f.account_exists(record));
    w.f.set_program_account(batch, &original);
    w.f.sponsored_ok(&honest);
    assert_eq!(w.f.read::<ManifestBatch>(batch).holder, w.transporter);
    assert!(w.f.account_exists(record));

    // (c) The LoadingIntent in record_loading.
    let (mut w, intent) = accepted_fixture();
    let args = w.record_args(w.owner, intent);
    assert_eq!(args.triples.len(), 1);
    let honest = w.record_instructions(&args);
    let original = w.intent_state(intent);
    assert_eq!(original.protocol, w.f.protocol);
    let foreign = LoadingIntent {
        protocol: other_protocol(),
        ..original.clone()
    };
    w.f.set_program_account(intent, &foreign);
    w.refused_untouched(&honest, |f, ix| {
        f.sponsored_refused(ix, 1, WrongOrganisation)
    });
    assert_same(&w.intent_state(intent), &foreign);
    w.f.set_program_account(intent, &original);
    w.record_ok(&args);

    // (d) A HandoffAcceptance in a record_loading triple.
    let (mut w, intent) = accepted_fixture();
    let args = w.record_args(w.owner, intent);
    assert_eq!(args.triples.len(), 1);
    let honest = w.record_instructions(&args);
    let acceptance = args.triples[0].acceptance;
    let original: HandoffAcceptance = w.f.read(acceptance);
    assert_eq!(original.protocol, w.f.protocol);
    let foreign = HandoffAcceptance {
        protocol: other_protocol(),
        ..original.clone()
    };
    w.f.set_program_account(acceptance, &foreign);
    w.refused_untouched(&honest, |f, ix| {
        f.sponsored_refused(ix, 1, AcceptanceMissing)
    });
    assert_same(&w.f.read::<HandoffAcceptance>(acceptance), &foreign);
    w.f.set_program_account(acceptance, &original);
    w.record_ok(&args);

    // (e) The Incident slot of attest_shortfall holds the PDA derived with the second
    // instance's Protocol; Phase 3 only creates Incidents, so the seeds check refuses it.
    let mut w = World::new();
    let (_, batch) = w.prepare_to(w.terminal_class);
    let args = w.shortfall_args(Some(batch));
    let mut instructions = w.shortfall_instructions(&args);
    let honest_incident = w.incident(&args.incident_id);
    let foreign_incident = incident_key(other_protocol(), &args.incident_id);
    assert_ne!(honest_incident, foreign_incident);
    let slot = instructions[1]
        .accounts
        .iter()
        .position(|meta| meta.pubkey == honest_incident)
        .expect("the incident slot");
    instructions[1].accounts[slot].pubkey = foreign_incident;
    w.refused_untouched(&instructions, |f, ix| {
        f.sponsored_refused_anchor(ix, 1, AnchorError::ConstraintSeeds)
    });
    assert!(!w.f.account_exists(foreign_incident));
    assert!(!w.f.account_exists(honest_incident));
    w.attest_ok(&args);
}

// ================================================================ text mutations ====

/// The frame every signed text has (§5): the header, then `Network:`, `Program:`, `Protocol:`
/// and `Action:` lines, `Valid until:` second to last and the test-network notice last. Returns
/// the §9 mutants: one per rendered line, its last byte replaced.
fn framed_mutations(text: &[u8], action: &str, line_count: usize) -> Vec<Vec<u8>> {
    let rendered = std::str::from_utf8(text).expect("a UTF-8 text");
    let lines: Vec<&str> = rendered.split('\n').collect();
    // A literal per action, so a sweep can't silently cover fewer lines than the text has.
    assert_eq!(lines.len(), line_count, "{action}: lines in the text");
    assert_eq!(lines[0], "Thetis authorisation v1");
    assert!(lines[1].starts_with("Network: "), "{}", lines[1]);
    assert!(lines[2].starts_with("Program: "), "{}", lines[2]);
    assert!(lines[3].starts_with("Protocol: "), "{}", lines[3]);
    assert_eq!(lines[4], format!("Action: {action}"));
    assert!(
        lines[lines.len() - 2].starts_with("Valid until: "),
        "{}",
        lines[lines.len() - 2]
    );
    assert_eq!(lines[lines.len() - 1], "Test network only. Synthetic data.");
    let mutations = line_mutations(text);
    assert_eq!(mutations.len(), line_count, "{action}: one mutant per line");
    mutations
}

impl World {
    /// Signs every mutant of `text` with `sign` (keeping the honest accounts and arguments),
    /// sends each sponsored and asserts it is refused with `MessageMismatch` at instruction 1;
    /// every account the action names stays byte-identical and each of `absent` stays absent.
    fn assert_mutations_refused(
        &mut self,
        text: &[u8],
        action: &str,
        line_count: usize,
        absent: &[Pubkey],
        sign: impl Fn(&World, &[u8]) -> [Instruction; 2],
    ) {
        let mutations = framed_mutations(text, action, line_count);
        let payer = self.f.payer();
        let named: Vec<Pubkey> = sign(self, text)[1]
            .accounts
            .iter()
            .map(|meta| meta.pubkey)
            .filter(|key| *key != payer)
            .collect();
        let before = self.snapshot(&named);
        for key in absent {
            assert!(
                !self.f.account_exists(*key),
                "{key} exists before the sweep"
            );
        }
        for mutated in mutations {
            assert_ne!(mutated, text);
            let instructions = sign(self, &mutated);
            self.f.sponsored_refused(&instructions, 1, MessageMismatch);
            self.assert_unchanged(&before);
            for key in absent {
                assert!(!self.f.account_exists(*key), "{key} was created");
            }
        }
    }
}

#[test]
fn prepare_text_field_mutations_refused() {
    let mut w = World::new();
    let owner = w.owner;
    let args = w.prepare_args(owner, w.terminal_class);
    let text = w.prepare_text(&args);
    w.assert_mutations_refused(
        &text,
        "Prepare shipment",
        17,
        &[args.shipment],
        |w, text| w.prepare_signed(&args, text),
    );
    let honest = w.prepare_signed(&args, &text);
    w.f.sponsored_ok(&honest);
    assert_eq!(w.lot_state().state, LotState::Prepared);
}

#[test]
fn cancel_text_field_mutations_refused() {
    let mut w = World::new();
    let (shipment, _) = w.prepare_to(w.terminal_class);
    let text = w.cancel_text(shipment);
    w.assert_mutations_refused(&text, "Cancel shipment", 13, &[], |w, text| {
        w.cancel_signed(shipment, text)
    });
    let honest = w.cancel_signed(shipment, &text);
    w.f.sponsored_ok(&honest);
    assert_eq!(w.lot_state().state, LotState::Stored);
}

#[test]
fn handover_text_field_mutations_refused() {
    // The departure, Kopano Stockyard Custody to Mosela Haulage: both sign one shared text,
    // the holder first.
    let mut w = World::new();
    let (_, batch) = w.prepare_to(w.terminal_class);
    let args = w.handover_args(batch, w.transporter);
    let text = w.handover_text(&args);
    w.assert_mutations_refused(
        &text,
        "Hand over custody",
        16,
        &[handover_key(batch, 0)],
        |w, text| w.handover_signed(&args, text),
    );
    let honest = w.handover_signed(&args, &text);
    w.f.sponsored_ok(&honest);
    assert_eq!(w.f.read::<ManifestBatch>(batch).holder, w.transporter);
    assert!(w.f.account_exists(handover_key(batch, 0)));
}

#[test]
fn observation_text_field_mutations_refused() {
    let mut w = World::new();
    let (_, batch) = w.prepare_to(w.terminal_class);
    w.hand_over(batch, w.transporter);
    let args = w.border_args(batch);
    let text = w.observation_text(&args);
    w.assert_mutations_refused(&text, "Record observation", 17, &[], |w, text| {
        w.observation_signed(&args, text)
    });
    let honest = w.observation_signed(&args, &text);
    w.f.sponsored_ok(&honest);
    assert_eq!(w.f.read::<ManifestBatch>(batch).observation_count, 1);
}

#[test]
fn shortfall_text_field_mutations_refused() {
    // Both forms: batch present, then the whole lot with a second incident id.
    let mut w = World::new();
    let (_, batch) = w.prepare_to(w.terminal_class);
    let forms = [
        w.shortfall_args(Some(batch)),
        ShortfallArgs {
            incident_id: INCIDENT_TWO,
            ..w.shortfall_args(None)
        },
    ];
    for args in &forms {
        let text = w.shortfall_text(args);
        // Both forms print 18 lines: the whole-lot form keeps the batch line.
        w.assert_mutations_refused(
            &text,
            "Attest shortfall",
            18,
            &[w.incident(&args.incident_id)],
            |w, text| w.shortfall_signed(args, text),
        );
        w.attest_ok(args);
    }
}

#[test]
fn loading_intent_text_field_mutations_refused() {
    let (mut w, _) = loading_fixture();
    let args = w.intent_args(w.owner, 1, LOADING_DOCUMENT);
    let text = w.intent_text(&args);
    let intent = intent_key(w.position(), args.nonce);
    w.assert_mutations_refused(&text, "Prepare loading", 16, &[intent], |w, text| {
        [
            ed25519_instruction(&[(w.f.signer(Owner), text)]),
            w.intent_instruction(&args),
        ]
    });
    w.create_intent_ok(&args);
    assert_eq!(w.intent_state(intent).status, LoadingStatus::Open);
}

#[test]
fn record_loading_text_field_mutations_refused() {
    let (mut w, intent) = accepted_fixture();
    let args = w.record_args(w.owner, intent);
    assert_eq!(args.triples.len(), 1);
    let text = w.record_text(&args);
    assert!(String::from_utf8(text.clone())
        .unwrap()
        .contains("Loan acceptances: 1"));
    w.assert_mutations_refused(&text, "Record loading", 16, &[], |w, text| {
        w.record_signed(&args, text)
    });
    w.record_ok(&args);
    assert_eq!(w.lot_state().state, LotState::Loaded);
}

// ================================================================== sizes ====

const SHIPMENT_ONE: [u8; 16] = [0x22; 16];
/// Two distinct 48-byte names and a 16-byte lot id (§11.1).
const WIDEST_FROM: &str = "Kopano Stockyard Custody And Allied Yards Pty 01";
const WIDEST_TO: &str = "Mosela Haulage And Allied Bulk Transport Pty 001";
const WIDEST_OWNER: &str = "Khunou Ore Exports And Allied Mining Pty Ltd 001";
const WIDEST_TERMINAL: &str = "Port Terminal T1 And Allied Bulk Terminals Pty 1";
const WIDEST_LOT_ID: &str = "CR-0001-WIDEST-1";

/// `SetComputeUnitPrice` of one micro-lamport (the ComputeBudget program, no accounts).
fn compute_unit_price() -> Instruction {
    Instruction {
        program_id: COMPUTE_BUDGET,
        accounts: vec![],
        data: [vec![3], 1_u64.to_le_bytes().to_vec()].concat(),
    }
}

/// `[SetComputeUnitLimit, verify, action]`.
fn plain(instructions: &[Instruction; 2]) -> Vec<Instruction> {
    let [verify, action] = instructions.clone();
    vec![compute_unit_limit(), verify, action]
}

/// `[SetComputeUnitLimit, SetComputeUnitPrice, verify, action]`.
fn priced(instructions: &[Instruction; 2]) -> Vec<Instruction> {
    let [verify, action] = instructions.clone();
    vec![compute_unit_limit(), compute_unit_price(), verify, action]
}

/// Compiles `instructions` as a sponsored v0 transaction against `table` and checks that only
/// the sponsor signs, that `inline` are the only static keys, and that the table supplies
/// exactly `writable` and `readonly`. Returns the transaction and its size.
fn v0(
    w: &mut World,
    table: &AddressLookupTableAccount,
    instructions: &[Instruction],
    inline: &[Pubkey],
    writable: &[Pubkey],
    readonly: &[Pubkey],
) -> (VersionedTransaction, usize) {
    let tx = w.f.sponsored_v0(instructions, std::slice::from_ref(table));
    assert_eq!(tx.signatures.len(), 1, "only the sponsor signs");
    let VersionedMessage::V0(message) = &tx.message else {
        panic!("a v0 message");
    };
    assert_eq!(
        sorted(message.account_keys.clone()),
        sorted(inline.to_vec())
    );
    assert_eq!(message.address_table_lookups.len(), 1);
    let lookup = &message.address_table_lookups[0];
    assert_eq!(lookup.account_key, table.key);
    let loaded = |indexes: &[u8]| -> Vec<Pubkey> {
        sorted(
            indexes
                .iter()
                .map(|index| table.addresses[usize::from(*index)])
                .collect(),
        )
    };
    assert_eq!(loaded(&lookup.writable_indexes), sorted(writable.to_vec()));
    assert_eq!(loaded(&lookup.readonly_indexes), sorted(readonly.to_vec()));
    let size = transaction_size(&tx);
    (tx, size)
}

/// `table`'s addresses without `left_out`: the relay's table (services/api `compile.ts`),
/// whose protocol and created accounts stay static.
fn without(addresses: &[Pubkey], left_out: &[Pubkey]) -> Vec<Pubkey> {
    addresses
        .iter()
        .copied()
        .filter(|key| !left_out.contains(key))
        .collect()
}

#[test]
fn handover_transaction_fits_1232_bytes() {
    // The executed demo shape (the departure), then the widest text and arguments over the same
    // accounts, serialised only (§11.1), against a table of the whole fixture inventory.
    let mut w = World::new();
    let (shipment, batch) = w.prepare_to(w.terminal_class);
    let document = w.documents[0];
    let demo = w.handover_args(batch, w.transporter);
    let widest = HandoverArgs {
        expected_sequence: u64::MAX,
        valid_until: i64::MAX,
        ..demo.clone()
    };
    for name in [WIDEST_FROM, WIDEST_TO] {
        assert_eq!(name.len(), MAX_DISPLAY_NAME);
    }
    assert_ne!(WIDEST_FROM, WIDEST_TO);
    assert_eq!(WIDEST_LOT_ID.len(), MAX_LOT_ID);
    let text = custody_handover_message(
        &ID,
        &INSTANCE,
        WIDEST_LOT_ID,
        &SHIPMENT_ONE,
        16,
        16,
        u64::MAX,
        WIDEST_FROM,
        WIDEST_TO,
        HandoverStage::Departure,
        &[0x44; 32],
        u64::MAX,
        i64::MAX,
    );
    assert_eq!(text.len(), 593);
    // Built before the demo executes: the accounts follow the batch's state.
    let demo_instructions = w.handover_instructions(&demo);
    let widest_instructions = w.handover_signed(&widest, &text);

    let readonly = vec![
        SYSTEM,
        INSTRUCTIONS_SYSVAR,
        w.f.protocol,
        w.custodian,
        w.authority_of(Custodian),
        w.transporter,
        w.authority_of(Driver),
        document,
    ];
    let (lot, source, destination) = (w.lot, w.source, w.terminal_class);
    let writable = |record: Pubkey| vec![shipment, batch, lot, source, destination, record];
    let demo_record = handover_key(batch, 0);
    let widest_record = handover_key(batch, u64::MAX);
    // The relay appends the HandoverRecord PDA before it hands over; the table is the whole
    // inventory (§11.1 item 3): every account the world created, the fixed keys and the
    // Phase 3 keys for the current sequence and for `u64::MAX`.
    let inventory = w.inventory();
    for key in readonly
        .iter()
        .chain(&writable(demo_record))
        .chain(&writable(widest_record))
    {
        assert!(inventory.contains(key), "{key} is not in the inventory");
    }
    println!("handover table: {} addresses", inventory.len());
    let table = w.f.create_lookup_table(inventory.clone());
    let inline = vec![w.f.payer(), ID, ED25519, COMPUTE_BUDGET];
    assert_eq!(readonly.len() + writable(demo_record).len(), 14);

    let (tx, demo_size) = v0(
        &mut w,
        &table,
        &plain(&demo_instructions),
        &inline,
        &writable(demo_record),
        &readonly,
    );
    let meta =
        w.f.send(tx)
            .unwrap_or_else(|failure| panic!("{:?}\n{}", failure.err, failure.meta.pretty_logs()));
    let units = meta.compute_units_consumed;
    assert!(
        units < u64::from(COMPUTE_UNIT_LIMIT),
        "handover used {units} CU"
    );
    println!("handover v0 demo: {units} CU, {demo_size} bytes");
    assert!(demo_size <= PACKET_DATA_SIZE);
    assert_eq!(w.f.read::<ManifestBatch>(batch).holder, w.transporter);
    w.assert_invariants();

    // The widest, without and with the compute-unit price.
    let (_, widest_size) = v0(
        &mut w,
        &table,
        &plain(&widest_instructions),
        &inline,
        &writable(widest_record),
        &readonly,
    );
    println!("handover v0 widest: {widest_size} bytes");
    assert_eq!(widest_size, 1_181);
    assert!(widest_size <= PACKET_DATA_SIZE);
    let (_, widest_priced) = v0(
        &mut w,
        &table,
        &priced(&widest_instructions),
        &inline,
        &writable(widest_record),
        &readonly,
    );
    println!("handover v0 widest, with the compute-unit price: {widest_priced} bytes");
    assert_eq!(widest_priced, 1_193);
    assert!(widest_priced <= PACKET_DATA_SIZE);

    // The relay's shape (services/api compile.ts): the protocol stays static, and the relay
    // appends the HandoverRecord it creates to the table first (§4.6; T056r R7).
    let relay_table =
        w.f.create_lookup_table(without(&inventory, &[w.f.protocol]));
    let relay_readonly = without(&readonly, &[w.f.protocol]);
    let relay_inline = [inline.clone(), vec![w.f.protocol]].concat();
    let (_, relay_widest) = v0(
        &mut w,
        &relay_table,
        &plain(&widest_instructions),
        &relay_inline,
        &writable(widest_record),
        &relay_readonly,
    );
    println!("handover v0 widest, relay shape: {relay_widest} bytes");
    let (_, relay_widest_priced) = v0(
        &mut w,
        &relay_table,
        &priced(&widest_instructions),
        &relay_inline,
        &writable(widest_record),
        &relay_readonly,
    );
    println!("handover v0 widest, relay shape, with the price: {relay_widest_priced} bytes");
    let (_, relay_demo_priced) = v0(
        &mut w,
        &relay_table,
        &priced(&demo_instructions),
        &relay_inline,
        &writable(demo_record),
        &relay_readonly,
    );
    println!("handover v0 demo, relay shape, with the price: {relay_demo_priced} bytes");
    // With the HandoverRecord in the table the widest relay shape carries the price.
    assert_eq!(relay_widest, 1_212);
    assert_eq!(relay_widest_priced, 1_224);
    assert!(relay_widest_priced <= PACKET_DATA_SIZE);
    assert!(relay_demo_priced <= PACKET_DATA_SIZE);
}

#[test]
fn record_loading_transaction_fits_1232_bytes() {
    // The compute-unit worst case (§9): the final loading of a child lot that is its root's
    // last live child, the root already at zero supply, so the intake retires; four accepted
    // positive locks on four unpaid loans. Serialised only, against a table of the whole
    // fixture inventory.
    let mut w = World::new();
    let root = w.lot;
    let child = w.split_child(THREE_THOUSAND_T);
    let collect =
        w.redeem_instructions(root, None, TWO_THOUSAND_T, Custodian, w.custodian, w.source);
    w.f.sponsored_ok(&collect);
    let root_state: Lot = w.f.read(root);
    assert_eq!((root_state.supply_kg, root_state.live_children), (0, 1));
    w.lot = child;
    w.lot_id = CHILD_LOT_ID.into();
    w.root = Some(root);
    let lender = w.lender_one;
    w.open_facility(lender);
    let valuation = w.set_valuation(lender, w.source);
    let mut loans = Vec::new();
    for _ in 0..MAX_LOADING_LOANS {
        let (loan, _) = w.pledge(lender, 1);
        w.advance(lender, loan, valuation, 1);
        loans.push(loan);
    }
    w.ship_to(w.terminal_class);
    let intent = w.create_intent(1);
    for loan in &loans {
        w.accept(lender, *loan, intent);
    }
    let args = w.record_args(w.owner, intent);
    assert_eq!(args.triples.len(), MAX_LOADING_LOANS);
    let demo_instructions = w.record_instructions(&args);

    let position = w.position();
    let readonly_fixed = vec![
        w.f.protocol,
        w.owner,
        w.authority_of(Owner),
        w.terminal,
        w.authority_of(Custodian2),
        World::vault_authority(position),
        INSTRUCTIONS_SYSVAR,
        TOKEN_2022,
    ];
    let writable_fixed = vec![
        w.terminal_class,
        child,
        root,
        w.intake(),
        World::mint(child),
        position,
        World::vault(child, position),
        intent,
    ];
    let mut readonly = readonly_fixed.clone();
    readonly.extend(args.triples.iter().map(|triple| triple.acceptance));
    let mut writable = writable_fixed.clone();
    writable.extend(
        args.triples
            .iter()
            .flat_map(|triple| [triple.loan, triple.lock]),
    );
    assert_eq!(readonly.len() + writable.len(), 16 + 12);
    let inventory = w.inventory();
    for key in readonly.iter().chain(&writable) {
        assert!(inventory.contains(key), "{key} is not in the inventory");
    }
    println!("record_loading table: {} addresses", inventory.len());
    let table = w.f.create_lookup_table(inventory.clone());
    let inline = vec![w.f.payer(), ID, ED25519, COMPUTE_BUDGET];

    let (_, demo_size) = v0(
        &mut w,
        &table,
        &plain(&demo_instructions),
        &inline,
        &writable,
        &readonly,
    );
    println!("record_loading v0 demo worst case: {demo_size} bytes");
    assert!(demo_size <= PACKET_DATA_SIZE);

    // The widest text and arguments over the same accounts.
    for name in [WIDEST_OWNER, WIDEST_TERMINAL] {
        assert_eq!(name.len(), MAX_DISPLAY_NAME);
    }
    assert_eq!(WIDEST_LOT_ID.len(), MAX_LOT_ID);
    let text = record_loading_message(
        &ID,
        &INSTANCE,
        WIDEST_LOT_ID,
        u64::MAX,
        WIDEST_OWNER,
        WIDEST_TERMINAL,
        &LOADING_DOCUMENT,
        u64::MAX,
        u64::MAX,
        4,
        u64::MAX,
        i64::MAX,
    );
    assert_eq!(text.len(), 615);
    let widest = RecordArgs {
        expected_revision: u64::MAX,
        valid_until: i64::MAX,
        ..args
    };
    let widest_instructions = w.record_signed(&widest, &text);
    let (_, widest_size) = v0(
        &mut w,
        &table,
        &plain(&widest_instructions),
        &inline,
        &writable,
        &readonly,
    );
    println!("record_loading v0 widest: {widest_size} bytes");
    assert_eq!(widest_size, 1_199);
    assert!(widest_size <= PACKET_DATA_SIZE);
    let (_, widest_priced) = v0(
        &mut w,
        &table,
        &priced(&widest_instructions),
        &inline,
        &writable,
        &readonly,
    );
    println!("record_loading v0 widest, with the compute-unit price: {widest_priced} bytes");
    assert_eq!(widest_priced, 1_211);
    assert!(widest_priced <= PACKET_DATA_SIZE);

    // The relay's shape (services/api compile.ts): the protocol stays static. A relay finding,
    // not a program defect: the price does not fit this shape, so compile.ts omits it and a
    // wallet may add its own.
    let relay_table =
        w.f.create_lookup_table(without(&inventory, &[w.f.protocol]));
    let relay_readonly = without(&readonly, &[w.f.protocol]);
    let relay_inline = [inline.clone(), vec![w.f.protocol]].concat();
    let (_, relay_widest) = v0(
        &mut w,
        &relay_table,
        &plain(&widest_instructions),
        &relay_inline,
        &writable,
        &relay_readonly,
    );
    println!("record_loading v0 widest, relay shape: {relay_widest} bytes");
    assert_eq!(relay_widest, 1_230);
    assert!(relay_widest <= PACKET_DATA_SIZE);
    let (_, relay_priced) = v0(
        &mut w,
        &relay_table,
        &priced(&widest_instructions),
        &relay_inline,
        &writable,
        &relay_readonly,
    );
    println!("record_loading v0 widest, relay shape, with the price: {relay_priced} bytes");
    assert_eq!(relay_priced, 1_242);
    assert!(relay_priced > PACKET_DATA_SIZE);
    // The demo worst case in the relay's shape carries the price.
    let (_, relay_demo_priced) = v0(
        &mut w,
        &relay_table,
        &priced(&demo_instructions),
        &relay_inline,
        &writable,
        &relay_readonly,
    );
    println!(
        "record_loading v0 demo worst case, relay shape, with the price: {relay_demo_priced} bytes"
    );
    assert_eq!(relay_demo_priced, 1_087);
    assert!(relay_demo_priced <= PACKET_DATA_SIZE);
}
