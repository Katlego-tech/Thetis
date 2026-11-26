//! Recovery and closing. The facility's lender moves a loan that is over its limit on a fresh
//! valuation to Recovery with `liquidate` (TX, `LEND`): the lock changes control, and no units,
//! owner, custody or money move. The lender
//! closes a loan whose debt is zero and that has no open exception with `close_loan` (TX,
//! `LEND`): the lock is released from the position, and the Loan and LockAllocation stay as
//! tombstones that every later loan instruction refuses.
//!
//! Demo money: USD cents, 20 c/kg, haircut 0, LTV 60%, a USD600,000 advance on the 5,000 t lot
//! CR-0001, at 1,200 bps simple interest; one accrual year (31,536,000 s, 7,200,000 interest);
//! payments of USD600,000, USD210,000, USD30,000 and the USD700,000 overpayment; the 2,000 t at
//! USD400,000 release intent. The demo cast is synthetic. Facility ids, payment identities,
//! digests, site codes, nonces and expiries are deterministic synthetic test inputs.

mod common;

use anchor_lang::{prelude::Pubkey, AccountSerialize};
use common::{Actor::*, *};
use litesvm::types::TransactionMetadata;
use solana_message::Message;
use solana_transaction::Instruction;
use thetis::{
    accounts,
    error::ThetisError::{self, *},
    events, instruction,
    intent::message::{advance_message, issue_message, pledge_message, release_intent_message},
    state::*,
    ID,
};

const TOKEN_2022: Pubkey = anchor_spl::token_2022::ID;
const ASSOCIATED_TOKEN: Pubkey = anchor_spl::associated_token::ID;
const INSTRUCTIONS_SYSVAR: Pubkey = solana_sdk_ids::sysvar::instructions::ID;

const DAY: i64 = 86_400;
/// A fixed 365-day year, the accrual year.
const YEAR: i64 = 31_536_000;
const HOUR: i64 = 3_600;
const LOT_VALIDITY: i64 = 30 * DAY;
/// The Authorities are delegated, and the demo valuation is valid, for two years.
const AUTHORITY_LIFETIME: i64 = 2 * YEAR;
const VALUATION_VALIDITY: i64 = 2 * YEAR;
/// The signing window the money texts use, inside the 300 s money window.
const MONEY_WINDOW: i64 = 240;
/// The signing window the Phase 1 custody actions use, inside their 600 s window.
const CUSTODY_WINDOW: i64 = 570;

const CLASS_CODE: &str = "CHROME";
const GRADES: [&str; 2] = ["A", "B"];
const SITE_CODE: &str = "PORT-STOCKYARD";
const INTAKE_DIGEST: [u8; 32] = [0x0a; 32];
const SOURCE_DIGEST: [u8; 32] = [0x5e; 32];
/// The SHA-256 of the private bank evidence, as the lender's API would compute it.
const EVIDENCE_DIGEST: [u8; 32] = [0xe1; 32];

const USD: [u8; 3] = *b"USD";
const CENTS: u8 = 2;
const RATE_BPS: u16 = 1_200;
const MAX_LTV_BPS: u16 = 6_000;
const TERMS_DIGEST: [u8; 32] = [0x7d; 32];
/// 20 c/kg.
const VALUE_PER_KG: u64 = 20;
/// Lender One Bank's facility to Khunou Ore Exports.
const FACILITY_ONE: [u8; 16] = [0x11; 16];

const LOT_ID: &str = "CR-0001";
const LOT_KG: u64 = 5_000_000;
const TWO_THOUSAND_T: u64 = 2_000_000;

/// USD600,000: the advance, at the 60% limit on 5,000 t at 20 c/kg.
const LIMIT: u64 = 60_000_000;
/// One accrual year on USD600,000 at 1,200 bps: USD72,000.
const YEAR_INTEREST: u64 = 7_200_000;
/// USD400,000: the 2,000 t sale price.
const FOUR_HUNDRED_K: u64 = 40_000_000;
/// USD210,000.
const TWO_TEN_K: u64 = 21_000_000;
/// USD30,000.
const THIRTY_K: u64 = 3_000_000;
/// USD700,000: the overpayment.
const SEVEN_HUNDRED_K: u64 = 70_000_000;
const ACCRUAL_DENOMINATOR: u64 = 315_360_000_000;

const OWNER_ID: u8 = 1;
const CUSTODIAN_ID: u8 = 2;
const LENDER_ID: u8 = 7;
const LENDER2_ID: u8 = 8;
const BUYER_ID: u8 = 9;

