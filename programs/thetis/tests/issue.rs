mod common;

use anchor_lang::prelude::Pubkey;
use common::{Actor::*, *};
use litesvm::types::TransactionMetadata;
use solana_keypair::Keypair;
use solana_transaction::Instruction;
use thetis::{
    accounts,
    error::ThetisError::*,
    events, instruction,
    intent::message::issue_message,
    state::{self, *},
    ID,
};

const TOKEN_2022: Pubkey = anchor_spl::token_2022::ID;
const ASSOCIATED_TOKEN: Pubkey = anchor_spl::associated_token::ID;
const INSTRUCTIONS_SYSVAR: Pubkey = solana_sdk_ids::sysvar::instructions::ID;
const PACKET_DATA_SIZE: usize = 1232;
const COMPUTE_UNIT_LIMIT: u32 = 400_000;
const LOT_VALIDITY: i64 = 30 * 86_400;
const DAY: i64 = 86_400;

const INTAKE_DIGEST: [u8; 32] = digest(0x00);
const SECOND_DIGEST: [u8; 32] = digest(0x80);
const ORIGIN_SHA256: [u8; 32] = digest(0x20);
const SECOND_ORIGIN_SHA256: [u8; 32] = digest(0xa0);

/// 32 ascending bytes from `base`, the shape of the signed-text known-answer vector.
const fn digest(base: u8) -> [u8; 32] {
    let mut bytes = [0; 32];
    let mut index = 0;
    while index < 32 {
        bytes[index] = base + index as u8;
        index += 1;
    }
    bytes
}

/// Organisation ids in the demo world.
const OWNER_ID: u8 = 1;
const CUSTODIAN_ID: u8 = 2;
const ISSUER_ID: u8 = 3;
const OTHER_ISSUER_ID: u8 = 4;
const BUYER_ID: u8 = 5;
const OTHER_CUSTODIAN_ID: u8 = 6;

/// Everything about the demo world that a test may need to vary.
struct Spec {
    class_code: &'static str,
    class_version: u32,
    grades: [&'static str; 2],
    origin_required: bool,
    owner_name: &'static str,
    custodian_name: &'static str,
    site_code: &'static str,
    approved_capacity_kg: u64,
    custodian_scopes: u16,
    custodian_expires_at: i64,
    document_version: u32,
    document_valid_until: i64,
}

impl Spec {
    fn demo() -> Self {
        Self {
            class_code: "CHROME",
            class_version: 1,
            grades: ["A", "B"],
            origin_required: true,
            owner_name: "Khunou Ore Exports",
            custodian_name: "Kopano Stockyard Custody",
            site_code: "PORT-STOCKYARD",
            approved_capacity_kg: 10_000_000,
            custodian_scopes: state::scope::ISSUE,
            custodian_expires_at: NOW + DAY,
            document_version: 1,
            document_valid_until: NOW + DAY,
        }
    }

    /// The widest values the state allows, so the transaction is as large as it can get.
    fn widest() -> Self {
        Self {
            class_code: "CHROMEXX",
            class_version: u32::MAX,
            grades: ["GRADEAAA", "B"],
            owner_name: "Khunou Ore Exports And Allied Holdings Pty Ltd 1",
            custodian_name: "Kopano Stockyard Custody And Storage Services 02",
            site_code: "PORT-STOCKYARD-1",
            approved_capacity_kg: u64::MAX,
            document_version: u32::MAX,
            ..Self::demo()
        }
    }
}

/// One `issue_lot` call, with every input a test may vary.
#[derive(Clone)]
struct IssueArgs {
    lot_id: String,
    grade: String,
    quantity_kg: u64,
    intake_digest: [u8; 32],
    valid_until: i64,
    owner: Pubkey,
    origin: Option<Pubkey>,
    origin_issuer: Option<Pubkey>,
    /// The Authority account passed; the custodian's own when `None`.
    authority: Option<Pubkey>,
    /// Who signs the text, in entry order.
    signers: Vec<Actor>,
    /// The instruction-index field of every Ed25519 entry.
    ed25519_index: u16,
    /// A text to sign instead of the one the program will rebuild.
    text: Option<Vec<u8>>,
}

/// The addresses `issue_lot` derives for one call.
struct Addresses {
    intake: Pubkey,
    lot: Pubkey,
    mint: Pubkey,
    mint_authority: Pubkey,
    position: Pubkey,
    vault_authority: Pubkey,
    vault: Pubkey,
}

struct World {
    f: Fixture,
    spec: Spec,
    /// The clock, mirrored here so intents are signed relative to it.
    now: i64,
    owner: Pubkey,
    custodian: Pubkey,
    issuer_org: Pubkey,
    class_policy: Pubkey,
    custodian_class: Pubkey,
    authority: Pubkey,
    /// The Origin attestation for `INTAKE_DIGEST`, when the class requires one.
    document: Option<Pubkey>,
}

impl World {
    fn demo() -> Self {
        Self::build(Spec::demo())
    }

