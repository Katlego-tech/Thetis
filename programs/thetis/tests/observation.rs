//! Phase 3: `record_observation` (PS, one entry): an observer with `OBSERVE` records a
//! checkpoint or a border crossing of one batch. The observation is an event plus the batch's
//! `observation_count`; it never changes the holder, the stage, the sequence, the lot or the
//! shipment. A `Border` observation is recorded only by a Transporter or a Terminal (owner
//! decision 3), a `Checkpoint` by a Custodian, Transporter, Terminal or Inspector.
//!
//! Demo quantities are the demo's (5,000 t). Site capacities are fixture values stated below.
//! The demo cast is synthetic; "another haulier" (demo.md §3) uses the harness's generated test
//! name, and `Inspector Test Org` is the test-only inspector of program-custody.md §10. Shipment
//! ids, digests, site and location codes and times are deterministic synthetic test inputs.

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
        cancel_shipment_message, custody_handover_message, issue_message, observation_message,
        prepare_shipment_message,
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
const DOCUMENT_VALIDITY: i64 = 10 * DAY;
/// The relay's custody window (600 s less its 30 s margin).
const CUSTODY_WINDOW: i64 = 570;

const CLASS_CODE: &str = "CHROME";
const GRADES: [&str; 2] = ["A", "B"];
const SOURCE_SITE: &str = "INLAND-YARD";
const DESTINATION_SITE: &str = "PORT-T1";
/// Fixture capacities.
const SOURCE_CAPACITY: u64 = 10_000_000;
const DESTINATION_CAPACITY: u64 = 5_000_000;

const LOT_ID: &str = "CR-0001";
const INTAKE_DIGEST: [u8; 32] = [0x0a; 32];
const LOT_KG: u64 = 5_000_000;
const DEPARTURE_SHA: [u8; 32] = [0xdd; 32];
const SHIPMENT_ONE: [u8; 16] = [0x22; 16];
const SHIPMENT_TWO: [u8; 16] = [0x23; 16];
const LOCATION: &str = "BORDER-1";
const CHECKPOINT: &str = "WEIGH-STOP-2";
const EVIDENCE: [u8; 32] = [0x77; 32];
/// How long before the block time the photo was taken (a synthetic test input).
const PHOTO_AGE: i64 = 60;

const OWNER_ID: u8 = 1;
const CUSTODIAN_ID: u8 = 2;
const TRANSPORTER_ID: u8 = 3;
const TERMINAL_ID: u8 = 5;
const OTHER_HAULIER_ID: u8 = 8;
const INSPECTOR_ID: u8 = 10;

const OWNER_NAME: &str = "Khunou Ore Exports";
const CUSTODIAN_NAME: &str = "Kopano Stockyard Custody";
const TRANSPORTER_NAME: &str = "Mosela Haulage";
const TERMINAL_NAME: &str = "Port Terminal T1";
const INSPECTOR_NAME: &str = "Inspector Test Org";

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

/// A fiat protocol with the demo cast plus `Inspector Test Org`; a source site of Kopano
/// Stockyard Custody and a destination site of Port Terminal T1 in the chrome class; CR-0001
/// (5,000 t, grade A) issued at the source to Khunou Ore Exports; and Kopano's departure
/// document for it. Mosela Haulage, Kopano, Port Terminal T1 and the inspector hold `OBSERVE`;
/// "another haulier" holds `CARRY` only.
struct World {
    f: Fixture,
    now: i64,
    owner: Pubkey,
    custodian: Pubkey,
    transporter: Pubkey,
    other_haulier: Pubkey,
    terminal: Pubkey,
    inspector: Pubkey,
    class_policy: Pubkey,
    source: Pubkey,
    destination: Pubkey,
    lot: Pubkey,
    position: Pubkey,
    document: Pubkey,
    shipments: Vec<Pubkey>,
    batches: Vec<Pubkey>,
    classes: Vec<Pubkey>,
}