const OWNER_NAME: &str = "Khunou Ore Exports";
const CUSTODIAN_NAME: &str = "Kopano Stockyard Custody";
const LENDER_NAME: &str = "Lender One Bank";
const LENDER2_NAME: &str = "Lender Two Bank";
const BUYER_NAME: &str = "Buyer Smelter Co";

/// The Loan's and the LockAllocation's account sizes, discriminators included.
const LOAN_SPACE: usize = 222;
const LOCK_SPACE: usize = 114;

/// A deterministic synthetic payment identity: 32 bytes of `n`.
fn payment_id(n: u8) -> [u8; 32] {
    [n; 32]
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

/// Accrual, computed independently in the test: `(interest, remainder)` in `u128`.
fn expected_accrual(principal: u64, rate_bps: u16, elapsed: i64, carried: u64) -> (u64, u64) {
    let numerator = u128::from(principal) * u128::from(rate_bps) * u128::try_from(elapsed).unwrap()
        + u128::from(carried);
    let denominator = u128::from(ACCRUAL_DENOMINATOR);
    (
        u64::try_from(numerator / denominator).unwrap(),
        u64::try_from(numerator % denominator).unwrap(),
    )
}

/// A fiat-mode protocol with the stored chrome lot CR-0001 (5,000 t) held by Khunou Ore
/// Exports, Lender One Bank's facility to it with a 20 c/kg valuation, the whole lot pledged as
/// loan 0, USD600,000 advanced at `NOW`, Lender Two Bank with its own `LEND` Authority, and
/// Buyer Smelter Co with a `BUY` Authority.
struct World {
    f: Fixture,
    /// The clock, mirrored here so texts are signed relative to it.
    now: i64,
    owner: Pubkey,
    custodian: Pubkey,
    lender: Pubkey,
    lender2: Pubkey,
    buyer: Pubkey,
    class_policy: Pubkey,
    custodian_class: Pubkey,
    lot: Pubkey,
    position: Pubkey,
    facility: Pubkey,
    valuation: Pubkey,
    loan: Pubkey,
    lock: Pubkey,
    /// Every payment attestation the world created, for the invariants.
    payments: Vec<Pubkey>,
}

impl World {
    /// The demo, with the valuation valid for two years.
    fn demo() -> Self {
        Self::with_valuation_until(NOW + VALUATION_VALIDITY)
    }

    /// The demo, with the valuation valid until `valid_until`.
    fn with_valuation_until(valid_until: i64) -> Self {
        let mut f = Fixture::initialized();
        let register =
            f.register_with_origin(Accreditor, CLASS_CODE, 1, &GRADES, LOT_VALIDITY, false);
        f.ok(register, Accreditor);
        let class_policy = f.class(CLASS_CODE, 1);

        let owner = accredit(&mut f, OWNER_ID, Role::Exporter, OWNER_NAME);
        let custodian = accredit(&mut f, CUSTODIAN_ID, Role::Custodian, CUSTODIAN_NAME);
        let lender = accredit(&mut f, LENDER_ID, Role::Lender, LENDER_NAME);
        let lender2 = accredit(&mut f, LENDER2_ID, Role::Lender, LENDER2_NAME);
        let buyer = accredit(&mut f, BUYER_ID, Role::Buyer, BUYER_NAME);

        let accredit_site = f.accredit_site(Accreditor, custodian, class_policy, SITE_CODE, LOT_KG);
        f.ok(accredit_site, Accreditor);
        let custodian_class = f.site(custodian, class_policy, SITE_CODE);

        let expires_at = NOW + AUTHORITY_LIFETIME;
        for (org, wallet, scopes) in [
            (custodian, Custodian, scope::ISSUE),
            (owner, Owner, scope::PLEDGE),
            (lender, Lender, scope::LEND),
            (lender2, Lender2, scope::LEND),
            (buyer, Buyer, scope::BUY),
        ] {
            let delegate = f.delegate(OrgAdmin, org, f.key(wallet), scopes, expires_at);
            f.ok(delegate, OrgAdmin);
        }

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
            buyer,
            class_policy,
            custodian_class,
            lot: Pubkey::default(),
            position: Pubkey::default(),
            facility,
            valuation: Pubkey::default(),
            loan,
            lock,
            payments: Vec::new(),
        };
        world.open_facility();
        world.valuation = world.set_valuation(valid_until);
        world.issue_lot();
        world.pledge();
        world.advance_demo();
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

    fn vault_authority(&self) -> Pubkey {
        pda(&[b"vault", self.position.as_ref()])
    }

    fn vault(&self) -> Pubkey {
        Pubkey::find_program_address(
            &[
                self.vault_authority().as_ref(),
                TOKEN_2022.as_ref(),
                self.mint().as_ref(),
            ],
            &ASSOCIATED_TOKEN,
        )
        .0
    }

    fn loan_state(&self) -> Loan {
        self.f.read(self.loan)
    }

    fn lock_state(&self) -> LockAllocation {
        self.f.read(self.lock)
    }

    fn position_state(&self) -> Position {
        self.f.read(self.position)
    }

    // ------------------------------------------------------------------- set-up ----

    /// A USD facility to Khunou Ore Exports at 1,200 bps and 60%, through `open_facility`.
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
        self.f.signed_ok(&[open], Lender);
    }

    /// Lender One Bank's valuation of grade A at the lot's site, 20 c/kg, haircut 0, valid
    /// until `valid_until`. The first call creates it; a later one updates it.
    fn set_valuation(&mut self, valid_until: i64) -> Pubkey {
        let valuation = pda(&[
            b"valuation",
            self.facility.as_ref(),
            self.class_policy.as_ref(),
            GRADES[0].as_bytes(),
            self.custodian_class.as_ref(),
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
                custodian_class: self.custodian_class,
                valuation,
                system_program: SYSTEM,
            },
            instruction::SetValuation {
                grade: GRADES[0].into(),
                value_per_kg: VALUE_PER_KG,
                haircut_bps: 0,
                valid_until,
                source_digest: SOURCE_DIGEST,
            },
        );
        self.f.signed_ok(&[set], Lender);
        assert_eq!(self.f.read::<Valuation>(valuation).valid_until, valid_until);
        valuation
    }

    /// Issues CR-0001, 5,000 t of grade A at the lot's site, to the owner.
    fn issue_lot(&mut self) {
        let valid_until = self.now + CUSTODY_WINDOW;
        let protocol = self.f.protocol;
        self.lot = pda(&[b"lot", protocol.as_ref(), LOT_ID.as_bytes()]);
        self.position = pda(&[b"position", self.lot.as_ref(), self.owner.as_ref()]);
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
                vault_authority: self.vault_authority(),
                vault: self.vault(),
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
        assert_eq!(self.f.read::<Lot>(self.lot).state, LotState::Stored);
    }

    /// The real PS×2 pledge of the whole lot to Lender One Bank as loan 0.
    fn pledge(&mut self) {
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
        assert_eq!(self.loan_state().status, LoanStatus::Active);
        assert_eq!(self.lock_state().quantity_kg, LOT_KG);
        self.assert_invariants();
    }

    /// `record_advance` of `amount` at the loan's current revision, accepted by the borrower:
    /// the Ed25519 entry, then the instruction.
    fn advance_instructions(&self, amount: u64) -> [Instruction; 2] {
        let loan = self.loan_state();
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
        let verify = ed25519_instruction(&[(self.f.signer(Owner), text.as_slice())]);
        [verify, advance]
    }

    /// The demo advance: USD600,000 on loan 0 at `NOW`.
    fn advance_demo(&mut self) {
        let instructions = self.advance_instructions(LIMIT);
        self.f.signed_ok(&instructions, Lender);
        let loan = self.loan_state();
        assert_eq!(loan.principal, LIMIT);
        assert_eq!(loan.booked_interest, 0);
        assert_eq!(loan.revision, 1);
        self.assert_invariants();
    }

    // ----------------------------------------------------------------- payments ----

    /// A real `confirm_payment` by Lender One Bank on loan 0. Returns the record and the
    /// transaction.
    fn confirm(
        &mut self,
        id: u8,
        purpose: PaymentPurpose,
        subject: Pubkey,
        target: Option<Pubkey>,
        amount: u64,
    ) -> (Pubkey, TransactionMetadata) {
        let payment = pda(&[
            b"payment",
            self.f.protocol.as_ref(),
            self.lender.as_ref(),
            &payment_id(id),
        ]);
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
        let tx = self.f.signed_ok(&[confirm], Lender);
        self.payments.push(payment);
        self.assert_invariants();
        (payment, tx)
    }

    /// A confirmed, unconsumed Repayment of `amount` on loan 0.
    fn confirm_repayment(&mut self, id: u8, amount: u64) -> Pubkey {
        let loan = self.loan;
        let (payment, _) = self.confirm(id, PaymentPurpose::Repayment, loan, None, amount);
        assert_eq!(
            self.f.read::<PaymentAttestation>(payment).status,
            PaymentStatus::Unconsumed
        );
        payment
    }

    /// A Correction naming `target`. Returns the record and the transaction.
    fn correct(&mut self, id: u8, target: Pubkey) -> (Pubkey, TransactionMetadata) {
        self.confirm(id, PaymentPurpose::Correction, target, Some(target), 0)
    }

    /// The fiat `repay` of `payment` on loan 0 by Lender One Bank.
    fn repay_instruction(&self, payment: Pubkey) -> Instruction {
        let amount = self.f.read::<PaymentAttestation>(payment).amount;
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

    fn repay(&mut self, payment: Pubkey) -> TransactionMetadata {
        let repay = self.repay_instruction(payment);
        let tx = self.f.signed_ok(&[repay], Lender);
        assert_eq!(
            self.f.read::<PaymentAttestation>(payment).status,
            PaymentStatus::Consumed
        );
        self.assert_invariants();
        tx
    }

    /// Confirms and repays `amount` on loan 0.
    fn repay_amount(&mut self, id: u8, amount: u64) -> (Pubkey, TransactionMetadata) {
        let payment = self.confirm_repayment(id, amount);
        let tx = self.repay(payment);
        (payment, tx)
    }

    // ----------------------------------------------------------- release intent ----

    /// The default intent on loan 0 (nonce 1, 2,000 t at USD400,000, no top-up,
    /// expiring a day from now), signed by the owner at the position's current revision.
    fn intent_instructions(&self) -> ([Instruction; 2], Pubkey) {
        let nonce = 1_u64;
        let expires_at = self.now + DAY;
        let valid_until = self.now + MONEY_WINDOW;
        let expected_revision = self.position_state().revision;
        let loan = self.loan_state();
        let text = release_intent_message(
            &ID,
            &INSTANCE,
            LOT_ID,
            TWO_THOUSAND_T,
            OWNER_NAME,
            BUYER_NAME,
            LENDER_NAME,
            &FACILITY_ONE,
            loan.index,
            nonce,
            FOUR_HUNDRED_K,
            0,
            &USD,
            CENTS,
            expires_at,
            expected_revision,
            valid_until,
        );
        let intent = pda(&[b"release", self.loan.as_ref(), &nonce.to_le_bytes()]);
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
                intent,
                instructions: INSTRUCTIONS_SYSVAR,
                system_program: SYSTEM,
            },
            instruction::CreateReleaseIntent {
                nonce,
                quantity_kg: TWO_THOUSAND_T,
                price: FOUR_HUNDRED_K,
                top_up: 0,
                expires_at,
                expected_revision,
                valid_until,
            },
        );
        let verify = ed25519_instruction(&[(self.f.signer(Owner), text.as_slice())]);
        ([verify, create], intent)
    }

    /// `create_release_intent` must fail with `expected`: no intent, no change, no event.
    fn intent_refused(&mut self, expected: ThetisError) {
        let (instructions, intent) = self.intent_instructions();
        self.f.sponsored_refused(&instructions, 1, expected);
        assert!(!self.f.account_exists(intent));
    }

    // ---------------------------------------------------------------- recovery ----

    /// `liquidate` of loan 0 at `expected_revision`, signed by Lender One Bank's wallet.
    fn liquidate_accounts(&self) -> accounts::Liquidate {
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
        }
    }

    fn liquidate_instruction(&self, expected_revision: u64) -> Instruction {
        ix(
            self.liquidate_accounts(),
            instruction::Liquidate { expected_revision },
        )
    }

    fn liquidate(&mut self, expected_revision: u64) -> TransactionMetadata {
        let liquidate = self.liquidate_instruction(expected_revision);
        let tx = self.f.signed_ok(&[liquidate], Lender);
        self.assert_invariants();
        tx
    }

    /// `liquidate` must fail with `expected`, with no state change and no event.
    fn liquidate_refused(&mut self, expected_revision: u64, expected: ThetisError) {
        let liquidate = self.liquidate_instruction(expected_revision);
        self.f.signed_refused(&[liquidate], Lender, 0, expected);
        self.assert_invariants();
    }

    fn close_instruction(&self, expected_revision: u64) -> Instruction {
        ix(
            accounts::CloseLoan {
                lender: self.f.key(Lender),
                protocol: self.f.protocol,
                authority: self.authority_of(Lender),
                lender_org: self.lender,
                facility: self.facility,
                loan: self.loan,
                lock: self.lock,
                position: self.position,
            },
            instruction::CloseLoan { expected_revision },
        )
    }

    fn close(&mut self, expected_revision: u64) -> TransactionMetadata {
        let close = self.close_instruction(expected_revision);
        let tx = self.f.signed_ok(&[close], Lender);
        assert_eq!(self.loan_state().status, LoanStatus::Closed);
        self.assert_invariants();
        tx
    }

    /// `close_loan` must fail with `expected`, with no state change and no event.
    fn close_refused(&mut self, expected_revision: u64, expected: ThetisError) {
        let close = self.close_instruction(expected_revision);
        self.f.signed_refused(&[close], Lender, 0, expected);
        self.assert_invariants();
    }

    /// One year on, the loan is over its limit, and `liquidate` moves it to
    /// Recovery at revision 2.
    fn liquidate_after_a_year(&mut self) -> TransactionMetadata {
        self.advance_to(NOW + YEAR);
        self.liquidate(1)
    }

    // ------------------------------------------------------------- invariants ----

    /// Accounts that neither `liquidate` nor `close_loan` writes: identity, policy, custody,
    /// the lot and its tokens, and the valuation. The position is not here: `close_loan`
    /// writes it, so each test compares it itself.
    fn custody_and_policy(&self) -> Vec<Pubkey> {
        vec![
            self.f.protocol,
            self.owner,
            self.custodian,
            self.lender,
            self.lender2,
            self.buyer,
            self.authority_of(Owner),
            self.authority_of(Lender),
            self.authority_of(Lender2),
            self.authority_of(Buyer),
            self.class_policy,
            self.custodian_class,
            self.facility,
            self.valuation,
            self.lot,
            self.mint(),
            self.vault_authority(),
            self.vault(),
        ]
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

    /// Invariants: supply equals the position and the vault and the mint; `locked_kg` is
    /// the lock's quantity while the loan isn't Closed and 0 once it is, and fits the position;
    /// a closed lock holds 0; for a loan that isn't Closed, Active ⇔ Pledged and Recovery ⇔
    /// Recovery; the remainder is below one minor unit; a consumed payment has
    /// `applied + surplus == amount`, and an unconsumed or voided one has neither.
    fn assert_invariants(&self) {
        let f = &self.f;
        let lot: Lot = f.read(self.lot);
        let position = self.position_state();
        assert_eq!(position.quantity_kg, lot.supply_kg);
        assert_eq!(f.mint_supply(self.mint()), lot.supply_kg);
        assert_eq!(f.token_amount(self.vault()), position.quantity_kg);
        let loan = self.loan_state();
        let lock = self.lock_state();
        assert_eq!(lock.loan, self.loan);
        assert_eq!(lock.position, loan.position);
        if loan.status == LoanStatus::Closed {
            assert_eq!(lock.quantity_kg, 0);
            assert_eq!(position.locked_kg, 0);
        } else {
            assert_eq!(position.locked_kg, lock.quantity_kg);
            assert_eq!(
                loan.status == LoanStatus::Active,
                lock.control == LockControl::Pledged
            );
            assert_eq!(
                loan.status == LoanStatus::Recovery,
                lock.control == LockControl::Recovery
            );
        }
        assert!(
            u128::from(position.locked_kg) + u128::from(position.reserved_kg)
                <= u128::from(position.quantity_kg)
        );
        assert!(loan.accrual_remainder < ACCRUAL_DENOMINATOR);
        for payment_key in &self.payments {
            let payment: PaymentAttestation = f.read(*payment_key);
            match payment.status {
                PaymentStatus::Consumed => {
                    assert_eq!(payment.applied + payment.surplus, payment.amount)
                }
                PaymentStatus::Unconsumed | PaymentStatus::Voided => {
                    assert_eq!((payment.applied, payment.surplus), (0, 0))
                }
            }
        }
    }
}