    fn build(spec: Spec) -> Self {
        let mut f = Fixture::initialized();
        let class_policy = f.class(spec.class_code, spec.class_version);
        let register = f.register_with_origin(
            Accreditor,
            spec.class_code,
            spec.class_version,
            &spec.grades,
            LOT_VALIDITY,
            spec.origin_required,
        );
        f.ok(register, Accreditor);

        let owner = f.organisation(OWNER_ID);
        let accredit = f.accredit(Accreditor, OWNER_ID, Role::Exporter, spec.owner_name);
        f.ok(accredit, Accreditor);
        let custodian = f.organisation(CUSTODIAN_ID);
        let accredit = f.accredit(
            Accreditor,
            CUSTODIAN_ID,
            Role::Custodian,
            spec.custodian_name,
        );
        f.ok(accredit, Accreditor);
        let issuer_org = f.add_org(ISSUER_ID, Role::DocumentIssuer);

        let delegate = f.delegate(
            OrgAdmin,
            issuer_org,
            f.key(Issuer),
            state::scope::ATTEST_ORIGIN,
            NOW + DAY,
        );
        f.ok(delegate, OrgAdmin);
        let document = spec.origin_required.then(|| {
            let attest = f.attest(
                Issuer,
                issuer_org,
                DocumentKind::Origin,
                INTAKE_DIGEST,
                spec.document_version,
                ORIGIN_SHA256,
                spec.document_valid_until,
            );
            f.ok(attest, Issuer);
            f.document(DocumentKind::Origin, INTAKE_DIGEST, spec.document_version)
        });

        let custodian_class = f.site(custodian, class_policy, spec.site_code);
        let accredit_site = f.accredit_site(
            Accreditor,
            custodian,
            class_policy,
            spec.site_code,
            spec.approved_capacity_kg,
        );
        f.ok(accredit_site, Accreditor);
        let delegate = f.delegate(
            OrgAdmin,
            custodian,
            f.key(Custodian),
            spec.custodian_scopes,
            spec.custodian_expires_at,
        );
        f.ok(delegate, OrgAdmin);

        let authority = f.authority(f.key(Custodian));
        Self {
            f,
            spec,
            now: NOW,
            owner,
            custodian,
            issuer_org,
            class_policy,
            custodian_class,
            authority,
            document,
        }
    }

    fn advance_to(&mut self, unix_timestamp: i64) {
        self.now = unix_timestamp;
        self.f.set_time(unix_timestamp);
    }

    /// The demo issue: lot CR-0001, grade A, 5,000.000 t, signed for ten minutes.
    fn demo_args(&self) -> IssueArgs {
        IssueArgs {
            lot_id: "CR-0001".into(),
            grade: "A".into(),
            quantity_kg: 5_000_000,
            intake_digest: INTAKE_DIGEST,
            valid_until: self.now + 570,
            owner: self.owner,
            origin: self.document,
            origin_issuer: self.document.map(|_| self.issuer_org),
            authority: None,
            signers: vec![Custodian],
            ed25519_index: u16::MAX,
            text: None,
        }
    }

    /// A second lot on a second intake digest, with its own attested origin document.
    fn second_args(&mut self) -> IssueArgs {
        let document = self.attest_origin(SECOND_DIGEST, SECOND_ORIGIN_SHA256, self.issuer_org);
        IssueArgs {
            lot_id: "CR-0002".into(),
            intake_digest: SECOND_DIGEST,
            origin: Some(document),
            ..self.demo_args()
        }
    }

