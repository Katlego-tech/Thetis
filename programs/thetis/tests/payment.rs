//! Fiat-mode `confirm_payment` and `repay` tests. The facility lender's wallet signs each
//! transaction (TX, `LEND`); the fee sponsor is the init payer. A payment is recorded once per
//! lender and payment identity, consumed at most once by `repay`, and voided or marked as an
//! exception only by a `Correction` from the same lender. `repay` applies interest first, then
//! principal, and records any surplus on the consumed attestation.
//!
//! Demo money: USD cents, 20 c/kg, haircut 0, LTV 60%, a USD600,000 advance on the 5,000 t lot
//! CR-0001, at 1,200 bps simple interest; payments of USD210,000, USD30,000, USD400,000 and the
//! USD700,000 overpayment, and the bounds 0, 1 and `u64::MAX`. The demo cast is synthetic.
//! Facility ids, payment identities, digests, site codes and expiries are deterministic synthetic
//! test inputs. Until release intents can be created on chain, the harness writes one with
//! LiteSVM `set_account`.

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
    lending_math::{apply_payment, PaymentApplication},
    state::*,
    ID,
};

const TOKEN_2022: Pubkey = anchor_spl::token_2022::ID;
const TOKEN: Pubkey = anchor_spl::token::ID;
const ASSOCIATED_TOKEN: Pubkey = anchor_spl::associated_token::ID;
const INSTRUCTIONS_SYSVAR: Pubkey = solana_sdk_ids::sysvar::instructions::ID;
const COMPUTE_BUDGET: Pubkey = solana_sdk_ids::compute_budget::ID;
const PACKET_DATA_SIZE: usize = 1232;
const COMPUTE_UNIT_LIMIT: u32 = 400_000;

const DAY: i64 = 86_400;
/// A fixed 365-day year, the accrual year.
const YEAR: i64 = 31_536_000;
const LOT_VALIDITY: i64 = 30 * DAY;
/// The Authorities are delegated, and the valuation is valid, for two years.
const AUTHORITY_LIFETIME: i64 = 2 * YEAR;
const VALUATION_VALIDITY: i64 = 2 * YEAR;
/// The signing window the pledge and advance texts use, inside the 300 s money window.
const MONEY_WINDOW: i64 = 240;
/// The signing window the Phase 1 custody actions use, inside their 600 s window.
const CUSTODY_WINDOW: i64 = 570;

const CLASS_CODE: &str = "CHROME";
const GRADES: [&str; 2] = ["A", "B"];
const SITE_CODE: &str = "PORT-STOCKYARD";
const INTAKE_DIGEST: [u8; 32] = [0x0a; 32];
const SECOND_INTAKE_DIGEST: [u8; 32] = [0x0b; 32];
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
/// Lender Two Bank's facility to Khunou Ore Exports.
const FACILITY_TWO: [u8; 16] = [0x22; 16];

const LOT_ID: &str = "CR-0001";
const SECOND_LOT_ID: &str = "CR-0002";
const LOT_KG: u64 = 5_000_000;
const TWO_THOUSAND_T: u64 = 2_000_000;
const THREE_THOUSAND_T: u64 = 3_000_000;

/// USD600,000: the advance, at the 60% limit on 5,000 t at 20 c/kg.
const LIMIT: u64 = 60_000_000;
/// USD400,000: the 2,000 t sale price.
const FOUR_HUNDRED_K: u64 = 40_000_000;
/// USD210,000.
const TWO_TEN_K: u64 = 21_000_000;
/// USD30,000.
const THIRTY_K: u64 = 3_000_000;
/// USD700,000: the overpayment.
const SEVEN_HUNDRED_K: u64 = 70_000_000;
/// One accrual year of USD600,000 at 1,200 bps.
const ONE_YEAR_INTEREST: u64 = 7_200_000;
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

/// A deterministic synthetic payment identity: 32 bytes of `n`.
fn payment_id(n: u8) -> [u8; 32] {
    [n; 32]
}

/// One `confirm_payment` call, with every input a test may vary.
#[derive(Clone)]
struct ConfirmArgs {
    payment_id: [u8; 32],
    purpose: PaymentPurpose,
    amount: u64,
    currency: [u8; 3],
    evidence_digest: [u8; 32],
    observed_at: i64,
    /// The wallet that signs the transaction as `lender`.
    signer: Actor,
    authority: Pubkey,
    lender_org: Pubkey,
    facility: Pubkey,
    loan: Pubkey,
    subject: Pubkey,
    target: Option<Pubkey>,
}

/// One fiat `repay` call. Absent slots are `None`; of the six pool slots only `token_program`
/// is ever filled, to make a pool slot present.
#[derive(Clone)]
struct RepayArgs {
    amount: u64,
    signer: Actor,
    facility: Pubkey,
    loan: Pubkey,
    authority: Option<Pubkey>,
    lender_org: Option<Pubkey>,
    payment: Option<Pubkey>,
    token_program: Option<Pubkey>,
}

/// What a confirmation may change, and what it must leave alone, read before it runs.
struct ConfirmSnapshot {
    loan: Loan,
    target: Option<PaymentAttestation>,
    untouched: Vec<(Pubkey, Option<RawAccount>)>,
}

/// What a repayment may change, and what it must leave alone, read before it runs.
struct RepaySnapshot {
    loan: Loan,
    payment: PaymentAttestation,
    untouched: Vec<(Pubkey, Option<RawAccount>)>,
}

/// A second stored lot, CR-0002 (5,000 t), held by the same owner at the same site: 2,000 t
/// pledged to Lender One Bank as its loan 1, and 3,000 t to Lender Two Bank's own facility as
/// that facility's loan 0.
struct SecondLot {
    lender_one_loan: Pubkey,
    lender_two_facility: Pubkey,
    lender_two_loan: Pubkey,
}