// --------------------------------------------------------------------- liquidate ----

#[test]
fn liquidate_rejects_healthy_loan() {
    let mut w = World::demo();
    // At `NOW` the debt is USD600,000 and the limit USD600,000: equality is healthy.
    let loan = w.loan_state();
    assert_eq!(loan.principal + loan.booked_interest, LIMIT);
    assert_eq!(
        u128::from(LOT_KG) * u128::from(VALUE_PER_KG) * u128::from(MAX_LTV_BPS) / 10_000,
        u128::from(LIMIT)
    );
    w.liquidate_refused(1, LoanHealthy);
    assert_eq!(w.loan_state().status, LoanStatus::Active);
    assert_eq!(w.lock_state().control, LockControl::Pledged);
}

#[test]
fn liquidate_after_accrual_moves_control_to_recovery() {
    let mut w = World::demo();
    w.advance_to(NOW + YEAR);
    assert_eq!(
        expected_accrual(LIMIT, RATE_BPS, YEAR, 0),
        (YEAR_INTEREST, 0)
    );
    let loan_before = w.loan_state();
    let lock_before = w.lock_state();
    let mut keys = w.custody_and_policy();
    keys.push(w.position);
    let untouched = w.snapshot(&keys);

    let tx = w.liquidate(1);

    let expected_loan = Loan {
        status: LoanStatus::Recovery,
        booked_interest: YEAR_INTEREST,
        accrual_remainder: 0,
        accrued_at: NOW + YEAR,
        revision: 2,
        ..loan_before.clone()
    };
    assert_eq!(serialized(&w.loan_state()), serialized(&expected_loan));
    assert_eq!(w.loan_state().principal, LIMIT);
    let expected_lock = LockAllocation {
        control: LockControl::Recovery,
        ..lock_before.clone()
    };
    assert_eq!(serialized(&w.lock_state()), serialized(&expected_lock));
    assert_eq!(w.lock_state().quantity_kg, LOT_KG);
    // A19: lot state, custodian class and its occupancy, the position's owner and quantities,
    // the vault and the mint are byte for byte unchanged; nothing moved.
    w.assert_unchanged(&untouched);
    let position = w.position_state();
    assert_eq!(position.owner, w.owner);
    assert_eq!(
        (
            position.quantity_kg,
            position.locked_kg,
            position.reserved_kg
        ),
        (LOT_KG, LOT_KG, 0)
    );
    assert_eq!(w.f.read::<Lot>(w.lot).state, LotState::Stored);
    assert_eq!(w.f.token_amount(w.vault()), LOT_KG);
    assert_event(
        &tx,
        events::Liquidated {
            loan: w.loan,
            lock: w.lock,
            debt: LIMIT + YEAR_INTEREST,
            limit: LIMIT,
            revision: 2,
        },
    );
}

