//! Sponsored redemption, intake retirement, and transaction size coverage.

mod common;

use anchor_lang::{prelude::Pubkey, AccountDeserialize, AccountSerialize};
use common::{Actor::*, *};
use litesvm::types::TransactionMetadata;
use solana_keypair::Keypair;
use solana_message::AddressLookupTableAccount;
use solana_transaction::Instruction;
use thetis::{
    accounts,
    error::ThetisError::*,
    events, instruction,
    intent::message::{issue_message, redeem_message, split_message},
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
const TICKET: [u8; 32] = digest(0x80);

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
const OTHER_CUSTODIAN_ID: u8 = 6;

const OTHER_CUSTODIAN_NAME: &str = "Sekoto Yard Custody";

/// Everything about the demo world that a test may need to vary.
struct Spec {
    class_code: &'static str,
    class_version: u32,
    grades: [&'static str; 2],
    owner_name: &'static str,
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
            custodian_name: "Kopano Stockyard Custody",
            site_code: "PORT-STOCKYARD",
            approved_capacity_kg: 10_000_000,
            document_version: 1,
            lot_id: "CR-0001",
            lot_quantity_kg: 5_000_000,
        }
    }

    /// Maximum-width lot and organisation identifiers, with capacity for a u64 quantity.
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
            lot_id: "CR-0001-WIDEST-1",
            lot_quantity_kg: u64::MAX,
        }
    }
}

struct RedeemArgs {
    lot_id: String,
    quantity_kg: u64,
    collection_ticket: [u8; 32],
    expected_revision: u64,
    valid_until: i64,
    root: Option<Pubkey>,
    intake: Pubkey,
    custodian: Pubkey,
    custodian_authority: Pubkey,
    signers: Vec<Actor>,
}

struct Addresses {
    lot: Pubkey,
    mint: Pubkey,
    position: Pubkey,
    vault_authority: Pubkey,
    vault: Pubkey,
}

struct Snapshot {
    lot: Lot,
    position: Position,
    site: CustodianClass,
    intake: IntakeIdentity,
    root: Option<Lot>,
}

struct World {
    f: Fixture,
    spec: Spec,
    /// The clock, mirrored here so intents are signed relative to it.
    now: i64,
    owner: Pubkey,
    custodian: Pubkey,
    other_custodian: Pubkey,
    issuer_org: Pubkey,
    class_policy: Pubkey,
    custodian_class: Pubkey,
    /// The Authority of the custodian wallet, scopes ISSUE | REDEEM.
    custodian_authority: Pubkey,
    /// The Authority of the other custodian's wallet, scopes ISSUE | REDEEM.
    other_custodian_authority: Pubkey,
    /// The Authority of the owner's wallet, scopes TRANSFER | SPLIT | REDEEM.
    authority: Pubkey,
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
        let other_custodian = f.organisation(OTHER_CUSTODIAN_ID);
        let accredit = f.accredit(
            Accreditor,
            OTHER_CUSTODIAN_ID,
            Role::Custodian,
            OTHER_CUSTODIAN_NAME,
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
            state::scope::ISSUE | state::scope::REDEEM,
            NOW + DAY,
        );
        f.ok(delegate, OrgAdmin);
        let delegate = f.delegate(
            OrgAdmin,
            other_custodian,
            f.key(Custodian2),
            state::scope::ISSUE | state::scope::REDEEM,
            NOW + DAY,
        );
        f.ok(delegate, OrgAdmin);
        let delegate = f.delegate(
            OrgAdmin,
            owner,
            f.key(Owner),
            state::scope::TRANSFER | state::scope::SPLIT | state::scope::REDEEM,
            NOW + DAY,
        );
        f.ok(delegate, OrgAdmin);
        let custodian_authority = f.authority(f.key(Custodian));
        let other_custodian_authority = f.authority(f.key(Custodian2));
        let authority = f.authority(f.key(Owner));
        let lot = pda(&[b"lot", f.protocol.as_ref(), spec.lot_id.as_bytes()]);
        let mut world = Self {
            f,
            spec,
            now: NOW,
            owner,
            custodian,
            other_custodian,
            issuer_org,
            class_policy,
            custodian_class,
            custodian_authority,
            other_custodian_authority,
            authority,
            lot,
        };
        world.issue_lot(world.spec.lot_id, world.spec.lot_quantity_kg, INTAKE_DIGEST);
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

    fn issue_instructions(
        &self,
        lot_id: &str,
        quantity_kg: u64,
        intake_digest: [u8; 32],
    ) -> [Instruction; 2] {
        let origin = self.f.document(
            DocumentKind::Origin,
            intake_digest,
            self.spec.document_version,
        );
        let grade = self.spec.grades[0];
        let valid_until = self.now + INTENT_WINDOW;
        let protocol = self.f.protocol;
        let intake = pda(&[
            b"intake",
            protocol.as_ref(),
            self.custodian.as_ref(),
            &intake_digest,
        ]);
        let a = self.lot_addresses(self.lot_key(lot_id));

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
                lot: a.lot,
                mint: a.mint,
                mint_authority: pda(&[b"mint_authority", a.mint.as_ref()]),
                position: a.position,
                vault_authority: a.vault_authority,
                vault: a.vault,
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
        [verify, issue]
    }