    /// Attests an Origin document for `subject` (version 1) as the Issuer wallet.
    fn attest_origin(&mut self, subject: [u8; 32], sha256: [u8; 32], issuer_org: Pubkey) -> Pubkey {
        let attest = self.f.attest(
            Issuer,
            issuer_org,
            DocumentKind::Origin,
            subject,
            1,
            sha256,
            NOW + DAY,
        );
        self.f.ok(attest, Issuer);
        self.f.document(DocumentKind::Origin, subject, 1)
    }

    fn addresses(&self, args: &IssueArgs) -> Addresses {
        let protocol = self.f.protocol;
        let intake = pda(&[
            b"intake",
            protocol.as_ref(),
            self.custodian.as_ref(),
            &args.intake_digest,
        ]);
        let lot = pda(&[b"lot", protocol.as_ref(), args.lot_id.as_bytes()]);
        let mint = pda(&[b"mint", lot.as_ref()]);
        let mint_authority = pda(&[b"mint_authority", mint.as_ref()]);
        let position = pda(&[b"position", lot.as_ref(), args.owner.as_ref()]);
        let vault_authority = pda(&[b"vault", position.as_ref()]);
        let vault = Pubkey::find_program_address(
            &[vault_authority.as_ref(), TOKEN_2022.as_ref(), mint.as_ref()],
            &ASSOCIATED_TOKEN,
        )
        .0;
        Addresses {
            intake,
            lot,
            mint,
            mint_authority,
            position,
            vault_authority,
            vault,
        }
    }

    /// The text the program rebuilds from chain state and the arguments (program-lots.md §6.2).
    fn text(&self, args: &IssueArgs) -> Vec<u8> {
        let owner = self.f.read::<Organisation>(args.owner).display_name;
        let custodian = self.f.read::<Organisation>(self.custodian).display_name;
        let origin = args
            .origin
            .map(|document| self.f.read::<DocumentAttestation>(document));
        issue_message(
            &ID,
            &INSTANCE,
            &args.lot_id,
            self.spec.class_code,
            self.spec.class_version,
            &args.grade,
            args.quantity_kg,
            &owner,
            &custodian,
            self.spec.site_code,
            &args.intake_digest,
            origin
                .as_ref()
                .map(|document| (&document.sha256, document.version)),
            args.valid_until,
        )
    }

    /// The Ed25519 verification instruction followed by `issue_lot`.
    fn issue(&self, args: &IssueArgs) -> [Instruction; 2] {
        let text = args.text.clone().unwrap_or_else(|| self.text(args));
        let entries: Vec<(&Keypair, &[u8])> = args
            .signers
            .iter()
            .map(|actor| (self.f.signer(*actor), text.as_slice()))
            .collect();
        [
            ed25519_instruction_at(&entries, args.ed25519_index),
            self.issue_instruction(args),
        ]
    }

    fn issue_instruction(&self, args: &IssueArgs) -> Instruction {
        let a = self.addresses(args);
        ix(
            accounts::IssueLot {
                sponsor: self.f.payer(),
                protocol: self.f.protocol,
                authority: args.authority.unwrap_or(self.authority),
                owner: args.owner,
                custodian: self.custodian,
                class_policy: self.class_policy,
                custodian_class: self.custodian_class,
                origin: args.origin,
                origin_issuer: args.origin_issuer,
                intake: a.intake,
                lot: a.lot,
                mint: a.mint,
                mint_authority: a.mint_authority,
                position: a.position,
                vault_authority: a.vault_authority,
                vault: a.vault,
                instructions: INSTRUCTIONS_SYSVAR,
                token_program: TOKEN_2022,
                associated_token_program: ASSOCIATED_TOKEN,
                system_program: SYSTEM,
            },
            instruction::IssueLot {
                lot_id: args.lot_id.clone(),
                grade: args.grade.clone(),
                quantity_kg: args.quantity_kg,
                intake_digest: args.intake_digest,
                valid_until: args.valid_until,
            },
        )
    }

