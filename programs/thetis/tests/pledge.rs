//! `pledge`: the borrower and the lender lock an exact quantity of a position under one facility,
//! which creates a Loan and its LockAllocation.
//!
//! Demo money: USD cents at 1,200 bps simple interest and a 60% LTV limit, on the 5,000 t lot
//! CR-0001. The demo cast is synthetic. Facility ids,
//! digests and expiries are deterministic synthetic test inputs.

mod common;

use anchor_lang::{prelude::Pubkey, AccountSerialize};
use common::{Actor::*, *};
use litesvm::types::TransactionMetadata;
use solana_keypair::Keypair;
use solana_message::{AddressLookupTableAccount, VersionedMessage};
use solana_transaction::{versioned::VersionedTransaction, Instruction};
use thetis::{
    accounts,
    error::ThetisError::{self, *},
    events, instruction,
    intent::message::{
        format_bps, format_money, issue_message, pledge_message, redeem_message, split_message,
        transfer_message,
    },
    state::*,
    validate::MONEY_WINDOW_SECS,
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
const LOT_VALIDITY: i64 = 30 * DAY;
/// Every Authority outlives the lot, so `LotExpired` can be reached with valid Authorities.
const AUTHORITY_LIFETIME: i64 = 60 * DAY;
/// The signing window the pledge tests use, inside the 300 s money window.
const MONEY_WINDOW: i64 = 240;
/// The signing window the Phase 1 custody actions use, inside their 600 s window.
const CUSTODY_WINDOW: i64 = 570;

const CLASS_CODE: &str = "CHROME";
const GRADES: [&str; 2] = ["A", "B"];
const SITE_CODE: &str = "PORT-STOCKYARD";
const INTAKE_DIGEST: [u8; 32] = [0x0a; 32];
const COLLECTION_TICKET: [u8; 32] = [0x80; 32];

const USD: [u8; 3] = *b"USD";
const CENTS: u8 = 2;
const TERMS_DIGEST: [u8; 32] = [0x7d; 32];
/// Lender One Bank's facility to Khunou Ore Exports: the facility id of the signed-text vector below.
const FACILITY_ONE: [u8; 16] = [0x11; 16];
/// Lender Two Bank's facility to Khunou Ore Exports.
const FACILITY_TWO: [u8; 16] = [0x22; 16];
/// Lender One Bank's facility to another exporter.
const FACILITY_OTHER_BORROWER: [u8; 16] = [0x33; 16];

/// Organisation ids in the pledge world.
const OWNER_ID: u8 = 1;
const CUSTODIAN_ID: u8 = 2;
const BUYER_ID: u8 = 5;
const LENDER_ID: u8 = 7;
const LENDER2_ID: u8 = 8;
const OTHER_EXPORTER_ID: u8 = 9;

const CUSTODIAN_NAME: &str = "Kopano Stockyard Custody";
const BUYER_NAME: &str = "Buyer Smelter Co";
const LENDER2_NAME: &str = "Lender Two Bank";
/// A second synthetic exporter, used only as the wrong party.
const OTHER_EXPORTER_NAME: &str = "Exporter Two (synthetic)";

/// The signed pledge text known answer, byte for byte.
const PLEDGE_TEXT: &str = "Thetis authorisation v1
Network: devnet
Program: jGJpdjtoDUtXMjvc4UaEi1mBeFZKqVfe9jL8ireHMs3
Protocol: 00112233445566778899aabbccddeeff
Action: Pledge receipts
Lot: CR-0001
Quantity: 5,000.000 t
Owner: Khunou Ore Exports
Lender: Lender One Bank
Facility: 11111111111111111111111111111111
Loan: 0
Currency: USD
Rate: 12.00% a year, simple, actual/365
Max LTV: 60.00%
Terms: v1
Revision: 0
Valid until: 2026-11-19 16:32:05 SAST
Test network only. Synthetic data.";

/// Everything about the pledge world that the size test varies.
struct Spec {
    owner_name: &'static str,
    lender_name: &'static str,
    lot_id: &'static str,
    lot_quantity_kg: u64,
    approved_capacity_kg: u64,
    rate_bps: u16,
    max_ltv_bps: u16,
    terms_version: u32,
}

impl Spec {
    fn demo() -> Self {
        Self {
            owner_name: "Khunou Ore Exports",
            lender_name: "Lender One Bank",
            lot_id: "CR-0001",
            lot_quantity_kg: 5_000_000,
            approved_capacity_kg: 10_000_000,
            rate_bps: 1_200,
            max_ltv_bps: 6_000,
            terms_version: 1,
        }
    }

    /// The widest values: two distinct 48-byte names, a 16-byte lot id, a `u64::MAX`
    /// quantity, 10,000 bps rate and LTV, and terms version `u32::MAX`.
    fn widest() -> Self {
        Self {
            owner_name: "Khunou Ore Exports And Allied Holdings Pty Ltd 1",
            lender_name: "Lender One Bank And Allied Trade Finance Pty Ltd",
            lot_id: "CR-0001-WIDEST-1",
            lot_quantity_kg: u64::MAX,
            approved_capacity_kg: u64::MAX,
            rate_bps: 10_000,
            max_ltv_bps: 10_000,
            terms_version: u32::MAX,
        }
    }
}

/// One `pledge` call, with every input a test may vary.
#[derive(Clone)]
struct PledgeArgs {
    facility: Pubkey,
    loan_index: u32,
    quantity_kg: u64,
    /// The position's revision.
    expected_revision: u64,
    valid_until: i64,
    borrower_org: Pubkey,
    borrower_authority: Pubkey,
    lender_org: Pubkey,
    lender_authority: Pubkey,
    position: Pubkey,
    /// Who signs the one shared text, in entry order.
    signers: Vec<Actor>,
}

/// What a pledge may change, and what it must leave alone, read before it runs.
struct Snapshot {
    position: Position,
    facility: Facility,
    vault_balance: u64,
    mint_supply: u64,
    untouched: Vec<(Pubkey, Option<RawAccount>)>,
}

/// A fiat-mode protocol with one stored chrome lot of the spec's quantity held by Khunou Ore
/// Exports, two lenders, and three open facilities in the spec's terms.
struct World {
    f: Fixture,
    spec: Spec,
    /// The clock, mirrored here so texts are signed relative to it.
    now: i64,
    owner: Pubkey,
    other_exporter: Pubkey,
    custodian: Pubkey,
    buyer: Pubkey,
    lender: Pubkey,
    lender2: Pubkey,
    class_policy: Pubkey,
    custodian_class: Pubkey,
    lot: Pubkey,
    /// Lender One Bank to Khunou Ore Exports.
    facility: Pubkey,
    /// Lender Two Bank to Khunou Ore Exports.
    facility2: Pubkey,
    /// Lender One Bank to the other exporter.
    other_facility: Pubkey,
    /// Every LockAllocation a successful pledge created.
    locks: Vec<Pubkey>,
}

fn accredit(f: &mut Fixture, id: u8, role: Role, name: &str) -> Pubkey {
    let accredit = f.accredit(Accreditor, id, role, name);
    f.ok(accredit, Accreditor);
    f.organisation(id)
}

fn serialized<T: AccountSerialize>(value: &T) -> Vec<u8> {
    let mut data = Vec::new();
    value.try_serialize(&mut data).unwrap();
    data
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

impl World {
    fn demo() -> Self {
        Self::build(Spec::demo())
    }

    fn build(spec: Spec) -> Self {
        let mut f = Fixture::initialized();
        let register =
            f.register_with_origin(Accreditor, CLASS_CODE, 1, &GRADES, LOT_VALIDITY, false);
        f.ok(register, Accreditor);
        let class_policy = f.class(CLASS_CODE, 1);

        let owner = accredit(&mut f, OWNER_ID, Role::Exporter, spec.owner_name);
        let custodian = accredit(&mut f, CUSTODIAN_ID, Role::Custodian, CUSTODIAN_NAME);
        let buyer = accredit(&mut f, BUYER_ID, Role::Buyer, BUYER_NAME);
        let lender = accredit(&mut f, LENDER_ID, Role::Lender, spec.lender_name);
        let lender2 = accredit(&mut f, LENDER2_ID, Role::Lender, LENDER2_NAME);
        let other_exporter = accredit(
            &mut f,
            OTHER_EXPORTER_ID,
            Role::Exporter,
            OTHER_EXPORTER_NAME,
        );

        let accredit_site = f.accredit_site(
            Accreditor,
            custodian,
            class_policy,
            SITE_CODE,
            spec.approved_capacity_kg,
        );
        f.ok(accredit_site, Accreditor);
        let custodian_class = f.site(custodian, class_policy, SITE_CODE);

        let expires_at = NOW + AUTHORITY_LIFETIME;
        for (org, wallet, scopes) in [
            (custodian, Custodian, scope::ISSUE | scope::REDEEM),
            (
                owner,
                Owner,
                scope::TRANSFER | scope::SPLIT | scope::REDEEM | scope::PLEDGE,
            ),
            (other_exporter, Outsider, scope::PLEDGE),
            (lender, Lender, scope::LEND),
            (lender2, Lender2, scope::LEND),
        ] {
            let delegate = f.delegate(OrgAdmin, org, f.key(wallet), scopes, expires_at);
            f.ok(delegate, OrgAdmin);
        }

        let lot = pda(&[b"lot", f.protocol.as_ref(), spec.lot_id.as_bytes()]);
        let mut world = Self {
            f,
            spec,
            now: NOW,
            owner,
            other_exporter,
            custodian,
            buyer,
            lender,
            lender2,
            class_policy,
            custodian_class,
            lot,
            facility: Pubkey::default(),
            facility2: Pubkey::default(),
            other_facility: Pubkey::default(),
            locks: Vec::new(),
        };
        world.facility = world.open_facility(Lender, lender, owner, FACILITY_ONE);
        world.facility2 = world.open_facility(Lender2, lender2, owner, FACILITY_TWO);
        world.other_facility =
            world.open_facility(Lender, lender, other_exporter, FACILITY_OTHER_BORROWER);
        world.issue_lot();
        world
    }

    fn advance_to(&mut self, unix_timestamp: i64) {
        self.now = unix_timestamp;
        self.f.set_time(unix_timestamp);
    }

    fn authority_of(&self, actor: Actor) -> Pubkey {
        self.f.authority(self.f.key(actor))
    }

    fn facility_key(&self, lender_org: Pubkey, facility_id: [u8; 16]) -> Pubkey {
        pda(&[
            b"facility",
            self.f.protocol.as_ref(),
            lender_org.as_ref(),
            &facility_id,
        ])
    }

    /// Opens a facility in the spec's terms through `open_facility`.
    fn open_facility(
        &mut self,
        signer: Actor,
        lender_org: Pubkey,
        borrower_org: Pubkey,
        facility_id: [u8; 16],
    ) -> Pubkey {
        let facility = self.facility_key(lender_org, facility_id);
        let open = ix(
            accounts::OpenFacility {
                lender: self.f.key(signer),
                payer: self.f.payer(),
                protocol: self.f.protocol,
                authority: self.authority_of(signer),
                lender_org,
                borrower_org,
                facility,
                pool: None,
                system_program: SYSTEM,
            },
            instruction::OpenFacility {
                facility_id,
                currency: USD,
                currency_decimals: CENTS,
                terms_version: self.spec.terms_version,
                rate_bps: self.spec.rate_bps,
                max_ltv_bps: self.spec.max_ltv_bps,
                terms_digest: TERMS_DIGEST,
            },
        );
        self.f.ok(open, signer);
        let stored: Facility = self.f.read(facility);
        assert_eq!(stored.borrower, borrower_org);
        assert_eq!(stored.loan_count, 0);
        facility
    }

    fn mint(&self) -> Pubkey {
        pda(&[b"mint", self.lot.as_ref()])
    }

    fn position(&self, organisation: Pubkey) -> Pubkey {
        pda(&[b"position", self.lot.as_ref(), organisation.as_ref()])
    }

    fn vault_authority(position: Pubkey) -> Pubkey {
        pda(&[b"vault", position.as_ref()])
    }

    /// The Token-2022 associated token account of a vault authority for a mint.
    fn associated_token(vault_authority: Pubkey, mint: Pubkey) -> Pubkey {
        Pubkey::find_program_address(
            &[vault_authority.as_ref(), TOKEN_2022.as_ref(), mint.as_ref()],
            &ASSOCIATED_TOKEN,
        )
        .0
    }

    fn vault(&self, position: Pubkey) -> Pubkey {
        Self::associated_token(Self::vault_authority(position), self.mint())
    }

    fn loan(&self, facility: Pubkey, loan_index: u32) -> (Pubkey, u8) {
        Pubkey::find_program_address(
            &[b"loan", facility.as_ref(), &loan_index.to_le_bytes()],
            &ID,
        )
    }

    fn lock(&self, loan: Pubkey) -> (Pubkey, u8) {
        Pubkey::find_program_address(&[b"lock", loan.as_ref()], &ID)
    }

    /// Issues the spec's lot to the owner; the class needs no origin document.
    fn issue_lot(&mut self) {
        let lot_id = self.spec.lot_id;
        let quantity_kg = self.spec.lot_quantity_kg;
        let valid_until = self.now + CUSTODY_WINDOW;
        let protocol = self.f.protocol;
        let intake = pda(&[
            b"intake",
            protocol.as_ref(),
            self.custodian.as_ref(),
            &INTAKE_DIGEST,
        ]);
        let mint = self.mint();
        let position = self.position(self.owner);
        let text = issue_message(
            &ID,
            &INSTANCE,
            lot_id,
            CLASS_CODE,
            1,
            GRADES[0],
            quantity_kg,
            self.spec.owner_name,
            CUSTODIAN_NAME,
            SITE_CODE,
            &INTAKE_DIGEST,
            None,
            valid_until,
        );
        let verify = ed25519_instruction(&[(self.f.signer(Custodian), text.as_slice())]);
        let issue = ix(
            accounts::IssueLot {
                sponsor: self.f.payer(),
                protocol,
                authority: self.authority_of(Custodian),
                owner: self.owner,
                custodian: self.custodian,
                class_policy: self.class_policy,
                custodian_class: self.custodian_class,
                origin: None,
                origin_issuer: None,
                intake,
                lot: self.lot,
                mint,
                mint_authority: pda(&[b"mint_authority", mint.as_ref()]),
                position,
                vault_authority: Self::vault_authority(position),
                vault: self.vault(position),
                instructions: INSTRUCTIONS_SYSVAR,
                token_program: TOKEN_2022,
                associated_token_program: ASSOCIATED_TOKEN,
                system_program: SYSTEM,
            },
            instruction::IssueLot {
                lot_id: lot_id.into(),
                grade: GRADES[0].into(),
                quantity_kg,
                intake_digest: INTAKE_DIGEST,
                valid_until,
            },
        );
        self.f.sponsored_ok(&[verify, issue]);

        let lot: Lot = self.f.read(self.lot);
        assert_eq!(lot.state, LotState::Stored);
        assert_eq!(lot.supply_kg, quantity_kg);
        assert_eq!(lot.expires_at, self.now + LOT_VALIDITY);
        let held: Position = self.f.read(position);
        assert_eq!(held.owner, self.owner);
        assert_eq!(held.quantity_kg, quantity_kg);
        assert_eq!(held.locked_kg, 0);
        assert_eq!(held.revision, 0);
        self.assert_invariants();
    }

    fn lender_actor(&self, lender_org: Pubkey) -> Actor {
        if lender_org == self.lender2 {
            Lender2
        } else {
            Lender
        }
    }

    /// The default pledge under `facility`: the owner's position, at the facility's next loan
    /// index, signed by the owner's wallet and then the facility lender's wallet.
    fn args(&self, facility: Pubkey, quantity_kg: u64, expected_revision: u64) -> PledgeArgs {
        let stored: Facility = self.f.read(facility);
        let lender_actor = self.lender_actor(stored.lender);
        PledgeArgs {
            facility,
            loan_index: stored.loan_count,
            quantity_kg,
            expected_revision,
            valid_until: self.now + MONEY_WINDOW,
            borrower_org: self.owner,
            borrower_authority: self.authority_of(Owner),
            lender_org: stored.lender,
            lender_authority: self.authority_of(lender_actor),
            position: self.position(self.owner),
            signers: vec![Owner, lender_actor],
        }
    }

    /// The text the program rebuilds from the accounts passed and the arguments.
    fn text(&self, args: &PledgeArgs) -> Vec<u8> {
        let lot: Lot = self.f.read(self.lot);
        let facility: Facility = self.f.read(args.facility);
        let owner = self.f.read::<Organisation>(args.borrower_org).display_name;
        let lender = self.f.read::<Organisation>(args.lender_org).display_name;
        pledge_message(
            &ID,
            &INSTANCE,
            &lot.lot_id,
            args.quantity_kg,
            &owner,
            &lender,
            &facility.facility_id,
            args.loan_index,
            &facility.currency,
            facility.rate_bps,
            facility.max_ltv_bps,
            facility.terms_version,
            args.expected_revision,
            args.valid_until,
        )
    }

    /// One Ed25519 instruction whose entries share one copy of the text, followed by `pledge`.
    fn pledge(&self, args: &PledgeArgs) -> [Instruction; 2] {
        let text = self.text(args);
        let signers: Vec<&Keypair> = args
            .signers
            .iter()
            .map(|actor| self.f.signer(*actor))
            .collect();
        [
            ed25519_shared_instruction(&signers, &text),
            self.pledge_instruction(args),
        ]
    }

    fn pledge_instruction(&self, args: &PledgeArgs) -> Instruction {
        let loan = self.loan(args.facility, args.loan_index).0;
        ix(
            accounts::Pledge {
                sponsor: self.f.payer(),
                protocol: self.f.protocol,
                lot: self.lot,
                position: args.position,
                borrower_org: args.borrower_org,
                borrower_authority: args.borrower_authority,
                lender_org: args.lender_org,
                lender_authority: args.lender_authority,
                facility: args.facility,
                loan,
                lock: self.lock(loan).0,
                instructions: INSTRUCTIONS_SYSVAR,
                system_program: SYSTEM,
            },
            instruction::Pledge {
                loan_index: args.loan_index,
                quantity_kg: args.quantity_kg,
                expected_revision: args.expected_revision,
                valid_until: args.valid_until,
            },
        )
    }

    fn snapshot(&self, args: &PledgeArgs) -> Snapshot {
        let untouched = [
            self.f.protocol,
            self.lot,
            args.borrower_org,
            args.borrower_authority,
            args.lender_org,
            args.lender_authority,
        ]
        .into_iter()
        .map(|key| (key, self.f.raw_account(key)))
        .collect();
        Snapshot {
            position: self.f.read(args.position),
            facility: self.f.read(args.facility),
            vault_balance: self.f.token_amount(self.vault(args.position)),
            mint_supply: self.f.mint_supply(self.mint()),
            untouched,
        }
    }

    /// Sends the pledge and checks every effect, the event and the invariants.
    fn pledge_ok(&mut self, args: &PledgeArgs) -> TransactionMetadata {
        let instructions = self.pledge(args);
        self.send_pledge(args, &instructions)
    }

    /// As `pledge_ok`, for instructions built earlier.
    fn send_pledge(
        &mut self,
        args: &PledgeArgs,
        instructions: &[Instruction; 2],
    ) -> TransactionMetadata {
        let before = self.snapshot(args);
        let tx = self.f.sponsored_ok(instructions);
        self.assert_pledged(args, &before, &tx);
        tx
    }

    fn assert_pledged(&mut self, args: &PledgeArgs, before: &Snapshot, tx: &TransactionMetadata) {
        let f = &self.f;
        let q = args.quantity_kg;
        let (loan_key, loan_bump) = self.loan(args.facility, args.loan_index);
        let (lock_key, lock_bump) = self.lock(loan_key);

        // Space: Loan 222 and LockAllocation 114 bytes, discriminators included.
        assert_eq!(f.owner_and_data_len(loan_key), Some((ID, 222)));
        assert_eq!(f.owner_and_data_len(lock_key), Some((ID, 114)));

        let loan: Loan = f.read(loan_key);
        assert_eq!(loan.protocol, f.protocol);
        assert_eq!(loan.facility, args.facility);
        assert_eq!(loan.borrower, before.position.owner);
        assert_eq!(loan.lot, self.lot);
        assert_eq!(loan.position, args.position);
        assert_eq!(loan.index, args.loan_index);
        assert_eq!(loan.status, LoanStatus::Active);
        assert_eq!(loan.rate_bps, before.facility.rate_bps);
        assert_eq!(loan.terms_version, before.facility.terms_version);
        assert_eq!(loan.principal, 0);
        assert_eq!(loan.booked_interest, 0);
        assert_eq!(loan.accrual_remainder, 0);
        assert_eq!(loan.accrued_at, self.now);
        assert_eq!(loan.open_exceptions, 0);
        assert_eq!(loan.revision, 0);
        assert_eq!(loan.bump, loan_bump);

        let lock: LockAllocation = f.read(lock_key);
        assert_eq!(lock.protocol, f.protocol);
        assert_eq!(lock.loan, loan_key);
        assert_eq!(lock.position, args.position);
        assert_eq!(lock.quantity_kg, q);
        assert_eq!(lock.control, LockControl::Pledged);
        assert_eq!(lock.bump, lock_bump);

        let position: Position = f.read(args.position);
        assert_eq!(position.protocol, before.position.protocol);
        assert_eq!(position.lot, before.position.lot);
        assert_eq!(position.owner, before.position.owner);
        assert_eq!(position.quantity_kg, before.position.quantity_kg);
        assert_eq!(position.locked_kg, before.position.locked_kg + q);
        assert_eq!(position.reserved_kg, before.position.reserved_kg);
        assert_eq!(position.revision, before.position.revision + 1);
        assert_eq!(position.bump, before.position.bump);

        // The facility changes only in its loan count.
        let mut facility = before.facility.clone();
        facility.loan_count += 1;
        assert_eq!(
            serialized(&f.read::<Facility>(args.facility)),
            serialized(&facility)
        );
        for (key, account) in &before.untouched {
            assert_eq!(&f.raw_account(*key), account, "{key} changed");
        }
        // No units move: the lock is accounting on the position.
        assert_eq!(
            f.token_amount(self.vault(args.position)),
            before.vault_balance
        );
        assert_eq!(f.mint_supply(self.mint()), before.mint_supply);

        assert_event(
            tx,
            events::Pledged {
                loan: loan_key,
                lock: lock_key,
                position: args.position,
                lot: self.lot,
                quantity_kg: q,
                position_revision: before.position.revision + 1,
                revision: 0,
            },
        );
        self.locks.push(lock_key);
        self.assert_invariants();
    }

    /// The pledge is index 1 of the sponsored transaction; the fixture also asserts that
    /// nothing changed and no event was emitted.
    fn assert_refused(&mut self, args: &PledgeArgs, expected: ThetisError) {
        let instructions = self.pledge(args);
        self.f.sponsored_refused(&instructions, 1, expected);
        self.assert_no_loan(args);
    }

    fn assert_no_loan(&self, args: &PledgeArgs) {
        let loan = self.loan(args.facility, args.loan_index).0;
        assert!(!self.f.account_exists(loan));
        assert!(!self.f.account_exists(self.lock(loan).0));
    }

    /// Invariants: supply equals the sum of positions, each vault holds its position's
    /// quantity, and each position's `locked_kg` is the sum of its live locks and fits.
    fn assert_invariants(&self) {
        let f = &self.f;
        let lot: Lot = f.read(self.lot);
        let mut total: u128 = 0;
        for holder in [self.owner, self.buyer, self.other_exporter] {
            let key = self.position(holder);
            if !f.account_exists(key) {
                continue;
            }
            let position: Position = f.read(key);
            total += u128::from(position.quantity_kg);
            assert_eq!(f.token_amount(self.vault(key)), position.quantity_kg);
            let mut locked: u128 = 0;
            for lock_key in &self.locks {
                let lock: LockAllocation = f.read(*lock_key);
                let loan: Loan = f.read(lock.loan);
                assert_eq!(
                    loan.status == LoanStatus::Active,
                    lock.control == LockControl::Pledged
                );
                if lock.position == key && loan.status != LoanStatus::Closed {
                    locked += u128::from(lock.quantity_kg);
                }
            }
            assert_eq!(u128::from(position.locked_kg), locked);
            assert!(
                u128::from(position.locked_kg) + u128::from(position.reserved_kg)
                    <= u128::from(position.quantity_kg)
            );
        }
        assert_eq!(total, u128::from(lot.supply_kg));
        assert_eq!(f.mint_supply(self.mint()), lot.supply_kg);
    }

    /// Rewrites the owner's Position into a state instructions cannot reach cheaply.
    fn forge_position(&mut self, change: impl FnOnce(&mut Position)) {
        let address = self.position(self.owner);
        let mut position: Position = self.f.read(address);
        change(&mut position);
        self.f.set_program_account(address, &position);
    }

    fn forge_facility(&mut self, facility: Pubkey, change: impl FnOnce(&mut Facility)) {
        let mut stored: Facility = self.f.read(facility);
        change(&mut stored);
        self.f.set_program_account(facility, &stored);
    }

    /// The per-instance lookup table: the inherited Phase 1 entries plus Lot,
    /// Position, Facility, Loan and LockAllocation. Sponsor, Thetis, Ed25519 and ComputeBudget
    /// stay inline.
    fn table_addresses(&self, args: &PledgeArgs) -> Vec<Pubkey> {
        let loan = self.loan(args.facility, args.loan_index).0;
        vec![
            SYSTEM,
            INSTRUCTIONS_SYSVAR,
            self.f.protocol,
            args.borrower_org,
            args.borrower_authority,
            args.lender_org,
            args.lender_authority,
            self.lot,
            args.position,
            args.facility,
            loan,
            self.lock(loan).0,
        ]
    }

    /// Compiles the pledge as the relay sends it (v0, lookup table, compute-budget instruction)
    /// and asserts its shape and that it fits one packet. Returns the transaction and its size.
    fn pledge_v0(&mut self, args: &PledgeArgs) -> (VersionedTransaction, usize) {
        let addresses = self.table_addresses(args);
        let table: AddressLookupTableAccount = self.f.create_lookup_table(addresses.clone());
        let [verify, pledge] = self.pledge(args);
        let tx = self.f.sponsored_v0(
            &[compute_unit_limit(), verify, pledge],
            std::slice::from_ref(&table),
        );
        assert_eq!(tx.signatures.len(), 1, "only the sponsor signs");
        let VersionedMessage::V0(message) = &tx.message else {
            panic!("a v0 message");
        };
        assert_eq!(
            sorted(message.account_keys.clone()),
            sorted(vec![self.f.payer(), ID, ED25519, COMPUTE_BUDGET]),
            "only the sponsor and the three called programs are inline"
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
        let loan = self.loan(args.facility, args.loan_index).0;
        assert_eq!(
            loaded(&lookup.writable_indexes),
            sorted(vec![args.position, args.facility, loan, self.lock(loan).0])
        );
        assert_eq!(
            loaded(&lookup.readonly_indexes),
            sorted(vec![
                SYSTEM,
                INSTRUCTIONS_SYSVAR,
                self.f.protocol,
                args.borrower_org,
                args.borrower_authority,
                args.lender_org,
                args.lender_authority,
                self.lot,
            ])
        );
        let size = transaction_size(&tx);
        assert!(
            size <= PACKET_DATA_SIZE,
            "pledge v0 transaction is {size} bytes"
        );
        (tx, size)
    }

    /// `transfer` of `quantity_kg` from the owner to the Buyer organisation (Phase 1).
    fn transfer(&self, quantity_kg: u64, expected_revision: u64) -> [Instruction; 2] {
        let valid_until = self.now + CUSTODY_WINDOW;
        let text = transfer_message(
            &ID,
            &INSTANCE,
            self.spec.lot_id,
            quantity_kg,
            self.spec.owner_name,
            BUYER_NAME,
            expected_revision,
            valid_until,
        );
        let from_position = self.position(self.owner);
        let to_position = self.position(self.buyer);
        let transfer = ix(
            accounts::Transfer {
                sponsor: self.f.payer(),
                protocol: self.f.protocol,
                authority: self.authority_of(Owner),
                lot: self.lot,
                mint: self.mint(),
                owner: self.owner,
                from_position,
                from_vault_authority: Self::vault_authority(from_position),
                from_vault: self.vault(from_position),
                recipient: self.buyer,
                to_position,
                to_vault_authority: Self::vault_authority(to_position),
                to_vault: self.vault(to_position),
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
        [
            ed25519_instruction(&[(self.f.signer(Owner), text.as_slice())]),
            transfer,
        ]
    }

    /// `split` of `quantity_kg` of the lot into a new lot, signed by the owner and the
    /// custodian (Phase 1). `expected_revision` is the lot's.
    fn split(
        &self,
        child_lot_id: &str,
        quantity_kg: u64,
        expected_revision: u64,
    ) -> [Instruction; 2] {
        let valid_until = self.now + CUSTODY_WINDOW;
        let text = split_message(
            &ID,
            &INSTANCE,
            self.spec.lot_id,
            child_lot_id,
            quantity_kg,
            self.spec.owner_name,
            CUSTODIAN_NAME,
            expected_revision,
            valid_until,
        );
        let position = self.position(self.owner);
        let child_lot = pda(&[b"lot", self.f.protocol.as_ref(), child_lot_id.as_bytes()]);
        let child_mint = pda(&[b"mint", child_lot.as_ref()]);
        let child_position = pda(&[b"position", child_lot.as_ref(), self.owner.as_ref()]);
        let child_vault_authority = Self::vault_authority(child_position);
        let split = ix(
            accounts::Split {
                sponsor: self.f.payer(),
                protocol: self.f.protocol,
                owner_authority: self.authority_of(Owner),
                custodian_authority: self.authority_of(Custodian),
                lot: self.lot,
                root: None,
                class_policy: self.class_policy,
                custodian_class: self.custodian_class,
                owner: self.owner,
                custodian: self.custodian,
                mint: self.mint(),
                position,
                vault_authority: Self::vault_authority(position),
                vault: self.vault(position),
                child_lot,
                child_mint,
                child_mint_authority: pda(&[b"mint_authority", child_mint.as_ref()]),
                child_position,
                child_vault_authority,
                child_vault: Self::associated_token(child_vault_authority, child_mint),
                instructions: INSTRUCTIONS_SYSVAR,
                token_program: TOKEN_2022,
                associated_token_program: ASSOCIATED_TOKEN,
                system_program: SYSTEM,
            },
            instruction::Split {
                child_lot_id: child_lot_id.into(),
                quantity_kg,
                expected_revision,
                valid_until,
            },
        );
        let signers = [self.f.signer(Owner), self.f.signer(Custodian)];
        [ed25519_shared_instruction(&signers, &text), split]
    }

    /// `redeem` of `quantity_kg` from the owner's position, signed by the owner and the
    /// custodian (Phase 1). `expected_revision` is the position's.
    fn redeem(&self, quantity_kg: u64, expected_revision: u64) -> [Instruction; 2] {
        let valid_until = self.now + CUSTODY_WINDOW;
        let text = redeem_message(
            &ID,
            &INSTANCE,
            self.spec.lot_id,
            quantity_kg,
            self.spec.owner_name,
            CUSTODIAN_NAME,
            &COLLECTION_TICKET,
            expected_revision,
            valid_until,
        );
        let position = self.position(self.owner);
        let redeem = ix(
            accounts::Redeem {
                sponsor: self.f.payer(),
                protocol: self.f.protocol,
                owner_authority: self.authority_of(Owner),
                custodian_authority: self.authority_of(Custodian),
                owner: self.owner,
                custodian: self.custodian,
                custodian_class: self.custodian_class,
                lot: self.lot,
                root: None,
                intake: self.f.read::<Lot>(self.lot).intake,
                mint: self.mint(),
                position,
                vault_authority: Self::vault_authority(position),
                vault: self.vault(position),
                instructions: INSTRUCTIONS_SYSVAR,
                token_program: TOKEN_2022,
            },
            instruction::Redeem {
                quantity_kg,
                collection_ticket: COLLECTION_TICKET,
                expected_revision,
                valid_until,
            },
        );
        let signers = [self.f.signer(Owner), self.f.signer(Custodian)];
        [ed25519_shared_instruction(&signers, &text), redeem]
    }

    fn owner_position(&self) -> Position {
        self.f.read(self.position(self.owner))
    }
}

#[test]
fn pledge_demo_locks_exact_quantity_and_creates_loan() {
    let mut w = World::demo();
    let args = w.args(w.facility, 5_000_000, 0);
    assert_eq!(args.loan_index, 0);
    assert_eq!(args.lender_org, w.lender);
    w.assert_no_loan(&args);

    let tx = w.pledge_ok(&args);

    let (loan_key, _) = w.loan(w.facility, 0);
    let (lock_key, _) = w.lock(loan_key);
    let position = w.owner_position();
    assert_eq!(position.quantity_kg, 5_000_000);
    assert_eq!(position.locked_kg, 5_000_000);
    assert_eq!(position.reserved_kg, 0);
    assert_eq!(position.revision, 1);
    assert_eq!(w.f.read::<Facility>(w.facility).loan_count, 1);
    // The other facilities are untouched.
    assert_eq!(w.f.read::<Facility>(w.facility2).loan_count, 0);
    assert_eq!(w.f.read::<Facility>(w.other_facility).loan_count, 0);

    let loan: Loan = w.f.read(loan_key);
    assert_eq!(loan.facility, w.facility);
    assert_eq!(loan.borrower, w.owner);
    assert_eq!(loan.lot, w.lot);
    assert_eq!(loan.position, w.position(w.owner));
    assert_eq!(loan.index, 0);
    assert_eq!(loan.status, LoanStatus::Active);
    assert_eq!(loan.rate_bps, 1_200);
    assert_eq!(loan.terms_version, 1);
    assert_eq!(loan.principal, 0);
    assert_eq!(loan.booked_interest, 0);
    assert_eq!(loan.accrual_remainder, 0);
    assert_eq!(loan.accrued_at, NOW);
    assert_eq!(loan.open_exceptions, 0);
    assert_eq!(loan.revision, 0);
    let lock: LockAllocation = w.f.read(lock_key);
    assert_eq!(lock.loan, loan_key);
    assert_eq!(lock.position, w.position(w.owner));
    assert_eq!(lock.quantity_kg, 5_000_000);
    assert_eq!(lock.control, LockControl::Pledged);
    assert_eq!(w.f.owner_and_data_len(loan_key), Some((ID, 222)));
    assert_eq!(w.f.owner_and_data_len(lock_key), Some((ID, 114)));

    let lot: Lot = w.f.read(w.lot);
    assert_eq!(lot.revision, 0);
    assert_eq!(lot.supply_kg, 5_000_000);
    assert_eq!(w.f.token_amount(w.vault(w.position(w.owner))), 5_000_000);
    assert_event(
        &tx,
        events::Pledged {
            loan: loan_key,
            lock: lock_key,
            position: w.position(w.owner),
            lot: w.lot,
            quantity_kg: 5_000_000,
            position_revision: 1,
            revision: 0,
        },
    );
}

#[test]
fn pledge_concurrent_same_units_only_one_succeeds() {
    let mut w = World::demo();
    // Both lenders' pledges of all 5,000 t are signed against position revision 0.
    let one = w.args(w.facility, 5_000_000, 0);
    let two = w.args(w.facility2, 5_000_000, 0);
    assert_eq!(two.lender_org, w.lender2);
    let first = w.pledge(&one);
    let second = w.pledge(&two);

    w.send_pledge(&one, &first);

    w.f.sponsored_refused(&second, 1, StaleRevision);
    w.assert_no_loan(&two);
    // Re-signed on the new revision, the same units are no longer available (A03).
    let retry = w.args(w.facility2, 5_000_000, 1);
    assert_eq!(retry.loan_index, 0);
    w.assert_refused(&retry, InsufficientAvailable);

    let position = w.owner_position();
    assert_eq!(position.locked_kg, 5_000_000);
    assert_eq!(position.revision, 1);
    assert_eq!(w.f.read::<Facility>(w.facility).loan_count, 1);
    assert_eq!(w.f.read::<Facility>(w.facility2).loan_count, 0);
    w.assert_invariants();
}

#[test]
fn pledge_distinct_free_quantities_both_succeed() {
    let mut w = World::demo();
    let one = w.args(w.facility, 2_000_000, 0);
    w.pledge_ok(&one);
    // The second is signed at the revision the first produced.
    let two = w.args(w.facility2, 3_000_000, 1);
    w.pledge_ok(&two);

    let position = w.owner_position();
    assert_eq!(position.quantity_kg, 5_000_000);
    assert_eq!(position.locked_kg, 5_000_000);
    assert_eq!(position.revision, 2);
    let lock_one: LockAllocation = w.f.read(w.lock(w.loan(w.facility, 0).0).0);
    let lock_two: LockAllocation = w.f.read(w.lock(w.loan(w.facility2, 0).0).0);
    assert_eq!(lock_one.quantity_kg, 2_000_000);
    assert_eq!(lock_two.quantity_kg, 3_000_000);
    assert_eq!(
        w.f.read::<Loan>(w.loan(w.facility, 0).0).facility,
        w.facility
    );
    assert_eq!(
        w.f.read::<Loan>(w.loan(w.facility2, 0).0).facility,
        w.facility2
    );
    assert_eq!(w.f.read::<Facility>(w.facility).loan_count, 1);
    assert_eq!(w.f.read::<Facility>(w.facility2).loan_count, 1);

    // Nothing is left free: one more kilogram under either lender is refused.
    w.assert_refused(&w.args(w.facility, 1, 2), InsufficientAvailable);
    w.assert_refused(&w.args(w.facility2, 1, 2), InsufficientAvailable);
}

#[test]
fn pledge_rejects_stale_loan_index() {
    let mut w = World::demo();
    // A free index that is not `loan_count` reaches the handler.
    let skipped = PledgeArgs {
        loan_index: 1,
        ..w.args(w.facility, 2_000_000, 0)
    };
    w.assert_refused(&skipped, StaleRevision);

    w.pledge_ok(&w.args(w.facility, 2_000_000, 0));

    // An occupied index fails at Anchor's init, before the handler.
    let taken = PledgeArgs {
        loan_index: 0,
        ..w.args(w.facility, 1_000_000, 1)
    };
    let loan = w.loan(w.facility, 0).0;
    let loan_before = w.f.raw_account(loan);
    let lock_before = w.f.raw_account(w.lock(loan).0);
    let instructions = w.pledge(&taken);
    w.f.sponsored_already_in_use(&instructions, 1);
    assert_eq!(w.f.raw_account(loan), loan_before);
    assert_eq!(w.f.raw_account(w.lock(loan).0), lock_before);

    let skipped = PledgeArgs {
        loan_index: 2,
        ..w.args(w.facility, 1_000_000, 1)
    };
    w.assert_refused(&skipped, StaleRevision);
    assert_eq!(w.f.read::<Facility>(w.facility).loan_count, 1);

    // The current index is accepted.
    let next = w.args(w.facility, 1_000_000, 1);
    assert_eq!(next.loan_index, 1);
    w.pledge_ok(&next);
    assert_eq!(w.f.read::<Facility>(w.facility).loan_count, 2);
    assert_eq!(w.owner_position().locked_kg, 3_000_000);
}

#[test]
fn pledge_rejects_wrong_owner() {
    let mut w = World::demo();
    let demo = w.args(w.facility, 5_000_000, 0);
    let other_authority = w.authority_of(Outsider);
    for args in [
        // Another exporter names itself and its own Authority, over Khunou's position.
        PledgeArgs {
            borrower_org: w.other_exporter,
            borrower_authority: other_authority,
            signers: vec![Outsider, Lender],
            ..demo.clone()
        },
        // Khunou's organisation with another exporter's Authority.
        PledgeArgs {
            borrower_authority: other_authority,
            signers: vec![Outsider, Lender],
            ..demo.clone()
        },
        // Khunou's own Authority naming another exporter's organisation.
        PledgeArgs {
            borrower_org: w.other_exporter,
            ..demo.clone()
        },
    ] {
        w.assert_refused(&args, WrongOrganisation);
    }

    w.pledge_ok(&demo);
}

#[test]
fn pledge_rejects_lender_of_other_facility() {
    let mut w = World::demo();
    let demo = w.args(w.facility, 5_000_000, 0);
    let lender2_authority = w.authority_of(Lender2);
    for args in [
        // Lender Two, with its own organisation and Authority, accepts Lender One's facility.
        PledgeArgs {
            lender_org: w.lender2,
            lender_authority: lender2_authority,
            signers: vec![Owner, Lender2],
            ..demo.clone()
        },
        // Lender One's organisation with Lender Two's Authority.
        PledgeArgs {
            lender_authority: lender2_authority,
            signers: vec![Owner, Lender2],
            ..demo.clone()
        },
        // Lender One's Authority naming Lender Two's organisation.
        PledgeArgs {
            lender_org: w.lender2,
            ..demo.clone()
        },
    ] {
        w.assert_refused(&args, WrongOrganisation);
    }
    assert_eq!(w.f.read::<Facility>(w.facility2).loan_count, 0);

    w.pledge_ok(&demo);
}

#[test]
fn pledge_rejects_ineligible_borrower() {
    let mut w = World::demo();
    // Lender One's facility to another exporter, over Khunou's position.
    let args = w.args(w.other_facility, 5_000_000, 0);
    assert_eq!(
        w.f.read::<Facility>(w.other_facility).borrower,
        w.other_exporter
    );
    assert_eq!(args.borrower_org, w.owner);

    w.assert_refused(&args, BorrowerNotEligible);

    assert_eq!(w.f.read::<Facility>(w.other_facility).loan_count, 0);
    w.pledge_ok(&w.args(w.facility, 5_000_000, 0));
}

#[test]
fn pledge_rejects_expired_lot() {
    let mut w = World::demo();
    let expires_at = w.f.read::<Lot>(w.lot).expires_at;
    assert_eq!(expires_at, NOW + LOT_VALIDITY);
    assert!(NOW + AUTHORITY_LIFETIME > expires_at + DAY);

    for at in [expires_at, expires_at + DAY] {
        w.advance_to(at);
        w.assert_refused(&w.args(w.facility, 5_000_000, 0), LotExpired);
    }

    // One second before expiry the same pledge is accepted.
    w.advance_to(expires_at - 1);
    w.pledge_ok(&w.args(w.facility, 5_000_000, 0));
    assert_eq!(
        w.f.read::<Loan>(w.loan(w.facility, 0).0).accrued_at,
        expires_at - 1
    );
}

#[test]
fn pledge_rejects_redeemed_lot() {
    let mut w = World::demo();
    // A real redeem of the whole lot.
    let redeem = w.redeem(5_000_000, 0);
    w.f.sponsored_ok(&redeem);
    let lot: Lot = w.f.read(w.lot);
    assert_eq!(lot.state, LotState::Redeemed);
    assert_eq!(lot.supply_kg, 0);
    let position = w.owner_position();
    assert_eq!(position.quantity_kg, 0);
    assert_eq!(position.revision, 1);
    w.assert_invariants();

    // Signed at the post-redeem position revision, so the lot state is what refuses it.
    w.assert_refused(&w.args(w.facility, 5_000_000, 1), LotNotStored);
    assert_eq!(w.f.read::<Facility>(w.facility).loan_count, 0);
}

#[test]
fn pledge_rejects_zero_quantity() {
    let mut w = World::demo();

    w.assert_refused(&w.args(w.facility, 0, 0), ZeroQuantity);

    // The lower bound itself is accepted.
    w.pledge_ok(&w.args(w.facility, 1, 0));
    assert_eq!(w.owner_position().locked_kg, 1);
}

#[test]
fn pledge_rejects_single_signature() {
    let mut w = World::demo();
    let demo = w.args(w.facility, 5_000_000, 0);
    for signers in [vec![Owner], vec![Lender]] {
        let args = PledgeArgs {
            signers,
            ..demo.clone()
        };
        w.assert_refused(&args, WrongSignatureCount);
    }

    w.pledge_ok(&demo);
}

#[test]
fn pledge_rejects_window_301() {
    assert_eq!(MONEY_WINDOW_SECS, 300);
    let mut w = World::demo();
    let demo = w.args(w.facility, 5_000_000, 0);

    let too_long = PledgeArgs {
        valid_until: w.now + 301,
        ..demo.clone()
    };
    w.assert_refused(&too_long, WindowTooLong);

    let longest = PledgeArgs {
        valid_until: w.now + 300,
        ..demo
    };
    w.pledge_ok(&longest);
}

#[test]
fn pledge_rejects_paused() {
    let mut w = World::demo();
    let paused = w.f.change_pause(Admin, pause::PLEDGE, true);
    w.f.ok(paused, Admin);

    w.assert_refused(&w.args(w.facility, 5_000_000, 0), Paused);

    // Only the PLEDGE bit stops a pledge.
    let unpause = w.f.change_pause(Admin, pause::PLEDGE, false);
    w.f.ok(unpause, Admin);
    let others = w.f.change_pause(Admin, pause::ALL & !pause::PLEDGE, true);
    w.f.ok(others, Admin);
    assert_eq!(
        w.f.read::<Protocol>(w.f.protocol).pause_flags,
        pause::ALL & !pause::PLEDGE
    );
    w.pledge_ok(&w.args(w.facility, 5_000_000, 0));
}

#[test]
fn pledged_units_refused_by_transfer_split_and_redeem() {
    let mut w = World::demo();
    w.pledge_ok(&w.args(w.facility, 2_000_000, 0));
    let position = w.owner_position();
    assert_eq!(position.locked_kg, 2_000_000);
    assert_eq!(position.revision, 1);
    let lot_revision = w.f.read::<Lot>(w.lot).revision;
    assert_eq!(lot_revision, 0);

    // Each Phase 1 handler is asked for all 5,000 t with otherwise valid inputs.
    let transfer = w.transfer(5_000_000, 1);
    w.f.sponsored_refused(&transfer, 1, InsufficientAvailable);
    let split = w.split("CR-0002", 5_000_000, lot_revision);
    w.f.sponsored_refused(&split, 1, InsufficientAvailable);
    let redeem = w.redeem(5_000_000, 1);
    w.f.sponsored_refused(&redeem, 1, InsufficientAvailable);

    let position = w.owner_position();
    assert_eq!(position.quantity_kg, 5_000_000);
    assert_eq!(position.locked_kg, 2_000_000);
    assert_eq!(position.revision, 1);
    assert!(!w.f.account_exists(w.position(w.buyer)));
    w.assert_invariants();

    // The unpledged 3,000 t still move; the pledged 2,000 t stay with the owner.
    let free = w.transfer(3_000_000, 1);
    w.f.sponsored_ok(&free);
    let position = w.owner_position();
    assert_eq!(position.quantity_kg, 2_000_000);
    assert_eq!(position.locked_kg, 2_000_000);
    assert_eq!(
        w.f.read::<Position>(w.position(w.buyer)).quantity_kg,
        3_000_000
    );
    w.assert_invariants();
}

#[test]
fn format_money_and_bps_known_answers() {
    for (minor, decimals, expected) in [
        (40_000_000, 2, "USD 400,000.00"),
        (20, 2, "USD 0.20"),
        (0, 2, "USD 0.00"),
        (1_500_000, 6, "USD 1.500000"),
        (7, 0, "USD 7"),
        (u64::MAX, 2, "USD 184,467,440,737,095,516.15"),
    ] {
        assert_eq!(
            format_money(minor, decimals, &USD),
            expected,
            "{minor} at {decimals} decimals"
        );
    }
    for (bps, expected) in [
        (6_000, "60.00%"),
        (1_200, "12.00%"),
        (0, "0.00%"),
        (10_000, "100.00%"),
        (5, "0.05%"),
    ] {
        assert_eq!(format_bps(bps), expected, "{bps} bps");
    }
}

#[test]
fn pledge_message_known_answer() {
    assert_eq!(
        ID.to_string(),
        "jGJpdjtoDUtXMjvc4UaEi1mBeFZKqVfe9jL8ireHMs3"
    );
    let instance: [u8; 16] = core::array::from_fn(|index| index as u8 * 0x11);
    assert_eq!(instance[15], 0xff);

    let bytes = pledge_message(
        &ID,
        &instance,
        "CR-0001",
        5_000_000,
        "Khunou Ore Exports",
        "Lender One Bank",
        &FACILITY_ONE,
        0,
        &USD,
        1_200,
        6_000,
        1,
        0,
        1_795_098_725,
    );

    assert_eq!(String::from_utf8(bytes.clone()).unwrap(), PLEDGE_TEXT);
    assert_eq!(bytes, PLEDGE_TEXT.as_bytes());
    assert_eq!(bytes.len(), 460);
    let sha256: String = solana_sha256_hasher::hash(&bytes)
        .to_bytes()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    assert_eq!(
        sha256,
        "0d2745d8edc9b94befab1dcca6e06d7aabe7d1a850310f3634f86162bcb77132"
    );
}

#[test]
fn pledge_size_fits_v0_widest() {
    // The demo pledge, executed as the relay sends it, within the compute budget.
    let mut w = World::demo();
    let args = w.args(w.facility, 5_000_000, 0);
    let (tx, demo_size) = w.pledge_v0(&args);
    let before = w.snapshot(&args);
    let meta =
        w.f.send(tx)
            .unwrap_or_else(|failure| panic!("{:?}\n{}", failure.err, failure.meta.pretty_logs()));
    let units = meta.compute_units_consumed;
    assert!(
        units < u64::from(COMPUTE_UNIT_LIMIT),
        "pledge used {units} compute units"
    );
    w.assert_pledged(&args, &before, &meta);
    println!("pledge v0 demo: {demo_size} bytes, {units} CU");

    // The widest values, serialised only.
    let spec = Spec::widest();
    assert_eq!(spec.owner_name.len(), MAX_DISPLAY_NAME);
    assert_eq!(spec.lender_name.len(), MAX_DISPLAY_NAME);
    assert_ne!(spec.owner_name, spec.lender_name);
    assert_eq!(spec.lot_id.len(), MAX_LOT_ID);
    let mut w = World::build(spec);
    w.forge_position(|position| position.revision = u64::MAX);
    w.forge_facility(w.facility, |facility| facility.loan_count = u32::MAX);
    let args = PledgeArgs {
        valid_until: i64::MAX,
        ..w.args(w.facility, u64::MAX, u64::MAX)
    };
    assert_eq!(args.loan_index, u32::MAX);
    let stored: Facility = w.f.read(w.facility);
    assert_eq!(stored.rate_bps, 10_000);
    assert_eq!(stored.max_ltv_bps, 10_000);
    assert_eq!(stored.terms_version, u32::MAX);
    assert_eq!(w.text(&args).len(), 596);

    let (_, widest_size) = w.pledge_v0(&args);
    println!("pledge v0 widest: {widest_size} bytes");
}

#[test]
fn pledge_rejects_text_the_parties_did_not_sign() {
    let mut w = World::demo();
    let demo = w.args(w.facility, 5_000_000, 0);
    // Both parties sign a text for 4,000 t, then the pledge asks for 5,000 t.
    let signed = PledgeArgs {
        quantity_kg: 4_000_000,
        ..demo.clone()
    };
    let text = w.text(&signed);
    let keys = [w.f.signer(Owner), w.f.signer(Lender)];
    let verify = ed25519_shared_instruction(&keys, &text);
    let pledge = w.pledge_instruction(&demo);
    w.f.sponsored_refused(&[verify, pledge], 1, MessageMismatch);
    w.assert_no_loan(&demo);

    w.pledge_ok(&demo);
}

#[test]
fn pledge_rejects_missing_verification_and_swapped_signers() {
    let mut w = World::demo();
    let demo = w.args(w.facility, 5_000_000, 0);
    // No Ed25519 instruction before the pledge.
    let pledge = w.pledge_instruction(&demo);
    w.f.sponsored_refused(&[pledge], 0, MissingVerification);
    w.assert_no_loan(&demo);

    // The lender's entry first: the borrower's entry must come first.
    let swapped = PledgeArgs {
        signers: vec![Lender, Owner],
        ..demo.clone()
    };
    w.assert_refused(&swapped, WrongSigner);

    w.pledge_ok(&demo);
}

#[test]
fn pledge_rejects_expired_signature_and_over_available() {
    let mut w = World::demo();
    let demo = w.args(w.facility, 5_000_000, 0);
    let late = PledgeArgs {
        valid_until: w.now - 1,
        ..demo.clone()
    };
    w.assert_refused(&late, Expired);
    // One kilogram more than the position holds.
    w.assert_refused(
        &PledgeArgs {
            quantity_kg: 5_000_001,
            ..demo.clone()
        },
        InsufficientAvailable,
    );

    w.pledge_ok(&demo);
}

#[test]
fn format_money_pads_and_groups_every_decimal_count() {
    for (minor, decimals, expected) in [
        (5, 2, "USD 0.05"),
        (5, 9, "USD 0.000000005"),
        (1_000_000_000, 9, "USD 1.000000000"),
        (999, 0, "USD 999"),
        (1_000, 0, "USD 1,000"),
        (123_456_789, 3, "USD 123,456.789"),
    ] {
        assert_eq!(
            format_money(minor, decimals, &USD),
            expected,
            "{minor} at {decimals} decimals"
        );
    }
}
