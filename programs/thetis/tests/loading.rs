//! Phase 3: loading at the terminal — `create_loading_intent` (the owner's PS), `accept_loading`
//! (each affected lender's TX, one per loan) and `record_loading` (PS×2: the owner and the
//! terminal), program-custody.md §4.4, §6.1–§6.5 and §9 (A16, A17).
//!
//! Demo quantities and money are the demo's (5,000 t, 3,000 t, 2,000 t, USD600,000, USD400,000,
//! 20 c/kg, haircut 0, LTV 60%, 1,200 bps) plus the bounds 0, 1 and `u64::MAX`; site
//! capacities are fixture values stated below. The demo cast is synthetic; the second terminal
//! uses the harness's generated test name. Shipment ids, digests, site codes, payment ids,
//! nonces and expiries are deterministic synthetic test inputs.

mod common;

use anchor_lang::{
    __private::base64::{engine::general_purpose::STANDARD, Engine},
    error::ErrorCode as AnchorError,
    prelude::Pubkey,
    AccountSerialize, AnchorDeserialize, Event,
};
use anchor_spl::associated_token::get_associated_token_address_with_program_id;
use common::{Actor::*, *};
use litesvm::types::TransactionMetadata;
use solana_message::{AddressLookupTableAccount, VersionedMessage};
use solana_transaction::{versioned::VersionedTransaction, AccountMeta, Instruction};
use thetis::{
    accounts,
    error::ThetisError::{self, *},
    events, instruction,
    intent::message::{
        advance_message, buy_pledged_message, cancel_shipment_message, custody_handover_message,
        issue_message, loading_intent_message, pledge_message, prepare_shipment_message,
        record_loading_message, redeem_message, release_intent_message, split_message,
        transfer_message,
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

const HOUR: i64 = 3_600;
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
const TWO_THOUSAND_T: u64 = 2_000_000;
const DEPARTURE_SHA: [u8; 32] = [0xdd; 32];
const COLLECTION_TICKET: [u8; 32] = [0xc7; 32];
/// The bill-of-lading digests: the vectors' 32 × 0xaa, and a replacement document.
const LOADING_DOCUMENT: [u8; 32] = [0xaa; 32];
const OTHER_DOCUMENT: [u8; 32] = [0xab; 32];

const USD: [u8; 3] = *b"USD";
const CENTS: u8 = 2;
const RATE_BPS: u16 = 1_200;
const MAX_LTV_BPS: u16 = 6_000;
/// 20 c/kg in cents.
const VALUE_PER_KG: u64 = 20;
const TERMS_DIGEST: [u8; 32] = [0x7d; 32];
const SOURCE_DIGEST: [u8; 32] = [0x5e; 32];
const EVIDENCE_DIGEST: [u8; 32] = [0xe1; 32];
const FACILITY_ONE: [u8; 16] = [0x11; 16];
const FACILITY_TWO: [u8; 16] = [0x12; 16];
/// USD600,000, USD400,000 and USD200,000 in cents.
const SIX_HUNDRED_K: u64 = 60_000_000;
const FOUR_HUNDRED_K: u64 = 40_000_000;
const TWO_HUNDRED_K: u64 = 20_000_000;

const OWNER_ID: u8 = 1;
const CUSTODIAN_ID: u8 = 2;
const TRANSPORTER_ID: u8 = 3;
const BUYER_ID: u8 = 4;
const TERMINAL_ID: u8 = 5;
const LENDER_TWO_ID: u8 = 6;
const LENDER_ID: u8 = 7;
const OTHER_TERMINAL_ID: u8 = 10;

const OWNER_NAME: &str = "Khunou Ore Exports";
const CUSTODIAN_NAME: &str = "Kopano Stockyard Custody";
const TRANSPORTER_NAME: &str = "Mosela Haulage";
const BUYER_NAME: &str = "Buyer Smelter Co";
const TERMINAL_NAME: &str = "Port Terminal T1";
const LENDER_NAME: &str = "Lender One Bank";
const LENDER_TWO_NAME: &str = "Lender Two Bank";

/// Account sizes, discriminator included (§7).
const LOADING_INTENT_SPACE: usize = 283;
const ACCEPTANCE_SPACE: usize = 213;

/// The one-year accrual denominator of program-lending.md (bps × seconds): 10,000 × 31,536,000.
const ACCRUAL_DENOMINATOR: u128 = 315_360_000_000;

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

/// The first event of `tx` named `E`, decoded.
fn first_event<E: Event + AnchorDeserialize>(tx: &TransactionMetadata) -> E {
    event_data(tx)
        .map(|data| STANDARD.decode(data).unwrap())
        .find(|bytes| bytes.starts_with(E::DISCRIMINATOR))
        .map(|bytes| E::deserialize(&mut &bytes[E::DISCRIMINATOR.len()..]).unwrap())
        .expect("event present")
}

/// Simple interest computed independently of the program: whole units and the carried
/// remainder (program-lending.md §6.3 "Accrual").
fn interest(principal: u64, elapsed: i64, carried: u64) -> (u64, u64) {
    let numerator = u128::from(principal) * u128::from(RATE_BPS) * u128::try_from(elapsed).unwrap()
        + u128::from(carried);
    (
        u64::try_from(numerator / ACCRUAL_DENOMINATOR).unwrap(),
        u64::try_from(numerator % ACCRUAL_DENOMINATOR).unwrap(),
    )
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

/// A fiat protocol with the demo cast; a source site of Kopano Stockyard Custody and the
/// terminal site PORT-T1 of Port Terminal T1 in the chrome class; CR-0001 (5,000 t, grade A)
/// issued at the source to Khunou Ore Exports; Lender One Bank and Lender Two Bank.
struct World {
    f: Fixture,
    now: i64,
    owner: Pubkey,
    custodian: Pubkey,
    transporter: Pubkey,
    buyer: Pubkey,
    terminal: Pubkey,
    other_terminal: Pubkey,
    lender_one: Lender,
    lender_two: Lender,
    class_policy: Pubkey,
    source: Pubkey,
    terminal_class: Pubkey,
    other_terminal_class: Pubkey,
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
}

impl World {
    /// CR-0001 at the source.
    fn new() -> Self {
        let mut f = Fixture::new();
        let init = f.initialize_instance(INSTANCE, SettlementMode::FiatAttestationTest, Admin);
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
        let lender_two_org = accredit(&mut f, LENDER_TWO_ID, Role::Lender, LENDER_TWO_NAME);
        let lender_org = accredit(&mut f, LENDER_ID, Role::Lender, LENDER_NAME);
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
            (lender_two_org, Lender2, scope::LEND),
        ] {
            let delegate = f.delegate(OrgAdmin, org, f.key(wallet), scopes, expires_at);
            f.ok(delegate, OrgAdmin);
        }

        let protocol = f.protocol;
        let facility = |lender: Pubkey, id: &[u8; 16]| {
            pda(&[b"facility", protocol.as_ref(), lender.as_ref(), id])
        };
        let lot = pda(&[b"lot", protocol.as_ref(), LOT_ID.as_bytes()]);
        let mut world = Self {
            f,
            now: NOW,
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
            lender_two: Lender {
                actor: Lender2,
                org: lender_two_org,
                name: LENDER_TWO_NAME,
                facility_id: FACILITY_TWO,
                facility: facility(lender_two_org, &FACILITY_TWO),
            },
            class_policy,
            source,
            terminal_class,
            other_terminal_class,
            lot,
            lot_id: LOT_ID.into(),
            root: None,
            lots: Vec::new(),
            shipments: Vec::new(),
            classes: vec![source, terminal_class, other_terminal_class],
            loans: Vec::new(),
            trips: 0,
            document_versions: Vec::new(),
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

    fn advance_to(&mut self, unix_timestamp: i64) {
        self.now = unix_timestamp;
        self.f.set_time(unix_timestamp);
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

    /// Prepares the world's lot to `destination` in one batch carried by Mosela Haulage and
    /// registers it. Returns the shipment and its batch.
    fn prepare_to(&mut self, destination: Pubkey) -> (Pubkey, Pubkey) {
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
        self.f.sponsored_ok(&[verify, prepare]);
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

    fn cancel(&mut self, shipment: Pubkey) {
        let stored: Shipment = self.f.read(shipment);
        let valid_until = self.now + CUSTODY_WINDOW;
        let destination = self.class_state(stored.destination);
        let text = cancel_shipment_message(
            &ID,
            &INSTANCE,
            &self.lot_id,
            &stored.shipment_id,
            OWNER_NAME,
            &self.name(stored.destination_custodian),
            &destination.site_code,
            stored.revision,
            valid_until,
        );
        let cancel = ix(
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
                valid_until,
            },
        );
        let verify = ed25519_instruction(&[(self.f.signer(Owner), text.as_slice())]);
        self.f.sponsored_ok(&[verify, cancel]);
        assert_eq!(self.lot_state().state, LotState::Stored);
        self.assert_invariants();
    }

    // -------------------------------------------------- Phase 1 instructions ----

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

    /// Splits `quantity_kg` of CR-0001 at the source into the child CR-0002, owned by the
    /// owner. Returns the child lot.
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

    fn close_loan_instruction(&self, lender: Lender, loan: Pubkey, lock: Pubkey) -> Instruction {
        ix(
            accounts::CloseLoan {
                lender: self.f.key(lender.actor),
                protocol: self.f.protocol,
                authority: self.authority_of(lender.actor),
                lender_org: lender.org,
                facility: lender.facility,
                loan,
                lock,
                position: self.position(),
            },
            instruction::CloseLoan {
                expected_revision: self.loan_state(loan).revision,
            },
        )
    }

    fn release_intent_key(loan: Pubkey, nonce: u64) -> Pubkey {
        pda(&[b"release", loan.as_ref(), &nonce.to_le_bytes()])
    }

    /// Lender One Bank's release intent `nonce` on `loan` for 2,000 t to Buyer Smelter Co at
    /// USD400,000, signed at the position's current revision.
    fn release_intent_instructions(&self, loan: Pubkey, nonce: u64) -> [Instruction; 2] {
        let lender = self.lender_one;
        let revision = self.position_state().revision;
        let valid_until = self.now + MONEY_WINDOW;
        let expires_at = self.now + DAY;
        let text = release_intent_message(
            &ID,
            &INSTANCE,
            &self.lot_id,
            TWO_THOUSAND_T,
            OWNER_NAME,
            BUYER_NAME,
            lender.name,
            &lender.facility_id,
            self.loan_state(loan).index,
            nonce,
            FOUR_HUNDRED_K,
            0,
            &USD,
            CENTS,
            expires_at,
            revision,
            valid_until,
        );
        let create = ix(
            accounts::CreateReleaseIntent {
                sponsor: self.f.payer(),
                protocol: self.f.protocol,
                seller_org: self.owner,
                seller_authority: self.authority_of(Owner),
                buyer_org: self.buyer,
                lender_org: lender.org,
                facility: lender.facility,
                loan,
                lock: pda(&[b"lock", loan.as_ref()]),
                lot: self.lot,
                position: self.position(),
                intent: Self::release_intent_key(loan, nonce),
                instructions: INSTRUCTIONS_SYSVAR,
                system_program: SYSTEM,
            },
            instruction::CreateReleaseIntent {
                nonce,
                quantity_kg: TWO_THOUSAND_T,
                price: FOUR_HUNDRED_K,
                top_up: 0,
                expires_at,
                expected_revision: revision,
                valid_until,
            },
        );
        [
            ed25519_instruction(&[(self.f.signer(Owner), text.as_slice())]),
            create,
        ]
    }

    /// Buyer Smelter Co's `sell_pledged` of release intent `intent` with `payment`, valued by
    /// `valuation`, signed at `expected_revision`.
    fn sell_instructions(
        &self,
        loan: Pubkey,
        intent: Pubkey,
        payment: Pubkey,
        valuation: Pubkey,
        expected_revision: u64,
    ) -> [Instruction; 2] {
        let lender = self.lender_one;
        let stored: ReleaseIntent = self.f.read(intent);
        let valid_until = self.now + MONEY_WINDOW;
        let position = self.position();
        let buyer_position = Self::position_key(self.lot, self.buyer);
        let text = buy_pledged_message(
            &ID,
            &INSTANCE,
            &self.lot_id,
            stored.quantity_kg,
            OWNER_NAME,
            BUYER_NAME,
            lender.name,
            &lender.facility_id,
            self.loan_state(loan).index,
            stored.nonce,
            stored.price,
            stored.top_up,
            &USD,
            CENTS,
            expected_revision,
            valid_until,
        );
        let sell = ix(
            accounts::SellPledged {
                sponsor: self.f.payer(),
                protocol: self.f.protocol,
                facility: lender.facility,
                lender_org: lender.org,
                loan,
                lock: pda(&[b"lock", loan.as_ref()]),
                valuation,
                intent,
                payment,
                lot: self.lot,
                mint: Self::mint(self.lot),
                seller_org: self.owner,
                buyer_org: self.buyer,
                buyer_authority: self.authority_of(Buyer),
                seller_position: position,
                seller_vault_authority: Self::vault_authority(position),
                seller_vault: Self::vault(self.lot, position),
                buyer_position,
                buyer_vault_authority: Self::vault_authority(buyer_position),
                buyer_vault: Self::vault(self.lot, buyer_position),
                instructions: INSTRUCTIONS_SYSVAR,
                token_program: TOKEN_2022,
                associated_token_program: ASSOCIATED_TOKEN,
                system_program: SYSTEM,
            },
            instruction::SellPledged {
                expected_revision,
                valid_until,
            },
        );
        [
            ed25519_instruction(&[(self.f.signer(Buyer), text.as_slice())]),
            sell,
        ]
    }

    /// The A16 fixture: Lender One Bank's loan 0 pledges the whole 5,000 t at the source with
    /// USD600,000 advanced (valued at the source), the lot then arrives at PORT-T1 and Lender
    /// One values the terminal's class. The clock does not move from the advance on. Returns
    /// the loan and the terminal valuation.
    fn port_sale_fixture() -> (Self, Pubkey, Pubkey) {
        let mut w = Self::new();
        let lender = w.lender_one;
        w.open_facility(lender);
        let source_valuation = w.set_valuation(lender, w.source);
        let (loan, _) = w.pledge(lender, LOT_KG);
        w.advance(lender, loan, source_valuation, SIX_HUNDRED_K);
        w.ship_to(w.terminal_class);
        let valuation = w.set_valuation(lender, w.terminal_class);
        (w, loan, valuation)
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

    /// Writes `restriction` into the lot's account (the harness route until the restriction
    /// instructions exist, §9).
    fn set_restriction(&mut self, restriction: Restriction) {
        let mut stored = self.lot_state();
        stored.restriction = restriction;
        let lot = self.lot;
        self.f.set_program_account(lot, &stored);
    }

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

// ============================================================ the demo (A17) ====

#[test]
fn create_loading_intent_demo_creates_intent_and_raises_revision() {
    let mut w = World::at_terminal();
    let revision = w.position_state().revision;
    let intent = w.create_intent(1);
    let stored = w.intent_state(intent);
    assert_eq!(stored.quantity_kg, LOT_KG);
    assert_eq!(stored.locked_kg, 0);
    assert_eq!(stored.terminal, w.terminal);
    assert_eq!(stored.custodian_class, w.terminal_class);
    assert_eq!(stored.position_revision, revision + 1);
    assert_eq!(w.position_state().revision, revision + 1);
    // Nothing else moves: the lot stays stored at the terminal with its occupancy.
    assert_eq!(w.lot_state().state, LotState::Stored);
    assert_eq!(w.class_state(w.terminal_class).occupied_kg, LOT_KG);
}

#[test]
fn accept_loading_demo_records_debt_snapshot() {
    let (mut w, loan, lock, valuation) = terminal_with_lock(LOT_KG);
    let lender = w.lender_one;
    w.advance(lender, loan, valuation, SIX_HUNDRED_K);
    let intent = w.create_intent(1);
    // Interest accrues on the loan, but the acceptance records the stored figures only.
    w.advance_to(w.now + HOUR);
    let acceptance = w.accept(lender, loan, intent);
    let stored: HandoffAcceptance = w.f.read(acceptance);
    assert_eq!(stored.lock, lock);
    assert_eq!(stored.lock_quantity_kg, LOT_KG);
    assert_eq!(stored.principal, SIX_HUNDRED_K);
    assert_eq!(stored.booked_interest, 0);
    assert_eq!(stored.loan_revision, w.loan_state(loan).revision);
    assert_eq!(stored.version, 1);
}

#[test]
fn loading_demo_unpaid_leaves_external_handoff_debt() {
    let (mut w, loan, lock, valuation) = terminal_with_lock(LOT_KG);
    let lender = w.lender_one;
    w.advance(lender, loan, valuation, SIX_HUNDRED_K);
    let advanced_at = w.now;
    let intent = w.create_intent(1);
    w.accept(lender, loan, intent);
    w.advance_to(w.now + HOUR);
    let tx = w.record(w.owner, intent);

    // Units burned, occupancy freed, the whole lot loaded.
    assert_eq!(w.position_state().quantity_kg, 0);
    assert_eq!(w.mint_supply_of_lot(), 0);
    assert_eq!(w.class_state(w.terminal_class).occupied_kg, 0);
    assert_eq!(w.lot_state().state, LotState::Loaded);
    // The debt stays recorded, with interest accrued to the loading: an external hand-off.
    let stored = w.loan_state(loan);
    assert_eq!(stored.status, LoanStatus::ExternalHandoff);
    assert_eq!(stored.principal, SIX_HUNDRED_K);
    let (expected_interest, _) = interest(SIX_HUNDRED_K, w.now - advanced_at, 0);
    assert!(expected_interest > 0);
    assert_eq!(stored.booked_interest, expected_interest);
    assert_eq!(w.lock_state(lock).quantity_kg, 0);
    assert_eq!(w.lock_state(lock).control, LockControl::Pledged);
    assert_eq!(w.intent_state(intent).status, LoadingStatus::Executed);
    let handed_off: events::LoanHandedOff = first_event(&tx);
    assert!(handed_off.external_handoff);
    assert_eq!(handed_off.released_kg, LOT_KG);
    let recorded: events::LoadingRecorded = first_event(&tx);
    assert!(recorded.lot_loaded);
    assert_eq!(recorded.loans_accepted, 1);
}

#[test]
fn loading_with_zero_debt_leaves_loan_active_for_closure() {
    let (mut w, loan, lock, _) = terminal_with_lock(THREE_THOUSAND_T);
    let lender = w.lender_one;
    let intent = w.create_intent(1);
    w.accept(lender, loan, intent);
    w.advance_to(w.now + HOUR);
    let tx = w.record(w.owner, intent);
    let stored = w.loan_state(loan);
    assert_eq!(stored.status, LoanStatus::Active);
    assert_eq!(stored.principal + stored.booked_interest, 0);
    assert_eq!(w.lock_state(lock).quantity_kg, 0);
    let handed_off: events::LoanHandedOff = first_event(&tx);
    assert!(!handed_off.external_handoff);
    // The loan closes through close_loan with Phase 2's checks; its lock releases 0 kg.
    let close = w.close_loan_instruction(lender, loan, lock);
    w.f.signed_ok(&[close], lender.actor);
    assert_eq!(w.loan_state(loan).status, LoanStatus::Closed);
    w.assert_invariants();
}

#[test]
fn loading_without_locks_needs_no_acceptance() {
    let mut w = World::at_terminal();
    let intent = w.create_intent(1);
    let args = w.record_args(w.owner, intent);
    assert!(args.triples.is_empty());
    let tx = w.record_ok(&args);
    let recorded: events::LoadingRecorded = first_event(&tx);
    assert_eq!(recorded.loans_accepted, 0);
    assert_eq!(event_data(&tx).count(), 1);
}

// ======================================================= acceptances (A17) ====

#[test]
fn record_loading_rejects_missing_lender() {
    let (mut w, loan, _, _) = terminal_with_lock(THREE_THOUSAND_T);
    let (one, two) = (w.lender_one, w.lender_two);
    w.open_facility(two);
    let (second_loan, _) = w.pledge(two, TWO_THOUSAND_T);
    let intent = w.create_intent(1);
    w.accept(one, loan, intent);
    // Lender Two Bank has not accepted: the relay finds one acceptance and sends one triple.
    let args = w.record_args(w.owner, intent);
    assert_eq!(args.triples.len(), 1);
    w.record_refused(&args, AcceptanceMissing);
    // Once Lender Two accepts, the loading goes through.
    w.accept(two, second_loan, intent);
    w.record(w.owner, intent);
}

#[test]
fn record_loading_rejects_stale_acceptance() {
    let (mut w, loan, _, valuation) = terminal_with_lock(LOT_KG);
    let lender = w.lender_one;
    let intent = w.create_intent(1);
    w.accept(lender, loan, intent);
    // An advance of 1 minor unit after the acceptance raises the loan revision.
    w.advance(lender, loan, valuation, 1);
    let args = w.record_args(w.owner, intent);
    w.record_refused(&args, AcceptanceStale);
}

#[test]
fn accept_loading_reaccept_after_stale_overwrites() {
    let (mut w, loan, _, valuation) = terminal_with_lock(LOT_KG);
    let lender = w.lender_one;
    let intent = w.create_intent(1);
    let acceptance = w.accept(lender, loan, intent);
    w.advance(lender, loan, valuation, 1);
    // The same PDA is overwritten at the new loan revision.
    w.accept(lender, loan, intent);
    let stored: HandoffAcceptance = w.f.read(acceptance);
    assert_eq!(stored.version, 2);
    assert_eq!(stored.principal, 1);
    assert_eq!(stored.loan_revision, w.loan_state(loan).revision);
    w.record(w.owner, intent);
    assert_eq!(w.loan_state(loan).status, LoanStatus::ExternalHandoff);
}

#[test]
fn record_loading_rejects_changed_document() {
    let (mut w, loan, lock, _) = terminal_with_lock(THREE_THOUSAND_T);
    let lender = w.lender_one;
    let first = w.create_intent(1);
    let accepted = w.accept(lender, loan, first);
    // A different bill of lading is a new intent; intent 1's acceptance does not count for it.
    let args = w.intent_args(w.owner, 2, OTHER_DOCUMENT);
    let second = w.create_intent_ok(&args);
    let mut args = w.record_args(w.owner, second);
    args.triples = vec![Triple {
        acceptance: accepted,
        loan,
        lock,
    }];
    args.loans_accepted = 1;
    w.record_refused(&args, AcceptanceMissing);
}

#[test]
fn accept_loading_rejects_newer_lock() {
    let (mut w, loan, _, _) = terminal_with_lock(THREE_THOUSAND_T);
    let (one, two) = (w.lender_one, w.lender_two);
    let intent = w.create_intent(1);
    // After the intent, Lender Two Bank pledges the free 2,000 t: the position revision moves.
    w.open_facility(two);
    w.pledge(two, TWO_THOUSAND_T);
    let args = w.accept_args(one, loan, intent);
    assert_eq!(args.expected_revision, w.loan_state(loan).revision);
    w.accept_refused(&args, StaleRevision);
}

#[test]
fn accept_loading_rejects_other_lender() {
    let (mut w, loan, _, _) = terminal_with_lock(THREE_THOUSAND_T);
    let two = w.lender_two;
    w.open_facility(two);
    let intent = w.create_intent(1);
    // Lender Two Bank signs for Lender One Bank's loan, with its own organisation.
    let mut args = w.accept_args(w.lender_one, loan, intent);
    args.lender = Lender {
        facility: w.lender_one.facility,
        ..two
    };
    w.accept_refused(&args, WrongOrganisation);
    // And with Lender One's organisation named but its own wallet's Authority.
    args.lender = Lender {
        org: w.lender_one.org,
        facility: w.lender_one.facility,
        ..two
    };
    w.accept_refused(&args, WrongOrganisation);
}

#[test]
fn accept_loading_rejects_expired_intent() {
    let (mut w, loan, _, _) = terminal_with_lock(THREE_THOUSAND_T);
    let lender = w.lender_one;
    let mut args = w.intent_args(w.owner, 1, LOADING_DOCUMENT);
    args.expires_at = w.now + DAY;
    let intent = w.create_intent_ok(&args);
    w.advance_to(w.now + DAY);
    let args = w.accept_args(lender, loan, intent);
    w.accept_refused(&args, LoadingExpired);
    // One second earlier it would have been accepted.
    w.advance_to(w.now - 1);
    w.accept(lender, loan, intent);
}

#[test]
fn accept_loading_rejects_loan_under_exception() {
    let (mut w, loan, _, valuation) = terminal_with_lock(LOT_KG);
    let lender = w.lender_one;
    // A repayment of 1 minor unit is confirmed and consumed, then corrected: an exception.
    w.advance(lender, loan, valuation, 1);
    let repayment = w.confirm(lender, loan, 1, PaymentPurpose::Repayment, loan, None, 1);
    w.repay(lender, loan, repayment, 1);
    let intent = w.create_intent(1);
    w.confirm(
        lender,
        loan,
        2,
        PaymentPurpose::Correction,
        repayment,
        Some(repayment),
        0,
    );
    assert_eq!(w.loan_state(loan).open_exceptions, 1);
    let args = w.accept_args(lender, loan, intent);
    w.accept_refused(&args, LoanUnderException);
}

#[test]
fn record_loading_rejects_loan_under_exception() {
    let (mut w, loan, _, valuation) = terminal_with_lock(LOT_KG);
    let lender = w.lender_one;
    w.advance(lender, loan, valuation, 1);
    let repayment = w.confirm(lender, loan, 1, PaymentPurpose::Repayment, loan, None, 1);
    w.repay(lender, loan, repayment, 1);
    let intent = w.create_intent(1);
    w.accept(lender, loan, intent);
    // The correction after the acceptance raises both the exceptions and the loan revision;
    // the exception is checked first.
    let revision = w.loan_state(loan).revision;
    w.confirm(
        lender,
        loan,
        2,
        PaymentPurpose::Correction,
        repayment,
        Some(repayment),
        0,
    );
    assert_eq!(w.loan_state(loan).revision, revision + 1);
    let args = w.record_args(w.owner, intent);
    assert_eq!(args.triples.len(), 1);
    w.record_refused(&args, LoanUnderException);
}

#[test]
fn older_loading_intent_superseded_by_newer() {
    let (mut w, loan, _, _) = terminal_with_lock(THREE_THOUSAND_T);
    let lender = w.lender_one;
    let first = w.create_intent(1);
    w.accept(lender, loan, first);
    let args = w.intent_args(w.owner, 2, OTHER_DOCUMENT);
    w.create_intent_ok(&args);
    // Intent 1, sent at the current loan and position revisions, fails its stored snapshot.
    let accept = w.accept_args(lender, loan, first);
    w.accept_refused(&accept, StaleRevision);
    let record = w.record_args(w.owner, first);
    assert_eq!(record.expected_revision, w.position_state().revision);
    w.record_refused(&record, StaleRevision);
}

// =================================================== create_loading_intent ====

#[test]
fn create_loading_intent_rejects_lot_not_at_terminal() {
    let mut w = World::new();
    // At Kopano Stockyard Custody's site: the site's holder is a Custodian, not a Terminal.
    let args = w.intent_args(w.owner, 1, LOADING_DOCUMENT);
    assert_eq!(args.terminal_org, w.custodian);
    w.create_intent_refused(&args, WrongRole);
}

#[test]
fn create_loading_intent_rejects_zero_document() {
    let mut w = World::at_terminal();
    let args = w.intent_args(w.owner, 1, [0; 32]);
    w.create_intent_refused(&args, InvalidField);
    // An expiry that is not in the future is refused the same way.
    let mut args = w.intent_args(w.owner, 1, LOADING_DOCUMENT);
    args.expires_at = w.now;
    w.create_intent_refused(&args, InvalidField);
    args.expires_at = w.now + 1;
    w.create_intent_ok(&args);
}

#[test]
fn create_loading_intent_rejects_other_site_paused_and_stale() {
    let mut w = World::at_terminal();
    // Another terminal's site that does not hold the lot.
    let mut args = w.intent_args(w.owner, 1, LOADING_DOCUMENT);
    args.custodian_class = w.other_terminal_class;
    args.terminal_org = w.other_terminal;
    w.create_intent_refused(&args, WrongOrganisation);
    // The terminal of the site, named against another site.
    let mut args = w.intent_args(w.owner, 1, LOADING_DOCUMENT);
    args.terminal_org = w.other_terminal;
    w.create_intent_refused(&args, WrongOrganisation);
    // A stale position revision.
    let mut args = w.intent_args(w.owner, 1, LOADING_DOCUMENT);
    args.expected_revision += 1;
    w.create_intent_refused(&args, StaleRevision);
    // A window over the custody ceiling.
    let mut args = w.intent_args(w.owner, 1, LOADING_DOCUMENT);
    args.valid_until = w.now + 601;
    w.create_intent_refused(&args, WindowTooLong);
    // Paused loading.
    let pause = w.f.change_pause(Admin, pause::LOADING, true);
    w.f.ok(pause, Admin);
    let args = w.intent_args(w.owner, 1, LOADING_DOCUMENT);
    w.create_intent_refused(&args, Paused);
    let unpause = w.f.change_pause(Admin, pause::LOADING, false);
    w.f.ok(unpause, Admin);
    // A restricted lot.
    w.set_restriction(Restriction::ReviewRequired);
    w.create_intent_refused(&args, Restricted);
    w.set_restriction(Restriction::Normal);
    w.create_intent_ok(&args);
    // The same nonce again: init fails.
    let args = w.intent_args(w.owner, 1, LOADING_DOCUMENT);
    let instructions = w.intent_instructions(&args);
    w.f.sponsored_already_in_use(&instructions, 1);
}

// ========================================================== record_loading ====

#[test]
fn record_loading_rejects_wrong_terminal() {
    let mut w = World::at_terminal();
    let intent = w.create_intent(1);
    // Another Terminal organisation with LOAD signs for a loading at Port Terminal T1.
    let mut args = w.record_args(w.owner, intent);
    args.terminal_org = w.other_terminal;
    args.terminal_signer = Outsider;
    w.record_refused(&args, WrongOrganisation);
}

#[test]
fn record_loading_rejects_terminal_without_authority() {
    let mut w = World::at_terminal();
    let intent = w.create_intent(1);
    // A Port Terminal T1 wallet with no Authority: the relay passes the Authority PDA derived
    // from it, which does not exist, so Anchor refuses the account before the handler runs.
    let mut args = w.record_args(w.owner, intent);
    args.terminal_signer = Issuer2;
    assert!(!w.f.account_exists(w.authority_of(Issuer2)));
    let instructions = w.record_instructions(&args);
    w.f.sponsored_refused_anchor(&instructions, 1, AnchorError::AccountNotInitialized);
    assert_eq!(w.intent_state(intent).status, LoadingStatus::Open);
    w.assert_invariants();
}

#[test]
fn record_loading_rejects_single_signature() {
    let mut w = World::at_terminal();
    let intent = w.create_intent(1);
    let args = w.record_args(w.owner, intent);
    let text = w.record_text(&args);
    let instructions = [
        ed25519_instruction(&[(w.f.signer(Owner), text.as_slice())]),
        w.record_instruction(&args),
    ];
    w.f.sponsored_refused(&instructions, 1, WrongSignatureCount);
    // The terminal's entry first: the owner signs first.
    let swapped = [
        ed25519_shared_instruction(&[w.f.signer(Custodian2), w.f.signer(Owner)], &text),
        w.record_instruction(&args),
    ];
    w.f.sponsored_refused(&swapped, 1, WrongSigner);
    w.assert_invariants();
}

#[test]
fn record_loading_rejects_duplicate_acceptance() {
    let (mut w, loan, _, _) = terminal_with_lock(THREE_THOUSAND_T);
    let lender = w.lender_one;
    let intent = w.create_intent(1);
    w.accept(lender, loan, intent);
    let mut args = w.record_args(w.owner, intent);
    let triple = args.triples[0];
    args.triples = vec![triple, triple];
    args.loans_accepted = 2;
    w.record_refused(&args, InvalidField);
}

#[test]
fn record_loading_rejects_unsorted_triples() {
    let (mut w, loan, _, _) = terminal_with_lock(THREE_THOUSAND_T);
    let (one, two) = (w.lender_one, w.lender_two);
    w.open_facility(two);
    let (second_loan, _) = w.pledge(two, TWO_THOUSAND_T);
    let intent = w.create_intent(1);
    w.accept(one, loan, intent);
    w.accept(two, second_loan, intent);
    let mut args = w.record_args(w.owner, intent);
    assert_eq!(args.triples.len(), 2);
    args.triples.reverse();
    w.record_refused(&args, InvalidField);
    args.triples.reverse();
    w.record_ok(&args);
}

#[test]
fn record_loading_rejects_forged_acceptance_account() {
    let (mut w, loan, lock, _) = terminal_with_lock(THREE_THOUSAND_T);
    let intent = w.create_intent(1);
    // The right shape and values, owned by another program.
    let forged = HandoffAcceptance {
        protocol: w.f.protocol,
        intent,
        loan,
        lock,
        lender: w.lender_one.org,
        lock_quantity_kg: THREE_THOUSAND_T,
        loan_revision: w.loan_state(loan).revision,
        principal: 0,
        booked_interest: 0,
        accepted_at: w.now,
        version: 1,
        bump: 255,
    };
    let address = acceptance_key(intent, loan);
    w.f.set_foreign_account(address, TOKEN_2022, serialized(&forged));
    let mut args = w.record_args(w.owner, intent);
    assert_eq!(args.triples.len(), 1);
    w.record_refused(&args, AcceptanceMissing);
    // A Thetis account of another type in the acceptance slot is refused the same way.
    args.triples[0].acceptance = intent;
    w.record_refused(&args, AcceptanceMissing);
}

#[test]
fn record_loading_rejects_read_only_loan_or_lock() {
    let (mut w, loan, _, _) = terminal_with_lock(THREE_THOUSAND_T);
    let lender = w.lender_one;
    let intent = w.create_intent(1);
    w.accept(lender, loan, intent);
    let args = w.record_args(w.owner, intent);
    for slot in [1, 2] {
        let [verify, mut record] = w.record_instructions(&args);
        let at = record.accounts.len() - 3 + slot;
        record.accounts[at].is_writable = false;
        w.f.sponsored_refused(&[verify, record], 1, InvalidField);
    }
    w.assert_invariants();
}

#[test]
fn record_loading_rejects_restricted_lot() {
    let (mut w, loan, _, _) = terminal_with_lock(THREE_THOUSAND_T);
    let lender = w.lender_one;
    let intent = w.create_intent(1);
    w.accept(lender, loan, intent);
    w.set_restriction(Restriction::ReviewRequired);
    let args = w.record_args(w.owner, intent);
    w.record_refused(&args, Restricted);
}

#[test]
fn record_loading_replay_after_success_refused() {
    let mut w = World::at_terminal();
    let intent = w.create_intent(1);
    let args = w.record_args(w.owner, intent);
    let instructions = w.record_instructions(&args);
    w.record_ok(&args);
    // Execution raised the position revision; the same signed loading is stale.
    w.f.sponsored_refused(&instructions, 1, StaleRevision);
    w.assert_invariants();
}

#[test]
fn record_loading_rejects_executed_intent() {
    let mut w = World::at_terminal();
    let intent = w.create_intent(1);
    // Unreachable with real instructions (execution raises the position revision): the
    // harness marks the open intent executed, revisions unchanged.
    let mut stored = w.intent_state(intent);
    stored.status = LoadingStatus::Executed;
    w.f.set_program_account(intent, &stored);
    let args = w.record_args(w.owner, intent);
    let instructions = w.record_instructions(&args);
    w.f.sponsored_refused(&instructions, 1, LoadingNotOpen);
}

#[test]
fn record_loading_rejects_expired_window_pause_and_stale() {
    let mut w = World::at_terminal();
    let mut intent_args = w.intent_args(w.owner, 1, LOADING_DOCUMENT);
    intent_args.expires_at = w.now + HOUR;
    let intent = w.create_intent_ok(&intent_args);
    let mut args = w.record_args(w.owner, intent);
    args.valid_until = w.now + 601;
    w.record_refused(&args, WindowTooLong);
    let mut args = w.record_args(w.owner, intent);
    args.expected_revision -= 1;
    w.record_refused(&args, StaleRevision);
    let pause = w.f.change_pause(Admin, pause::LOADING, true);
    w.f.ok(pause, Admin);
    let args = w.record_args(w.owner, intent);
    w.record_refused(&args, Paused);
    let unpause = w.f.change_pause(Admin, pause::LOADING, false);
    w.f.ok(unpause, Admin);
    // The intent's own expiry.
    w.advance_to(w.now + HOUR);
    let args = w.record_args(w.owner, intent);
    w.record_refused(&args, LoadingExpired);
    w.advance_to(w.now - 1);
    let args = w.record_args(w.owner, intent);
    w.record_ok(&args);
}

#[test]
fn record_loading_rejects_more_than_max_loading_loans() {
    let (mut w, loan, _, _) = terminal_with_lock(THREE_THOUSAND_T);
    let lender = w.lender_one;
    let intent = w.create_intent(1);
    w.accept(lender, loan, intent);
    let mut args = w.record_args(w.owner, intent);
    let triple = args.triples[0];
    args.triples = vec![triple; MAX_LOADING_LOANS + 1];
    args.loans_accepted = u8::try_from(MAX_LOADING_LOANS + 1).unwrap();
    w.record_refused(&args, InvalidField);
    // A remaining-account list that is not whole triples.
    let mut args = w.record_args(w.owner, intent);
    let [verify, mut record] = w.record_instructions(&args);
    record.accounts.pop();
    w.f.sponsored_refused(&[verify, record], 1, InvalidField);
    args.triples.clear();
    args.loans_accepted = 0;
    // No triple at all leaves the 3,000 t lock unaccepted.
    w.record_refused(&args, AcceptanceMissing);
}

// =================================================================== A16 ====

#[test]
fn loading_after_return_to_same_terminal_needs_new_intent() {
    let (mut w, loan, _, _) = terminal_with_lock(THREE_THOUSAND_T);
    let lender = w.lender_one;
    let intent = w.create_intent(1);
    w.accept(lender, loan, intent);
    // The lot ships away to the source and comes back to the same terminal.
    w.ship_to(w.source);
    w.ship_to(w.terminal_class);
    let args = w.record_args(w.owner, intent);
    assert_eq!(args.expected_revision, w.position_state().revision);
    assert_eq!(args.triples.len(), 1);
    w.record_refused(&args, StaleRevision);
    // A new intent and acceptance load it.
    let fresh = w.create_intent(2);
    w.accept(lender, loan, fresh);
    w.record(w.owner, fresh);
}

#[test]
fn partial_port_sale_after_full_arrival_succeeds() {
    let (mut w, loan, valuation) = World::port_sale_fixture();
    assert_eq!(w.lot_state().custodian_class, w.terminal_class);
    let release = w.release_intent_instructions(loan, 1);
    w.f.sponsored_ok(&release);
    let intent = World::release_intent_key(loan, 1);
    let payment = w.confirm(
        w.lender_one,
        loan,
        3,
        PaymentPurpose::Release,
        intent,
        None,
        FOUR_HUNDRED_K,
    );
    let revision = w.position_state().revision;
    let sell = w.sell_instructions(loan, intent, payment, valuation, revision);
    w.f.sponsored_ok(&sell);
    // 2,000 t to Buyer Smelter Co for USD400,000 leaves USD200,000 of debt on 3,000 t.
    let stored = w.loan_state(loan);
    assert_eq!(stored.principal + stored.booked_interest, TWO_HUNDRED_K);
    assert_eq!(
        w.lock_state(pda(&[b"lock", loan.as_ref()])).quantity_kg,
        THREE_THOUSAND_T
    );
    assert_eq!(w.position_state().quantity_kg, THREE_THOUSAND_T);
    let buyer: Position = w.f.read(World::position_key(w.lot, w.buyer));
    assert_eq!(buyer.quantity_kg, TWO_THOUSAND_T);
    w.assert_invariants();
}

#[test]
fn prepared_next_shipment_blocks_port_sale() {
    let (mut w, loan, valuation) = World::port_sale_fixture();
    let release = w.release_intent_instructions(loan, 1);
    w.f.sponsored_ok(&release);
    let intent = World::release_intent_key(loan, 1);
    let payment = w.confirm(
        w.lender_one,
        loan,
        3,
        PaymentPurpose::Release,
        intent,
        None,
        FOUR_HUNDRED_K,
    );
    w.prepare_to(w.source);
    let revision = w.position_state().revision;
    let sell = w.sell_instructions(loan, intent, payment, valuation, revision);
    w.f.sponsored_refused(&sell, 1, StaleRevision);
    let release = w.release_intent_instructions(loan, 2);
    w.f.sponsored_refused(&release, 1, LotNotStored);
    w.assert_invariants();
}

#[test]
fn loading_one_position_leaves_lot_stored_for_others() {
    let mut w = World::at_terminal();
    let transfer = w.transfer_instructions(TWO_THOUSAND_T);
    w.f.sponsored_ok(&transfer);
    let intent = w.create_intent(1);
    assert_eq!(w.intent_state(intent).quantity_kg, THREE_THOUSAND_T);
    let tx = w.record(w.owner, intent);
    let lot = w.lot_state();
    assert_eq!(lot.state, LotState::Stored);
    assert_eq!(lot.supply_kg, TWO_THOUSAND_T);
    assert_eq!(w.class_state(w.terminal_class).occupied_kg, TWO_THOUSAND_T);
    assert!(!w.f.read::<IntakeIdentity>(w.intake()).retired);
    let recorded: events::LoadingRecorded = first_event(&tx);
    assert!(!recorded.lot_loaded);
    let buyer: Position = w.f.read(World::position_key(w.lot, w.buyer));
    assert_eq!(buyer.quantity_kg, TWO_THOUSAND_T);
}

#[test]
fn final_loading_sets_loaded_and_retires_intake() {
    let mut w = World::at_terminal();
    let transfer = w.transfer_instructions(TWO_THOUSAND_T);
    w.f.sponsored_ok(&transfer);
    let first = w.create_intent(1);
    w.record(w.owner, first);
    assert!(!w.f.read::<IntakeIdentity>(w.intake()).retired);
    // Buyer Smelter Co loads the last 2,000 t.
    let args = w.intent_args(w.buyer, 1, OTHER_DOCUMENT);
    let last = w.create_intent_ok(&args);
    let tx = w.record(w.buyer, last);
    let lot = w.lot_state();
    assert_eq!(lot.state, LotState::Loaded);
    assert_eq!(lot.supply_kg, 0);
    assert!(w.f.read::<IntakeIdentity>(w.intake()).retired);
    assert_eq!(w.class_state(w.terminal_class).occupied_kg, 0);
    let recorded: events::LoadingRecorded = first_event(&tx);
    assert!(recorded.lot_loaded);
}

#[test]
fn loaded_lot_refuses_transfer_and_redeem() {
    let mut w = World::at_terminal();
    let intent = w.create_intent(1);
    w.record(w.owner, intent);
    assert_eq!(w.lot_state().state, LotState::Loaded);
    let transfer = w.transfer_instructions(TWO_THOUSAND_T);
    w.f.sponsored_refused(&transfer, 1, LotNotStored);
    // redeem checks the custodian's REDEEM scope first, and a terminal cannot hold it.
    let redeem = w.redeem_instructions(
        w.lot,
        None,
        TWO_THOUSAND_T,
        Custodian2,
        w.terminal,
        w.terminal_class,
    );
    w.f.sponsored_refused(&redeem, 1, ScopeMissing);
    w.assert_invariants();
}

#[test]
fn prepare_shipment_cancels_open_intents() {
    // (a) an open release intent.
    let (mut w, loan, valuation) = World::port_sale_fixture();
    let release = w.release_intent_instructions(loan, 1);
    w.f.sponsored_ok(&release);
    let intent = World::release_intent_key(loan, 1);
    let payment = w.confirm(
        w.lender_one,
        loan,
        3,
        PaymentPurpose::Release,
        intent,
        None,
        FOUR_HUNDRED_K,
    );
    let (shipment, _) = w.prepare_to(w.source);
    let prepared: Shipment = w.f.read(shipment);
    assert!(w.position_state().revision > w.f.read::<ReleaseIntent>(intent).position_revision);
    assert_eq!(prepared.position, w.position());
    w.cancel(shipment);
    let revision = w.position_state().revision;
    let sell = w.sell_instructions(loan, intent, payment, valuation, revision);
    w.f.sponsored_refused(&sell, 1, StaleRevision);

    // (b) an open loading intent with its acceptance.
    let (mut w, loan, _, _) = terminal_with_lock(THREE_THOUSAND_T);
    let lender = w.lender_one;
    let intent = w.create_intent(1);
    w.accept(lender, loan, intent);
    let (shipment, _) = w.prepare_to(w.source);
    assert!(w.position_state().revision > w.intent_state(intent).position_revision);
    w.cancel(shipment);
    let args = w.record_args(w.owner, intent);
    assert_eq!(args.triples.len(), 1);
    w.record_refused(&args, StaleRevision);
}

#[test]
fn shipment_prepared_event_names_a_newer_position_revision() {
    let mut w = World::at_terminal();
    let intent = w.create_intent(1);
    let lot = w.lot_state();
    let document = w.attest_departure();
    let stored_document: DocumentAttestation = w.f.read(document);
    let destination = w.class_state(w.source);
    let leaf = Leaf {
        index: 0,
        quantity_kg: lot.supply_kg,
        carrier: w.transporter,
        load_digest: [0x77; 32],
        manifest_digest: [0x44; 32],
    };
    let manifest = Manifest::new(vec![leaf]);
    let shipment_id = [0x5a; 16];
    let valid_until = w.now + CUSTODY_WINDOW;
    let text = prepare_shipment_message(
        &ID,
        &INSTANCE,
        LOT_ID,
        &shipment_id,
        lot.supply_kg,
        OWNER_NAME,
        CUSTODIAN_NAME,
        &destination.site_code,
        1,
        &manifest.root,
        (&stored_document.sha256, stored_document.version),
        lot.revision,
        valid_until,
    );
    let shipment = pda(&[b"shipment", w.f.protocol.as_ref(), &shipment_id]);
    let prepare = ix(
        accounts::PrepareShipment {
            sponsor: w.f.payer(),
            protocol: w.f.protocol,
            owner_org: w.owner,
            owner_authority: w.authority_of(Owner),
            lot: w.lot,
            position: w.position(),
            source_class: w.terminal_class,
            destination_class: w.source,
            destination_org: w.custodian,
            departure_document: document,
            departure_issuer: w.terminal,
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
    let verify = ed25519_instruction(&[(w.f.signer(Owner), text.as_slice())]);
    let tx = w.f.sponsored_ok(&[verify, prepare]);
    w.shipments.push(shipment);
    let prepared: events::ShipmentPrepared = first_event(&tx);
    // The indexer's rule: an intent effectively open just before the shipment has
    // position_revision == ShipmentPrepared.position_revision − 1.
    assert_eq!(
        prepared.position_revision - 1,
        w.intent_state(intent).position_revision
    );
    w.assert_invariants();
}

// ================================================================ vectors ====

#[test]
fn loading_messages_known_answers() {
    let program: Pubkey = "jGJpdjtoDUtXMjvc4UaEi1mBeFZKqVfe9jL8ireHMs3"
        .parse()
        .unwrap();
    let instance: [u8; 16] = std::array::from_fn(|index| u8::try_from(index * 0x11).unwrap());
    let valid_until = 1_795_098_725;
    let intent = loading_intent_message(
        &program,
        &instance,
        "CR-0001",
        3_000_000,
        OWNER_NAME,
        TERMINAL_NAME,
        TERMINAL_SITE,
        &LOADING_DOCUMENT,
        1,
        1_795_185_125,
        2,
        valid_until,
    );
    assert_eq!(
        String::from_utf8(intent.clone()).unwrap(),
        "Thetis authorisation v1\n\
         Network: devnet\n\
         Program: jGJpdjtoDUtXMjvc4UaEi1mBeFZKqVfe9jL8ireHMs3\n\
         Protocol: 00112233445566778899aabbccddeeff\n\
         Action: Prepare loading\n\
         Lot: CR-0001\n\
         Quantity: 3,000.000 t\n\
         Owner: Khunou Ore Exports\n\
         Terminal: Port Terminal T1\n\
         Site: PORT-T1\n\
         Loading document: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n\
         Intent: 1\n\
         Intent expires: 2026-11-20 16:32:05 SAST\n\
         Revision: 2\n\
         Valid until: 2026-11-19 16:32:05 SAST\n\
         Test network only. Synthetic data."
    );
    assert_eq!(intent.len(), 480);
    assert_eq!(
        sha256_hex(&intent),
        "44d338aa7908d0254818fe1cf7bfa568e01d1e43d7a362826d2fdebb2bf31536"
    );
    let record = record_loading_message(
        &program,
        &instance,
        "CR-0001",
        3_000_000,
        OWNER_NAME,
        TERMINAL_NAME,
        &LOADING_DOCUMENT,
        1,
        3_000_000,
        1,
        3,
        valid_until,
    );
    assert_eq!(
        String::from_utf8(record.clone()).unwrap(),
        "Thetis authorisation v1\n\
         Network: devnet\n\
         Program: jGJpdjtoDUtXMjvc4UaEi1mBeFZKqVfe9jL8ireHMs3\n\
         Protocol: 00112233445566778899aabbccddeeff\n\
         Action: Record loading\n\
         Lot: CR-0001\n\
         Quantity: 3,000.000 t\n\
         Owner: Khunou Ore Exports\n\
         Terminal: Port Terminal T1\n\
         Loading document: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n\
         Intent: 1\n\
         Locked: 3,000.000 t\n\
         Loan acceptances: 1\n\
         Revision: 3\n\
         Valid until: 2026-11-19 16:32:05 SAST\n\
         Test network only. Synthetic data."
    );
    assert_eq!(record.len(), 464);
    assert_eq!(
        sha256_hex(&record),
        "dfc9feeb92f83a2dfe7362567f43c921cbfe642f813aae60c583b2db59424c6e"
    );
}

#[test]
fn loading_text_line_mutations_refused() {
    // Every rendered line of both texts, its last byte replaced, signed with the right keys.
    let (mut w, loan, _, _) = terminal_with_lock(THREE_THOUSAND_T);
    let lender = w.lender_one;
    let args = w.intent_args(w.owner, 1, LOADING_DOCUMENT);
    let text = w.intent_text(&args);
    for mutated in line_mutations(&text) {
        let instructions = [
            ed25519_instruction(&[(w.f.signer(Owner), mutated.as_slice())]),
            w.intent_instruction(&args),
        ];
        w.f.sponsored_refused(&instructions, 1, MessageMismatch);
    }
    let intent = w.create_intent_ok(&args);
    w.accept(lender, loan, intent);
    let args = w.record_args(w.owner, intent);
    let text = w.record_text(&args);
    for mutated in line_mutations(&text) {
        let instructions = w.record_signed(&args, &mutated);
        w.f.sponsored_refused(&instructions, 1, MessageMismatch);
    }
    w.record_ok(&args);
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

const WIDEST_OWNER: &str = "Khunou Ore Exports And Allied Mining Pty Ltd 001";
const WIDEST_TERMINAL: &str = "Port Terminal T1 And Allied Bulk Terminals Pty 1";
const WIDEST_LOT_ID: &str = "CR-0001-WIDEST-1";
const WIDEST_SITE: &str = "PORT-T1-WIDEST-1";

/// Compiles `[compute budget, verify, action]` as a sponsored v0 transaction against `table`
/// and checks that only the sponsor signs, that `inline` are the only static keys, and that the
/// table supplies exactly `writable` and `readonly`.
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
    assert!(size <= PACKET_DATA_SIZE, "v0 transaction is {size} bytes");
    (tx, size)
}

#[test]
fn create_loading_intent_size_fits_v0_widest() {
    let mut w = World::at_terminal();
    let demo = w.intent_args(w.owner, 1, LOADING_DOCUMENT);
    let position = w.position();
    let readonly = vec![
        w.f.protocol,
        w.owner,
        w.authority_of(Owner),
        w.lot,
        w.terminal_class,
        w.terminal,
        INSTRUCTIONS_SYSVAR,
        SYSTEM,
    ];
    let demo_intent = intent_key(position, 1);
    let widest_intent = intent_key(position, u64::MAX);
    // The relay appends the LoadingIntent PDA before it creates the intent (§11.1).
    let mut addresses = readonly.clone();
    addresses.extend([position, demo_intent, widest_intent]);
    let table = w.f.create_lookup_table(addresses);
    let inline = vec![w.f.payer(), ID, ED25519, COMPUTE_BUDGET];
    assert_eq!(readonly.len() + 2, 10);

    let instructions = w.intent_instructions(&demo);
    let (tx, demo_size) = v0(
        &mut w,
        &table,
        instructions,
        inline.clone(),
        vec![position, demo_intent],
        readonly.clone(),
    );
    let meta =
        w.f.send(tx)
            .unwrap_or_else(|failure| panic!("{:?}\n{}", failure.err, failure.meta.pretty_logs()));
    let units = meta.compute_units_consumed;
    assert!(
        units < u64::from(COMPUTE_UNIT_LIMIT),
        "create_loading_intent used {units} CU"
    );
    println!("create_loading_intent v0 demo: {units} CU, {demo_size} bytes");
    assert_eq!(w.intent_state(demo_intent).status, LoadingStatus::Open);
    w.assert_invariants();

    for name in [WIDEST_OWNER, WIDEST_TERMINAL] {
        assert_eq!(name.len(), MAX_DISPLAY_NAME);
    }
    assert_eq!(WIDEST_LOT_ID.len(), MAX_LOT_ID);
    assert_eq!(WIDEST_SITE.len(), MAX_SITE_CODE);
    let text = loading_intent_message(
        &ID,
        &INSTANCE,
        WIDEST_LOT_ID,
        u64::MAX,
        WIDEST_OWNER,
        WIDEST_TERMINAL,
        WIDEST_SITE,
        &LOADING_DOCUMENT,
        u64::MAX,
        i64::MAX,
        u64::MAX,
        i64::MAX,
    );
    assert_eq!(text.len(), 631);
    let widest = IntentArgs {
        nonce: u64::MAX,
        expires_at: i64::MAX,
        expected_revision: u64::MAX,
        valid_until: i64::MAX,
        ..demo.clone()
    };
    let instructions = [
        ed25519_instruction(&[(w.f.signer(Owner), text.as_slice())]),
        w.intent_instruction(&widest),
    ];
    let (_, widest_size) = v0(
        &mut w,
        &table,
        instructions.clone(),
        inline.clone(),
        vec![position, widest_intent],
        readonly.clone(),
    );
    println!("create_loading_intent v0 widest: {widest_size} bytes");
    assert_eq!(widest_size, 1_117);

    // The relay's shape (services/api compile.ts): the protocol and the created intent stay
    // static.
    let relay_readonly: Vec<Pubkey> = readonly
        .iter()
        .copied()
        .filter(|key| *key != w.f.protocol)
        .collect();
    let mut relay_addresses = relay_readonly.clone();
    relay_addresses.push(position);
    let relay_table = w.f.create_lookup_table(relay_addresses);
    let mut relay_inline = inline;
    relay_inline.extend([w.f.protocol, widest_intent]);
    let (_, relay_size) = v0(
        &mut w,
        &relay_table,
        instructions,
        relay_inline,
        vec![position],
        relay_readonly,
    );
    println!("create_loading_intent v0 widest, relay shape: {relay_size} bytes");
    assert_eq!(relay_size, 1_179);
}

#[test]
fn record_loading_size_fits_v0_widest() {
    // The compute-unit worst case (§9): the final loading of a child lot that is
    // its root's last live child, the root already at zero supply, so the intake retires; four
    // accepted positive locks on four unpaid loans with accrual elapsed.
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
    w.advance_to(w.now + DAY);
    let args = w.record_args(w.owner, intent);
    assert_eq!(args.triples.len(), MAX_LOADING_LOANS);

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
    let mut addresses = readonly.clone();
    addresses.extend(writable.clone());
    let table = w.f.create_lookup_table(addresses);
    let inline = vec![w.f.payer(), ID, ED25519, COMPUTE_BUDGET];

    // The executed worst case, through record_ok's checks.
    let instructions = w.record_instructions(&args);
    let (_, demo_size) = v0(
        &mut w,
        &table,
        instructions,
        inline.clone(),
        writable.clone(),
        readonly.clone(),
    );
    let tx = w.record_ok(&args);
    let units = tx.compute_units_consumed;
    assert!(
        units < u64::from(COMPUTE_UNIT_LIMIT),
        "record_loading used {units} CU"
    );
    println!("record_loading worst case: {units} CU, {demo_size} bytes as v0");
    assert!(w.f.read::<IntakeIdentity>(w.intake()).retired);
    assert_eq!(w.f.read::<Lot>(root).live_children, 0);
    for loan in &loans {
        assert_eq!(w.loan_state(*loan).status, LoanStatus::ExternalHandoff);
    }

    // The widest text and arguments over the same accounts, serialised only.
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
    let instructions = w.record_signed(&widest, &text);
    let (_, widest_size) = v0(
        &mut w,
        &table,
        instructions.clone(),
        inline.clone(),
        writable.clone(),
        readonly.clone(),
    );
    println!("record_loading v0 widest: {widest_size} bytes");
    assert_eq!(widest_size, 1_199);

    // The relay's shape (services/api compile.ts): the protocol stays static.
    let relay_readonly: Vec<Pubkey> = readonly
        .iter()
        .copied()
        .filter(|key| *key != w.f.protocol)
        .collect();
    let mut relay_addresses = relay_readonly.clone();
    relay_addresses.extend(writable.clone());
    let relay_table = w.f.create_lookup_table(relay_addresses);
    let mut relay_inline = inline;
    relay_inline.push(w.f.protocol);
    let (_, relay_size) = v0(
        &mut w,
        &relay_table,
        instructions,
        relay_inline,
        writable,
        relay_readonly,
    );
    println!("record_loading v0 widest, relay shape: {relay_size} bytes");
    assert_eq!(relay_size, 1_230);
}

impl World {
    fn mint_supply_of_lot(&self) -> u64 {
        self.f.mint_supply(Self::mint(self.lot))
    }
}