/// A fiat-mode protocol with the stored chrome lot CR-0001 (5,000 t) held by Khunou Ore
/// Exports, Lender One Bank's facility to it with a fresh 20 c/kg valuation, the whole lot
/// pledged as loan 0, and USD600,000 advanced at `NOW`.
struct World {
    f: Fixture,
    /// The clock, mirrored here so texts are signed relative to it.
    now: i64,
    owner: Pubkey,
    custodian: Pubkey,
    lender: Pubkey,
    lender2: Pubkey,
    buyer: Option<Pubkey>,
    class_policy: Pubkey,
    custodian_class: Pubkey,
    lot: Pubkey,
    position: Pubkey,
    facility: Pubkey,
    valuation: Pubkey,
    loan: Pubkey,
    lock: Pubkey,
    /// Every (lot, position) the world issued, for the invariants.
    positions: Vec<(Pubkey, Pubkey)>,
    /// Every lock the world created, for the invariants.
    locks: Vec<Pubkey>,
    /// Every payment attestation the world created, for the invariants.
    payments: Vec<Pubkey>,
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

/// Interest first, then principal, computed independently in the test:
/// `(applied, from_interest, from_principal, surplus)`.
fn expected_split(principal: u64, interest_now: u64, received: u64) -> (u64, u64, u64, u64) {
    let debt = u64::try_from(u128::from(principal) + u128::from(interest_now)).unwrap();
    let applied = debt.min(received);
    let from_interest = applied.min(interest_now);
    (
        applied,
        from_interest,
        applied - from_interest,
        received - applied,
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

        // Room for two 5,000 t lots.
        let accredit_site =
            f.accredit_site(Accreditor, custodian, class_policy, SITE_CODE, 2 * LOT_KG);
        f.ok(accredit_site, Accreditor);
        let custodian_class = f.site(custodian, class_policy, SITE_CODE);

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

        let facility = pda(&[
            b"facility",
            f.protocol.as_ref(),
            lender.as_ref(),
            &FACILITY_ONE,
        ]);
        let loan = Self::loan_key(facility, 0);
        let lock = pda(&[b"lock", loan.as_ref()]);
        let mut world = Self {
            f,
            now: NOW,
            owner,
            custodian,
            lender,
            lender2,
            buyer: None,
            class_policy,
            custodian_class,
            lot: Pubkey::default(),
            position: Pubkey::default(),
            facility,
            valuation: Pubkey::default(),
            loan,
            lock,
            positions: Vec::new(),
            locks: Vec::new(),
            payments: Vec::new(),
        };
        world.open_facility(Lender, lender, FACILITY_ONE);
        world.valuation = world.set_valuation(NOW + VALUATION_VALIDITY);
        let (lot, position) = world.issue_lot(LOT_ID, INTAKE_DIGEST);
        world.lot = lot;
        world.position = position;
        let pledged = world.pledge(lot, LOT_ID, position, Lender, facility, 0, LOT_KG, 0);
        assert_eq!(pledged, loan);
        world.advance_demo();
        world
    }

    fn loan_key(facility: Pubkey, index: u32) -> Pubkey {
        pda(&[b"loan", facility.as_ref(), &index.to_le_bytes()])
    }

    fn advance_to(&mut self, unix_timestamp: i64) {
        self.now = unix_timestamp;
        self.f.set_time(unix_timestamp);
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
        Pubkey::find_program_address(
            &[
                Self::vault_authority(position).as_ref(),
                TOKEN_2022.as_ref(),
                Self::mint(lot).as_ref(),
            ],
            &ASSOCIATED_TOKEN,
        )
        .0
    }

    /// A USD facility to Khunou Ore Exports at 1,200 bps and 60%, through `open_facility`.
    fn open_facility(&mut self, signer: Actor, lender_org: Pubkey, facility_id: [u8; 16]) {
        let facility = pda(&[
            b"facility",
            self.f.protocol.as_ref(),
            lender_org.as_ref(),
            &facility_id,
        ]);
        let open = ix(
            accounts::OpenFacility {
                lender: self.f.key(signer),
                payer: self.f.payer(),
                protocol: self.f.protocol,
                authority: self.authority_of(signer),
                lender_org,
                borrower_org: self.owner,
                facility,
                pool: None,
                system_program: SYSTEM,
            },
            instruction::OpenFacility {
                facility_id,
                currency: USD,
                currency_decimals: CENTS,
                terms_version: 1,
                rate_bps: RATE_BPS,
                max_ltv_bps: MAX_LTV_BPS,
                terms_digest: TERMS_DIGEST,
            },
        );
        self.f.signed_ok(&[open], signer);
    }

    /// Lender One Bank's valuation of grade A at the lot's site, 20 c/kg, haircut 0.
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

    /// Issues a 5,000 t grade A lot at the lot's site to the owner. Returns (lot, position).
    fn issue_lot(&mut self, lot_id: &str, intake_digest: [u8; 32]) -> (Pubkey, Pubkey) {
        let valid_until = self.now + CUSTODY_WINDOW;
        let protocol = self.f.protocol;
        let lot = pda(&[b"lot", protocol.as_ref(), lot_id.as_bytes()]);
        let position = pda(&[b"position", lot.as_ref(), self.owner.as_ref()]);
        let intake = pda(&[
            b"intake",
            protocol.as_ref(),
            self.custodian.as_ref(),
            &intake_digest,
        ]);
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
            SITE_CODE,
            &intake_digest,
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
                intake_digest,
                valid_until,
            },
        );
        self.f.sponsored_ok(&[verify, issue]);
        assert_eq!(self.f.read::<Lot>(lot).state, LotState::Stored);
        self.positions.push((lot, position));
        (lot, position)
    }

    /// A real PS×2 pledge of `quantity_kg` of `position` to `facility` as loan `loan_index`,
    /// signed by the owner and the facility's lender. Returns the loan.
    #[allow(clippy::too_many_arguments)]
    fn pledge(
        &mut self,
        lot: Pubkey,
        lot_id: &str,
        position: Pubkey,
        lender: Actor,
        facility: Pubkey,
        loan_index: u32,
        quantity_kg: u64,
        position_revision: u64,
    ) -> Pubkey {
        let stored: Facility = self.f.read(facility);
        let lender_org = stored.lender;
        let lender_name = self.f.read::<Organisation>(lender_org).display_name;
        let valid_until = self.now + MONEY_WINDOW;
        let text = pledge_message(
            &ID,
            &INSTANCE,
            lot_id,
            quantity_kg,
            OWNER_NAME,
            &lender_name,
            &stored.facility_id,
            loan_index,
            &USD,
            RATE_BPS,
            MAX_LTV_BPS,
            1,
            position_revision,
            valid_until,
        );
        let loan = Self::loan_key(facility, loan_index);
        let lock = pda(&[b"lock", loan.as_ref()]);
        let signers = [self.f.signer(Owner), self.f.signer(lender)];
        let pledge = ix(
            accounts::Pledge {
                sponsor: self.f.payer(),
                protocol: self.f.protocol,
                lot,
                position,
                borrower_org: self.owner,
                borrower_authority: self.authority_of(Owner),
                lender_org,
                lender_authority: self.authority_of(lender),
                facility,
                loan,
                lock,
                instructions: INSTRUCTIONS_SYSVAR,
                system_program: SYSTEM,
            },
            instruction::Pledge {
                loan_index,
                quantity_kg,
                expected_revision: position_revision,
                valid_until,
            },
        );
        self.f
            .sponsored_ok(&[ed25519_shared_instruction(&signers, &text), pledge]);
        assert_eq!(self.f.read::<Loan>(loan).status, LoanStatus::Active);
        assert_eq!(self.f.read::<LockAllocation>(lock).quantity_kg, quantity_kg);
        self.locks.push(lock);
        self.assert_invariants();
        loan
    }

    /// The demo advance: USD600,000 on loan 0 at `NOW`, accepted by the borrower.
    fn advance_demo(&mut self) {
        let valid_until = self.now + MONEY_WINDOW;
        let text = advance_message(
            &ID,
            &INSTANCE,
            LOT_ID,
            OWNER_NAME,
            LENDER_NAME,
            &FACILITY_ONE,
            0,
            LIMIT,
            LIMIT,
            &USD,
            CENTS,
            RATE_BPS,
            1,
            0,
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
                amount: LIMIT,
                currency: USD,
                expected_revision: 0,
                valid_until,
            },
        );
        let verify = ed25519_instruction(&[(self.f.signer(Owner), text.as_slice())]);
        self.f.signed_ok(&[verify, advance], Lender);
        let loan: Loan = self.f.read(self.loan);
        assert_eq!(loan.principal, LIMIT);
        assert_eq!(loan.booked_interest, 0);
        assert_eq!(loan.accrual_remainder, 0);
        assert_eq!(loan.accrued_at, NOW);
        assert_eq!(loan.revision, 1);
        self.assert_invariants();
    }

    /// An advance on loan 0 that must be refused with `expected`: proves a valuation is stale.
    fn advance_refused(&mut self, amount: u64, expected: ThetisError) {
        let loan: Loan = self.f.read(self.loan);
        let valid_until = self.now + MONEY_WINDOW;
        let text = advance_message(
            &ID,
            &INSTANCE,
            LOT_ID,
            OWNER_NAME,
            LENDER_NAME,
            &FACILITY_ONE,
            0,
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
        self.f
            .signed_refused(&[verify, advance], Lender, 1, expected);
    }

    /// Issues CR-0002 and pledges it: 2,000 t to Lender One Bank (its loan 1) and 3,000 t to
    /// Lender Two Bank's own facility (that facility's loan 0).
    fn add_second_lot(&mut self) -> SecondLot {
        let (lot, position) = self.issue_lot(SECOND_LOT_ID, SECOND_INTAKE_DIGEST);
        let lender2 = self.lender2;
        self.open_facility(Lender2, lender2, FACILITY_TWO);
        let lender_two_facility = pda(&[
            b"facility",
            self.f.protocol.as_ref(),
            lender2.as_ref(),
            &FACILITY_TWO,
        ]);
        let facility = self.facility;
        let lender_one_loan = self.pledge(
            lot,
            SECOND_LOT_ID,
            position,
            Lender,
            facility,
            1,
            TWO_THOUSAND_T,
            0,
        );
        let lender_two_loan = self.pledge(
            lot,
            SECOND_LOT_ID,
            position,
            Lender2,
            lender_two_facility,
            0,
            THREE_THOUSAND_T,
            1,
        );
        SecondLot {
            lender_one_loan,
            lender_two_facility,
            lender_two_loan,
        }
    }

    /// Buyer Smelter Co, accredited on first use.
    fn buyer_org(&mut self) -> Pubkey {
        if let Some(buyer) = self.buyer {
            return buyer;
        }
        let buyer = accredit(&mut self.f, BUYER_ID, Role::Buyer, BUYER_NAME);
        self.buyer = Some(buyer);
        buyer
    }

    /// An open release intent of `loan` for 2,000 t at USD400,000 with no top-up, written by the
    /// harness at its canonical address (release intents are not created on chain yet).
    fn release_intent(&mut self, loan: Pubkey, nonce: u64) -> Pubkey {
        let buyer = self.buyer_org();
        let (address, bump) =
            Pubkey::find_program_address(&[b"release", loan.as_ref(), &nonce.to_le_bytes()], &ID);
        let stored: Loan = self.f.read(loan);
        let position: Position = self.f.read(stored.position);
        let intent = ReleaseIntent {
            protocol: self.f.protocol,
            loan,
            lot: stored.lot,
            position: stored.position,
            seller: self.owner,
            buyer,
            nonce,
            quantity_kg: TWO_THOUSAND_T,
            price: FOUR_HUNDRED_K,
            top_up: 0,
            currency: USD,
            expires_at: self.now + DAY,
            position_revision: position.revision,
            status: IntentStatus::Open,
            bump,
        };
        self.f.set_program_account(address, &intent);
        address
    }

    fn payment_key(&self, lender_org: Pubkey, payment_id: &[u8; 32]) -> Pubkey {
        pda(&[
            b"payment",
            self.f.protocol.as_ref(),
            lender_org.as_ref(),
            payment_id,
        ])
    }

    /// A Lender One Bank Repayment of `amount` on loan 0, observed now.
    fn repayment(&self, id: u8, amount: u64) -> ConfirmArgs {
        ConfirmArgs {
            payment_id: payment_id(id),
            purpose: PaymentPurpose::Repayment,
            amount,
            currency: USD,
            evidence_digest: EVIDENCE_DIGEST,
            observed_at: self.now,
            signer: Lender,
            authority: self.authority_of(Lender),
            lender_org: self.lender,
            facility: self.facility,
            loan: self.loan,
            subject: self.loan,
            target: None,
        }
    }

    /// A Lender One Bank Release payment of `amount` on loan 0 naming `intent`.
    fn release(&self, id: u8, intent: Pubkey, amount: u64) -> ConfirmArgs {
        ConfirmArgs {
            purpose: PaymentPurpose::Release,
            subject: intent,
            ..self.repayment(id, amount)
        }
    }

    /// A Lender One Bank Correction on loan 0 naming `target`.
    fn correction(&self, id: u8, target: Pubkey) -> ConfirmArgs {
        ConfirmArgs {
            purpose: PaymentPurpose::Correction,
            subject: target,
            target: Some(target),
            ..self.repayment(id, 0)
        }
    }

    fn confirm_instruction(&self, args: &ConfirmArgs) -> Instruction {
        ix(
            accounts::ConfirmPayment {
                lender: self.f.key(args.signer),
                payer: self.f.payer(),
                protocol: self.f.protocol,
                authority: args.authority,
                lender_org: args.lender_org,
                facility: args.facility,
                loan: args.loan,
                subject: args.subject,
                target: args.target,
                payment: self.payment_key(args.lender_org, &args.payment_id),
                system_program: SYSTEM,
            },
            instruction::ConfirmPayment {
                payment_id: args.payment_id,
                purpose: args.purpose,
                amount: args.amount,
                currency: args.currency,
                evidence_digest: args.evidence_digest,
                observed_at: args.observed_at,
            },
        )
    }

    /// Accounts a refused or successful action must never change: collateral and identity.
    fn collateral(&self) -> Vec<Pubkey> {
        let mut keys = vec![
            self.f.protocol,
            self.owner,
            self.lender,
            self.lender2,
            self.authority_of(Lender),
            self.authority_of(Lender2),
            self.valuation,
        ];
        for (lot, position) in &self.positions {
            keys.extend([
                *lot,
                *position,
                Self::vault(*lot, *position),
                Self::mint(*lot),
            ]);
        }
        keys.extend(self.locks.iter().copied());
        keys
    }

    fn confirm_snapshot(&self, args: &ConfirmArgs) -> ConfirmSnapshot {
        let mut keys = self.collateral();
        keys.push(args.facility);
        if args.subject != args.loan && Some(args.subject) != args.target {
            keys.push(args.subject);
        }
        ConfirmSnapshot {
            loan: self.f.read(args.loan),
            target: args.target.map(|target| self.f.read(target)),
            untouched: keys
                .into_iter()
                .map(|key| (key, self.f.raw_account(key)))
                .collect(),
        }
    }

    /// Sends the confirmation and checks the new record, the target and loan (for a
    /// Correction), that nothing else changed, the one event and the invariants.
    fn confirm_ok(&mut self, args: &ConfirmArgs) -> (Pubkey, TransactionMetadata) {
        let before = self.confirm_snapshot(args);
        let instruction = self.confirm_instruction(args);
        let tx = self.f.signed_ok(&[instruction], args.signer);
        let payment = self.assert_confirmed(args, &before, &tx);
        (payment, tx)
    }

    fn assert_confirmed(
        &mut self,
        args: &ConfirmArgs,
        before: &ConfirmSnapshot,
        tx: &TransactionMetadata,
    ) -> Pubkey {
        let (payment, bump) = Pubkey::find_program_address(
            &[
                b"payment",
                self.f.protocol.as_ref(),
                args.lender_org.as_ref(),
                &args.payment_id,
            ],
            &ID,
        );
        let facility: Facility = self.f.read(args.facility);
        let correction = args.purpose == PaymentPurpose::Correction;
        let expected = PaymentAttestation {
            protocol: self.f.protocol,
            lender: facility.lender,
            loan: args.loan,
            payment_id: args.payment_id,
            purpose: args.purpose,
            subject: args.subject,
            amount: args.amount,
            currency: args.currency,
            evidence_digest: args.evidence_digest,
            observed_at: args.observed_at,
            status: if correction {
                PaymentStatus::Consumed
            } else {
                PaymentStatus::Unconsumed
            },
            applied: 0,
            surplus: 0,
            bump,
        };
        let record: PaymentAttestation = self.f.read(payment);
        assert_eq!(serialized(&record), serialized(&expected));
        assert_eq!(self.f.owner_and_data_len(payment), Some((ID, 238)));

        let mut loan = before.loan.clone();
        match (&before.target, args.target) {
            (Some(old), Some(target)) => {
                let mut expected_target = old.clone();
                let voided = old.status == PaymentStatus::Unconsumed;
                if voided {
                    expected_target.status = PaymentStatus::Voided;
                } else {
                    loan.open_exceptions += 1;
                    loan.revision += 1;
                }
                let stored: PaymentAttestation = self.f.read(target);
                assert_eq!(serialized(&stored), serialized(&expected_target));
                assert_event(
                    tx,
                    events::PaymentCorrected {
                        payment,
                        target,
                        loan: args.loan,
                        voided,
                        open_exceptions: loan.open_exceptions,
                        loan_revision: loan.revision,
                    },
                );
            }
            _ => {
                assert!(!correction);
                assert_event(
                    tx,
                    events::PaymentConfirmed {
                        payment,
                        loan: args.loan,
                        purpose: args.purpose,
                        subject: args.subject,
                        amount: args.amount,
                        currency: args.currency,
                    },
                );
            }
        }
        let stored_loan: Loan = self.f.read(args.loan);
        assert_eq!(serialized(&stored_loan), serialized(&loan));
        for (key, account) in &before.untouched {
            assert_eq!(&self.f.raw_account(*key), account, "{key} changed");
        }
        self.payments.push(payment);
        self.assert_invariants();
        payment
    }

    /// `confirm_payment` must fail with `expected`; the fixture also asserts that nothing
    /// changed (the payment address included) and no event was emitted.
    fn confirm_refused(&mut self, args: &ConfirmArgs, expected: ThetisError) {
        let instruction = self.confirm_instruction(args);
        self.f
            .signed_refused(&[instruction], args.signer, 0, expected);
    }

    /// The complete fiat `repay` of `payment` on loan 0 by Lender One Bank.
    fn repay_args(&self, payment: Pubkey, amount: u64) -> RepayArgs {
        RepayArgs {
            amount,
            signer: Lender,
            facility: self.facility,
            loan: self.loan,
            authority: Some(self.authority_of(Lender)),
            lender_org: Some(self.lender),
            payment: Some(payment),
            token_program: None,
        }
    }

    fn repay_instruction(&self, args: &RepayArgs) -> Instruction {
        ix(
            accounts::Repay {
                signer: self.f.key(args.signer),
                protocol: self.f.protocol,
                facility: args.facility,
                loan: args.loan,
                authority: args.authority,
                lender_org: args.lender_org,
                payment: args.payment,
                pool: None,
                pool_authority: None,
                pool_vault: None,
                payer_token: None,
                mint: None,
                token_program: args.token_program,
            },
            instruction::Repay {
                amount: args.amount,
            },
        )
    }

    fn repay_snapshot(&self, args: &RepayArgs) -> RepaySnapshot {
        let mut keys = self.collateral();
        keys.push(args.facility);
        RepaySnapshot {
            loan: self.f.read(args.loan),
            payment: self.f.read(args.payment.unwrap()),
            untouched: keys
                .into_iter()
                .map(|key| (key, self.f.raw_account(key)))
                .collect(),
        }
    }

    fn repay_ok(&mut self, args: &RepayArgs) -> TransactionMetadata {
        let before = self.repay_snapshot(args);
        let instruction = self.repay_instruction(args);
        let tx = self.f.signed_ok(&[instruction], args.signer);
        self.assert_repaid(args, &before, &tx);
        tx
    }

    /// The loan changes only in its accrual checkpoint, principal, interest and revision; the
    /// payment becomes `Consumed` with the applied amount and surplus; nothing else changes; one
    /// `Repaid` carries the completed values.
    fn assert_repaid(&self, args: &RepayArgs, before: &RepaySnapshot, tx: &TransactionMetadata) {
        let old = &before.loan;
        let (interest, remainder) = expected_accrual(
            old.principal,
            old.rate_bps,
            self.now - old.accrued_at,
            old.accrual_remainder,
        );
        let interest_now = old.booked_interest + interest;
        let (applied, from_interest, from_principal, surplus) =
            expected_split(old.principal, interest_now, before.payment.amount);
        let mut loan = old.clone();
        loan.booked_interest = interest_now - from_interest;
        loan.accrual_remainder = remainder;
        loan.accrued_at = self.now;
        loan.principal = old.principal - from_principal;
        loan.revision = old.revision + 1;
        let stored_loan: Loan = self.f.read(args.loan);
        assert_eq!(serialized(&stored_loan), serialized(&loan));
        assert_eq!(stored_loan.status, old.status);

        let payment = args.payment.unwrap();
        let mut record = before.payment.clone();
        record.status = PaymentStatus::Consumed;
        record.applied = applied;
        record.surplus = surplus;
        let stored: PaymentAttestation = self.f.read(payment);
        assert_eq!(serialized(&stored), serialized(&record));
        assert_eq!(applied + surplus, record.amount);

        for (key, account) in &before.untouched {
            assert_eq!(&self.f.raw_account(*key), account, "{key} changed");
        }
        assert_event(
            tx,
            events::Repaid {
                loan: args.loan,
                payment: Some(payment),
                pool: None,
                pool_revision: None,
                applied,
                from_interest,
                from_principal,
                surplus,
                principal: loan.principal,
                booked_interest: loan.booked_interest,
                revision: loan.revision,
            },
        );
        self.assert_invariants();
    }

    /// `repay` must fail with `expected`, with no state change and no event.
    fn repay_refused(&mut self, args: &RepayArgs, expected: ThetisError) {
        let instruction = self.repay_instruction(args);
        self.f
            .signed_refused(&[instruction], args.signer, 0, expected);
    }

    fn set_settlement_mode(&mut self, mode: SettlementMode) {
        let mut protocol: Protocol = self.f.read(self.f.protocol);
        protocol.settlement_mode = mode;
        let address = self.f.protocol;
        self.f.set_program_account(address, &protocol);
    }

    /// §3 invariants: supply equals the position and the vault holds it; each position's
    /// `locked_kg` is the sum of its open locks and fits; control follows status; the remainder
    /// is below one minor unit; each payment is consumed at most once, with `applied + surplus
    /// == amount`, and a Correction carries no amount.
    fn assert_invariants(&self) {
        let f = &self.f;
        for (lot_key, position_key) in &self.positions {
            let lot: Lot = f.read(*lot_key);
            let position: Position = f.read(*position_key);
            assert_eq!(position.quantity_kg, lot.supply_kg);
            assert_eq!(
                f.token_amount(Self::vault(*lot_key, *position_key)),
                position.quantity_kg
            );
            assert_eq!(f.mint_supply(Self::mint(*lot_key)), lot.supply_kg);
            let locked: u64 = self
                .locks
                .iter()
                .map(|lock| f.read::<LockAllocation>(*lock))
                .filter(|lock| lock.position == *position_key)
                .filter(|lock| f.read::<Loan>(lock.loan).status != LoanStatus::Closed)
                .map(|lock| lock.quantity_kg)
                .sum();
            assert_eq!(position.locked_kg, locked);
            assert!(
                u128::from(position.locked_kg) + u128::from(position.reserved_kg)
                    <= u128::from(position.quantity_kg)
            );
        }
        for lock_key in &self.locks {
            let lock: LockAllocation = f.read(*lock_key);
            let loan: Loan = f.read(lock.loan);
            assert_eq!(lock.position, loan.position);
            assert_eq!(
                loan.status == LoanStatus::Active,
                lock.control == LockControl::Pledged
            );
            assert!(loan.accrual_remainder < ACCRUAL_DENOMINATOR);
        }
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
            if payment.purpose == PaymentPurpose::Correction {
                assert_eq!(payment.amount, 0);
                assert_eq!(payment.status, PaymentStatus::Consumed);
            }
        }
    }

    /// The per-instance lookup table: the pledge and advance entries.
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

    /// Compiles `instruction` as the relay sends it (v0, lookup table, compute-budget
    /// instruction, signed by the sponsor and the lender) and asserts which keys are inline and
    /// which are loaded, and that it fits one packet.
    fn payment_v0(
        &mut self,
        table: &AddressLookupTableAccount,
        instruction: Instruction,
        per_payment: Vec<Pubkey>,
        loaded_readonly: Vec<Pubkey>,
    ) -> (VersionedTransaction, usize) {
        let tx = self.f.signed_v0(
            &[compute_unit_limit(), instruction],
            std::slice::from_ref(table),
            Lender,
        );
        assert_eq!(tx.signatures.len(), 2, "the sponsor and the lender sign");
        let VersionedMessage::V0(message) = &tx.message else {
            panic!("a v0 message");
        };
        let mut inline = vec![self.f.payer(), self.f.key(Lender), ID, COMPUTE_BUDGET];
        inline.extend(per_payment);
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
        assert_eq!(loaded(&lookup.writable_indexes), vec![self.loan]);
        assert_eq!(loaded(&lookup.readonly_indexes), sorted(loaded_readonly));
        let size = transaction_size(&tx);
        assert!(size <= PACKET_DATA_SIZE, "v0 transaction is {size} bytes");
        (tx, size)
    }
}

