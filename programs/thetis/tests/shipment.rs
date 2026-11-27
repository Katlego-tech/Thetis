//! Phase 3: `prepare_shipment` (owner PS), `register_batch` (TX, any payer) and
//! `cancel_shipment` (owner PS), with the destination's capacity reserved at prepare and released
//! at cancel; the Phase 3 enums, scopes, pause bits and errors; the departure document check; the
//! Merkle manifest; and the refusal of new debt while a lot is `Prepared` or restricted.
//!
//! Demo quantities and money are the demo's (5,000 t, 3,000 t, 2,000 t, USD600,000, USD400,000 at
//! 20 c/kg, haircut 0, LTV 60%, 1,200 bps). Site capacities are fixture values stated below. The
//! demo cast is synthetic; shipment ids, digests, site codes and expiries are deterministic
//! synthetic test inputs. The DocumentIssuer organisation uses the harness's generated test name.

mod common;

use anchor_lang::{prelude::Pubkey, AccountSerialize};
use anchor_spl::associated_token::{
    get_associated_token_address_with_program_id,
    spl_associated_token_account::instruction::create_associated_token_account_idempotent,
};
use anchor_spl::token::spl_token;
use common::{Actor::*, *};
use litesvm::types::TransactionMetadata;
use solana_message::{AddressLookupTableAccount, VersionedMessage};
use solana_transaction::{versioned::VersionedTransaction, Instruction};
use thetis::{
    accounts,
    error::ThetisError::{self, *},
    events, instruction,
    intent::message::{
        advance_message, borrow_message, cancel_shipment_message, issue_message, pledge_message,
        prepare_shipment_message, redeem_message, release_intent_message, split_message,
        transfer_message,
    },
    manifest::{batch_leaf, node, verify_batch},
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

const CLASS_CODE: &str = "CHROME";
/// A second class, for the destination of another class.
const OTHER_CLASS_CODE: &str = "MANGANES";
const GRADES: [&str; 2] = ["A", "B"];
const SOURCE_SITE: &str = "INLAND-YARD";
const DESTINATION_SITE: &str = "PORT-T1";
/// Fixture capacities: the source holds two demo lots, the destination exactly one.
const SOURCE_CAPACITY: u64 = 10_000_000;
const DESTINATION_CAPACITY: u64 = 5_000_000;

const LOT_ID: &str = "CR-0001";
const SECOND_LOT_ID: &str = "CR-0002";
const INTAKE_DIGEST: [u8; 32] = [0x0a; 32];
const SECOND_INTAKE_DIGEST: [u8; 32] = [0x0b; 32];
const LOT_KG: u64 = 5_000_000;
const THREE_THOUSAND_T: u64 = 3_000_000;
const TWO_THOUSAND_T: u64 = 2_000_000;
const DEPARTURE_SHA: [u8; 32] = [0xdd; 32];
const COLLECTION_TICKET: [u8; 32] = [0xc7; 32];
const SHIPMENT_ONE: [u8; 16] = [0x22; 16];
const SHIPMENT_TWO: [u8; 16] = [0x23; 16];

const USD: [u8; 3] = *b"USD";
const CENTS: u8 = 2;
const MICRO: u8 = 6;
const RATE_BPS: u16 = 1_200;
const MAX_LTV_BPS: u16 = 6_000;
const TERMS_DIGEST: [u8; 32] = [0x7d; 32];
const SOURCE_DIGEST: [u8; 32] = [0x5e; 32];
const FACILITY_ONE: [u8; 16] = [0x11; 16];

const OWNER_ID: u8 = 1;
const CUSTODIAN_ID: u8 = 2;
const TRANSPORTER_ID: u8 = 3;
const BUYER_ID: u8 = 4;
const TERMINAL_ID: u8 = 5;
const ISSUER_ID: u8 = 6;
const LENDER_ID: u8 = 7;

const OWNER_NAME: &str = "Khunou Ore Exports";
const CUSTODIAN_NAME: &str = "Kopano Stockyard Custody";
const TRANSPORTER_NAME: &str = "Mosela Haulage";
const BUYER_NAME: &str = "Buyer Smelter Co";
const TERMINAL_NAME: &str = "Port Terminal T1";
const LENDER_NAME: &str = "Lender One Bank";

/// Account sizes, discriminators included (§7).
const SHIPMENT_SPACE: usize = 406;
const BATCH_SPACE: usize = 274;

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

fn unhex(text: &str) -> [u8; 32] {
    assert_eq!(text.len(), 64);
    let mut out = [0; 32];
    for (index, byte) in out.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&text[2 * index..2 * index + 2], 16).unwrap();
    }
    out
}

fn shipment_key(protocol: Pubkey, shipment_id: &[u8; 16]) -> Pubkey {
    pda(&[b"shipment", protocol.as_ref(), shipment_id])
}

fn batch_key(protocol: Pubkey, load_digest: &[u8; 32]) -> Pubkey {
    pda(&[b"batch", protocol.as_ref(), load_digest])
}