#[test]
fn liquidate_rejects_stale_valuation() {
    let mut w = World::with_valuation_until(NOW + DAY);
    w.advance_to(NOW + YEAR);
    // Over the limit too: USD672,000 against USD600,000, so staleness is the only fault.
    let (interest, _) = expected_accrual(LIMIT, RATE_BPS, YEAR, 0);
    assert!(LIMIT + interest > LIMIT);
    w.liquidate_refused(1, ValuationStale);
    assert_eq!(w.loan_state().booked_interest, 0);

    // The same loan, revalued fresh, can be liquidated.
    w.set_valuation(NOW + YEAR + DAY);
    w.liquidate(1);
    assert_eq!(w.loan_state().status, LoanStatus::Recovery);
}

#[test]
fn liquidate_rejects_other_lender() {
    let mut w = World::demo();
    w.advance_to(NOW + YEAR);
    // Lender Two Bank's own canonical, active LEND Authority and organisation, its wallet
    // signing, against Lender One Bank's facility and over-limit loan.
    let liquidate = ix(
        accounts::Liquidate {
            lender: w.f.key(Lender2),
            authority: w.authority_of(Lender2),
            lender_org: w.lender2,
            ..w.liquidate_accounts()
        },
        instruction::Liquidate {
            expected_revision: 1,
        },
    );
    w.f.signed_refused(&[liquidate], Lender2, 0, WrongOrganisation);
    assert_eq!(w.loan_state().status, LoanStatus::Active);

    // The facility's own lender can.
    w.liquidate(1);
    assert_eq!(w.loan_state().status, LoanStatus::Recovery);
}