/// Reads one `release-examples.json` field: a canonical decimal string that fits `u64`.
fn fixture_u64(row: &serde_json::Value, group: &str, field: &str) -> u64 {
    let text = row[group][field]
        .as_str()
        .unwrap_or_else(|| panic!("{group}.{field} is a string"));
    let value: u64 = text.parse().unwrap();
    assert_eq!(value.to_string(), text, "{group}.{field} is canonical");
    value
}

fn release_examples() -> Vec<serde_json::Value> {
    let rows: Vec<serde_json::Value> = serde_json::from_str(include_str!(
        "../../../fixtures/domain/release-examples.json"
    ))
    .unwrap();
    assert!(!rows.is_empty());
    for row in &rows {
        assert_eq!(row["label"], "synthetic");
    }
    rows
}

fn refused<T: std::fmt::Debug>(result: anchor_lang::Result<T>, expected: ThetisError) {
    assert_eq!(result.unwrap_err(), expected.into());
}

// ---------------------------------------------------------------- confirm_payment ----

#[test]
fn confirm_payment_records_unconsumed_attestation() {
    let mut w = World::demo();
    let loan_before = w.f.raw_account(w.loan);

    // Repayment: the subject is the loan itself.
    let repayment = w.repayment(1, THIRTY_K);
    let (payment, _) = w.confirm_ok(&repayment);
    let record: PaymentAttestation = w.f.read(payment);
    assert_eq!(record.protocol, w.f.protocol);
    assert_eq!(record.lender, w.lender);
    assert_eq!(record.loan, w.loan);
    assert_eq!(record.payment_id, payment_id(1));
    assert_eq!(record.purpose, PaymentPurpose::Repayment);
    assert_eq!(record.subject, w.loan);
    assert_eq!(record.amount, 3_000_000);
    assert_eq!(record.currency, *b"USD");
    assert_eq!(record.evidence_digest, EVIDENCE_DIGEST);
    assert_eq!(record.observed_at, NOW);
    assert_eq!(record.status, PaymentStatus::Unconsumed);
    assert_eq!((record.applied, record.surplus), (0, 0));
    assert_eq!(
        payment,
        pda(&[
            b"payment",
            w.f.protocol.as_ref(),
            w.lender.as_ref(),
            &payment_id(1)
        ])
    );

    // Release: the subject is the 2,000 t / USD400,000 intent; observed a day earlier.
    let intent = w.release_intent(w.loan, 1);
    let release = ConfirmArgs {
        observed_at: NOW - DAY,
        ..w.release(2, intent, FOUR_HUNDRED_K)
    };
    let (payment, tx) = w.confirm_ok(&release);
    let record: PaymentAttestation = w.f.read(payment);
    assert_eq!(record.purpose, PaymentPurpose::Release);
    assert_eq!(record.subject, intent);
    assert_eq!(record.amount, 40_000_000);
    assert_eq!(record.observed_at, NOW - DAY);
    assert_eq!(record.status, PaymentStatus::Unconsumed);
    assert_event(
        &tx,
        events::PaymentConfirmed {
            payment,
            loan: w.loan,
            purpose: PaymentPurpose::Release,
            subject: intent,
            amount: 40_000_000,
            currency: USD,
        },
    );

    // Recording money writes nothing to the loan.
    assert_eq!(w.f.raw_account(w.loan), loan_before);
}