impl World {
    fn demo() -> Self {
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
        let terminal = accredit(&mut f, TERMINAL_ID, Role::Terminal, TERMINAL_NAME);
        let inspector = accredit(&mut f, INSPECTOR_ID, Role::Inspector, INSPECTOR_NAME);
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
        let destination = f.site(terminal, class_policy, DESTINATION_SITE);

        let expires_at = NOW + AUTHORITY_LIFETIME;
        for (org, wallet, scopes) in [
            (owner, Owner, scope::TRANSFER | scope::SHIP),
            (
                custodian,
                Custodian,
                scope::ISSUE | scope::CARRY | scope::OBSERVE | scope::ATTEST_TRANSPORT,
            ),
            (terminal, Custodian2, scope::CARRY | scope::OBSERVE),
            (transporter, Driver, scope::CARRY | scope::OBSERVE),
            (other_haulier, OtherDriver, scope::CARRY),
            (inspector, Inspector, scope::OBSERVE),
        ] {
            let delegate = f.delegate(OrgAdmin, org, f.key(wallet), scopes, expires_at);
            f.ok(delegate, OrgAdmin);
        }

        let protocol = f.protocol;
        let lot = pda(&[b"lot", protocol.as_ref(), LOT_ID.as_bytes()]);
        let mut world = Self {
            f,
            now: NOW,
            owner,
            custodian,
            transporter,
            other_haulier,
            terminal,
            inspector,
            class_policy,
            source,
            destination,
            lot,
            position: pda(&[b"position", lot.as_ref(), owner.as_ref()]),
            document: Pubkey::default(),
            shipments: Vec::new(),
            batches: Vec::new(),
            classes: vec![source, destination],
        };
        world.issue_lot();
        world.document = world.attest_departure();
        world.assert_invariants();
        world
    }

    fn authority_of(&self, actor: Actor) -> Pubkey {
        self.f.authority(self.f.key(actor))
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
        self.f.document(DocumentKind::Departure, subject, 1)
    }

    // ------------------------------------------------------------ shipments ----