#[test]
fn liquidate_rejects_loan_not_active() {
    let mut w = World::demo();
    w.liquidate_after_a_year();
    assert_eq!(w.loan_state().revision, 2);
    w.liquidate_refused(2, LoanNotActive);
    assert_eq!(w.loan_state().status, LoanStatus::Recovery);
}

#[test]
fn recovery_blocks_release_intent_and_advance() {
    let mut w = World::demo();
    w.liquidate_after_a_year();
    // The position revision is still the pledge's: liquidation does not raise it.
    assert_eq!(w.position_state().revision, 1);
    w.intent_refused(LoanNotActive);

    let advance = w.advance_instructions(THIRTY_K);
    w.f.signed_refused(&advance, Lender, 1, LoanNotActive);
    let loan = w.loan_state();
    assert_eq!((loan.principal, loan.revision), (LIMIT, 2));
    w.assert_invariants();
}

#[test]
fn repay_in_recovery_succeeds() {
    let mut w = World::demo();
    w.liquidate_after_a_year();
    let (payment, tx) = w.repay_amount(1, TWO_TEN_K);

    let loan = w.loan_state();
    assert_eq!(loan.status, LoanStatus::Recovery);
    assert_eq!(loan.principal, LIMIT - (TWO_TEN_K - YEAR_INTEREST));
    assert_eq!(loan.principal, 46_200_000);
    assert_eq!(loan.booked_interest, 0);
    assert_eq!(loan.revision, 3);
    assert_eq!(w.lock_state().control, LockControl::Recovery);
    assert_eq!(w.lock_state().quantity_kg, LOT_KG);
    let record: PaymentAttestation = w.f.read(payment);
    assert_eq!((record.applied, record.surplus), (TWO_TEN_K, 0));
    assert_event(
        &tx,
        events::Repaid {
            loan: w.loan,
            payment: Some(payment),
            pool: None,
            pool_revision: None,
            applied: TWO_TEN_K,
            from_interest: YEAR_INTEREST,
            from_principal: 13_800_000,
            surplus: 0,
            principal: 46_200_000,
            booked_interest: 0,
            revision: 3,
        },
    );
}