#[test]
fn confirm_payment_rejects_reused_identity_other_loan() {
    let mut w = World::demo();
    let second = w.add_second_lot();
    let first = w.repayment(1, THIRTY_K);
    let (payment, _) = w.confirm_ok(&first);
    let before = w.f.raw_account(payment);

    // The same identity from the same lender, on its other loan: the address is taken (A05).
    let other_loan = ConfirmArgs {
        loan: second.lender_one_loan,
        subject: second.lender_one_loan,
        ..first.clone()
    };
    let instruction = w.confirm_instruction(&other_loan);
    w.f.already_initialized(instruction, Lender);
    // And again on the same loan.
    let instruction = w.confirm_instruction(&first);
    w.f.already_initialized(instruction, Lender);
    assert_eq!(w.f.raw_account(payment), before);

    // A fresh identity on the other loan is accepted.
    w.confirm_ok(&ConfirmArgs {
        payment_id: payment_id(2),
        ..other_loan
    });
}

#[test]
fn confirm_payment_identity_is_scoped_per_lender() {
    let mut w = World::demo();
    let second = w.add_second_lot();
    let one = w.repayment(1, THIRTY_K);
    let (lender_one_payment, _) = w.confirm_ok(&one);

    // The same identity, from Lender Two Bank on its own facility and loan.
    let two = ConfirmArgs {
        signer: Lender2,
        authority: w.authority_of(Lender2),
        lender_org: w.lender2,
        facility: second.lender_two_facility,
        loan: second.lender_two_loan,
        subject: second.lender_two_loan,
        ..one.clone()
    };
    let (lender_two_payment, _) = w.confirm_ok(&two);

    assert_ne!(lender_one_payment, lender_two_payment);
    let first: PaymentAttestation = w.f.read(lender_one_payment);
    let second_record: PaymentAttestation = w.f.read(lender_two_payment);
    assert_eq!(first.payment_id, second_record.payment_id);
    assert_eq!(first.lender, w.lender);
    assert_eq!(second_record.lender, w.lender2);
    assert_eq!(first.loan, w.loan);
    assert_eq!(second_record.loan, second.lender_two_loan);
    assert_eq!(first.status, PaymentStatus::Unconsumed);
    assert_eq!(second_record.status, PaymentStatus::Unconsumed);
}

