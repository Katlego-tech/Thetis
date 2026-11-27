//! Phase 3: `handover` (PS×2: the current holder and the next holder sign one text), with the
//! batch sequence, the batch manifest digest, the departure document recheck at each departure
//! and the partial arrival accounting of program-custody.md §4.3; and `redeem` at a destination
//! custodian that did not issue the lot (the intake PDA re-derived from `intake.custodian`).
//!
//! Demo quantities and money are the demo's (5,000 t, 3,000 t, 2,000 t, USD600,000, USD400,000,
//! 20 c/kg, haircut 0, LTV 60%, 1,200 bps). Site capacities are fixture values stated below. The
//! demo cast is synthetic; "another haulier" (demo.md §3) and the DocumentIssuer use the
//! harness's generated test names, and `Custodian Two Test Org` is the test-only second
//! custodian of §9. Shipment ids, digests, site codes, payment ids and expiries are
//! deterministic synthetic test inputs.

mod common;

use anchor_lang::{error::ErrorCode as AnchorError, prelude::Pubkey, AccountSerialize};
use anchor_spl::associated_token::get_associated_token_address_with_program_id;
use common::{Actor::*, *};
use solana_message::{AddressLookupTableAccount, VersionedMessage};
use solana_transaction::{versioned::VersionedTransaction, Instruction};
use thetis::{
    accounts,
    error::ThetisError::{self, *},
    events, instruction,
    intent::message::{
        advance_message, buy_pledged_message, custody_handover_message, issue_message,
        pledge_message, redeem_message, release_intent_message, transfer_message,
    },
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

const CLASS_CODE: &str = "CHROME";
const GRADES: [&str; 2] = ["A", "B"];
const SOURCE_SITE: &str = "INLAND-YARD";
const DESTINATION_SITE: &str = "PORT-T1";
const SECOND_CUSTODIAN_SITE: &str = "INLAND-YARD-2";
/// Fixture capacities: the source holds two demo lots, each destination exactly one.
const SOURCE_CAPACITY: u64 = 10_000_000;
const DESTINATION_CAPACITY: u64 = 5_000_000;

const LOT_ID: &str = "CR-0001";
const INTAKE_DIGEST: [u8; 32] = [0x0a; 32];
const LOT_KG: u64 = 5_000_000;
const THREE_THOUSAND_T: u64 = 3_000_000;
const TWO_THOUSAND_T: u64 = 2_000_000;
const DEPARTURE_SHA: [u8; 32] = [0xdd; 32];
const COLLECTION_TICKET: [u8; 32] = [0xc7; 32];
const SHIPMENT_ONE: [u8; 16] = [0x22; 16];
const OTHER_MANIFEST: [u8; 32] = [0x99; 32];

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
/// USD600,000 and USD400,000 in cents.
const SIX_HUNDRED_K: u64 = 60_000_000;
const FOUR_HUNDRED_K: u64 = 40_000_000;

const OWNER_ID: u8 = 1;
const CUSTODIAN_ID: u8 = 2;
const TRANSPORTER_ID: u8 = 3;
const BUYER_ID: u8 = 4;
const TERMINAL_ID: u8 = 5;
const LENDER_ID: u8 = 7;
const OTHER_HAULIER_ID: u8 = 8;
const SECOND_CUSTODIAN_ID: u8 = 9;

const OWNER_NAME: &str = "Khunou Ore Exports";
const CUSTODIAN_NAME: &str = "Kopano Stockyard Custody";
const TRANSPORTER_NAME: &str = "Mosela Haulage";
const BUYER_NAME: &str = "Buyer Smelter Co";
const TERMINAL_NAME: &str = "Port Terminal T1";
const LENDER_NAME: &str = "Lender One Bank";
const SECOND_CUSTODIAN_NAME: &str = "Custodian Two Test Org";

/// `HandoverRecord` size, discriminator included (§7).
const HANDOVER_SPACE: usize = 290;

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

fn shipment_key(protocol: Pubkey, shipment_id: &[u8; 16]) -> Pubkey {
    pda(&[b"shipment", protocol.as_ref(), shipment_id])
}

fn batch_key(protocol: Pubkey, load_digest: &[u8; 32]) -> Pubkey {
    pda(&[b"batch", protocol.as_ref(), load_digest])
}

fn handover_key(batch: Pubkey, sequence: u64) -> Pubkey {
    pda(&[b"handover", batch.as_ref(), &sequence.to_le_bytes()])
}

fn bump_of(seeds: &[&[u8]]) -> u8 {
    Pubkey::find_program_address(seeds, &ID).1
}

fn payment_id(n: u8) -> [u8; 32] {
    [n; 32]
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
    leaves: Vec<Leaf>,
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
        Self {
            leaves,
            root,
            proofs,
        }
    }

    fn batch_count(&self) -> u8 {
        u8::try_from(self.leaves.len()).unwrap()
    }
}

/// One `handover` call, with every input a test may vary.
#[derive(Clone)]
struct HandoverArgs {
    shipment: Pubkey,
    batch: Pubkey,
    lot: Pubkey,
    source: Pubkey,
    destination: Pubkey,
    manifest_digest: [u8; 32],
    expected_sequence: u64,
    valid_until: i64,
    from_signer: Actor,
    from_org: Pubkey,
    to_signer: Actor,
    to_org: Pubkey,
    departure_document: Option<Pubkey>,
    /// The stage printed in the signed text.
    stage: HandoverStage,
}

/// A fiat protocol with the demo cast; a source site of Kopano Stockyard Custody and a
/// destination site of Port Terminal T1 in the chrome class; CR-0001 (5,000 t, grade A) issued at
/// the source to Khunou Ore Exports; and Kopano's departure document for it.
struct World {
    f: Fixture,
    now: i64,
    owner: Pubkey,
    custodian: Pubkey,
    transporter: Pubkey,
    other_haulier: Pubkey,
    buyer: Pubkey,
    terminal: Pubkey,
    lender: Pubkey,
    class_policy: Pubkey,
    source: Pubkey,
    destination: Pubkey,
    /// The organisation holding the destination site.
    destination_org: Pubkey,
    /// The wallet that signs for the destination organisation.
    destination_signer: Actor,
    lot: Pubkey,
    position: Pubkey,
    /// Kopano's departure document for CR-0001, version 1.
    document: Pubkey,
    lots: Vec<Pubkey>,
    shipments: Vec<Pubkey>,
    batches: Vec<Pubkey>,
    classes: Vec<Pubkey>,
    facility: Pubkey,
    valuation: Pubkey,
    loan: Pubkey,
    lock: Pubkey,
}

impl World {
    fn demo() -> Self {
        Self::new(false)
    }

    /// As `demo`, with the destination a site of `Custodian Two Test Org` (a Custodian with
    /// `CARRY` and `REDEEM`) instead of Port Terminal T1.
    fn with_second_custodian() -> Self {
        Self::new(true)
    }