// -------------------------------------------------------------------- close_loan ----

#[test]
fn close_loan_rejects_outstanding_debt() {
    let mut w = World::demo();
    w.close_refused(1, DebtOutstanding);
    assert_eq!(w.position_state().locked_kg, LOT_KG);
    assert_eq!(w.loan_state().status, LoanStatus::Active);
}

#[test]
fn close_loan_rejects_open_exception() {
    let mut w = World::demo();
    let (repayment, _) = w.repay_amount(1, LIMIT);
    let loan = w.loan_state();
    assert_eq!((loan.principal, loan.booked_interest), (0, 0));
    w.correct(2, repayment);
    let loan = w.loan_state();
    assert_eq!((loan.open_exceptions, loan.revision), (1, 3));

    w.close_refused(3, LiveObligation);
    assert_eq!(w.position_state().locked_kg, LOT_KG);
}

#[test]
fn close_loan_after_full_repay_releases_lock() {
    let mut w = World::demo();
    w.repay_amount(1, LIMIT);
    assert_eq!(w.loan_state().revision, 2);
    // An hour later, so the close writes its own accrual checkpoint.
    w.advance_to(NOW + HOUR);
    let loan_before = w.loan_state();
    let lock_before = w.lock_state();
    let position_before = w.position_state();
    let untouched = w.snapshot(&w.custody_and_policy());

    let tx = w.close(2);

    let expected_loan = Loan {
        status: LoanStatus::Closed,
        principal: 0,
        booked_interest: 0,
        accrual_remainder: 0,
        accrued_at: NOW + HOUR,
        revision: 3,
        ..loan_before.clone()
    };
    assert_eq!(serialized(&w.loan_state()), serialized(&expected_loan));
    let expected_lock = LockAllocation {
        quantity_kg: 0,
        control: LockControl::Pledged,
        ..lock_before.clone()
    };
    assert_eq!(serialized(&w.lock_state()), serialized(&expected_lock));
    let expected_position = Position {
        locked_kg: 0,
        revision: 2,
        ..position_before.clone()
    };
    assert_eq!(
        serialized(&w.position_state()),
        serialized(&expected_position)
    );
    assert_eq!(w.position_state().quantity_kg, LOT_KG);
    w.assert_unchanged(&untouched);
    assert_event(
        &tx,
        events::LoanClosed {
            loan: w.loan,
            position: w.position,
            released_kg: LOT_KG,
            revision: 3,
        },
    );
}