#[test]
fn confirm_payment_rejects_other_lender() {
    let mut w = World::demo();
    let demo = w.repayment(1, THIRTY_K);
    let lender2_authority = w.authority_of(Lender2);
    let stored: Authority = w.f.read(lender2_authority);
    assert_eq!(stored.organisation, w.lender2);
    assert_ne!(stored.scopes & scope::LEND, 0);
    assert!(stored.revoked_at.is_none());
    for args in [
        // Lender Two Bank, with its own organisation and canonical LEND Authority, records a
        // payment against Lender One Bank's facility and loan (A04).
        ConfirmArgs {
            signer: Lender2,
            authority: lender2_authority,
            lender_org: w.lender2,
            ..demo.clone()
        },
        // Lender Two's Authority naming Lender One's organisation.
        ConfirmArgs {
            signer: Lender2,
            authority: lender2_authority,
            ..demo.clone()
        },
        // Lender One's Authority naming Lender Two's organisation.
        ConfirmArgs {
            lender_org: w.lender2,
            ..demo.clone()
        },
    ] {
        w.confirm_refused(&args, WrongOrganisation);
    }

    w.confirm_ok(&demo);
}

#[test]
fn confirm_payment_rejects_wrong_currency() {
    let mut w = World::demo();
    // Compared byte for byte with the facility's USD (A06).
    for currency in [*b"EUR", *b"usd"] {
        let args = ConfirmArgs {
            currency,
            ..w.repayment(1, THIRTY_K)
        };
        w.confirm_refused(&args, CurrencyMismatch);
    }

    w.confirm_ok(&w.repayment(1, THIRTY_K));
}

#[test]
fn confirm_payment_rejects_missing_digests_and_future_time() {
    let mut w = World::demo();
    let base = w.repayment(1, THIRTY_K);
    // One fault each, so one refusal cannot mask another.
    for args in [
        ConfirmArgs {
            payment_id: [0; 32],
            ..base.clone()
        },
        ConfirmArgs {
            evidence_digest: [0; 32],
            ..base.clone()
        },
        ConfirmArgs {
            observed_at: w.now + 1,
            ..base.clone()
        },
        ConfirmArgs {
            amount: 0,
            ..base.clone()
        },
    ] {
        w.confirm_refused(&args, InvalidField);
    }

    // Observed exactly now is accepted.
    assert_eq!(base.observed_at, w.now);
    let (payment, _) = w.confirm_ok(&base);

    // A Correction carries no amount; any other purpose carries no target.
    let correction = ConfirmArgs {
        amount: 1,
        ..w.correction(2, payment)
    };
    w.confirm_refused(&correction, InvalidField);
    let extraneous = ConfirmArgs {
        target: Some(payment),
        ..w.repayment(3, THIRTY_K)
    };
    w.confirm_refused(&extraneous, InvalidField);
    assert_eq!(
        w.f.read::<PaymentAttestation>(payment).status,
        PaymentStatus::Unconsumed
    );
}

#[test]
fn confirm_payment_rejects_subject_of_other_loan() {
    let mut w = World::demo();
    let second = w.add_second_lot();

    // Repayment naming Lender One Bank's other, real loan.
    let repayment = ConfirmArgs {
        subject: second.lender_one_loan,
        ..w.repayment(1, THIRTY_K)
    };
    w.confirm_refused(&repayment, PaymentNotBound);

    // Release naming an intent of that other loan.
    let other_intent = w.release_intent(second.lender_one_loan, 1);
    w.confirm_refused(&w.release(2, other_intent, FOUR_HUNDRED_K), PaymentNotBound);
    // Release naming an account that is not a ReleaseIntent: the loan, then a wallet.
    w.confirm_refused(&w.release(2, w.loan, FOUR_HUNDRED_K), PaymentNotBound);
    let wallet = w.f.key(Owner);
    w.confirm_refused(&w.release(2, wallet, FOUR_HUNDRED_K), PaymentNotBound);

    // This loan's own subjects are accepted.
    w.confirm_ok(&w.repayment(1, THIRTY_K));
    let own_intent = w.release_intent(w.loan, 1);
    w.confirm_ok(&w.release(2, own_intent, FOUR_HUNDRED_K));
}

#[test]
fn confirm_payment_rejects_simulation_mode() {
    let mut w = World::demo();
    // A valid fiat loan fixture; the harness rewrites only the settlement mode.
    w.set_settlement_mode(SettlementMode::DevnetTokenSimulation);
    w.confirm_refused(&w.repayment(1, THIRTY_K), WrongSettlementMode);

    w.set_settlement_mode(SettlementMode::FiatAttestationTest);
    w.confirm_ok(&w.repayment(1, THIRTY_K));
}

// -------------------------------------------------------------------------- repay ----

