//! Phase 3: shortfalls and restrictions — `attest_shortfall` (an inspector's PS, one entry) and
//! `set_restriction` (the protocol accreditor's TX), program-custody.md §4.5, §5, §6.1–§6.5 and §9
//! (A20), with the restriction they set read by repay, shipping and loading.
//!
//! Demo quantities and money are the demo's (5,000 t, 3,000 t, USD600,000, 20 c/kg, haircut 0,
//! LTV 60%, 1,200 bps) plus the bounds 0, 1 and `u64::MAX`; site capacities are fixture values
//! stated below; the shortfall readings are §6.2's labelled synthetic inputs (4,990 t observed,
//! 50 bps tolerance, and the same reading at tolerance 0 for the outside case, §9). The demo
//! cast is synthetic; `Inspector Test Org` is the test-only inspector of §10, never seeded, and
//! the second terminal uses the harness's generated test name. Incident and shipment ids,
//! digests, site codes, payment ids, nonces and expiries are deterministic synthetic test inputs.

mod common;

use anchor_lang::{
    __private::base64::{engine::general_purpose::STANDARD, Engine},
    error::ErrorCode as AnchorError,
    prelude::Pubkey,
    AccountSerialize, Event,
};
use anchor_spl::associated_token::{
    get_associated_token_address_with_program_id,
    spl_associated_token_account::instruction::create_associated_token_account_idempotent,
};
use anchor_spl::token::spl_token;
use common::{Actor::*, *};
use litesvm::types::TransactionMetadata;
use solana_message::{AddressLookupTableAccount, VersionedMessage};
use solana_transaction::{versioned::VersionedTransaction, AccountMeta, Instruction};
use thetis::{
    accounts,
    error::ThetisError::{self, *},
    events, instruction,
    intent::message::{
        advance_message, borrow_message, custody_handover_message, issue_message,
        loading_intent_message, pledge_message, prepare_shipment_message, record_loading_message,
        redeem_message, shortfall_message,
    },
    lending_math::accrue,
    manifest::{batch_leaf, node},
    state::*,
    ID,
};

const SPL_TOKEN: Pubkey = anchor_spl::token::ID;
const TOKEN_2022: Pubkey = anchor_spl::token_2022::ID;
const ASSOCIATED_TOKEN: Pubkey = anchor_spl::associated_token::ID;
const INSTRUCTIONS_SYSVAR: Pubkey = solana_sdk_ids::sysvar::instructions::ID;
const ED25519: Pubkey = solana_sdk_ids::ed25519_program::ID;
const COMPUTE_BUDGET: Pubkey = solana_sdk_ids::compute_budget::ID;
const PACKET_DATA_SIZE: usize = 1232;
const COMPUTE_UNIT_LIMIT: u32 = 400_000;

/// The simulation pool's SPL Token mint, written by the harness at a fixed synthetic address.
const POOL_MINT: Pubkey = Pubkey::new_from_array([0x4d; 32]);

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
const INTAKE_DIGEST: [u8; 32] = [0x0a; 32];
const LOT_KG: u64 = 5_000_000;
const THREE_THOUSAND_T: u64 = 3_000_000;
const DEPARTURE_SHA: [u8; 32] = [0xdd; 32];
const COLLECTION_TICKET: [u8; 32] = [0xc7; 32];
/// The bill-of-lading digest: the vectors' 32 × 0xaa.
const LOADING_DOCUMENT: [u8; 32] = [0xaa; 32];

const USD: [u8; 3] = *b"USD";
const CENTS: u8 = 2;
const MICRO: u8 = 6;
const RATE_BPS: u16 = 1_200;
const MAX_LTV_BPS: u16 = 6_000;
/// 20 c/kg in cents.
const VALUE_PER_KG: u64 = 20;
const TERMS_DIGEST: [u8; 32] = [0x7d; 32];
const SOURCE_DIGEST: [u8; 32] = [0x5e; 32];
const EVIDENCE_DIGEST: [u8; 32] = [0xe1; 32];
const FACILITY_ONE: [u8; 16] = [0x11; 16];
/// USD600,000 in cents.
const SIX_HUNDRED_K: u64 = 60_000_000;

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
/// The restriction reason digests the accreditor sends (synthetic).
const REASON_ONE: [u8; 32] = [0x5a; 32];
const REASON_TWO: [u8; 32] = [0x5b; 32];

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