    fn issue_lot(&mut self, lot_id: &str, quantity_kg: u64, intake_digest: [u8; 32]) {
        let instructions = self.issue_instructions(lot_id, quantity_kg, intake_digest);
        self.f.sponsored_ok(&instructions);

        let lot = self.lot_key(lot_id);
        let issued: Lot = self.f.read(lot);
        assert_eq!(issued.lot_id, lot_id);
        assert_eq!(issued.state, LotState::Stored);
        assert_eq!(issued.supply_kg, quantity_kg);
        assert_eq!(issued.revision, 0);
        assert_eq!(issued.parent, None);
        assert_eq!(issued.root, lot);
        let a = self.lot_addresses(lot);
        let held: Position = self.f.read(a.position);
        assert_eq!(held.owner, self.owner);
        assert_eq!(held.quantity_kg, quantity_kg);
        assert_eq!(held.revision, 0);
        assert_eq!(self.f.token_amount(a.vault), quantity_kg);
        assert_eq!(self.f.mint_supply(a.mint), quantity_kg);
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
        self.issue_lot("CR-0002", 1_000_000, SECOND_DIGEST);
        self.lot_key("CR-0002")
    }

    fn intake(&self) -> Pubkey {
        self.f.read::<Lot>(self.lot).intake
    }

    fn args(&self, quantity_kg: u64, expected_revision: u64) -> RedeemArgs {
        self.args_for(self.spec.lot_id, quantity_kg, expected_revision)
    }

    fn args_for(&self, lot_id: &str, quantity_kg: u64, expected_revision: u64) -> RedeemArgs {
        let lot: Lot = self.f.read(self.lot_key(lot_id));
        RedeemArgs {
            lot_id: lot_id.into(),
            quantity_kg,
            collection_ticket: TICKET,
            expected_revision,
            valid_until: self.now + INTENT_WINDOW,
            root: lot.parent.map(|_| lot.root),
            intake: lot.intake,
            custodian: self.custodian,
            custodian_authority: self.custodian_authority,
            signers: vec![Owner, Custodian],
        }
    }

    fn lot_addresses(&self, lot: Pubkey) -> Addresses {
        let position = self.position_key(lot, self.owner);
        let mint = pda(&[b"mint", lot.as_ref()]);
        let vault_authority = pda(&[b"vault", position.as_ref()]);
        Addresses {
            lot,
            mint,
            position,
            vault_authority,
            vault: associated_token(vault_authority, mint),
        }
    }

    fn redeem_addresses(&self, args: &RedeemArgs) -> Addresses {
        self.lot_addresses(self.lot_key(&args.lot_id))
    }

    fn redeem_instruction(&self, args: &RedeemArgs) -> Instruction {
        let a = self.redeem_addresses(args);
        ix(
            accounts::Redeem {
                sponsor: self.f.payer(),
                protocol: self.f.protocol,
                owner_authority: self.authority,
                custodian_authority: args.custodian_authority,
                owner: self.owner,
                custodian: args.custodian,
                custodian_class: self.custodian_class,
                lot: a.lot,
                root: args.root,
                intake: args.intake,
                mint: a.mint,
                position: a.position,
                vault_authority: a.vault_authority,
                vault: a.vault,
                instructions: INSTRUCTIONS_SYSVAR,
                token_program: TOKEN_2022,
            },
            instruction::Redeem {
                quantity_kg: args.quantity_kg,
                collection_ticket: args.collection_ticket,
                expected_revision: args.expected_revision,
                valid_until: args.valid_until,
            },
        )
    }

    fn redeem_instructions(&self, args: &RedeemArgs) -> [Instruction; 2] {
        let custodian: Organisation = self.f.read(args.custodian);
        let text = redeem_message(
            &ID,
            &INSTANCE,
            &args.lot_id,
            args.quantity_kg,
            self.spec.owner_name,
            &custodian.display_name,
            &args.collection_ticket,
            args.expected_revision,
            args.valid_until,
        );
        let signers: Vec<&Keypair> = args
            .signers
            .iter()
            .map(|actor| self.f.signer(*actor))
            .collect();
        [
            ed25519_shared_instruction(&signers, &text),
            self.redeem_instruction(args),
        ]
    }

    fn snapshot(&self, args: &RedeemArgs) -> Snapshot {
        let a = self.redeem_addresses(args);
        let lot: Lot = self.f.read(a.lot);
        let position: Position = self.f.read(a.position);
        assert_eq!(self.f.token_amount(a.vault), position.quantity_kg);
        assert_eq!(self.f.mint_supply(a.mint), lot.supply_kg);
        Snapshot {
            lot,
            position,
            site: self.f.read(self.custodian_class),
            intake: self.f.read(args.intake),
            root: args.root.map(|root| self.f.read(root)),
        }
    }