    fn new(second_custodian: bool) -> Self {
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
        let lender = accredit(&mut f, LENDER_ID, Role::Lender, LENDER_NAME);
        let other_haulier = f.add_org(OTHER_HAULIER_ID, Role::Transporter);

        let source_site = f.accredit_site(
            Accreditor,
            custodian,
            class_policy,
            SOURCE_SITE,
            SOURCE_CAPACITY,
        );
        f.ok(source_site, Accreditor);
        let terminal_site = f.accredit_site(
            Accreditor,
            terminal,
            class_policy,
            DESTINATION_SITE,
            DESTINATION_CAPACITY,
        );
        f.ok(terminal_site, Accreditor);
        let source = f.site(custodian, class_policy, SOURCE_SITE);
        let terminal_class = f.site(terminal, class_policy, DESTINATION_SITE);
        let mut classes = vec![source, terminal_class];

        let expires_at = NOW + AUTHORITY_LIFETIME;
        let mut delegations = vec![
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
            (terminal, Custodian2, scope::CARRY | scope::ATTEST_TRANSPORT),
            (transporter, Driver, scope::CARRY),
            (other_haulier, OtherDriver, scope::CARRY),
            (buyer, Buyer, scope::TRANSFER | scope::BUY | scope::SHIP),
            (lender, Lender, scope::LEND | scope::POOL),
        ];
        let (destination, destination_org, destination_signer) = if second_custodian {
            let second = accredit(
                &mut f,
                SECOND_CUSTODIAN_ID,
                Role::Custodian,
                SECOND_CUSTODIAN_NAME,
            );
            let site = f.accredit_site(
                Accreditor,
                second,
                class_policy,
                SECOND_CUSTODIAN_SITE,
                DESTINATION_CAPACITY,
            );
            f.ok(site, Accreditor);
            let class = f.site(second, class_policy, SECOND_CUSTODIAN_SITE);
            classes.push(class);
            delegations.push((second, SecondCustodian, scope::CARRY | scope::REDEEM));
            (class, second, SecondCustodian)
        } else {
            (terminal_class, terminal, Custodian2)
        };
        for (org, wallet, scopes) in delegations {
            let delegate = f.delegate(OrgAdmin, org, f.key(wallet), scopes, expires_at);
            f.ok(delegate, OrgAdmin);
        }

        let protocol = f.protocol;
        let lot = pda(&[b"lot", protocol.as_ref(), LOT_ID.as_bytes()]);
        let facility = pda(&[
            b"facility",
            protocol.as_ref(),
            lender.as_ref(),
            &FACILITY_ONE,
        ]);
        let loan = pda(&[b"loan", facility.as_ref(), &0_u32.to_le_bytes()]);
        let mut world = Self {
            f,
            now: NOW,
            owner,
            custodian,
            transporter,
            other_haulier,
            buyer,
            terminal,
            lender,
            class_policy,
            source,
            destination,
            destination_org,
            destination_signer,
            lot,
            position: pda(&[b"position", lot.as_ref(), owner.as_ref()]),
            document: Pubkey::default(),
            lots: Vec::new(),
            shipments: Vec::new(),
            batches: Vec::new(),
            classes,
            facility,
            valuation: Pubkey::default(),
            loan,
            lock: pda(&[b"lock", loan.as_ref()]),
        };
        world.issue_lot();
        world.document = world.attest_departure();
        world.assert_invariants();
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
        self.f.read(self.position)
    }

    fn class_state(&self, class: Pubkey) -> CustodianClass {
        self.f.read(class)
    }

    fn batch_state(&self, batch: Pubkey) -> ManifestBatch {
        self.f.read(batch)
    }

    fn shipment_state(&self, shipment: Pubkey) -> Shipment {
        self.f.read(shipment)
    }

