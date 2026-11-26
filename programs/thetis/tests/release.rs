//! Fiat-mode `create_release_intent` and `sell_pledged` tests. The seller signs the release intent (PS, `PLEDGE`); the lender records the buyer's
//! bank payment with `confirm_payment` (TX, `LEND`); the buyer signs the acceptance at execution
//! (PS, `BUY`). The sale moves the units to the buyer, applies the payment interest first, records
//! any surplus, and is refused when the remaining debt would exceed the limit on the remaining
//! collateral.
//!
//! Demo money: USD cents, 20 c/kg, haircut 0, LTV 60%, a USD600,000 advance on the 5,000 t lot
//! CR-0001, at 1,200 bps simple interest; sales of 2,000 t for USD400,000, USD210,000 (with and
//! without the USD30,000 top-up) and the USD700,000 overpayment, the domain fixtures, and the
//! bounds 0, 1 and `u64::MAX`. The demo cast is synthetic. Facility ids, payment identities,
//! digests, site codes, nonces and expiries are deterministic synthetic test inputs.

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
    intent::message::{
        advance_message, buy_pledged_message, issue_message, pledge_message, release_intent_message,
    },
    state::*,
    ID,
};

const TOKEN_2022: Pubkey = anchor_spl::token_2022::ID;
const ASSOCIATED_TOKEN: Pubkey = anchor_spl::associated_token::ID;
const INSTRUCTIONS_SYSVAR: Pubkey = solana_sdk_ids::sysvar::instructions::ID;
const COMPUTE_BUDGET: Pubkey = solana_sdk_ids::compute_budget::ID;
const ED25519: Pubkey = solana_sdk_ids::ed25519_program::ID;
const PACKET_DATA_SIZE: usize = 1232;
const COMPUTE_UNIT_LIMIT: u32 = 400_000;

const DAY: i64 = 86_400;
const YEAR: i64 = 31_536_000;
const HOUR: i64 = 3_600;
const LOT_VALIDITY: i64 = 30 * DAY;
/// The Authorities are delegated, and the valuation is valid, for two years.
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
const FOUR_THOUSAND_T: u64 = 4_000_000;
const THREE_THOUSAND_T: u64 = 3_000_000;
const TWO_THOUSAND_T: u64 = 2_000_000;
const ONE_THOUSAND_T: u64 = 1_000_000;

/// USD600,000: the advance, at the 60% limit on 5,000 t at 20 c/kg.
const LIMIT: u64 = 60_000_000;
/// USD400,000: the 2,000 t sale price.
const FOUR_HUNDRED_K: u64 = 40_000_000;
/// USD210,000.
const TWO_TEN_K: u64 = 21_000_000;
/// USD30,000: the top-up the USD210,000 sale needs.
const THIRTY_K: u64 = 3_000_000;
/// USD700,000: the overpayment.
const SEVEN_HUNDRED_K: u64 = 70_000_000;
const ACCRUAL_DENOMINATOR: u64 = 315_360_000_000;

const OWNER_ID: u8 = 1;
const CUSTODIAN_ID: u8 = 2;
const LENDER_ID: u8 = 7;
const LENDER2_ID: u8 = 8;
const BUYER_ID: u8 = 9;
const BUYER2_ID: u8 = 10;
const OWNER2_ID: u8 = 11;

const OWNER_NAME: &str = "Khunou Ore Exports";
const CUSTODIAN_NAME: &str = "Kopano Stockyard Custody";
const LENDER_NAME: &str = "Lender One Bank";
const LENDER2_NAME: &str = "Lender Two Bank";
const BUYER_NAME: &str = "Buyer Smelter Co";
const BUYER2_NAME: &str = "Second Buyer Smelting Co";
const OWNER2_NAME: &str = "Second Ore Exporters";

/// The release intent's known-answer text: 501 bytes.
const RELEASE_INTENT_TEXT: &str = "Thetis authorisation v1
Network: devnet
Program: jGJpdjtoDUtXMjvc4UaEi1mBeFZKqVfe9jL8ireHMs3
Protocol: 00112233445566778899aabbccddeeff
Action: Create release intent
Lot: CR-0001
Quantity: 2,000.000 t
Seller: Khunou Ore Exports
Buyer: Buyer Smelter Co
Lender: Lender One Bank
Facility: 11111111111111111111111111111111
Loan: 0
Intent: 1
Price: USD 400,000.00
Top-up: USD 0.00
Intent expires: 2026-11-20 16:32:05 SAST
Revision: 1
Valid until: 2026-11-19 16:32:05 SAST
Test network only. Synthetic data.";

/// The buyer acceptance's known-answer text: 459 bytes.
const BUYER_ACCEPTANCE_TEXT: &str = "Thetis authorisation v1
Network: devnet
Program: jGJpdjtoDUtXMjvc4UaEi1mBeFZKqVfe9jL8ireHMs3
Protocol: 00112233445566778899aabbccddeeff
Action: Buy pledged receipts
Lot: CR-0001
Quantity: 2,000.000 t
Seller: Khunou Ore Exports
Buyer: Buyer Smelter Co
Lender: Lender One Bank
Facility: 11111111111111111111111111111111
Loan: 0
Intent: 1
Price: USD 400,000.00
Top-up: USD 0.00
Revision: 1
Valid until: 2026-11-19 16:32:05 SAST
Test network only. Synthetic data.";

/// A deterministic synthetic payment identity: 32 bytes of `n`.
fn payment_id(n: u8) -> [u8; 32] {
    [n; 32]
}

/// One `create_release_intent` call, with every input a test may vary.
#[derive(Clone)]
struct IntentArgs {
    nonce: u64,
    quantity_kg: u64,
    price: u64,
    top_up: u64,
    expires_at: i64,
    expected_revision: u64,
    valid_until: i64,
    /// The wallet whose Authority signs as the seller.
    seller: Actor,
    seller_org: Pubkey,
    buyer_org: Pubkey,
    lender_org: Pubkey,
    facility: Pubkey,
    loan: Pubkey,
    lock: Pubkey,
    lot: Pubkey,
    position: Pubkey,
}

/// One `sell_pledged` call. The other accounts follow from the stored intent and its loan.
#[derive(Clone)]
struct SellArgs {
    intent: Pubkey,
    payment: Pubkey,
    expected_revision: u64,
    valid_until: i64,
    /// The wallet whose Authority signs as the buyer.
    buyer: Actor,
    buyer_org: Pubkey,
}

/// A second stored lot, CR-0002 (5,000 t), held by the same owner at the same site: 2,000 t
/// pledged to Lender One Bank as its loan 1, and 3,000 t to Lender Two Bank's own facility as
/// that facility's loan 0 (copied from `tests/payment.rs`).
struct SecondLot {
    lot: Pubkey,
    position: Pubkey,
    lender_one_loan: Pubkey,
}

/// A fiat-mode protocol with the stored chrome lot CR-0001 (5,000 t) held by Khunou Ore
/// Exports, Lender One Bank's facility to it with a fresh 20 c/kg valuation, part or all of the
/// lot pledged as loan 0, and Buyer Smelter Co holding a `BUY` Authority.
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
    /// Every (lot, position) that exists, buyer positions included, for the invariants.
    positions: Vec<(Pubkey, Pubkey)>,
    /// Every lock the world created, for the invariants.
    locks: Vec<Pubkey>,
    /// Every payment attestation the world created, for the invariants.
    payments: Vec<Pubkey>,
    /// Every release intent the world created, for the invariants.
    intents: Vec<Pubkey>,
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