    fn assert_redeemed(&self, args: &RedeemArgs, before: Snapshot, tx: &TransactionMetadata) {
        let a = self.redeem_addresses(args);
        let qty = args.quantity_kg;
        let Snapshot {
            mut lot,
            mut position,
            mut site,
            mut intake,
            mut root,
        } = before;

        lot.supply_kg -= qty;
        lot.revision += 1;
        let lot_redeemed = lot.supply_kg == 0;
        if lot_redeemed {
            lot.state = LotState::Redeemed;
            if let Some(root) = &mut root {
                root.live_children -= 1;
            }
        }
        position.quantity_kg -= qty;
        position.revision += 1;
        site.occupied_kg -= qty;
        let family_root = root.as_ref().unwrap_or(&lot);
        assert_eq!(family_root.root, intake.lot);
        assert_eq!(lot.intake, args.intake);
        intake.retired = family_root.supply_kg == 0 && family_root.live_children == 0;

        self.assert_account(a.lot, &lot);
        self.assert_account(a.position, &position);
        self.assert_account(self.custodian_class, &site);
        self.assert_account(args.intake, &intake);
        if let Some(root) = root {
            self.assert_account(lot.root, &root);
        }
        assert_eq!(self.f.token_amount(a.vault), position.quantity_kg);
        assert_eq!(self.f.mint_supply(a.mint), lot.supply_kg);
        assert!(position.locked_kg + position.reserved_kg <= position.quantity_kg);
        // The fixture has one holder per lot.
        assert_eq!(position.quantity_kg, lot.supply_kg);
        assert!(site.occupied_kg + site.reserved_inbound_kg <= site.approved_capacity_kg);
        assert_event(
            tx,
            events::UnitsRedeemed {
                lot: a.lot,
                owner: self.owner,
                quantity_kg: qty,
                collection_ticket: args.collection_ticket,
                revision: lot.revision,
                lot_redeemed,
            },
        );
    }

    /// Compare all serialized fields, allowing for the account's allocated padding.
    fn assert_account(&self, address: Pubkey, expected: &impl anchor_lang::AccountSerialize) {
        let mut data = self.f.data(address);
        let mut fields = Vec::new();
        expected.try_serialize(&mut fields).unwrap();
        assert!(data.len() >= fields.len(), "account {address} is too short");
        data.truncate(fields.len());
        assert_eq!(data, fields, "account {address}");
    }

    fn redeem_ok(&mut self, args: &RedeemArgs) -> TransactionMetadata {
        let before = self.snapshot(args);
        let tx = self.f.sponsored_ok(&self.redeem_instructions(args));
        self.assert_redeemed(args, before, &tx);
        tx
    }

    fn assert_refused(&mut self, args: &RedeemArgs, expected: thetis::error::ThetisError) {
        self.f
            .sponsored_refused(&self.redeem_instructions(args), 1, expected);
    }

    fn split_ok(&mut self, parent_id: &str, child_id: &str, quantity_kg: u64) {
        let a = self.lot_addresses(self.lot_key(parent_id));
        let parent: Lot = self.f.read(a.lot);
        let child = self.lot_addresses(self.lot_key(child_id));
        let valid_until = self.now + INTENT_WINDOW;
        let text = split_message(
            &ID,
            &INSTANCE,
            parent_id,
            child_id,
            quantity_kg,
            self.spec.owner_name,
            self.spec.custodian_name,
            parent.revision,
            valid_until,
        );
        let verify =
            ed25519_shared_instruction(&[self.f.signer(Owner), self.f.signer(Custodian)], &text);
        let split = ix(
            accounts::Split {
                sponsor: self.f.payer(),
                protocol: self.f.protocol,
                owner_authority: self.authority,
                custodian_authority: self.custodian_authority,
                lot: a.lot,
                root: parent.parent.map(|_| parent.root),
                class_policy: self.class_policy,
                custodian_class: self.custodian_class,
                owner: self.owner,
                custodian: self.custodian,
                mint: a.mint,
                position: a.position,
                vault_authority: a.vault_authority,
                vault: a.vault,
                child_lot: child.lot,
                child_mint: child.mint,
                child_mint_authority: pda(&[b"mint_authority", child.mint.as_ref()]),
                child_position: child.position,
                child_vault_authority: child.vault_authority,
                child_vault: child.vault,
                instructions: INSTRUCTIONS_SYSVAR,
                token_program: TOKEN_2022,
                associated_token_program: ASSOCIATED_TOKEN,
                system_program: SYSTEM,
            },
            instruction::Split {
                child_lot_id: child_id.into(),
                quantity_kg,
                expected_revision: parent.revision,
                valid_until,
            },
        );
        self.f.sponsored_ok(&[verify, split]);
    }

    fn forge_account<T: AccountDeserialize + AccountSerialize>(
        &mut self,
        address: Pubkey,
        change: impl FnOnce(&mut T),
    ) {
        let mut account = self.f.read(address);
        change(&mut account);
        self.f.set_program_account(address, &account);
    }

    fn forge_position(&mut self, lot: Pubkey, change: impl FnOnce(&mut Position)) {
        self.forge_account(self.position_key(lot, self.owner), change);
    }

