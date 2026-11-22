mod common;

use anchor_lang::prelude::Pubkey;
use common::{Actor::*, *};
use litesvm::types::TransactionMetadata;
use solana_keypair::Keypair;
use solana_message::AddressLookupTableAccount;
use solana_transaction::Instruction;
use thetis::{
    accounts,
    error::ThetisError::*,
    events, instruction,
    intent::message::{issue_message, split_message, transfer_message},
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
/// The longest validity window a signed intent may ask for, less the margin the tests keep.
const INTENT_WINDOW: i64 = 570;

const INTAKE_DIGEST: [u8; 32] = digest(0x00);
const ORIGIN_SHA256: [u8; 32] = digest(0x20);
const SECOND_DIGEST: [u8; 32] = digest(0x40);
const SECOND_ORIGIN_SHA256: [u8; 32] = digest(0x60);

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
const BUYER_ID: u8 = 5;
const OTHER_CUSTODIAN_ID: u8 = 6;
const OTHER_BUYER_ID: u8 = 7;

const OTHER_CUSTODIAN_NAME: &str = "Sekoto Yard Custody";
const OTHER_SITE_CODE: &str = "ROAD-STOCKYARD";

/// Everything about the demo world that a test may need to vary.
struct Spec {
    class_code: &'static str,
    class_version: u32,
    grades: [&'static str; 2],
    owner_name: &'static str,
    buyer_name: &'static str,
    custodian_name: &'static str,
    site_code: &'static str,
    approved_capacity_kg: u64,
    document_version: u32,
    lot_id: &'static str,
    lot_quantity_kg: u64,
    split_inherits_expiry: bool,
}

impl Spec {
    fn demo() -> Self {
        Self {
            class_code: "CHROME",
            class_version: 1,
            grades: ["A", "B"],
            owner_name: "Khunou Ore Exports",
            buyer_name: "Thaba Steel Buyers",
            custodian_name: "Kopano Stockyard Custody",
            site_code: "PORT-STOCKYARD",
            approved_capacity_kg: 10_000_000,
            document_version: 1,
            lot_id: "CR-0001",
            lot_quantity_kg: 5_000_000,
            split_inherits_expiry: true,
        }
    }

    /// The widest values the state allows, so the transaction is as large as it can get.
    fn widest() -> Self {
        Self {
            class_code: "CHROMEXX",
            class_version: u32::MAX,
            grades: ["GRADEAAA", "B"],
            owner_name: "Khunou Ore Exports And Allied Holdings Pty Ltd 1",
            buyer_name: "Thaba Steel Buyers And Allied Trading Holdings 2",
            custodian_name: "Kopano Stockyard Custody And Storage Services 02",
            site_code: "PORT-STOCKYARD-1",
            approved_capacity_kg: u64::MAX,
            document_version: u32::MAX,
            lot_id: "CR-0001-WIDEST-1",
            lot_quantity_kg: u64::MAX,
            split_inherits_expiry: true,
        }
    }
}

/// One `split` call, with every input a test may vary.
#[derive(Clone)]
struct SplitArgs {
    /// The id of the parent Lot.
    parent_id: String,
    child_lot_id: String,
    quantity_kg: u64,
    expected_revision: u64,
    valid_until: i64,
    /// The root Lot account passed.
    root: Option<Pubkey>,
    /// The holder Organisation.
    owner: Pubkey,
    /// The custodian Organisation.
    custodian: Pubkey,
    owner_authority: Pubkey,
    custodian_authority: Pubkey,
    class_policy: Pubkey,
    custodian_class: Pubkey,
    /// Who signs the text, in entry order.
    signers: Vec<Actor>,
    /// A text to sign instead of the one the program will rebuild.
    text: Option<Vec<u8>>,
    /// A parent Position to pass instead of the owner's own.
    position: Option<Pubkey>,
}

/// The addresses `split` derives for one call.
struct Addresses {
    lot: Pubkey,
    mint: Pubkey,
    position: Pubkey,
    vault_authority: Pubkey,
    vault: Pubkey,
    child_lot: Pubkey,
    child_mint: Pubkey,
    child_mint_authority: Pubkey,
    child_position: Pubkey,
    child_vault_authority: Pubkey,
    child_vault: Pubkey,
}

/// What a split may change, read before it runs.
struct Snapshot {
    lot: Lot,
    position: Position,
    mint_supply: u64,
    /// The root Lot, when it is not the parent itself.
    root: Option<Lot>,
    occupied_kg: u64,
}

struct World {
    f: Fixture,
    spec: Spec,
    /// The clock, mirrored here so intents are signed relative to it.
    now: i64,
    owner: Pubkey,
    buyer: Pubkey,
    other_buyer: Pubkey,
    custodian: Pubkey,
    other_custodian: Pubkey,
    issuer_org: Pubkey,
    class_policy: Pubkey,
    custodian_class: Pubkey,
    /// The site of the other custodian, for the same class.
    other_custodian_class: Pubkey,
    /// The Authority of the custodian wallet, scope ISSUE.
    custodian_authority: Pubkey,
    /// The Authority of the other custodian's wallet, scope ISSUE.
    other_custodian_authority: Pubkey,
    /// The Authority of the owner's wallet, scope TRANSFER | SPLIT.
    authority: Pubkey,
    /// The Authority of the Buyer wallet on the Buyer organisation, scope TRANSFER | SPLIT.
    buyer_authority: Pubkey,
    /// The root Lot issued by the world.
    lot: Pubkey,
}

/// The Token-2022 associated token account of a vault authority for a mint.
fn associated_token(vault_authority: Pubkey, mint: Pubkey) -> Pubkey {
    Pubkey::find_program_address(
        &[vault_authority.as_ref(), TOKEN_2022.as_ref(), mint.as_ref()],
        &ASSOCIATED_TOKEN,
    )
    .0
}

impl World {
    fn demo() -> Self {
        Self::build(Spec::demo())
    }

    /// Builds the world and issues the lot to the owner.
    fn build(spec: Spec) -> Self {
        let mut f = Fixture::initialized();
        let class_policy = f.class(spec.class_code, spec.class_version);
        let register = f.register_with_inheritance(
            Accreditor,
            spec.class_code,
            spec.class_version,
            &spec.grades,
            LOT_VALIDITY,
            true,
            spec.split_inherits_expiry,
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
        let buyer = f.organisation(BUYER_ID);
        let accredit = f.accredit(Accreditor, BUYER_ID, Role::Buyer, spec.buyer_name);
        f.ok(accredit, Accreditor);
        let other_custodian = f.organisation(OTHER_CUSTODIAN_ID);
        let accredit = f.accredit(
            Accreditor,
            OTHER_CUSTODIAN_ID,
            Role::Custodian,
            OTHER_CUSTODIAN_NAME,
        );
        f.ok(accredit, Accreditor);
        let other_buyer = f.organisation(OTHER_BUYER_ID);
        let accredit = f.accredit(
            Accreditor,
            OTHER_BUYER_ID,
            Role::Buyer,
            "Lesedi Metals Trading",
        );
        f.ok(accredit, Accreditor);

        let delegate = f.delegate(
            OrgAdmin,
            issuer_org,
            f.key(Issuer),
            state::scope::ATTEST_ORIGIN,
            NOW + DAY,
        );
        f.ok(delegate, OrgAdmin);
        let attest = f.attest(
            Issuer,
            issuer_org,
            DocumentKind::Origin,
            INTAKE_DIGEST,
            spec.document_version,
            ORIGIN_SHA256,
            NOW + DAY,
        );
        f.ok(attest, Issuer);
        let origin = f.document(DocumentKind::Origin, INTAKE_DIGEST, spec.document_version);

        let custodian_class = f.site(custodian, class_policy, spec.site_code);
        let accredit_site = f.accredit_site(
            Accreditor,
            custodian,
            class_policy,
            spec.site_code,
            spec.approved_capacity_kg,
        );
        f.ok(accredit_site, Accreditor);
        let other_custodian_class = f.site(other_custodian, class_policy, OTHER_SITE_CODE);
        let accredit_site = f.accredit_site(
            Accreditor,
            other_custodian,
            class_policy,
            OTHER_SITE_CODE,
            10_000_000,
        );
        f.ok(accredit_site, Accreditor);

        let delegate = f.delegate(
            OrgAdmin,
            custodian,
            f.key(Custodian),
            state::scope::ISSUE,
            NOW + DAY,
        );
        f.ok(delegate, OrgAdmin);
        let delegate = f.delegate(
            OrgAdmin,
            other_custodian,
            f.key(Custodian2),
            state::scope::ISSUE,
            NOW + DAY,
        );
        f.ok(delegate, OrgAdmin);
        let delegate = f.delegate(
            OrgAdmin,
            owner,
            f.key(Owner),
            state::scope::TRANSFER | state::scope::SPLIT,
            NOW + DAY,
        );
        f.ok(delegate, OrgAdmin);
        let delegate = f.delegate(
            OrgAdmin,
            buyer,
            f.key(Buyer),
            state::scope::TRANSFER | state::scope::SPLIT,
            NOW + DAY,
        );
        f.ok(delegate, OrgAdmin);

        let custodian_authority = f.authority(f.key(Custodian));
        let other_custodian_authority = f.authority(f.key(Custodian2));
        let authority = f.authority(f.key(Owner));
        let buyer_authority = f.authority(f.key(Buyer));
        let lot = pda(&[b"lot", f.protocol.as_ref(), spec.lot_id.as_bytes()]);
        let mut world = Self {
            f,
            spec,
            now: NOW,
            owner,
            buyer,
            other_buyer,
            custodian,
            other_custodian,
            issuer_org,
            class_policy,
            custodian_class,
            other_custodian_class,
            custodian_authority,
            other_custodian_authority,
            authority,
            buyer_authority,
            lot,
        };
        world.issue_lot(
            world.spec.lot_id,
            world.spec.lot_quantity_kg,
            INTAKE_DIGEST,
            origin,
        );
        world
    }

    fn lot_key(&self, lot_id: &str) -> Pubkey {
        pda(&[b"lot", self.f.protocol.as_ref(), lot_id.as_bytes()])
    }

    fn position_key(&self, lot: Pubkey, organisation: Pubkey) -> Pubkey {
        pda(&[b"position", lot.as_ref(), organisation.as_ref()])
    }

    /// The owner's Position in the world's root Lot.
    fn root_position(&self, organisation: Pubkey) -> Pubkey {
        self.position_key(self.lot, organisation)
    }

    /// Issues a lot of the spec's class to the owner through the Ed25519 verification
    /// instruction and `issue_lot`, asserting that it succeeds and leaves the owner holding
    /// everything.
    fn issue_lot(
        &mut self,
        lot_id: &str,
        quantity_kg: u64,
        intake_digest: [u8; 32],
        origin: Pubkey,
    ) {
        let grade = self.spec.grades[0];
        let valid_until = self.now + INTENT_WINDOW;
        let protocol = self.f.protocol;
        let intake = pda(&[
            b"intake",
            protocol.as_ref(),
            self.custodian.as_ref(),
            &intake_digest,
        ]);
        let lot = self.lot_key(lot_id);
        let mint = pda(&[b"mint", lot.as_ref()]);
        let position = self.position_key(lot, self.owner);
        let vault_authority = pda(&[b"vault", position.as_ref()]);
        let vault = associated_token(vault_authority, mint);

        let document = self.f.read::<DocumentAttestation>(origin);
        let text = issue_message(
            &ID,
            &INSTANCE,
            lot_id,
            self.spec.class_code,
            self.spec.class_version,
            grade,
            quantity_kg,
            self.spec.owner_name,
            self.spec.custodian_name,
            self.spec.site_code,
            &intake_digest,
            Some((&document.sha256, document.version)),
            valid_until,
        );
        let verify = ed25519_instruction(&[(self.f.signer(Custodian), text.as_slice())]);
        let issue = ix(
            accounts::IssueLot {
                sponsor: self.f.payer(),
                protocol,
                authority: self.custodian_authority,
                owner: self.owner,
                custodian: self.custodian,
                class_policy: self.class_policy,
                custodian_class: self.custodian_class,
                origin: Some(origin),
                origin_issuer: Some(self.issuer_org),
                intake,
                lot,
                mint,
                mint_authority: pda(&[b"mint_authority", mint.as_ref()]),
                position,
                vault_authority,
                vault,
                instructions: INSTRUCTIONS_SYSVAR,
                token_program: TOKEN_2022,
                associated_token_program: ASSOCIATED_TOKEN,
                system_program: SYSTEM,
            },
            instruction::IssueLot {
                lot_id: lot_id.into(),
                grade: grade.into(),
                quantity_kg,
                intake_digest,
                valid_until,
            },
        );
        self.f.sponsored_ok(&[verify, issue]);

        let issued: Lot = self.f.read(lot);
        assert_eq!(issued.lot_id, lot_id);
        assert_eq!(issued.state, LotState::Stored);
        assert_eq!(issued.supply_kg, quantity_kg);
        assert_eq!(issued.revision, 0);
        assert_eq!(issued.parent, None);
        assert_eq!(issued.root, lot);
        let held: Position = self.f.read(position);
        assert_eq!(held.owner, self.owner);
        assert_eq!(held.quantity_kg, quantity_kg);
        assert_eq!(held.revision, 0);
        assert_eq!(self.f.token_amount(vault), quantity_kg);
        assert_eq!(self.f.mint_supply(mint), quantity_kg);
    }

    /// Issues a second root Lot, "CR-0002", of 1,000,000 kg to the owner.
    fn issue_second_root(&mut self) -> Pubkey {
        let attest = self.f.attest(
            Issuer,
            self.issuer_org,
            DocumentKind::Origin,
            SECOND_DIGEST,
            self.spec.document_version,
            SECOND_ORIGIN_SHA256,
            NOW + DAY,
        );
        self.f.ok(attest, Issuer);
        let origin = self.f.document(
            DocumentKind::Origin,
            SECOND_DIGEST,
            self.spec.document_version,
        );
        self.issue_lot("CR-0002", 1_000_000, SECOND_DIGEST, origin);
        self.lot_key("CR-0002")
    }

    /// Moves `quantity_kg` of the root Lot from one holder to another, as setup: the owner's
    /// Position revision must be `expected_revision`.
    fn transfer_units(
        &mut self,
        from: Pubkey,
        to: Pubkey,
        authority: Pubkey,
        signer: Actor,
        quantity_kg: u64,
        expected_revision: u64,
    ) {
        let valid_until = self.now + INTENT_WINDOW;
        let from_name = self.f.read::<Organisation>(from).display_name;
        let to_name = self.f.read::<Organisation>(to).display_name;
        let text = transfer_message(
            &ID,
            &INSTANCE,
            self.spec.lot_id,
            quantity_kg,
            &from_name,
            &to_name,
            expected_revision,
            valid_until,
        );
        let verify = ed25519_instruction(&[(self.f.signer(signer), text.as_slice())]);
        let mint = pda(&[b"mint", self.lot.as_ref()]);
        let from_position = self.position_key(self.lot, from);
        let from_vault_authority = pda(&[b"vault", from_position.as_ref()]);
        let to_position = self.position_key(self.lot, to);
        let to_vault_authority = pda(&[b"vault", to_position.as_ref()]);
        let transfer = ix(
            accounts::Transfer {
                sponsor: self.f.payer(),
                protocol: self.f.protocol,
                authority,
                lot: self.lot,
                mint,
                owner: from,
                from_position,
                from_vault_authority,
                from_vault: associated_token(from_vault_authority, mint),
                recipient: to,
                to_position,
                to_vault_authority,
                to_vault: associated_token(to_vault_authority, mint),
                instructions: INSTRUCTIONS_SYSVAR,
                token_program: TOKEN_2022,
                associated_token_program: ASSOCIATED_TOKEN,
                system_program: SYSTEM,
            },
            instruction::Transfer {
                quantity_kg,
                expected_revision,
                valid_until,
            },
        );
        self.f.sponsored_ok(&[verify, transfer]);
    }

    /// The default split of the world's root Lot: the owner moves `quantity_kg` into a child
    /// lot, signed by the owner's wallet and then the custodian's wallet for ten minutes.
    fn args(&self, child_lot_id: &str, quantity_kg: u64, expected_revision: u64) -> SplitArgs {
        self.args_for(
            self.spec.lot_id,
            child_lot_id,
            quantity_kg,
            expected_revision,
        )
    }

    /// As `args`, for any existing parent Lot; the root defaults to the parent's lineage.
    fn args_for(
        &self,
        parent_id: &str,
        child_lot_id: &str,
        quantity_kg: u64,
        expected_revision: u64,
    ) -> SplitArgs {
        let parent: Lot = self.f.read(self.lot_key(parent_id));
        SplitArgs {
            parent_id: parent_id.into(),
            child_lot_id: child_lot_id.into(),
            quantity_kg,
            expected_revision,
            valid_until: self.now + INTENT_WINDOW,
            root: parent.parent.map(|_| parent.root),
            owner: self.owner,
            custodian: self.custodian,
            owner_authority: self.authority,
            custodian_authority: self.custodian_authority,
            class_policy: self.class_policy,
            custodian_class: self.custodian_class,
            signers: vec![Owner, Custodian],
            text: None,
            position: None,
        }
    }

    fn addresses(&self, args: &SplitArgs) -> Addresses {
        let lot = self.lot_key(&args.parent_id);
        let mint = pda(&[b"mint", lot.as_ref()]);
        let position = args
            .position
            .unwrap_or_else(|| self.position_key(lot, args.owner));
        let vault_authority = pda(&[b"vault", position.as_ref()]);
        let child_lot = self.lot_key(&args.child_lot_id);
        let child_mint = pda(&[b"mint", child_lot.as_ref()]);
        let child_position = self.position_key(child_lot, args.owner);
        let child_vault_authority = pda(&[b"vault", child_position.as_ref()]);
        Addresses {
            lot,
            mint,
            position,
            vault_authority,
            vault: associated_token(vault_authority, mint),
            child_lot,
            child_mint,
            child_mint_authority: pda(&[b"mint_authority", child_mint.as_ref()]),
            child_position,
            child_vault_authority,
            child_vault: associated_token(child_vault_authority, child_mint),
        }
    }

    /// The text the program rebuilds from chain state and the arguments.
    fn text(&self, args: &SplitArgs) -> Vec<u8> {
        let owner = self.f.read::<Organisation>(args.owner).display_name;
        let custodian = self.f.read::<Organisation>(args.custodian).display_name;
        split_message(
            &ID,
            &INSTANCE,
            &args.parent_id,
            &args.child_lot_id,
            args.quantity_kg,
            &owner,
            &custodian,
            args.expected_revision,
            args.valid_until,
        )
    }

    /// The Ed25519 verification instruction, one shared text for every signer, followed by
    /// `split`.
    fn split(&self, args: &SplitArgs) -> [Instruction; 2] {
        let text = args.text.clone().unwrap_or_else(|| self.text(args));
        let signers: Vec<&Keypair> = args
            .signers
            .iter()
            .map(|actor| self.f.signer(*actor))
            .collect();
        [
            ed25519_shared_instruction(&signers, &text),
            self.split_instruction(args),
        ]
    }

    fn split_instruction(&self, args: &SplitArgs) -> Instruction {
        let a = self.addresses(args);
        ix(
            accounts::Split {
                sponsor: self.f.payer(),
                protocol: self.f.protocol,
                owner_authority: args.owner_authority,
                custodian_authority: args.custodian_authority,
                lot: a.lot,
                root: args.root,
                class_policy: args.class_policy,
                custodian_class: args.custodian_class,
                owner: args.owner,
                custodian: args.custodian,
                mint: a.mint,
                position: a.position,
                vault_authority: a.vault_authority,
                vault: a.vault,
                child_lot: a.child_lot,
                child_mint: a.child_mint,
                child_mint_authority: a.child_mint_authority,
                child_position: a.child_position,
                child_vault_authority: a.child_vault_authority,
                child_vault: a.child_vault,
                instructions: INSTRUCTIONS_SYSVAR,
                token_program: TOKEN_2022,
                associated_token_program: ASSOCIATED_TOKEN,
                system_program: SYSTEM,
            },
            instruction::Split {
                child_lot_id: args.child_lot_id.clone(),
                quantity_kg: args.quantity_kg,
                expected_revision: args.expected_revision,
                valid_until: args.valid_until,
            },
        )
    }

    fn snapshot(&self, args: &SplitArgs) -> Snapshot {
        let a = self.addresses(args);
        let lot: Lot = self.f.read(a.lot);
        let root = lot.parent.map(|_| self.f.read::<Lot>(lot.root));
        let site: CustodianClass = self.f.read(lot.custodian_class);
        Snapshot {
            lot,
            position: self.f.read(a.position),
            mint_supply: self.f.mint_supply(a.mint),
            root,
            occupied_kg: site.occupied_kg,
        }
    }

    /// Sends the split and checks every effect it promises.
    fn split_ok(&mut self, args: &SplitArgs) -> TransactionMetadata {
        let instructions = self.split(args);
        let before = self.snapshot(args);
        let tx = self.f.sponsored_ok(&instructions);
        self.assert_split(args, &before, &tx);
        tx
    }

    fn assert_split(&self, args: &SplitArgs, before: &Snapshot, tx: &TransactionMetadata) {
        let f = &self.f;
        let a = self.addresses(args);
        let q = args.quantity_kg;
        let parent_is_root = before.lot.parent.is_none();

        // The parent Lot.
        let lot: Lot = f.read(a.lot);
        assert_eq!(lot.protocol, f.protocol);
        assert_eq!(lot.lot_id, before.lot.lot_id);
        assert_eq!(lot.class_policy, before.lot.class_policy);
        assert_eq!(lot.class_version, before.lot.class_version);
        assert_eq!(lot.grade, before.lot.grade);
        assert_eq!(lot.custodian_class, before.lot.custodian_class);
        assert_eq!(lot.intake, before.lot.intake);
        assert_eq!(lot.parent, before.lot.parent);
        assert_eq!(lot.root, before.lot.root);
        assert_eq!(lot.mint, a.mint);
        assert_eq!(lot.supply_kg, before.lot.supply_kg - q);
        assert_eq!(lot.state, before.lot.state);
        assert_eq!(lot.restriction, before.lot.restriction);
        assert_eq!(lot.expires_at, before.lot.expires_at);
        assert_eq!(lot.revision, before.lot.revision + 1);
        assert_eq!(
            lot.live_children,
            before.lot.live_children + u32::from(parent_is_root)
        );
        assert_eq!(lot.bump, before.lot.bump);

        // A separate root changes only its live children.
        if let Some(previous) = &before.root {
            let root: Lot = f.read(before.lot.root);
            assert_eq!(root.lot_id, previous.lot_id);
            assert_eq!(root.supply_kg, previous.supply_kg);
            assert_eq!(root.state, previous.state);
            assert_eq!(root.restriction, previous.restriction);
            assert_eq!(root.expires_at, previous.expires_at);
            assert_eq!(root.parent, previous.parent);
            assert_eq!(root.root, previous.root);
            assert_eq!(root.mint, previous.mint);
            assert_eq!(root.revision, previous.revision);
            assert_eq!(root.live_children, previous.live_children + 1);
            assert_eq!(root.bump, previous.bump);
        }

        // The parent Position, vault and mint.
        let position: Position = f.read(a.position);
        assert_eq!(position.protocol, f.protocol);
        assert_eq!(position.lot, a.lot);
        assert_eq!(position.owner, args.owner);
        assert_eq!(position.quantity_kg, before.position.quantity_kg - q);
        assert_eq!(position.locked_kg, before.position.locked_kg);
        assert_eq!(position.reserved_kg, before.position.reserved_kg);
        assert_eq!(position.revision, before.position.revision + 1);
        assert_eq!(position.bump, before.position.bump);
        assert_eq!(f.mint_supply(a.mint), before.mint_supply - q);
        assert_eq!(f.mint_supply(a.mint), lot.supply_kg);
        assert_eq!(f.owner(a.vault), Some(TOKEN_2022));
        assert_eq!(f.token_amount(a.vault), position.quantity_kg);

        // The child Lot.
        let child: Lot = f.read(a.child_lot);
        assert_eq!(child.protocol, f.protocol);
        assert_eq!(child.lot_id, args.child_lot_id);
        assert_eq!(child.class_policy, before.lot.class_policy);
        assert_eq!(child.class_version, before.lot.class_version);
        assert_eq!(child.grade, before.lot.grade);
        assert_eq!(child.custodian_class, before.lot.custodian_class);
        assert_eq!(child.intake, before.lot.intake);
        assert_eq!(child.parent, Some(a.lot));
        assert_eq!(child.root, before.lot.root);
        assert_eq!(child.mint, a.child_mint);
        assert_eq!(child.supply_kg, q);
        assert_eq!(child.state, LotState::Stored);
        assert_eq!(child.restriction, Restriction::Normal);
        assert_eq!(child.expires_at, before.lot.expires_at);
        assert_eq!(child.revision, 0);
        assert_eq!(child.live_children, 0);
        assert_eq!(
            child.bump,
            Pubkey::find_program_address(
                &[b"lot", f.protocol.as_ref(), args.child_lot_id.as_bytes()],
                &ID
            )
            .1
        );
        assert_eq!(f.owner(a.child_lot), Some(ID));

        // The child Position, vault and mint.
        let child_position: Position = f.read(a.child_position);
        assert_eq!(child_position.protocol, f.protocol);
        assert_eq!(child_position.lot, a.child_lot);
        assert_eq!(child_position.owner, args.owner);
        assert_eq!(child_position.quantity_kg, q);
        assert_eq!(child_position.locked_kg, 0);
        assert_eq!(child_position.reserved_kg, 0);
        assert_eq!(child_position.revision, 0);
        assert_eq!(f.owner(a.child_mint), Some(TOKEN_2022));
        assert_eq!(f.mint_supply(a.child_mint), q);
        assert_eq!(f.mint_supply(a.child_mint), child.supply_kg);
        assert_eq!(f.owner(a.child_vault), Some(TOKEN_2022));
        assert_eq!(f.token_amount(a.child_vault), q);
        assert_eq!(f.token_amount(a.child_vault), child_position.quantity_kg);
        // Seed-checked signing PDAs hold no account.
        assert!(!f.account_exists(a.vault_authority));
        assert!(!f.account_exists(a.child_vault_authority));
        assert!(!f.account_exists(a.child_mint_authority));

        // Occupancy does not move: the units stay where they are.
        let site: CustodianClass = f.read(before.lot.custodian_class);
        assert_eq!(site.occupied_kg, before.occupied_kg);

        assert_event(
            tx,
            events::LotSplit {
                parent: a.lot,
                child: a.child_lot,
                owner: args.owner,
                quantity_kg: q,
                parent_revision: before.lot.revision + 1,
            },
        );
    }

    /// The Ed25519 instruction is index 0 and `split` index 1 of a sponsored transaction; the
    /// fixture also asserts that nothing changed and no event was emitted, and the child lot
    /// must not exist afterwards.
    fn assert_refused(&mut self, args: &SplitArgs, expected: thetis::error::ThetisError) {
        let instructions = self.split(args);
        self.f.sponsored_refused(&instructions, 1, expected);
        assert!(!self.f.account_exists(self.addresses(args).child_lot));
    }

    /// Rewrites a Lot that instructions cannot yet bring into that state.
    fn forge_lot(&mut self, lot_id: &str, change: impl FnOnce(&mut Lot)) {
        let address = self.lot_key(lot_id);
        let mut lot: Lot = self.f.read(address);
        change(&mut lot);
        self.f.set_program_account(address, &lot);
    }

    /// A lookup table holding every account the splits name except the sponsor and Thetis.
    fn table(&mut self, calls: &[&SplitArgs]) -> AddressLookupTableAccount {
        let mut addresses: Vec<Pubkey> = Vec::new();
        for args in calls {
            for meta in self.split_instruction(args).accounts {
                if meta.pubkey != self.f.payer()
                    && meta.pubkey != ID
                    && !addresses.contains(&meta.pubkey)
                {
                    addresses.push(meta.pubkey);
                }
            }
        }
        self.f.create_lookup_table(addresses)
    }

    /// Splits through a v0 transaction with a lookup table, asserting that it fits in one
    /// packet and in the compute budget it asks for. Returns `(bytes, compute units)`.
    fn split_v0(&mut self, args: &SplitArgs, table: &AddressLookupTableAccount) -> (usize, u64) {
        let limit = Instruction {
            program_id: solana_sdk_ids::compute_budget::ID,
            accounts: vec![],
            data: [vec![2], COMPUTE_UNIT_LIMIT.to_le_bytes().to_vec()].concat(),
        };
        let [verify, split] = self.split(args);
        let tx = self
            .f
            .sponsored_v0(&[limit, verify, split], std::slice::from_ref(table));
        assert_eq!(tx.signatures.len(), 1, "only the sponsor signs");
        let size = transaction_size(&tx);
        assert!(
            size <= PACKET_DATA_SIZE,
            "split v0 transaction is {size} bytes"
        );

        let before = self.snapshot(args);
        let meta = self
            .f
            .send(tx)
            .unwrap_or_else(|failure| panic!("{:?}\n{}", failure.err, failure.meta.pretty_logs()));
        let units = meta.compute_units_consumed;
        assert!(
            units <= u64::from(COMPUTE_UNIT_LIMIT),
            "split used {units} compute units"
        );
        self.assert_split(args, &before, &meta);
        (size, units)
    }
}

#[test]
fn split_with_both_signers_creates_child_lot() {
    let mut w = World::demo();
    let args = w.args("CR-0001-A", 2_000_000, 0);
    let a = w.addresses(&args);
    let before: Lot = w.f.read(w.lot);
    assert!(!w.f.account_exists(a.child_lot));
    assert!(!w.f.account_exists(a.child_mint));
    assert!(!w.f.account_exists(a.child_position));
    assert!(!w.f.account_exists(a.child_vault));

    let tx = w.split_ok(&args);

    let parent: Lot = w.f.read(w.lot);
    assert_eq!(parent.supply_kg, 3_000_000);
    assert_eq!(parent.revision, 1);
    assert_eq!(parent.state, LotState::Stored);
    assert_eq!(parent.live_children, 1);
    let position: Position = w.f.read(a.position);
    assert_eq!(position.quantity_kg, 3_000_000);
    assert_eq!(position.revision, 1);
    assert_eq!(w.f.mint_supply(a.mint), 3_000_000);
    assert_eq!(w.f.token_amount(a.vault), 3_000_000);

    let child: Lot = w.f.read(a.child_lot);
    assert_eq!(child.protocol, w.f.protocol);
    assert_eq!(child.lot_id, "CR-0001-A");
    assert_eq!(child.class_policy, w.class_policy);
    assert_eq!(child.class_version, 1);
    assert_eq!(child.grade, "A");
    assert_eq!(child.custodian_class, w.custodian_class);
    assert_eq!(child.intake, before.intake);
    assert_eq!(child.parent, Some(w.lot));
    assert_eq!(child.root, w.lot);
    assert_eq!(child.mint, a.child_mint);
    assert_eq!(child.supply_kg, 2_000_000);
    assert_eq!(child.state, LotState::Stored);
    assert_eq!(child.restriction, Restriction::Normal);
    assert_eq!(child.expires_at, before.expires_at);
    assert_eq!(child.revision, 0);
    assert_eq!(child.live_children, 0);

    let child_position: Position = w.f.read(a.child_position);
    assert_eq!(child_position.protocol, w.f.protocol);
    assert_eq!(child_position.lot, a.child_lot);
    assert_eq!(child_position.owner, w.owner);
    assert_eq!(child_position.quantity_kg, 2_000_000);
    assert_eq!(child_position.locked_kg, 0);
    assert_eq!(child_position.reserved_kg, 0);
    assert_eq!(child_position.revision, 0);
    assert_eq!(w.f.owner(a.child_mint), Some(TOKEN_2022));
    assert_eq!(w.f.mint_supply(a.child_mint), 2_000_000);
    assert_eq!(w.f.owner(a.child_vault), Some(TOKEN_2022));
    assert_eq!(w.f.token_amount(a.child_vault), 2_000_000);
    assert_event(
        &tx,
        events::LotSplit {
            parent: w.lot,
            child: a.child_lot,
            owner: w.owner,
            quantity_kg: 2_000_000,
            parent_revision: 1,
        },
    );
}

#[test]
fn split_records_lineage_parent_and_root() {
    let mut w = World::demo();
    let first = w.args("CR-0001-A", 2_000_000, 0);
    w.split_ok(&first);
    let nested = w.args_for("CR-0001-A", "CR-0001-B", 500_000, 0);
    assert_eq!(nested.root, Some(w.lot));

    w.split_ok(&nested);

    let a = w.lot_key("CR-0001-A");
    let b = w.lot_key("CR-0001-B");
    let root: Lot = w.f.read(w.lot);
    let first_child: Lot = w.f.read(a);
    let second_child: Lot = w.f.read(b);
    assert_eq!(root.parent, None);
    assert_eq!(root.root, w.lot);
    assert_eq!(first_child.parent, Some(w.lot));
    assert_eq!(first_child.root, w.lot);
    assert_eq!(second_child.parent, Some(a));
    assert_eq!(second_child.root, w.lot);
    assert_eq!(second_child.expires_at, first_child.expires_at);
    assert_eq!(first_child.expires_at, root.expires_at);
    assert_eq!(first_child.supply_kg, 1_500_000);
    assert_eq!(second_child.supply_kg, 500_000);
}

#[test]
fn split_leaves_occupancy_unchanged() {
    let mut w = World::demo();
    let site: CustodianClass = w.f.read(w.custodian_class);
    assert_eq!(site.occupied_kg, 5_000_000);

    w.split_ok(&w.args("CR-0001-A", 2_000_000, 0));
    let site: CustodianClass = w.f.read(w.custodian_class);
    assert_eq!(site.occupied_kg, 5_000_000);

    w.split_ok(&w.args_for("CR-0001-A", "CR-0001-B", 500_000, 0));
    let site: CustodianClass = w.f.read(w.custodian_class);
    assert_eq!(site.occupied_kg, 5_000_000);
}

#[test]
fn split_increments_root_live_children() {
    let mut w = World::demo();
    assert_eq!(w.f.read::<Lot>(w.lot).live_children, 0);

    w.split_ok(&w.args("CR-0001-A", 2_000_000, 0));
    let root: Lot = w.f.read(w.lot);
    assert_eq!(root.live_children, 1);
    assert_eq!(root.revision, 1);

    w.split_ok(&w.args_for("CR-0001-A", "CR-0001-B", 500_000, 0));
    let root: Lot = w.f.read(w.lot);
    assert_eq!(root.live_children, 2);
    // The nested split did not touch the root's revision.
    assert_eq!(root.revision, 1);
    assert_eq!(root.supply_kg, 3_000_000);
    let parent: Lot = w.f.read(w.lot_key("CR-0001-A"));
    assert_eq!(parent.live_children, 0);
    assert_eq!(parent.revision, 1);
    assert_eq!(parent.supply_kg, 1_500_000);
}

#[test]
fn split_rejects_owner_signature_only() {
    let mut w = World::demo();
    let args = SplitArgs {
        signers: vec![Owner],
        ..w.args("CR-0001-A", 2_000_000, 0)
    };

    w.assert_refused(&args, WrongSignatureCount);
}

#[test]
fn split_rejects_custodian_of_another_site() {
    let mut w = World::demo();
    let args = SplitArgs {
        custodian: w.other_custodian,
        custodian_authority: w.other_custodian_authority,
        signers: vec![Owner, Custodian2],
        ..w.args("CR-0001-A", 2_000_000, 0)
    };

    w.assert_refused(&args, WrongOrganisation);
}

#[test]
fn split_rejects_whole_lot() {
    let mut w = World::demo();

    w.assert_refused(&w.args("CR-0001-A", 5_000_000, 0), SplitWouldEmptyParent);
}

#[test]
fn split_rejects_class_without_inheritance() {
    let mut w = World::build(Spec {
        split_inherits_expiry: false,
        ..Spec::demo()
    });

    w.assert_refused(&w.args("CR-0001-A", 2_000_000, 0), SplitNeedsReassay);
}

#[test]
fn split_rejects_root_mismatch() {
    let mut w = World::demo();
    let second_root = w.issue_second_root();
    w.split_ok(&w.args("CR-0001-A", 2_000_000, 0));

    // A child parent needs its root...
    let missing = SplitArgs {
        root: None,
        ..w.args_for("CR-0001-A", "CR-0001-B", 500_000, 0)
    };
    w.assert_refused(&missing, RootMismatch);
    // ...and the right one.
    let wrong = SplitArgs {
        root: Some(second_root),
        ..w.args_for("CR-0001-A", "CR-0001-B", 500_000, 0)
    };
    w.assert_refused(&wrong, RootMismatch);
    // A root parent takes none.
    let present = SplitArgs {
        root: Some(second_root),
        ..w.args("CR-0001-B", 500_000, 1)
    };
    w.assert_refused(&present, RootMismatch);
}

#[test]
fn split_rejects_taken_child_lot_id() {
    let mut w = World::demo();
    w.split_ok(&w.args("CR-0001-A", 2_000_000, 0));

    let again = w.split(&w.args("CR-0001-A", 1_000_000, 1));
    w.f.sponsored_already_in_use(&again, 1);
}

#[test]
fn split_rejects_stale_lot_revision() {
    let mut w = World::demo();
    w.split_ok(&w.args("CR-0001-A", 2_000_000, 0));
    assert_eq!(w.f.read::<Lot>(w.lot).revision, 1);

    w.assert_refused(&w.args("CR-0001-B", 500_000, 0), StaleRevision);

    w.split_ok(&w.args("CR-0001-B", 500_000, 1));
}

#[test]
fn split_checks_the_parent_lot_revision() {
    let mut w = World::demo();
    w.transfer_units(w.owner, w.buyer, w.authority, Owner, 1_000_000, 0);
    w.transfer_units(w.buyer, w.other_buyer, w.buyer_authority, Buyer, 100_000, 0);
    assert_eq!(w.f.read::<Lot>(w.lot).revision, 2);
    assert_eq!(w.f.read::<Position>(w.root_position(w.owner)).revision, 1);

    // The owner's Position is at 1, but the Lot is at 2: only the latter counts.
    w.assert_refused(&w.args("CR-0001-A", 1_000_000, 1), StaleRevision);

    w.split_ok(&w.args("CR-0001-A", 1_000_000, 2));
}

#[test]
fn split_rejects_position_of_another_owner() {
    let mut w = World::demo();
    w.transfer_units(w.owner, w.buyer, w.authority, Owner, 1_000_000, 0);
    // The Buyer names itself as owner but passes the Exporter's Position.
    let args = SplitArgs {
        owner: w.buyer,
        owner_authority: w.buyer_authority,
        signers: vec![Buyer, Custodian],
        position: Some(w.root_position(w.owner)),
        ..w.args("CR-0001-A", 500_000, 1)
    };

    w.assert_refused(&args, WrongOrganisation);
}

#[test]
fn split_rejects_custodian_class_of_another_site() {
    let mut w = World::demo();
    let args = SplitArgs {
        custodian_class: w.other_custodian_class,
        ..w.args("CR-0001-A", 2_000_000, 0)
    };

    w.assert_refused(&args, WrongOrganisation);
}

#[test]
fn split_rejects_zero_quantity() {
    let mut w = World::demo();

    w.assert_refused(&w.args("CR-0001-A", 0, 0), ZeroQuantity);
}

#[test]
fn split_rejects_more_than_available() {
    let mut w = World::demo();
    w.transfer_units(w.owner, w.buyer, w.authority, Owner, 1_000_000, 0);

    w.assert_refused(&w.args("CR-0001-A", 4_000_001, 1), InsufficientAvailable);

    w.split_ok(&w.args("CR-0001-A", 4_000_000, 1));
}

#[test]
fn split_rejects_owner_without_split_scope() {
    let mut w = World::demo();
    let delegate = w.f.delegate(
        OrgAdmin,
        w.owner,
        w.f.key(Outsider),
        state::scope::TRANSFER,
        NOW + DAY,
    );
    w.f.ok(delegate, OrgAdmin);
    let args = SplitArgs {
        owner_authority: w.f.authority(w.f.key(Outsider)),
        signers: vec![Outsider, Custodian],
        ..w.args("CR-0001-A", 2_000_000, 0)
    };

    w.assert_refused(&args, ScopeMissing);
}

#[test]
fn split_rejects_custodian_without_issue_scope() {
    let mut w = World::demo();
    // A custodian-organisation Authority that holds SPLIT but not ISSUE.
    let wallet = w.f.key(Custodian2);
    w.f.forge_authority(w.custodian, wallet, state::scope::SPLIT, NOW + DAY);
    let args = SplitArgs {
        custodian_authority: w.f.authority(wallet),
        signers: vec![Owner, Custodian2],
        ..w.args("CR-0001-A", 2_000_000, 0)
    };

    w.assert_refused(&args, ScopeMissing);
}

#[test]
fn split_rejects_custodian_entry_first() {
    let mut w = World::demo();
    let args = SplitArgs {
        signers: vec![Custodian, Owner],
        ..w.args("CR-0001-A", 2_000_000, 0)
    };

    w.assert_refused(&args, WrongSigner);
}

#[test]
fn split_rejects_invalid_child_lot_id() {
    let mut w = World::demo();

    w.assert_refused(&w.args("cr-0001-a", 2_000_000, 0), InvalidField);
}

#[test]
fn split_rejects_when_paused() {
    let mut w = World::demo();
    let pause = w.f.change_pause(Admin, state::pause::SPLIT, true);
    w.f.ok(pause, Admin);

    w.assert_refused(&w.args("CR-0001-A", 2_000_000, 0), Paused);
}

#[test]
fn split_demo_transaction_fits_1232_bytes() {
    let mut w = World::demo();
    let args = w.args("CR-0001-A", 2_000_000, 0);
    let table = w.table(&[&args]);

    let (size, units) = w.split_v0(&args, &table);

    println!("split v0 demo: {size} bytes, {units} CU");
}

#[test]
fn split_transaction_fits_1232_bytes() {
    let spec = Spec::widest();
    assert_eq!(spec.owner_name.len(), state::MAX_DISPLAY_NAME);
    assert_eq!(spec.custodian_name.len(), state::MAX_DISPLAY_NAME);
    assert_ne!(spec.owner_name, spec.custodian_name);
    assert_eq!(spec.lot_id.len(), state::MAX_LOT_ID);
    assert_eq!(spec.lot_quantity_kg, u64::MAX);
    let mut w = World::build(spec);
    let root_id = w.spec.lot_id;
    let child_id = "CR-0001-WIDEST-A";
    let grandchild_id = "CR-0001-WIDEST-B";
    assert_eq!(child_id.len(), state::MAX_LOT_ID);
    assert_eq!(grandchild_id.len(), state::MAX_LOT_ID);
    let revision = u64::MAX - 1;
    assert_eq!(revision.to_string().len(), 20);

    let first = w.args(child_id, u64::MAX - 1, 0);
    // The second split's lineage does not exist yet, so its arguments are spelled out.
    let second = SplitArgs {
        parent_id: child_id.into(),
        child_lot_id: grandchild_id.into(),
        quantity_kg: u64::MAX - 2,
        expected_revision: revision,
        root: Some(w.lot),
        ..first.clone()
    };
    let table = w.table(&[&first, &second]);

    let (first_size, first_units) = w.split_v0(&first, &table);
    assert_eq!(w.f.read::<Lot>(w.lot).supply_kg, 1);
    w.forge_lot(child_id, |lot| lot.revision = revision);
    let (size, units) = w.split_v0(&second, &table);

    println!("split v0 widest: {size} bytes, {units} CU");
    println!("split v0 widest, first level: {first_size} bytes, {first_units} CU");
    let root: Lot = w.f.read(w.lot);
    let child: Lot = w.f.read(w.lot_key(child_id));
    let grandchild: Lot = w.f.read(w.lot_key(grandchild_id));
    assert_eq!(root.lot_id, root_id);
    assert_eq!(root.lot_id.len(), state::MAX_LOT_ID);
    assert_eq!(child.lot_id.len(), state::MAX_LOT_ID);
    assert_eq!(grandchild.lot_id.len(), state::MAX_LOT_ID);
    assert_eq!(root.live_children, 2);
    assert_eq!(root.revision, 1);
    assert_eq!(child.revision, u64::MAX);
    assert_eq!(child.supply_kg, 1);
    assert_eq!(child.parent, Some(w.lot));
    assert_eq!(grandchild.supply_kg, u64::MAX - 2);
    assert_eq!(grandchild.parent, Some(w.lot_key(child_id)));
    assert_eq!(grandchild.root, w.lot);
    assert_eq!(grandchild.revision, 0);
}