fn sha256_hex(bytes: &[u8]) -> String {
    solana_sha256_hasher::hash(bytes)
        .to_bytes()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
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

fn release_example(name: &str) -> serde_json::Value {
    release_examples()
        .into_iter()
        .find(|row| row["name"] == name)
        .unwrap_or_else(|| panic!("fixture {name}"))
}

impl World {
    /// The demo: the whole lot pledged as loan 0 and USD600,000 advanced at `NOW`.
    fn demo() -> Self {
        let mut world = Self::build(LOT_KG);
        world.advance_demo();
        world
    }

    /// The world with `pledged_kg` of CR-0001 pledged as loan 0 and nothing advanced.
    fn build(pledged_kg: u64) -> Self {
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
            (buyer, Buyer, scope::BUY),
        ] {
            let delegate = f.delegate(OrgAdmin, org, f.key(wallet), scopes, expires_at);
            f.ok(delegate, OrgAdmin);
        }

        let facility = Self::facility_key(&f, lender, FACILITY_ONE);
        let loan = Self::loan_key(facility, 0);
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
            positions: Vec::new(),
            locks: Vec::new(),
            payments: Vec::new(),
            intents: Vec::new(),
        };
        world.open_facility(Lender, lender, FACILITY_ONE);
        world.valuation = world.set_valuation(NOW + VALUATION_VALIDITY);
        let (lot, position) = world.issue_lot(LOT_ID, INTAKE_DIGEST);
        world.lot = lot;
        world.position = position;
        let pledged = world.pledge(lot, LOT_ID, position, Lender, facility, 0, pledged_kg, 0);
        assert_eq!(pledged, loan);
        world
    }

    fn facility_key(f: &Fixture, lender_org: Pubkey, facility_id: [u8; 16]) -> Pubkey {
        pda(&[
            b"facility",
            f.protocol.as_ref(),
            lender_org.as_ref(),
            &facility_id,
        ])
    }

    fn loan_key(facility: Pubkey, index: u32) -> Pubkey {
        pda(&[b"loan", facility.as_ref(), &index.to_le_bytes()])
    }

    fn intent_key(loan: Pubkey, nonce: u64) -> (Pubkey, u8) {
        Pubkey::find_program_address(&[b"release", loan.as_ref(), &nonce.to_le_bytes()], &ID)
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

    fn position_key(lot: Pubkey, owner: Pubkey) -> Pubkey {
        pda(&[b"position", lot.as_ref(), owner.as_ref()])
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

    fn display_name(&self, organisation: Pubkey) -> String {
        self.f.read::<Organisation>(organisation).display_name
    }

    // ------------------------------------------------------------------- set-up ----

    /// A USD facility to Khunou Ore Exports at 1,200 bps and 60%, through `open_facility`.
    fn open_facility(&mut self, signer: Actor, lender_org: Pubkey, facility_id: [u8; 16]) {
        let facility = Self::facility_key(&self.f, lender_org, facility_id);
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
        let position = Self::position_key(lot, self.owner);
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
        let lender_name = self.display_name(lender_org);
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
        assert_eq!(loan.revision, 1);
        self.assert_invariants();
    }

    /// Issues CR-0002 and pledges it: 2,000 t to Lender One Bank (its loan 1) and 3,000 t to
    /// Lender Two Bank's own facility (that facility's loan 0).
    fn add_second_lot(&mut self) -> SecondLot {
        let (lot, position) = self.issue_lot(SECOND_LOT_ID, SECOND_INTAKE_DIGEST);
        let lender2 = self.lender2;
        self.open_facility(Lender2, lender2, FACILITY_TWO);
        let lender_two_facility = Self::facility_key(&self.f, lender2, FACILITY_TWO);
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
        self.pledge(
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
            lot,
            position,
            lender_one_loan,
        }
    }

    /// A second Buyer organisation, with its own canonical `BUY` Authority for `Buyer2`.
    fn second_buyer(&mut self) -> Pubkey {
        let buyer2 = accredit(&mut self.f, BUYER2_ID, Role::Buyer, BUYER2_NAME);
        let delegate = self.f.delegate(
            OrgAdmin,
            buyer2,
            self.f.key(Buyer2),
            scope::BUY,
            NOW + AUTHORITY_LIFETIME,
        );
        self.f.ok(delegate, OrgAdmin);
        buyer2
    }

    /// A second Exporter organisation, not the borrower, with its own canonical `PLEDGE`
    /// Authority for `Owner2`.
    fn second_exporter(&mut self) -> Pubkey {
        let owner2 = accredit(&mut self.f, OWNER2_ID, Role::Exporter, OWNER2_NAME);
        let delegate = self.f.delegate(
            OrgAdmin,
            owner2,
            self.f.key(Owner2),
            scope::PLEDGE,
            NOW + AUTHORITY_LIFETIME,
        );
        self.f.ok(delegate, OrgAdmin);
        owner2
    }

    // ----------------------------------------------------------------- payments ----

    fn payment_key(&self, lender_org: Pubkey, payment_id: &[u8; 32]) -> Pubkey {
        pda(&[
            b"payment",
            self.f.protocol.as_ref(),
            lender_org.as_ref(),
            payment_id,
        ])
    }

    /// A real `confirm_payment` by Lender One Bank on `loan` of its facility. Returns the
    /// record's address.
    fn confirm(
        &mut self,
        id: u8,
        purpose: PaymentPurpose,
        loan: Pubkey,
        subject: Pubkey,
        target: Option<Pubkey>,
        amount: u64,
    ) -> Pubkey {
        let payment = self.payment_key(self.lender, &payment_id(id));
        let confirm = ix(
            accounts::ConfirmPayment {
                lender: self.f.key(Lender),
                payer: self.f.payer(),
                protocol: self.f.protocol,
                authority: self.authority_of(Lender),
                lender_org: self.lender,
                facility: self.facility,
                loan,
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
        self.f.signed_ok(&[confirm], Lender);
        self.payments.push(payment);
        payment
    }

    /// A Release payment of `amount` naming `intent`, on the intent's loan.
    fn confirm_release(&mut self, id: u8, intent: Pubkey, amount: u64) -> Pubkey {
        let loan = self.f.read::<ReleaseIntent>(intent).loan;
        let payment = self.confirm(id, PaymentPurpose::Release, loan, intent, None, amount);
        let record: PaymentAttestation = self.f.read(payment);
        assert_eq!(record.status, PaymentStatus::Unconsumed);
        assert_eq!(record.subject, intent);
        payment
    }

    /// A Repayment of `amount` on loan 0.
    fn confirm_repayment(&mut self, id: u8, amount: u64) -> Pubkey {
        let loan = self.loan;
        self.confirm(id, PaymentPurpose::Repayment, loan, loan, None, amount)
    }

    /// A Correction naming `target`, on the target's loan.
    fn correct(&mut self, id: u8, target: Pubkey) -> Pubkey {
        let loan = self.f.read::<PaymentAttestation>(target).loan;
        self.confirm(
            id,
            PaymentPurpose::Correction,
            loan,
            target,
            Some(target),
            0,
        )
    }

    /// The fiat `repay` of `payment` on loan 0 by Lender One Bank.
    fn repay(&mut self, payment: Pubkey, amount: u64) {
        let repay = ix(
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
        );
        self.f.signed_ok(&[repay], Lender);
        assert_eq!(
            self.f.read::<PaymentAttestation>(payment).status,
            PaymentStatus::Consumed
        );
    }

    // ----------------------------------------------------------- release intent ----

    /// The default intent on loan 0: nonce 1, 2,000 t at USD400,000, no top-up, expiring a day
    /// from now, signed by the owner at the position's current revision.
    fn intent_args(&self) -> IntentArgs {
        IntentArgs {
            nonce: 1,
            quantity_kg: TWO_THOUSAND_T,
            price: FOUR_HUNDRED_K,
            top_up: 0,
            expires_at: self.now + DAY,
            expected_revision: self.f.read::<Position>(self.position).revision,
            valid_until: self.now + MONEY_WINDOW,
            seller: Owner,
            seller_org: self.owner,
            buyer_org: self.buyer,
            lender_org: self.lender,
            facility: self.facility,
            loan: self.loan,
            lock: self.lock,
            lot: self.lot,
            position: self.position,
        }
    }

    /// The default intent on another loan of the owner's.
    fn intent_args_for(&self, loan: Pubkey) -> IntentArgs {
        let stored: Loan = self.f.read(loan);
        IntentArgs {
            expected_revision: self.f.read::<Position>(stored.position).revision,
            facility: stored.facility,
            lender_org: self.f.read::<Facility>(stored.facility).lender,
            loan,
            lock: pda(&[b"lock", loan.as_ref()]),
            lot: stored.lot,
            position: stored.position,
            ..self.intent_args()
        }
    }

    /// The text the program builds for `args` from the accounts it is given.
    fn intent_text(&self, args: &IntentArgs) -> Vec<u8> {
        let facility: Facility = self.f.read(args.facility);
        let loan: Loan = self.f.read(args.loan);
        let lot: Lot = self.f.read(args.lot);
        release_intent_message(
            &ID,
            &INSTANCE,
            &lot.lot_id,
            args.quantity_kg,
            &self.display_name(args.seller_org),
            &self.display_name(args.buyer_org),
            &self.display_name(args.lender_org),
            &facility.facility_id,
            loan.index,
            args.nonce,
            args.price,
            args.top_up,
            &facility.currency,
            facility.currency_decimals,
            args.expires_at,
            args.expected_revision,
            args.valid_until,
        )
    }

    fn create_instruction(&self, args: &IntentArgs) -> Instruction {
        ix(
            accounts::CreateReleaseIntent {
                sponsor: self.f.payer(),
                protocol: self.f.protocol,
                seller_org: args.seller_org,
                seller_authority: self.authority_of(args.seller),
                buyer_org: args.buyer_org,
                lender_org: args.lender_org,
                facility: args.facility,
                loan: args.loan,
                lock: args.lock,
                lot: args.lot,
                position: args.position,
                intent: Self::intent_key(args.loan, args.nonce).0,
                instructions: INSTRUCTIONS_SYSVAR,
                system_program: SYSTEM,
            },
            instruction::CreateReleaseIntent {
                nonce: args.nonce,
                quantity_kg: args.quantity_kg,
                price: args.price,
                top_up: args.top_up,
                expires_at: args.expires_at,
                expected_revision: args.expected_revision,
                valid_until: args.valid_until,
            },
        )
    }

    /// The seller's Ed25519 entry over `text`, then the instruction.
    fn create_signed(&self, args: &IntentArgs, text: &[u8]) -> [Instruction; 2] {
        let verify = ed25519_instruction(&[(self.f.signer(args.seller), text)]);
        [verify, self.create_instruction(args)]
    }

    fn create_instructions(&self, args: &IntentArgs) -> [Instruction; 2] {
        self.create_signed(args, &self.intent_text(args))
    }

    /// Accounts a successful `create_release_intent` must leave byte for byte unchanged.
    fn create_untouched(&self, args: &IntentArgs) -> Vec<(Pubkey, Option<RawAccount>)> {
        let mut keys = self.collateral();
        keys.extend([
            args.seller_org,
            args.buyer_org,
            args.lender_org,
            args.facility,
            args.loan,
            args.lock,
            args.lot,
            args.position,
            self.authority_of(args.seller),
        ]);
        keys.into_iter()
            .map(|key| (key, self.f.raw_account(key)))
            .collect()
    }

    /// Sends the intent and checks every stored field, its size, that nothing else changed,
    /// the one event and the invariants.
    fn create_ok(&mut self, args: &IntentArgs) -> (Pubkey, TransactionMetadata) {
        let untouched = self.create_untouched(args);
        let instructions = self.create_instructions(args);
        let tx = self.f.sponsored_ok(&instructions);
        let intent = self.assert_created(args, &untouched, &tx);
        (intent, tx)
    }

    fn assert_created(
        &mut self,
        args: &IntentArgs,
        untouched: &[(Pubkey, Option<RawAccount>)],
        tx: &TransactionMetadata,
    ) -> Pubkey {
        let (intent, bump) = Self::intent_key(args.loan, args.nonce);
        let position: Position = self.f.read(args.position);
        let expected = ReleaseIntent {
            protocol: self.f.protocol,
            loan: args.loan,
            lot: args.lot,
            position: args.position,
            seller: args.seller_org,
            buyer: args.buyer_org,
            nonce: args.nonce,
            quantity_kg: args.quantity_kg,
            price: args.price,
            top_up: args.top_up,
            currency: USD,
            expires_at: args.expires_at,
            position_revision: position.revision,
            status: IntentStatus::Open,
            bump,
        };
        let stored: ReleaseIntent = self.f.read(intent);
        assert_eq!(serialized(&stored), serialized(&expected));
        assert_eq!(position.revision, args.expected_revision);
        // 8 + 245 bytes.
        assert_eq!(self.f.owner_and_data_len(intent), Some((ID, 253)));
        for (key, account) in untouched {
            assert_eq!(&self.f.raw_account(*key), account, "{key} changed");
        }
        assert_event(
            tx,
            events::ReleaseIntentCreated {
                intent,
                loan: args.loan,
                seller: args.seller_org,
                buyer: args.buyer_org,
                quantity_kg: args.quantity_kg,
                price: args.price,
                top_up: args.top_up,
                expires_at: args.expires_at,
            },
        );
        self.intents.push(intent);
        self.assert_invariants();
        intent
    }

    /// `create_release_intent` must fail with `expected`: no intent, no change, no event.
    fn create_refused(&mut self, args: &IntentArgs, expected: ThetisError) {
        let instructions = self.create_instructions(args);
        self.f.sponsored_refused(&instructions, 1, expected);
        let intent = Self::intent_key(args.loan, args.nonce).0;
        assert!(!self.f.account_exists(intent));
    }

    /// Creates the default intent with `price` and `top_up`, and records its exact payment.
    /// Returns (intent, payment).
    fn intent_with_payment(
        &mut self,
        nonce: u64,
        quantity_kg: u64,
        price: u64,
        top_up: u64,
        payment: u8,
    ) -> (Pubkey, Pubkey) {
        let args = IntentArgs {
            nonce,
            quantity_kg,
            price,
            top_up,
            ..self.intent_args()
        };
        let (intent, _) = self.create_ok(&args);
        let payment = self.confirm_release(payment, intent, price + top_up);
        (intent, payment)
    }

    // ------------------------------------------------------------- sell_pledged ----

    /// The sale of `intent` with `payment`, accepted by Buyer Smelter Co at the intent's revision.
    fn sell_args(&self, intent: Pubkey, payment: Pubkey) -> SellArgs {
        let stored: ReleaseIntent = self.f.read(intent);
        SellArgs {
            intent,
            payment,
            expected_revision: stored.position_revision,
            valid_until: self.now + MONEY_WINDOW,
            buyer: Buyer,
            buyer_org: stored.buyer,
        }
    }

    fn sell_accounts(&self, args: &SellArgs) -> accounts::SellPledged {
        let intent: ReleaseIntent = self.f.read(args.intent);
        let loan: Loan = self.f.read(intent.loan);
        let facility: Facility = self.f.read(loan.facility);
        let buyer_position = Self::position_key(intent.lot, args.buyer_org);
        accounts::SellPledged {
            sponsor: self.f.payer(),
            protocol: self.f.protocol,
            facility: loan.facility,
            lender_org: facility.lender,
            loan: intent.loan,
            lock: pda(&[b"lock", intent.loan.as_ref()]),
            valuation: self.valuation,
            intent: args.intent,
            payment: args.payment,
            lot: intent.lot,
            mint: Self::mint(intent.lot),
            seller_org: intent.seller,
            buyer_org: args.buyer_org,
            buyer_authority: self.authority_of(args.buyer),
            seller_position: intent.position,
            seller_vault_authority: Self::vault_authority(intent.position),
            seller_vault: Self::vault(intent.lot, intent.position),
            buyer_position,
            buyer_vault_authority: Self::vault_authority(buyer_position),
            buyer_vault: Self::vault(intent.lot, buyer_position),
            instructions: INSTRUCTIONS_SYSVAR,
            token_program: TOKEN_2022,
            associated_token_program: ASSOCIATED_TOKEN,
            system_program: SYSTEM,
        }
    }

    /// The buyer acceptance the program builds for `args` from the accounts it is given.
    fn sell_text(&self, args: &SellArgs) -> Vec<u8> {
        let intent: ReleaseIntent = self.f.read(args.intent);
        let loan: Loan = self.f.read(intent.loan);
        let facility: Facility = self.f.read(loan.facility);
        let lot: Lot = self.f.read(intent.lot);
        buy_pledged_message(
            &ID,
            &INSTANCE,
            &lot.lot_id,
            intent.quantity_kg,
            &self.display_name(intent.seller),
            &self.display_name(args.buyer_org),
            &self.display_name(facility.lender),
            &facility.facility_id,
            loan.index,
            intent.nonce,
            intent.price,
            intent.top_up,
            &facility.currency,
            facility.currency_decimals,
            args.expected_revision,
            args.valid_until,
        )
    }

    fn sell_instruction(&self, args: &SellArgs) -> Instruction {
        ix(
            self.sell_accounts(args),
            instruction::SellPledged {
                expected_revision: args.expected_revision,
                valid_until: args.valid_until,
            },
        )
    }

    fn sell_signed(&self, args: &SellArgs, text: &[u8]) -> [Instruction; 2] {
        let verify = ed25519_instruction(&[(self.f.signer(args.buyer), text)]);
        [verify, self.sell_instruction(args)]
    }

    fn sell_instructions(&self, args: &SellArgs) -> [Instruction; 2] {
        self.sell_signed(args, &self.sell_text(args))
    }

    /// Accounts a successful sale must leave byte for byte unchanged.
    fn sell_untouched(&self, args: &SellArgs) -> Vec<(Pubkey, Option<RawAccount>)> {
        let intent: ReleaseIntent = self.f.read(args.intent);
        let changed = [
            intent.loan,
            pda(&[b"lock", intent.loan.as_ref()]),
            intent.lot,
            intent.position,
            Self::vault(intent.lot, intent.position),
            Self::position_key(intent.lot, args.buyer_org),
            Self::vault(intent.lot, Self::position_key(intent.lot, args.buyer_org)),
        ];
        let mut keys = self.collateral();
        keys.extend([
            self.facility,
            self.authority_of(args.buyer),
            args.buyer_org,
            Self::mint(intent.lot),
        ]);
        keys.into_iter()
            .filter(|key| !changed.contains(key))
            .map(|key| (key, self.f.raw_account(key)))
            .collect()
    }

    /// Sends the sale and checks every changed account against values computed independently
    /// in the test, that nothing else changed, the one event and the invariants.
    fn sell_ok(&mut self, args: &SellArgs) -> TransactionMetadata {
        let instructions = self.sell_instructions(args);
        self.sell_ok_with(args, &instructions)
    }

    fn sell_ok_with(
        &mut self,
        args: &SellArgs,
        instructions: &[Instruction],
    ) -> TransactionMetadata {
        let before = SaleSnapshot::take(self, args);
        let untouched = self.sell_untouched(args);
        let tx = self.f.sponsored_ok(instructions);
        self.assert_sold(args, &before, &untouched, &tx);
        tx
    }

    fn assert_sold(
        &mut self,
        args: &SellArgs,
        before: &SaleSnapshot,
        untouched: &[(Pubkey, Option<RawAccount>)],
        tx: &TransactionMetadata,
    ) {
        let intent = &before.intent;
        let q = intent.quantity_kg;
        let old = &before.loan;
        assert_eq!(
            u128::from(before.payment.amount),
            u128::from(intent.price) + u128::from(intent.top_up)
        );

        // The loan: accrual to now, then interest first, then principal.
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
        assert_eq!(
            serialized(&self.f.read::<Loan>(intent.loan)),
            serialized(&loan)
        );

        let mut lock = before.lock.clone();
        lock.quantity_kg -= q;
        let lock_key = pda(&[b"lock", intent.loan.as_ref()]);
        assert_eq!(
            serialized(&self.f.read::<LockAllocation>(lock_key)),
            serialized(&lock)
        );

        let mut seller = before.seller_position.clone();
        seller.quantity_kg -= q;
        seller.locked_kg -= q;
        seller.revision += 1;
        assert_eq!(
            serialized(&self.f.read::<Position>(intent.position)),
            serialized(&seller)
        );

        let buyer_key = Self::position_key(intent.lot, args.buyer_org);
        let buyer = match &before.buyer_position {
            Some(existing) => {
                let mut buyer = existing.clone();
                buyer.quantity_kg += q;
                buyer.revision += 1;
                buyer
            }
            None => Position {
                protocol: self.f.protocol,
                lot: intent.lot,
                owner: args.buyer_org,
                quantity_kg: q,
                locked_kg: 0,
                reserved_kg: 0,
                revision: 0,
                bump: Pubkey::find_program_address(
                    &[b"position", intent.lot.as_ref(), args.buyer_org.as_ref()],
                    &ID,
                )
                .1,
            },
        };
        assert_eq!(
            serialized(&self.f.read::<Position>(buyer_key)),
            serialized(&buyer)
        );

        let mut lot = before.lot.clone();
        lot.revision += 1;
        assert_eq!(
            serialized(&self.f.read::<Lot>(intent.lot)),
            serialized(&lot)
        );

        let mut executed = intent.clone();
        executed.status = IntentStatus::Executed;
        assert_eq!(
            serialized(&self.f.read::<ReleaseIntent>(args.intent)),
            serialized(&executed)
        );

        let mut payment = before.payment.clone();
        payment.status = PaymentStatus::Consumed;
        payment.applied = applied;
        payment.surplus = surplus;
        assert_eq!(
            serialized(&self.f.read::<PaymentAttestation>(args.payment)),
            serialized(&payment)
        );

        // The units moved vault to vault; supply is untouched.
        let seller_vault = Self::vault(intent.lot, intent.position);
        let buyer_vault = Self::vault(intent.lot, buyer_key);
        assert_eq!(self.f.token_amount(seller_vault), before.seller_vault - q);
        assert_eq!(self.f.token_amount(buyer_vault), before.buyer_vault + q);
        assert_eq!(
            self.f.mint_supply(Self::mint(intent.lot)),
            before.mint_supply
        );
        assert_eq!(lot.supply_kg, before.lot.supply_kg);

        for (key, account) in untouched {
            assert_eq!(&self.f.raw_account(*key), account, "{key} changed");
        }
        assert_event(
            tx,
            events::PledgedSold {
                intent: args.intent,
                loan: intent.loan,
                payment: args.payment,
                lot: intent.lot,
                seller_position: intent.position,
                buyer_position: buyer_key,
                quantity_kg: q,
                applied,
                surplus,
                principal: loan.principal,
                booked_interest: loan.booked_interest,
                lot_revision: lot.revision,
                revision: loan.revision,
            },
        );
        if !self.positions.contains(&(intent.lot, buyer_key)) {
            self.positions.push((intent.lot, buyer_key));
        }
        self.assert_invariants();
    }

    /// `sell_pledged` must fail with `expected`, with no state change and no event.
    fn sell_refused(&mut self, args: &SellArgs, expected: ThetisError) {
        let instructions = self.sell_instructions(args);
        self.f.sponsored_refused(&instructions, 1, expected);
        self.assert_invariants();
    }

    // ------------------------------------------------------------- invariants ----

    /// Accounts no release action changes: identity, policy and the valuation.
    fn collateral(&self) -> Vec<Pubkey> {
        vec![
            self.f.protocol,
            self.owner,
            self.custodian,
            self.lender,
            self.lender2,
            self.buyer,
            self.authority_of(Owner),
            self.authority_of(Lender),
            self.authority_of(Buyer),
            self.class_policy,
            self.custodian_class,
            self.valuation,
        ]
    }

    /// Invariants: each lot's supply equals the sum of its positions, the mint's supply and
    /// each vault's balance; each position's `locked_kg` is the sum of its open locks and fits;
    /// control follows status; the remainder is below one minor unit; each payment is consumed at
    /// most once with `applied + surplus == amount`; an executed intent's payment is consumed.
    fn assert_invariants(&self) {
        let f = &self.f;
        let mut lots: Vec<Pubkey> = self.positions.iter().map(|(lot, _)| *lot).collect();
        lots.sort();
        lots.dedup();
        for lot_key in lots {
            let lot: Lot = f.read(lot_key);
            let held: u64 = self
                .positions
                .iter()
                .filter(|(lot, _)| *lot == lot_key)
                .map(|(_, position)| f.read::<Position>(*position).quantity_kg)
                .sum();
            assert_eq!(held, lot.supply_kg);
            assert_eq!(f.mint_supply(Self::mint(lot_key)), lot.supply_kg);
        }
        for (lot_key, position_key) in &self.positions {
            let position: Position = f.read(*position_key);
            assert_eq!(position.lot, *lot_key);
            assert_eq!(
                f.token_amount(Self::vault(*lot_key, *position_key)),
                position.quantity_kg
            );
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
        }
        for intent_key in &self.intents {
            let intent: ReleaseIntent = f.read(*intent_key);
            assert!(intent.quantity_kg > 0 && intent.price > 0);
            if intent.status == IntentStatus::Executed {
                let consumed = self.payments.iter().any(|payment| {
                    let payment: PaymentAttestation = f.read(*payment);
                    payment.purpose == PaymentPurpose::Release
                        && payment.subject == *intent_key
                        && payment.status == PaymentStatus::Consumed
                });
                assert!(
                    consumed,
                    "executed intent {intent_key} has no consumed payment"
                );
            }
        }
    }

    // --------------------------------------------------------------- v0 shape ----

    /// Compiles `instructions` as the relay sends them (v0, the lookup table, a compute-budget
    /// instruction, signed by the sponsor only) and asserts the inline keys, the loaded writable
    /// and readonly sets, and that the transaction fits one packet. Returns it and its size.
    fn release_v0(
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
}

/// What a sale may change, read before it runs.
struct SaleSnapshot {
    intent: ReleaseIntent,
    loan: Loan,
    lock: LockAllocation,
    payment: PaymentAttestation,
    lot: Lot,
    seller_position: Position,
    buyer_position: Option<Position>,
    seller_vault: u64,
    buyer_vault: u64,
    mint_supply: u64,
}

impl SaleSnapshot {
    fn take(w: &World, args: &SellArgs) -> Self {
        let intent: ReleaseIntent = w.f.read(args.intent);
        let buyer_key = World::position_key(intent.lot, args.buyer_org);
        let buyer_vault = World::vault(intent.lot, buyer_key);
        Self {
            loan: w.f.read(intent.loan),
            lock: w.f.read(pda(&[b"lock", intent.loan.as_ref()])),
            payment: w.f.read(args.payment),
            lot: w.f.read(intent.lot),
            seller_position: w.f.read(intent.position),
            buyer_position: w.f.account_exists(buyer_key).then(|| w.f.read(buyer_key)),
            seller_vault: w.f.token_amount(World::vault(intent.lot, intent.position)),
            buyer_vault: if w.f.account_exists(buyer_vault) {
                w.f.token_amount(buyer_vault)
            } else {
                0
            },
            mint_supply: w.f.mint_supply(World::mint(intent.lot)),
            intent,
        }
    }
}

// ------------------------------------------------------------------ sell_pledged ----

#[test]
fn sell_pledged_2000t_400k_leaves_200k_on_3000t() {
    let mut w = World::demo();
    let row = release_example("sale-2000t-400k");
    let (intent, payment) = w.intent_with_payment(1, TWO_THOUSAND_T, FOUR_HUNDRED_K, 0, 1);

    let tx = w.sell_ok(&w.sell_args(intent, payment));

    // A07: USD200,000 left on the 3,000 t still locked, which allows at most USD360,000.
    let loan: Loan = w.f.read(w.loan);
    assert_eq!(loan.principal, 20_000_000);
    assert_eq!(loan.booked_interest, 0);
    assert_eq!(
        loan.principal + loan.booked_interest,
        fixture_u64(&row, "expected", "debtAfter")
    );
    assert_eq!(loan.revision, 2);
    assert_eq!(loan.status, LoanStatus::Active);
    let lock: LockAllocation = w.f.read(w.lock);
    assert_eq!(lock.quantity_kg, 3_000_000);
    assert_eq!(
        lock.quantity_kg,
        fixture_u64(&row, "expected", "quantityAfter")
    );
    assert_eq!(lock.control, LockControl::Pledged);
    let seller: Position = w.f.read(w.position);
    assert_eq!(
        (seller.quantity_kg, seller.locked_kg, seller.revision),
        (3_000_000, 3_000_000, 2)
    );
    let buyer_position = World::position_key(w.lot, w.buyer);
    let buyer: Position = w.f.read(buyer_position);
    assert_eq!(buyer.owner, w.buyer);
    assert_eq!(
        (buyer.quantity_kg, buyer.locked_kg, buyer.reserved_kg),
        (2_000_000, 0, 0)
    );
    assert_eq!(buyer.revision, 0);
    assert_eq!(
        w.f.token_amount(World::vault(w.lot, buyer_position)),
        2_000_000
    );
    assert_eq!(w.f.token_amount(World::vault(w.lot, w.position)), 3_000_000);
    let lot: Lot = w.f.read(w.lot);
    assert_eq!(lot.supply_kg, LOT_KG);
    assert_eq!(lot.revision, 1);
    let record: PaymentAttestation = w.f.read(payment);
    assert_eq!(record.status, PaymentStatus::Consumed);
    assert_eq!((record.applied, record.surplus), (40_000_000, 0));
    assert_eq!(
        w.f.read::<ReleaseIntent>(intent).status,
        IntentStatus::Executed
    );
    assert_event(
        &tx,
        events::PledgedSold {
            intent,
            loan: w.loan,
            payment,
            lot: w.lot,
            seller_position: w.position,
            buyer_position,
            quantity_kg: 2_000_000,
            applied: 40_000_000,
            surplus: 0,
            principal: 20_000_000,
            booked_interest: 0,
            lot_revision: 1,
            revision: 2,
        },
    );

    // A second sale to the same buyer reuses its position: 1,000 t at USD210,000 clears the
    // USD200,000 left, with USD10,000 surplus, and 2,000 t stay locked.
    let (second, second_payment) = w.intent_with_payment(2, ONE_THOUSAND_T, TWO_TEN_K, 0, 2);
    assert_eq!(w.f.read::<ReleaseIntent>(second).position_revision, 2);
    w.sell_ok(&w.sell_args(second, second_payment));
    let loan: Loan = w.f.read(w.loan);
    assert_eq!(
        (loan.principal, loan.booked_interest, loan.revision),
        (0, 0, 3)
    );
    assert_eq!(w.f.read::<LockAllocation>(w.lock).quantity_kg, 2_000_000);
    let buyer: Position = w.f.read(buyer_position);
    assert_eq!((buyer.quantity_kg, buyer.revision), (3_000_000, 1));
    let record: PaymentAttestation = w.f.read(second_payment);
    assert_eq!((record.applied, record.surplus), (20_000_000, 1_000_000));
    assert_eq!(w.f.read::<Lot>(w.lot).revision, 2);
}

#[test]
fn sell_pledged_210k_without_topup_refused() {
    let mut w = World::demo();
    let row = release_example("sale-2000t-210k-refused");
    assert!(!row["expected"]["allowed"].as_bool().unwrap());
    // USD390,000 would be left on 3,000 t, whose limit is USD360,000 (A07).
    let (intent, payment) = w.intent_with_payment(1, TWO_THOUSAND_T, TWO_TEN_K, 0, 1);

    w.sell_refused(&w.sell_args(intent, payment), ResidualOverLimit);

    // The money stays unresolved and the intent open.
    let record: PaymentAttestation = w.f.read(payment);
    assert_eq!(record.status, PaymentStatus::Unconsumed);
    assert_eq!((record.applied, record.surplus), (0, 0));
    assert_eq!(w.f.read::<ReleaseIntent>(intent).status, IntentStatus::Open);
    assert_eq!(w.f.read::<Loan>(w.loan).principal, LIMIT);
    assert!(!w.f.account_exists(World::position_key(w.lot, w.buyer)));
}

#[test]
fn sell_pledged_210k_with_30k_topup_succeeds() {
    let mut w = World::demo();
    let row = release_example("sale-2000t-210k-topup-30k");
    assert_eq!(fixture_u64(&row, "input", "sellerTopUp"), THIRTY_K);
    // The seller tops up USD30,000, so exactly USD360,000 is left on 3,000 t (A07).
    let (intent, payment) = w.intent_with_payment(1, TWO_THOUSAND_T, TWO_TEN_K, THIRTY_K, 1);
    assert_eq!(w.f.read::<PaymentAttestation>(payment).amount, 24_000_000);

    w.sell_ok(&w.sell_args(intent, payment));

    let loan: Loan = w.f.read(w.loan);
    assert_eq!(loan.principal, 36_000_000);
    assert_eq!(
        loan.principal,
        fixture_u64(&row, "expected", "limitAfter"),
        "the residual sits exactly at the limit"
    );
    let record: PaymentAttestation = w.f.read(payment);
    assert_eq!((record.applied, record.surplus), (24_000_000, 0));
    assert_eq!(w.f.read::<LockAllocation>(w.lock).quantity_kg, 3_000_000);
}

#[test]
fn sell_pledged_overpay_records_surplus() {
    let mut w = World::demo();
    // 2,000 t at USD700,000 against USD600,000 of debt.
    let (intent, payment) = w.intent_with_payment(1, TWO_THOUSAND_T, SEVEN_HUNDRED_K, 0, 1);

    let tx = w.sell_ok(&w.sell_args(intent, payment));

    let loan: Loan = w.f.read(w.loan);
    assert_eq!((loan.principal, loan.booked_interest), (0, 0));
    // A sale never closes the loan; the remaining 3,000 t stay locked.
    assert_eq!(loan.status, LoanStatus::Active);
    assert_eq!(w.f.read::<LockAllocation>(w.lock).quantity_kg, 3_000_000);
    assert_eq!(w.f.read::<Position>(w.position).locked_kg, 3_000_000);
    let record: PaymentAttestation = w.f.read(payment);
    assert_eq!(record.status, PaymentStatus::Consumed);
    assert_eq!((record.applied, record.surplus), (60_000_000, 10_000_000));
    assert_event(
        &tx,
        events::PledgedSold {
            intent,
            loan: w.loan,
            payment,
            lot: w.lot,
            seller_position: w.position,
            buyer_position: World::position_key(w.lot, w.buyer),
            quantity_kg: 2_000_000,
            applied: 60_000_000,
            surplus: 10_000_000,
            principal: 0,
            booked_interest: 0,
            lot_revision: 1,
            revision: 2,
        },
    );
}

#[test]
fn sell_pledged_matches_preview_release_for_every_fixture() {
    let rows = release_examples();
    assert_eq!(rows.len(), 4);
    for row in rows {
        let name = row["name"].as_str().unwrap();
        let mut w = World::demo();
        // The demo is each row's input: the clock is fixed, so booked interest is 0.
        let loan: Loan = w.f.read(w.loan);
        let lock: LockAllocation = w.f.read(w.lock);
        let valuation: Valuation = w.f.read(w.valuation);
        let facility: Facility = w.f.read(w.facility);
        assert_eq!(
            fixture_u64(&row, "input", "principal"),
            loan.principal,
            "{name}"
        );
        assert_eq!(
            fixture_u64(&row, "input", "bookedInterest"),
            loan.booked_interest,
            "{name}"
        );
        assert_eq!(fixture_u64(&row, "input", "bookedFees"), 0, "{name}");
        assert_eq!(
            fixture_u64(&row, "input", "lockedQuantity"),
            lock.quantity_kg,
            "{name}"
        );
        assert_eq!(
            fixture_u64(&row, "input", "valuePerUnit"),
            valuation.value_per_kg,
            "{name}"
        );
        assert_eq!(
            fixture_u64(&row, "input", "haircutBps"),
            u64::from(valuation.haircut_bps),
            "{name}"
        );
        assert_eq!(
            fixture_u64(&row, "input", "maxLtvBps"),
            u64::from(facility.max_ltv_bps),
            "{name}"
        );

        let quantity = fixture_u64(&row, "input", "soldLockedQuantity");
        let price = fixture_u64(&row, "input", "buyerAmount");
        let top_up = fixture_u64(&row, "input", "sellerTopUp");
        let (intent, payment) = w.intent_with_payment(1, quantity, price, top_up, 1);
        assert_eq!(
            w.f.read::<PaymentAttestation>(payment).amount,
            fixture_u64(&row, "expected", "confirmedPayment"),
            "{name}"
        );

        let args = w.sell_args(intent, payment);
        if row["expected"]["allowed"].as_bool().unwrap() {
            w.sell_ok(&args);
            let loan: Loan = w.f.read(w.loan);
            assert_eq!(
                loan.principal + loan.booked_interest,
                fixture_u64(&row, "expected", "debtAfter"),
                "{name}"
            );
            assert_eq!(
                w.f.read::<LockAllocation>(w.lock).quantity_kg,
                fixture_u64(&row, "expected", "quantityAfter"),
                "{name}"
            );
            let record: PaymentAttestation = w.f.read(payment);
            assert_eq!(
                record.applied,
                fixture_u64(&row, "expected", "applied"),
                "{name}"
            );
            assert_eq!(
                record.surplus,
                fixture_u64(&row, "expected", "sellerSurplus"),
                "{name}"
            );
        } else {
            w.sell_refused(&args, ResidualOverLimit);
            assert_eq!(
                w.f.read::<PaymentAttestation>(payment).status,
                PaymentStatus::Unconsumed,
                "{name}"
            );
            assert_eq!(
                w.f.read::<ReleaseIntent>(intent).status,
                IntentStatus::Open,
                "{name}"
            );
        }
    }
}

#[test]
fn sell_pledged_rejects_wrong_buyer() {
    let mut w = World::demo();
    let buyer2 = w.second_buyer();
    let (intent, payment) = w.intent_with_payment(1, TWO_THOUSAND_T, FOUR_HUNDRED_K, 0, 1);
    let demo = w.sell_args(intent, payment);
    let stored: Authority = w.f.read(w.authority_of(Buyer2));
    assert_eq!(stored.organisation, buyer2);
    assert_ne!(stored.scopes & scope::BUY, 0);
    // A06: each case signs the text the program would build for the accounts it names.
    for args in [
        // The second buyer, with its own organisation and canonical BUY Authority.
        SellArgs {
            buyer: Buyer2,
            buyer_org: buyer2,
            ..demo.clone()
        },
        // The second buyer's Authority naming the intent's buyer organisation.
        SellArgs {
            buyer: Buyer2,
            ..demo.clone()
        },
        // The intent's buyer's Authority naming the second buyer organisation.
        SellArgs {
            buyer_org: buyer2,
            ..demo.clone()
        },
    ] {
        w.sell_refused(&args, WrongOrganisation);
    }
    assert!(!w.f.account_exists(World::position_key(w.lot, buyer2)));

    w.sell_ok(&demo);
}

#[test]
fn sell_pledged_rejects_attestation_for_other_loan() {
    let mut w = World::demo();
    let second = w.add_second_lot();
    // A real intent of Lender One Bank's loan 1 (CR-0002), and its real Release payment.
    let other_args = w.intent_args_for(second.lender_one_loan);
    assert_eq!(other_args.position, second.position);
    assert_eq!(other_args.lot, second.lot);
    let (other_intent, _) = w.create_ok(&other_args);
    let other_payment = w.confirm_release(1, other_intent, FOUR_HUNDRED_K);

    let (intent, payment) = w.intent_with_payment(1, TWO_THOUSAND_T, FOUR_HUNDRED_K, 0, 2);
    w.sell_refused(&w.sell_args(intent, other_payment), PaymentNotBound);

    // One field at a time, on a harness copy of this intent's own payment: the loan, the lender,
    // then the protocol.
    let real: PaymentAttestation = w.f.read(payment);
    let other_protocol = pda(&[b"protocol", &[2; 16]]);
    assert_ne!(other_protocol, w.f.protocol);
    for field in ["loan", "lender", "protocol"] {
        let mut forged = real.clone();
        match field {
            "loan" => forged.loan = second.lender_one_loan,
            "lender" => forged.lender = w.lender2,
            _ => forged.protocol = other_protocol,
        }
        w.f.set_program_account(payment, &forged);
        w.sell_refused(&w.sell_args(intent, payment), PaymentNotBound);
    }
    w.f.set_program_account(payment, &real);

    assert_eq!(
        w.f.read::<PaymentAttestation>(other_payment).status,
        PaymentStatus::Unconsumed
    );
    w.sell_ok(&w.sell_args(intent, payment));
}

#[test]
fn sell_pledged_rejects_repayment_purpose_attestation() {
    let mut w = World::demo();
    let (intent, payment) = w.intent_with_payment(1, TWO_THOUSAND_T, FOUR_HUNDRED_K, 0, 1);
    // A real Repayment of the same amount on the same loan (A06).
    let repayment = w.confirm_repayment(2, FOUR_HUNDRED_K);
    w.sell_refused(&w.sell_args(intent, repayment), PaymentNotBound);

    // The purpose alone: this intent's own payment rewritten to purpose Repayment, still naming
    // the intent, a state no instruction produces.
    let real: PaymentAttestation = w.f.read(payment);
    let mut forged = real.clone();
    forged.purpose = PaymentPurpose::Repayment;
    w.f.set_program_account(payment, &forged);
    w.sell_refused(&w.sell_args(intent, payment), PaymentNotBound);
    w.f.set_program_account(payment, &real);

    assert_eq!(
        w.f.read::<PaymentAttestation>(repayment).status,
        PaymentStatus::Unconsumed
    );
    w.sell_ok(&w.sell_args(intent, payment));
}

#[test]
fn sell_pledged_rejects_attestation_for_other_intent() {
    let mut w = World::demo();
    // Two open intents of the same loan, same terms, each with its own payment.
    let (first, first_payment) = w.intent_with_payment(1, TWO_THOUSAND_T, FOUR_HUNDRED_K, 0, 1);
    let (second, second_payment) = w.intent_with_payment(2, TWO_THOUSAND_T, FOUR_HUNDRED_K, 0, 2);
    assert_eq!(
        w.f.read::<PaymentAttestation>(second_payment).subject,
        second
    );

    w.sell_refused(&w.sell_args(first, second_payment), PaymentNotBound);

    assert_eq!(
        w.f.read::<PaymentAttestation>(second_payment).status,
        PaymentStatus::Unconsumed
    );
    w.sell_ok(&w.sell_args(first, first_payment));
}

#[test]
fn sell_pledged_rejects_amount_not_price_plus_topup() {
    let mut w = World::demo();
    let args = IntentArgs {
        price: TWO_TEN_K,
        top_up: THIRTY_K,
        ..w.intent_args()
    };
    let (intent, _) = w.create_ok(&args);
    // One cent short, one cent over, the price alone and the top-up alone: each is recorded,
    // and none can be consumed (A08).
    let mut wrong = Vec::new();
    for (id, amount) in [
        (1, TWO_TEN_K + THIRTY_K - 1),
        (2, TWO_TEN_K + THIRTY_K + 1),
        (3, TWO_TEN_K),
        (4, THIRTY_K),
    ] {
        let payment = w.confirm_release(id, intent, amount);
        w.sell_refused(&w.sell_args(intent, payment), PaymentNotBound);
        wrong.push(payment);
    }
    for payment in wrong {
        let record: PaymentAttestation = w.f.read(payment);
        assert_eq!(record.status, PaymentStatus::Unconsumed);
        assert_eq!(record.subject, intent);
    }

    let exact = w.confirm_release(5, intent, TWO_TEN_K + THIRTY_K);
    w.sell_ok(&w.sell_args(intent, exact));
}

#[test]
fn sell_pledged_rejects_voided_attestation() {
    let mut w = World::demo();
    let (intent, payment) = w.intent_with_payment(1, TWO_THOUSAND_T, FOUR_HUNDRED_K, 0, 1);
    w.correct(2, payment);
    assert_eq!(
        w.f.read::<PaymentAttestation>(payment).status,
        PaymentStatus::Voided
    );

    w.sell_refused(&w.sell_args(intent, payment), PaymentConsumed);

    assert_eq!(
        w.f.read::<PaymentAttestation>(payment).status,
        PaymentStatus::Voided
    );
    assert_eq!(w.f.read::<ReleaseIntent>(intent).status, IntentStatus::Open);
    // A fresh payment for the same intent is still accepted.
    let fresh = w.confirm_release(3, intent, FOUR_HUNDRED_K);
    w.sell_ok(&w.sell_args(intent, fresh));
}

#[test]
fn sell_pledged_expired_intent_leaves_payment_unresolved() {
    let mut w = World::demo();
    let (intent, payment) = w.intent_with_payment(1, TWO_THOUSAND_T, FOUR_HUNDRED_K, 0, 1);
    let expires_at = w.f.read::<ReleaseIntent>(intent).expires_at;
    assert_eq!(expires_at, NOW + DAY);

    // At exactly `expires_at` the intent has expired (A08).
    w.advance_to(expires_at);
    w.sell_refused(&w.sell_args(intent, payment), IntentExpired);

    let record: PaymentAttestation = w.f.read(payment);
    assert_eq!(record.status, PaymentStatus::Unconsumed);
    assert_eq!(record.subject, intent);
    assert_eq!(record.loan, w.loan);
    assert_eq!(record.purpose, PaymentPurpose::Release);
    assert_eq!((record.applied, record.surplus), (0, 0));
    assert_eq!(w.f.read::<ReleaseIntent>(intent).status, IntentStatus::Open);

    // One second earlier, in a fresh demo, the same sale goes through, with a day's accrual.
    let mut w = World::demo();
    let (intent, payment) = w.intent_with_payment(1, TWO_THOUSAND_T, FOUR_HUNDRED_K, 0, 1);
    w.advance_to(expires_at - 1);
    w.sell_ok(&w.sell_args(intent, payment));
    // The day's interest is paid first, so it reappears as principal left.
    let (interest, _) = expected_accrual(LIMIT, RATE_BPS, DAY - 1, 0);
    assert!(interest > 0);
    let loan: Loan = w.f.read(w.loan);
    assert_eq!(loan.accrued_at, expires_at - 1);
    assert_eq!(loan.booked_interest, 0);
    assert_eq!(loan.principal, LIMIT - FOUR_HUNDRED_K + interest);
}

#[test]
fn sell_pledged_rejects_executed_intent() {
    let mut w = World::demo();
    let (intent, payment) = w.intent_with_payment(1, TWO_THOUSAND_T, FOUR_HUNDRED_K, 0, 1);
    let args = w.sell_args(intent, payment);
    let instructions = w.sell_instructions(&args);
    w.sell_ok_with(&args, &instructions);

    // The same instructions again, with a new blockhash: the status is checked before the
    // revisions and the payment.
    w.f.sponsored_refused(&instructions, 1, IntentNotOpen);
    // Re-signed at the position's new revision: still not open.
    let resigned = SellArgs {
        expected_revision: w.f.read::<Position>(w.position).revision,
        ..args
    };
    w.sell_refused(&resigned, IntentNotOpen);
}

#[test]
fn sell_pledged_rejects_stale_valuation() {
    let mut w = World::demo();
    let (intent, payment) = w.intent_with_payment(1, TWO_THOUSAND_T, FOUR_HUNDRED_K, 0, 1);
    // The lender shortens the valuation to an hour, then the clock passes it.
    let valid_until = w.now + HOUR;
    w.set_valuation(valid_until);
    w.advance_to(valid_until + 1);

    w.sell_refused(&w.sell_args(intent, payment), ValuationStale);

    // A refreshed valuation lets the same sale through.
    let refreshed = w.now + YEAR;
    w.set_valuation(refreshed);
    w.sell_ok(&w.sell_args(intent, payment));
}

#[test]
fn sell_pledged_rejects_stale_position_revision() {
    // 4,000 t pledged as loan 0, an intent at position revision 1, then a second
    // pledge of the free 1,000 t as loan 1 moves the position to revision 2.
    let mut w = World::build(FOUR_THOUSAND_T);
    let (intent, payment) = w.intent_with_payment(1, TWO_THOUSAND_T, FOUR_HUNDRED_K, 0, 1);
    assert_eq!(w.f.read::<ReleaseIntent>(intent).position_revision, 1);
    let (lot, position, facility) = (w.lot, w.position, w.facility);
    w.pledge(
        lot,
        LOT_ID,
        position,
        Lender,
        facility,
        1,
        ONE_THOUSAND_T,
        1,
    );
    assert_eq!(w.f.read::<Position>(w.position).revision, 2);

    // At the position's revision: the intent's is older.
    let current = SellArgs {
        expected_revision: 2,
        ..w.sell_args(intent, payment)
    };
    w.sell_refused(&current, StaleRevision);
    // At the intent's revision: the position has moved.
    let signed = SellArgs {
        expected_revision: 1,
        ..w.sell_args(intent, payment)
    };
    w.sell_refused(&signed, StaleRevision);

    assert_eq!(
        w.f.read::<PaymentAttestation>(payment).status,
        PaymentStatus::Unconsumed
    );
    assert_eq!(w.f.read::<ReleaseIntent>(intent).status, IntentStatus::Open);
}

#[test]
fn sell_pledged_rejects_loan_under_exception() {
    // A completed sale whose Release payment is then corrected (A09): the buyer keeps the units,
    // nothing is rewound, and the loan takes no new intent.
    let mut w = World::demo();
    let (intent, payment) = w.intent_with_payment(1, TWO_THOUSAND_T, FOUR_HUNDRED_K, 0, 1);
    w.sell_ok(&w.sell_args(intent, payment));
    let buyer_position = World::position_key(w.lot, w.buyer);
    let kept: Vec<_> = [
        payment,
        intent,
        w.lock,
        w.lot,
        w.position,
        buyer_position,
        World::vault(w.lot, w.position),
        World::vault(w.lot, buyer_position),
        World::mint(w.lot),
    ]
    .into_iter()
    .map(|key| (key, w.f.raw_account(key)))
    .collect();
    let loan_before: Loan = w.f.read(w.loan);
    w.correct(2, payment);
    for (key, account) in &kept {
        assert_eq!(&w.f.raw_account(*key), account, "{key} changed");
    }
    let loan: Loan = w.f.read(w.loan);
    assert_eq!(loan.open_exceptions, 1);
    assert_eq!(loan.revision, loan_before.revision + 1);
    assert_eq!(
        (loan.principal, loan.booked_interest),
        (loan_before.principal, loan_before.booked_interest)
    );
    assert_eq!(w.f.read::<Position>(buyer_position).quantity_kg, 2_000_000);
    let blocked = IntentArgs {
        nonce: 2,
        quantity_kg: ONE_THOUSAND_T,
        ..w.intent_args()
    };
    w.create_refused(&blocked, LoanUnderException);

    // An open intent with its payment, then a repayment consumed and corrected: the sale is
    // refused while the exception is open.
    let mut w = World::demo();
    let (intent, payment) = w.intent_with_payment(1, TWO_THOUSAND_T, FOUR_HUNDRED_K, 0, 1);
    let repayment = w.confirm_repayment(2, THIRTY_K);
    w.repay(repayment, THIRTY_K);
    w.correct(3, repayment);
    let loan: Loan = w.f.read(w.loan);
    assert_eq!(loan.open_exceptions, 1);
    assert_eq!(loan.principal, LIMIT - THIRTY_K);

    w.sell_refused(&w.sell_args(intent, payment), LoanUnderException);
    assert_eq!(
        w.f.read::<PaymentAttestation>(payment).status,
        PaymentStatus::Unconsumed
    );
}

// --------------------------------------------------------- create_release_intent ----

#[test]
fn create_release_intent_rejects_quantity_over_locked() {
    let mut w = World::demo();
    let demo = w.intent_args();
    w.create_refused(
        &IntentArgs {
            quantity_kg: LOT_KG + 1,
            ..demo.clone()
        },
        InsufficientLocked,
    );
    w.create_refused(
        &IntentArgs {
            quantity_kg: 0,
            ..demo.clone()
        },
        ZeroQuantity,
    );

    // The whole lock is accepted; no quantity is reserved by an intent.
    let (intent, _) = w.create_ok(&IntentArgs {
        quantity_kg: LOT_KG,
        ..demo
    });
    assert_eq!(w.f.read::<ReleaseIntent>(intent).quantity_kg, LOT_KG);
    let position: Position = w.f.read(w.position);
    assert_eq!((position.reserved_kg, position.revision), (0, 1));
}

#[test]
fn create_release_intent_rejects_buyer_not_approved() {
    let mut w = World::demo();
    let demo = w.intent_args();
    // A buyer organisation of another protocol, written by the harness.
    let foreign_protocol = pda(&[b"protocol", &[2; 16]]);
    let foreign = pda(&[b"org", foreign_protocol.as_ref(), &[12; 16]]);
    let organisation = Organisation {
        protocol: foreign_protocol,
        org_id: [12; 16],
        role: Role::Buyer,
        display_name: "Foreign Buyer Smelting Co".into(),
        admin: w.f.key(OrgAdmin),
        related: Vec::new(),
        bump: 255,
    };
    w.f.set_program_account(foreign, &organisation);
    // Not a Buyer: a lender, the custodian and the seller itself; then a Buyer of another
    // protocol.
    for buyer_org in [w.lender2, w.custodian, w.owner, foreign] {
        w.create_refused(
            &IntentArgs {
                buyer_org,
                ..demo.clone()
            },
            RecipientNotApproved,
        );
    }

    w.create_ok(&demo);
}

#[test]
fn create_release_intent_rejects_non_borrower_seller() {
    let mut w = World::demo();
    let owner2 = w.second_exporter();
    let demo = w.intent_args();
    // Each is the wrong organisation, never the wrong role.
    for args in [
        // Another Exporter, with its own organisation and canonical PLEDGE Authority.
        IntentArgs {
            seller: Owner2,
            seller_org: owner2,
            ..demo.clone()
        },
        // A Lender organisation and its own Authority as the seller.
        IntentArgs {
            seller: Lender2,
            seller_org: w.lender2,
            ..demo.clone()
        },
        // The borrower's Authority naming another Exporter organisation.
        IntentArgs {
            seller_org: owner2,
            ..demo.clone()
        },
        // The other Exporter's Authority naming the borrower organisation.
        IntentArgs {
            seller: Owner2,
            ..demo.clone()
        },
    ] {
        w.create_refused(&args, WrongOrganisation);
    }

    w.create_ok(&demo);
}

#[test]
fn create_release_intent_rejects_past_expiry_and_zero_price() {
    let mut w = World::demo();
    let demo = w.intent_args();
    for args in [
        IntentArgs {
            price: 0,
            ..demo.clone()
        },
        IntentArgs {
            expires_at: w.now,
            ..demo.clone()
        },
        IntentArgs {
            expires_at: w.now - 1,
            ..demo.clone()
        },
    ] {
        w.create_refused(&args, InvalidField);
    }

    // One second in the future is accepted; there is no policy ceiling.
    let (intent, _) = w.create_ok(&IntentArgs {
        expires_at: w.now + 1,
        ..demo.clone()
    });
    assert_eq!(w.f.read::<ReleaseIntent>(intent).expires_at, NOW + 1);
    w.create_ok(&IntentArgs {
        nonce: 2,
        expires_at: i64::MAX,
        ..demo
    });
}

#[test]
fn create_release_intent_rejects_unpayable_total() {
    let mut w = World::demo();
    let demo = w.intent_args();
    for (price, top_up) in [(u64::MAX, 1), (1, u64::MAX), (u64::MAX, u64::MAX)] {
        w.create_refused(
            &IntentArgs {
                price,
                top_up,
                ..demo.clone()
            },
            ArithmeticOverflow,
        );
    }

    // A total of exactly u64::MAX is payable.
    let (intent, _) = w.create_ok(&IntentArgs {
        price: u64::MAX,
        top_up: 0,
        ..demo
    });
    assert_eq!(w.f.read::<ReleaseIntent>(intent).price, u64::MAX);
}

#[test]
fn create_release_intent_rejects_window_301() {
    let mut w = World::demo();
    let demo = w.intent_args();
    w.create_refused(
        &IntentArgs {
            valid_until: w.now + 301,
            ..demo.clone()
        },
        WindowTooLong,
    );
    w.create_refused(
        &IntentArgs {
            valid_until: w.now - 1,
            ..demo.clone()
        },
        Expired,
    );

    w.create_ok(&IntentArgs {
        valid_until: w.now + 300,
        ..demo
    });
}

// ------------------------------------------------------------------ signed texts ----

#[test]
fn release_messages_known_answers() {
    assert_eq!(
        ID.to_string(),
        "jGJpdjtoDUtXMjvc4UaEi1mBeFZKqVfe9jL8ireHMs3"
    );
    let instance: [u8; 16] = core::array::from_fn(|index| index as u8 * 0x11);
    assert_eq!(instance[15], 0xff);

    let intent = release_intent_message(
        &ID,
        &instance,
        "CR-0001",
        2_000_000,
        "Khunou Ore Exports",
        "Buyer Smelter Co",
        "Lender One Bank",
        &FACILITY_ONE,
        0,
        1,
        40_000_000,
        0,
        &USD,
        2,
        1_795_185_125,
        1,
        1_795_098_725,
    );
    assert_eq!(
        String::from_utf8(intent.clone()).unwrap(),
        RELEASE_INTENT_TEXT
    );
    assert_eq!(intent.len(), 501);
    assert_eq!(
        sha256_hex(&intent),
        "98efb3cb89d6b5779b3453d68f9b105fa3777903c3cb5822e3e466cca44bb469"
    );

    let acceptance = buy_pledged_message(
        &ID,
        &instance,
        "CR-0001",
        2_000_000,
        "Khunou Ore Exports",
        "Buyer Smelter Co",
        "Lender One Bank",
        &FACILITY_ONE,
        0,
        1,
        40_000_000,
        0,
        &USD,
        2,
        1,
        1_795_098_725,
    );
    assert_eq!(
        String::from_utf8(acceptance.clone()).unwrap(),
        BUYER_ACCEPTANCE_TEXT
    );
    assert_eq!(acceptance.len(), 459);
    assert_eq!(
        sha256_hex(&acceptance),
        "579c76287e3112388fdf5e21882e8e56c05ee535a032762705753a0fbd8ce656"
    );
}

// -------------------------------------------------------------- transaction size ----

/// Three distinct 48-byte names and a 16-byte lot id.
const WIDEST_SELLER: &str = "Khunou Ore Exports And Allied Holdings Pty Ltd 1";
const WIDEST_BUYER: &str = "Buyer Smelter Co And Allied Smelting Holdings Lt";
const WIDEST_LENDER: &str = "Lender One Bank And Allied Trade Finance Pty Ltd";
const WIDEST_LOT_ID: &str = "CR-0001-WIDEST-1";

fn assert_widest_names() {
    for name in [WIDEST_SELLER, WIDEST_BUYER, WIDEST_LENDER] {
        assert_eq!(name.len(), MAX_DISPLAY_NAME);
    }
    assert_ne!(WIDEST_SELLER, WIDEST_BUYER);
    assert_ne!(WIDEST_SELLER, WIDEST_LENDER);
    assert_ne!(WIDEST_BUYER, WIDEST_LENDER);
    assert_eq!(WIDEST_LOT_ID.len(), MAX_LOT_ID);
}

#[test]
fn create_release_intent_size_fits_v0_widest() {
    let mut w = World::demo();
    let demo = w.intent_args();
    let widest = IntentArgs {
        nonce: u64::MAX,
        quantity_kg: u64::MAX,
        price: u64::MAX,
        top_up: u64::MAX,
        expires_at: i64::MAX,
        expected_revision: u64::MAX,
        valid_until: i64::MAX,
        ..demo.clone()
    };
    let demo_intent = World::intent_key(w.loan, demo.nonce).0;
    let widest_intent = World::intent_key(w.loan, widest.nonce).0;
    // The relay appends each new intent's PDA before it sends the intent.
    let readonly = vec![
        SYSTEM,
        INSTRUCTIONS_SYSVAR,
        w.f.protocol,
        w.owner,
        w.authority_of(Owner),
        w.buyer,
        w.lender,
        w.facility,
        w.loan,
        w.lock,
        w.lot,
        w.position,
    ];
    let mut addresses = readonly.clone();
    addresses.extend([demo_intent, widest_intent]);
    let table = w.f.create_lookup_table(addresses);
    let inline = vec![w.f.payer(), ID, ED25519, COMPUTE_BUDGET];

    // The demo intent, executed as the relay sends it, within the compute budget.
    let untouched = w.create_untouched(&demo);
    let instructions = w.create_instructions(&demo);
    let (tx, demo_size) = w.release_v0(
        &table,
        instructions,
        inline.clone(),
        vec![demo_intent],
        readonly.clone(),
    );
    let meta =
        w.f.send(tx)
            .unwrap_or_else(|failure| panic!("{:?}\n{}", failure.err, failure.meta.pretty_logs()));
    let units = meta.compute_units_consumed;
    assert!(
        units < u64::from(COMPUTE_UNIT_LIMIT),
        "create_release_intent used {units} compute units"
    );
    w.assert_created(&demo, &untouched, &meta);
    println!("create_release_intent v0 demo: {demo_size} bytes, {units} CU");

    // The widest values serialised only.
    assert_widest_names();
    let text = release_intent_message(
        &ID,
        &INSTANCE,
        WIDEST_LOT_ID,
        u64::MAX,
        WIDEST_SELLER,
        WIDEST_BUYER,
        WIDEST_LENDER,
        &FACILITY_ONE,
        u32::MAX,
        u64::MAX,
        u64::MAX,
        u64::MAX,
        &USD,
        1,
        i64::MAX,
        u64::MAX,
        i64::MAX,
    );
    assert_eq!(text.len(), 725);
    let instructions = w.create_signed(&widest, &text);
    let (_, widest_size) =
        w.release_v0(&table, instructions, inline, vec![widest_intent], readonly);
    println!("create_release_intent v0 widest: {widest_size} bytes");
    assert_eq!(widest_size, 1_209);
}

#[test]
fn sell_pledged_size_fits_v0_widest() {
    let mut w = World::demo();
    let (intent, payment) = w.intent_with_payment(1, TWO_THOUSAND_T, FOUR_HUNDRED_K, 0, 1);
    let buyer_position = World::position_key(w.lot, w.buyer);
    // The relay appends the buyer's position, vault authority and vault before the
    // sale; the payment is inline.
    let writable = vec![
        w.loan,
        w.lock,
        intent,
        w.lot,
        w.position,
        World::vault(w.lot, w.position),
        buyer_position,
        World::vault(w.lot, buyer_position),
    ];
    let readonly = vec![
        SYSTEM,
        INSTRUCTIONS_SYSVAR,
        TOKEN_2022,
        ASSOCIATED_TOKEN,
        w.f.protocol,
        w.facility,
        w.lender,
        w.valuation,
        World::mint(w.lot),
        w.owner,
        w.buyer,
        w.authority_of(Buyer),
        World::vault_authority(w.position),
        World::vault_authority(buyer_position),
    ];
    let mut addresses = readonly.clone();
    addresses.extend(writable.iter().copied());
    let table = w.f.create_lookup_table(addresses);
    let inline = vec![w.f.payer(), ID, ED25519, COMPUTE_BUDGET, payment];

    // The demo sale, executed as the relay sends it, within the compute budget.
    let args = w.sell_args(intent, payment);
    let before = SaleSnapshot::take(&w, &args);
    let untouched = w.sell_untouched(&args);
    let instructions = w.sell_instructions(&args);
    let (tx, demo_size) = w.release_v0(
        &table,
        instructions,
        inline.clone(),
        writable.clone(),
        readonly.clone(),
    );
    let meta =
        w.f.send(tx)
            .unwrap_or_else(|failure| panic!("{:?}\n{}", failure.err, failure.meta.pretty_logs()));
    let units = meta.compute_units_consumed;
    assert!(
        units < u64::from(COMPUTE_UNIT_LIMIT),
        "sell_pledged used {units} compute units"
    );
    w.assert_sold(&args, &before, &untouched, &meta);
    println!("sell_pledged v0 demo: {demo_size} bytes, {units} CU");

    // The widest values serialised only, over the same accounts.
    assert_widest_names();
    let text = buy_pledged_message(
        &ID,
        &INSTANCE,
        WIDEST_LOT_ID,
        u64::MAX,
        WIDEST_SELLER,
        WIDEST_BUYER,
        WIDEST_LENDER,
        &FACILITY_ONE,
        u32::MAX,
        u64::MAX,
        u64::MAX,
        u64::MAX,
        &USD,
        1,
        u64::MAX,
        i64::MAX,
    );
    assert_eq!(text.len(), 675);
    let widest = SellArgs {
        expected_revision: u64::MAX,
        valid_until: i64::MAX,
        ..args
    };
    let instructions = w.sell_signed(&widest, &text);
    let (_, widest_size) = w.release_v0(&table, instructions, inline, writable, readonly);
    println!("sell_pledged v0 widest: {widest_size} bytes");
    assert_eq!(widest_size, 1_170);
}

#[test]
fn sell_pledged_rejects_currency_mismatch() {
    let mut w = World::demo();
    let (intent, payment) = w.intent_with_payment(1, TWO_THOUSAND_T, FOUR_HUNDRED_K, 0, 1);
    let eur = *b"EUR";
    assert_ne!(eur, USD);

    // A harness-written Release payment, as payment.rs writes its records: this intent's own
    // payment with only the currency changed, a state no instruction produces. The amount,
    // loan, lender, purpose and subject all still bind, so the currency is the single fault.
    let real: PaymentAttestation = w.f.read(payment);
    let mut forged = real.clone();
    forged.currency = eur;
    w.f.set_program_account(payment, &forged);
    let before = w.f.raw_account(payment);
    w.sell_refused(&w.sell_args(intent, payment), CurrencyMismatch);

    // Nothing changed: the payment is still unconsumed, the intent open, the loan untouched.
    assert_eq!(w.f.raw_account(payment), before);
    let record: PaymentAttestation = w.f.read(payment);
    assert_eq!(record.status, PaymentStatus::Unconsumed);
    assert_eq!((record.applied, record.surplus), (0, 0));
    assert_eq!(w.f.read::<ReleaseIntent>(intent).status, IntentStatus::Open);
    let loan: Loan = w.f.read(w.loan);
    assert_eq!((loan.principal, loan.revision), (LIMIT, 1));
    assert!(!w.f.account_exists(World::position_key(w.lot, w.buyer)));

    // The same check on the intent's own currency, with the real payment.
    w.f.set_program_account(payment, &real);
    let real_intent: ReleaseIntent = w.f.read(intent);
    let mut forged_intent = real_intent.clone();
    forged_intent.currency = eur;
    w.f.set_program_account(intent, &forged_intent);
    w.sell_refused(&w.sell_args(intent, payment), CurrencyMismatch);
    assert_eq!(
        w.f.read::<PaymentAttestation>(payment).status,
        PaymentStatus::Unconsumed
    );

    // With both records as the program wrote them, the sale goes through.
    w.f.set_program_account(intent, &real_intent);
    w.sell_ok(&w.sell_args(intent, payment));
}