#[test]
fn repay_applies_interest_then_principal() {
    let mut w = World::demo();
    // One accrual year: USD600,000 at 1,200 bps has accrued 7,200,000, with no remainder.
    w.advance_to(NOW + YEAR);
    let (payment, _) = w.confirm_ok(&w.repayment(1, TWO_TEN_K));

    let tx = w.repay_ok(&w.repay_args(payment, TWO_TEN_K));

    let loan: Loan = w.f.read(w.loan);
    assert_eq!(loan.booked_interest, 0);
    assert_eq!(loan.principal, 46_200_000);
    assert_eq!(loan.accrual_remainder, 0);
    assert_eq!(loan.accrued_at, NOW + YEAR);
    assert_eq!(loan.revision, 2);
    assert_eq!(loan.status, LoanStatus::Active);
    let record: PaymentAttestation = w.f.read(payment);
    assert_eq!(record.status, PaymentStatus::Consumed);
    assert_eq!((record.applied, record.surplus), (21_000_000, 0));
    assert_event(
        &tx,
        events::Repaid {
            loan: w.loan,
            payment: Some(payment),
            pool: None,
            pool_revision: None,
            applied: 21_000_000,
            from_interest: ONE_YEAR_INTEREST,
            from_principal: 13_800_000,
            surplus: 0,
            principal: 46_200_000,
            booked_interest: 0,
            revision: 2,
        },
    );
}

#[test]
fn repay_partial_conserves_debt() {
    let mut w = World::demo();
    // One year and one second: 7,200,000 interest, and 72,000,000,000 carried.
    w.advance_to(NOW + YEAR + 1);
    let debt_before = LIMIT + ONE_YEAR_INTEREST;
    let (payment, _) = w.confirm_ok(&w.repayment(1, THIRTY_K));

    let tx = w.repay_ok(&w.repay_args(payment, THIRTY_K));

    let loan: Loan = w.f.read(w.loan);
    assert_eq!(loan.principal, 60_000_000);
    assert_eq!(loan.booked_interest, 4_200_000);
    assert_eq!(loan.accrual_remainder, 72_000_000_000);
    assert_eq!(loan.accrued_at, NOW + YEAR + 1);
    assert_eq!(loan.revision, 2);
    assert_eq!(
        loan.principal + loan.booked_interest,
        debt_before - THIRTY_K
    );
    assert_event(
        &tx,
        events::Repaid {
            loan: w.loan,
            payment: Some(payment),
            pool: None,
            pool_revision: None,
            applied: 3_000_000,
            from_interest: 3_000_000,
            from_principal: 0,
            surplus: 0,
            principal: 60_000_000,
            booked_interest: 4_200_000,
            revision: 2,
        },
    );

    // One second later, one cent: the carried remainder is kept, not dropped.
    w.advance_to(NOW + YEAR + 2);
    let (payment, _) = w.confirm_ok(&w.repayment(2, 1));
    w.repay_ok(&w.repay_args(payment, 1));
    let loan: Loan = w.f.read(w.loan);
    assert_eq!(loan.principal, 60_000_000);
    assert_eq!(loan.booked_interest, 4_199_999);
    assert_eq!(loan.accrual_remainder, 144_000_000_000);
    assert_eq!(loan.accrued_at, NOW + YEAR + 2);
    assert_eq!(loan.revision, 3);
}

#[test]
fn repay_overpayment_records_surplus() {
    let mut w = World::demo();
    // The domain's overpayment fixture: USD700,000 against USD600,000.
    let row = release_examples()
        .into_iter()
        .find(|row| row["name"] == "overpay-surplus")
        .unwrap();
    assert_eq!(fixture_u64(&row, "input", "principal"), LIMIT);
    assert_eq!(fixture_u64(&row, "input", "buyerAmount"), SEVEN_HUNDRED_K);
    assert_eq!(fixture_u64(&row, "expected", "applied"), 60_000_000);
    assert_eq!(fixture_u64(&row, "expected", "sellerSurplus"), 10_000_000);

    // The clock is fixed, so no interest has accrued.
    let (payment, _) = w.confirm_ok(&w.repayment(1, SEVEN_HUNDRED_K));
    let tx = w.repay_ok(&w.repay_args(payment, SEVEN_HUNDRED_K));
    let loan: Loan = w.f.read(w.loan);
    assert_eq!((loan.principal, loan.booked_interest), (0, 0));
    assert_eq!(loan.revision, 2);
    // Repaying never closes the loan.
    assert_eq!(loan.status, LoanStatus::Active);
    let record: PaymentAttestation = w.f.read(payment);
    assert_eq!(record.status, PaymentStatus::Consumed);
    assert_eq!((record.applied, record.surplus), (60_000_000, 10_000_000));
    assert_event(
        &tx,
        events::Repaid {
            loan: w.loan,
            payment: Some(payment),
            pool: None,
            pool_revision: None,
            applied: 60_000_000,
            from_interest: 0,
            from_principal: 60_000_000,
            surplus: 10_000_000,
            principal: 0,
            booked_interest: 0,
            revision: 2,
        },
    );

    // On zero debt, one cent is still consumed and recorded, all of it surplus.
    let (payment, _) = w.confirm_ok(&w.repayment(2, 1));
    let tx = w.repay_ok(&w.repay_args(payment, 1));
    let record: PaymentAttestation = w.f.read(payment);
    assert_eq!(record.status, PaymentStatus::Consumed);
    assert_eq!((record.applied, record.surplus), (0, 1));
    assert_event(
        &tx,
        events::Repaid {
            loan: w.loan,
            payment: Some(payment),
            pool: None,
            pool_revision: None,
            applied: 0,
            from_interest: 0,
            from_principal: 0,
            surplus: 1,
            principal: 0,
            booked_interest: 0,
            revision: 3,
        },
    );
}

#[test]
fn repay_with_stale_valuation_succeeds() {
    let mut w = World::demo();
    // The lender shortens the valuation to one day, then the clock passes it.
    let valid_until = w.now + DAY;
    w.set_valuation(valid_until);
    w.advance_to(valid_until + 1);
    assert!(w.f.read::<Valuation>(w.valuation).valid_until < w.now);
    // The valuation is genuinely stale: an advance is refused.
    w.advance_refused(1, ValuationStale);

    let (payment, _) = w.confirm_ok(&w.repayment(1, THIRTY_K));
    w.repay_ok(&w.repay_args(payment, THIRTY_K));
    let loan: Loan = w.f.read(w.loan);
    assert_eq!(loan.revision, 2);
    assert_eq!(loan.accrued_at, valid_until + 1);
    assert_eq!(
        w.f.read::<PaymentAttestation>(payment).status,
        PaymentStatus::Consumed
    );
}

#[test]
fn repay_while_paused_succeeds() {
    let mut w = World::demo();
    let pause_all = w.f.change_pause(Admin, pause::ALL, true);
    w.f.ok(pause_all, Admin);
    assert_eq!(w.f.read::<Protocol>(w.f.protocol).pause_flags, pause::ALL);

    // Recording money that has arrived, and repaying with it, are never paused.
    let (payment, _) = w.confirm_ok(&w.repayment(1, THIRTY_K));
    w.repay_ok(&w.repay_args(payment, THIRTY_K));
    assert_eq!(w.f.read::<Protocol>(w.f.protocol).pause_flags, pause::ALL);
    assert_eq!(w.f.read::<Loan>(w.loan).revision, 2);
}

#[test]
fn repay_rejects_consumed_attestation() {
    let mut w = World::demo();
    let (payment, _) = w.confirm_ok(&w.repayment(1, THIRTY_K));
    w.repay_ok(&w.repay_args(payment, THIRTY_K));
    let loan = w.f.raw_account(w.loan);

    w.repay_refused(&w.repay_args(payment, THIRTY_K), PaymentConsumed);
    assert_eq!(w.f.raw_account(w.loan), loan);
    let record: PaymentAttestation = w.f.read(payment);
    assert_eq!((record.applied, record.surplus), (3_000_000, 0));
}

