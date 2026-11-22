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
    intent::message::{issue_message, transfer_message},
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
const OTHER_BUYER_ID: u8 = 7;
const TRANSPORTER_ID: u8 = 8;

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
        }
    }
}

/// One `transfer` call, with every input a test may vary.
#[derive(Clone)]
struct TransferArgs {
    quantity_kg: u64,
    expected_revision: u64,
    valid_until: i64,
    /// The source Organisation.
    owner: Pubkey,
    /// The destination Organisation.
    recipient: Pubkey,
    /// The Authority account passed.
    authority: Pubkey,
    /// Who signs the text, in entry order.
    signers: Vec<Actor>,
    /// A text to sign instead of the one the program will rebuild.
    text: Option<Vec<u8>>,
    /// A source Position to pass instead of the owner's own.
    from_position: Option<Pubkey>,
}

/// The addresses `transfer` derives for one call.
struct Addresses {
    mint: Pubkey,
    from_position: Pubkey,
    from_vault_authority: Pubkey,
    from_vault: Pubkey,
    to_position: Pubkey,
    to_vault_authority: Pubkey,
    to_vault: Pubkey,
}

/// What a transfer may change, read before it runs.
struct Snapshot {
    lot: Lot,
    from: Position,
    to: Option<Position>,
    mint_supply: u64,
}

struct World {
    f: Fixture,
    spec: Spec,
    /// The clock, mirrored here so intents are signed relative to it.
    now: i64,
    owner: Pubkey,
    buyer: Pubkey,
    other_buyer: Pubkey,
    transporter: Pubkey,
    custodian: Pubkey,
    issuer_org: Pubkey,
    class_policy: Pubkey,
    custodian_class: Pubkey,
    /// The Authority of the custodian wallet that issues the lot.
    custodian_authority: Pubkey,
    /// The Authority of the owner's wallet, scope TRANSFER.
    authority: Pubkey,
    /// The Authority of the Buyer wallet on the Buyer organisation, scope TRANSFER.
    buyer_authority: Pubkey,
    origin: Pubkey,
    lot: Pubkey,
}

impl World {
    fn demo() -> Self {
        Self::build(Spec::demo())
    }

    /// Builds the world and issues the lot to the owner.
    fn build(spec: Spec) -> Self {
        let mut f = Fixture::initialized();
        let class_policy = f.class(spec.class_code, spec.class_version);
        let register = f.register_with_origin(
            Accreditor,
            spec.class_code,
            spec.class_version,
            &spec.grades,
            LOT_VALIDITY,
            true,
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
        let other_buyer = f.organisation(OTHER_BUYER_ID);
        let accredit = f.accredit(
            Accreditor,
            OTHER_BUYER_ID,
            Role::Buyer,
            "Lesedi Metals Trading",
        );
        f.ok(accredit, Accreditor);
        let transporter = f.organisation(TRANSPORTER_ID);
        let accredit = f.accredit(
            Accreditor,
            TRANSPORTER_ID,
            Role::Transporter,
            "Marang Freight Haulage",
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
            owner,
            f.key(Owner),
            state::scope::TRANSFER,
            NOW + DAY,
        );
        f.ok(delegate, OrgAdmin);
        let delegate = f.delegate(
            OrgAdmin,
            buyer,
            f.key(Buyer),
            state::scope::TRANSFER,
            NOW + DAY,
        );
        f.ok(delegate, OrgAdmin);

        let custodian_authority = f.authority(f.key(Custodian));
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
            transporter,
            custodian,
            issuer_org,
            class_policy,
            custodian_class,
            custodian_authority,
            authority,
            buyer_authority,
            origin,
            lot,
        };
        world.issue_lot();
        world
    }

    fn advance_to(&mut self, unix_timestamp: i64) {
        self.now = unix_timestamp;
        self.f.set_time(unix_timestamp);
    }

    fn mint(&self) -> Pubkey {
        pda(&[b"mint", self.lot.as_ref()])
    }

    fn position(&self, organisation: Pubkey) -> Pubkey {
        pda(&[b"position", self.lot.as_ref(), organisation.as_ref()])
    }

    /// The Token-2022 associated token account of a vault authority for the lot's mint.
    fn vault(&self, vault_authority: Pubkey) -> Pubkey {
        Pubkey::find_program_address(
            &[
                vault_authority.as_ref(),
                TOKEN_2022.as_ref(),
                self.mint().as_ref(),
            ],
            &ASSOCIATED_TOKEN,
        )
        .0
    }

