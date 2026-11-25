//! Fiat-mode `record_advance` tests. The lender signs the transaction and the borrower signs
//! "Accept advance" in one Ed25519 entry; the handler materialises accrual, checks the limit
//! through `release_preview`, then writes the loan.
//!
//! Demo money: USD cents, 20 c/kg, haircut 0, LTV 60%, a USD600,000 advance on the 5,000 t lot
//! CR-0001, at 1,200 bps simple interest. The demo cast is synthetic. Facility ids, digests,
//! site codes and expiries are deterministic synthetic test inputs.

mod common;

use anchor_lang::{prelude::Pubkey, AccountSerialize};
use common::{Actor::*, *};
use litesvm::types::TransactionMetadata;
use solana_message::{AddressLookupTableAccount, VersionedMessage};
use solana_transaction::{versioned::VersionedTransaction, Instruction};
use thetis::{
    accounts,
    error::ThetisError::{self, *},
    events, instruction,
    intent::message::{advance_message, issue_message, pledge_message},
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
/// A fixed 365-day year, the accrual year.
const YEAR: i64 = 31_536_000;
const LOT_VALIDITY: i64 = 30 * DAY;
/// The Authorities are delegated, and the valuation is valid, for two years (§9).
const AUTHORITY_LIFETIME: i64 = 2 * YEAR;
const VALUATION_VALIDITY: i64 = 2 * YEAR;
/// The signing window the advance tests use, inside the 300 s money window.
const MONEY_WINDOW: i64 = 240;
/// The signing window the Phase 1 custody actions use, inside their 600 s window.
const CUSTODY_WINDOW: i64 = 570;

const CLASS_CODE: &str = "CHROME";
const GRADES: [&str; 2] = ["A", "B"];
const SITE_CODE: &str = "PORT-STOCKYARD";
/// A second site of the same custodian and class, for the other-site valuation.
const OTHER_SITE_CODE: &str = "INLAND-YARD";
const INTAKE_DIGEST: [u8; 32] = [0x0a; 32];
const SOURCE_DIGEST: [u8; 32] = [0x5e; 32];

const USD: [u8; 3] = *b"USD";
const CENTS: u8 = 2;
const RATE_BPS: u16 = 1_200;
const MAX_LTV_BPS: u16 = 6_000;
const TERMS_DIGEST: [u8; 32] = [0x7d; 32];
/// 20 c/kg (demo.md §2).
const VALUE_PER_KG: u64 = 20;
/// Lender One Bank's facility to Khunou Ore Exports: the facility id of the signed-text vector.
const FACILITY_ONE: [u8; 16] = [0x11; 16];

const LOT_ID: &str = "CR-0001";
const LOT_KG: u64 = 5_000_000;
/// USD600,000: the 60% limit on 5,000 t at 20 c/kg.
const LIMIT: u64 = 60_000_000;
/// USD400,000.
const FOUR_HUNDRED_K: u64 = 40_000_000;

const OWNER_ID: u8 = 1;
const CUSTODIAN_ID: u8 = 2;
const LENDER_ID: u8 = 7;
const LENDER2_ID: u8 = 8;

const OWNER_NAME: &str = "Khunou Ore Exports";
const CUSTODIAN_NAME: &str = "Kopano Stockyard Custody";
const LENDER_NAME: &str = "Lender One Bank";
const LENDER2_NAME: &str = "Lender Two Bank";

/// The signed "Accept advance" known answer, byte for byte (§6.2).
const ADVANCE_TEXT: &str = "Thetis authorisation v1
Network: devnet
Program: jGJpdjtoDUtXMjvc4UaEi1mBeFZKqVfe9jL8ireHMs3
Protocol: 00112233445566778899aabbccddeeff
Action: Accept advance
Lot: CR-0001
Owner: Khunou Ore Exports
Lender: Lender One Bank
Facility: 11111111111111111111111111111111
Loan: 0
Advance: USD 600,000.00
Principal after: USD 600,000.00
Rate: 12.00% a year, simple, actual/365
Terms: v1
Revision: 0
Valid until: 2026-11-19 16:32:05 SAST
Test network only. Synthetic data.";

/// One `record_advance` call, with every input a test may vary.
#[derive(Clone)]
struct AdvanceArgs {
    amount: u64,
    currency: [u8; 3],
    /// The loan's revision.
    expected_revision: u64,
    valid_until: i64,
    /// The wallet that signs the transaction as `lender`.
    signer: Actor,
    lender_authority: Pubkey,
    lender_org: Pubkey,
    valuation: Pubkey,
}

/// What an advance may change, and what it must leave alone, read before it runs.
struct Snapshot {
    loan: Loan,
    untouched: Vec<(Pubkey, Option<RawAccount>)>,
}

/// A fiat-mode protocol with one stored chrome lot of 5,000 t held by Khunou Ore Exports, Lender
/// One Bank's facility to it with a fresh 20 c/kg valuation, and the whole lot pledged as loan 0.
struct World {
    f: Fixture,
    /// The clock, mirrored here so texts are signed relative to it.
    now: i64,
    owner: Pubkey,
    custodian: Pubkey,
    lender: Pubkey,
    lender2: Pubkey,
    class_policy: Pubkey,
    custodian_class: Pubkey,
    /// A second CustodianClass of the same custodian and class.
    other_site: Pubkey,
    lot: Pubkey,
    position: Pubkey,
    facility: Pubkey,
    /// The lot's own valuation: (facility, class, grade A, the lot's site).
    valuation: Pubkey,
    loan: Pubkey,
    lock: Pubkey,
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

/// §6.3 accrual, computed independently in the test: `(interest, remainder)` in `u128`.
fn expected_accrual(principal: u64, rate_bps: u16, elapsed: i64, carried: u64) -> (u64, u64) {
    const DENOMINATOR: u128 = 315_360_000_000;
    let numerator = u128::from(principal) * u128::from(rate_bps) * u128::try_from(elapsed).unwrap()
        + u128::from(carried);
    (
        u64::try_from(numerator / DENOMINATOR).unwrap(),
        u64::try_from(numerator % DENOMINATOR).unwrap(),
    )
}

impl World {
    fn demo() -> Self {
        let mut f = Fixture::initialized();
        let register =
            f.register_with_origin(Accreditor, CLASS_CODE, 1, &GRADES, LOT_VALIDITY, false);
        f.ok(register, Accreditor);
        let class_policy = f.class(CLASS_CODE, 1);

        let owner = accredit(&mut f, OWNER_ID, Role::Exporter, OWNER_NAME);
        let custodian = accredit(&mut f, CUSTODIAN_ID, Role::Custodian, CUSTODIAN_NAME);
        let lender = accredit(&mut f, LENDER_ID, Role::Lender, LENDER_NAME);
        let lender2 = accredit(&mut f, LENDER2_ID, Role::Lender, LENDER2_NAME);

        for site_code in [SITE_CODE, OTHER_SITE_CODE] {
            let accredit_site =
                f.accredit_site(Accreditor, custodian, class_policy, site_code, 10_000_000);
            f.ok(accredit_site, Accreditor);
        }
        let custodian_class = f.site(custodian, class_policy, SITE_CODE);
        let other_site = f.site(custodian, class_policy, OTHER_SITE_CODE);

        let expires_at = NOW + AUTHORITY_LIFETIME;
        for (org, wallet, scopes) in [
            (custodian, Custodian, scope::ISSUE),
            (owner, Owner, scope::PLEDGE),
            (lender, Lender, scope::LEND),
            (lender2, Lender2, scope::LEND),
        ] {
            let delegate = f.delegate(OrgAdmin, org, f.key(wallet), scopes, expires_at);
            f.ok(delegate, OrgAdmin);
        }

        let lot = pda(&[b"lot", f.protocol.as_ref(), LOT_ID.as_bytes()]);
        let position = pda(&[b"position", lot.as_ref(), owner.as_ref()]);
        let facility = pda(&[
            b"facility",
            f.protocol.as_ref(),
            lender.as_ref(),
            &FACILITY_ONE,
        ]);
        let loan = pda(&[b"loan", facility.as_ref(), &0_u32.to_le_bytes()]);
        let lock = pda(&[b"lock", loan.as_ref()]);
        let mut world = Self {
            f,
            now: NOW,
            owner,
            custodian,
            lender,
            lender2,
            class_policy,
            custodian_class,
            other_site,
            lot,
            position,
            facility,
            valuation: Pubkey::default(),
            loan,
            lock,
        };
        world.open_facility();
        world.valuation = world.set_valuation(GRADES[0], custodian_class, NOW + VALUATION_VALIDITY);
        world.issue_lot();
        world.pledge_whole_lot();
        world
    }

    fn advance_to(&mut self, unix_timestamp: i64) {
        self.now = unix_timestamp;
        self.f.set_time(unix_timestamp);
    }

    fn authority_of(&self, actor: Actor) -> Pubkey {
        self.f.authority(self.f.key(actor))
    }

    fn mint(&self) -> Pubkey {
        pda(&[b"mint", self.lot.as_ref()])
    }

    fn vault_authority(position: Pubkey) -> Pubkey {
        pda(&[b"vault", position.as_ref()])
    }

    fn vault(&self, position: Pubkey) -> Pubkey {
        Pubkey::find_program_address(
            &[
                Self::vault_authority(position).as_ref(),
                TOKEN_2022.as_ref(),
                self.mint().as_ref(),
            ],
            &ASSOCIATED_TOKEN,
        )
        .0
    }

    fn valuation_key(&self, grade: &str, custodian_class: Pubkey) -> Pubkey {
        pda(&[
            b"valuation",
            self.facility.as_ref(),
            self.class_policy.as_ref(),
            grade.as_bytes(),
            custodian_class.as_ref(),
        ])
    }

    /// Lender One Bank's USD facility to Khunou Ore Exports, through `open_facility`.
    fn open_facility(&mut self) {
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
        self.f.ok(open, Lender);
    }

    /// A real `set_valuation` by Lender One Bank under its facility and the chrome class, at
    /// 20 c/kg and haircut 0. Returns the valuation's address.
    fn set_valuation(&mut self, grade: &str, custodian_class: Pubkey, valid_until: i64) -> Pubkey {
        let valuation = self.valuation_key(grade, custodian_class);
        let set = ix(
            accounts::SetValuation {
                lender: self.f.key(Lender),
                payer: self.f.payer(),
                protocol: self.f.protocol,
                authority: self.authority_of(Lender),
                lender_org: self.lender,
                facility: self.facility,
                class_policy: self.class_policy,
                custodian_class,
                valuation,
                system_program: SYSTEM,
            },
            instruction::SetValuation {
                grade: grade.into(),
                value_per_kg: VALUE_PER_KG,
                haircut_bps: 0,
                valid_until,
                source_digest: SOURCE_DIGEST,
            },
        );
        self.f.ok(set, Lender);
        let stored: Valuation = self.f.read(valuation);
        assert_eq!(stored.grade, grade);
        assert_eq!(stored.custodian_class, custodian_class);
        assert_eq!(stored.valid_until, valid_until);
        valuation
    }

    /// Issues CR-0001 (5,000 t, grade A, at the lot's site) to the owner.
    fn issue_lot(&mut self) {
        let valid_until = self.now + CUSTODY_WINDOW;
        let protocol = self.f.protocol;
        let intake = pda(&[
            b"intake",
            protocol.as_ref(),
            self.custodian.as_ref(),
            &INTAKE_DIGEST,
        ]);
        let mint = self.mint();
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
                position: self.position,
                vault_authority: Self::vault_authority(self.position),
                vault: self.vault(self.position),
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
        let lot: Lot = self.f.read(self.lot);
        assert_eq!(lot.state, LotState::Stored);
        assert_eq!(lot.grade, GRADES[0]);
        assert_eq!(lot.custodian_class, self.custodian_class);
    }

    /// Pledges all 5,000 t to Lender One Bank as loan 0 at the current clock time.
    fn pledge_whole_lot(&mut self) {
        let valid_until = self.now + MONEY_WINDOW;
        let text = pledge_message(
            &ID,
            &INSTANCE,
            LOT_ID,
            LOT_KG,
            OWNER_NAME,
            LENDER_NAME,
            &FACILITY_ONE,
            0,
            &USD,
            RATE_BPS,
            MAX_LTV_BPS,
            1,
            0,
            valid_until,
        );
        let signers = [self.f.signer(Owner), self.f.signer(Lender)];
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
                quantity_kg: LOT_KG,
                expected_revision: 0,
                valid_until,
            },
        );
        self.f
            .sponsored_ok(&[ed25519_shared_instruction(&signers, &text), pledge]);
        let loan: Loan = self.f.read(self.loan);
        assert_eq!(loan.status, LoanStatus::Active);
        assert_eq!(loan.principal, 0);
        assert_eq!(loan.revision, 0);
        assert_eq!(loan.accrued_at, self.now);
        let lock: LockAllocation = self.f.read(self.lock);
        assert_eq!(lock.quantity_kg, LOT_KG);
        self.assert_invariants();
    }

    /// The default advance of `amount` on loan 0, signed by Lender One Bank's wallet.
    fn args(&self, amount: u64, expected_revision: u64) -> AdvanceArgs {
        AdvanceArgs {
            amount,
            currency: USD,
            expected_revision,
            valid_until: self.now + MONEY_WINDOW,
            signer: Lender,
            lender_authority: self.authority_of(Lender),
            lender_org: self.lender,
            valuation: self.valuation,
        }
    }

    /// The "Accept advance" text the program rebuilds from the accounts and the arguments.
    fn text(&self, args: &AdvanceArgs) -> Vec<u8> {
        let lot: Lot = self.f.read(self.lot);
        let facility: Facility = self.f.read(self.facility);
        let loan: Loan = self.f.read(self.loan);
        let owner = self.f.read::<Organisation>(self.owner).display_name;
        let lender = self.f.read::<Organisation>(args.lender_org).display_name;
        advance_message(
            &ID,
            &INSTANCE,
            &lot.lot_id,
            &owner,
            &lender,
            &facility.facility_id,
            loan.index,
            args.amount,
            loan.principal.checked_add(args.amount).unwrap(),
            &facility.currency,
            facility.currency_decimals,
            loan.rate_bps,
            loan.terms_version,
            args.expected_revision,
            args.valid_until,
        )
    }

    /// The borrower's one Ed25519 entry over `text`, followed by `record_advance`.
    fn advance_signed(&self, args: &AdvanceArgs, text: &[u8]) -> [Instruction; 2] {
        [
            ed25519_instruction(&[(self.f.signer(Owner), text)]),
            self.advance_instruction(args),
        ]
    }

    fn advance(&self, args: &AdvanceArgs) -> [Instruction; 2] {
        self.advance_signed(args, &self.text(args))
    }

    fn advance_instruction(&self, args: &AdvanceArgs) -> Instruction {
        ix(
            accounts::RecordAdvance {
                lender: self.f.key(args.signer),
                protocol: self.f.protocol,
                lender_authority: args.lender_authority,
                lender_org: args.lender_org,
                facility: self.facility,
                loan: self.loan,
                lock: self.lock,
                lot: self.lot,
                valuation: args.valuation,
                borrower_org: self.owner,
                borrower_authority: self.authority_of(Owner),
                instructions: INSTRUCTIONS_SYSVAR,
            },
            instruction::RecordAdvance {
                amount: args.amount,
                currency: args.currency,
                expected_revision: args.expected_revision,
                valid_until: args.valid_until,
            },
        )
    }

    fn snapshot(&self, args: &AdvanceArgs) -> Snapshot {
        let untouched = [
            self.f.protocol,
            args.lender_authority,
            args.lender_org,
            self.facility,
            self.lock,
            self.lot,
            args.valuation,
            self.owner,
            self.authority_of(Owner),
            self.position,
            self.vault(self.position),
            self.mint(),
        ]
        .into_iter()
        .map(|key| (key, self.f.raw_account(key)))
        .collect();
        Snapshot {
            loan: self.f.read(self.loan),
            untouched,
        }
    }

    /// Sends the advance and checks every effect, the event and the invariants.
    fn advance_ok(&mut self, args: &AdvanceArgs) -> TransactionMetadata {
        let before = self.snapshot(args);
        let instructions = self.advance(args);
        let tx = self.f.signed_ok(&instructions, args.signer);
        self.assert_advanced(args, &before, &tx);
        tx
    }

    /// The loan changes only in its accrual checkpoint, principal and revision; nothing else
    /// changes; one `AdvanceRecorded` carries the completed values.
    fn assert_advanced(&self, args: &AdvanceArgs, before: &Snapshot, tx: &TransactionMetadata) {
        let old = &before.loan;
        let (interest, remainder) = expected_accrual(
            old.principal,
            old.rate_bps,
            self.now - old.accrued_at,
            old.accrual_remainder,
        );
        let mut expected = old.clone();
        expected.booked_interest = old.booked_interest + interest;
        expected.accrual_remainder = remainder;
        expected.accrued_at = self.now;
        expected.principal = old.principal + args.amount;
        expected.revision = old.revision + 1;
        let loan: Loan = self.f.read(self.loan);
        assert_eq!(serialized(&loan), serialized(&expected));
        assert_eq!(self.f.owner_and_data_len(self.loan), Some((ID, 222)));
        for (key, account) in &before.untouched {
            assert_eq!(&self.f.raw_account(*key), account, "{key} changed");
        }
        assert_event(
            tx,
            events::AdvanceRecorded {
                loan: self.loan,
                amount: args.amount,
                principal: loan.principal,
                booked_interest: loan.booked_interest,
                revision: loan.revision,
            },
        );
        self.assert_invariants();
    }

    /// `record_advance` is index 1 of the transaction; the fixture also asserts that nothing
    /// changed and no event was emitted.
    fn assert_refused(&mut self, args: &AdvanceArgs, expected: ThetisError) {
        let instructions = self.advance(args);
        self.f
            .signed_refused(&instructions, args.signer, 1, expected);
    }

    /// §3 invariants: supply equals the position, the vault holds it, the lock is the
    /// position's whole `locked_kg` and fits, control follows status, and the remainder is below
    /// one minor unit of interest.
    fn assert_invariants(&self) {
        let f = &self.f;
        let lot: Lot = f.read(self.lot);
        let position: Position = f.read(self.position);
        assert_eq!(position.quantity_kg, lot.supply_kg);
        assert_eq!(
            f.token_amount(self.vault(self.position)),
            position.quantity_kg
        );
        assert_eq!(f.mint_supply(self.mint()), lot.supply_kg);
        let lock: LockAllocation = f.read(self.lock);
        let loan: Loan = f.read(self.loan);
        assert_eq!(lock.loan, self.loan);
        assert_eq!(lock.position, self.position);
        assert_eq!(
            loan.status == LoanStatus::Active,
            lock.control == LockControl::Pledged
        );
        assert_eq!(position.locked_kg, lock.quantity_kg);
        assert!(
            u128::from(position.locked_kg) + u128::from(position.reserved_kg)
                <= u128::from(position.quantity_kg)
        );
        assert!(loan.accrual_remainder < 315_360_000_000);
    }

    /// The per-instance lookup table: §12 item 12's pledge entries plus the Valuation.
    fn table_addresses(&self) -> Vec<Pubkey> {
        vec![
            SYSTEM,
            INSTRUCTIONS_SYSVAR,
            self.f.protocol,
            self.owner,
            self.authority_of(Owner),
            self.lender,
            self.authority_of(Lender),
            self.lot,
            self.position,
            self.facility,
            self.loan,
            self.lock,
            self.valuation,
        ]
    }

    /// Compiles the advance as the relay sends it (v0, lookup table, compute-budget
    /// instruction, signed by the sponsor and the lender) and asserts its shape and that it fits
    /// one packet. Returns the transaction and its size.
    fn advance_v0(
        &mut self,
        table: &AddressLookupTableAccount,
        instructions: [Instruction; 2],
    ) -> (VersionedTransaction, usize) {
        let [verify, advance] = instructions;
        let tx = self.f.signed_v0(
            &[compute_unit_limit(), verify, advance],
            std::slice::from_ref(table),
            Lender,
        );
        assert_eq!(tx.signatures.len(), 2, "the sponsor and the lender sign");
        let VersionedMessage::V0(message) = &tx.message else {
            panic!("a v0 message");
        };
        assert_eq!(
            sorted(message.account_keys.clone()),
            sorted(vec![
                self.f.payer(),
                self.f.key(Lender),
                ID,
                ED25519,
                COMPUTE_BUDGET
            ]),
            "only the two signers and the three called programs are inline"
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
        assert_eq!(loaded(&lookup.writable_indexes), vec![self.loan]);
        assert_eq!(
            loaded(&lookup.readonly_indexes),
            sorted(vec![
                self.f.protocol,
                self.authority_of(Lender),
                self.lender,
                self.facility,
                self.lock,
                self.lot,
                self.valuation,
                self.owner,
                self.authority_of(Owner),
                INSTRUCTIONS_SYSVAR,
            ])
        );
        let size = transaction_size(&tx);
        assert!(
            size <= PACKET_DATA_SIZE,
            "record_advance v0 transaction is {size} bytes"
        );
        (tx, size)
    }
}

#[test]
fn record_advance_demo_600k_at_limit_succeeds() {
    let mut w = World::demo();
    // The clock is fixed: the pledge and the advance run at the same second.
    assert_eq!(w.f.read::<Loan>(w.loan).accrued_at, w.now);
    let args = w.args(LIMIT, 0);

    let tx = w.advance_ok(&args);

    let loan: Loan = w.f.read(w.loan);
    assert_eq!(loan.status, LoanStatus::Active);
    assert_eq!(loan.principal, 60_000_000);
    assert_eq!(loan.booked_interest, 0);
    assert_eq!(loan.accrual_remainder, 0);
    assert_eq!(loan.accrued_at, NOW);
    assert_eq!(loan.revision, 1);
    assert_eq!(loan.rate_bps, 1_200);
    assert_eq!(loan.open_exceptions, 0);
    let lock: LockAllocation = w.f.read(w.lock);
    assert_eq!(lock.quantity_kg, 5_000_000);
    assert_eq!(lock.control, LockControl::Pledged);
    let position: Position = w.f.read(w.position);
    assert_eq!(position.locked_kg, 5_000_000);
    assert_eq!(position.revision, 1);
    assert_event(
        &tx,
        events::AdvanceRecorded {
            loan: w.loan,
            amount: 60_000_000,
            principal: 60_000_000,
            booked_interest: 0,
            revision: 1,
        },
    );
}

#[test]
fn record_advance_rejects_over_ltv() {
    let mut w = World::demo();
    // One cent over USD600,000.
    w.assert_refused(&w.args(LIMIT + 1, 0), OverLimit);
    let loan: Loan = w.f.read(w.loan);
    assert_eq!(loan.principal, 0);
    assert_eq!(loan.revision, 0);

    // Equality passes.
    w.advance_ok(&w.args(LIMIT, 0));
    // Once at the limit, one more cent is over it.
    w.assert_refused(&w.args(1, 1), OverLimit);
    assert_eq!(w.f.read::<Loan>(w.loan).principal, LIMIT);
}

#[test]
fn record_advance_materialises_accrual_before_limit() {
    let mut w = World::demo();
    w.advance_ok(&w.args(FOUR_HUNDRED_K, 0));
    let loan: Loan = w.f.read(w.loan);
    assert_eq!(loan.principal, 40_000_000);
    assert_eq!(loan.booked_interest, 0);
    assert_eq!(loan.revision, 1);

    // One accrual year later, 40,000,000 at 1,200 bps has accrued 4,800,000.
    w.advance_to(NOW + YEAR);
    let before = w.f.raw_account(w.loan);
    // Without accrual, 20,000,000 would sit exactly at the 60,000,000 limit.
    w.assert_refused(&w.args(20_000_000, 1), OverLimit);
    assert_eq!(w.f.raw_account(w.loan), before);
    let loan: Loan = w.f.read(w.loan);
    assert_eq!(loan.principal, 40_000_000);
    assert_eq!(loan.booked_interest, 0);
    assert_eq!(loan.accrual_remainder, 0);
    assert_eq!(loan.accrued_at, NOW);
    assert_eq!(loan.revision, 1);

    // One second later, the advance that brings the debt exactly to the limit is accepted
    // and the accrual is written.
    w.advance_to(NOW + YEAR + 1);
    let follow_up = LIMIT - FOUR_HUNDRED_K - 4_800_000;
    assert_eq!(follow_up, 15_200_000);
    let tx = w.advance_ok(&w.args(follow_up, 1));

    let loan: Loan = w.f.read(w.loan);
    assert_eq!(loan.booked_interest, 4_800_000);
    assert_eq!(loan.accrual_remainder, 48_000_000_000);
    assert_eq!(loan.accrued_at, NOW + YEAR + 1);
    assert_eq!(loan.principal, 55_200_000);
    assert_eq!(loan.revision, 2);
    assert_eq!(loan.principal + loan.booked_interest, LIMIT);
    assert_event(
        &tx,
        events::AdvanceRecorded {
            loan: w.loan,
            amount: 15_200_000,
            principal: 55_200_000,
            booked_interest: 4_800_000,
            revision: 2,
        },
    );
}

#[test]
fn record_advance_rejects_stale_valuation() {
    let mut w = World::demo();
    // The lender shortens the valuation to one day, then the clock passes it by one second.
    let valid_until = w.now + DAY;
    w.set_valuation(GRADES[0], w.custodian_class, valid_until);
    w.advance_to(valid_until + 1);

    w.assert_refused(&w.args(FOUR_HUNDRED_K, 0), ValuationStale);
    assert_eq!(w.f.read::<Loan>(w.loan).principal, 0);

    // Refreshed, the valuation is accepted up to and including its last second.
    let valid_until = w.now + DAY;
    w.set_valuation(GRADES[0], w.custodian_class, valid_until);
    w.advance_to(valid_until);
    w.advance_ok(&w.args(FOUR_HUNDRED_K, 0));
}

#[test]
fn record_advance_rejects_valuation_of_other_grade_or_site() {
    let mut w = World::demo();
    // Real, fresh valuations under the same facility and class; each differs only in the
    // named identity.
    let other_grade = w.set_valuation(GRADES[1], w.custodian_class, NOW + VALUATION_VALIDITY);
    let other_site = w.set_valuation(GRADES[0], w.other_site, NOW + VALUATION_VALIDITY);
    let lot: Lot = w.f.read(w.lot);
    assert_eq!(lot.grade, GRADES[0]);
    assert_eq!(lot.custodian_class, w.custodian_class);
    assert_ne!(w.other_site, w.custodian_class);

    for valuation in [other_grade, other_site] {
        let args = AdvanceArgs {
            valuation,
            ..w.args(FOUR_HUNDRED_K, 0)
        };
        w.assert_refused(&args, ValuationMismatch);
    }
    assert_eq!(w.f.read::<Loan>(w.loan).revision, 0);

    w.advance_ok(&w.args(FOUR_HUNDRED_K, 0));
}

#[test]
fn record_advance_rejects_wrong_currency() {
    let mut w = World::demo();
    // Compared byte for byte with the facility's USD.
    for currency in [*b"EUR", *b"usd"] {
        let args = AdvanceArgs {
            currency,
            ..w.args(FOUR_HUNDRED_K, 0)
        };
        w.assert_refused(&args, CurrencyMismatch);
    }
    assert_eq!(w.f.read::<Loan>(w.loan).principal, 0);

    w.advance_ok(&w.args(FOUR_HUNDRED_K, 0));
}

#[test]
fn record_advance_rejects_unsigned_increase() {
    let mut w = World::demo();
    let args = w.args(FOUR_HUNDRED_K, 0);
    // The lender signs the transaction; no Ed25519 instruction precedes the advance.
    let unsigned = w.advance_instruction(&args);
    w.f.signed_refused(&[unsigned], Lender, 0, MissingVerification);
    let loan: Loan = w.f.read(w.loan);
    assert_eq!(loan.principal, 0);
    assert_eq!(loan.revision, 0);

    w.advance_ok(&args);
}

#[test]
fn record_advance_rejects_amount_borrower_did_not_accept() {
    let mut w = World::demo();
    // The borrower accepted USD400,000; the lender records USD600,000. Both are within the limit.
    let accepted = w.args(FOUR_HUNDRED_K, 0);
    let recorded = w.args(LIMIT, 0);
    let text = w.text(&accepted);
    let instructions = w.advance_signed(&recorded, &text);
    w.f.signed_refused(&instructions, Lender, 1, MessageMismatch);
    assert_eq!(w.f.read::<Loan>(w.loan).principal, 0);

    w.advance_ok(&accepted);
    assert_eq!(w.f.read::<Loan>(w.loan).principal, 40_000_000);
}

#[test]
fn record_advance_rejects_other_lender() {
    let mut w = World::demo();
    let demo = w.args(FOUR_HUNDRED_K, 0);
    let lender2_authority = w.authority_of(Lender2);
    let stored: Authority = w.f.read(lender2_authority);
    assert_eq!(stored.organisation, w.lender2);
    assert_ne!(stored.scopes & scope::LEND, 0);
    assert!(stored.revoked_at.is_none());
    for args in [
        // Lender Two Bank, with its own organisation and canonical LEND Authority, signs against
        // Lender One Bank's facility and loan.
        AdvanceArgs {
            signer: Lender2,
            lender_authority: lender2_authority,
            lender_org: w.lender2,
            ..demo.clone()
        },
        // Lender Two's Authority naming Lender One's organisation.
        AdvanceArgs {
            signer: Lender2,
            lender_authority: lender2_authority,
            ..demo.clone()
        },
        // Lender One's Authority naming Lender Two's organisation.
        AdvanceArgs {
            lender_org: w.lender2,
            ..demo.clone()
        },
    ] {
        w.assert_refused(&args, WrongOrganisation);
    }
    assert_eq!(w.f.read::<Loan>(w.loan).principal, 0);

    w.advance_ok(&demo);
}

#[test]
fn record_advance_rejects_simulation_mode() {
    let mut w = World::demo();
    // A valid fiat loan fixture; the harness rewrites only the settlement mode.
    let mut protocol: Protocol = w.f.read(w.f.protocol);
    assert_eq!(
        protocol.settlement_mode,
        SettlementMode::FiatAttestationTest
    );
    protocol.settlement_mode = SettlementMode::DevnetTokenSimulation;
    let protocol_key = w.f.protocol;
    w.f.set_program_account(protocol_key, &protocol);

    w.assert_refused(&w.args(FOUR_HUNDRED_K, 0), WrongSettlementMode);
    assert_eq!(w.f.read::<Loan>(w.loan).principal, 0);

    // Back in fiat mode, the same advance is accepted.
    protocol.settlement_mode = SettlementMode::FiatAttestationTest;
    w.f.set_program_account(protocol_key, &protocol);
    w.advance_ok(&w.args(FOUR_HUNDRED_K, 0));
}

#[test]
fn advance_message_known_answer() {
    assert_eq!(
        ID.to_string(),
        "jGJpdjtoDUtXMjvc4UaEi1mBeFZKqVfe9jL8ireHMs3"
    );
    let instance: [u8; 16] = core::array::from_fn(|index| index as u8 * 0x11);
    assert_eq!(instance[15], 0xff);

    let bytes = advance_message(
        &ID,
        &instance,
        "CR-0001",
        "Khunou Ore Exports",
        "Lender One Bank",
        &FACILITY_ONE,
        0,
        60_000_000,
        60_000_000,
        &USD,
        2,
        1_200,
        1,
        0,
        1_795_098_725,
    );

    assert_eq!(String::from_utf8(bytes.clone()).unwrap(), ADVANCE_TEXT);
    assert_eq!(bytes, ADVANCE_TEXT.as_bytes());
    assert_eq!(bytes.len(), 463);
    let sha256: String = solana_sha256_hasher::hash(&bytes)
        .to_bytes()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    assert_eq!(
        sha256,
        "ce096def0e25dfe374590623223ddd840d32b7898059ea1118648b1964a13d32"
    );
}

#[test]
fn record_advance_size_fits_v0_widest() {
    // The demo advance, executed as the relay sends it, within the compute budget.
    let mut w = World::demo();
    let addresses = w.table_addresses();
    let table = w.f.create_lookup_table(addresses);
    let args = w.args(LIMIT, 0);
    let before = w.snapshot(&args);
    let instructions = w.advance(&args);
    let (tx, demo_size) = w.advance_v0(&table, instructions);
    let meta =
        w.f.send(tx)
            .unwrap_or_else(|failure| panic!("{:?}\n{}", failure.err, failure.meta.pretty_logs()));
    let units = meta.compute_units_consumed;
    assert!(
        units < u64::from(COMPUTE_UNIT_LIMIT),
        "record_advance used {units} compute units"
    );
    w.assert_advanced(&args, &before, &meta);
    println!("record_advance v0 demo: {demo_size} bytes, {units} CU");

    // The widest values (§13 item 11), serialised only: two distinct 48-byte names, a 16-byte
    // lot id, loan index u32::MAX, amount and principal after u64::MAX at one decimal, rate
    // 10,000 bps, terms u32::MAX, revision u64::MAX and valid_until i64::MAX.
    let owner = "Khunou Ore Exports And Allied Holdings Pty Ltd 1";
    let lender = "Lender One Bank And Allied Trade Finance Pty Ltd";
    let lot_id = "CR-0001-WIDEST-1";
    assert_eq!(owner.len(), MAX_DISPLAY_NAME);
    assert_eq!(lender.len(), MAX_DISPLAY_NAME);
    assert_ne!(owner, lender);
    assert_eq!(lot_id.len(), MAX_LOT_ID);
    let text = advance_message(
        &ID,
        &INSTANCE,
        lot_id,
        owner,
        lender,
        &FACILITY_ONE,
        u32::MAX,
        u64::MAX,
        u64::MAX,
        &USD,
        1,
        10_000,
        u32::MAX,
        u64::MAX,
        i64::MAX,
    );
    assert_eq!(text.len(), 615);
    let widest = AdvanceArgs {
        amount: u64::MAX,
        expected_revision: u64::MAX,
        valid_until: i64::MAX,
        ..w.args(LIMIT, 0)
    };
    let instructions = w.advance_signed(&widest, &text);
    let (_, widest_size) = w.advance_v0(&table, instructions);
    println!("record_advance v0 widest: {widest_size} bytes");
}