#[test]
fn repay_rejects_attestation_for_other_loan_or_purpose() {
    let mut w = World::demo();
    let second = w.add_second_lot();

    // A Repayment of Lender One Bank's other loan (A06).
    let other_loan = ConfirmArgs {
        loan: second.lender_one_loan,
        subject: second.lender_one_loan,
        ..w.repayment(1, THIRTY_K)
    };
    let (other, _) = w.confirm_ok(&other_loan);
    w.repay_refused(&w.repay_args(other, THIRTY_K), PaymentNotBound);

    // A bound, unconsumed Release payment of this loan.
    let intent = w.release_intent(w.loan, 1);
    let (release, _) = w.confirm_ok(&w.release(2, intent, FOUR_HUNDRED_K));
    w.repay_refused(&w.repay_args(release, FOUR_HUNDRED_K), PaymentNotBound);

    // The purpose alone: a Release record whose subject the harness rewrites to the loan, a
    // state no instruction produces, so only the purpose is wrong.
    let mut forged: PaymentAttestation = w.f.read(release);
    let real = forged.clone();
    forged.subject = w.loan;
    w.f.set_program_account(release, &forged);
    w.repay_refused(&w.repay_args(release, FOUR_HUNDRED_K), PaymentNotBound);
    // The subject alone: the same record rewritten to purpose Repayment, still naming the intent.
    forged.subject = intent;
    forged.purpose = PaymentPurpose::Repayment;
    w.f.set_program_account(release, &forged);
    w.repay_refused(&w.repay_args(release, FOUR_HUNDRED_K), PaymentNotBound);
    w.f.set_program_account(release, &real);

    for payment in [other, release] {
        assert_eq!(
            w.f.read::<PaymentAttestation>(payment).status,
            PaymentStatus::Unconsumed
        );
    }
    let (own, _) = w.confirm_ok(&w.repayment(3, THIRTY_K));
    w.repay_ok(&w.repay_args(own, THIRTY_K));
}

#[test]
fn repay_rejects_missing_attestation() {
    let mut w = World::demo();
    let (payment, _) = w.confirm_ok(&w.repayment(1, THIRTY_K));
    let full = w.repay_args(payment, THIRTY_K);

    // The None sentinel in the payment slot, alone and with every other slot fault: the
    // payment is checked first.
    for args in [
        RepayArgs {
            payment: None,
            ..full.clone()
        },
        RepayArgs {
            payment: None,
            authority: None,
            lender_org: None,
            token_program: Some(TOKEN),
            ..full.clone()
        },
    ] {
        w.repay_refused(&args, PaymentMissing);
    }
    // With the payment present, a missing authority or organisation, or a pool slot, is not
    // the fiat layout.
    for args in [
        RepayArgs {
            authority: None,
            ..full.clone()
        },
        RepayArgs {
            lender_org: None,
            ..full.clone()
        },
        RepayArgs {
            token_program: Some(TOKEN),
            ..full.clone()
        },
    ] {
        w.repay_refused(&args, InvalidField);
    }

    w.repay_ok(&full);
}

#[test]
fn repay_rejects_simulation_mode() {
    let mut w = World::demo();
    let (payment, _) = w.confirm_ok(&w.repayment(1, THIRTY_K));
    // A valid fiat repayment; the harness rewrites only the settlement mode. `repay` runs in
    // both modes, and the simulation slot matrix refuses the fiat layout.
    w.set_settlement_mode(SettlementMode::DevnetTokenSimulation);
    w.repay_refused(&w.repay_args(payment, THIRTY_K), InvalidField);
    assert_eq!(
        w.f.read::<PaymentAttestation>(payment).status,
        PaymentStatus::Unconsumed
    );

    w.set_settlement_mode(SettlementMode::FiatAttestationTest);
    w.repay_ok(&w.repay_args(payment, THIRTY_K));
}

#[test]
fn repay_wrong_amount_leaves_payment_unresolved() {
    let mut w = World::demo();
    // The confirmation is committed in its own transaction first.
    let (payment, _) = w.confirm_ok(&w.repayment(1, THIRTY_K));
    w.repay_refused(&w.repay_args(payment, TWO_TEN_K), InvalidField);

    // The money stays unresolved and bound to its subject (A08).
    let record: PaymentAttestation = w.f.read(payment);
    assert_eq!(record.status, PaymentStatus::Unconsumed);
    assert_eq!(record.loan, w.loan);
    assert_eq!(record.subject, w.loan);
    assert_eq!(record.purpose, PaymentPurpose::Repayment);
    assert_eq!(record.amount, 3_000_000);
    assert_eq!((record.applied, record.surplus), (0, 0));
    assert_eq!(w.f.read::<Loan>(w.loan).revision, 1);

    w.repay_ok(&w.repay_args(payment, THIRTY_K));
}

// --------------------------------------------------------------------- correction ----

#[test]
fn correction_voids_unconsumed_attestation() {
    let mut w = World::demo();
    let (payment, _) = w.confirm_ok(&w.repayment(1, THIRTY_K));
    let loan_before = w.f.raw_account(w.loan);

    let (correction, tx) = w.confirm_ok(&w.correction(2, payment));

    let original: PaymentAttestation = w.f.read(payment);
    assert_eq!(original.status, PaymentStatus::Voided);
    assert_eq!(original.amount, 3_000_000);
    assert_eq!((original.applied, original.surplus), (0, 0));
    let record: PaymentAttestation = w.f.read(correction);
    assert_eq!(record.purpose, PaymentPurpose::Correction);
    assert_eq!(record.status, PaymentStatus::Consumed);
    assert_eq!(record.subject, payment);
    assert_eq!((record.amount, record.applied, record.surplus), (0, 0, 0));
    // A void reports the loan's revision without advancing it.
    assert_eq!(w.f.raw_account(w.loan), loan_before);
    let loan: Loan = w.f.read(w.loan);
    assert_eq!((loan.open_exceptions, loan.revision), (0, 1));
    assert_event(
        &tx,
        events::PaymentCorrected {
            payment: correction,
            target: payment,
            loan: w.loan,
            voided: true,
            open_exceptions: 0,
            loan_revision: 1,
        },
    );

    // A voided record is never consumed.
    w.repay_refused(&w.repay_args(payment, THIRTY_K), PaymentConsumed);
    // A correction naming the voided record, or a correction, is not bound.
    w.confirm_refused(&w.correction(3, payment), PaymentNotBound);
    w.confirm_refused(&w.correction(4, correction), PaymentNotBound);
    // A Correction needs its target.
    let no_target = ConfirmArgs {
        target: None,
        ..w.correction(5, payment)
    };
    w.confirm_refused(&no_target, PaymentNotBound);
}

#[test]
fn correction_after_consumption_appends_exception_without_reversal() {
    let mut w = World::demo();
    w.advance_to(NOW + YEAR);
    let (payment, _) = w.confirm_ok(&w.repayment(1, TWO_TEN_K));
    w.repay_ok(&w.repay_args(payment, TWO_TEN_K));
    let consumed = w.f.raw_account(payment);
    let loan_before: Loan = w.f.read(w.loan);
    assert_eq!(loan_before.principal, 46_200_000);
    assert_eq!(loan_before.revision, 2);

    // A day later, so a correction that wrote accrual would show it (A09).
    w.advance_to(NOW + YEAR + DAY);
    let (correction, tx) = w.confirm_ok(&w.correction(2, payment));

    // The original stays consumed with its amounts.
    assert_eq!(w.f.raw_account(payment), consumed);
    let original: PaymentAttestation = w.f.read(payment);
    assert_eq!(original.status, PaymentStatus::Consumed);
    assert_eq!((original.applied, original.surplus), (21_000_000, 0));
    // The balances and the accrual checkpoint are not rewound or advanced.
    let loan: Loan = w.f.read(w.loan);
    assert_eq!(loan.principal, 46_200_000);
    assert_eq!(loan.booked_interest, 0);
    assert_eq!(loan.accrual_remainder, 0);
    assert_eq!(loan.accrued_at, NOW + YEAR);
    assert_eq!(loan.status, LoanStatus::Active);
    // One exception, one revision.
    assert_eq!(loan.open_exceptions, 1);
    assert_eq!(loan.revision, 3);
    let record: PaymentAttestation = w.f.read(correction);
    assert_eq!(record.status, PaymentStatus::Consumed);
    assert_eq!(record.subject, payment);
    assert_eq!((record.amount, record.applied, record.surplus), (0, 0, 0));
    assert_event(
        &tx,
        events::PaymentCorrected {
            payment: correction,
            target: payment,
            loan: w.loan,
            voided: false,
            open_exceptions: 1,
            loan_revision: 3,
        },
    );

    // Repayment stays open under an exception.
    let (later, _) = w.confirm_ok(&w.repayment(3, THIRTY_K));
    w.repay_ok(&w.repay_args(later, THIRTY_K));
    let loan: Loan = w.f.read(w.loan);
    assert_eq!(loan.open_exceptions, 1);
    assert_eq!(loan.revision, 4);
}

// ---------------------------------------------------------------- transaction size ----