#[test]
fn closed_loan_is_tombstone() {
    let mut w = World::demo();
    // Close from Recovery: liquidate, repay the whole debt with the overpayment, then close.
    w.liquidate_after_a_year();
    let (overpayment, _) = w.repay_amount(1, SEVEN_HUNDRED_K);
    let record: PaymentAttestation = w.f.read(overpayment);
    assert_eq!(
        (record.applied, record.surplus),
        (
            LIMIT + YEAR_INTEREST,
            SEVEN_HUNDRED_K - LIMIT - YEAR_INTEREST
        )
    );
    assert_eq!(record.surplus, 2_800_000);
    assert_eq!(w.loan_state().revision, 3);
    let unconsumed = w.confirm_repayment(2, THIRTY_K);

    let tx = w.close(3);
    let loan = w.loan_state();
    assert_eq!((loan.status, loan.revision), (LoanStatus::Closed, 4));
    let lock = w.lock_state();
    assert_eq!((lock.quantity_kg, lock.control), (0, LockControl::Recovery));
    let position = w.position_state();
    assert_eq!((position.locked_kg, position.revision), (0, 2));
    assert_event(
        &tx,
        events::LoanClosed {
            loan: w.loan,
            position: w.position,
            released_kg: LOT_KG,
            revision: 4,
        },
    );

    // The accounts stay as tombstones.
    assert_eq!(w.f.owner_and_data_len(w.loan), Some((ID, LOAN_SPACE)));
    assert_eq!(w.f.owner_and_data_len(w.lock), Some((ID, LOCK_SPACE)));

    // Every Phase 2 loan instruction refuses the closed loan, one fault each.
    let advance = w.advance_instructions(THIRTY_K);
    w.f.signed_refused(&advance, Lender, 1, LoanNotActive);
    let repay = w.repay_instruction(unconsumed);
    w.f.signed_refused(&[repay], Lender, 0, LoanNotActive);
    assert_eq!(
        w.f.read::<PaymentAttestation>(unconsumed).status,
        PaymentStatus::Unconsumed
    );
    w.liquidate_refused(4, LoanNotActive);
    w.close_refused(4, LoanNotActive);
    w.intent_refused(LoanNotActive);
    let loan = w.loan_state();
    assert_eq!((loan.status, loan.revision), (LoanStatus::Closed, 4));

    // A Correction naming a consumed payment of the loan still succeeds.
    let (correction, tx) = w.correct(3, overpayment);
    let loan = w.loan_state();
    assert_eq!(loan.status, LoanStatus::Closed);
    assert_eq!((loan.open_exceptions, loan.revision), (1, 5));
    assert_event(
        &tx,
        events::PaymentCorrected {
            payment: correction,
            target: overpayment,
            loan: w.loan,
            voided: false,
            open_exceptions: 1,
            loan_revision: 5,
        },
    );
    assert_eq!(
        w.f.read::<PaymentAttestation>(unconsumed).status,
        PaymentStatus::Unconsumed
    );
}