    fn addresses(&self, args: &TransferArgs) -> Addresses {
        let from_position = args
            .from_position
            .unwrap_or_else(|| self.position(args.owner));
        let from_vault_authority = pda(&[b"vault", from_position.as_ref()]);
        let to_position = self.position(args.recipient);
        let to_vault_authority = pda(&[b"vault", to_position.as_ref()]);
        Addresses {
            mint: self.mint(),
            from_position,
            from_vault_authority,
            from_vault: self.vault(from_vault_authority),
            to_position,
            to_vault_authority,
            to_vault: self.vault(to_vault_authority),
        }
    }

    /// Issues the spec's lot to the owner through the Ed25519 verification instruction and
    /// `issue_lot`, asserting that it succeeds and leaves the owner holding everything.
    fn issue_lot(&mut self) {
        let lot_id = self.spec.lot_id;
        let grade = self.spec.grades[0];
        let quantity_kg = self.spec.lot_quantity_kg;
        let valid_until = self.now + INTENT_WINDOW;
        let protocol = self.f.protocol;
        let intake = pda(&[
            b"intake",
            protocol.as_ref(),
            self.custodian.as_ref(),
            &INTAKE_DIGEST,
        ]);
        let mint = self.mint();
        let position = self.position(self.owner);
        let vault_authority = pda(&[b"vault", position.as_ref()]);
        let vault = self.vault(vault_authority);

        let document = self.f.read::<DocumentAttestation>(self.origin);
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
            &INTAKE_DIGEST,
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
                origin: Some(self.origin),
                origin_issuer: Some(self.issuer_org),
                intake,
                lot: self.lot,
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
                intake_digest: INTAKE_DIGEST,
                valid_until,
            },
        );
        self.f.sponsored_ok(&[verify, issue]);

        let lot: Lot = self.f.read(self.lot);
        assert_eq!(lot.lot_id, lot_id);
        assert_eq!(lot.state, LotState::Stored);
        assert_eq!(lot.supply_kg, quantity_kg);
        assert_eq!(lot.revision, 0);
        let position: Position = self.f.read(position);
        assert_eq!(position.owner, self.owner);
        assert_eq!(position.quantity_kg, quantity_kg);
        assert_eq!(position.revision, 0);
        assert_eq!(self.f.token_amount(vault), quantity_kg);
        assert_eq!(self.f.mint_supply(mint), quantity_kg);
    }

    /// The default transfer: the owner moves `quantity_kg` to the Buyer, signed by the owner's
    /// wallet for ten minutes.
    fn args(&self, quantity_kg: u64, expected_revision: u64) -> TransferArgs {
        TransferArgs {
            quantity_kg,
            expected_revision,
            valid_until: self.now + INTENT_WINDOW,
            owner: self.owner,
            recipient: self.buyer,
            authority: self.authority,
            signers: vec![Owner],
            text: None,
            from_position: None,
        }
    }

    /// The text the program rebuilds from chain state and the arguments (program-lots.md §6.3).
    fn text(&self, args: &TransferArgs) -> Vec<u8> {
        let owner = self.f.read::<Organisation>(args.owner).display_name;
        let recipient = self.f.read::<Organisation>(args.recipient).display_name;
        transfer_message(
            &ID,
            &INSTANCE,
            self.spec.lot_id,
            args.quantity_kg,
            &owner,
            &recipient,
            args.expected_revision,
            args.valid_until,
        )
    }

    /// The Ed25519 verification instruction followed by `transfer`.
    fn transfer(&self, args: &TransferArgs) -> [Instruction; 2] {
        let text = args.text.clone().unwrap_or_else(|| self.text(args));
        let entries: Vec<(&Keypair, &[u8])> = args
            .signers
            .iter()
            .map(|actor| (self.f.signer(*actor), text.as_slice()))
            .collect();
        [
            ed25519_instruction(&entries),
            self.transfer_instruction(args),
        ]
    }

    fn transfer_instruction(&self, args: &TransferArgs) -> Instruction {
        let a = self.addresses(args);
        ix(
            accounts::Transfer {
                sponsor: self.f.payer(),
                protocol: self.f.protocol,
                authority: args.authority,
                lot: self.lot,
                mint: a.mint,
                owner: args.owner,
                from_position: a.from_position,
                from_vault_authority: a.from_vault_authority,
                from_vault: a.from_vault,
                recipient: args.recipient,
                to_position: a.to_position,
                to_vault_authority: a.to_vault_authority,
                to_vault: a.to_vault,
                instructions: INSTRUCTIONS_SYSVAR,
                token_program: TOKEN_2022,
                associated_token_program: ASSOCIATED_TOKEN,
                system_program: SYSTEM,
            },
            instruction::Transfer {
                quantity_kg: args.quantity_kg,
                expected_revision: args.expected_revision,
                valid_until: args.valid_until,
            },
        )
    }

    fn snapshot(&self, args: &TransferArgs) -> Snapshot {
        let a = self.addresses(args);
        Snapshot {
            lot: self.f.read(self.lot),
            from: self.f.read(a.from_position),
            to: self
                .f
                .account_exists(a.to_position)
                .then(|| self.f.read(a.to_position)),
            mint_supply: self.f.mint_supply(a.mint),
        }
    }

    /// Sends the transfer and checks every effect program-lots.md §6.3 promises.
    fn transfer_ok(&mut self, args: &TransferArgs) -> TransactionMetadata {
        let instructions = self.transfer(args);
        self.send_transfer(args, &instructions)
    }

    /// As `transfer_ok`, for instructions the test built itself.
    fn send_transfer(
        &mut self,
        args: &TransferArgs,
        instructions: &[Instruction; 2],
    ) -> TransactionMetadata {
        let before = self.snapshot(args);
        let tx = self.f.sponsored_ok(instructions);
        self.assert_transferred(args, &before, &tx);
        tx
    }

    fn assert_transferred(&self, args: &TransferArgs, before: &Snapshot, tx: &TransactionMetadata) {
        let f = &self.f;
        let a = self.addresses(args);
        let q = args.quantity_kg;

        let from: Position = f.read(a.from_position);
        assert_eq!(from.protocol, f.protocol);
        assert_eq!(from.lot, self.lot);
        assert_eq!(from.owner, args.owner);
        assert_eq!(from.quantity_kg, before.from.quantity_kg - q);
        assert_eq!(from.locked_kg, before.from.locked_kg);
        assert_eq!(from.reserved_kg, before.from.reserved_kg);
        assert_eq!(from.revision, before.from.revision + 1);
        assert_eq!(from.bump, before.from.bump);

        let to: Position = f.read(a.to_position);
        assert_eq!(to.protocol, f.protocol);
        assert_eq!(to.lot, self.lot);
        assert_eq!(to.owner, args.recipient);
        match &before.to {
            Some(previous) => {
                assert_eq!(to.quantity_kg, previous.quantity_kg + q);
                assert_eq!(to.locked_kg, previous.locked_kg);
                assert_eq!(to.reserved_kg, previous.reserved_kg);
                assert_eq!(to.revision, previous.revision + 1);
                assert_eq!(to.bump, previous.bump);
            }
            None => {
                assert_eq!(to.quantity_kg, q);
                assert_eq!(to.locked_kg, 0);
                assert_eq!(to.reserved_kg, 0);
                assert_eq!(to.revision, 0);
            }
        }

        let lot: Lot = f.read(self.lot);
        assert_eq!(lot.revision, before.lot.revision + 1);
        assert_eq!(lot.supply_kg, before.lot.supply_kg);
        assert_eq!(lot.state, before.lot.state);
        assert_eq!(lot.restriction, before.lot.restriction);
        assert_eq!(lot.expires_at, before.lot.expires_at);
        assert_eq!(lot.live_children, before.lot.live_children);
        assert_eq!(lot.lot_id, before.lot.lot_id);
        assert_eq!(lot.mint, a.mint);

        assert_eq!(f.mint_supply(a.mint), before.mint_supply);
        assert_eq!(f.owner(a.from_vault), Some(TOKEN_2022));
        assert_eq!(f.owner(a.to_vault), Some(TOKEN_2022));
        assert_eq!(f.token_amount(a.from_vault), from.quantity_kg);
        assert_eq!(f.token_amount(a.to_vault), to.quantity_kg);
        // Seed-checked signing PDAs hold no account.
        assert!(!f.account_exists(a.from_vault_authority));
        assert!(!f.account_exists(a.to_vault_authority));

        assert_event(
            tx,
            events::UnitsTransferred {
                lot: self.lot,
                from: args.owner,
                to: args.recipient,
                quantity_kg: q,
                revision: before.lot.revision + 1,
            },
        );
    }

    /// The Ed25519 instruction is index 0 and `transfer` index 1 of a sponsored transaction; the
    /// fixture also asserts that nothing changed and no event was emitted.
    fn assert_refused(&mut self, args: &TransferArgs, expected: thetis::error::ThetisError) {
        let instructions = self.transfer(args);
        self.f.sponsored_refused(&instructions, 1, expected);
    }

    /// Rewrites a Position that instructions cannot yet bring into that state.
    fn forge_position(&mut self, organisation: Pubkey, change: impl FnOnce(&mut Position)) {
        let address = self.position(organisation);
        let mut position: Position = self.f.read(address);
        change(&mut position);
        self.f.set_program_account(address, &position);
    }

    /// Rewrites the Lot that instructions cannot yet bring into that state.
    fn forge_lot(&mut self, change: impl FnOnce(&mut Lot)) {
        let mut lot: Lot = self.f.read(self.lot);
        change(&mut lot);
        self.f.set_program_account(self.lot, &lot);
    }

    /// Every account a transfer may touch that is not the sponsor or a program Thetis does not
    /// own.
    fn table_addresses(&self, args: &TransferArgs) -> Vec<Pubkey> {
        let a = self.addresses(args);
        vec![
            SYSTEM,
            TOKEN_2022,
            ASSOCIATED_TOKEN,
            INSTRUCTIONS_SYSVAR,
            self.f.protocol,
            args.authority,
            args.owner,
            args.recipient,
            self.lot,
            a.mint,
            a.from_position,
            a.from_vault_authority,
            a.from_vault,
            a.to_position,
            a.to_vault_authority,
            a.to_vault,
        ]
    }

    /// Transfers through a v0 transaction with a lookup table, asserting that it fits in one
    /// packet and in the compute budget it asks for. Returns `(bytes, compute units)`.
    fn transfer_v0(&mut self, args: &TransferArgs) -> (usize, u64) {
        let table = self.f.create_lookup_table(self.table_addresses(args));
        let limit = Instruction {
            program_id: solana_sdk_ids::compute_budget::ID,
            accounts: vec![],
            data: [vec![2], COMPUTE_UNIT_LIMIT.to_le_bytes().to_vec()].concat(),
        };
        let [verify, transfer] = self.transfer(args);
        let tx = self.f.sponsored_v0(&[limit, verify, transfer], &[table]);
        assert_eq!(tx.signatures.len(), 1, "only the sponsor signs");
        let size = transaction_size(&tx);
        assert!(
            size <= PACKET_DATA_SIZE,
            "transfer v0 transaction is {size} bytes"
        );

        let before = self.snapshot(args);
        let meta = self
            .f
            .send(tx)
            .unwrap_or_else(|failure| panic!("{:?}\n{}", failure.err, failure.meta.pretty_logs()));
        let units = meta.compute_units_consumed;
        assert!(
            units <= u64::from(COMPUTE_UNIT_LIMIT),
            "transfer used {units} compute units"
        );
        self.assert_transferred(args, &before, &meta);
        (size, units)
    }
}