    fn occupied_kg(&self) -> u64 {
        self.f
            .read::<CustodianClass>(self.custodian_class)
            .occupied_kg
    }

    /// Sends the issue and checks every effect program-lots.md §6.1 and §10 promise.
    fn issue_ok(&mut self, args: &IssueArgs) -> TransactionMetadata {
        let occupied_before = self.occupied_kg();
        let instructions = self.issue(args);
        let tx = self.f.sponsored_ok(&instructions);
        self.assert_issued(args, &tx, occupied_before);
        tx
    }

    fn assert_issued(&self, args: &IssueArgs, tx: &TransactionMetadata, occupied_before: u64) {
        let f = &self.f;
        let a = self.addresses(args);

        let lot: Lot = f.read(a.lot);
        assert_eq!(lot.protocol, f.protocol);
        assert_eq!(lot.lot_id, args.lot_id);
        assert_eq!(lot.class_policy, self.class_policy);
        assert_eq!(lot.class_version, self.spec.class_version);
        assert_eq!(lot.grade, args.grade);
        assert_eq!(lot.custodian_class, self.custodian_class);
        assert_eq!(lot.intake, a.intake);
        assert_eq!(lot.parent, None);
        assert_eq!(lot.root, a.lot);
        assert_eq!(lot.mint, a.mint);
        assert_eq!(lot.supply_kg, args.quantity_kg);
        assert_eq!(lot.state, LotState::Stored);
        assert_eq!(lot.restriction, Restriction::Normal);
        assert_eq!(lot.expires_at, self.now + LOT_VALIDITY);
        assert_eq!(lot.revision, 0);
        assert_eq!(lot.live_children, 0);

        let intake: IntakeIdentity = f.read(a.intake);
        assert_eq!(intake.protocol, f.protocol);
        assert_eq!(intake.custodian, self.custodian);
        assert_eq!(intake.intake_digest, args.intake_digest);
        assert_eq!(intake.lot, a.lot);
        assert!(!intake.retired);

        let position: Position = f.read(a.position);
        assert_eq!(position.protocol, f.protocol);
        assert_eq!(position.lot, a.lot);
        assert_eq!(position.owner, args.owner);
        assert_eq!(position.quantity_kg, args.quantity_kg);
        assert_eq!(position.locked_kg, 0);
        assert_eq!(position.reserved_kg, 0);
        assert_eq!(position.revision, 0);

        assert_eq!(f.owner(a.mint), Some(TOKEN_2022));
        assert_eq!(f.owner(a.vault), Some(TOKEN_2022));
        assert_eq!(f.mint_supply(a.mint), args.quantity_kg);
        assert_eq!(f.token_amount(a.vault), args.quantity_kg);
        // Seed-checked signing PDAs hold no account.
        assert!(!f.account_exists(a.mint_authority));
        assert!(!f.account_exists(a.vault_authority));

        assert_eq!(lot.supply_kg, position.quantity_kg);
        assert_eq!(position.quantity_kg, f.token_amount(a.vault));
        assert_eq!(f.token_amount(a.vault), f.mint_supply(a.mint));
        assert_eq!(self.occupied_kg(), occupied_before + args.quantity_kg);

        assert_event(
            tx,
            events::LotIssued {
                lot: a.lot,
                owner: args.owner,
                quantity_kg: args.quantity_kg,
                intake: a.intake,
                revision: 0,
            },
        );
    }

    /// The Ed25519 instruction is index 0 and `issue_lot` index 1 of a sponsored transaction.
    fn assert_refused(&mut self, args: &IssueArgs, expected: thetis::error::ThetisError) {
        let instructions = self.issue(args);
        self.f.sponsored_refused(&instructions, 1, expected);
        assert!(!self.f.account_exists(self.addresses(args).lot));
    }

    /// Every account an issue may touch that is not the sponsor or the program itself.
    fn table_addresses(&self, args: &IssueArgs) -> Vec<Pubkey> {
        let a = self.addresses(args);
        let mut addresses = vec![
            SYSTEM,
            TOKEN_2022,
            ASSOCIATED_TOKEN,
            INSTRUCTIONS_SYSVAR,
            self.f.protocol,
            self.class_policy,
            self.custodian_class,
            self.owner,
            self.custodian,
            self.authority,
            a.intake,
            a.lot,
            a.mint,
            a.mint_authority,
            a.position,
            a.vault,
            a.vault_authority,
        ];
        addresses.extend(args.origin);
        addresses.extend(args.origin_issuer);
        addresses
    }