fn bump_of(seeds: &[&[u8]]) -> u8 {
    Pubkey::find_program_address(seeds, &ID).1
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

/// A manifest of up to 16 leaves, its root and each leaf's 4-level proof, built in the test with
/// the program's `batch_leaf` and `node` over a 16-leaf tree padded with zero leaves.
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

/// One `prepare_shipment` call, with every input a test may vary.
#[derive(Clone)]
struct PrepareArgs {
    shipment_id: [u8; 16],
    batch_count: u8,
    manifest_root: [u8; 32],
    /// The lot's revision.
    expected_revision: u64,
    valid_until: i64,
    signer: Actor,
    owner_org: Pubkey,
    lot: Pubkey,
    position: Pubkey,
    source: Pubkey,
    destination: Pubkey,
    destination_org: Pubkey,
    document: Pubkey,
    issuer: Pubkey,
}

/// One `cancel_shipment` call.
#[derive(Clone)]
struct CancelArgs {
    shipment: Pubkey,
    /// The shipment's revision.
    expected_revision: u64,
    valid_until: i64,
    signer: Actor,
    owner_org: Pubkey,
    lot: Pubkey,
    destination: Pubkey,
    destination_org: Pubkey,
}

/// A protocol in either settlement mode with the demo cast, a source site of Kopano Stockyard
/// Custody and a destination site of Port Terminal T1 in the chrome class, CR-0001 (5,000 t,
/// grade A) issued at the source to Khunou Ore Exports, and Kopano's departure document for it.
struct World {
    f: Fixture,
    now: i64,
    mode: SettlementMode,
    owner: Pubkey,
    custodian: Pubkey,
    transporter: Pubkey,
    buyer: Pubkey,
    terminal: Pubkey,
    issuer: Pubkey,
    lender: Pubkey,
    class_policy: Pubkey,
    source: Pubkey,
    destination: Pubkey,
    lot: Pubkey,
    position: Pubkey,
    /// Kopano's departure document for CR-0001, version 1.
    document: Pubkey,
    /// Every lot the world issued, for the invariants.
    lots: Vec<Pubkey>,
    /// Every shipment the world prepared, for the invariants.
    shipments: Vec<Pubkey>,
    /// Every CustodianClass the world accredited, for the invariants.
    classes: Vec<Pubkey>,
    facility: Pubkey,
    valuation: Pubkey,
    loan: Pubkey,
    lock: Pubkey,
    pool: Pubkey,
    pool_authority: Pubkey,
    pool_vault: Pubkey,
}

impl World {
    fn demo() -> Self {
        Self::new(SettlementMode::FiatAttestationTest)
    }

    fn new(mode: SettlementMode) -> Self {
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
        let issuer = f.add_org(ISSUER_ID, Role::DocumentIssuer);
        let lender = accredit(&mut f, LENDER_ID, Role::Lender, LENDER_NAME);

        let source_site = f.accredit_site(
            Accreditor,
            custodian,
            class_policy,
            SOURCE_SITE,
            SOURCE_CAPACITY,
        );
        f.ok(source_site, Accreditor);
        let destination_site = f.accredit_site(
            Accreditor,
            terminal,
            class_policy,
            DESTINATION_SITE,
            DESTINATION_CAPACITY,
        );
        f.ok(destination_site, Accreditor);
        let source = f.site(custodian, class_policy, SOURCE_SITE);
        let destination = f.site(terminal, class_policy, DESTINATION_SITE);

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
                scope::ISSUE | scope::REDEEM | scope::ATTEST_TRANSPORT,
            ),
            (terminal, Custodian2, scope::ATTEST_TRANSPORT),
            (buyer, Buyer, scope::TRANSFER | scope::BUY | scope::SHIP),
            (issuer, Issuer, scope::ATTEST_ORIGIN),
            (issuer, Issuer2, scope::ATTEST_TRANSPORT),
            (lender, Lender, scope::LEND | scope::POOL),
        ] {
            let delegate = f.delegate(OrgAdmin, org, f.key(wallet), scopes, expires_at);
            f.ok(delegate, OrgAdmin);
        }

        let protocol = f.protocol;
        let lot = pda(&[b"lot", protocol.as_ref(), LOT_ID.as_bytes()]);
        let pool = pda(&[b"pool", protocol.as_ref()]);
        let pool_authority = pda(&[b"pool_authority", pool.as_ref()]);
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
            mode,
            owner,
            custodian,
            transporter,
            buyer,
            terminal,
            issuer,
            lender,
            class_policy,
            source,
            destination,
            lot,
            position: pda(&[b"position", lot.as_ref(), owner.as_ref()]),
            document: Pubkey::default(),
            lots: Vec::new(),
            shipments: Vec::new(),
            classes: vec![source, destination],
            facility,
            valuation: Pubkey::default(),
            loan,
            lock: pda(&[b"lock", loan.as_ref()]),
            pool,
            pool_authority,
            pool_vault: get_associated_token_address_with_program_id(
                &pool_authority,
                &POOL_MINT,
                &SPL_TOKEN,
            ),
        };
        world.issue_lot(LOT_ID, &INTAKE_DIGEST);
        world.document = world.attest_departure(Custodian, custodian, lot, 1, DEPARTURE_SHA);
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

    fn lot_key(&self, lot_id: &str) -> Pubkey {
        pda(&[b"lot", self.f.protocol.as_ref(), lot_id.as_bytes()])
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

    fn intake(&self, digest: &[u8; 32]) -> Pubkey {
        pda(&[
            b"intake",
            self.f.protocol.as_ref(),
            self.custodian.as_ref(),
            digest,
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

    /// Issues `lot_id` (5,000 t, grade A) at the source to Khunou Ore Exports.
    fn issue_lot(&mut self, lot_id: &str, intake_digest: &[u8; 32]) -> Pubkey {
        let valid_until = self.now + CUSTODY_WINDOW;
        let lot = self.lot_key(lot_id);
        let position = Self::position_key(lot, self.owner);
        let mint = Self::mint(lot);
        let text = issue_message(
            &ID,
            &INSTANCE,
            lot_id,
            CLASS_CODE,
            1,
            GRADES[0],
            LOT_KG,
            OWNER_NAME,
            CUSTODIAN_NAME,
            SOURCE_SITE,
            intake_digest,
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
                intake: self.intake(intake_digest),
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
                lot_id: lot_id.into(),
                grade: GRADES[0].into(),
                quantity_kg: LOT_KG,
                intake_digest: *intake_digest,
                valid_until,
            },
        );
        self.f.sponsored_ok(&[verify, issue]);
        let stored: Lot = self.f.read(lot);
        assert_eq!(stored.state, LotState::Stored);
        assert_eq!(stored.restriction, Restriction::Normal);
        assert_eq!(stored.custodian_class, self.source);
        self.lots.push(lot);
        lot
    }

    /// A real `attest_document` of kind `Departure` for `lot`, by `signer` for `org`.
    fn attest_departure(
        &mut self,
        signer: Actor,
        org: Pubkey,
        lot: Pubkey,
        version: u32,
        sha256: [u8; 32],
    ) -> Pubkey {
        self.attest_kind(
            signer,
            org,
            DocumentKind::Departure,
            lot.to_bytes(),
            version,
            sha256,
            self.now + DOCUMENT_VALIDITY,
        )
    }

    #[allow(clippy::too_many_arguments)]
    fn attest_kind(
        &mut self,
        signer: Actor,
        org: Pubkey,
        kind: DocumentKind,
        subject: [u8; 32],
        version: u32,
        sha256: [u8; 32],
        valid_until: i64,
    ) -> Pubkey {
        let attest = self
            .f
            .attest(signer, org, kind, subject, version, sha256, valid_until);
        let tx = self.f.ok(attest, signer);
        let document = self.f.document(kind, subject, version);
        assert_event(
            &tx,
            events::DocumentAttested {
                document,
                kind,
                subject,
                version,
            },
        );
        let stored: DocumentAttestation = self.f.read(document);
        assert_eq!(stored.kind, kind);
        assert_eq!(stored.issuer, org);
        assert_eq!(stored.sha256, sha256);
        document
    }

    // ------------------------------------------------------------ manifests ----

    /// A manifest whose batches carry `quantities` in index order, all carried by Mosela
    /// Haulage, with load digests `load_base + index` and manifest digests `0x44 + index`.
    fn manifest(&self, quantities: &[u64], load_base: u8) -> Manifest {
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
                        load_digest: [load_base + index; 32],
                        manifest_digest: [0x44 + index; 32],
                    }
                })
                .collect(),
        )
    }

    /// M1's shape: one 5,000 t batch.
    fn demo_manifest(&self) -> Manifest {
        self.manifest(&[LOT_KG], 0x33)
    }

    // ------------------------------------------------------------- prepare ----

    fn prepare_args(&self, manifest: &Manifest) -> PrepareArgs {
        PrepareArgs {
            shipment_id: SHIPMENT_ONE,
            batch_count: manifest.batch_count(),
            manifest_root: manifest.root,
            expected_revision: self.lot_state().revision,
            valid_until: self.now + CUSTODY_WINDOW,
            signer: Owner,
            owner_org: self.owner,
            lot: self.lot,
            position: self.position,
            source: self.source,
            destination: self.destination,
            destination_org: self.terminal,
            document: self.document,
            issuer: self.custodian,
        }
    }

    /// The "Prepare shipment" text the program rebuilds from the accounts and the arguments.
    fn prepare_text(&self, args: &PrepareArgs) -> Vec<u8> {
        let lot: Lot = self.f.read(args.lot);
        let destination: CustodianClass = self.f.read(args.destination);
        let document: DocumentAttestation = self.f.read(args.document);
        prepare_shipment_message(
            &ID,
            &INSTANCE,
            &lot.lot_id,
            &args.shipment_id,
            lot.supply_kg,
            &self.name(args.owner_org),
            &self.name(args.destination_org),
            &destination.site_code,
            args.batch_count,
            &args.manifest_root,
            (&document.sha256, document.version),
            args.expected_revision,
            args.valid_until,
        )
    }

    fn prepare_instruction(&self, args: &PrepareArgs) -> Instruction {
        ix(
            accounts::PrepareShipment {
                sponsor: self.f.payer(),
                protocol: self.f.protocol,
                owner_org: args.owner_org,
                owner_authority: self.authority_of(args.signer),
                lot: args.lot,
                position: args.position,
                source_class: args.source,
                destination_class: args.destination,
                destination_org: args.destination_org,
                departure_document: args.document,
                departure_issuer: args.issuer,
                shipment: shipment_key(self.f.protocol, &args.shipment_id),
                instructions: INSTRUCTIONS_SYSVAR,
                system_program: SYSTEM,
            },
            instruction::PrepareShipment {
                shipment_id: args.shipment_id,
                batch_count: args.batch_count,
                manifest_root: args.manifest_root,
                expected_revision: args.expected_revision,
                valid_until: args.valid_until,
            },
        )
    }

    fn prepare_signed(&self, args: &PrepareArgs, text: &[u8]) -> [Instruction; 2] {
        [
            ed25519_instruction(&[(self.f.signer(args.signer), text)]),
            self.prepare_instruction(args),
        ]
    }

    fn prepare(&self, args: &PrepareArgs) -> [Instruction; 2] {
        self.prepare_signed(args, &self.prepare_text(args))
    }

    /// Sends the prepare and checks every effect, the event and the invariants.
    fn prepare_ok(&mut self, args: &PrepareArgs) -> Pubkey {
        let shipment = shipment_key(self.f.protocol, &args.shipment_id);
        let lot_before: Lot = self.f.read(args.lot);
        let position_before: Position = self.f.read(args.position);
        let destination_before = self.class_state(args.destination);
        let untouched = self.snapshot(&[
            args.source,
            args.document,
            args.issuer,
            args.owner_org,
            args.destination_org,
            self.authority_of(args.signer),
            Self::vault(args.lot, args.position),
            Self::mint(args.lot),
        ]);
        let instructions = self.prepare(args);
        let tx = self.f.sponsored_ok(&instructions);

        let source: CustodianClass = self.f.read(args.source);
        let destination = self.class_state(args.destination);
        let expected = Shipment {
            protocol: self.f.protocol,
            shipment_id: args.shipment_id,
            lot: args.lot,
            position: args.position,
            owner: args.owner_org,
            source: args.source,
            source_custodian: source.custodian,
            destination: args.destination,
            destination_custodian: destination.custodian,
            committed_kg: lot_before.supply_kg,
            locked_kg: position_before.locked_kg,
            batch_count: args.batch_count,
            manifest_root: args.manifest_root,
            departure_document: args.document,
            registered_count: 0,
            registered_kg: 0,
            departed_count: 0,
            departed_kg: 0,
            arrived_count: 0,
            arrived_kg: 0,
            status: ShipmentStatus::Prepared,
            prepared_at: self.now,
            revision: 0,
            bump: bump_of(&[b"shipment", self.f.protocol.as_ref(), &args.shipment_id]),
        };
        assert_same(&self.f.read::<Shipment>(shipment), &expected);
        assert_eq!(
            self.f.owner_and_data_len(shipment),
            Some((ID, SHIPMENT_SPACE))
        );

        let mut expected_destination = destination_before.clone();
        expected_destination.reserved_inbound_kg += lot_before.supply_kg;
        assert_same(&destination, &expected_destination);

        let mut expected_lot = lot_before.clone();
        expected_lot.state = LotState::Prepared;
        expected_lot.revision += 1;
        assert_same(&self.f.read::<Lot>(args.lot), &expected_lot);

        let mut expected_position = position_before.clone();
        expected_position.revision += 1;
        assert_same(&self.f.read::<Position>(args.position), &expected_position);
        self.assert_unchanged(&untouched);

        assert_event(
            &tx,
            events::ShipmentPrepared {
                shipment,
                lot: args.lot,
                owner: args.owner_org,
                source: args.source,
                destination: args.destination,
                committed_kg: lot_before.supply_kg,
                locked_kg: position_before.locked_kg,
                batch_count: args.batch_count,
                manifest_root: args.manifest_root,
                departure_document: args.document,
                lot_revision: expected_lot.revision,
                position_revision: expected_position.revision,
            },
        );
        self.shipments.push(shipment);
        self.assert_invariants();
        shipment
    }

    fn prepare_refused(&mut self, args: &PrepareArgs, expected: ThetisError) {
        let instructions = self.prepare(args);
        self.f.sponsored_refused(&instructions, 1, expected);
        assert!(!self
            .f
            .account_exists(shipment_key(self.f.protocol, &args.shipment_id)));
    }

    /// The demo prepare: CR-0001 with M1's shape to Port Terminal T1.
    fn prepare_demo(&mut self) -> (Pubkey, Manifest) {
        let manifest = self.demo_manifest();
        let args = self.prepare_args(&manifest);
        (self.prepare_ok(&args), manifest)
    }

    // ------------------------------------------------------------- register ----

    fn register_instruction(
        &self,
        shipment: Pubkey,
        leaf: &Leaf,
        proof: &[[u8; 32]; 4],
    ) -> Instruction {
        ix(
            accounts::RegisterBatch {
                payer: self.f.payer(),
                protocol: self.f.protocol,
                shipment,
                batch: batch_key(self.f.protocol, &leaf.load_digest),
                system_program: SYSTEM,
            },
            instruction::RegisterBatch {
                index: leaf.index,
                quantity_kg: leaf.quantity_kg,
                carrier: leaf.carrier,
                load_digest: leaf.load_digest,
                manifest_digest: leaf.manifest_digest,
                proof: *proof,
            },
        )
    }

    /// Registers leaf `index` of `manifest` and checks the batch, the shipment counters, the
    /// event and the invariants.
    fn register_ok(&mut self, shipment: Pubkey, manifest: &Manifest, index: usize) -> Pubkey {
        let leaf = &manifest.leaves[index];
        let batch = batch_key(self.f.protocol, &leaf.load_digest);
        let before: Shipment = self.f.read(shipment);
        let untouched = self.snapshot(&[before.lot, before.source, before.destination]);
        let register = self.register_instruction(shipment, leaf, &manifest.proofs[index]);
        let tx = self.f.sponsored_ok(&[register]);

        let expected_batch = ManifestBatch {
            protocol: self.f.protocol,
            shipment,
            lot: before.lot,
            index: leaf.index,
            batch_count: before.batch_count,
            quantity_kg: leaf.quantity_kg,
            carrier: leaf.carrier,
            load_digest: leaf.load_digest,
            manifest_digest: leaf.manifest_digest,
            holder: before.source_custodian,
            stage: BatchStage::AtSource,
            sequence: 0,
            observation_count: 0,
            departed_at: None,
            arrived_at: None,
            bump: bump_of(&[b"batch", self.f.protocol.as_ref(), &leaf.load_digest]),
        };
        assert_same(&self.f.read::<ManifestBatch>(batch), &expected_batch);
        assert_eq!(self.f.owner_and_data_len(batch), Some((ID, BATCH_SPACE)));

        let mut expected = before.clone();
        expected.registered_count += 1;
        expected.registered_kg += leaf.quantity_kg;
        assert_same(&self.f.read::<Shipment>(shipment), &expected);
        self.assert_unchanged(&untouched);
        assert_event(
            &tx,
            events::BatchRegistered {
                batch,
                shipment,
                index: leaf.index,
                quantity_kg: leaf.quantity_kg,
                carrier: leaf.carrier,
                load_digest: leaf.load_digest,
                manifest_digest: leaf.manifest_digest,
                registered_count: expected.registered_count,
            },
        );
        self.assert_invariants();
        batch
    }

    fn register_refused(&mut self, register: Instruction, expected: ThetisError) {
        self.f.sponsored_refused(&[register], 0, expected);
    }

    // --------------------------------------------------------------- cancel ----

    fn cancel_args(&self, shipment: Pubkey) -> CancelArgs {
        let stored: Shipment = self.f.read(shipment);
        CancelArgs {
            shipment,
            expected_revision: stored.revision,
            valid_until: self.now + CUSTODY_WINDOW,
            signer: Owner,
            owner_org: stored.owner,
            lot: stored.lot,
            destination: stored.destination,
            destination_org: stored.destination_custodian,
        }
    }

    fn cancel_text(&self, args: &CancelArgs) -> Vec<u8> {
        let lot: Lot = self.f.read(args.lot);
        let shipment: Shipment = self.f.read(args.shipment);
        let destination: CustodianClass = self.f.read(args.destination);
        cancel_shipment_message(
            &ID,
            &INSTANCE,
            &lot.lot_id,
            &shipment.shipment_id,
            &self.name(args.owner_org),
            &self.name(args.destination_org),
            &destination.site_code,
            args.expected_revision,
            args.valid_until,
        )
    }

    fn cancel_instruction(&self, args: &CancelArgs) -> Instruction {
        ix(
            accounts::CancelShipment {
                sponsor: self.f.payer(),
                protocol: self.f.protocol,
                owner_org: args.owner_org,
                owner_authority: self.authority_of(args.signer),
                lot: args.lot,
                shipment: args.shipment,
                destination_class: args.destination,
                destination_org: args.destination_org,
                instructions: INSTRUCTIONS_SYSVAR,
            },
            instruction::CancelShipment {
                expected_revision: args.expected_revision,
                valid_until: args.valid_until,
            },
        )
    }

    fn cancel_signed(&self, args: &CancelArgs, text: &[u8]) -> [Instruction; 2] {
        [
            ed25519_instruction(&[(self.f.signer(args.signer), text)]),
            self.cancel_instruction(args),
        ]
    }

    fn cancel(&self, args: &CancelArgs) -> [Instruction; 2] {
        self.cancel_signed(args, &self.cancel_text(args))
    }

    /// Cancels `shipment` and checks every effect, the event and the invariants.
    fn cancel_ok(&mut self, shipment: Pubkey) {
        let args = self.cancel_args(shipment);
        let before: Shipment = self.f.read(shipment);
        let lot_before: Lot = self.f.read(args.lot);
        let destination_before = self.class_state(args.destination);
        let untouched = self.snapshot(&[
            before.position,
            before.source,
            args.owner_org,
            args.destination_org,
            self.authority_of(args.signer),
        ]);
        let instructions = self.cancel(&args);
        let tx = self.f.sponsored_ok(&instructions);

        let mut expected = before.clone();
        expected.status = ShipmentStatus::Cancelled;
        expected.revision += 1;
        assert_same(&self.f.read::<Shipment>(shipment), &expected);
        let mut expected_lot = lot_before.clone();
        expected_lot.state = LotState::Stored;
        expected_lot.revision += 1;
        assert_same(&self.f.read::<Lot>(args.lot), &expected_lot);
        let mut expected_destination = destination_before.clone();
        expected_destination.reserved_inbound_kg -= before.committed_kg;
        assert_same(&self.class_state(args.destination), &expected_destination);
        self.assert_unchanged(&untouched);
        assert_event(
            &tx,
            events::ShipmentCancelled {
                shipment,
                lot: args.lot,
                released_kg: before.committed_kg,
                lot_revision: expected_lot.revision,
                revision: expected.revision,
            },
        );
        self.assert_invariants();
    }

    fn cancel_refused(&mut self, args: &CancelArgs, expected: ThetisError) {
        let instructions = self.cancel(args);
        self.f.sponsored_refused(&instructions, 1, expected);
    }

    // -------------------------------------------------- Phase 1 instructions ----

    /// A `transfer` of `quantity_kg` from the owner's position to Buyer Smelter Co, signed at
    /// the owner position's current revision.
    fn transfer_instructions(&self, quantity_kg: u64) -> [Instruction; 2] {
        let revision = self.position_state().revision;
        self.transfer_at(quantity_kg, revision, self.now + CUSTODY_WINDOW)
    }

    fn transfer_at(&self, quantity_kg: u64, revision: u64, valid_until: i64) -> [Instruction; 2] {
        let text = transfer_message(
            &ID,
            &INSTANCE,
            LOT_ID,
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

    /// A `split` of 2,000 t into CR-0001-A, signed at the lot's current revision.
    fn split_instructions(&self) -> [Instruction; 2] {
        let child_id = "CR-0001-A";
        let revision = self.lot_state().revision;
        let valid_until = self.now + CUSTODY_WINDOW;
        let text = split_message(
            &ID,
            &INSTANCE,
            LOT_ID,
            child_id,
            TWO_THOUSAND_T,
            OWNER_NAME,
            CUSTODIAN_NAME,
            revision,
            valid_until,
        );
        let child_lot = self.lot_key(child_id);
        let child_mint = Self::mint(child_lot);
        let child_position = Self::position_key(child_lot, self.owner);
        let split = ix(
            accounts::Split {
                sponsor: self.f.payer(),
                protocol: self.f.protocol,
                owner_authority: self.authority_of(Owner),
                custodian_authority: self.authority_of(Custodian),
                lot: self.lot,
                root: None,
                class_policy: self.class_policy,
                custodian_class: self.source,
                owner: self.owner,
                custodian: self.custodian,
                mint: Self::mint(self.lot),
                position: self.position,
                vault_authority: Self::vault_authority(self.position),
                vault: Self::vault(self.lot, self.position),
                child_lot,
                child_mint,
                child_mint_authority: pda(&[b"mint_authority", child_mint.as_ref()]),
                child_position,
                child_vault_authority: Self::vault_authority(child_position),
                child_vault: Self::vault(child_lot, child_position),
                instructions: INSTRUCTIONS_SYSVAR,
                token_program: TOKEN_2022,
                associated_token_program: ASSOCIATED_TOKEN,
                system_program: SYSTEM,
            },
            instruction::Split {
                child_lot_id: child_id.into(),
                quantity_kg: TWO_THOUSAND_T,
                expected_revision: revision,
                valid_until,
            },
        );
        let signers = [self.f.signer(Owner), self.f.signer(Custodian)];
        [ed25519_shared_instruction(&signers, &text), split]
    }

    /// A `redeem` of 2,000 t at the source, signed at the position's current revision.
    fn redeem_instructions(&self) -> [Instruction; 2] {
        let revision = self.position_state().revision;
        let valid_until = self.now + CUSTODY_WINDOW;
        let text = redeem_message(
            &ID,
            &INSTANCE,
            LOT_ID,
            TWO_THOUSAND_T,
            OWNER_NAME,
            CUSTODIAN_NAME,
            &COLLECTION_TICKET,
            revision,
            valid_until,
        );
        let redeem = ix(
            accounts::Redeem {
                sponsor: self.f.payer(),
                protocol: self.f.protocol,
                owner_authority: self.authority_of(Owner),
                custodian_authority: self.authority_of(Custodian),
                owner: self.owner,
                custodian: self.custodian,
                custodian_class: self.source,
                lot: self.lot,
                root: None,
                intake: self.intake(&INTAKE_DIGEST),
                mint: Self::mint(self.lot),
                position: self.position,
                vault_authority: Self::vault_authority(self.position),
                vault: Self::vault(self.lot, self.position),
                instructions: INSTRUCTIONS_SYSVAR,
                token_program: TOKEN_2022,
            },
            instruction::Redeem {
                quantity_kg: TWO_THOUSAND_T,
                collection_ticket: COLLECTION_TICKET,
                expected_revision: revision,
                valid_until,
            },
        );
        let signers = [self.f.signer(Owner), self.f.signer(Custodian)];
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
            SettlementMode::FiatAttestationTest => 20,
            SettlementMode::DevnetTokenSimulation => 200_000,
        }
    }

    /// USD600,000 at the mode's decimals.
    fn six_hundred_k(&self) -> u64 {
        600_000 * 10_u64.pow(u32::from(self.decimals()))
    }

    /// USD400,000 at the mode's decimals.
    fn four_hundred_k(&self) -> u64 {
        400_000 * 10_u64.pow(u32::from(self.decimals()))
    }

    /// Lender One Bank's facility to Khunou Ore Exports (with the simulation pool and USD700,000
    /// deposited in simulation mode), its 20 c/kg valuation of the source site, and a pledge of
    /// `quantity_kg` as loan 0.
    fn open_lending(&mut self, quantity_kg: u64) {
        if self.mode == SettlementMode::DevnetTokenSimulation {
            self.open_pool_and_deposit();
        }
        let open = ix(
            accounts::OpenFacility {
                lender: self.f.key(Lender),
                payer: self.f.payer(),
                protocol: self.f.protocol,
                authority: self.authority_of(Lender),
                lender_org: self.lender,
                borrower_org: self.owner,
                facility: self.facility,
                pool: (self.mode == SettlementMode::DevnetTokenSimulation).then_some(self.pool),
                system_program: SYSTEM,
            },
            instruction::OpenFacility {
                facility_id: FACILITY_ONE,
                currency: USD,
                currency_decimals: self.decimals(),
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
                value_per_kg: self.value_per_kg(),
                haircut_bps: 0,
                valid_until: NOW + VALUATION_VALIDITY,
                source_digest: SOURCE_DIGEST,
            },
        );
        self.f.signed_ok(&[set], Lender);
        let pledge = self.pledge_instructions(0, quantity_kg);
        self.f.sponsored_ok(&pledge);
        let lock: LockAllocation = self.f.read(self.lock);
        assert_eq!(lock.quantity_kg, quantity_kg);
        self.assert_invariants();
    }

    /// A PS×2 pledge of `quantity_kg` as loan `loan_index`, at the position's current revision.
    fn pledge_instructions(&self, loan_index: u32, quantity_kg: u64) -> [Instruction; 2] {
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
            loan_index,
            &USD,
            RATE_BPS,
            MAX_LTV_BPS,
            1,
            revision,
            valid_until,
        );
        let loan = pda(&[b"loan", self.facility.as_ref(), &loan_index.to_le_bytes()]);
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
                loan,
                lock: pda(&[b"lock", loan.as_ref()]),
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
        let signers = [self.f.signer(Owner), self.f.signer(Lender)];
        [ed25519_shared_instruction(&signers, &text), pledge]
    }

    /// A release intent (nonce 1) for 2,000 t to Buyer Smelter Co at USD400,000, signed at the
    /// position's current revision.
    fn release_intent_instructions(&self) -> [Instruction; 2] {
        let revision = self.position_state().revision;
        let valid_until = self.now + MONEY_WINDOW;
        let expires_at = self.now + DAY;
        let price = self.four_hundred_k();
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
            1,
            price,
            0,
            &USD,
            self.decimals(),
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
                intent: pda(&[b"release", self.loan.as_ref(), &1_u64.to_le_bytes()]),
                instructions: INSTRUCTIONS_SYSVAR,
                system_program: SYSTEM,
            },
            instruction::CreateReleaseIntent {
                nonce: 1,
                quantity_kg: TWO_THOUSAND_T,
                price,
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

    /// A fiat-mode `record_advance` of USD600,000 on loan 0, at the loan's current revision.
    fn advance_instructions(&self) -> [Instruction; 2] {
        let loan: Loan = self.f.read(self.loan);
        let amount = self.six_hundred_k();
        let valid_until = self.now + MONEY_WINDOW;
        let text = advance_message(
            &ID,
            &INSTANCE,
            LOT_ID,
            OWNER_NAME,
            LENDER_NAME,
            &FACILITY_ONE,
            loan.index,
            amount,
            loan.principal + amount,
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
                amount,
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

    // ------------------------------------------------------ simulation pool ----

    fn ata(&self, actor: Actor) -> Pubkey {
        get_associated_token_address_with_program_id(&self.f.key(actor), &POOL_MINT, &SPL_TOKEN)
    }

    /// The admin opens the pool on a harness-written SPL mint; Lender One Bank deposits
    /// USD700,000; the owner gets an empty ATA to borrow into.
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
                depositor_org: self.lender,
                pool: self.pool,
                share: pda(&[b"pool_share", self.pool.as_ref(), self.lender.as_ref()]),
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

    /// A simulation-mode `borrow` of USD600,000 on loan 0 into the owner's ATA.
    fn borrow_instructions(&self) -> [Instruction; 2] {
        let loan: Loan = self.f.read(self.loan);
        let amount = self.six_hundred_k();
        let valid_until = self.now + MONEY_WINDOW;
        let destination = self.ata(Owner);
        let text = borrow_message(
            &ID,
            &INSTANCE,
            LOT_ID,
            OWNER_NAME,
            LENDER_NAME,
            &FACILITY_ONE,
            loan.index,
            amount,
            loan.principal + amount,
            &USD,
            MICRO,
            &destination,
            RATE_BPS,
            loan.revision,
            valid_until,
        );
        let borrow = ix(
            accounts::Borrow {
                sponsor: self.f.payer(),
                protocol: self.f.protocol,
                borrower_org: self.owner,
                borrower_authority: self.authority_of(Owner),
                lender_org: self.lender,
                facility: self.facility,
                loan: self.loan,
                lock: self.lock,
                lot: self.lot,
                valuation: self.valuation,
                pool: self.pool,
                lender_share: pda(&[b"pool_share", self.pool.as_ref(), self.lender.as_ref()]),
                pool_authority: self.pool_authority,
                pool_vault: self.pool_vault,
                mint: POOL_MINT,
                destination,
                token_program: SPL_TOKEN,
                instructions: INSTRUCTIONS_SYSVAR,
            },
            instruction::Borrow {
                amount,
                expected_revision: loan.revision,
                valid_until,
            },
        );
        [
            ed25519_instruction(&[(self.f.signer(Owner), text.as_slice())]),
            borrow,
        ]
    }

    // ------------------------------------------------------------ invariants ----

    /// Writes `restriction` into the lot's account (the harness route until the restriction instructions exist, §9).
    fn set_restriction(&mut self, lot: Pubkey, restriction: Restriction) {
        let mut stored: Lot = self.f.read(lot);
        stored.restriction = restriction;
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

    /// §3 invariants over every lot, shipment and class the world made: supply equals the sum
    /// of positions and each vault holds its position; each class's occupancy and reservation
    /// equal its ordinary stock plus the contributions of every open shipment touching it, within
    /// capacity; a lot is `Prepared` or `InTransit` exactly while it has one open shipment; and
    /// every position's `reserved_kg` stays 0.
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
        for shipment in &open {
            assert!(shipment.registered_kg <= shipment.committed_kg);
            assert!(shipment.registered_count <= shipment.batch_count);
            assert!(shipment.departed_count <= shipment.registered_count);
            assert!(shipment.arrived_count <= shipment.departed_count);
            assert!(shipment.arrived_kg <= shipment.departed_kg);
            assert!(shipment.departed_kg <= shipment.registered_kg);
        }
        for lot_key in &self.lots {
            let lot: Lot = self.f.read(*lot_key);
            let mut positions = vec![Self::position_key(*lot_key, self.owner)];
            positions.push(Self::position_key(*lot_key, self.buyer));
            let mut total = 0;
            for position_key in positions {
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
            let class: CustodianClass = self.f.read(*class_key);
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

// ============================================================ prepare_shipment ====

#[test]
fn prepare_shipment_demo_reserves_destination_and_marks_prepared() {
    let mut w = World::demo();
    let (shipment, manifest) = w.prepare_demo();
    let stored: Shipment = w.f.read(shipment);
    assert_eq!(stored.committed_kg, LOT_KG);
    assert_eq!(stored.batch_count, 1);
    assert_eq!(stored.manifest_root, manifest.root);
    assert_eq!(stored.source_custodian, w.custodian);
    assert_eq!(stored.destination_custodian, w.terminal);
    assert_eq!(w.class_state(w.destination).reserved_inbound_kg, LOT_KG);
    // The source keeps the lot's occupancy until a batch departs.
    assert_eq!(w.class_state(w.source).occupied_kg, LOT_KG);
    assert_eq!(w.lot_state().state, LotState::Prepared);
}

#[test]
fn prepare_shipment_exactly_at_capacity_succeeds() {
    let mut w = World::demo();
    let destination = w.class_state(w.destination);
    assert_eq!(destination.approved_capacity_kg, LOT_KG);
    assert_eq!(destination.occupied_kg + destination.reserved_inbound_kg, 0);
    w.prepare_demo();
    let destination = w.class_state(w.destination);
    assert_eq!(
        destination.occupied_kg + destination.reserved_inbound_kg,
        destination.approved_capacity_kg
    );
}

#[test]
fn prepare_shipment_rejects_concurrent_overbooking() {
    let mut w = World::demo();
    let second_lot = w.issue_lot(SECOND_LOT_ID, &SECOND_INTAKE_DIGEST);
    let second_document = w.attest_departure(Custodian, w.custodian, second_lot, 1, DEPARTURE_SHA);
    w.assert_invariants();
    w.prepare_demo();

    let manifest = w.manifest(&[LOT_KG], 0x60);
    let mut args = w.prepare_args(&manifest);
    args.shipment_id = SHIPMENT_TWO;
    args.lot = second_lot;
    args.position = World::position_key(second_lot, w.owner);
    args.document = second_document;
    args.expected_revision = w.f.read::<Lot>(second_lot).revision;
    w.prepare_refused(&args, OverCapacity);
    // The first reservation is intact and the second lot still stored.
    assert_eq!(w.class_state(w.destination).reserved_inbound_kg, LOT_KG);
    assert_eq!(w.f.read::<Lot>(second_lot).state, LotState::Stored);

    // Once the first shipment is cancelled, the destination has room again.
    let first = w.shipments[0];
    w.cancel_ok(first);
    w.prepare_ok(&args);
}

#[test]
fn prepare_shipment_rejects_lot_not_stored() {
    let mut w = World::demo();
    w.prepare_demo();
    let manifest = w.manifest(&[LOT_KG], 0x60);
    let mut args = w.prepare_args(&manifest);
    args.shipment_id = SHIPMENT_TWO;
    assert_eq!(args.expected_revision, w.lot_state().revision);
    w.prepare_refused(&args, LotNotStored);
}

#[test]
fn prepare_shipment_rejects_restricted_lot() {
    let mut w = World::demo();
    let manifest = w.demo_manifest();
    let args = w.prepare_args(&manifest);
    for restriction in [
        Restriction::ReviewRequired,
        Restriction::Disputed,
        Restriction::Frozen,
    ] {
        let lot = w.lot;
        w.set_restriction(lot, restriction);
        w.prepare_refused(&args, Restricted);
    }
    let lot = w.lot;
    w.set_restriction(lot, Restriction::Normal);
    w.prepare_ok(&args);
}

#[test]
fn prepare_shipment_rejects_not_sole_holder() {
    let mut w = World::demo();
    let transfer = w.transfer_instructions(TWO_THOUSAND_T);
    w.f.sponsored_ok(&transfer);
    w.assert_invariants();
    assert_eq!(w.position_state().quantity_kg, THREE_THOUSAND_T);
    let manifest = w.demo_manifest();
    let args = w.prepare_args(&manifest);
    w.prepare_refused(&args, NotSoleHolder);
}

#[test]
fn prepare_shipment_rejects_wrong_owner() {
    let mut w = World::demo();
    let manifest = w.demo_manifest();
    // Buyer Smelter Co holds SHIP, but the position is Khunou Ore Exports'.
    let mut args = w.prepare_args(&manifest);
    args.signer = Buyer;
    args.owner_org = w.buyer;
    w.prepare_refused(&args, WrongOrganisation);
    // The owner's organisation with the buyer's Authority is the same fault.
    let mut args = w.prepare_args(&manifest);
    args.signer = Buyer;
    w.prepare_refused(&args, WrongOrganisation);
}

#[test]
fn prepare_shipment_rejects_same_site() {
    let mut w = World::demo();
    let manifest = w.demo_manifest();
    let mut args = w.prepare_args(&manifest);
    args.destination = w.source;
    args.destination_org = w.custodian;
    w.prepare_refused(&args, InvalidField);
}

#[test]
fn prepare_shipment_rejects_destination_of_other_class() {
    let mut w = World::demo();
    let register = w.f.register_with_origin(
        Accreditor,
        OTHER_CLASS_CODE,
        1,
        &GRADES,
        LOT_VALIDITY,
        false,
    );
    w.f.ok(register, Accreditor);
    let other_class = w.f.class(OTHER_CLASS_CODE, 1);
    let site = w.f.accredit_site(
        Accreditor,
        w.terminal,
        other_class,
        DESTINATION_SITE,
        DESTINATION_CAPACITY,
    );
    w.f.ok(site, Accreditor);
    let other_site = w.f.site(w.terminal, other_class, DESTINATION_SITE);
    w.classes.push(other_site);
    let manifest = w.demo_manifest();
    let mut args = w.prepare_args(&manifest);
    args.destination = other_site;
    w.prepare_refused(&args, DestinationNotEligible);
}

#[test]
fn prepare_shipment_rejects_related_destination() {
    let mut w = World::demo();
    let relate = w.f.relationship(Accreditor, w.owner, w.terminal);
    w.f.ok(relate, Accreditor);
    let manifest = w.demo_manifest();
    let args = w.prepare_args(&manifest);
    w.prepare_refused(&args, RelatedCustodian);
}

#[test]
fn prepare_shipment_rejects_bad_batch_count_or_root() {
    let mut w = World::demo();
    let manifest = w.demo_manifest();
    for batch_count in [0, 17] {
        let mut args = w.prepare_args(&manifest);
        args.batch_count = batch_count;
        w.prepare_refused(&args, InvalidField);
    }
    let mut args = w.prepare_args(&manifest);
    args.manifest_root = [0; 32];
    w.prepare_refused(&args, InvalidField);
    // The bounds themselves are accepted: 16 batches.
    let mut args = w.prepare_args(&manifest);
    args.batch_count = 16;
    w.prepare_ok(&args);
}

#[test]
fn prepare_shipment_rejects_invalid_departure_document() {
    let mut w = World::demo();
    let manifest = w.demo_manifest();
    let lot = w.lot;
    let custodian = w.custodian;

    // Revoked.
    let revoked = w.attest_departure(Custodian, custodian, lot, 2, DEPARTURE_SHA);
    let revoke = w.f.revoke_document(Custodian, custodian, revoked);
    w.f.ok(revoke, Custodian);
    // Another lot's subject.
    let other_lot = w.lot_key(SECOND_LOT_ID);
    let other_subject = w.attest_departure(Custodian, custodian, other_lot, 1, DEPARTURE_SHA);
    // Kind Origin, by a DocumentIssuer, for this lot.
    let issuer = w.issuer;
    let origin = w.attest_kind(
        Issuer,
        issuer,
        DocumentKind::Origin,
        lot.to_bytes(),
        1,
        DEPARTURE_SHA,
        NOW + DOCUMENT_VALIDITY,
    );
    // An all-zero hash.
    let zero_hash = w.attest_departure(Custodian, custodian, lot, 3, [0; 32]);
    // Issued by the destination's terminal, which is neither a DocumentIssuer nor the source.
    let terminal = w.terminal;
    let by_destination = w.attest_departure(Custodian2, terminal, lot, 4, DEPARTURE_SHA);
    // Valid for one minute only; expired below.
    let short = w.attest_kind(
        Custodian,
        custodian,
        DocumentKind::Departure,
        lot.to_bytes(),
        5,
        DEPARTURE_SHA,
        NOW + 60,
    );

    for (document, issuer) in [
        (revoked, custodian),
        (other_subject, custodian),
        (origin, issuer),
        (zero_hash, custodian),
        // The valid document with an issuer account that is not the document's issuer.
        (w.document, issuer),
        (by_destination, terminal),
    ] {
        let mut args = w.prepare_args(&manifest);
        args.document = document;
        args.issuer = issuer;
        w.prepare_refused(&args, DepartureDocumentInvalid);
    }

    // Expired: `valid_until > now` fails once the clock reaches it.
    w.advance_to(NOW + 60);
    let mut args = w.prepare_args(&manifest);
    args.document = short;
    w.prepare_refused(&args, DepartureDocumentInvalid);

    // A DocumentIssuer's departure document is accepted, as is Kopano's.
    let by_issuer = w.attest_departure(Issuer2, issuer, lot, 6, DEPARTURE_SHA);
    let mut args = w.prepare_args(&manifest);
    args.document = by_issuer;
    args.issuer = issuer;
    let shipment = w.prepare_ok(&args);
    w.cancel_ok(shipment);
    let mut args = w.prepare_args(&manifest);
    args.shipment_id = SHIPMENT_TWO;
    w.prepare_ok(&args);
}

#[test]
fn prepare_shipment_rejects_stale_revision() {
    let mut w = World::demo();
    let manifest = w.demo_manifest();
    let mut args = w.prepare_args(&manifest);
    args.expected_revision += 1;
    w.prepare_refused(&args, StaleRevision);
}

#[test]
fn prepare_shipment_rejects_paused() {
    let mut w = World::demo();
    let second_lot = w.issue_lot(SECOND_LOT_ID, &SECOND_INTAKE_DIGEST);
    let second_document = w.attest_departure(Custodian, w.custodian, second_lot, 1, DEPARTURE_SHA);
    let (shipment, manifest) = w.prepare_demo();

    let pause = w.f.change_pause(Admin, pause::SHIP, true);
    w.f.ok(pause, Admin);
    let second_manifest = w.manifest(&[LOT_KG], 0x60);
    let mut args = w.prepare_args(&second_manifest);
    args.shipment_id = SHIPMENT_TWO;
    args.lot = second_lot;
    args.position = World::position_key(second_lot, w.owner);
    args.document = second_document;
    args.expected_revision = w.f.read::<Lot>(second_lot).revision;
    w.prepare_refused(&args, Paused);

    // Registration and cancellation are never paused, even with every bit set.
    let pause = w.f.change_pause(Admin, pause::ALL, true);
    w.f.ok(pause, Admin);
    w.register_ok(shipment, &manifest, 0);
    w.cancel_ok(shipment);
}

#[test]
fn prepare_shipment_rejects_window_601() {
    let mut w = World::demo();
    let manifest = w.demo_manifest();
    let mut args = w.prepare_args(&manifest);
    args.valid_until = w.now + 601;
    w.prepare_refused(&args, WindowTooLong);
    let mut args = w.prepare_args(&manifest);
    args.valid_until = w.now + 600;
    w.prepare_ok(&args);
}

#[test]
fn prepare_shipment_raises_position_revision() {
    let mut w = World::demo();
    // A transfer signed before the shipment, at the position's revision 0.
    let early = w.transfer_at(TWO_THOUSAND_T, 0, w.now + CUSTODY_WINDOW);
    let before = w.position_state();
    let (shipment, _) = w.prepare_demo();
    let after = w.position_state();
    let mut expected = before.clone();
    expected.revision += 1;
    assert_same(&after, &expected);
    w.cancel_ok(shipment);
    assert_eq!(w.lot_state().state, LotState::Stored);
    w.f.sponsored_refused(&early, 1, StaleRevision);
    // The same transfer signed at the current revision goes through.
    let current = w.transfer_instructions(TWO_THOUSAND_T);
    w.f.sponsored_ok(&current);
    w.assert_invariants();
}

#[test]
fn prepared_lot_refuses_transfer_split_redeem_pledge_and_sale() {
    let mut w = World::demo();
    w.open_lending(THREE_THOUSAND_T);
    w.prepare_demo();

    let transfer = w.transfer_instructions(TWO_THOUSAND_T);
    w.f.sponsored_refused(&transfer, 1, LotNotStored);
    let split = w.split_instructions();
    w.f.sponsored_refused(&split, 1, LotNotStored);
    let redeem = w.redeem_instructions();
    w.f.sponsored_refused(&redeem, 1, LotNotStored);
    let pledge = w.pledge_instructions(1, TWO_THOUSAND_T);
    w.f.sponsored_refused(&pledge, 1, LotNotStored);
    let release = w.release_intent_instructions();
    w.f.sponsored_refused(&release, 1, LotNotStored);
    w.assert_invariants();
}

#[test]
fn record_advance_rejects_prepared_lot() {
    let mut w = World::demo();
    w.open_lending(LOT_KG);
    let (shipment, _) = w.prepare_demo();
    let advance = w.advance_instructions();
    w.f.signed_refused(&advance, Lender, 1, LotNotStored);
    // Back at the source, the same advance is within the limit and goes through.
    w.cancel_ok(shipment);
    let advance = w.advance_instructions();
    w.f.signed_ok(&advance, Lender);
    assert_eq!(w.f.read::<Loan>(w.loan).principal, w.six_hundred_k());
}

#[test]
fn borrow_rejects_prepared_lot() {
    let mut w = World::new(SettlementMode::DevnetTokenSimulation);
    w.open_lending(LOT_KG);
    let (shipment, _) = w.prepare_demo();
    let borrow = w.borrow_instructions();
    w.f.sponsored_refused(&borrow, 1, LotNotStored);
    w.cancel_ok(shipment);
    let borrow = w.borrow_instructions();
    w.f.sponsored_ok(&borrow);
    assert_eq!(w.f.read::<Loan>(w.loan).principal, w.six_hundred_k());
}

#[test]
fn record_advance_and_borrow_reject_restricted_lot() {
    let mut w = World::demo();
    w.open_lending(LOT_KG);
    let lot = w.lot;
    w.set_restriction(lot, Restriction::ReviewRequired);
    let advance = w.advance_instructions();
    w.f.signed_refused(&advance, Lender, 1, Restricted);

    let mut w = World::new(SettlementMode::DevnetTokenSimulation);
    w.open_lending(LOT_KG);
    let lot = w.lot;
    w.set_restriction(lot, Restriction::ReviewRequired);
    let borrow = w.borrow_instructions();
    w.f.sponsored_refused(&borrow, 1, Restricted);
}

// ============================================================== register_batch ====

#[test]
fn register_batch_demo_completes_manifest() {
    let mut w = World::demo();
    let (shipment, manifest) = w.prepare_demo();
    w.register_ok(shipment, &manifest, 0);
    let stored: Shipment = w.f.read(shipment);
    assert_eq!(stored.registered_count, stored.batch_count);
    assert_eq!(stored.registered_kg, stored.committed_kg);
    assert_eq!(stored.status, ShipmentStatus::Prepared);
    assert_eq!(stored.revision, 0);
}

#[test]
fn register_batch_two_batches_sum_exactly() {
    let mut w = World::demo();
    let manifest = w.manifest(&[THREE_THOUSAND_T, TWO_THOUSAND_T], 0x33);
    let args = w.prepare_args(&manifest);
    let shipment = w.prepare_ok(&args);
    w.register_ok(shipment, &manifest, 0);
    assert_eq!(
        w.f.read::<Shipment>(shipment).registered_kg,
        THREE_THOUSAND_T
    );
    w.register_ok(shipment, &manifest, 1);
    let stored: Shipment = w.f.read(shipment);
    assert_eq!((stored.registered_count, stored.registered_kg), (2, LOT_KG));
}

#[test]
fn register_batch_rejects_wrong_proof() {
    let mut w = World::demo();
    let manifest = w.manifest(&[THREE_THOUSAND_T, TWO_THOUSAND_T], 0x33);
    let args = w.prepare_args(&manifest);
    let shipment = w.prepare_ok(&args);
    // Leaf 0 with leaf 1's proof.
    let register = w.register_instruction(shipment, &manifest.leaves[0], &manifest.proofs[1]);
    w.register_refused(register, ManifestMismatch);
    // A leaf that is not in the root: leaf 0 with another quantity.
    let mut forged = manifest.leaves[0].clone();
    forged.quantity_kg = TWO_THOUSAND_T;
    let register = w.register_instruction(shipment, &forged, &manifest.proofs[0]);
    w.register_refused(register, ManifestMismatch);
    // Another carrier.
    let mut forged = manifest.leaves[0].clone();
    forged.carrier = w.buyer;
    let register = w.register_instruction(shipment, &forged, &manifest.proofs[0]);
    w.register_refused(register, ManifestMismatch);
    w.register_ok(shipment, &manifest, 0);
}

#[test]
fn register_batch_rejects_sum_mismatch() {
    let mut w = World::demo();
    let manifest = w.manifest(&[THREE_THOUSAND_T, TWO_THOUSAND_T - 1], 0x33);
    let args = w.prepare_args(&manifest);
    let shipment = w.prepare_ok(&args);
    w.register_ok(shipment, &manifest, 0);
    let register = w.register_instruction(shipment, &manifest.leaves[1], &manifest.proofs[1]);
    w.register_refused(register, BatchSumMismatch);

    // A first batch already over the committed quantity is refused too.
    let mut w = World::demo();
    let manifest = w.manifest(&[LOT_KG + 1, 1], 0x33);
    let args = w.prepare_args(&manifest);
    let shipment = w.prepare_ok(&args);
    let register = w.register_instruction(shipment, &manifest.leaves[0], &manifest.proofs[0]);
    w.register_refused(register, BatchSumMismatch);
}

#[test]
fn register_batch_rejects_overlapping_load_identity() {
    let mut w = World::demo();
    let (first, manifest) = w.prepare_demo();
    w.register_ok(first, &manifest, 0);
    w.cancel_ok(first);

    // A new shipment whose manifest reuses the registered load digest.
    let mut args = w.prepare_args(&manifest);
    args.shipment_id = SHIPMENT_TWO;
    let second = w.prepare_ok(&args);
    let register = w.register_instruction(second, &manifest.leaves[0], &manifest.proofs[0]);
    w.f.sponsored_already_in_use(&[register], 0);
    assert_eq!(w.f.read::<Shipment>(second).registered_count, 0);
    // The registered batch still belongs to the first shipment.
    let batch: ManifestBatch =
        w.f.read(batch_key(w.f.protocol, &manifest.leaves[0].load_digest));
    assert_eq!(batch.shipment, first);
}

#[test]
fn register_batch_rejects_index_out_of_range() {
    let mut w = World::demo();
    let (shipment, manifest) = w.prepare_demo();
    let mut leaf = manifest.leaves[0].clone();
    leaf.index = 1;
    leaf.load_digest = [0x34; 32];
    let register = w.register_instruction(shipment, &leaf, &manifest.proofs[0]);
    w.register_refused(register, InvalidField);
    leaf.index = 16;
    let register = w.register_instruction(shipment, &leaf, &manifest.proofs[0]);
    w.register_refused(register, InvalidField);
}

#[test]
fn register_batch_rejects_cancelled_shipment() {
    let mut w = World::demo();
    let (shipment, manifest) = w.prepare_demo();
    w.cancel_ok(shipment);
    let register = w.register_instruction(shipment, &manifest.leaves[0], &manifest.proofs[0]);
    w.register_refused(register, ShipmentNotOpen);
}

// ============================================================= cancel_shipment ====

#[test]
fn cancel_shipment_releases_reservation_and_restores_stored() {
    let mut w = World::demo();
    let (shipment, manifest) = w.prepare_demo();
    w.register_ok(shipment, &manifest, 0);
    let lot_before = w.lot_state();
    w.cancel_ok(shipment);
    assert_eq!(w.class_state(w.destination).reserved_inbound_kg, 0);
    assert_eq!(w.class_state(w.source).occupied_kg, LOT_KG);
    let lot = w.lot_state();
    assert_eq!(lot.state, LotState::Stored);
    assert_eq!(lot.custodian_class, w.source);
    assert_eq!(lot.revision, lot_before.revision + 1);
    // The registered batch stays as a tombstone.
    let batch: ManifestBatch =
        w.f.read(batch_key(w.f.protocol, &manifest.leaves[0].load_digest));
    assert_eq!(batch.stage, BatchStage::AtSource);
}

#[test]
fn cancel_shipment_rejects_cancelled() {
    let mut w = World::demo();
    let (shipment, _) = w.prepare_demo();
    w.cancel_ok(shipment);
    let args = w.cancel_args(shipment);
    assert_eq!(args.expected_revision, 1);
    w.cancel_refused(&args, ShipmentNotOpen);
}

#[test]
fn cancel_shipment_rejects_wrong_owner() {
    let mut w = World::demo();
    let (shipment, _) = w.prepare_demo();
    let mut args = w.cancel_args(shipment);
    args.signer = Buyer;
    args.owner_org = w.buyer;
    w.cancel_refused(&args, WrongOrganisation);
    let mut args = w.cancel_args(shipment);
    args.signer = Buyer;
    w.cancel_refused(&args, WrongOrganisation);
    w.cancel_ok(shipment);
}

// ======================================================= departure documents ====

#[test]
fn attest_departure_document_requires_transport_scope() {
    let mut w = World::demo();
    let issuer = w.issuer;
    let subject = w.lot.to_bytes();
    let attest = w.f.attest(
        Issuer,
        issuer,
        DocumentKind::Departure,
        subject,
        7,
        DEPARTURE_SHA,
        NOW + DOCUMENT_VALIDITY,
    );
    w.f.refused(attest, Issuer, ScopeMissing);
    let document = w.attest_kind(
        Issuer2,
        issuer,
        DocumentKind::Departure,
        subject,
        7,
        DEPARTURE_SHA,
        NOW + DOCUMENT_VALIDITY,
    );
    let stored: DocumentAttestation = w.f.read(document);
    assert_eq!(stored.subject, subject);
    assert_eq!(stored.version, 7);
    // The transport scope does not attest origin.
    let attest = w.f.attest(
        Issuer2,
        issuer,
        DocumentKind::Origin,
        subject,
        7,
        DEPARTURE_SHA,
        NOW + DOCUMENT_VALIDITY,
    );
    w.f.refused(attest, Issuer2, ScopeMissing);
}

#[test]
fn attest_departure_document_by_custodian_succeeds() {
    let mut w = World::demo();
    let stored: DocumentAttestation = w.f.read(w.document);
    assert_eq!(stored.kind, DocumentKind::Departure);
    assert_eq!(stored.issuer, w.custodian);
    assert_eq!(stored.subject, w.lot.to_bytes());
    assert_eq!(stored.revoked_at, None);

    let custodian = w.custodian;
    let subject = w.lot.to_bytes();
    let attest = w.f.attest(
        Custodian,
        custodian,
        DocumentKind::Origin,
        subject,
        1,
        DEPARTURE_SHA,
        NOW + DOCUMENT_VALIDITY,
    );
    w.f.refused(attest, Custodian, ScopeMissing);

    // A Custodian Authority the harness writes with ATTEST_ORIGIN still is the wrong role.
    let wallet = w.f.key(Outsider);
    w.f.forge_authority(custodian, wallet, scope::ATTEST_ORIGIN, NOW + DAY);
    let attest = w.f.attest(
        Outsider,
        custodian,
        DocumentKind::Origin,
        subject,
        1,
        DEPARTURE_SHA,
        NOW + DOCUMENT_VALIDITY,
    );
    w.f.refused(attest, Outsider, WrongRole);
    // The terminal may attest a departure too.
    let terminal = w.terminal;
    let lot = w.lot;
    w.attest_departure(Custodian2, terminal, lot, 2, DEPARTURE_SHA);
}

#[test]
fn revoke_departure_document_requires_transport_scope() {
    let mut w = World::demo();
    let issuer = w.issuer;
    let lot = w.lot;
    let document = w.attest_departure(Issuer2, issuer, lot, 8, DEPARTURE_SHA);
    let revoke = w.f.revoke_document(Issuer, issuer, document);
    w.f.refused(revoke, Issuer, ScopeMissing);
    let revoke = w.f.revoke_document(Issuer2, issuer, document);
    let tx = w.f.ok(revoke, Issuer2);
    assert_event(&tx, events::DocumentRevoked { document, at: NOW });
    assert_eq!(
        w.f.read::<DocumentAttestation>(document).revoked_at,
        Some(NOW)
    );
    // Kopano revokes its own document with its transport scope.
    let custodian = w.custodian;
    let own = w.document;
    let revoke = w.f.revoke_document(Custodian, custodian, own);
    w.f.ok(revoke, Custodian);
}

// ================================================== scopes, pause, accreditation ====

#[test]
fn delegate_authority_phase3_scope_table() {
    assert_eq!(scope::SHIP, 1 << 9);
    assert_eq!(scope::CARRY, 1 << 10);
    assert_eq!(scope::OBSERVE, 1 << 11);
    assert_eq!(scope::LOAD, 1 << 12);
    assert_eq!(scope::INSPECT, 1 << 13);
    assert_eq!(scope::ATTEST_TRANSPORT, 1 << 14);

    let mut f = Fixture::initialized();
    let exporter = f.add_org(1, Role::Exporter);
    let custodian = f.add_org(2, Role::Custodian);
    let transporter = f.add_org(3, Role::Transporter);
    let terminal = f.add_org(4, Role::Terminal);
    let inspector = f.add_org(5, Role::Inspector);
    for (org, scopes) in [
        (custodian, scope::SHIP),
        (transporter, scope::LOAD),
        (terminal, scope::INSPECT),
        (exporter, 1 << 15),
        (exporter, scope::SHIP | 1 << 15),
        (inspector, scope::CARRY),
    ] {
        let wallet = Pubkey::new_unique();
        let delegate = f.delegate(OrgAdmin, org, wallet, scopes, NOW + 1);
        f.refused(delegate, OrgAdmin, ScopeNotAllowed);
        assert!(!f.account_exists(f.authority(wallet)));
    }
    for (org, scopes) in [
        (exporter, scope::SHIP),
        (
            custodian,
            scope::CARRY | scope::OBSERVE | scope::ATTEST_TRANSPORT,
        ),
        (transporter, scope::CARRY | scope::OBSERVE),
        (
            terminal,
            scope::CARRY | scope::OBSERVE | scope::LOAD | scope::ATTEST_TRANSPORT,
        ),
        (inspector, scope::OBSERVE | scope::INSPECT),
    ] {
        let wallet = Pubkey::new_unique();
        let delegate = f.delegate(OrgAdmin, org, wallet, scopes, NOW + 1);
        f.ok(delegate, OrgAdmin);
        assert_eq!(f.read::<Authority>(f.authority(wallet)).scopes, scopes);
    }
}

#[test]
fn pause_accepts_phase3_bits_and_rejects_bit_12() {
    assert_eq!(pause::SHIP, 1 << 9);
    assert_eq!(pause::HANDOVER, 1 << 10);
    assert_eq!(pause::LOADING, 1 << 11);
    assert_eq!(pause::ALL, 0xfff);

    let mut f = Fixture::initialized();
    for (flags, expected) in [
        (pause::SHIP, 0x200),
        (pause::HANDOVER, 0x600),
        (pause::LOADING, 0xe00),
        (pause::ALL, 0xfff),
    ] {
        let tx = f.ok(f.change_pause(Admin, flags, true), Admin);
        assert_event(&tx, events::PauseChanged { flags: expected });
        assert_eq!(f.read::<Protocol>(f.protocol).pause_flags, expected);
    }
    for paused in [true, false] {
        for flags in [0x1000, 0x1200, 0x1fff, 0x8000, 0xffff] {
            f.refused(f.change_pause(Admin, flags, paused), Admin, InvalidField);
            assert_eq!(f.read::<Protocol>(f.protocol).pause_flags, 0xfff);
        }
    }
    let tx = f.ok(
        f.change_pause(Admin, pause::SHIP | pause::LOADING, false),
        Admin,
    );
    assert_event(&tx, events::PauseChanged { flags: 0x5ff });
    assert_eq!(f.read::<Protocol>(f.protocol).pause_flags, 0x5ff);
}

#[test]
fn accredit_custodian_class_accepts_terminal() {
    let mut f = Fixture::initialized();
    let terminal = f.add_org(1, Role::Terminal);
    let transporter = f.add_org(2, Role::Transporter);
    f.ok(
        f.register(Accreditor, CLASS_CODE, 1, &["A"], 3600),
        Accreditor,
    );
    let class = f.class(CLASS_CODE, 1);
    f.refused(
        f.accredit_site(Accreditor, transporter, class, DESTINATION_SITE, LOT_KG),
        Accreditor,
        WrongRole,
    );
    let tx = f.ok(
        f.accredit_site(Accreditor, terminal, class, DESTINATION_SITE, LOT_KG),
        Accreditor,
    );
    let custodian_class = f.site(terminal, class, DESTINATION_SITE);
    assert_event(
        &tx,
        events::CustodianClassAccredited {
            custodian_class,
            approved_capacity_kg: LOT_KG,
        },
    );
    let stored: CustodianClass = f.read(custodian_class);
    assert_eq!(stored.custodian, terminal);
    assert_eq!(stored.class_policy, class);
    assert_eq!(stored.site_code, DESTINATION_SITE);
    assert_eq!(
        (
            stored.approved_capacity_kg,
            stored.occupied_kg,
            stored.reserved_inbound_kg
        ),
        (LOT_KG, 0, 0)
    );
}

// ============================================================== known answers ====

#[test]
fn manifest_root_known_answers() {
    let carrier = Pubkey::new_from_array([0x11; 32]);
    let leaf0 = batch_leaf(0, 5_000_000, &carrier, &[0x33; 32], &[0x44; 32]);
    assert_eq!(
        leaf0,
        unhex("c462e25edead2a478f7534f928d94a2dd85acedcead8d997c031e715f4bcb8d1")
    );
    let empty = [
        [0; 32],
        unhex("ae0798d0ecaed2b778eddebf18f071a561c53658c05e76cedecc27cafbdbc577"),
        unhex("90534fe0aff6db9edb29eee74e78a386916a581c8e6465349493e1a6c87241e1"),
        unhex("bea16162721bca4b6e1782cbdc695a471522157c6716f508db47c599195340f4"),
    ];
    // The empty subtrees are the zero leaf hashed up with `node`.
    assert_eq!(node(&empty[0], &empty[0]), empty[1]);
    assert_eq!(node(&empty[1], &empty[1]), empty[2]);
    assert_eq!(node(&empty[2], &empty[2]), empty[3]);
    let m1 = unhex("8df721d308bd44a37494f5362fff9cb0ac090efc83e7f2cb152177dc7b602486");
    assert!(verify_batch(&m1, 0, leaf0, &empty));
    assert!(!verify_batch(&m1, 1, leaf0, &empty));

    let m2_leaf0 = batch_leaf(0, 3_000_000, &carrier, &[0x33; 32], &[0x44; 32]);
    let m2_leaf1 = batch_leaf(1, 2_000_000, &carrier, &[0x55; 32], &[0x66; 32]);
    assert_eq!(
        m2_leaf0,
        unhex("229ad3dea2350a043f8b528b9c835f9363d6f9aa61d269c5f86c1b610b7a85b1")
    );
    assert_eq!(
        m2_leaf1,
        unhex("c60f926e27312d66dc90683881d5efa8a4fd8b040f14c7794a646a44be9390f6")
    );
    let m2 = unhex("4c71a1be02e39b85eacad7da6a0dc84ed7607b211f5e6c66276a5d79080c99cd");
    let proof0 = [m2_leaf1, empty[1], empty[2], empty[3]];
    let proof1 = [m2_leaf0, empty[1], empty[2], empty[3]];
    assert!(verify_batch(&m2, 0, m2_leaf0, &proof0));
    assert!(verify_batch(&m2, 1, m2_leaf1, &proof1));
    assert!(!verify_batch(&m2, 0, m2_leaf0, &proof1));
    assert!(!verify_batch(&m2, 1, m2_leaf0, &proof1));

    // The test's own tree builder agrees with the vectors.
    let built = Manifest::new(vec![Leaf {
        index: 0,
        quantity_kg: 5_000_000,
        carrier,
        load_digest: [0x33; 32],
        manifest_digest: [0x44; 32],
    }]);
    assert_eq!(built.root, m1);
    assert_eq!(built.proofs[0], empty);
}

const PREPARE_TEXT: &str = "Thetis authorisation v1
Network: devnet
Program: jGJpdjtoDUtXMjvc4UaEi1mBeFZKqVfe9jL8ireHMs3
Protocol: 00112233445566778899aabbccddeeff
Action: Prepare shipment
Lot: CR-0001
Shipment: 22222222222222222222222222222222
Quantity: 5,000.000 t
Owner: Khunou Ore Exports
To: Port Terminal T1
Site: PORT-T1
Batches: 1
Manifest: 8df721d308bd44a37494f5362fff9cb0ac090efc83e7f2cb152177dc7b602486
Departure document: dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd v1
Revision: 0
Valid until: 2026-11-19 16:32:05 SAST
Test network only. Synthetic data.";

const CANCEL_TEXT: &str = "Thetis authorisation v1
Network: devnet
Program: jGJpdjtoDUtXMjvc4UaEi1mBeFZKqVfe9jL8ireHMs3
Protocol: 00112233445566778899aabbccddeeff
Action: Cancel shipment
Lot: CR-0001
Shipment: 22222222222222222222222222222222
Owner: Khunou Ore Exports
To: Port Terminal T1
Site: PORT-T1
Revision: 0
Valid until: 2026-11-19 16:32:05 SAST
Test network only. Synthetic data.";

#[test]
fn shipment_messages_known_answers() {
    let instance: [u8; 16] = std::array::from_fn(|index| u8::try_from(index * 0x11).unwrap());
    let m1 = unhex("8df721d308bd44a37494f5362fff9cb0ac090efc83e7f2cb152177dc7b602486");
    let prepare = prepare_shipment_message(
        &ID,
        &instance,
        "CR-0001",
        &[0x22; 16],
        5_000_000,
        "Khunou Ore Exports",
        "Port Terminal T1",
        "PORT-T1",
        1,
        &m1,
        (&[0xdd; 32], 1),
        0,
        1_795_098_725,
    );
    assert_eq!(String::from_utf8(prepare.clone()).unwrap(), PREPARE_TEXT);
    assert_eq!(prepare.len(), 558);
    assert_eq!(
        sha256_hex(&prepare),
        "86e56551651bc2e465735800ce765ef264b9ec7dc532f26623e19ecd48cf1d53"
    );
    let cancel = cancel_shipment_message(
        &ID,
        &instance,
        "CR-0001",
        &[0x22; 16],
        "Khunou Ore Exports",
        "Port Terminal T1",
        "PORT-T1",
        0,
        1_795_098_725,
    );
    assert_eq!(String::from_utf8(cancel.clone()).unwrap(), CANCEL_TEXT);
    assert_eq!(cancel.len(), 361);
    assert_eq!(
        sha256_hex(&cancel),
        "215259944b57deef198ca6214696884991e7fb8cd561c8328e68a9c1c8480be2"
    );
}

// ============================================================ transaction size ====

/// Two distinct 48-byte names, a 16-byte lot id and a 16-byte site code (§11.1).
const WIDEST_OWNER: &str = "Khunou Ore Exports And Allied Holdings Pty Ltd 1";
const WIDEST_TERMINAL: &str = "Port Terminal T1 And Allied Bulk Terminals Pty 1";
const WIDEST_LOT_ID: &str = "CR-0001-WIDEST-1";
const WIDEST_SITE: &str = "PORT-T1-WIDEST-1";

fn assert_widest_inputs() {
    for name in [WIDEST_OWNER, WIDEST_TERMINAL] {
        assert_eq!(name.len(), MAX_DISPLAY_NAME);
    }
    assert_ne!(WIDEST_OWNER, WIDEST_TERMINAL);
    assert_eq!(WIDEST_LOT_ID.len(), MAX_LOT_ID);
    assert_eq!(WIDEST_SITE.len(), MAX_SITE_CODE);
}

impl World {
    /// Compiles `[compute budget, verify, action]` as a sponsored v0 transaction against `table`
    /// and checks that only the sponsor signs, that `inline` are the only static keys, and that
    /// the table supplies exactly `writable` and `readonly`.
    fn shipment_v0(
        &mut self,
        table: &AddressLookupTableAccount,
        instructions: [Instruction; 2],
        inline: Vec<Pubkey>,
        writable: Vec<Pubkey>,
        readonly: Vec<Pubkey>,
    ) -> (VersionedTransaction, usize) {
        let [verify, action] = instructions;
        let tx = self.f.sponsored_v0(
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

    fn send_measured(&mut self, tx: VersionedTransaction, name: &str) -> TransactionMetadata {
        let meta = self
            .f
            .send(tx)
            .unwrap_or_else(|failure| panic!("{:?}\n{}", failure.err, failure.meta.pretty_logs()));
        let units = meta.compute_units_consumed;
        assert!(
            units < u64::from(COMPUTE_UNIT_LIMIT),
            "{name} used {units} compute units"
        );
        println!("{name} v0 demo: {units} CU");
        meta
    }
}

#[test]
fn prepare_shipment_size_fits_v0_widest() {
    let mut w = World::demo();
    let manifest = w.demo_manifest();
    let demo = w.prepare_args(&manifest);
    let widest = PrepareArgs {
        shipment_id: SHIPMENT_TWO,
        batch_count: 16,
        expected_revision: u64::MAX,
        valid_until: i64::MAX,
        ..demo.clone()
    };
    let demo_shipment = shipment_key(w.f.protocol, &demo.shipment_id);
    let widest_shipment = shipment_key(w.f.protocol, &widest.shipment_id);
    let batch = batch_key(w.f.protocol, &manifest.leaves[0].load_digest);
    let readonly = vec![
        SYSTEM,
        INSTRUCTIONS_SYSVAR,
        w.f.protocol,
        w.owner,
        w.authority_of(Owner),
        w.source,
        w.terminal,
        w.document,
        w.custodian,
    ];
    let writable = |shipment: Pubkey| vec![w.lot, w.position, w.destination, shipment];
    // The relay appends the Shipment and every ManifestBatch PDA before it prepares.
    let mut addresses = readonly.clone();
    addresses.extend(writable(demo_shipment));
    addresses.extend([widest_shipment, batch]);
    let demo_writable = writable(demo_shipment);
    let widest_writable = writable(widest_shipment);
    let table = w.f.create_lookup_table(addresses);
    let inline = vec![w.f.payer(), ID, ED25519, COMPUTE_BUDGET];
    assert_eq!(readonly.len() + demo_writable.len(), 13);

    let instructions = w.prepare(&demo);
    let (tx, demo_size) = w.shipment_v0(
        &table,
        instructions,
        inline.clone(),
        demo_writable,
        readonly.clone(),
    );
    w.send_measured(tx, "prepare_shipment");
    assert_eq!(w.lot_state().state, LotState::Prepared);
    w.shipments.push(demo_shipment);
    w.assert_invariants();
    println!("prepare_shipment v0 demo: {demo_size} bytes");

    assert_widest_inputs();
    let text = prepare_shipment_message(
        &ID,
        &INSTANCE,
        WIDEST_LOT_ID,
        &widest.shipment_id,
        u64::MAX,
        WIDEST_OWNER,
        WIDEST_TERMINAL,
        WIDEST_SITE,
        16,
        &widest.manifest_root,
        (&DEPARTURE_SHA, u32::MAX),
        u64::MAX,
        i64::MAX,
    );
    assert_eq!(text.len(), 692);
    let instructions = w.prepare_signed(&widest, &text);
    let (_, widest_size) = w.shipment_v0(&table, instructions, inline, widest_writable, readonly);
    println!("prepare_shipment v0 widest: {widest_size} bytes");
    assert_eq!(widest_size, 1_185);
}

#[test]
fn cancel_shipment_size_fits_v0_widest() {
    let mut w = World::demo();
    let (shipment, _) = w.prepare_demo();
    let demo = w.cancel_args(shipment);
    let widest = CancelArgs {
        expected_revision: u64::MAX,
        valid_until: i64::MAX,
        ..demo.clone()
    };
    let readonly = vec![
        INSTRUCTIONS_SYSVAR,
        w.f.protocol,
        w.owner,
        w.authority_of(Owner),
        w.terminal,
    ];
    let writable = vec![w.lot, shipment, w.destination];
    let mut addresses = readonly.clone();
    addresses.extend(writable.clone());
    let table = w.f.create_lookup_table(addresses);
    let inline = vec![w.f.payer(), ID, ED25519, COMPUTE_BUDGET];
    assert_eq!(readonly.len() + writable.len(), 8);

    let instructions = w.cancel(&demo);
    let (tx, demo_size) = w.shipment_v0(
        &table,
        instructions,
        inline.clone(),
        writable.clone(),
        readonly.clone(),
    );
    w.send_measured(tx, "cancel_shipment");
    assert_eq!(
        w.f.read::<Shipment>(shipment).status,
        ShipmentStatus::Cancelled
    );
    w.assert_invariants();
    println!("cancel_shipment v0 demo: {demo_size} bytes");

    assert_widest_inputs();
    let text = cancel_shipment_message(
        &ID,
        &INSTANCE,
        WIDEST_LOT_ID,
        &SHIPMENT_ONE,
        WIDEST_OWNER,
        WIDEST_TERMINAL,
        WIDEST_SITE,
        u64::MAX,
        i64::MAX,
    );
    assert_eq!(text.len(), 468);
    let instructions = w.cancel_signed(&widest, &text);
    let (_, widest_size) = w.shipment_v0(&table, instructions, inline, writable, readonly);
    println!("cancel_shipment v0 widest: {widest_size} bytes");
    assert_eq!(widest_size, 902);
}