#[test]
fn transfer_moves_partial_quantity_to_buyer() {
    let mut w = World::demo();
    let args = w.args(1_000_000, 0);
    let a = w.addresses(&args);
    assert!(!w.f.account_exists(a.to_position));
    assert!(!w.f.account_exists(a.to_vault));

    let tx = w.transfer_ok(&args);

    let from: Position = w.f.read(a.from_position);
    assert_eq!(from.quantity_kg, 4_000_000);
    assert_eq!(from.revision, 1);
    let to: Position = w.f.read(a.to_position);
    assert_eq!(to.protocol, w.f.protocol);
    assert_eq!(to.lot, w.lot);
    assert_eq!(to.owner, w.buyer);
    assert_eq!(to.quantity_kg, 1_000_000);
    assert_eq!(to.locked_kg, 0);
    assert_eq!(to.reserved_kg, 0);
    assert_eq!(to.revision, 0);
    let lot: Lot = w.f.read(w.lot);
    assert_eq!(lot.revision, 1);
    assert_eq!(lot.supply_kg, 5_000_000);
    assert_eq!(w.f.mint_supply(a.mint), 5_000_000);
    assert_eq!(w.f.token_amount(a.from_vault), 4_000_000);
    assert_eq!(w.f.token_amount(a.to_vault), 1_000_000);
    assert_eq!(w.f.owner(a.to_vault), Some(TOKEN_2022));
    assert_event(
        &tx,
        events::UnitsTransferred {
            lot: w.lot,
            from: w.owner,
            to: w.buyer,
            quantity_kg: 1_000_000,
            revision: 1,
        },
    );
}