fn sha256_hex(bytes: &[u8]) -> String {
    solana_sha256_hasher::hash(bytes)
        .to_bytes()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn bump_of(seeds: &[&[u8]]) -> u8 {
    Pubkey::find_program_address(seeds, &ID).1
}

fn payment_id(n: u8) -> [u8; 32] {
    [n; 32]
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

/// A protocol (fiat unless a test asks for the simulation pool) with the demo cast plus
/// `Inspector Test Org`; a source site of Kopano Stockyard Custody and the
/// terminal site PORT-T1 of Port Terminal T1 in the chrome class; CR-0001 (5,000 t, grade A)
/// issued at the source to Khunou Ore Exports; Lender One Bank.
struct World {
    f: Fixture,
    now: i64,
    mode: SettlementMode,
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
    pool: Pubkey,
    pool_authority: Pubkey,
    pool_vault: Pubkey,
}

impl World {
    /// CR-0001 at the source, fiat.
    fn new() -> Self {
        Self::in_mode(SettlementMode::FiatAttestationTest)
    }

    /// CR-0001 at the source, in `mode`.
    fn in_mode(mode: SettlementMode) -> Self {
        let mut f = Fixture::new();
        let init = f.initialize_instance(INSTANCE, mode, Admin);
        f.ok(init, Admin);
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
            (transporter, Driver, scope::CARRY),
            (buyer, Buyer, scope::TRANSFER | scope::BUY | scope::SHIP),
            (lender_org, Lender, scope::LEND | scope::POOL),
            (inspector, Inspector, scope::INSPECT),
        ] {
            let delegate = f.delegate(OrgAdmin, org, f.key(wallet), scopes, expires_at);
            f.ok(delegate, OrgAdmin);
        }

        let protocol = f.protocol;
        let facility = |lender: Pubkey, id: &[u8; 16]| {
            pda(&[b"facility", protocol.as_ref(), lender.as_ref(), id])
        };
        let lot = pda(&[b"lot", protocol.as_ref(), LOT_ID.as_bytes()]);
        let pool = pda(&[b"pool", protocol.as_ref()]);
        let pool_authority = pda(&[b"pool_authority", pool.as_ref()]);
        let mut world = Self {
            f,
            now: NOW,
            mode,
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
            pool,
            pool_authority,
            pool_vault: get_associated_token_address_with_program_id(
                &pool_authority,
                &POOL_MINT,
                &SPL_TOKEN,
            ),
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
        self.f
            .document(DocumentKind::Departure, lot.to_bytes(), version)
    }

    /// A departure document and the owner's `prepare_shipment` of the world's lot to
    /// `destination` in one batch carried by Mosela Haulage, at the lot's current revision.
    /// Returns the instructions, the shipment, the leaf and the manifest.
    fn prepare_instructions(
        &mut self,
        destination: Pubkey,
    ) -> ([Instruction; 2], Pubkey, Leaf, Manifest) {
        let document = self.attest_departure();
        let trip = self.trips;
        self.trips += 1;
        let lot = self.lot_state();
        let source = self.class_state(lot.custodian_class);
        let destination_state = self.class_state(destination);
        let leaf = Leaf {
            index: 0,
            quantity_kg: lot.supply_kg,
            carrier: self.transporter,
            load_digest: [0x33_u8.wrapping_add(0x10 * trip); 32],
            manifest_digest: [0x44; 32],
        };
        let manifest = Manifest::new(vec![leaf.clone()]);
        let shipment_id = [0x22 + trip; 16];
        let shipment = pda(&[b"shipment", self.f.protocol.as_ref(), &shipment_id]);
        let valid_until = self.now + CUSTODY_WINDOW;
        let stored_document: DocumentAttestation = self.f.read(document);
        let text = prepare_shipment_message(
            &ID,
            &INSTANCE,
            &lot.lot_id,
            &shipment_id,
            lot.supply_kg,
            OWNER_NAME,
            &self.name(destination_state.custodian),
            &destination_state.site_code,
            1,
            &manifest.root,
            (&stored_document.sha256, stored_document.version),
            lot.revision,
            valid_until,
        );
        let prepare = ix(
            accounts::PrepareShipment {
                sponsor: self.f.payer(),
                protocol: self.f.protocol,
                owner_org: self.owner,
                owner_authority: self.authority_of(Owner),
                lot: self.lot,
                position: self.position(),
                source_class: lot.custodian_class,
                destination_class: destination,
                destination_org: destination_state.custodian,
                departure_document: document,
                departure_issuer: source.custodian,
                shipment,
                instructions: INSTRUCTIONS_SYSVAR,
                system_program: SYSTEM,
            },
            instruction::PrepareShipment {
                shipment_id,
                batch_count: 1,
                manifest_root: manifest.root,
                expected_revision: lot.revision,
                valid_until,
            },
        );
        let verify = ed25519_instruction(&[(self.f.signer(Owner), text.as_slice())]);
        ([verify, prepare], shipment, leaf, manifest)
    }

    /// Prepares the world's lot to `destination` in one batch carried by Mosela Haulage and
    /// registers it. Returns the shipment and its batch.
    fn prepare_to(&mut self, destination: Pubkey) -> (Pubkey, Pubkey) {
        let (instructions, shipment, leaf, manifest) = self.prepare_instructions(destination);
        self.f.sponsored_ok(&instructions);
        self.shipments.push(shipment);
        let batch = pda(&[b"batch", self.f.protocol.as_ref(), &leaf.load_digest]);
        let register = ix(
            accounts::RegisterBatch {
                payer: self.f.payer(),
                protocol: self.f.protocol,
                shipment,
                batch,
                system_program: SYSTEM,
            },
            instruction::RegisterBatch {
                index: 0,
                quantity_kg: leaf.quantity_kg,
                carrier: leaf.carrier,
                load_digest: leaf.load_digest,
                manifest_digest: leaf.manifest_digest,
                proof: manifest.proofs[0],
            },
        );
        self.f.sponsored_ok(&[register]);
        assert_eq!(self.lot_state().state, LotState::Prepared);
        self.assert_invariants();
        (shipment, batch)
    }

    /// One handover of `batch` from its holder to `to_org`.
    fn hand_over(&mut self, batch: Pubkey, to_org: Pubkey) {
        let stored: ManifestBatch = self.f.read(batch);
        let shipment: Shipment = self.f.read(stored.shipment);
        let lot: Lot = self.f.read(stored.lot);
        let at_source = stored.stage == BatchStage::AtSource;
        let stage = if at_source {
            HandoverStage::Departure
        } else {
            HandoverStage::Arrival
        };
        let valid_until = self.now + CUSTODY_WINDOW;
        let text = custody_handover_message(
            &ID,
            &INSTANCE,
            &lot.lot_id,
            &shipment.shipment_id,
            stored.index + 1,
            stored.batch_count,
            stored.quantity_kg,
            &self.name(stored.holder),
            &self.name(to_org),
            stage,
            &stored.manifest_digest,
            stored.sequence,
            valid_until,
        );
        let from_signer = self.signer_for(stored.holder);
        let to_signer = self.signer_for(to_org);
        let handover = ix(
            accounts::Handover {
                sponsor: self.f.payer(),
                protocol: self.f.protocol,
                shipment: stored.shipment,
                batch,
                lot: stored.lot,
                from_org: stored.holder,
                from_authority: self.authority_of(from_signer),
                to_org,
                to_authority: self.authority_of(to_signer),
                source_class: shipment.source,
                destination_class: shipment.destination,
                departure_document: at_source.then_some(shipment.departure_document),
                handover: pda(&[b"handover", batch.as_ref(), &stored.sequence.to_le_bytes()]),
                instructions: INSTRUCTIONS_SYSVAR,
                system_program: SYSTEM,
            },
            instruction::Handover {
                manifest_digest: stored.manifest_digest,
                expected_sequence: stored.sequence,
                valid_until,
            },
        );
        let signers = [self.f.signer(from_signer), self.f.signer(to_signer)];
        self.f
            .sponsored_ok(&[ed25519_shared_instruction(&signers, &text), handover]);
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

    fn decimals(&self) -> u8 {
        match self.mode {
            SettlementMode::FiatAttestationTest => CENTS,
            SettlementMode::DevnetTokenSimulation => MICRO,
        }
    }

    /// 20 c/kg at the mode's decimals.
    fn value_per_kg(&self) -> u64 {
        match self.mode {
            SettlementMode::FiatAttestationTest => VALUE_PER_KG,
            SettlementMode::DevnetTokenSimulation => 200_000,
        }
    }

    fn ata(&self, actor: Actor) -> Pubkey {
        get_associated_token_address_with_program_id(&self.f.key(actor), &POOL_MINT, &SPL_TOKEN)
    }

    /// The admin opens the simulation pool on a harness-written SPL mint; Lender One Bank
    /// deposits USD700,000; the owner gets an empty ATA to borrow into (as tests/shipment.rs).
    fn open_pool_and_deposit(&mut self) {
        let payer = self.f.payer();
        let data = mint_data(Some(payer), 0, MICRO);
        self.f.set_foreign_account(POOL_MINT, SPL_TOKEN, data);
        for actor in [Lender, Owner] {
            let create = create_associated_token_account_idempotent(
                &payer,
                &self.f.key(actor),
                &POOL_MINT,
                &SPL_TOKEN,
            );
            self.f.sponsored_ok(&[create]);
        }
        let seven_hundred_k = 700_000 * 10_u64.pow(u32::from(MICRO));
        let mint_to = spl_token::instruction::mint_to(
            &SPL_TOKEN,
            &POOL_MINT,
            &self.ata(Lender),
            &payer,
            &[],
            seven_hundred_k,
        )
        .unwrap();
        self.f.sponsored_ok(&[mint_to]);
        let open = ix(
            accounts::OpenPool {
                admin: self.f.key(Admin),
                payer,
                protocol: self.f.protocol,
                pool: self.pool,
                pool_authority: self.pool_authority,
                mint: POOL_MINT,
                pool_vault: self.pool_vault,
                token_program: SPL_TOKEN,
                associated_token_program: ASSOCIATED_TOKEN,
                system_program: SYSTEM,
            },
            instruction::OpenPool { currency: USD },
        );
        self.f.signed_ok(&[open], Admin);
        let deposit = ix(
            accounts::Deposit {
                depositor: self.f.key(Lender),
                payer,
                protocol: self.f.protocol,
                authority: self.authority_of(Lender),
                depositor_org: self.lender_one.org,
                pool: self.pool,
                share: self.pool_share(),
                depositor_token: self.ata(Lender),
                pool_vault: self.pool_vault,
                mint: POOL_MINT,
                token_program: SPL_TOKEN,
                system_program: SYSTEM,
            },
            instruction::Deposit {
                amount: seven_hundred_k,
            },
        );
        self.f.signed_ok(&[deposit], Lender);
    }

    fn pool_share(&self) -> Pubkey {
        pda(&[
            b"pool_share",
            self.pool.as_ref(),
            self.lender_one.org.as_ref(),
        ])
    }

    /// A simulation-mode `borrow` of USD600,000 on Lender One Bank's `loan`, valued by
    /// `valuation`, into the owner's ATA.
    fn borrow(&mut self, loan: Pubkey, valuation: Pubkey) {
        let lender = self.lender_one;
        let stored = self.loan_state(loan);
        let amount = 600_000 * 10_u64.pow(u32::from(MICRO));
        let valid_until = self.now + MONEY_WINDOW;
        let destination = self.ata(Owner);
        let text = borrow_message(
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
            MICRO,
            &destination,
            RATE_BPS,
            stored.revision,
            valid_until,
        );
        let borrow = ix(
            accounts::Borrow {
                sponsor: self.f.payer(),
                protocol: self.f.protocol,
                borrower_org: self.owner,
                borrower_authority: self.authority_of(Owner),
                lender_org: lender.org,
                facility: lender.facility,
                loan,
                lock: pda(&[b"lock", loan.as_ref()]),
                lot: self.lot,
                valuation,
                pool: self.pool,
                lender_share: self.pool_share(),
                pool_authority: self.pool_authority,
                pool_vault: self.pool_vault,
                mint: POOL_MINT,
                destination,
                token_program: SPL_TOKEN,
                instructions: INSTRUCTIONS_SYSVAR,
            },
            instruction::Borrow {
                amount,
                expected_revision: stored.revision,
                valid_until,
            },
        );
        let verify = ed25519_instruction(&[(self.f.signer(Owner), text.as_slice())]);
        self.f.sponsored_ok(&[verify, borrow]);
        assert_eq!(self.loan_state(loan).principal, amount);
        self.assert_invariants();
    }

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
                pool: (self.mode == SettlementMode::DevnetTokenSimulation).then_some(self.pool),
                system_program: SYSTEM,
            },
            instruction::OpenFacility {
                facility_id: lender.facility_id,
                currency: USD,
                currency_decimals: self.decimals(),
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
                value_per_kg: self.value_per_kg(),
                haircut_bps: 0,
                valid_until: NOW + VALUATION_VALIDITY,
                source_digest: SOURCE_DIGEST,
            },
        );
        self.f.signed_ok(&[set], lender.actor);
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

    fn payment_key(&self, lender: Lender, id: u8) -> Pubkey {
        pda(&[
            b"payment",
            self.f.protocol.as_ref(),
            lender.org.as_ref(),
            &payment_id(id),
        ])
    }

    /// A real `confirm_payment` by the lender on `loan`.
    #[allow(clippy::too_many_arguments)]
    fn confirm(
        &mut self,
        lender: Lender,
        loan: Pubkey,
        id: u8,
        purpose: PaymentPurpose,
        subject: Pubkey,
        target: Option<Pubkey>,
        amount: u64,
    ) -> Pubkey {
        let payment = self.payment_key(lender, id);
        let confirm = ix(
            accounts::ConfirmPayment {
                lender: self.f.key(lender.actor),
                payer: self.f.payer(),
                protocol: self.f.protocol,
                authority: self.authority_of(lender.actor),
                lender_org: lender.org,
                facility: lender.facility,
                loan,
                subject,
                target,
                payment,
                system_program: SYSTEM,
            },
            instruction::ConfirmPayment {
                payment_id: payment_id(id),
                purpose,
                amount,
                currency: USD,
                evidence_digest: EVIDENCE_DIGEST,
                observed_at: self.now,
            },
        );
        self.f.signed_ok(&[confirm], lender.actor);
        payment
    }

    fn repay(&mut self, lender: Lender, loan: Pubkey, payment: Pubkey, amount: u64) {
        let repay = ix(
            accounts::Repay {
                signer: self.f.key(lender.actor),
                protocol: self.f.protocol,
                facility: lender.facility,
                loan,
                authority: Some(self.authority_of(lender.actor)),
                lender_org: Some(lender.org),
                payment: Some(payment),
                pool: None,
                pool_authority: None,
                pool_vault: None,
                payer_token: None,
                mint: None,
                token_program: None,
            },
            instruction::Repay { amount },
        );
        self.f.signed_ok(&[repay], lender.actor);
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

    fn create_intent_refused(&mut self, args: &IntentArgs, expected: ThetisError) {
        let instructions = self.intent_instructions(args);
        let intent = intent_key(Self::position_key(self.lot, args.holder), args.nonce);
        self.f.sponsored_refused(&instructions, 1, expected);
        assert!(!self.f.account_exists(intent));
        self.assert_invariants();
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

    fn accept_refused(&mut self, args: &AcceptArgs, expected: ThetisError) {
        let instruction = self.accept_instruction(args);
        self.f
            .signed_refused(&[instruction], args.lender.actor, 0, expected);
        self.assert_invariants();
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

    fn record(&mut self, holder: Pubkey, intent: Pubkey) -> TransactionMetadata {
        let args = self.record_args(holder, intent);
        self.record_ok(&args)
    }

    fn record_refused(&mut self, args: &RecordArgs, expected: ThetisError) {
        let instructions = self.record_instructions(args);
        self.f.sponsored_refused(&instructions, 1, expected);
        assert_eq!(
            self.intent_state(args.intent).status,
            LoadingStatus::Open,
            "a refused loading leaves the intent open"
        );
        self.assert_invariants();
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

    fn attest_refused(&mut self, args: &ShortfallArgs, expected: ThetisError) {
        let instructions = self.shortfall_instructions(args);
        self.f.sponsored_refused(&instructions, 1, expected);
        assert!(!self.f.account_exists(self.incident(&args.incident_id)));
        self.assert_invariants();
    }

    fn restrict_instruction(
        &self,
        signer: Actor,
        restriction: Restriction,
        reason_digest: [u8; 32],
    ) -> Instruction {
        ix(
            accounts::SetRestriction {
                accreditor: self.f.key(signer),
                protocol: self.f.protocol,
                lot: self.lot,
            },
            instruction::SetRestriction {
                restriction,
                reason_digest,
            },
        )
    }

    /// The accreditor sets `restriction`; checks that only the lot's restriction and revision
    /// change, the event and the invariants.
    fn restrict(&mut self, restriction: Restriction, reason_digest: [u8; 32]) {
        let before = self.lot_state();
        let untouched = self.snapshot(&[self.f.protocol, Self::mint(self.lot), self.position()]);
        let instruction = self.restrict_instruction(Accreditor, restriction, reason_digest);
        let tx = self.f.ok(instruction, Accreditor);
        let mut lot = before.clone();
        lot.restriction = restriction;
        lot.revision += 1;
        assert_same(&self.lot_state(), &lot);
        self.assert_unchanged(&untouched);
        assert_events(
            &tx,
            vec![events::RestrictionSet {
                lot: self.lot,
                from: before.restriction,
                to: restriction,
                reason_digest,
                revision: lot.revision,
            }
            .data()],
        );
        self.assert_invariants();
    }

    fn restrict_refused(
        &mut self,
        signer: Actor,
        restriction: Restriction,
        reason_digest: [u8; 32],
        expected: ThetisError,
    ) {
        let instruction = self.restrict_instruction(signer, restriction, reason_digest);
        self.f.refused(instruction, signer, expected);
        self.assert_invariants();
    }

    /// Collects the whole of CR-0001 at the source: the lot is `Redeemed`.
    fn redeem_whole_lot(&mut self) {
        let collect = self.redeem_instructions(
            self.lot,
            None,
            LOT_KG,
            Custodian,
            self.custodian,
            self.source,
        );
        self.f.sponsored_ok(&collect);
        assert_eq!(self.lot_state().state, LotState::Redeemed);
    }

    /// CR-0001 shipped to PORT-T1 and wholly loaded there: the lot is `Loaded`.
    fn loaded() -> Self {
        let mut w = Self::at_terminal();
        let intent = w.create_intent(1);
        w.record(w.owner, intent);
        assert_eq!(w.lot_state().state, LotState::Loaded);
        w
    }
}

// ================================================================ attest_shortfall ====

#[test]
fn attest_shortfall_outside_tolerance_sets_review_required() {
    // The whole lot, 4,990 t of 5,000 t at tolerance 0: outside, so the Normal lot moves to
    // ReviewRequired with one revision.
    let mut w = World::new();
    let revision = w.lot_state().revision;
    let args = ShortfallArgs {
        tolerance_bps: 0,
        ..w.shortfall_args(None)
    };
    let incident = w.attest_ok(&args);
    let stored: Incident = w.f.read(incident);
    assert!(!stored.within_tolerance);
    assert_eq!(stored.expected_kg, LOT_KG);
    assert_eq!(stored.batch, None);
    assert_eq!(stored.restriction_after, Restriction::ReviewRequired);
    let lot = w.lot_state();
    assert_eq!(lot.restriction, Restriction::ReviewRequired);
    assert_eq!(lot.revision, revision + 1);
    // The restriction is the one every handler reads: shipping is now refused.
    let (prepare, _, _, _) = w.prepare_instructions(w.terminal_class);
    w.f.sponsored_refused(&prepare, 1, Restricted);
}

#[test]
fn attest_shortfall_within_tolerance_recorded_without_restriction() {
    // §6.2's reading of batch 1 of 1 while it is on the road: within 50 bps, so the Incident is
    // recorded and the lot keeps Normal and its revision. Nothing is slashed (A20).
    let mut w = World::new();
    let (_, batch) = w.prepare_to(w.terminal_class);
    w.hand_over(batch, w.transporter);
    let before = w.lot_state();
    assert_eq!(before.state, LotState::InTransit);
    let args = w.shortfall_args(Some(batch));
    let incident = w.attest_ok(&args);
    let stored: Incident = w.f.read(incident);
    assert!(stored.within_tolerance);
    assert_eq!(stored.batch, Some(batch));
    assert_eq!(stored.expected_kg, LOT_KG);
    assert_eq!(stored.restriction_after, Restriction::Normal);
    assert_same(&w.lot_state(), &before);
    // The batch still arrives.
    w.hand_over(batch, w.terminal);
    assert_eq!(w.lot_state().state, LotState::Stored);
}

#[test]
fn attest_shortfall_rejects_repeated_incident_id() {
    // An incident id is used once per protocol, ever (A20): a second reading under the same id,
    // even of a different shape, fails at init and changes nothing.
    let mut w = World::new();
    let args = w.shortfall_args(None);
    w.attest_ok(&args);
    let stored = w.f.raw_account(w.incident(&INCIDENT_ONE));
    let again = ShortfallArgs {
        tolerance_bps: 0,
        ..args.clone()
    };
    let instructions = w.shortfall_instructions(&again);
    w.f.sponsored_already_in_use(&instructions, 1);
    let (_, batch) = w.prepare_to(w.terminal_class);
    let with_batch = ShortfallArgs {
        batch: Some(batch),
        ..args
    };
    let instructions = w.shortfall_instructions(&with_batch);
    w.f.sponsored_already_in_use(&instructions, 1);
    assert_eq!(w.f.raw_account(w.incident(&INCIDENT_ONE)), stored);
    assert_eq!(w.lot_state().restriction, Restriction::Normal);
}

#[test]
fn attest_shortfall_changes_no_loan_pool_or_position() {
    // The simulation pool funds a USD600,000 borrow against the whole 5,000 t; a reading within
    // tolerance and one outside it leave every lending, pool and position account byte-identical
    // (A20). Only the lot's restriction and revision move, on the outside reading.
    let mut w = World::in_mode(SettlementMode::DevnetTokenSimulation);
    let lender = w.lender_one;
    w.open_pool_and_deposit();
    w.open_facility(lender);
    let valuation = w.set_valuation(lender, w.source);
    let (loan, lock) = w.pledge(lender, LOT_KG);
    w.borrow(loan, valuation);
    let position = w.position();
    let keys = [
        lender.facility,
        valuation,
        loan,
        lock,
        w.pool,
        w.pool_share(),
        w.pool_authority,
        w.pool_vault,
        POOL_MINT,
        w.ata(Owner),
        w.ata(Lender),
        position,
        World::vault(w.lot, position),
        World::vault_authority(position),
        World::mint(w.lot),
        w.intake(),
        w.source,
        w.owner,
        lender.org,
    ];
    let snapshot = w.snapshot(&keys);
    let inside = w.shortfall_args(None);
    w.attest_ok(&inside);
    w.assert_unchanged(&snapshot);
    let outside = ShortfallArgs {
        incident_id: INCIDENT_TWO,
        tolerance_bps: 0,
        ..inside
    };
    w.attest_ok(&outside);
    w.assert_unchanged(&snapshot);
    assert_eq!(w.lot_state().restriction, Restriction::ReviewRequired);
}

#[test]
fn attest_shortfall_rejects_non_inspector() {
    // Mosela Haulage, a Transporter, whose driver's Authority the harness writes with INSPECT
    // (no role may be delegated it): otherwise valid, refused on the role.
    let mut w = World::new();
    w.f.forge_authority(
        w.transporter,
        w.f.key(Driver),
        scope::CARRY | scope::INSPECT,
        NOW + AUTHORITY_LIFETIME,
    );
    let args = ShortfallArgs {
        signer: Driver,
        inspector_org: w.transporter,
        ..w.shortfall_args(None)
    };
    w.attest_refused(&args, WrongRole);
}

#[test]
fn attest_shortfall_rejects_inspector_without_authority() {
    // An Inspector Test Org wallet with no Authority: the Authority PDA the relay derives does
    // not exist, so Anchor refuses it before the handler.
    let mut w = World::new();
    let args = ShortfallArgs {
        signer: UnlinkedDriver,
        ..w.shortfall_args(None)
    };
    assert!(!w.f.account_exists(w.authority_of(UnlinkedDriver)));
    let instructions = w.shortfall_instructions(&args);
    w.f.sponsored_refused_anchor(&instructions, 1, AnchorError::AccountNotInitialized);
    assert!(!w.f.account_exists(w.incident(&INCIDENT_ONE)));
}

#[test]
fn attest_shortfall_rejects_not_a_shortfall() {
    // A reading at or above the expected quantity is not a shortfall, for the whole lot and for
    // a batch.
    let mut w = World::new();
    for observed_kg in [LOT_KG, LOT_KG + 1, u64::MAX] {
        let args = ShortfallArgs {
            observed_kg,
            ..w.shortfall_args(None)
        };
        w.attest_refused(&args, InvalidField);
    }
    let (_, batch) = w.prepare_to(w.terminal_class);
    let args = ShortfallArgs {
        observed_kg: LOT_KG,
        ..w.shortfall_args(Some(batch))
    };
    w.attest_refused(&args, InvalidField);
    // One kilogram short is a shortfall.
    let args = ShortfallArgs {
        observed_kg: LOT_KG - 1,
        ..w.shortfall_args(Some(batch))
    };
    w.attest_ok(&args);
}

#[test]
fn attest_shortfall_rejects_invalid_fields() {
    // Each otherwise valid: tolerance above 10,000 bps, a method code outside [A-Z0-9-] 1–8, a
    // zero evidence digest, an observation time after now or before 0.
    let mut w = World::new();
    let valid = w.shortfall_args(None);
    let mut cases = vec![ShortfallArgs {
        tolerance_bps: 10_001,
        ..valid.clone()
    }];
    for method in ["", "weigh", "WEIGH BR", "WEIGH_1", "WEIGHBRID"] {
        cases.push(ShortfallArgs {
            method_code: method.into(),
            ..valid.clone()
        });
    }
    cases.push(ShortfallArgs {
        evidence_digest: [0; 32],
        ..valid.clone()
    });
    for observed_at in [w.now + 1, -1] {
        cases.push(ShortfallArgs {
            observed_at,
            ..valid.clone()
        });
    }
    for args in &cases {
        w.attest_refused(args, InvalidField);
    }
    // The bounds are accepted: 10,000 bps, an 8-byte code, observed at 0.
    let args = ShortfallArgs {
        tolerance_bps: 10_000,
        method_code: "WEIGH-01".into(),
        observed_at: 0,
        ..valid
    };
    w.attest_ok(&args);
}

#[test]
fn attest_shortfall_rejects_batch_of_other_lot() {
    // A batch whose stored lot is another lot's address (the harness rewrites only that field):
    // the binding refuses it.
    let mut w = World::new();
    let (_, batch) = w.prepare_to(w.terminal_class);
    let mut stored: ManifestBatch = w.f.read(batch);
    stored.lot = pda(&[b"lot", w.f.protocol.as_ref(), CHILD_LOT_ID.as_bytes()]);
    w.f.set_program_account(batch, &stored);
    let args = ShortfallArgs {
        observed_kg: LOT_KG - 1,
        ..w.shortfall_args(Some(batch))
    };
    let instructions = w.shortfall_signed(&args, b"never checked");
    // The text is never reached: the binding comes first.
    w.f.sponsored_refused(&instructions, 1, WrongOrganisation);
}

#[test]
fn attest_shortfall_rejects_retired_lot() {
    for mut w in [
        {
            let mut w = World::new();
            w.redeem_whole_lot();
            w
        },
        World::loaded(),
    ] {
        let args = ShortfallArgs {
            observed_kg: 0,
            ..w.shortfall_args(None)
        };
        let instructions = w.shortfall_signed(&args, b"never checked");
        w.f.sponsored_refused(&instructions, 1, LotRetired);
        assert!(!w.f.account_exists(w.incident(&INCIDENT_ONE)));
    }
}

#[test]
fn attest_shortfall_keeps_frozen_restriction() {
    // An outside-tolerance reading never lowers or replaces a restriction: Frozen (and every
    // other non-Normal value) stays, with no revision, and the Incident records it.
    for restriction in [
        Restriction::Frozen,
        Restriction::Disputed,
        Restriction::ReviewRequired,
    ] {
        let mut w = World::new();
        w.restrict(restriction, REASON_ONE);
        let before = w.lot_state();
        let args = ShortfallArgs {
            tolerance_bps: 0,
            ..w.shortfall_args(None)
        };
        let incident = w.attest_ok(&args);
        assert_same(&w.lot_state(), &before);
        let stored: Incident = w.f.read(incident);
        assert!(!stored.within_tolerance);
        assert_eq!(stored.restriction_after, restriction);
    }
}

// ================================================================= set_restriction ====

#[test]
fn set_restriction_by_accreditor_succeeds() {
    // Every drawn transition out of each value (§5), each one revision, on a Stored lot and on
    // a lot in transit.
    let mut w = World::new();
    use Restriction::*;
    for (to, reason) in [
        (ReviewRequired, REASON_ONE),
        (Normal, REASON_TWO),
        (Disputed, REASON_ONE),
        (ReviewRequired, REASON_TWO),
        (Frozen, REASON_ONE),
        (Disputed, REASON_TWO),
        (Frozen, REASON_ONE),
        (ReviewRequired, REASON_TWO),
        (Disputed, REASON_ONE),
        (Normal, REASON_TWO),
        (Frozen, REASON_ONE),
        (Normal, REASON_TWO),
    ] {
        w.restrict(to, reason);
    }
    let (_, batch) = w.prepare_to(w.terminal_class);
    w.hand_over(batch, w.transporter);
    w.restrict(Frozen, REASON_ONE);
    w.restrict(Normal, REASON_TWO);
    w.hand_over(batch, w.terminal);
    assert_eq!(w.lot_state().state, LotState::Stored);
}

#[test]
fn set_restriction_rejects_non_accreditor() {
    // The protocol admin, the lot's custodian and the owner are not the accreditor.
    let mut w = World::new();
    for signer in [Admin, Custodian, Owner, Inspector] {
        w.restrict_refused(signer, Restriction::Frozen, REASON_ONE, NotAccreditor);
    }
}

#[test]
fn set_restriction_rejects_unchanged_or_missing_reason() {
    let mut w = World::new();
    w.restrict_refused(Accreditor, Restriction::Normal, REASON_ONE, InvalidField);
    w.restrict_refused(Accreditor, Restriction::Frozen, [0; 32], InvalidField);
    w.restrict(Restriction::Frozen, REASON_ONE);
    w.restrict_refused(Accreditor, Restriction::Frozen, REASON_TWO, InvalidField);
    w.restrict_refused(Accreditor, Restriction::Normal, [0; 32], InvalidField);
}

#[test]
fn set_restriction_rejects_retired_lot() {
    let mut redeemed = World::new();
    redeemed.redeem_whole_lot();
    let mut loaded = World::loaded();
    for w in [&mut redeemed, &mut loaded] {
        w.restrict_refused(Accreditor, Restriction::Frozen, REASON_ONE, LotRetired);
    }
}

// ====================================================== what a restriction blocks ====

#[test]
fn frozen_lot_never_blocks_repay() {
    // A USD600,000 advance on the whole lot, then the accreditor freezes the lot: the lender's
    // confirmed repayment still applies in full (domain.md §5).
    let mut w = World::new();
    let lender = w.lender_one;
    w.open_facility(lender);
    let valuation = w.set_valuation(lender, w.source);
    let (loan, _) = w.pledge(lender, LOT_KG);
    w.advance(lender, loan, valuation, SIX_HUNDRED_K);
    w.restrict(Restriction::Frozen, REASON_ONE);
    let payment = w.confirm(
        lender,
        loan,
        1,
        PaymentPurpose::Repayment,
        loan,
        None,
        SIX_HUNDRED_K,
    );
    let before = w.loan_state(loan);
    w.repay(lender, loan, payment, SIX_HUNDRED_K);
    let after = w.loan_state(loan);
    assert!(after.principal < before.principal);
    assert_eq!(
        before.principal + before.booked_interest,
        after.principal + after.booked_interest + SIX_HUNDRED_K
    );
    assert_eq!(w.lot_state().restriction, Restriction::Frozen);
    w.assert_invariants();
}

#[test]
fn frozen_lot_blocks_prepare_and_loading() {
    // At PORT-T1 with one positive 3,000 t lock; intent 1 created and accepted; then frozen.
    let (mut w, loan, _, _) = terminal_with_lock(THREE_THOUSAND_T);
    let lender = w.lender_one;
    let intent = w.create_intent(1);
    w.accept(lender, loan, intent);
    let revision = w.lot_state().revision;
    w.restrict(Restriction::Frozen, REASON_ONE);
    assert_eq!(w.lot_state().revision, revision + 1);

    // prepare_shipment back to the source, signed at the post-freeze lot revision.
    let (prepare, _, _, _) = w.prepare_instructions(w.source);
    w.f.sponsored_refused(&prepare, 1, Restricted);
    // create_loading_intent with a new nonce at the current position revision.
    let args = w.intent_args(w.owner, 2, LOADING_DOCUMENT);
    w.create_intent_refused(&args, Restricted);
    // accept_loading of intent 1 at the current loan revision.
    let args = w.accept_args(lender, loan, intent);
    w.accept_refused(&args, Restricted);
    // record_loading of intent 1 with its valid acceptance.
    let args = w.record_args(w.owner, intent);
    assert_eq!(args.triples.len(), 1);
    w.record_refused(&args, Restricted);
}

// ===================================================================== texts ====

#[test]
fn shortfall_message_known_answer() {
    let program: Pubkey = "jGJpdjtoDUtXMjvc4UaEi1mBeFZKqVfe9jL8ireHMs3"
        .parse()
        .unwrap();
    let instance: [u8; 16] = core::array::from_fn(|i| u8::try_from(i * 0x11).unwrap());
    let observed_at = 1_795_098_425;
    let valid_until = 1_795_098_725;
    let text = |batch: Option<(u8, u8, &[u8; 32])>| {
        shortfall_message(
            &program,
            &instance,
            "CR-0001",
            &[0x88; 16],
            batch,
            "Inspector Test Org",
            "WEIGH",
            5_000_000,
            4_990_000,
            50,
            &[0x99; 32],
            observed_at,
            valid_until,
        )
    };
    let with_batch = text(Some((1, 1, &[0x33; 32])));
    assert_eq!(
        String::from_utf8(with_batch.clone()).unwrap(),
        "Thetis authorisation v1\n\
         Network: devnet\n\
         Program: jGJpdjtoDUtXMjvc4UaEi1mBeFZKqVfe9jL8ireHMs3\n\
         Protocol: 00112233445566778899aabbccddeeff\n\
         Action: Attest shortfall\n\
         Lot: CR-0001\n\
         Incident: 88888888888888888888888888888888\n\
         Batch: 1 of 1\n\
         Load: 3333333333333333333333333333333333333333333333333333333333333333\n\
         Inspector: Inspector Test Org\n\
         Method: WEIGH\n\
         Expected: 5,000.000 t\n\
         Observed: 4,990.000 t\n\
         Tolerance: 0.50%\n\
         Evidence: 9999999999999999999999999999999999999999999999999999999999999999\n\
         Observed at: 2026-11-19 16:27:05 SAST\n\
         Valid until: 2026-11-19 16:32:05 SAST\n\
         Test network only. Synthetic data."
    );
    assert_eq!(with_batch.len(), 592);
    assert_eq!(
        sha256_hex(&with_batch),
        "24792d8e4b075bd9bad82ff37e698621ea8a996488009ff17f14e3fe9370c847"
    );
    let whole_lot = text(None);
    let expected = String::from_utf8(with_batch).unwrap().replace(
        "Batch: 1 of 1\nLoad: 3333333333333333333333333333333333333333333333333333333333333333",
        "Batch: whole lot\nLoad: none",
    );
    assert_eq!(String::from_utf8(whole_lot.clone()).unwrap(), expected);
    assert_eq!(whole_lot.len(), 535);
    assert_eq!(
        sha256_hex(&whole_lot),
        "ee2889db2676c494f713c962e5a85f23757c30cd8d30a64fe4cd9afe2552a625"
    );
}

#[test]
fn shortfall_text_line_mutations_refused() {
    // Every rendered line of both forms of the text, its last byte replaced, signed by the
    // inspector with valid accounts and arguments (§9).
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
        let lines = text.iter().filter(|byte| **byte == b'\n').count() + 1;
        let mutations = line_mutations(&text);
        assert_eq!(mutations.len(), lines);
        for mutated in mutations {
            let instructions = w.shortfall_signed(args, &mutated);
            w.f.sponsored_refused(&instructions, 1, MessageMismatch);
        }
        w.attest_ok(args);
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

// ================================================================== sizes ====

const WIDEST_INSPECTOR: &str = "Inspector Test Org And Allied Surveyors Pty 0001";
const WIDEST_LOT_ID: &str = "CR-0001-WIDEST-1";
const WIDEST_METHOD: &str = "WEIGH-01";

/// Compiles `[compute budget, verify, action]` as a sponsored v0 transaction against `table`
/// and checks that only the sponsor signs, that `inline` are the only static keys, and that the
/// table supplies exactly `writable` and `readonly`. Returns the transaction and its size.
fn v0(
    w: &mut World,
    table: &AddressLookupTableAccount,
    instructions: [Instruction; 2],
    inline: Vec<Pubkey>,
    writable: Vec<Pubkey>,
    readonly: Vec<Pubkey>,
) -> (VersionedTransaction, usize) {
    let [verify, action] = instructions;
    let tx = w.f.sponsored_v0(
        &[compute_unit_limit(), verify, action],
        std::slice::from_ref(table),
    );
    assert_eq!(tx.signatures.len(), 1, "only the sponsor signs");
    let VersionedMessage::V0(message) = &tx.message else {
        panic!("a v0 message");
    };
    assert_eq!(sorted(message.account_keys.clone()), sorted(inline));
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
    assert_eq!(loaded(&lookup.writable_indexes), sorted(writable));
    assert_eq!(loaded(&lookup.readonly_indexes), sorted(readonly));
    let size = transaction_size(&tx);
    (tx, size)
}

#[test]
fn attest_shortfall_size_fits_v0_widest() {
    // The executed demo shape (batch present, in transit), then the widest values over the same
    // accounts, serialised only (§11.1).
    let mut w = World::new();
    let lot = w.lot;
    let (_, batch) = w.prepare_to(w.terminal_class);
    w.hand_over(batch, w.transporter);
    let demo = w.shortfall_args(Some(batch));
    let widest_id = [0xff; 16];
    let demo_incident = w.incident(&demo.incident_id);
    let widest_incident = w.incident(&widest_id);
    let readonly = vec![
        w.f.protocol,
        w.inspector,
        w.authority_of(Inspector),
        batch,
        INSTRUCTIONS_SYSVAR,
        SYSTEM,
    ];
    // The relay appends the Incident PDA before it attests (§4.6, §11.1 item 3).
    let mut addresses = readonly.clone();
    addresses.extend([lot, demo_incident, widest_incident]);
    let table = w.f.create_lookup_table(addresses);
    let inline = vec![w.f.payer(), ID, ED25519, COMPUTE_BUDGET];
    assert_eq!(readonly.len() + 2, 8);

    let instructions = w.shortfall_instructions(&demo);
    let (tx, demo_size) = v0(
        &mut w,
        &table,
        instructions,
        inline.clone(),
        vec![lot, demo_incident],
        readonly.clone(),
    );
    assert!(demo_size <= PACKET_DATA_SIZE);
    let meta =
        w.f.send(tx)
            .unwrap_or_else(|failure| panic!("{:?}\n{}", failure.err, failure.meta.pretty_logs()));
    let units = meta.compute_units_consumed;
    assert!(
        units < u64::from(COMPUTE_UNIT_LIMIT),
        "attest_shortfall used {units} CU"
    );
    println!("attest_shortfall v0 demo: {units} CU, {demo_size} bytes");
    assert!(w.f.read::<Incident>(demo_incident).within_tolerance);
    w.assert_invariants();

    assert_eq!(WIDEST_INSPECTOR.len(), MAX_DISPLAY_NAME);
    assert_eq!(WIDEST_LOT_ID.len(), MAX_LOT_ID);
    assert_eq!(WIDEST_METHOD.len(), MAX_METHOD_CODE);
    let widest_text = |batch: Option<(u8, u8, &[u8; 32])>| {
        shortfall_message(
            &ID,
            &INSTANCE,
            WIDEST_LOT_ID,
            &widest_id,
            batch,
            WIDEST_INSPECTOR,
            WIDEST_METHOD,
            u64::MAX,
            u64::MAX - 1,
            10_000,
            &SHORTFALL_EVIDENCE,
            i64::MAX,
            i64::MAX,
        )
    };
    let text = widest_text(Some((16, 16, &[0x33; 32])));
    assert_eq!(text.len(), 688);
    assert_eq!(widest_text(None).len(), 629);
    let widest = ShortfallArgs {
        incident_id: widest_id,
        observed_kg: u64::MAX - 1,
        tolerance_bps: 10_000,
        method_code: WIDEST_METHOD.into(),
        observed_at: i64::MAX,
        valid_until: i64::MAX,
        ..demo.clone()
    };
    let instructions = w.shortfall_signed(&widest, &text);
    let (_, widest_size) = v0(
        &mut w,
        &table,
        instructions.clone(),
        inline.clone(),
        vec![lot, widest_incident],
        readonly.clone(),
    );
    println!("attest_shortfall v0 widest: {widest_size} bytes");
    assert_eq!(widest_size, 1_192);
    assert!(widest_size <= PACKET_DATA_SIZE);

    // The whole-lot shape: the batch slot is the program id (inline), the text 629 bytes.
    let whole = ShortfallArgs {
        batch: None,
        ..widest.clone()
    };
    let whole_instructions = w.shortfall_signed(&whole, &widest_text(None));
    let whole_readonly: Vec<Pubkey> = readonly
        .iter()
        .copied()
        .filter(|key| *key != batch)
        .collect();
    let (_, whole_size) = v0(
        &mut w,
        &table,
        whole_instructions,
        inline.clone(),
        vec![lot, widest_incident],
        whole_readonly,
    );
    println!("attest_shortfall v0 widest, whole lot: {whole_size} bytes");
    assert_eq!(whole_size, 1_132);

    // The relay's shape (services/api compile.ts): the protocol stays static. With the
    // Incident appended to the table first (§4.6) it fits; left static as compile.ts leaves a
    // created account, it does not, so a relay that carries this must append it.
    let relay_readonly: Vec<Pubkey> = readonly
        .iter()
        .copied()
        .filter(|key| *key != w.f.protocol)
        .collect();
    let mut relay_addresses = relay_readonly.clone();
    relay_addresses.extend([lot, widest_incident]);
    let relay_table = w.f.create_lookup_table(relay_addresses);
    let mut relay_inline = inline.clone();
    relay_inline.push(w.f.protocol);
    let (_, relay_size) = v0(
        &mut w,
        &relay_table,
        instructions.clone(),
        relay_inline.clone(),
        vec![lot, widest_incident],
        relay_readonly.clone(),
    );
    println!("attest_shortfall v0 widest, relay shape with the incident in the table: {relay_size} bytes");
    assert_eq!(relay_size, 1_223);
    assert!(relay_size <= PACKET_DATA_SIZE);
    let mut static_addresses = relay_readonly.clone();
    static_addresses.push(lot);
    let static_table = w.f.create_lookup_table(static_addresses);
    relay_inline.push(widest_incident);
    let (_, static_size) = v0(
        &mut w,
        &static_table,
        instructions,
        relay_inline,
        vec![lot],
        relay_readonly,
    );
    println!(
        "attest_shortfall v0 widest, relay shape with the incident static: {static_size} bytes"
    );
    assert_eq!(static_size, 1_254);
    assert!(static_size > PACKET_DATA_SIZE);
}