    /// Issues through a v0 transaction with a lookup table, asserting that it fits in one
    /// packet and in the compute budget it asks for. Returns `(bytes, compute units)`.
    fn issue_v0(&mut self, args: &IssueArgs) -> (usize, u64) {
        let table = self.f.create_lookup_table(self.table_addresses(args));
        let limit = Instruction {
            program_id: solana_sdk_ids::compute_budget::ID,
            accounts: vec![],
            data: [vec![2], COMPUTE_UNIT_LIMIT.to_le_bytes().to_vec()].concat(),
        };
        let [verify, issue] = self.issue(args);
        let tx = self.f.sponsored_v0(&[limit, verify, issue], &[table]);
        assert_eq!(tx.signatures.len(), 1, "only the sponsor signs");
        let size = transaction_size(&tx);
        assert!(
            size <= PACKET_DATA_SIZE,
            "issue v0 transaction is {size} bytes"
        );

        let occupied_before = self.occupied_kg();
        let meta = self
            .f
            .send(tx)
            .unwrap_or_else(|failure| panic!("{:?}\n{}", failure.err, failure.meta.pretty_logs()));
        let units = meta.compute_units_consumed;
        assert!(
            units <= u64::from(COMPUTE_UNIT_LIMIT),
            "issue used {units} compute units"
        );
        self.assert_issued(args, &meta, occupied_before);
        (size, units)
    }
}

#[test]
fn issue_lot_demo_succeeds() {
    let mut w = World::demo();
    let args = w.demo_args();

    let text = String::from_utf8(w.text(&args)).unwrap();
    assert!(text.contains("\nAction: Issue lot\n"));
    assert!(text.contains("\nLot: CR-0001\n"));
    assert!(text.contains("\nQuantity: 5,000.000 t\n"));
    assert!(text.contains("\nOwner: Khunou Ore Exports\n"));
    assert!(text.contains("\nCustodian: Kopano Stockyard Custody\n"));
    assert!(text.contains("\nSite: PORT-STOCKYARD\n"));
    assert!(text.contains("\nOrigin document: 202122"));

    w.issue_ok(&args);
}

#[test]
fn issue_succeeds_exactly_at_capacity() {
    let mut w = World::demo();
    w.issue_ok(&w.demo_args());
    let remaining = w.spec.approved_capacity_kg - w.occupied_kg();
    let second = IssueArgs {
        quantity_kg: remaining,
        ..w.second_args()
    };

    w.issue_ok(&second);

    assert_eq!(w.occupied_kg(), w.spec.approved_capacity_kg);
}

#[test]
fn issue_accepts_class_without_origin_required() {
    let mut w = World::build(Spec {
        origin_required: false,
        ..Spec::demo()
    });
    let args = w.demo_args();
    assert_eq!((args.origin, args.origin_issuer), (None, None));
    let text = String::from_utf8(w.text(&args)).unwrap();
    assert!(text.contains("\nOrigin document: not required\n"));

    w.issue_ok(&args);
}

#[test]
fn issue_rejects_same_intake_digest_again() {
    let mut w = World::demo();
    let first = w.demo_args();
    w.issue_ok(&first);
    let second = IssueArgs {
        lot_id: "CR-0002".into(),
        ..w.demo_args()
    };
    let occupied = w.occupied_kg();

    let instructions = w.issue(&second);
    w.f.sponsored_already_in_use(&instructions, 1);

    assert_eq!(w.occupied_kg(), occupied);
    assert_eq!(
        w.f.read::<Lot>(w.addresses(&first).lot).supply_kg,
        first.quantity_kg
    );
    assert!(!w.f.account_exists(w.addresses(&second).lot));
}

#[test]
fn issue_rejects_same_lot_id_again() {
    let mut w = World::demo();
    let first = w.demo_args();
    w.issue_ok(&first);
    let second = IssueArgs {
        lot_id: first.lot_id.clone(),
        ..w.second_args()
    };
    let occupied = w.occupied_kg();

    let instructions = w.issue(&second);
    w.f.sponsored_already_in_use(&instructions, 1);

    assert_eq!(w.occupied_kg(), occupied);
    assert!(!w.f.account_exists(w.addresses(&second).intake));
}

#[test]
fn issue_rejects_related_custodian() {
    let mut w = World::demo();
    let relationship = w.f.relationship(Accreditor, w.owner, w.custodian);
    w.f.ok(relationship, Accreditor);

    w.assert_refused(&w.demo_args(), RelatedCustodian);
}

#[test]
fn issue_rejects_missing_origin() {
    let mut w = World::demo();
    let args = IssueArgs {
        origin: None,
        origin_issuer: None,
        ..w.demo_args()
    };

    w.assert_refused(&args, OriginInvalid);
}

#[test]
fn issue_rejects_revoked_origin() {
    let mut w = World::demo();
    let revoke =
        w.f.revoke_document(Issuer, w.issuer_org, w.document.unwrap());
    w.f.ok(revoke, Issuer);

    w.assert_refused(&w.demo_args(), OriginInvalid);
}

#[test]
fn issue_rejects_expired_origin() {
    let mut w = World::build(Spec {
        document_valid_until: NOW + 100,
        ..Spec::demo()
    });
    w.advance_to(NOW + 200);

    w.assert_refused(&w.demo_args(), OriginInvalid);
}

#[test]
fn issue_rejects_wrong_subject_origin() {
    let mut w = World::demo();
    let other = w.attest_origin(SECOND_DIGEST, SECOND_ORIGIN_SHA256, w.issuer_org);
    let args = IssueArgs {
        origin: Some(other),
        ..w.demo_args()
    };

    w.assert_refused(&args, OriginInvalid);
}

#[test]
fn issue_rejects_wrong_issuer_origin() {
    let mut w = World::demo();
    let other_issuer = w.f.add_org(OTHER_ISSUER_ID, Role::DocumentIssuer);
    let args = IssueArgs {
        origin_issuer: Some(other_issuer),
        ..w.demo_args()
    };

    w.assert_refused(&args, OriginInvalid);
}

#[test]
fn issue_rejects_over_capacity_by_one_kg() {
    let mut w = World::demo();
    w.issue_ok(&w.demo_args());
    let remaining = w.spec.approved_capacity_kg - w.occupied_kg();
    let second = IssueArgs {
        quantity_kg: remaining + 1,
        ..w.second_args()
    };
    let occupied = w.occupied_kg();

    w.assert_refused(&second, OverCapacity);

    assert_eq!(w.occupied_kg(), occupied);
}

#[test]
fn issue_rejects_grade_not_in_class() {
    let mut w = World::demo();
    let args = IssueArgs {
        grade: "Z".into(),
        ..w.demo_args()
    };

    w.assert_refused(&args, InvalidField);
}

#[test]
fn issue_rejects_owner_not_exporter() {
    let mut w = World::demo();
    let buyer = w.f.add_org(BUYER_ID, Role::Buyer);
    let args = IssueArgs {
        owner: buyer,
        ..w.demo_args()
    };

    w.assert_refused(&args, WrongRole);
}

#[test]
fn issue_rejects_zero_quantity() {
    let mut w = World::demo();
    let args = IssueArgs {
        quantity_kg: 0,
        ..w.demo_args()
    };

    w.assert_refused(&args, ZeroQuantity);
}

#[test]
fn issue_rejects_custodian_without_issue_scope() {
    let mut w = World::build(Spec {
        custodian_scopes: state::scope::REDEEM,
        ..Spec::demo()
    });

    w.assert_refused(&w.demo_args(), ScopeMissing);
}

#[test]
fn issue_rejects_expired_custodian_authority() {
    let mut w = World::build(Spec {
        custodian_expires_at: NOW + 100,
        ..Spec::demo()
    });
    w.advance_to(NOW + 100);

    w.assert_refused(&w.demo_args(), AuthorityExpired);
}

#[test]
fn issue_rejects_revoked_custodian_authority() {
    let mut w = World::demo();
    let revoke = w.f.revoke(OrgAdmin, w.custodian, w.authority);
    w.f.ok(revoke, OrgAdmin);

    w.assert_refused(&w.demo_args(), AuthorityRevoked);
}

#[test]
fn issue_rejects_authority_of_another_organisation() {
    let mut w = World::demo();
    let other = w.f.add_org(OTHER_CUSTODIAN_ID, Role::Custodian);
    let delegate = w.f.delegate(
        OrgAdmin,
        other,
        w.f.key(Custodian2),
        state::scope::ISSUE,
        NOW + DAY,
    );
    w.f.ok(delegate, OrgAdmin);
    let args = IssueArgs {
        authority: Some(w.f.authority(w.f.key(Custodian2))),
        signers: vec![Custodian2],
        ..w.demo_args()
    };

    w.assert_refused(&args, WrongOrganisation);
}

#[test]
fn issue_rejects_when_issuing_is_paused() {
    let mut w = World::demo();
    let pause = w.f.change_pause(Admin, state::pause::ISSUE, true);
    w.f.ok(pause, Admin);

    w.assert_refused(&w.demo_args(), Paused);
}

#[test]
fn issue_rejects_wrong_text() {
    let mut w = World::demo();
    let args = w.demo_args();
    let other = IssueArgs {
        quantity_kg: args.quantity_kg + 1_000,
        ..args.clone()
    };
    let args = IssueArgs {
        text: Some(w.text(&other)),
        ..args
    };

    w.assert_refused(&args, MessageMismatch);
}

#[test]
fn issue_rejects_wrong_signer() {
    let mut w = World::demo();
    let args = IssueArgs {
        signers: vec![Custodian2],
        ..w.demo_args()
    };

    w.assert_refused(&args, WrongSigner);
}

#[test]
fn issue_rejects_two_signature_entries() {
    let mut w = World::demo();
    let args = IssueArgs {
        signers: vec![Custodian, Custodian2],
        ..w.demo_args()
    };

    w.assert_refused(&args, WrongSignatureCount);
}

#[test]
fn issue_rejects_cross_instruction_offsets() {
    let mut w = World::demo();
    // The Ed25519 instruction is instruction 0: the precompile verifies a reference to it by
    // number, so Thetis itself has to insist on the self-reference marker.
    let args = IssueArgs {
        ed25519_index: 0,
        ..w.demo_args()
    };

    w.assert_refused(&args, CrossInstructionReference);
}

#[test]
fn issue_rejects_expired_intent() {
    let mut w = World::demo();
    let args = IssueArgs {
        valid_until: NOW - 1,
        ..w.demo_args()
    };

    w.assert_refused(&args, Expired);
}

#[test]
fn issue_rejects_window_of_601_seconds() {
    let mut w = World::demo();
    let args = IssueArgs {
        valid_until: NOW + 601,
        ..w.demo_args()
    };

    w.assert_refused(&args, WindowTooLong);
}

#[test]
fn issue_demo_transaction_fits_1232_bytes() {
    let mut w = World::demo();
    let args = w.demo_args();

    let (size, units) = w.issue_v0(&args);

    println!("issue v0 demo: {size} bytes, {units} CU");
}

#[test]
fn issue_transaction_fits_1232_bytes() {
    let spec = Spec::widest();
    assert_eq!(spec.owner_name.len(), state::MAX_DISPLAY_NAME);
    assert_eq!(spec.custodian_name.len(), state::MAX_DISPLAY_NAME);
    assert_ne!(spec.owner_name, spec.custodian_name);
    assert_eq!(spec.class_code.len(), state::MAX_CLASS_CODE);
    assert_eq!(spec.grades[0].len(), state::MAX_GRADE);
    assert_eq!(spec.site_code.len(), state::MAX_SITE_CODE);
    let mut w = World::build(spec);
    let args = IssueArgs {
        lot_id: "CR-0001-WIDEST-1".into(),
        grade: w.spec.grades[0].into(),
        quantity_kg: u64::MAX,
        ..w.demo_args()
    };
    assert_eq!(args.lot_id.len(), state::MAX_LOT_ID);

    let (size, units) = w.issue_v0(&args);

    println!("issue v0 widest: {size} bytes, {units} CU");
}