    fn table(&mut self, calls: &[&RedeemArgs]) -> AddressLookupTableAccount {
        let mut addresses = Vec::new();
        for args in calls {
            for meta in self.redeem_instruction(args).accounts {
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

    fn redeem_v0(&mut self, args: &RedeemArgs, table: &AddressLookupTableAccount) -> (usize, u64) {
        let limit = Instruction {
            program_id: solana_sdk_ids::compute_budget::ID,
            accounts: vec![],
            data: [vec![2], COMPUTE_UNIT_LIMIT.to_le_bytes().to_vec()].concat(),
        };
        let [verify, redeem] = self.redeem_instructions(args);
        let tx = self
            .f
            .sponsored_v0(&[limit, verify, redeem], std::slice::from_ref(table));
        assert_eq!(tx.signatures.len(), 1, "only the sponsor signs");
        let size = transaction_size(&tx);
        let before = self.snapshot(args);
        let meta = self
            .f
            .send(tx)
            .unwrap_or_else(|failure| panic!("{:?}\n{}", failure.err, failure.meta.pretty_logs()));
        self.assert_redeemed(args, before, &meta);
        eprintln!(
            "redeem v0 for {}: {size} bytes, {} compute units",
            args.lot_id, meta.compute_units_consumed
        );
        (size, meta.compute_units_consumed)
    }
}

#[test]
fn redeem_partial_burns_units_and_frees_capacity() {
    let mut w = World::demo();
    let args = w.args(2_000_000, 0);
    let site: CustodianClass = w.f.read(w.custodian_class);
    assert_eq!(site.occupied_kg, 5_000_000);

    let tx = w.redeem_ok(&args);

    let lot: Lot = w.f.read(w.lot);
    assert_eq!(lot.supply_kg, 3_000_000);
    assert_eq!(lot.state, LotState::Stored);
    assert_eq!(lot.revision, 1);
    let position: Position = w.f.read(w.root_position(w.owner));
    assert_eq!(position.quantity_kg, 3_000_000);
    assert_eq!(position.revision, 1);
    let a = w.redeem_addresses(&args);
    assert_eq!(w.f.token_amount(a.vault), 3_000_000);
    assert_eq!(w.f.mint_supply(a.mint), 3_000_000);
    let site: CustodianClass = w.f.read(w.custodian_class);
    assert_eq!(site.occupied_kg, 3_000_000);
    assert!(!w.f.read::<IntakeIdentity>(w.intake()).retired);
    assert_event(
        &tx,
        events::UnitsRedeemed {
            lot: w.lot,
            owner: w.owner,
            quantity_kg: 2_000_000,
            collection_ticket: TICKET,
            revision: 1,
            lot_redeemed: false,
        },
    );
}

#[test]
fn redeem_final_unit_sets_redeemed() {
    let mut w = World::demo();
    w.redeem_ok(&w.args(2_000_000, 0));
    let tx = w.redeem_ok(&w.args(3_000_000, 1));

    let lot: Lot = w.f.read(w.lot);
    assert_eq!(lot.state, LotState::Redeemed);
    assert_eq!(lot.supply_kg, 0);
    assert_eq!(lot.revision, 2);
    let position: Position = w.f.read(w.root_position(w.owner));
    assert_eq!(position.quantity_kg, 0);
    assert_eq!(position.revision, 2);
    assert_eq!(w.f.mint_supply(lot.mint), 0, "the mint stays, empty");
    assert!(
        w.f.account_exists(w.lot),
        "the Lot is a tombstone, never closed"
    );
    let site: CustodianClass = w.f.read(w.custodian_class);
    assert_eq!(site.occupied_kg, 0);
    assert_event(
        &tx,
        events::UnitsRedeemed {
            lot: w.lot,
            owner: w.owner,
            quantity_kg: 3_000_000,
            collection_ticket: TICKET,
            revision: 2,
            lot_redeemed: true,
        },
    );
    // A redeemed lot takes no further redemption.
    w.assert_refused(&w.args(1, 2), LotNotStored);
}

#[test]
fn redeem_retires_intake_identity_when_family_is_empty() {
    // The CR-0001 -> A -> B lineage of tests/split.rs.
    let mut w = World::demo();
    w.split_ok("CR-0001", "CR-0001-A", 2_000_000);
    w.split_ok("CR-0001-A", "CR-0001-B", 500_000);
    assert_eq!(w.f.read::<Lot>(w.lot).live_children, 2);
    let intake = w.intake();

    // Root: 3,000,000 kg left (its position revision is 1 after the split).
    w.redeem_ok(&w.args(3_000_000, 1));
    assert_eq!(w.f.read::<Lot>(w.lot).state, LotState::Redeemed);
    assert!(!w.f.read::<IntakeIdentity>(intake).retired);
    assert_eq!(w.f.read::<Lot>(w.lot).live_children, 2);

    // A (1,500,000 kg left, position revision 1): reaching zero frees one child slot.
    w.redeem_ok(&w.args_for("CR-0001-A", 1_500_000, 1));
    assert_eq!(w.f.read::<Lot>(w.lot).live_children, 1);
    assert!(!w.f.read::<IntakeIdentity>(intake).retired);

    // B: the last unit of the family retires the intake.
    w.redeem_ok(&w.args_for("CR-0001-B", 500_000, 0));
    assert_eq!(w.f.read::<Lot>(w.lot).live_children, 0);
    let retired: IntakeIdentity = w.f.read(intake);
    assert!(retired.retired);
    assert_eq!(retired.lot, w.lot);
    assert!(
        w.f.account_exists(intake),
        "the IntakeIdentity is never closed"
    );
    let site: CustodianClass = w.f.read(w.custodian_class);
    assert_eq!(site.occupied_kg, 0);
}

#[test]
fn redeem_keeps_intake_open_while_child_has_supply() {
    let mut w = World::demo();
    w.split_ok("CR-0001", "CR-0001-A", 2_000_000);
    let intake = w.intake();

    // The root reaches zero supply while child A still holds units.
    w.redeem_ok(&w.args(3_000_000, 1));
    assert_eq!(w.f.read::<Lot>(w.lot).state, LotState::Redeemed);
    assert_eq!(w.f.read::<Lot>(w.lot).live_children, 1);
    assert!(!w.f.read::<IntakeIdentity>(intake).retired);

    // A partial redemption of the child still leaves it open.
    w.redeem_ok(&w.args_for("CR-0001-A", 1_000_000, 0));
    assert!(!w.f.read::<IntakeIdentity>(intake).retired);
    assert_eq!(w.f.read::<Lot>(w.lot).live_children, 1);
}

#[test]
fn issue_rejects_same_intake_digest_after_full_redemption() {
    // A01: the digest can never be issued again once its family is redeemed.
    let mut w = World::demo();
    w.redeem_ok(&w.args(5_000_000, 0));
    let intake = w.intake();
    assert!(w.f.read::<IntakeIdentity>(intake).retired);
    let site_before: CustodianClass = w.f.read(w.custodian_class);
    assert_eq!(site_before.occupied_kg, 0);

    let reissue = w.issue_instructions("CR-0002", 1_000_000, INTAKE_DIGEST);
    w.f.sponsored_already_in_use(&reissue, 1);

    assert!(!w.f.account_exists(w.lot_key("CR-0002")));
    let site: CustodianClass = w.f.read(w.custodian_class);
    assert_eq!(site.occupied_kg, 0);
    assert_eq!(w.f.read::<Lot>(w.lot).supply_kg, 0);
    assert!(w.f.read::<IntakeIdentity>(intake).retired);
}

#[test]
fn redeem_rejects_single_party_signature() {
    // A18: both the holder and the custodian must sign.
    let mut w = World::demo();
    let mut owner_only = w.args(1_000_000, 0);
    owner_only.signers = vec![Owner];
    w.assert_refused(&owner_only, WrongSignatureCount);

    let mut custodian_only = w.args(1_000_000, 0);
    custodian_only.signers = vec![Custodian];
    w.assert_refused(&custodian_only, WrongSignatureCount);
}

#[test]
fn redeem_rejects_wrong_custodian() {
    let mut w = World::demo();
    let mut args = w.args(1_000_000, 0);
    args.custodian = w.other_custodian;
    args.custodian_authority = w.other_custodian_authority;
    args.signers = vec![Owner, Custodian2];
    w.assert_refused(&args, WrongOrganisation);
}

#[test]
fn redeem_rejects_more_than_available() {
    let mut w = World::demo();
    w.assert_refused(&w.args(5_000_001, 0), InsufficientAvailable);
    // Exactly everything is fine.
    w.redeem_ok(&w.args(5_000_000, 0));
}

#[test]
fn redeem_rejects_missing_collection_ticket() {
    let mut w = World::demo();
    let mut args = w.args(1_000_000, 0);
    args.collection_ticket = [0; 32];
    let a = w.redeem_addresses(&args);
    let addresses = [
        a.lot,
        a.position,
        w.custodian_class,
        args.intake,
        a.mint,
        a.vault,
    ];
    let before = addresses.map(|address| w.f.data(address));

    w.assert_refused(&args, InvalidField);
    assert_eq!(addresses.map(|address| w.f.data(address)), before);

    args.collection_ticket[31] = 1;
    w.redeem_ok(&args);
}

#[test]
fn redeem_rejects_locked_units() {
    // A18: locked units cannot be collected.
    let mut w = World::demo();
    w.forge_position(w.lot, |position| position.locked_kg = 4_000_000);
    w.assert_refused(&w.args(1_000_001, 0), InsufficientAvailable);
    // The unlocked remainder still can.
    w.redeem_ok(&w.args(1_000_000, 0));
    let position: Position = w.f.read(w.root_position(w.owner));
    assert_eq!(position.quantity_kg, 4_000_000);
    assert_eq!(position.locked_kg, 4_000_000);
}

#[test]
fn redeem_rejects_zero_quantity() {
    let mut w = World::demo();
    w.assert_refused(&w.args(0, 0), ZeroQuantity);
}

#[test]
fn redeem_rejects_root_mismatch() {
    let mut w = World::demo();
    w.split_ok("CR-0001", "CR-0001-A", 2_000_000);
    let other_root = w.issue_second_root();

    // A child lot without its root.
    let mut missing = w.args_for("CR-0001-A", 1_000_000, 0);
    missing.root = None;
    w.assert_refused(&missing, RootMismatch);
    // A child lot with another family's root.
    let mut other = w.args_for("CR-0001-A", 1_000_000, 0);
    other.root = Some(other_root);
    w.assert_refused(&other, RootMismatch);
    // A child lot whose "root" is itself.
    let mut itself = w.args_for("CR-0001-A", 1_000_000, 0);
    itself.root = Some(w.lot_key("CR-0001-A"));
    w.assert_refused(&itself, RootMismatch);
    // A root lot must not pass a root.
    let mut spurious = w.args(1_000_000, 1);
    spurious.root = Some(other_root);
    w.assert_refused(&spurious, RootMismatch);
}

#[test]
fn redeem_transaction_fits_1232_bytes() {
    // Demo values with a first-level child and its root.
    let mut w = World::demo();
    w.split_ok("CR-0001", "CR-0001-A", 2_000_000);
    let args = w.args_for("CR-0001-A", 1_000_000, 0);
    let table = w.table(&[&args]);
    let (demo_size, _) = w.redeem_v0(&args, &table);
    assert!(demo_size <= PACKET_DATA_SIZE);

    let mut widest = World::build(Spec::widest());
    let child_quantity = u64::MAX - 1_000_000;
    let grandchild_quantity = child_quantity - 1;
    let grandchild_id = "CR-0001-WIDEST-B";
    widest.split_ok("CR-0001-WIDEST-1", "CR-0001-WIDEST-A", child_quantity);
    widest.split_ok("CR-0001-WIDEST-A", grandchild_id, grandchild_quantity);

    // Keep both signed numbers at maximum text width while leaving room for the revision bump.
    let revision = u64::MAX - 1;
    let grandchild = widest.lot_key(grandchild_id);
    widest.forge_position(grandchild, |position| position.revision = revision);
    let args = widest.args_for(grandchild_id, grandchild_quantity, revision);
    let table = widest.table(&[&args]);
    let (size, units) = widest.redeem_v0(&args, &table);
    assert!(
        size <= PACKET_DATA_SIZE,
        "redeem v0 transaction is {size} bytes"
    );
    assert!(units <= u64::from(COMPUTE_UNIT_LIMIT));
}

#[test]
fn redeem_checks_position_revision_independently_of_lot_revision() {
    let mut w = World::demo();
    w.forge_position(w.lot, |position| position.revision = 7);
    w.assert_refused(&w.args(1_000_000, 0), StaleRevision);
    w.redeem_ok(&w.args(1_000_000, 7));
}

#[test]
fn redeem_rejects_reserved_units() {
    let mut w = World::demo();
    w.forge_position(w.lot, |position| {
        position.locked_kg = 2_000_000;
        position.reserved_kg = 2_000_000;
    });
    let mut site: CustodianClass = w.f.read(w.custodian_class);
    site.reserved_inbound_kg = 2_000_000;
    w.f.set_program_account(w.custodian_class, &site);
    w.assert_refused(&w.args(1_000_001, 0), InsufficientAvailable);
    w.redeem_ok(&w.args(1_000_000, 0));
}

#[test]
fn redeem_rejects_substituted_intake() {
    let mut w = World::demo();
    let other_lot = w.issue_second_root();
    let mut args = w.args(1_000_000, 0);
    args.intake = w.f.read::<Lot>(other_lot).intake;
    w.assert_refused(&args, WrongOrganisation);
}

#[test]
fn redeem_rejects_intake_with_mismatched_digest() {
    let mut w = World::demo();
    let address = w.intake();
    let mut intake: IntakeIdentity = w.f.read(address);
    intake.intake_digest = SECOND_DIGEST;
    w.f.set_program_account(address, &intake);
    w.assert_refused(&w.args(1_000_000, 0), WrongOrganisation);
}

#[test]
fn redeem_rejects_owner_authority_protocol() {
    let mut w = World::demo();
    w.forge_account(w.authority, |authority: &mut Authority| {
        authority.protocol = Pubkey::new_unique();
    });
    w.assert_refused(&w.args(1, 0), WrongOrganisation);
}

#[test]
fn redeem_rejects_custodian_authority_protocol() {
    let mut w = World::demo();
    w.forge_account(w.custodian_authority, |authority: &mut Authority| {
        authority.protocol = Pubkey::new_unique();
    });
    w.assert_refused(&w.args(1, 0), WrongOrganisation);
}

#[test]
fn redeem_rejects_owner_protocol() {
    let mut w = World::demo();
    w.forge_account(w.owner, |owner: &mut Organisation| {
        owner.protocol = Pubkey::new_unique();
    });
    w.assert_refused(&w.args(1, 0), WrongOrganisation);
}

#[test]
fn redeem_rejects_custodian_protocol() {
    let mut w = World::demo();
    w.forge_account(w.custodian, |custodian: &mut Organisation| {
        custodian.protocol = Pubkey::new_unique();
    });
    w.assert_refused(&w.args(1, 0), WrongOrganisation);
}

#[test]
fn redeem_rejects_site_protocol() {
    let mut w = World::demo();
    w.forge_account(w.custodian_class, |site: &mut CustodianClass| {
        site.protocol = Pubkey::new_unique();
    });
    w.assert_refused(&w.args(1, 0), WrongOrganisation);
}

#[test]
fn redeem_rejects_lot_protocol() {
    let mut w = World::demo();
    w.forge_account(w.lot, |lot: &mut Lot| {
        lot.protocol = Pubkey::new_unique();
    });
    w.assert_refused(&w.args(1, 0), WrongOrganisation);
}

#[test]
fn redeem_rejects_intake_protocol() {
    let mut w = World::demo();
    w.forge_account(w.intake(), |intake: &mut IntakeIdentity| {
        intake.protocol = Pubkey::new_unique();
    });
    w.assert_refused(&w.args(1, 0), WrongOrganisation);
}

#[test]
fn redeem_rejects_position_protocol() {
    let mut w = World::demo();
    w.forge_position(w.lot, |position| {
        position.protocol = Pubkey::new_unique();
    });
    w.assert_refused(&w.args(1, 0), WrongOrganisation);
}

#[test]
fn redeem_rejects_owner_authority_organisation() {
    let mut w = World::demo();
    let other = w.other_custodian;
    w.forge_account(w.authority, |authority: &mut Authority| {
        authority.organisation = other;
    });
    w.assert_refused(&w.args(1, 0), WrongOrganisation);
}

#[test]
fn redeem_rejects_custodian_authority_organisation() {
    let mut w = World::demo();
    let other = w.other_custodian;
    w.forge_account(w.custodian_authority, |authority: &mut Authority| {
        authority.organisation = other;
    });
    w.assert_refused(&w.args(1, 0), WrongOrganisation);
}

#[test]
fn redeem_rejects_lot_custodian_class() {
    let mut w = World::demo();
    let site_code = "ROAD-STOCKYARD";
    let other_site = w.f.site(w.custodian, w.class_policy, site_code);
    let accredit = w.f.accredit_site(
        Accreditor,
        w.custodian,
        w.class_policy,
        site_code,
        w.spec.approved_capacity_kg,
    );
    w.f.ok(accredit, Accreditor);
    w.forge_account(w.lot, |lot: &mut Lot| lot.custodian_class = other_site);
    w.assert_refused(&w.args(1, 0), WrongOrganisation);
}

#[test]
fn redeem_rejects_site_custodian() {
    let mut w = World::demo();
    let other = w.other_custodian;
    w.forge_account(w.custodian_class, |site: &mut CustodianClass| {
        site.custodian = other;
    });
    w.assert_refused(&w.args(1, 0), WrongOrganisation);
}

#[test]
fn redeem_rejects_position_lot() {
    let mut w = World::demo();
    let other_lot = w.issue_second_root();
    w.forge_position(w.lot, |position| position.lot = other_lot);
    w.assert_refused(&w.args(1, 0), WrongOrganisation);
}

#[test]
fn redeem_rejects_position_owner() {
    let mut w = World::demo();
    let buyer = w.f.add_org(5, Role::Buyer);
    w.forge_position(w.lot, |position| position.owner = buyer);
    w.assert_refused(&w.args(1, 0), WrongOrganisation);
}

#[test]
fn redeem_rejects_lot_mint() {
    let mut w = World::demo();
    let other_lot = w.issue_second_root();
    let other_mint = w.f.read::<Lot>(other_lot).mint;
    // The transaction still passes the mint PDA of the lot being redeemed.
    w.forge_account(w.lot, |lot: &mut Lot| lot.mint = other_mint);
    w.assert_refused(&w.args(1, 0), WrongOrganisation);
}

#[test]
fn redeem_rejects_lot_intake() {
    let mut w = World::demo();
    let other_lot = w.issue_second_root();
    let other_intake = w.f.read::<Lot>(other_lot).intake;
    let args = w.args(1, 0);
    // Keep passing the original intake, so its PDA and family binding still match.
    w.forge_account(w.lot, |lot: &mut Lot| lot.intake = other_intake);
    w.assert_refused(&args, WrongOrganisation);
}

#[test]
fn redeem_rejects_intake_custodian() {
    let mut w = World::demo();
    let other = w.other_custodian;
    w.forge_account(w.intake(), |intake: &mut IntakeIdentity| {
        intake.custodian = other;
    });
    w.assert_refused(&w.args(1, 0), WrongOrganisation);
}

#[test]
fn redeem_rejects_intake_lot() {
    let mut w = World::demo();
    let other_lot = w.issue_second_root();
    w.forge_account(w.intake(), |intake: &mut IntakeIdentity| {
        intake.lot = other_lot;
    });
    w.assert_refused(&w.args(1, 0), WrongOrganisation);
}

#[test]
fn redeem_rejects_intake_pda_address() {
    let mut w = World::demo();
    let address = w.intake();
    let intake: IntakeIdentity = w.f.read(address);
    // Use a bump that derives a different valid address. This reaches the address
    // comparison instead of failing because the seeds derive an on-curve key.
    let alternate_bump = (0..=u8::MAX)
        .find(|&bump| {
            bump != intake.bump
                && Pubkey::create_program_address(
                    &[
                        b"intake",
                        w.f.protocol.as_ref(),
                        w.custodian.as_ref(),
                        &intake.intake_digest,
                        &[bump],
                    ],
                    &ID,
                )
                .is_ok_and(|derived| derived != address)
        })
        .expect("an alternate valid intake bump");
    w.forge_account(address, |intake: &mut IntakeIdentity| {
        intake.bump = alternate_bump;
    });
    w.assert_refused(&w.args(1, 0), WrongOrganisation);
}

#[test]
fn redeem_rejects_when_paused() {
    let mut w = World::demo();
    let pause_redeem = w.f.change_pause(Admin, state::pause::REDEEM, true);
    w.f.ok(pause_redeem, Admin);
    let args = w.args(1, 0);
    w.assert_refused(&args, Paused);

    let unpause_redeem = w.f.change_pause(Admin, state::pause::REDEEM, false);
    w.f.ok(unpause_redeem, Admin);
    let pause_transfer = w.f.change_pause(Admin, state::pause::TRANSFER, true);
    w.f.ok(pause_transfer, Admin);
    w.redeem_ok(&args);
}

#[test]
fn redeem_rejects_owner_without_redeem_scope() {
    let mut w = World::demo();
    w.forge_account(w.authority, |authority: &mut Authority| {
        authority.scopes = state::scope::ISSUE
            | state::scope::TRANSFER
            | state::scope::SPLIT
            | state::scope::ATTEST_ORIGIN;
    });
    w.assert_refused(&w.args(1, 0), ScopeMissing);
}

#[test]
fn redeem_rejects_custodian_without_redeem_scope() {
    let mut w = World::demo();
    w.forge_account(w.custodian_authority, |authority: &mut Authority| {
        authority.scopes = state::scope::ISSUE
            | state::scope::TRANSFER
            | state::scope::SPLIT
            | state::scope::ATTEST_ORIGIN;
    });
    w.assert_refused(&w.args(1, 0), ScopeMissing);
}

#[test]
fn redeem_rejects_root_protocol() {
    let mut w = World::demo();
    w.split_ok("CR-0001", "CR-0001-A", 2_000_000);
    w.forge_account(w.lot, |root: &mut Lot| {
        root.protocol = Pubkey::new_unique();
    });
    w.assert_refused(&w.args_for("CR-0001-A", 1, 0), RootMismatch);
}

#[test]
fn redeem_rejects_root_alias() {
    let mut w = World::demo();
    let child_id = "CR-0001-A";
    w.split_ok("CR-0001", child_id, 2_000_000);
    let child = w.lot_key(child_id);
    w.forge_account(child, |lot: &mut Lot| lot.root = child);
    // Keep the earlier intake binding valid so only the root alias check can refuse.
    w.forge_account(w.intake(), |intake: &mut IntakeIdentity| intake.lot = child);
    let args = w.args_for(child_id, 1, 0);
    assert_eq!(args.root, Some(child));
    w.assert_refused(&args, RootMismatch);
}

#[test]
fn redeem_rejects_revoked_owner_authority() {
    let mut w = World::demo();
    let revoke = w.f.revoke(OrgAdmin, w.owner, w.authority);
    w.f.ok(revoke, OrgAdmin);
    w.assert_refused(&w.args(1, 0), AuthorityRevoked);
}

#[test]
fn redeem_rejects_revoked_custodian_authority() {
    let mut w = World::demo();
    let revoke = w.f.revoke(OrgAdmin, w.custodian, w.custodian_authority);
    w.f.ok(revoke, OrgAdmin);
    w.assert_refused(&w.args(1, 0), AuthorityRevoked);
}

#[test]
fn redeem_rejects_expired_authority() {
    let mut w = World::demo();
    let now = w.now;
    w.forge_account(w.authority, |authority: &mut Authority| {
        authority.expires_at = now;
    });
    w.assert_refused(&w.args(1, 0), AuthorityExpired);
}

#[test]
fn redeem_rejects_expired_intent() {
    let mut w = World::demo();
    let args = RedeemArgs {
        valid_until: w.now - 1,
        ..w.args(1, 0)
    };
    w.assert_refused(&args, Expired);
}

#[test]
fn redeem_rejects_window_of_601_seconds() {
    let mut w = World::demo();
    let mut args = RedeemArgs {
        valid_until: w.now + 601,
        ..w.args(1, 0)
    };
    w.assert_refused(&args, WindowTooLong);
    args.valid_until -= 1;
    w.redeem_ok(&args);
}

#[test]
fn redeem_rejects_wrong_text() {
    let mut w = World::demo();
    let [verify, _] = w.redeem_instructions(&w.args(1_000_000, 0));
    let redeem = w.redeem_instruction(&w.args(2_000_000, 0));
    w.f.sponsored_refused(&[verify, redeem], 1, MessageMismatch);
}

#[test]
fn redeem_rejects_stale_position_revision() {
    let mut w = World::demo();
    let args = w.args(1, 0);
    let instructions = w.redeem_instructions(&args);
    let before = w.snapshot(&args);
    let tx = w.f.sponsored_ok(&instructions);
    w.assert_redeemed(&args, before, &tx);

    // The fixture refreshes the transaction blockhash, so the same signed intent
    // reaches the program and is rejected on the position's new revision.
    w.f.sponsored_refused(&instructions, 1, StaleRevision);
}

#[test]
fn redeem_rejects_redeemed_lot() {
    let mut w = World::demo();
    // Keep a positive balance so the available-quantity guard cannot mask this check.
    w.forge_account(w.lot, |lot: &mut Lot| lot.state = LotState::Redeemed);
    w.assert_refused(&w.args(1, 0), LotNotStored);
}

#[test]
fn redeem_rejects_custodian_entry_first() {
    let mut w = World::demo();
    let args = RedeemArgs {
        signers: vec![Custodian, Owner],
        ..w.args(1, 0)
    };
    w.assert_refused(&args, WrongSigner);
}