    /// Issues CR-0001 (5,000 t, grade A) at the source to Khunou Ore Exports.
    fn issue_lot(&mut self) {
        let valid_until = self.now + CUSTODY_WINDOW;
        let lot = self.lot;
        let position = self.position;
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

    /// Kopano's real `attest_document` of kind `Departure` for CR-0001, version 1.
    fn attest_departure(&mut self) -> Pubkey {
        let subject = self.lot.to_bytes();
        let attest = self.f.attest(
            Custodian,
            self.custodian,
            DocumentKind::Departure,
            subject,
            1,
            DEPARTURE_SHA,
            self.now + DOCUMENT_VALIDITY,
        );
        self.f.ok(attest, Custodian);
        let document = self.f.document(DocumentKind::Departure, subject, 1);
        let stored: DocumentAttestation = self.f.read(document);
        assert_eq!(stored.issuer, self.custodian);
        document
    }

    // ------------------------------------------------------------ shipments ----

    /// A manifest whose batches carry `quantities` in index order, all carried by Mosela
    /// Haulage, with load digests `0x33 + 2 × index` and manifest digests `0x44 + 2 × index`
    /// (M1's and M2's digests).
    fn manifest(&self, quantities: &[u64]) -> Manifest {
        Manifest::new(
            quantities
                .iter()
                .enumerate()
                .map(|(index, quantity_kg)| {
                    let index = u8::try_from(index).unwrap();
                    Leaf {
                        index,
                        quantity_kg: *quantity_kg,
                        carrier: self.transporter,
                        load_digest: [0x33 + 2 * index; 32],
                        manifest_digest: [0x44 + 2 * index; 32],
                    }
                })
                .collect(),
        )
    }

    /// Prepares CR-0001 to the world's destination with `manifest` (a real `prepare_shipment`).
    fn prepare(&mut self, manifest: &Manifest) -> Pubkey {
        let valid_until = self.now + CUSTODY_WINDOW;
        let lot = self.lot_state();
        let destination = self.class_state(self.destination);
        let document: DocumentAttestation = self.f.read(self.document);
        let text = thetis::intent::message::prepare_shipment_message(
            &ID,
            &INSTANCE,
            LOT_ID,
            &SHIPMENT_ONE,
            lot.supply_kg,
            OWNER_NAME,
            &self.name(self.destination_org),
            &destination.site_code,
            manifest.batch_count(),
            &manifest.root,
            (&document.sha256, document.version),
            lot.revision,
            valid_until,
        );
        let shipment = shipment_key(self.f.protocol, &SHIPMENT_ONE);
        let prepare = ix(
            accounts::PrepareShipment {
                sponsor: self.f.payer(),
                protocol: self.f.protocol,
                owner_org: self.owner,
                owner_authority: self.authority_of(Owner),
                lot: self.lot,
                position: self.position,
                source_class: self.source,
                destination_class: self.destination,
                destination_org: self.destination_org,
                departure_document: self.document,
                departure_issuer: self.custodian,
                shipment,
                instructions: INSTRUCTIONS_SYSVAR,
                system_program: SYSTEM,
            },
            instruction::PrepareShipment {
                shipment_id: SHIPMENT_ONE,
                batch_count: manifest.batch_count(),
                manifest_root: manifest.root,
                expected_revision: lot.revision,
                valid_until,
            },
        );
        let verify = ed25519_instruction(&[(self.f.signer(Owner), text.as_slice())]);
        self.f.sponsored_ok(&[verify, prepare]);
        self.shipments.push(shipment);
        self.assert_invariants();
        shipment
    }

    /// Registers leaf `index` of `manifest` (a real `register_batch`).
    fn register(&mut self, shipment: Pubkey, manifest: &Manifest, index: usize) -> Pubkey {
        let leaf = &manifest.leaves[index];
        let batch = batch_key(self.f.protocol, &leaf.load_digest);
        let register = ix(
            accounts::RegisterBatch {
                payer: self.f.payer(),
                protocol: self.f.protocol,
                shipment,
                batch,
                system_program: SYSTEM,
            },
            instruction::RegisterBatch {
                index: leaf.index,
                quantity_kg: leaf.quantity_kg,
                carrier: leaf.carrier,
                load_digest: leaf.load_digest,
                manifest_digest: leaf.manifest_digest,
                proof: manifest.proofs[index],
            },
        );
        self.f.sponsored_ok(&[register]);
        self.batches.push(batch);
        self.assert_invariants();
        batch
    }

    /// Prepares and registers every batch of a manifest with `quantities`.
    fn ship(&mut self, quantities: &[u64]) -> (Pubkey, Vec<Pubkey>) {
        let manifest = self.manifest(quantities);
        let shipment = self.prepare(&manifest);
        let batches = (0..quantities.len())
            .map(|index| self.register(shipment, &manifest, index))
            .collect();
        (shipment, batches)
    }

    /// The demo shipment: CR-0001 in one 5,000 t batch (M1's shape), fully registered.
    fn ship_demo(&mut self) -> (Pubkey, Pubkey) {
        let (shipment, batches) = self.ship(&[LOT_KG]);
        (shipment, batches[0])
    }

    /// The §4.3 shipment: B1 = 3,000 t and B2 = 2,000 t (M2's shape), fully registered.
    fn ship_two(&mut self) -> (Pubkey, Pubkey, Pubkey) {
        let (shipment, batches) = self.ship(&[THREE_THOUSAND_T, TWO_THOUSAND_T]);
        (shipment, batches[0], batches[1])
    }

    fn cancel_instructions(&self, shipment: Pubkey) -> [Instruction; 2] {
        let stored = self.shipment_state(shipment);
        let valid_until = self.now + CUSTODY_WINDOW;
        let destination = self.class_state(stored.destination);
        let text = thetis::intent::message::cancel_shipment_message(
            &ID,
            &INSTANCE,
            LOT_ID,
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
        [
            ed25519_instruction(&[(self.f.signer(Owner), text.as_slice())]),
            cancel,
        ]
    }

    // ------------------------------------------------------------- handover ----

    /// The handover of `batch` from its holder to `to_org` (signed by `to_signer`), at the
    /// batch's current sequence. The departure document slot is filled at `AtSource` only,
    /// and the text's stage is the one the program derives for a valid recipient.
    fn handover_args(&self, batch: Pubkey, to_signer: Actor, to_org: Pubkey) -> HandoverArgs {
        let stored = self.batch_state(batch);
        let shipment = self.shipment_state(stored.shipment);
        let at_source = stored.stage == BatchStage::AtSource;
        let stage = if at_source {
            HandoverStage::Departure
        } else if to_org == shipment.destination_custodian {
            HandoverStage::Arrival
        } else {
            HandoverStage::Transfer
        };
        HandoverArgs {
            shipment: stored.shipment,
            batch,
            lot: stored.lot,
            source: shipment.source,
            destination: shipment.destination,
            manifest_digest: stored.manifest_digest,
            expected_sequence: stored.sequence,
            valid_until: self.now + CUSTODY_WINDOW,
            from_signer: self.signer_for(stored.holder),
            from_org: stored.holder,
            to_signer,
            to_org,
            departure_document: at_source.then_some(shipment.departure_document),
            stage,
        }
    }

    /// The wallet the world delegated for `org`.
    fn signer_for(&self, org: Pubkey) -> Actor {
        if org == self.custodian {
            Custodian
        } else if org == self.transporter {
            Driver
        } else if org == self.other_haulier {
            OtherDriver
        } else if org == self.destination_org {
            self.destination_signer
        } else if org == self.terminal {
            Custodian2
        } else {
            panic!("no signer for {org}")
        }
    }

    /// Kopano Stockyard Custody to Mosela Haulage (the batch's carrier).
    fn departure_args(&self, batch: Pubkey) -> HandoverArgs {
        self.handover_args(batch, Driver, self.transporter)
    }

    /// Mosela Haulage to the destination custodian.
    fn arrival_args(&self, batch: Pubkey) -> HandoverArgs {
        self.handover_args(batch, self.destination_signer, self.destination_org)
    }

    /// The "Hand over custody" text the program rebuilds from the accounts and the arguments.
    fn handover_text(&self, args: &HandoverArgs) -> Vec<u8> {
        let batch = self.batch_state(args.batch);
        let shipment = self.shipment_state(args.shipment);
        let lot: Lot = self.f.read(args.lot);
        custody_handover_message(
            &ID,
            &INSTANCE,
            &lot.lot_id,
            &shipment.shipment_id,
            batch.index + 1,
            batch.batch_count,
            batch.quantity_kg,
            &self.name(args.from_org),
            &self.name(args.to_org),
            args.stage,
            &batch.manifest_digest,
            args.expected_sequence,
            args.valid_until,
        )
    }

    fn handover_instruction(&self, args: &HandoverArgs) -> Instruction {
        ix(
            accounts::Handover {
                sponsor: self.f.payer(),
                protocol: self.f.protocol,
                shipment: args.shipment,
                batch: args.batch,
                lot: args.lot,
                from_org: args.from_org,
                from_authority: self.authority_of(args.from_signer),
                to_org: args.to_org,
                to_authority: self.authority_of(args.to_signer),
                source_class: args.source,
                destination_class: args.destination,
                departure_document: args.departure_document,
                handover: handover_key(args.batch, args.expected_sequence),
                instructions: INSTRUCTIONS_SYSVAR,
                system_program: SYSTEM,
            },
            instruction::Handover {
                manifest_digest: args.manifest_digest,
                expected_sequence: args.expected_sequence,
                valid_until: args.valid_until,
            },
        )
    }

    /// One Ed25519 instruction with two entries over one shared text, the holder first.
    fn handover_signed(&self, args: &HandoverArgs, text: &[u8]) -> [Instruction; 2] {
        let signers = [
            self.f.signer(args.from_signer),
            self.f.signer(args.to_signer),
        ];
        [
            ed25519_shared_instruction(&signers, text),
            self.handover_instruction(args),
        ]
    }

    fn handover(&self, args: &HandoverArgs) -> [Instruction; 2] {
        self.handover_signed(args, &self.handover_text(args))
    }

    /// Sends the handover and checks the HandoverRecord, every effect on the batch, shipment,
    /// lot and both classes (§6.1 "handover effect"), the event and the invariants.
    fn handover_ok(&mut self, args: &HandoverArgs) -> Pubkey {
        let record = handover_key(args.batch, args.expected_sequence);
        let batch_before = self.batch_state(args.batch);
        let shipment_before = self.shipment_state(args.shipment);
        let lot_before: Lot = self.f.read(args.lot);
        let source_before = self.class_state(args.source);
        let destination_before = self.class_state(args.destination);
        let mut untouched = vec![
            self.position,
            Self::vault(args.lot, self.position),
            Self::mint(args.lot),
            self.intake(),
            args.from_org,
            args.to_org,
            self.authority_of(args.from_signer),
            self.authority_of(args.to_signer),
        ];
        untouched.extend(args.departure_document);
        let untouched = self.snapshot(&untouched);
        let instructions = self.handover(args);
        let tx = self.f.sponsored_ok(&instructions);
        let now = self.now;
        let q = batch_before.quantity_kg;

        let expected_record = HandoverRecord {
            protocol: self.f.protocol,
            batch: args.batch,
            shipment: args.shipment,
            sequence: args.expected_sequence,
            from: args.from_org,
            to: args.to_org,
            from_wallet: self.f.key(args.from_signer),
            to_wallet: self.f.key(args.to_signer),
            stage: args.stage,
            quantity_kg: q,
            manifest_digest: batch_before.manifest_digest,
            at: now,
            bump: bump_of(&[
                b"handover",
                args.batch.as_ref(),
                &args.expected_sequence.to_le_bytes(),
            ]),
        };
        assert_same(&self.f.read::<HandoverRecord>(record), &expected_record);
        assert_eq!(
            self.f.owner_and_data_len(record),
            Some((ID, HANDOVER_SPACE))
        );

        let mut batch = batch_before.clone();
        batch.holder = args.to_org;
        batch.sequence += 1;
        let mut shipment = shipment_before.clone();
        shipment.revision += 1;
        let mut lot = lot_before.clone();
        let mut source = source_before.clone();
        let mut destination = destination_before.clone();
        match args.stage {
            HandoverStage::Departure => {
                source.occupied_kg -= q;
                batch.stage = BatchStage::InTransit;
                batch.departed_at = Some(now);
                shipment.departed_count += 1;
                shipment.departed_kg += q;
                if shipment_before.status == ShipmentStatus::Prepared {
                    shipment.status = ShipmentStatus::InTransit;
                    lot.state = LotState::InTransit;
                    lot.revision += 1;
                }
            }
            HandoverStage::Transfer => {}
            HandoverStage::Arrival => {
                destination.reserved_inbound_kg -= q;
                destination.occupied_kg += q;
                batch.stage = BatchStage::Arrived;
                batch.arrived_at = Some(now);
                shipment.arrived_count += 1;
                shipment.arrived_kg += q;
                if shipment.arrived_count == shipment.batch_count {
                    shipment.status = ShipmentStatus::Arrived;
                    lot.state = LotState::Stored;
                    lot.custodian_class = args.destination;
                    lot.revision += 1;
                }
            }
        }
        assert_same(&self.batch_state(args.batch), &batch);
        assert_same(&self.shipment_state(args.shipment), &shipment);
        assert_same(&self.f.read::<Lot>(args.lot), &lot);
        assert_same(&self.class_state(args.source), &source);
        assert_same(&self.class_state(args.destination), &destination);
        self.assert_unchanged(&untouched);
        assert_event(
            &tx,
            events::CustodyHandedOver {
                handover: record,
                batch: args.batch,
                shipment: args.shipment,
                lot: args.lot,
                sequence: args.expected_sequence,
                from: args.from_org,
                to: args.to_org,
                stage: args.stage,
                quantity_kg: q,
                shipment_status: shipment.status,
                lot_state: lot.state,
                shipment_revision: shipment.revision,
                lot_revision: lot.revision,
            },
        );
        self.assert_invariants();
        record
    }

    /// The handover must fail with `expected` at the handover instruction, with no state
    /// change, no event and no HandoverRecord.
    fn handover_refused(&mut self, args: &HandoverArgs, expected: ThetisError) {
        let instructions = self.handover(args);
        self.handover_instructions_refused(&instructions, args, expected);
    }

    fn handover_instructions_refused(
        &mut self,
        instructions: &[Instruction],
        args: &HandoverArgs,
        expected: ThetisError,
    ) {
        let record = handover_key(args.batch, args.expected_sequence);
        let existed = self.f.account_exists(record);
        self.f.sponsored_refused(instructions, 1, expected);
        assert_eq!(self.f.account_exists(record), existed);
        self.assert_invariants();
    }

    fn depart(&mut self, batch: Pubkey) -> Pubkey {
        let args = self.departure_args(batch);
        assert_eq!(args.stage, HandoverStage::Departure);
        self.handover_ok(&args)
    }

    fn arrive(&mut self, batch: Pubkey) -> Pubkey {
        let args = self.arrival_args(batch);
        assert_eq!(args.stage, HandoverStage::Arrival);
        self.handover_ok(&args)
    }

    // -------------------------------------------------- Phase 1 instructions ----

    /// A `transfer` of 2,000 t from the owner's position to Buyer Smelter Co, signed at the
    /// owner position's current revision.
    fn transfer_instructions(&self) -> [Instruction; 2] {
        let revision = self.position_state().revision;
        let valid_until = self.now + CUSTODY_WINDOW;
        let text = transfer_message(
            &ID,
            &INSTANCE,
            LOT_ID,
            TWO_THOUSAND_T,
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
                from_position: self.position,
                from_vault_authority: Self::vault_authority(self.position),
                from_vault: Self::vault(self.lot, self.position),
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
                quantity_kg: TWO_THOUSAND_T,
                expected_revision: revision,
                valid_until,
            },
        );
        [
            ed25519_instruction(&[(self.f.signer(Owner), text.as_slice())]),
            transfer,
        ]
    }

    /// A `redeem` of `quantity_kg` with `custodian` (signed by `signer`) at `site`, signed at
    /// the position's current revision.
    fn redeem_instructions(
        &self,
        quantity_kg: u64,
        signer: Actor,
        custodian: Pubkey,
        site: Pubkey,
    ) -> [Instruction; 2] {
        let revision = self.position_state().revision;
        let valid_until = self.now + CUSTODY_WINDOW;
        let text = redeem_message(
            &ID,
            &INSTANCE,
            LOT_ID,
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
                lot: self.lot,
                root: None,
                intake: self.intake(),
                mint: Self::mint(self.lot),
                position: self.position,
                vault_authority: Self::vault_authority(self.position),
                vault: Self::vault(self.lot, self.position),
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

    /// Lender One Bank's facility to Khunou Ore Exports, its 20 c/kg valuation of the source
    /// site, and a pledge of `quantity_kg` as loan 0.
    fn open_lending(&mut self, quantity_kg: u64) {
        let open = ix(
            accounts::OpenFacility {
                lender: self.f.key(Lender),
                payer: self.f.payer(),
                protocol: self.f.protocol,
                authority: self.authority_of(Lender),
                lender_org: self.lender,
                borrower_org: self.owner,
                facility: self.facility,
                pool: None,
                system_program: SYSTEM,
            },
            instruction::OpenFacility {
                facility_id: FACILITY_ONE,
                currency: USD,
                currency_decimals: CENTS,
                terms_version: 1,
                rate_bps: RATE_BPS,
                max_ltv_bps: MAX_LTV_BPS,
                terms_digest: TERMS_DIGEST,
            },
        );
        self.f.signed_ok(&[open], Lender);
        self.valuation = pda(&[
            b"valuation",
            self.facility.as_ref(),
            self.class_policy.as_ref(),
            GRADES[0].as_bytes(),
            self.source.as_ref(),
        ]);
        let set = ix(
            accounts::SetValuation {
                lender: self.f.key(Lender),
                payer: self.f.payer(),
                protocol: self.f.protocol,
                authority: self.authority_of(Lender),
                lender_org: self.lender,
                facility: self.facility,
                class_policy: self.class_policy,
                custodian_class: self.source,
                valuation: self.valuation,
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
        self.f.signed_ok(&[set], Lender);
        let revision = self.position_state().revision;
        let valid_until = self.now + MONEY_WINDOW;
        let text = pledge_message(
            &ID,
            &INSTANCE,
            LOT_ID,
            quantity_kg,
            OWNER_NAME,
            LENDER_NAME,
            &FACILITY_ONE,
            0,
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
                position: self.position,
                borrower_org: self.owner,
                borrower_authority: self.authority_of(Owner),
                lender_org: self.lender,
                lender_authority: self.authority_of(Lender),
                facility: self.facility,
                loan: self.loan,
                lock: self.lock,
                instructions: INSTRUCTIONS_SYSVAR,
                system_program: SYSTEM,
            },
            instruction::Pledge {
                loan_index: 0,
                quantity_kg,
                expected_revision: revision,
                valid_until,
            },
        );
        let signers = [self.f.signer(Owner), self.f.signer(Lender)];
        self.f
            .sponsored_ok(&[ed25519_shared_instruction(&signers, &text), pledge]);
        assert_eq!(
            self.f.read::<LockAllocation>(self.lock).quantity_kg,
            quantity_kg
        );
        self.assert_invariants();
    }

    /// A fiat `record_advance` of USD600,000 on loan 0, at the loan's current revision.
    fn advance_instructions(&self) -> [Instruction; 2] {
        let loan: Loan = self.f.read(self.loan);
        let valid_until = self.now + MONEY_WINDOW;
        let text = advance_message(
            &ID,
            &INSTANCE,
            LOT_ID,
            OWNER_NAME,
            LENDER_NAME,
            &FACILITY_ONE,
            loan.index,
            SIX_HUNDRED_K,
            loan.principal + SIX_HUNDRED_K,
            &USD,
            CENTS,
            RATE_BPS,
            1,
            loan.revision,
            valid_until,
        );
        let advance = ix(
            accounts::RecordAdvance {
                lender: self.f.key(Lender),
                protocol: self.f.protocol,
                lender_authority: self.authority_of(Lender),
                lender_org: self.lender,
                facility: self.facility,
                loan: self.loan,
                lock: self.lock,
                lot: self.lot,
                valuation: self.valuation,
                borrower_org: self.owner,
                borrower_authority: self.authority_of(Owner),
                instructions: INSTRUCTIONS_SYSVAR,
            },
            instruction::RecordAdvance {
                amount: SIX_HUNDRED_K,
                currency: USD,
                expected_revision: loan.revision,
                valid_until,
            },
        );
        [
            ed25519_instruction(&[(self.f.signer(Owner), text.as_slice())]),
            advance,
        ]
    }

    fn release_intent_key(&self, nonce: u64) -> Pubkey {
        pda(&[b"release", self.loan.as_ref(), &nonce.to_le_bytes()])
    }

    /// A release intent `nonce` for 2,000 t to Buyer Smelter Co at USD400,000, signed at the
    /// position's current revision.
    fn release_intent_instructions(&self, nonce: u64) -> [Instruction; 2] {
        let revision = self.position_state().revision;
        let valid_until = self.now + MONEY_WINDOW;
        let expires_at = self.now + DAY;
        let text = release_intent_message(
            &ID,
            &INSTANCE,
            LOT_ID,
            TWO_THOUSAND_T,
            OWNER_NAME,
            BUYER_NAME,
            LENDER_NAME,
            &FACILITY_ONE,
            0,
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
                lender_org: self.lender,
                facility: self.facility,
                loan: self.loan,
                lock: self.lock,
                lot: self.lot,
                position: self.position,
                intent: self.release_intent_key(nonce),
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

    fn payment_key(&self, id: u8) -> Pubkey {
        pda(&[
            b"payment",
            self.f.protocol.as_ref(),
            self.lender.as_ref(),
            &payment_id(id),
        ])
    }

    /// A real `confirm_payment` by Lender One Bank on loan 0.
    fn confirm(&mut self, id: u8, purpose: PaymentPurpose, subject: Pubkey, amount: u64) -> Pubkey {
        let payment = self.payment_key(id);
        let confirm = ix(
            accounts::ConfirmPayment {
                lender: self.f.key(Lender),
                payer: self.f.payer(),
                protocol: self.f.protocol,
                authority: self.authority_of(Lender),
                lender_org: self.lender,
                facility: self.facility,
                loan: self.loan,
                subject,
                target: None,
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
        self.f.signed_ok(&[confirm], Lender);
        payment
    }

    /// Buyer Smelter Co's `sell_pledged` of release intent `intent` with `payment`, signed at
    /// `expected_revision`.
    fn sell_instructions(
        &self,
        intent: Pubkey,
        payment: Pubkey,
        expected_revision: u64,
    ) -> [Instruction; 2] {
        let stored: ReleaseIntent = self.f.read(intent);
        let valid_until = self.now + MONEY_WINDOW;
        let buyer_position = Self::position_key(self.lot, self.buyer);
        let text = buy_pledged_message(
            &ID,
            &INSTANCE,
            LOT_ID,
            stored.quantity_kg,
            OWNER_NAME,
            BUYER_NAME,
            LENDER_NAME,
            &FACILITY_ONE,
            0,
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
                facility: self.facility,
                lender_org: self.lender,
                loan: self.loan,
                lock: self.lock,
                valuation: self.valuation,
                intent,
                payment,
                lot: self.lot,
                mint: Self::mint(self.lot),
                seller_org: self.owner,
                buyer_org: self.buyer,
                buyer_authority: self.authority_of(Buyer),
                seller_position: self.position,
                seller_vault_authority: Self::vault_authority(self.position),
                seller_vault: Self::vault(self.lot, self.position),
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

    fn repay_instruction(&self, payment: Pubkey, amount: u64) -> Instruction {
        ix(
            accounts::Repay {
                signer: self.f.key(Lender),
                protocol: self.f.protocol,
                facility: self.facility,
                loan: self.loan,
                authority: Some(self.authority_of(Lender)),
                lender_org: Some(self.lender),
                payment: Some(payment),
                pool: None,
                pool_authority: None,
                pool_vault: None,
                payer_token: None,
                mint: None,
                token_program: None,
            },
            instruction::Repay { amount },
        )
    }

    fn liquidate_instruction(&self) -> Instruction {
        let loan: Loan = self.f.read(self.loan);
        ix(
            accounts::Liquidate {
                lender: self.f.key(Lender),
                protocol: self.f.protocol,
                authority: self.authority_of(Lender),
                lender_org: self.lender,
                facility: self.facility,
                loan: self.loan,
                lock: self.lock,
                lot: self.lot,
                valuation: self.valuation,
            },
            instruction::Liquidate {
                expected_revision: loan.revision,
            },
        )
    }

    // ------------------------------------------------------------ invariants ----

    /// Writes `restriction` into the lot's account (the harness route until the restriction instructions exist, §9).
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

    /// §3 invariants over every lot, shipment, batch and class the world made: supply equals
    /// the sum of positions and each vault holds its position; each open shipment's counters are
    /// ordered; each class's occupancy and reservation equal its ordinary stock plus the
    /// contributions of every open shipment touching it, within capacity; a lot is `Prepared` or
    /// `InTransit` exactly while it has one open shipment; `reserved_kg` stays 0; and each
    /// batch's `sequence` equals the number of its HandoverRecord accounts.
    fn assert_invariants(&self) {
        let open: Vec<Shipment> = self
            .shipments
            .iter()
            .map(|key| self.shipment_state(*key))
            .filter(|shipment| {
                matches!(
                    shipment.status,
                    ShipmentStatus::Prepared | ShipmentStatus::InTransit
                )
            })
            .collect();
        for shipment in &open {
            assert!(shipment.registered_kg <= shipment.committed_kg);
            assert!(shipment.registered_count <= shipment.batch_count);
            assert!(shipment.departed_count <= shipment.registered_count);
            assert!(shipment.arrived_count <= shipment.departed_count);
            assert!(shipment.arrived_kg <= shipment.departed_kg);
            assert!(shipment.departed_kg <= shipment.registered_kg);
        }
        for batch_key in &self.batches {
            let batch = self.batch_state(*batch_key);
            for sequence in 0..batch.sequence {
                assert!(self.f.account_exists(handover_key(*batch_key, sequence)));
            }
            assert!(!self
                .f
                .account_exists(handover_key(*batch_key, batch.sequence)));
        }
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

// ================================================================ the demo route ====

#[test]
fn handover_demo_departure_moves_holder_and_source_occupancy() {
    let mut w = World::demo();
    let (shipment, batch) = w.ship_demo();
    assert_eq!(w.batch_state(batch).holder, w.custodian);
    w.depart(batch);

    let stored = w.batch_state(batch);
    assert_eq!(stored.holder, w.transporter);
    assert_eq!(stored.stage, BatchStage::InTransit);
    assert_eq!(stored.sequence, 1);
    assert_eq!(w.class_state(w.source).occupied_kg, 0);
    // The reservation stays until the batch arrives.
    assert_eq!(w.class_state(w.destination).reserved_inbound_kg, LOT_KG);
    assert_eq!(w.class_state(w.destination).occupied_kg, 0);
    assert_eq!(w.shipment_state(shipment).status, ShipmentStatus::InTransit);
    assert_eq!(w.lot_state().state, LotState::InTransit);
    assert_eq!(w.lot_state().custodian_class, w.source);
}

#[test]
fn handover_full_route_arrival_converts_reservation() {
    let mut w = World::demo();
    let (shipment, batch) = w.ship_demo();
    w.depart(batch);
    w.arrive(batch);

    let stored = w.batch_state(batch);
    assert_eq!(stored.holder, w.terminal);
    assert_eq!(stored.stage, BatchStage::Arrived);
    assert_eq!(stored.sequence, 2);
    let destination = w.class_state(w.destination);
    assert_eq!(destination.reserved_inbound_kg, 0);
    assert_eq!(destination.occupied_kg, LOT_KG);
    assert_eq!(w.class_state(w.source).occupied_kg, 0);
    assert_eq!(w.shipment_state(shipment).status, ShipmentStatus::Arrived);
    let lot = w.lot_state();
    assert_eq!(lot.state, LotState::Stored);
    assert_eq!(lot.custodian_class, w.destination);
}

#[test]
fn handover_transfer_to_another_transporter_keeps_in_transit() {
    let mut w = World::demo();
    let (shipment, batch) = w.ship_demo();
    w.depart(batch);
    let lot_before = w.lot_state();
    let args = w.handover_args(batch, OtherDriver, w.other_haulier);
    assert_eq!(args.stage, HandoverStage::Transfer);
    w.handover_ok(&args);
    let stored = w.batch_state(batch);
    assert_eq!(stored.holder, w.other_haulier);
    assert_eq!(stored.stage, BatchStage::InTransit);
    assert_eq!(stored.sequence, 2);
    assert_same(&w.lot_state(), &lot_before);
    assert_eq!(w.shipment_state(shipment).revision, 2);
    // The other haulier can then deliver to the destination.
    w.arrive(batch);
    assert_eq!(w.lot_state().state, LotState::Stored);
}

// ===================================================================== A10 ====

#[test]
fn handover_rejects_sender_not_holder() {
    let mut w = World::demo();
    let (_, batch) = w.ship_demo();
    // Port Terminal T1 signs as the sender of a batch Kopano holds.
    let mut args = w.departure_args(batch);
    args.from_signer = Custodian2;
    args.from_org = w.terminal;
    w.handover_refused(&args, WrongOrganisation);
}

#[test]
fn handover_rejects_carrier_not_assigned() {
    let mut w = World::demo();
    let (_, batch) = w.ship_demo();
    // Another haulier, a Transporter with CARRY that is not the batch's carrier.
    let args = w.handover_args(batch, OtherDriver, w.other_haulier);
    assert_eq!(args.stage, HandoverStage::Departure);
    w.handover_refused(&args, RecipientNotApproved);
    // The assigned carrier takes the batch.
    w.depart(batch);
}

#[test]
fn handover_rejects_next_holder_without_authority() {
    let mut w = World::demo();
    let (_, batch) = w.ship_demo();
    // The refused driver: a Mosela Haulage member's second wallet, linked but with no
    // Authority. The relay passes the Authority PDA derived from that wallet, which does not
    // exist, so Anchor refuses the account before the handler runs.
    let args = w.handover_args(batch, UnlinkedDriver, w.transporter);
    let missing = w.authority_of(UnlinkedDriver);
    assert!(!w.f.account_exists(missing));
    let instructions = w.handover(&args);
    w.f.sponsored_refused_anchor(&instructions, 1, AnchorError::AccountNotInitialized);
    assert!(!w.f.account_exists(handover_key(batch, 0)));
    assert_eq!(w.batch_state(batch).holder, w.custodian);
    w.assert_invariants();
}

#[test]
fn handover_rejects_arrival_at_unreserved_destination() {
    let mut w = World::demo();
    let (_, batch) = w.ship_demo();
    w.depart(batch);
    // Kopano Stockyard Custody holds no reservation for this shipment and is no Transporter.
    let args = w.handover_args(batch, Custodian, w.custodian);
    w.handover_refused(&args, RecipientNotApproved);
}

#[test]
fn handover_rejects_wrong_sequence() {
    let mut w = World::demo();
    let (_, batch) = w.ship_demo();
    w.depart(batch);
    let mut ahead = w.arrival_args(batch);
    assert_eq!(ahead.expected_sequence, 1);
    ahead.expected_sequence = 2;
    w.handover_refused(&ahead, StaleRevision);
    // The used sequence fails at the HandoverRecord PDA's init.
    let mut used = w.arrival_args(batch);
    used.expected_sequence = 0;
    let instructions = w.handover(&used);
    w.f.sponsored_already_in_use(&instructions, 1);
    assert_eq!(w.batch_state(batch).sequence, 1);
    w.assert_invariants();
}

#[test]
fn handover_rejects_different_manifest() {
    let mut w = World::demo();
    let (_, batch) = w.ship_demo();
    let mut args = w.departure_args(batch);
    args.manifest_digest = OTHER_MANIFEST;
    w.handover_refused(&args, ManifestMismatch);
}

#[test]
fn handover_rejects_single_signature() {
    let mut w = World::demo();
    let (_, batch) = w.ship_demo();
    let args = w.departure_args(batch);
    let text = w.handover_text(&args);
    let instructions = [
        ed25519_instruction(&[(w.f.signer(args.from_signer), text.as_slice())]),
        w.handover_instruction(&args),
    ];
    w.handover_instructions_refused(&instructions, &args, WrongSignatureCount);
}

// ===================================================================== A11 ====

#[test]
fn handover_rejects_expired_text() {
    let mut w = World::demo();
    let (_, batch) = w.ship_demo();
    let mut args = w.departure_args(batch);
    args.valid_until = w.now - 1;
    w.handover_refused(&args, Expired);
}

#[test]
fn handover_rejects_copied_signature_on_fresh_text() {
    let mut w = World::demo();
    let (_, batch) = w.ship_demo();
    let old = w.departure_args(batch);
    let old_text = w.handover_text(&old);
    let mut fresh = old.clone();
    fresh.valid_until = old.valid_until + 10;
    // The Ed25519 instruction carries the old text and its valid signatures.
    let instructions = w.handover_signed(&fresh, &old_text);
    w.handover_instructions_refused(&instructions, &fresh, MessageMismatch);
    // Both parties sign the fresh text and it goes through.
    w.handover_ok(&fresh);
}

#[test]
fn handover_replay_after_success_refused() {
    let mut w = World::demo();
    let (_, batch) = w.ship_demo();
    let args = w.departure_args(batch);
    let instructions = w.handover(&args);
    w.handover_ok(&args);
    let snapshot = w.snapshot(&[batch, w.lot, w.source, w.destination, w.shipments[0]]);
    w.f.sponsored_already_in_use(&instructions, 1);
    w.assert_unchanged(&snapshot);
    w.assert_invariants();
}

#[test]
fn handover_rejects_window_601() {
    let mut w = World::demo();
    let (_, batch) = w.ship_demo();
    let mut args = w.departure_args(batch);
    args.valid_until = w.now + 601;
    w.handover_refused(&args, WindowTooLong);
    args.valid_until = w.now + 600;
    w.handover_ok(&args);
}

// ============================================================== stage guards ====

#[test]
fn handover_rejects_before_manifest_complete() {
    let mut w = World::demo();
    let manifest = w.manifest(&[THREE_THOUSAND_T, TWO_THOUSAND_T]);
    let shipment = w.prepare(&manifest);
    let first = w.register(shipment, &manifest, 0);
    let args = w.departure_args(first);
    w.handover_refused(&args, ShipmentIncomplete);
    w.register(shipment, &manifest, 1);
    w.depart(first);
}

#[test]
fn handover_rejects_arrived_batch() {
    let mut w = World::demo();
    let (shipment, b1, b2) = w.ship_two();
    w.depart(b1);
    w.depart(b2);
    w.arrive(b1);
    assert_eq!(w.shipment_state(shipment).status, ShipmentStatus::InTransit);
    // The destination custodian hands the arrived B1 to a Transporter.
    let args = w.handover_args(b1, Driver, w.transporter);
    assert_eq!(args.from_org, w.terminal);
    w.handover_refused(&args, StageOutOfOrder);
}

#[test]
fn handover_rejects_cancelled_shipment() {
    let mut w = World::demo();
    let (shipment, batch) = w.ship_demo();
    let cancel = w.cancel_instructions(shipment);
    w.f.sponsored_ok(&cancel);
    assert_eq!(w.shipment_state(shipment).status, ShipmentStatus::Cancelled);
    let args = w.departure_args(batch);
    w.handover_refused(&args, ShipmentNotOpen);
}

#[test]
fn handover_rejects_frozen_lot() {
    let mut w = World::demo();
    let (_, batch) = w.ship_demo();
    w.set_restriction(Restriction::Frozen);
    let args = w.departure_args(batch);
    w.handover_refused(&args, Restricted);
}

#[test]
fn handover_allows_review_required_lot() {
    let mut w = World::demo();
    let (_, batch) = w.ship_demo();
    w.set_restriction(Restriction::ReviewRequired);
    w.depart(batch);
    w.arrive(batch);
    assert_eq!(w.lot_state().restriction, Restriction::ReviewRequired);
}

#[test]
fn handover_rejects_paused() {
    let mut w = World::demo();
    let (_, batch) = w.ship_demo();
    let pause = w.f.change_pause(Admin, pause::HANDOVER, true);
    w.f.ok(pause, Admin);
    let args = w.departure_args(batch);
    w.handover_refused(&args, Paused);
    let unpause = w.f.change_pause(Admin, pause::HANDOVER, false);
    w.f.ok(unpause, Admin);
    w.depart(batch);
}

// ===================================================================== A12 ====

#[test]
fn partial_arrival_exact_occupancy_and_reservation() {
    let mut w = World::demo();
    let (shipment, b1, b2) = w.ship_two();
    let row = |w: &World, state: LotState, s_occupied, d_reserved, d_occupied, counts: (u8, u8)| {
        assert_eq!(w.lot_state().state, state);
        assert_eq!(w.class_state(w.source).occupied_kg, s_occupied);
        assert_eq!(w.class_state(w.destination).reserved_inbound_kg, d_reserved);
        assert_eq!(w.class_state(w.destination).occupied_kg, d_occupied);
        let stored = w.shipment_state(shipment);
        assert_eq!((stored.departed_count, stored.arrived_count), counts);
    };
    row(&w, LotState::Prepared, LOT_KG, LOT_KG, 0, (0, 0));
    w.depart(b1);
    row(&w, LotState::InTransit, TWO_THOUSAND_T, LOT_KG, 0, (1, 0));
    w.depart(b2);
    row(&w, LotState::InTransit, 0, LOT_KG, 0, (2, 0));
    w.arrive(b1);
    row(
        &w,
        LotState::InTransit,
        0,
        TWO_THOUSAND_T,
        THREE_THOUSAND_T,
        (2, 1),
    );
    w.arrive(b2);
    row(&w, LotState::Stored, 0, 0, LOT_KG, (2, 2));
    assert_eq!(w.lot_state().custodian_class, w.destination);
}

#[test]
fn partial_arrival_keeps_lot_in_transit_and_sale_blocked() {
    let mut w = World::demo();
    w.open_lending(THREE_THOUSAND_T);
    // A release intent and its confirmed payment made before the shipment.
    let early = w.release_intent_instructions(1);
    w.f.sponsored_ok(&early);
    let intent = w.release_intent_key(1);
    let payment = w.confirm(1, PaymentPurpose::Release, intent, FOUR_HUNDRED_K);
    let intent_revision = w.f.read::<ReleaseIntent>(intent).position_revision;

    let (_, b1, b2) = w.ship_two();
    w.depart(b1);
    w.depart(b2);
    w.arrive(b1);
    assert_eq!(w.lot_state().state, LotState::InTransit);

    let transfer = w.transfer_instructions();
    w.f.sponsored_refused(&transfer, 1, LotNotStored);
    let redeem = w.redeem_instructions(TWO_THOUSAND_T, Custodian, w.custodian, w.source);
    w.f.sponsored_refused(&redeem, 1, LotNotStored);
    let release = w.release_intent_instructions(2);
    w.f.sponsored_refused(&release, 1, LotNotStored);
    // The pre-shipment intent is stale: the prepare raised the position revision.
    assert!(w.position_state().revision > intent_revision);
    let sell = w.sell_instructions(intent, payment, intent_revision);
    w.f.sponsored_refused(&sell, 1, StaleRevision);
    w.assert_invariants();
}

#[test]
fn shipment_completes_only_when_every_batch_arrives() {
    let mut w = World::demo();
    let (shipment, b1, b2) = w.ship_two();
    w.depart(b1);
    w.depart(b2);
    w.arrive(b1);
    let stored = w.shipment_state(shipment);
    assert_eq!(stored.status, ShipmentStatus::InTransit);
    assert_eq!(stored.arrived_count, 1);
    assert_eq!(w.lot_state().state, LotState::InTransit);
    assert_eq!(w.lot_state().custodian_class, w.source);
    w.arrive(b2);
    let stored = w.shipment_state(shipment);
    assert_eq!(stored.status, ShipmentStatus::Arrived);
    assert_eq!(stored.arrived_kg, LOT_KG);
    assert_eq!(w.lot_state().state, LotState::Stored);
    assert_eq!(w.lot_state().custodian_class, w.destination);
}

// ===================================================================== A13 ====

#[test]
fn cancel_after_departure_refused_reservation_kept() {
    let mut w = World::demo();
    let (shipment, batch) = w.ship_demo();
    w.depart(batch);
    let before = w.class_state(w.destination);
    let cancel = w.cancel_instructions(shipment);
    w.f.sponsored_refused(&cancel, 1, ShipmentDeparted);
    assert_same(&w.class_state(w.destination), &before);
    assert_eq!(before.reserved_inbound_kg, LOT_KG);
    w.assert_invariants();
}

// ===================================================================== A14 ====

#[test]
fn departure_refused_after_document_revoked() {
    let mut w = World::demo();
    let (_, batch) = w.ship_demo();
    let revoke = w.f.revoke_document(Custodian, w.custodian, w.document);
    w.f.ok(revoke, Custodian);
    let args = w.departure_args(batch);
    w.handover_refused(&args, DepartureDocumentInvalid);
}

#[test]
fn departure_refused_after_document_expired() {
    let mut w = World::demo();
    let (_, batch) = w.ship_demo();
    let document: DocumentAttestation = w.f.read(w.document);
    w.advance_to(document.valid_until);
    let args = w.departure_args(batch);
    w.handover_refused(&args, DepartureDocumentInvalid);
    // One second earlier the same departure goes through.
    w.advance_to(document.valid_until - 1);
    let args = w.departure_args(batch);
    w.handover_ok(&args);
}

#[test]
fn record_advance_rejects_lot_in_transit() {
    let mut w = World::demo();
    w.open_lending(LOT_KG);
    let (_, batch) = w.ship_demo();
    w.depart(batch);
    let advance = w.advance_instructions();
    w.f.signed_refused(&advance, Lender, 1, LotNotStored);
    assert_eq!(w.f.read::<Loan>(w.loan).principal, 0);
}

#[test]
fn repay_succeeds_while_departure_blocked() {
    let mut w = World::demo();
    w.open_lending(LOT_KG);
    let advance = w.advance_instructions();
    w.f.signed_ok(&advance, Lender);
    let (_, batch) = w.ship_demo();
    let revoke = w.f.revoke_document(Custodian, w.custodian, w.document);
    w.f.ok(revoke, Custodian);
    let args = w.departure_args(batch);
    w.handover_refused(&args, DepartureDocumentInvalid);

    let before: Loan = w.f.read(w.loan);
    assert_eq!(before.principal, SIX_HUNDRED_K);
    let payment = w.confirm(2, PaymentPurpose::Repayment, w.loan, SIX_HUNDRED_K);
    let repay = w.repay_instruction(payment, SIX_HUNDRED_K);
    w.f.signed_ok(&[repay], Lender);
    let after: Loan = w.f.read(w.loan);
    assert_eq!(after.principal + after.booked_interest, 0);
    assert_eq!(
        w.f.read::<PaymentAttestation>(payment).status,
        PaymentStatus::Consumed
    );
    // The batch is still at the source and the lot still Prepared.
    assert_eq!(w.batch_state(batch).stage, BatchStage::AtSource);
    assert_eq!(w.lot_state().state, LotState::Prepared);
    w.assert_invariants();
}

// ===================================================================== A19 ====

#[test]
fn liquidate_mid_transit_keeps_custody_and_reservation() {
    let mut w = World::demo();
    w.open_lending(LOT_KG);
    let advance = w.advance_instructions();
    w.f.signed_ok(&advance, Lender);
    let (shipment, batch) = w.ship_demo();
    w.depart(batch);
    // A year's interest takes the debt over the 60% limit at 20 c/kg.
    w.advance_to(NOW + YEAR);
    let custody = w.snapshot(&[
        shipment,
        batch,
        handover_key(batch, 0),
        w.lot,
        w.position,
        w.source,
        w.destination,
    ]);
    let liquidate = w.liquidate_instruction();
    w.f.signed_ok(&[liquidate], Lender);
    assert_eq!(w.f.read::<Loan>(w.loan).status, LoanStatus::Recovery);
    assert_eq!(
        w.f.read::<LockAllocation>(w.lock).control,
        LockControl::Recovery
    );
    w.assert_unchanged(&custody);
    assert_eq!(w.class_state(w.destination).reserved_inbound_kg, LOT_KG);
    // The batch can still arrive.
    w.arrive(batch);
    assert_eq!(w.lot_state().state, LotState::Stored);
}

#[test]
fn redeem_after_arrival_at_destination_custodian_succeeds() {
    let mut w = World::with_second_custodian();
    let (_, batch) = w.ship_demo();
    w.depart(batch);
    w.arrive(batch);
    assert_eq!(w.lot_state().custodian_class, w.destination);
    assert_eq!(w.batch_state(batch).holder, w.destination_org);

    let destination_org = w.destination_org;
    let redeem = w.redeem_instructions(LOT_KG, SecondCustodian, destination_org, w.destination);
    w.f.sponsored_ok(&redeem);
    let lot = w.lot_state();
    assert_eq!(lot.state, LotState::Redeemed);
    assert_eq!(lot.supply_kg, 0);
    let intake: IntakeIdentity = w.f.read(w.intake());
    assert!(intake.retired);
    assert_eq!(intake.custodian, w.custodian);
    assert_eq!(w.class_state(w.destination).occupied_kg, 0);
    w.assert_invariants();
}

// ============================================================== known answers ====

const HANDOVER_TEXT: &str = "Thetis authorisation v1
Network: devnet
Program: jGJpdjtoDUtXMjvc4UaEi1mBeFZKqVfe9jL8ireHMs3
Protocol: 00112233445566778899aabbccddeeff
Action: Hand over custody
Lot: CR-0001
Shipment: 22222222222222222222222222222222
Batch: 1 of 1
Quantity: 5,000.000 t
From: Kopano Stockyard Custody
To: Mosela Haulage
Stage: Departure
Manifest: 4444444444444444444444444444444444444444444444444444444444444444
Sequence: 0
Valid until: 2026-11-19 16:32:05 SAST
Test network only. Synthetic data.";

#[test]
fn handover_message_known_answer() {
    let instance: [u8; 16] = std::array::from_fn(|index| u8::try_from(index * 0x11).unwrap());
    let text = custody_handover_message(
        &ID,
        &instance,
        "CR-0001",
        &[0x22; 16],
        1,
        1,
        5_000_000,
        "Kopano Stockyard Custody",
        "Mosela Haulage",
        HandoverStage::Departure,
        &[0x44; 32],
        0,
        1_795_098_725,
    );
    assert_eq!(String::from_utf8(text.clone()).unwrap(), HANDOVER_TEXT);
    assert_eq!(text.len(), 480);
    assert_eq!(
        sha256_hex(&text),
        "e81d1fa1436bfe8fffc851a44068124ba956f00faf175a5226c513e51d36e0d9"
    );
    // The other stages print their names on the same line.
    for (stage, line) in [
        (HandoverStage::Transfer, "\nStage: Transfer\n"),
        (HandoverStage::Arrival, "\nStage: Arrival\n"),
    ] {
        let other = custody_handover_message(
            &ID,
            &instance,
            "CR-0001",
            &[0x22; 16],
            1,
            1,
            5_000_000,
            "Kopano Stockyard Custody",
            "Mosela Haulage",
            stage,
            &[0x44; 32],
            0,
            1_795_098_725,
        );
        assert_eq!(
            String::from_utf8(other).unwrap(),
            HANDOVER_TEXT.replace("\nStage: Departure\n", line)
        );
    }
}

// ============================================================ transaction size ====

/// Two distinct 48-byte names and a 16-byte lot id (§11.1).
const WIDEST_FROM: &str = "Kopano Stockyard Custody And Allied Yards Pty 01";
const WIDEST_TO: &str = "Mosela Haulage And Allied Bulk Transport Pty 001";
const WIDEST_LOT_ID: &str = "CR-0001-WIDEST-1";

#[test]
fn handover_size_fits_v0_widest() {
    let mut w = World::demo();
    let (shipment, batch) = w.ship_demo();
    let demo = w.departure_args(batch);
    let widest = HandoverArgs {
        expected_sequence: u64::MAX,
        valid_until: i64::MAX,
        ..demo.clone()
    };
    let readonly = vec![
        SYSTEM,
        INSTRUCTIONS_SYSVAR,
        w.f.protocol,
        w.custodian,
        w.authority_of(Custodian),
        w.transporter,
        w.authority_of(Driver),
        w.document,
    ];
    let writable = |record: Pubkey| vec![shipment, batch, w.lot, w.source, w.destination, record];
    let demo_record = handover_key(batch, 0);
    let widest_record = handover_key(batch, u64::MAX);
    // The relay appends the HandoverRecord PDA before it hands over.
    let mut addresses = readonly.clone();
    addresses.extend(writable(demo_record));
    addresses.push(widest_record);
    let demo_writable = writable(demo_record);
    let widest_writable = writable(widest_record);
    let table = w.f.create_lookup_table(addresses);
    let inline = vec![w.f.payer(), ID, ED25519, COMPUTE_BUDGET];
    assert_eq!(readonly.len() + demo_writable.len(), 14);

    let instructions = w.handover(&demo);
    let (tx, demo_size) = handover_v0(
        &mut w,
        &table,
        instructions,
        inline.clone(),
        demo_writable,
        readonly.clone(),
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
    assert_eq!(w.batch_state(batch).holder, w.transporter);
    w.assert_invariants();

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
    let instructions = w.handover_signed(&widest, &text);
    let (_, widest_size) = handover_v0(
        &mut w,
        &table,
        instructions,
        inline,
        widest_writable,
        readonly,
    );
    println!("handover v0 widest: {widest_size} bytes");
    assert_eq!(widest_size, 1_181);
}

/// Compiles `[compute budget, verify, handover]` as a sponsored v0 transaction against
/// `table` and checks that only the sponsor signs, that `inline` are the only static keys, and
/// that the table supplies exactly `writable` and `readonly`.
fn handover_v0(
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