    /// A manifest whose batches carry `quantities` in index order, all carried by Mosela
    /// Haulage, with load digests `first_load + 2 × index` and manifest digests
    /// `0x44 + 2 × index`.
    fn manifest(&self, quantities: &[u64], first_load: u8) -> Manifest {
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
                        load_digest: [first_load + 2 * index; 32],
                        manifest_digest: [0x44 + 2 * index; 32],
                    }
                })
                .collect(),
        )
    }

    /// Prepares CR-0001 to Port Terminal T1 with `manifest` (a real `prepare_shipment`).
    fn prepare(&mut self, manifest: &Manifest, shipment_id: [u8; 16]) -> Pubkey {
        let valid_until = self.now + CUSTODY_WINDOW;
        let lot = self.lot_state();
        let document: DocumentAttestation = self.f.read(self.document);
        let text = prepare_shipment_message(
            &ID,
            &INSTANCE,
            LOT_ID,
            &shipment_id,
            lot.supply_kg,
            OWNER_NAME,
            TERMINAL_NAME,
            DESTINATION_SITE,
            manifest.batch_count(),
            &manifest.root,
            (&document.sha256, document.version),
            lot.revision,
            valid_until,
        );
        let shipment = shipment_key(self.f.protocol, &shipment_id);
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
                destination_org: self.terminal,
                departure_document: self.document,
                departure_issuer: self.custodian,
                shipment,
                instructions: INSTRUCTIONS_SYSVAR,
                system_program: SYSTEM,
            },
            instruction::PrepareShipment {
                shipment_id,
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

    /// The demo shipment: CR-0001 in one 5,000 t batch (M1's shape), fully registered.
    fn ship_demo(&mut self) -> (Pubkey, Pubkey) {
        self.ship_as(SHIPMENT_ONE, 0x33)
    }

    fn ship_as(&mut self, shipment_id: [u8; 16], first_load: u8) -> (Pubkey, Pubkey) {
        let manifest = self.manifest(&[LOT_KG], first_load);
        let shipment = self.prepare(&manifest, shipment_id);
        let batch = self.register(shipment, &manifest, 0);
        (shipment, batch)
    }

    /// The owner's real `cancel_shipment` of a shipment that has not departed.
    fn cancel(&mut self, shipment: Pubkey) {
        let stored = self.shipment_state(shipment);
        let valid_until = self.now + CUSTODY_WINDOW;
        let text = cancel_shipment_message(
            &ID,
            &INSTANCE,
            LOT_ID,
            &stored.shipment_id,
            OWNER_NAME,
            TERMINAL_NAME,
            DESTINATION_SITE,
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
        assert_eq!(
            self.shipment_state(shipment).status,
            ShipmentStatus::Cancelled
        );
        self.assert_invariants();
    }

    /// A real `handover` of `batch` from its holder (signed by `from`) to `to_org` (signed by
    /// `to`), at the stage the program derives for a valid recipient.
    fn hand_over(&mut self, batch: Pubkey, from: Actor, to: Actor, to_org: Pubkey) {
        let stored = self.batch_state(batch);
        let shipment = self.shipment_state(stored.shipment);
        let valid_until = self.now + CUSTODY_WINDOW;
        let at_source = stored.stage == BatchStage::AtSource;
        let stage = if at_source {
            HandoverStage::Departure
        } else if to_org == shipment.destination_custodian {
            HandoverStage::Arrival
        } else {
            HandoverStage::Transfer
        };
        let text = custody_handover_message(
            &ID,
            &INSTANCE,
            LOT_ID,
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
        let handover = ix(
            accounts::Handover {
                sponsor: self.f.payer(),
                protocol: self.f.protocol,
                shipment: stored.shipment,
                batch,
                lot: stored.lot,
                from_org: stored.holder,
                from_authority: self.authority_of(from),
                to_org,
                to_authority: self.authority_of(to),
                source_class: shipment.source,
                destination_class: shipment.destination,
                departure_document: at_source.then_some(shipment.departure_document),
                handover: handover_key(batch, stored.sequence),
                instructions: INSTRUCTIONS_SYSVAR,
                system_program: SYSTEM,
            },
            instruction::Handover {
                manifest_digest: stored.manifest_digest,
                expected_sequence: stored.sequence,
                valid_until,
            },
        );
        let verify = ed25519_shared_instruction(&[self.f.signer(from), self.f.signer(to)], &text);
        self.f.sponsored_ok(&[verify, handover]);
        assert_eq!(self.batch_state(batch).holder, to_org);
        self.assert_invariants();
    }

    /// Kopano Stockyard Custody to Mosela Haulage (the batch's carrier).
    fn depart(&mut self, batch: Pubkey) {
        self.hand_over(batch, Custodian, Driver, self.transporter);
    }

    /// Mosela Haulage to Port Terminal T1 (the destination custodian).
    fn arrive(&mut self, batch: Pubkey) {
        self.hand_over(batch, Driver, Custodian2, self.terminal);
    }

    // ---------------------------------------------------------- observation ----

    /// An observation of `batch` by `observer_org` (signed by `observer_signer`) at the
    /// batch's current holder and observation count, photographed `PHOTO_AGE` seconds ago.
    fn observe_args(
        &self,
        batch: Pubkey,
        observer_signer: Actor,
        observer_org: Pubkey,
        kind: ObservationKind,
    ) -> ObserveArgs {
        let stored = self.batch_state(batch);
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
        let batch = self.batch_state(args.batch);
        let shipment = self.shipment_state(args.shipment);
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
    fn observation_signed(
        &self,
        args: &ObserveArgs,
        signer: Actor,
        text: &[u8],
    ) -> [Instruction; 2] {
        [
            ed25519_instruction(&[(self.f.signer(signer), text)]),
            self.observation_instruction(args),
        ]
    }

    fn observation(&self, args: &ObserveArgs) -> [Instruction; 2] {
        self.observation_signed(args, args.observer_signer, &self.observation_text(args))
    }

    /// Every account the program could touch other than the batch: the shipment, the lot and
    /// its position, vault, mint and intake, both classes, the organisations and Authorities,
    /// the departure document and every HandoverRecord.
    fn untouched_keys(&self, args: &ObserveArgs) -> Vec<Pubkey> {
        let mut keys = vec![
            self.f.protocol,
            args.lot,
            self.position,
            Self::vault(args.lot, self.position),
            Self::mint(args.lot),
            self.intake(),
            self.document,
            args.observer_org,
            args.holder_org,
            self.authority_of(args.observer_signer),
        ];
        keys.extend(&self.classes);
        keys.extend(&self.shipments);
        for batch in &self.batches {
            let sequence = self.batch_state(*batch).sequence;
            keys.extend((0..=sequence).map(|used| handover_key(*batch, used)));
            if *batch != args.batch {
                keys.push(*batch);
            }
        }
        keys
    }

    /// Sends the observation and checks its whole effect: `batch.observation_count + 1`, and
    /// nothing else anywhere (the holder, stage, sequence, lot and shipment unchanged), and
    /// exactly one `ObservationRecorded` with `index = expected_observation`. Returns the index.
    fn observe_ok(&mut self, args: &ObserveArgs) -> u32 {
        let before = self.batch_state(args.batch);
        let untouched = self.snapshot(&self.untouched_keys(args));
        let instructions = self.observation(args);
        let tx = self.f.sponsored_ok(&instructions);

        let mut expected = before.clone();
        expected.observation_count += 1;
        let after = self.batch_state(args.batch);
        assert_eq!(after.holder, before.holder);
        assert_eq!(after.stage, before.stage);
        assert_eq!(after.sequence, before.sequence);
        assert_eq!(after.observation_count, args.expected_observation + 1);
        assert_eq!(serialized(&after), serialized(&expected));
        self.assert_unchanged(&untouched);
        let event = events::ObservationRecorded {
            batch: args.batch,
            shipment: args.shipment,
            lot: args.lot,
            observer: args.observer_org,
            holder: args.holder_org,
            kind: args.kind,
            location_code: args.location_code.clone(),
            evidence_digest: args.evidence_digest,
            observed_at: args.observed_at,
            index: args.expected_observation,
        };
        assert_event(&tx, event);
        self.assert_invariants();
        args.expected_observation
    }

    /// The observation must fail with `expected` at the observation instruction, with no
    /// state change and no event.
    fn observe_refused(&mut self, args: &ObserveArgs, expected: ThetisError) {
        let instructions = self.observation(args);
        self.observe_instructions_refused(&instructions, expected);
    }

    fn observe_instructions_refused(
        &mut self,
        instructions: &[Instruction],
        expected: ThetisError,
    ) {
        self.f.sponsored_refused(instructions, 1, expected);
        self.assert_invariants();
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

    /// §3 invariants: supply equals the position and the vault; each open shipment's counters
    /// are ordered; each class's occupancy and reservation equal its ordinary stock plus the
    /// contributions of the open shipment; the lot is `Prepared` or `InTransit` exactly while it
    /// has one open shipment; `reserved_kg` stays 0; and each batch's `sequence` equals the
    /// number of its HandoverRecord accounts.
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
        let lot = self.lot_state();
        let position: Position = self.f.read(self.position);
        assert_eq!(position.reserved_kg, 0);
        assert_eq!(position.quantity_kg, lot.supply_kg);
        assert_eq!(
            self.f.token_amount(Self::vault(self.lot, self.position)),
            position.quantity_kg
        );
        assert_eq!(self.f.mint_supply(Self::mint(self.lot)), lot.supply_kg);
        assert!(open.len() <= 1);
        assert_eq!(
            matches!(lot.state, LotState::Prepared | LotState::InTransit),
            open.len() == 1
        );
        for class_key in &self.classes {
            let class: CustodianClass = self.f.read(*class_key);
            let ordinary = if lot.state == LotState::Stored && lot.custodian_class == *class_key {
                lot.supply_kg
            } else {
                0
            };
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

/// The demo world with CR-0001 shipped in one batch that has departed: Mosela Haulage holds it.
fn in_transit() -> (World, Pubkey, Pubkey) {
    let mut w = World::demo();
    let (shipment, batch) = w.ship_demo();
    w.depart(batch);
    assert_eq!(w.batch_state(batch).holder, w.transporter);
    (w, shipment, batch)
}

// ================================================================ the demo beat ====

#[test]
fn record_observation_border_keeps_holder() {
    let (mut w, shipment, batch) = in_transit();
    let shipment_before = w.shipment_state(shipment);
    let lot_before = w.lot_state();
    let args = w.border_args(batch);
    assert_eq!(args.expected_observation, 0);
    assert_eq!(args.observer_org, w.transporter);
    assert_eq!(args.holder_org, w.transporter);
    assert_eq!(w.observe_ok(&args), 0);

    // A border observation is never a handover (A10): no HandoverRecord, the same holder,
    // stage and sequence, and the shipment and lot byte for byte.
    let stored = w.batch_state(batch);
    assert_eq!(stored.holder, w.transporter);
    assert_eq!(stored.stage, BatchStage::InTransit);
    assert_eq!(stored.sequence, 1);
    assert_eq!(stored.observation_count, 1);
    assert!(!w.f.account_exists(handover_key(batch, 1)));
    assert_eq!(
        w.shipment_state(shipment).revision,
        shipment_before.revision
    );
    assert_eq!(w.shipment_state(shipment).status, ShipmentStatus::InTransit);
    assert_eq!(w.lot_state().revision, lot_before.revision);
    assert_eq!(w.lot_state().state, LotState::InTransit);

    // The next observation of the batch takes the next index.
    let mut next = w.border_args(batch);
    next.location_code = "BORDER-2".into();
    assert_eq!(next.expected_observation, 1);
    assert_eq!(w.observe_ok(&next), 1);

    // The batch still arrives with Mosela as the sender.
    w.arrive(batch);
    assert_eq!(w.batch_state(batch).observation_count, 2);
}

#[test]
fn record_observation_by_terminal_and_inspector() {
    let (mut w, _, batch) = in_transit();
    // Port Terminal T1 records a border crossing of a batch Mosela holds.
    let args = w.observe_args(batch, Custodian2, w.terminal, ObservationKind::Border);
    w.observe_ok(&args);
    // Inspector Test Org records a checkpoint.
    let mut args = w.observe_args(batch, Inspector, w.inspector, ObservationKind::Checkpoint);
    args.location_code = CHECKPOINT.into();
    assert_eq!(args.holder_org, w.transporter);
    assert_eq!(w.observe_ok(&args), 1);
    assert_eq!(w.batch_state(batch).holder, w.transporter);
}

#[test]
fn record_observation_at_source_and_after_arrival() {
    // Only a cancelled shipment is refused: a batch still at its source and a batch of an
    // arrived shipment can both be observed.
    let mut w = World::demo();
    let (shipment, batch) = w.ship_demo();
    let mut args = w.observe_args(batch, Custodian, w.custodian, ObservationKind::Checkpoint);
    args.location_code = CHECKPOINT.into();
    assert_eq!(args.holder_org, w.custodian);
    w.observe_ok(&args);
    assert_eq!(w.batch_state(batch).stage, BatchStage::AtSource);

    w.depart(batch);
    w.arrive(batch);
    assert_eq!(w.shipment_state(shipment).status, ShipmentStatus::Arrived);
    let mut args = w.observe_args(batch, Custodian2, w.terminal, ObservationKind::Checkpoint);
    args.location_code = DESTINATION_SITE.into();
    assert_eq!(args.holder_org, w.terminal);
    assert_eq!(w.observe_ok(&args), 1);
}

#[test]
fn record_observation_is_never_paused() {
    let (mut w, _, batch) = in_transit();
    let pause = w.f.change_pause(Admin, pause::ALL, true);
    w.f.ok(pause, Admin);
    let args = w.border_args(batch);
    w.observe_ok(&args);
}

// ============================================================ authority and role ====

#[test]
fn record_observation_rejects_scope_missing() {
    let (mut w, _, batch) = in_transit();
    // Another haulier: a Transporter Authority with CARRY only.
    let args = w.observe_args(batch, OtherDriver, w.other_haulier, ObservationKind::Border);
    w.observe_refused(&args, ScopeMissing);
}

#[test]
fn record_observation_rejects_observer_without_authority() {
    let (mut w, _, batch) = in_transit();
    // The refused observer: a Mosela Haulage member's second wallet, linked but with no
    // Authority. The relay passes the Authority PDA derived from that wallet, which does not
    // exist, so Anchor refuses the account before the handler runs.
    let args = w.observe_args(
        batch,
        UnlinkedDriver,
        w.transporter,
        ObservationKind::Border,
    );
    assert!(!w.f.account_exists(w.authority_of(UnlinkedDriver)));
    let instructions = w.observation(&args);
    w.f.sponsored_refused_anchor(&instructions, 1, AnchorError::AccountNotInitialized);
    assert_eq!(w.batch_state(batch).observation_count, 0);
    w.assert_invariants();
}

#[test]
fn record_observation_rejects_revoked_or_expired_authority() {
    let (mut w, _, batch) = in_transit();
    let args = w.border_args(batch);
    // The organisation revokes the driver's Authority.
    let revoke = w.f.revoke(OrgAdmin, w.transporter, w.authority_of(Driver));
    w.f.ok(revoke, OrgAdmin);
    w.observe_refused(&args, AuthorityRevoked);
    // An unrevoked Authority that expires at the block time.
    w.f.forge_authority(
        w.transporter,
        w.f.key(Driver),
        scope::CARRY | scope::OBSERVE,
        w.now,
    );
    w.observe_refused(&args, AuthorityExpired);
}

#[test]
fn record_observation_rejects_authority_of_another_organisation() {
    let (mut w, _, batch) = in_transit();
    // Mosela's driver signs with Mosela's Authority but names Port Terminal T1 as observer.
    let mut args = w.border_args(batch);
    args.observer_org = w.terminal;
    w.observe_refused(&args, WrongOrganisation);
}

#[test]
fn record_observation_border_rejects_custodian_observer() {
    let mut w = World::demo();
    let (_, batch) = w.ship_demo();
    // Kopano Stockyard Custody, a Custodian with OBSERVE, records a border crossing.
    let border = w.observe_args(batch, Custodian, w.custodian, ObservationKind::Border);
    w.observe_refused(&border, WrongRole);
    // The same Authority's checkpoint succeeds.
    let mut checkpoint = border.clone();
    checkpoint.kind = ObservationKind::Checkpoint;
    w.observe_ok(&checkpoint);
    // An inspector can't record a border crossing either.
    let border = w.observe_args(batch, Inspector, w.inspector, ObservationKind::Border);
    w.observe_refused(&border, WrongRole);
}

#[test]
fn record_observation_checkpoint_rejects_role_outside_observe() {
    let (mut w, _, batch) = in_transit();
    // delegate_authority never grants OBSERVE to an Exporter, so the harness writes one: the
    // role check by kind is defence in depth.
    w.f.forge_authority(
        w.owner,
        w.f.key(Owner),
        scope::SHIP | scope::OBSERVE,
        w.now + AUTHORITY_LIFETIME,
    );
    for kind in [ObservationKind::Checkpoint, ObservationKind::Border] {
        let args = w.observe_args(batch, Owner, w.owner, kind);
        w.observe_refused(&args, WrongRole);
    }
}

// ============================================================== bindings ====

#[test]
fn record_observation_rejects_wrong_holder_named() {
    let (mut w, _, batch) = in_transit();
    // Mosela holds the batch; the text names Kopano Stockyard Custody as holder.
    let mut args = w.border_args(batch);
    args.holder_org = w.custodian;
    w.observe_refused(&args, WrongOrganisation);
}

#[test]
fn record_observation_rejects_batch_of_another_shipment_or_lot() {
    let mut w = World::demo();
    let (first_shipment, first_batch) = w.ship_demo();
    w.cancel(first_shipment);
    let (second_shipment, second_batch) = w.ship_as(SHIPMENT_TWO, 0x35);
    // A batch passed with a shipment it does not belong to.
    let mut args = w.observe_args(
        second_batch,
        Custodian,
        w.custodian,
        ObservationKind::Checkpoint,
    );
    args.shipment = first_shipment;
    w.observe_refused(&args, WrongOrganisation);
    // The binding runs before the cancelled-shipment refusal.
    let mut args = w.observe_args(
        first_batch,
        Custodian,
        w.custodian,
        ObservationKind::Checkpoint,
    );
    args.shipment = second_shipment;
    w.observe_refused(&args, WrongOrganisation);
    // A lot that is not the shipment's: a copy of CR-0001's account at another address.
    let copy = Pubkey::new_unique();
    let lot = w.lot_state();
    w.f.set_program_account(copy, &lot);
    let mut args = w.observe_args(
        second_batch,
        Custodian,
        w.custodian,
        ObservationKind::Checkpoint,
    );
    args.lot = copy;
    w.observe_refused(&args, WrongOrganisation);
}

#[test]
fn record_observation_rejects_accounts_of_another_protocol() {
    let (mut w, shipment, batch) = in_transit();
    let foreign = Pubkey::new_unique();
    let args = w.border_args(batch);
    let original = w.batch_state(batch);
    let mut rewritten = original.clone();
    rewritten.protocol = foreign;
    w.f.set_program_account(batch, &rewritten);
    w.observe_refused(&args, WrongOrganisation);
    // The role check by kind runs before the protocol rule.
    let custodian_border = w.observe_args(batch, Custodian, w.custodian, ObservationKind::Border);
    w.observe_refused(&custodian_border, WrongRole);
    w.f.set_program_account(batch, &original);

    let original = w.shipment_state(shipment);
    let mut rewritten = original.clone();
    rewritten.protocol = foreign;
    w.f.set_program_account(shipment, &rewritten);
    w.observe_refused(&args, WrongOrganisation);
    w.f.set_program_account(shipment, &original);

    let original = w.lot_state();
    let mut rewritten = original.clone();
    rewritten.protocol = foreign;
    w.f.set_program_account(w.lot, &rewritten);
    w.observe_refused(&args, WrongOrganisation);
    w.f.set_program_account(w.lot, &original);

    // Restored, the observation goes through.
    w.observe_ok(&args);
}

// ======================================================== counter and refusals ====

#[test]
fn record_observation_rejects_replayed_text() {
    let (mut w, _, batch) = in_transit();
    let args = w.border_args(batch);
    let instructions = w.observation(&args);
    w.observe_ok(&args);
    // The same signed text again: its observation index is used.
    w.observe_instructions_refused(&instructions, StaleRevision);
    // An index ahead of the batch's count is refused too.
    let mut ahead = w.border_args(batch);
    ahead.expected_observation += 1;
    w.observe_refused(&ahead, StaleRevision);
    assert_eq!(w.batch_state(batch).observation_count, 1);
}

#[test]
fn record_observation_rejects_cancelled_shipment() {
    let mut w = World::demo();
    let (shipment, batch) = w.ship_demo();
    w.cancel(shipment);
    let args = w.observe_args(batch, Custodian, w.custodian, ObservationKind::Checkpoint);
    w.observe_refused(&args, ShipmentNotOpen);
}

#[test]
fn record_observation_rejects_bad_fields() {
    let (mut w, _, batch) = in_transit();
    let valid = w.border_args(batch);
    let cases: Vec<(&str, ObserveArgs)> = vec![
        (
            "lowercase location",
            ObserveArgs {
                location_code: "border-1".into(),
                ..valid.clone()
            },
        ),
        (
            "empty location",
            ObserveArgs {
                location_code: String::new(),
                ..valid.clone()
            },
        ),
        (
            "17-byte location",
            ObserveArgs {
                location_code: "BORDER-1-WEST-GAT".into(),
                ..valid.clone()
            },
        ),
        (
            "location with a space",
            ObserveArgs {
                location_code: "BORDER 1".into(),
                ..valid.clone()
            },
        ),
        (
            "zero evidence",
            ObserveArgs {
                evidence_digest: [0; 32],
                ..valid.clone()
            },
        ),
        (
            "future observed_at",
            ObserveArgs {
                observed_at: w.now + 1,
                ..valid.clone()
            },
        ),
        (
            "negative observed_at",
            ObserveArgs {
                observed_at: -1,
                ..valid.clone()
            },
        ),
    ];
    for (label, args) in cases {
        println!("{label}");
        w.observe_refused(&args, InvalidField);
    }
    // The bounds: a 16-byte location photographed at the block time.
    let edge = ObserveArgs {
        location_code: "BORDER-1-WEST-GA".into(),
        observed_at: w.now,
        ..valid
    };
    w.observe_ok(&edge);
}

#[test]
fn record_observation_rejects_counter_overflow() {
    let (mut w, _, batch) = in_transit();
    let mut stored = w.batch_state(batch);
    stored.observation_count = u32::MAX;
    w.f.set_program_account(batch, &stored);
    let args = w.border_args(batch);
    assert_eq!(args.expected_observation, u32::MAX);
    w.observe_refused(&args, ArithmeticOverflow);
}

// ================================================================ the window ====

#[test]
fn record_observation_rejects_window_601() {
    let (mut w, _, batch) = in_transit();
    let mut args = w.border_args(batch);
    args.valid_until = w.now + 601;
    w.observe_refused(&args, WindowTooLong);
    args.valid_until = w.now + 600;
    w.observe_ok(&args);
}

#[test]
fn record_observation_rejects_expired_text() {
    let (mut w, _, batch) = in_transit();
    let mut args = w.border_args(batch);
    args.valid_until = w.now - 1;
    w.observe_refused(&args, Expired);
}

// ============================================================== the signature ====

#[test]
fn record_observation_rejects_wrong_signature() {
    let (mut w, _, batch) = in_transit();
    let args = w.border_args(batch);
    let text = w.observation_text(&args);
    // Another wallet signs the right text.
    let instructions = w.observation_signed(&args, OtherDriver, &text);
    w.observe_instructions_refused(&instructions, WrongSigner);
    // The observer signs a text with another location than the arguments carry.
    let other = ObserveArgs {
        location_code: "BORDER-2".into(),
        ..args.clone()
    };
    let other_text = w.observation_text(&other);
    let instructions = w.observation_signed(&args, Driver, &other_text);
    w.observe_instructions_refused(&instructions, MessageMismatch);
    // No signature at all.
    let instructions = [w.observation_instruction(&args)];
    w.f.sponsored_refused(&instructions, 0, MissingVerification);
    w.observe_ok(&args);
}

// ============================================================== known answers ====

const OBSERVATION_TEXT: &str = "Thetis authorisation v1
Network: devnet
Program: jGJpdjtoDUtXMjvc4UaEi1mBeFZKqVfe9jL8ireHMs3
Protocol: 00112233445566778899aabbccddeeff
Action: Record observation
Lot: CR-0001
Shipment: 22222222222222222222222222222222
Batch: 1 of 1
Holder: Mosela Haulage
Observer: Mosela Haulage
Kind: Border
Location: BORDER-1
Evidence: 7777777777777777777777777777777777777777777777777777777777777777
Observed at: 2026-11-19 16:27:05 SAST
Observation: 0
Valid until: 2026-11-19 16:32:05 SAST
Test network only. Synthetic data.";

#[test]
fn observation_message_known_answer() {
    let instance: [u8; 16] = std::array::from_fn(|index| u8::try_from(index * 0x11).unwrap());
    let build = |kind| {
        observation_message(
            &ID,
            &instance,
            "CR-0001",
            &[0x22; 16],
            1,
            1,
            "Mosela Haulage",
            "Mosela Haulage",
            kind,
            "BORDER-1",
            &[0x77; 32],
            1_795_098_425,
            0,
            1_795_098_725,
        )
    };
    let text = build(ObservationKind::Border);
    assert_eq!(String::from_utf8(text.clone()).unwrap(), OBSERVATION_TEXT);
    assert_eq!(text.len(), 513);
    assert_eq!(
        sha256_hex(&text),
        "629424cd51436a48b5e2254e3faa2c952da9825f787dd852875dd986b368bb1b"
    );
    // A checkpoint prints its kind on the same line.
    assert_eq!(
        String::from_utf8(build(ObservationKind::Checkpoint)).unwrap(),
        OBSERVATION_TEXT.replace("\nKind: Border\n", "\nKind: Checkpoint\n")
    );
}

// ============================================================ transaction size ====

/// Two distinct 48-byte names and 16-byte lot id and location (§11.1).
const WIDEST_HOLDER: &str = "Mosela Haulage And Allied Bulk Transport Pty 001";
const WIDEST_OBSERVER: &str = "Port Terminal T1 And Allied Bulk Terminals Pty 1";
const WIDEST_LOT_ID: &str = "CR-0001-WIDEST-1";
const WIDEST_LOCATION: &str = "BORDER-1-WEST-GA";

#[test]
fn record_observation_size_fits_v0_widest() {
    let (mut w, shipment, batch) = in_transit();
    // The demo: Mosela observes the batch it holds (one organisation in both slots).
    let demo = w.border_args(batch);
    // The widest: Port Terminal T1 observes a batch Mosela holds (eight distinct table keys).
    let widest = ObserveArgs {
        observer_signer: Custodian2,
        observer_org: w.terminal,
        kind: ObservationKind::Checkpoint,
        location_code: WIDEST_LOCATION.into(),
        observed_at: i64::MAX,
        expected_observation: u32::MAX,
        valid_until: i64::MAX,
        ..demo.clone()
    };
    // The instance's table already holds every key: the observation creates no account.
    let shared = vec![
        INSTRUCTIONS_SYSVAR,
        w.f.protocol,
        w.transporter,
        shipment,
        w.lot,
    ];
    let demo_readonly = [shared.clone(), vec![w.authority_of(Driver)]].concat();
    let readonly = [shared, vec![w.terminal, w.authority_of(Custodian2)]].concat();
    let writable = vec![batch];
    let mut addresses = demo_readonly.clone();
    addresses.extend(&readonly[5..]);
    addresses.extend(&writable);
    let table = w.f.create_lookup_table(addresses);
    let inline = vec![w.f.payer(), ID, ED25519, COMPUTE_BUDGET];
    let instructions = w.observation(&demo);
    let (tx, demo_size) = observation_v0(
        &mut w,
        &table,
        instructions,
        inline.clone(),
        writable.clone(),
        demo_readonly,
    );
    let meta =
        w.f.send(tx)
            .unwrap_or_else(|failure| panic!("{:?}\n{}", failure.err, failure.meta.pretty_logs()));
    let units = meta.compute_units_consumed;
    assert!(
        units < u64::from(COMPUTE_UNIT_LIMIT),
        "record_observation used {units} CU"
    );
    println!("record_observation v0 demo: {units} CU, {demo_size} bytes");
    assert_eq!(w.batch_state(batch).observation_count, 1);
    assert_eq!(w.batch_state(batch).holder, w.transporter);
    w.assert_invariants();

    for name in [WIDEST_HOLDER, WIDEST_OBSERVER] {
        assert_eq!(name.len(), MAX_DISPLAY_NAME);
    }
    assert_ne!(WIDEST_HOLDER, WIDEST_OBSERVER);
    assert_eq!(WIDEST_LOT_ID.len(), MAX_LOT_ID);
    assert_eq!(WIDEST_LOCATION.len(), 16);
    let text = observation_message(
        &ID,
        &INSTANCE,
        WIDEST_LOT_ID,
        &SHIPMENT_ONE,
        16,
        16,
        WIDEST_HOLDER,
        WIDEST_OBSERVER,
        ObservationKind::Checkpoint,
        WIDEST_LOCATION,
        &EVIDENCE,
        i64::MAX,
        u32::MAX,
        i64::MAX,
    );
    assert_eq!(text.len(), 629);
    // protocol, observer_org, observer_authority, holder_org, shipment, batch, lot, Ix (§10).
    assert_eq!(readonly.len() + writable.len(), 8);
    let instructions = w.observation_signed(&widest, Custodian2, &text);
    let (_, widest_size) = observation_v0(&mut w, &table, instructions, inline, writable, readonly);
    println!("record_observation v0 widest: {widest_size} bytes");
    assert_eq!(widest_size, 1_120);
}

/// Compiles `[compute budget, verify, record_observation]` as a sponsored v0 transaction
/// against `table` and checks that only the sponsor signs, that `inline` are the only static
/// keys, and that the table supplies exactly `writable` and `readonly`.
fn observation_v0(
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