#[test]
fn confirm_payment_and_repay_size_fit_v0() {
    let mut w = World::demo();
    let addresses = w.table_addresses();
    let table = w.f.create_lookup_table(addresses);
    let confirm_loaded = vec![
        w.f.protocol,
        w.authority_of(Lender),
        w.lender,
        w.facility,
        SYSTEM,
    ];

    // A Repayment confirmation.
    let repayment = w.repayment(1, THIRTY_K);
    let payment = w.payment_key(w.lender, &repayment.payment_id);
    let before = w.confirm_snapshot(&repayment);
    let instruction = w.confirm_instruction(&repayment);
    let (tx, size) = w.payment_v0(&table, instruction, vec![payment], confirm_loaded.clone());
    let meta = w.f.send(tx).unwrap();
    assert!(meta.compute_units_consumed < u64::from(COMPUTE_UNIT_LIMIT));
    w.assert_confirmed(&repayment, &before, &meta);
    println!(
        "confirm_payment (Repayment) v0: {size} bytes, {} CU",
        meta.compute_units_consumed
    );

    // A Release confirmation: the intent is inline.
    let intent = w.release_intent(w.loan, 1);
    let release = w.release(2, intent, FOUR_HUNDRED_K);
    let release_payment = w.payment_key(w.lender, &release.payment_id);
    let before = w.confirm_snapshot(&release);
    let instruction = w.confirm_instruction(&release);
    let (tx, size) = w.payment_v0(
        &table,
        instruction,
        vec![release_payment, intent],
        confirm_loaded.clone(),
    );
    let meta = w.f.send(tx).unwrap();
    assert!(meta.compute_units_consumed < u64::from(COMPUTE_UNIT_LIMIT));
    w.assert_confirmed(&release, &before, &meta);
    println!(
        "confirm_payment (Release) v0: {size} bytes, {} CU",
        meta.compute_units_consumed
    );

    // The fiat repay: every pool slot is the inline Thetis id.
    let args = w.repay_args(payment, THIRTY_K);
    let before = w.repay_snapshot(&args);
    let instruction = w.repay_instruction(&args);
    let (tx, size) = w.payment_v0(
        &table,
        instruction,
        vec![payment],
        vec![w.f.protocol, w.facility, w.authority_of(Lender), w.lender],
    );
    let meta = w.f.send(tx).unwrap();
    assert!(meta.compute_units_consumed < u64::from(COMPUTE_UNIT_LIMIT));
    w.assert_repaid(&args, &before, &meta);
    println!("repay v0: {size} bytes, {} CU", meta.compute_units_consumed);

    // A Correction of the consumed repayment: the new record and its target are inline.
    let correction = w.correction(3, payment);
    let correction_payment = w.payment_key(w.lender, &correction.payment_id);
    let before = w.confirm_snapshot(&correction);
    let instruction = w.confirm_instruction(&correction);
    let (tx, size) = w.payment_v0(
        &table,
        instruction,
        vec![correction_payment, payment],
        confirm_loaded,
    );
    let meta = w.f.send(tx).unwrap();
    assert!(meta.compute_units_consumed < u64::from(COMPUTE_UNIT_LIMIT));
    w.assert_confirmed(&correction, &before, &meta);
    println!(
        "confirm_payment (Correction) v0: {size} bytes, {} CU",
        meta.compute_units_consumed
    );
}

// ----------------------------------------------------------------- apply_payment ----

#[test]
fn apply_payment_splits_interest_then_principal() {
    let application =
        |applied, from_interest, from_principal, surplus, principal, booked| PaymentApplication {
            applied,
            from_interest,
            from_principal,
            surplus,
            principal,
            booked_interest: booked,
        };
    let max = u64::MAX;
    for ((principal, interest_now, received), expected) in [
        // USD210,000 after a year: all the interest, then principal.
        (
            (60_000_000, ONE_YEAR_INTEREST, TWO_TEN_K),
            application(21_000_000, 7_200_000, 13_800_000, 0, 46_200_000, 0),
        ),
        // USD30,000: interest only, some left.
        (
            (60_000_000, ONE_YEAR_INTEREST, THIRTY_K),
            application(3_000_000, 3_000_000, 0, 0, 60_000_000, 4_200_000),
        ),
        // Exactly the debt.
        (
            (60_000_000, ONE_YEAR_INTEREST, 67_200_000),
            application(67_200_000, 7_200_000, 60_000_000, 0, 0, 0),
        ),
        // USD700,000 against USD600,000.
        (
            (60_000_000, 0, SEVEN_HUNDRED_K),
            application(60_000_000, 0, 60_000_000, 10_000_000, 0, 0),
        ),
        // Zero debt: everything is surplus.
        ((0, 0, 1), application(0, 0, 0, 1, 0, 0)),
        // Nothing received.
        (
            (60_000_000, ONE_YEAR_INTEREST, 0),
            application(0, 0, 0, 0, 60_000_000, 7_200_000),
        ),
        // Bounds.
        ((max, 0, max), application(max, 0, max, 0, 0, 0)),
        ((0, max, max), application(max, max, 0, 0, 0, 0)),
        ((max - 1, 1, 1), application(1, 1, 0, 0, max - 1, 0)),
        ((max - 1, 1, max), application(max, 1, max - 1, 0, 0, 0)),
    ] {
        assert_eq!(
            apply_payment(principal, interest_now, received).unwrap(),
            expected,
            "({principal}, {interest_now}, {received})"
        );
    }
}

#[test]
fn apply_payment_conserves_payment_and_debt() {
    // The accrual parity generator: an LCG modulo 2^64, output `state >> 16`.
    let mut state: u64 = 0x4d59_5df4_d0f3_3173;
    let mut next = || {
        state = state
            .wrapping_mul(6_364_136_223_846_793_005)
            .wrapping_add(1_442_695_040_888_963_407);
        state >> 16
    };
    for sample in 0..256 {
        let principal = next();
        let interest_now = next();
        // Alternate between under- and overpayment of the (48-bit) debt.
        let received = if sample % 2 == 0 {
            next() % (principal + interest_now + 1)
        } else {
            principal + interest_now + next()
        };
        let debt = principal + interest_now;
        let result = apply_payment(principal, interest_now, received).unwrap();
        assert_eq!(result.applied, debt.min(received), "sample {sample}");
        assert_eq!(result.applied + result.surplus, received);
        assert_eq!(result.from_interest + result.from_principal, result.applied);
        assert_eq!(result.principal, principal - result.from_principal);
        assert_eq!(result.booked_interest, interest_now - result.from_interest);
        assert_eq!(
            result.principal + result.booked_interest,
            debt - result.applied
        );
        // Interest first: principal is touched only once the interest is paid.
        if result.from_principal > 0 {
            assert_eq!(result.booked_interest, 0);
        }
        // A surplus only once the whole debt is paid.
        if result.surplus > 0 {
            assert_eq!((result.principal, result.booked_interest), (0, 0));
        }
    }
}

#[test]
fn apply_payment_matches_domain_release_fixtures() {
    for row in release_examples() {
        let name = row["name"].as_str().unwrap();
        // Phase 2 has no fees.
        assert_eq!(fixture_u64(&row, "input", "bookedFees"), 0, "{name}");
        let principal = fixture_u64(&row, "input", "principal");
        let interest = fixture_u64(&row, "input", "bookedInterest");
        let received =
            fixture_u64(&row, "input", "buyerAmount") + fixture_u64(&row, "input", "sellerTopUp");
        assert_eq!(
            principal + interest,
            fixture_u64(&row, "expected", "debtBefore"),
            "{name}"
        );
        assert_eq!(
            received,
            fixture_u64(&row, "expected", "confirmedPayment"),
            "{name}"
        );

        let result = apply_payment(principal, interest, received).unwrap();

        assert_eq!(
            result.applied,
            fixture_u64(&row, "expected", "applied"),
            "{name}"
        );
        assert_eq!(
            result.surplus,
            fixture_u64(&row, "expected", "sellerSurplus"),
            "{name}"
        );
        assert_eq!(
            result.principal + result.booked_interest,
            fixture_u64(&row, "expected", "debtAfter"),
            "{name}"
        );
    }
}

#[test]
fn apply_payment_refuses_debt_over_u64() {
    for (principal, interest_now, received) in [
        (u64::MAX, 1, 0),
        (u64::MAX, 1, u64::MAX),
        (1, u64::MAX, 1),
        (u64::MAX, u64::MAX, u64::MAX),
    ] {
        refused(
            apply_payment(principal, interest_now, received),
            ArithmeticOverflow,
        );
    }
    // The largest debt that fits is accepted.
    let result = apply_payment(u64::MAX, 0, 1).unwrap();
    assert_eq!(result.principal, u64::MAX - 1);
}