#[test]
fn transfer_moves_whole_position() {
    let mut w = World::demo();
    let args = w.args(5_000_000, 0);
    let a = w.addresses(&args);

    w.transfer_ok(&args);

    assert!(w.f.account_exists(a.from_position));
    let from: Position = w.f.read(a.from_position);
    assert_eq!(from.quantity_kg, 0);
    assert_eq!(from.revision, 1);
    assert_eq!(w.f.token_amount(a.from_vault), 0);
    let to: Position = w.f.read(a.to_position);
    assert_eq!(to.quantity_kg, 5_000_000);
    assert_eq!(w.f.token_amount(a.to_vault), 5_000_000);
    assert_eq!(w.f.mint_supply(a.mint), 5_000_000);
}

#[test]
fn transfer_creates_recipient_position_once_then_reuses_it() {
    let mut w = World::demo();
    let first = w.args(1_000_000, 0);
    let a = w.addresses(&first);

    w.transfer_ok(&first);
    let created = w.f.owner_and_data_len(a.to_position);
    assert!(created.is_some());

    let second = w.args(500_000, 1);
    let tx = w.transfer_ok(&second);

    assert_eq!(w.f.owner_and_data_len(a.to_position), created);
    let to: Position = w.f.read(a.to_position);
    assert_eq!(to.quantity_kg, 1_500_000);
    assert_eq!(to.revision, 1);
    let from: Position = w.f.read(a.from_position);
    assert_eq!(from.quantity_kg, 3_500_000);
    assert_eq!(from.revision, 2);
    assert_eq!(w.f.read::<Lot>(w.lot).revision, 2);
    assert_eq!(w.f.token_amount(a.to_vault), 1_500_000);
    assert_eq!(w.f.token_amount(a.from_vault), 3_500_000);
    assert_event(
        &tx,
        events::UnitsTransferred {
            lot: w.lot,
            from: w.owner,
            to: w.buyer,
            quantity_kg: 500_000,
            revision: 2,
        },
    );
}