/// The wire size of `instructions` as the legacy transaction `signed_ok` sends: the sponsor
/// (fee payer) and the lender sign.
fn legacy_wire_size(w: &World, instructions: &[Instruction]) -> usize {
    let message = Message::new(instructions, Some(&w.f.payer()));
    let signatures = usize::from(message.header.num_required_signatures);
    assert_eq!(signatures, 2);
    // A compact-u16 signature count (one byte below 128), the signatures, then the message.
    1 + signatures * 64 + message.serialize().len()
}

#[test]
fn recovery_instructions_fit_legacy_transaction_and_compute_budget() {
    let mut w = World::demo();
    w.advance_to(NOW + YEAR);
    let liquidate = [w.liquidate_instruction(1)];
    let liquidate_size = legacy_wire_size(&w, &liquidate);
    assert!(
        liquidate_size <= 1_232,
        "liquidate is {liquidate_size} bytes"
    );
    let tx = w.liquidate(1);
    assert!(
        tx.compute_units_consumed < 400_000,
        "liquidate used {} compute units",
        tx.compute_units_consumed
    );
    println!(
        "liquidate legacy: {liquidate_size} bytes, {} CU",
        tx.compute_units_consumed
    );

    w.repay_amount(1, SEVEN_HUNDRED_K);
    let close = [w.close_instruction(3)];
    let close_size = legacy_wire_size(&w, &close);
    assert!(close_size <= 1_232, "close_loan is {close_size} bytes");
    let tx = w.close(3);
    assert!(
        tx.compute_units_consumed < 400_000,
        "close_loan used {} compute units",
        tx.compute_units_consumed
    );
    println!(
        "close_loan legacy: {close_size} bytes, {} CU",
        tx.compute_units_consumed
    );
}