#[test]
fn transfer_checks_the_source_position_revision() {
    let mut w = World::demo();
    w.transfer_ok(&w.args(1_000_000, 0));
    let onward = TransferArgs {
        owner: w.buyer,
        recipient: w.other_buyer,
        authority: w.buyer_authority,
        signers: vec![Buyer],
        ..w.args(100_000, 0)
    };

    w.transfer_ok(&onward);

    assert_eq!(w.f.read::<Lot>(w.lot).revision, 2);
    assert_eq!(w.f.read::<Position>(w.position(w.owner)).revision, 1);
    assert_eq!(w.f.read::<Position>(w.position(w.buyer)).revision, 1);
    // The Lot's revision is 2, but the owner's Position is at 1: only the latter counts.
    w.assert_refused(&w.args(500_000, 2), StaleRevision);

    w.transfer_ok(&w.args(500_000, 1));
}

#[test]
fn transfer_rejects_wrong_owner() {
    let mut w = World::demo();
    let args = TransferArgs {
        recipient: w.other_buyer,
        authority: w.buyer_authority,
        signers: vec![Buyer],
        ..w.args(1_000_000, 0)
    };

    w.assert_refused(&args, WrongOrganisation);
}

#[test]
fn transfer_rejects_position_of_another_owner() {
    let mut w = World::demo();
    // The Buyer names itself as owner but passes the Exporter's Position.
    let args = TransferArgs {
        owner: w.buyer,
        recipient: w.other_buyer,
        authority: w.buyer_authority,
        signers: vec![Buyer],
        from_position: Some(w.position(w.owner)),
        ..w.args(1_000_000, 0)
    };

    w.assert_refused(&args, WrongOrganisation);
}

#[test]
fn transfer_rejects_authority_without_transfer_scope() {
    let mut w = World::demo();
    let delegate = w.f.delegate(
        OrgAdmin,
        w.owner,
        w.f.key(Outsider),
        state::scope::SPLIT,
        NOW + DAY,
    );
    w.f.ok(delegate, OrgAdmin);
    let args = TransferArgs {
        authority: w.f.authority(w.f.key(Outsider)),
        signers: vec![Outsider],
        ..w.args(1_000_000, 0)
    };

    w.assert_refused(&args, ScopeMissing);
}

#[test]
fn transfer_rejects_revoked_authority() {
    let mut w = World::demo();
    let revoke = w.f.revoke(OrgAdmin, w.owner, w.authority);
    w.f.ok(revoke, OrgAdmin);

    w.assert_refused(&w.args(1_000_000, 0), AuthorityRevoked);
}

#[test]
fn transfer_rejects_window_of_601_seconds() {
    let mut w = World::demo();
    let args = TransferArgs {
        valid_until: w.now + 601,
        ..w.args(1_000_000, 0)
    };

    w.assert_refused(&args, WindowTooLong);
}

#[test]
fn transfer_rejects_recipient_role_not_approved() {
    let mut w = World::demo();
    let args = TransferArgs {
        recipient: w.transporter,
        ..w.args(1_000_000, 0)
    };

    w.assert_refused(&args, RecipientNotApproved);
}

#[test]
fn transfer_rejects_recipient_equal_to_owner() {
    let mut w = World::demo();
    let args = TransferArgs {
        recipient: w.owner,
        ..w.args(1_000_000, 0)
    };

    w.assert_refused(&args, InvalidField);
}

#[test]
fn transfer_rejects_more_than_available() {
    let mut w = World::demo();

    w.assert_refused(&w.args(5_000_001, 0), InsufficientAvailable);
}

#[test]
fn transfer_rejects_locked_units() {
    let mut w = World::demo();
    w.forge_position(w.owner, |position| position.locked_kg = 1_000_000);

    w.assert_refused(&w.args(4_000_001, 0), InsufficientAvailable);

    w.transfer_ok(&w.args(4_000_000, 0));
}

#[test]
fn transfer_rejects_zero_quantity() {
    let mut w = World::demo();

    w.assert_refused(&w.args(0, 0), ZeroQuantity);
}

#[test]
fn transfer_rejects_stale_revision_replay() {
    let mut w = World::demo();
    let args = w.args(1_000_000, 0);
    let instructions = w.transfer(&args);

    w.send_transfer(&args, &instructions);

    w.f.sponsored_refused(&instructions, 1, StaleRevision);
}

#[test]
fn transfer_rejects_expired_intent() {
    let mut w = World::demo();
    let args = w.args(1_000_000, 0);
    assert_eq!(args.valid_until, NOW + INTENT_WINDOW);
    w.advance_to(args.valid_until + 1);

    w.assert_refused(&args, Expired);
}

#[test]
fn transfer_rejects_when_paused() {
    let mut w = World::demo();
    let pause = w.f.change_pause(Admin, state::pause::TRANSFER, true);
    w.f.ok(pause, Admin);

    w.assert_refused(&w.args(1_000_000, 0), Paused);
}

#[test]
fn transfer_rejects_redeemed_lot() {
    let mut w = World::demo();
    w.forge_lot(|lot| lot.state = LotState::Redeemed);

    w.assert_refused(&w.args(1_000_000, 0), LotNotStored);
}

#[test]
fn transfer_rejects_wrong_signer() {
    let mut w = World::demo();
    let args = TransferArgs {
        signers: vec![Buyer],
        ..w.args(1_000_000, 0)
    };

    w.assert_refused(&args, WrongSigner);
}

#[test]
fn transfer_rejects_wrong_text() {
    let mut w = World::demo();
    let args = w.args(1_000_000, 0);
    let other = TransferArgs {
        quantity_kg: 2_000_000,
        ..args.clone()
    };
    let args = TransferArgs {
        text: Some(w.text(&other)),
        ..args
    };

    w.assert_refused(&args, MessageMismatch);
}

#[test]
fn transfer_demo_transaction_fits_1232_bytes() {
    let mut w = World::demo();
    let args = w.args(1_000_000, 0);

    let (size, units) = w.transfer_v0(&args);

    println!("transfer v0 demo: {size} bytes, {units} CU");
}

#[test]
fn transfer_transaction_fits_1232_bytes() {
    let spec = Spec::widest();
    assert_eq!(spec.owner_name.len(), state::MAX_DISPLAY_NAME);
    assert_eq!(spec.buyer_name.len(), state::MAX_DISPLAY_NAME);
    assert_ne!(spec.owner_name, spec.buyer_name);
    assert_eq!(spec.lot_id.len(), state::MAX_LOT_ID);
    assert_eq!(spec.lot_quantity_kg, u64::MAX);
    let mut w = World::build(spec);
    let revision = u64::MAX - 1;
    assert_eq!(revision.to_string().len(), 20);
    w.forge_position(w.owner, |position| position.revision = revision);
    w.forge_lot(|lot| lot.revision = revision);
    let args = w.args(u64::MAX, revision);
    assert!(!w.f.account_exists(w.addresses(&args).to_position));

    let (size, units) = w.transfer_v0(&args);

    println!("transfer v0 widest: {size} bytes, {units} CU");
}
