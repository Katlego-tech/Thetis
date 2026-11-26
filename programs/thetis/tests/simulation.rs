//! The simulation adapter: the admin opens one pool per
//! simulation instance with `open_pool`; lenders `deposit` and `withdraw` test tokens against
//! 1:1 shares keyed by their organisation; the borrower signs "Borrow test tokens" and the relay
//! sends `borrow`, which draws only on the facility lender's own deposits; any wallet repays a
//! simulated loan with `repay`, which moves exactly the amount applied.
//!
//! This is a labelled devnet test simulation, never real yield, lending capital or recovery.
//! Demo money is the demo's, at 6 decimals: USD0.20/kg (200,000 per kg), haircut 0, LTV 60%, the
//! 5,000 t lot CR-0001, so the limit is USD600,000 (600,000,000,000), at 1,200 bps simple
//! interest; amounts of USD700,000, USD600,000, USD400,000, USD210,000 and USD30,000, and the
//! figures derived from them. The pool mint is a harness-written SPL Token mint. The
//! demo cast is synthetic; facility ids, digests, site codes and expiries are deterministic
//! synthetic test inputs.

mod common;

use anchor_lang::{
    error::ErrorCode as AnchorError,
    prelude::{pubkey, Pubkey},
};
use anchor_spl::associated_token::{
    get_associated_token_address_with_program_id,
    spl_associated_token_account::instruction::create_associated_token_account_idempotent,
};
use anchor_spl::token::spl_token;
use common::{Actor::*, *};
use litesvm::types::TransactionMetadata;
use solana_message::{AddressLookupTableAccount, VersionedMessage};
use solana_transaction::{versioned::VersionedTransaction, AccountMeta, Instruction};
use thetis::{
    accounts,
    error::ThetisError::{self, *},
    events, instruction,
    intent::message::{borrow_message, issue_message, pledge_message},
    state::*,
    ID,
};

const SPL_TOKEN: Pubkey = anchor_spl::token::ID;
const TOKEN_2022: Pubkey = anchor_spl::token_2022::ID;
const ASSOCIATED_TOKEN: Pubkey = anchor_spl::associated_token::ID;
const INSTRUCTIONS_SYSVAR: Pubkey = solana_sdk_ids::sysvar::instructions::ID;
const ED25519: Pubkey = solana_sdk_ids::ed25519_program::ID;
const COMPUTE_BUDGET: Pubkey = solana_sdk_ids::compute_budget::ID;
const PACKET_DATA_SIZE: usize = 1232;
const COMPUTE_UNIT_LIMIT: u32 = 400_000;

/// The pool mint and the other mints the tests write, at fixed synthetic addresses.
const POOL_MINT: Pubkey = Pubkey::new_from_array([0x4d; 32]);
const OTHER_MINT: Pubkey = Pubkey::new_from_array([0x4e; 32]);
const TOKEN_2022_MINT: Pubkey = Pubkey::new_from_array([0x4f; 32]);
const TEN_DECIMAL_MINT: Pubkey = Pubkey::new_from_array([0x50; 32]);
const NATIVE_MINT: Pubkey = pubkey!("So11111111111111111111111111111111111111112");

const DAY: i64 = 86_400;
/// A fixed 365-day year, the accrual year.
const YEAR: i64 = 31_536_000;
const LOT_VALIDITY: i64 = 30 * DAY;
/// The Authorities are delegated, and the demo valuation is valid, for three years.
const AUTHORITY_LIFETIME: i64 = 3 * YEAR;
const VALUATION_VALIDITY: i64 = 3 * YEAR;
/// The signing window the borrow texts use, inside the 300 s money window.
const MONEY_WINDOW: i64 = 240;
/// The signing window the Phase 1 custody actions use, inside their 600 s window.
const CUSTODY_WINDOW: i64 = 570;

const CLASS_CODE: &str = "CHROME";
const GRADES: [&str; 2] = ["A", "B"];
const SITE_CODE: &str = "PORT-STOCKYARD";
const INTAKE_DIGEST: [u8; 32] = [0x0a; 32];
const SOURCE_DIGEST: [u8; 32] = [0x5e; 32];
const TERMS_DIGEST: [u8; 32] = [0x7d; 32];

const USD: [u8; 3] = *b"USD";
const EUR: [u8; 3] = *b"EUR";
/// The pool mint's decimals: devnet test dollars, as USDC has.
const MICRO: u8 = 6;
const CENTS: u8 = 2;
const RATE_BPS: u16 = 1_200;
const MAX_LTV_BPS: u16 = 6_000;
/// USD0.20/kg at 6 decimals.
const VALUE_PER_KG: u64 = 200_000;
/// Lender One Bank's facility to Khunou Ore Exports.
const FACILITY_ONE: [u8; 16] = [0x11; 16];
/// Lender Two Bank's facility to Khunou Ore Exports.
const FACILITY_TWO: [u8; 16] = [0x22; 16];

const LOT_ID: &str = "CR-0001";
const LOT_KG: u64 = 5_000_000;

/// One US dollar at 6 decimals.
const DOLLAR: u64 = 1_000_000;
/// USD600,000: the limit at 60% on 5,000 t at USD0.20/kg.
const LIMIT: u64 = 600_000 * DOLLAR;
const SEVEN_HUNDRED_K: u64 = 700_000 * DOLLAR;
const FOUR_HUNDRED_K: u64 = 400_000 * DOLLAR;
const TWO_TEN_K: u64 = 210_000 * DOLLAR;
const THIRTY_K: u64 = 30_000 * DOLLAR;
const ACCRUAL_DENOMINATOR: u64 = 315_360_000_000;

const OWNER_ID: u8 = 1;
const CUSTODIAN_ID: u8 = 2;
const LENDER_ID: u8 = 7;
const LENDER2_ID: u8 = 8;

const OWNER_NAME: &str = "Khunou Ore Exports";
const CUSTODIAN_NAME: &str = "Kopano Stockyard Custody";
const LENDER_NAME: &str = "Lender One Bank";
const LENDER2_NAME: &str = "Lender Two Bank";

/// Account sizes, discriminators included.
const POOL_SPACE: usize = 149;
const SHARE_SPACE: usize = 89;

/// The wallets whose pool-mint ATAs the world creates; with the vault they hold the supply.
const WALLETS: [Actor; 5] = [Lender, Lender2, Outsider, LenderTreasury, Owner];

fn accredit(f: &mut Fixture, id: u8, role: Role, name: &str) -> Pubkey {
    let accredit = f.accredit(Accreditor, id, role, name);
    f.ok(accredit, Accreditor);
    f.organisation(id)
}

fn token_account(wallet: Pubkey, mint: Pubkey) -> Pubkey {
    get_associated_token_address_with_program_id(&wallet, &mint, &SPL_TOKEN)
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

/// What a simulated repayment of `offered` must do to the loan at `now`, computed in the test:
/// accrual to now, then interest first and principal after, capped at the debt.
struct ExpectedRepayment {
    applied: u64,
    from_interest: u64,
    from_principal: u64,
    principal: u64,
    booked_interest: u64,
    remainder: u64,
}

fn expected_repayment(loan: &Loan, now: i64, offered: u64) -> ExpectedRepayment {
    let (interest, remainder) = expected_accrual(
        loan.principal,
        loan.rate_bps,
        now - loan.accrued_at,
        loan.accrual_remainder,
    );
    let interest_now = loan.booked_interest + interest;
    let debt = loan.principal + interest_now;
    let applied = debt.min(offered);
    let from_interest = applied.min(interest_now);
    let from_principal = applied - from_interest;
    ExpectedRepayment {
        applied,
        from_interest,
        from_principal,
        principal: loan.principal - from_principal,
        booked_interest: interest_now - from_interest,
        remainder,
    }
}

/// The state a successful pool instruction is checked against afterwards.
struct Before {
    pool: SimulationPool,
    shares: Vec<(Pubkey, Option<PoolShare>)>,
    loan: Option<Loan>,
    balances: Vec<(Pubkey, u64)>,
}

/// The simulation demo: a `DevnetTokenSimulation` protocol; the stored chrome lot
/// CR-0001 (5,000 t) held by Khunou Ore Exports; Lender One Bank (a `LEND | POOL` wallet and a
/// `POOL` treasury wallet) and Lender Two Bank (`LEND | POOL`); the pool on a harness-written
/// 6-decimal SPL Token mint; Lender One's USD facility at 6 decimals with a USD0.20/kg valuation;
/// the whole lot pledged as loan 0; USD700,000 of test tokens each for Lender One, Lender Two and
/// Outsider (a wallet with no Authority).
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
    lot: Pubkey,
    position: Pubkey,
    pool: Pubkey,
    pool_authority: Pubkey,
    pool_vault: Pubkey,
    facility: Pubkey,
    valuation: Pubkey,
    loan: Pubkey,
    lock: Pubkey,
}

impl World {
    /// The demo, with the valuation valid for three years.
    fn demo() -> Self {
        Self::with_valuation_until(NOW + VALUATION_VALIDITY)
    }

    /// The demo, with the valuation valid until `valid_until`.
    fn with_valuation_until(valid_until: i64) -> Self {
        let mut world = Self::before_pool(SettlementMode::DevnetTokenSimulation);
        world.open_pool();
        world.open_lending(valid_until);
        world
    }

    /// An instance in `mode` with the cast, the Authorities, the issued lot and the funded
    /// wallets, but no pool, facility or loan.
    fn before_pool(mode: SettlementMode) -> Self {
        let mut f = Fixture::new();
        let init = f.initialize_instance(INSTANCE, mode, Admin);
        f.ok(init, Admin);
        let register =
            f.register_with_origin(Accreditor, CLASS_CODE, 1, &GRADES, LOT_VALIDITY, false);
        f.ok(register, Accreditor);
        let class_policy = f.class(CLASS_CODE, 1);

        let owner = accredit(&mut f, OWNER_ID, Role::Exporter, OWNER_NAME);
        let custodian = accredit(&mut f, CUSTODIAN_ID, Role::Custodian, CUSTODIAN_NAME);
        let lender = accredit(&mut f, LENDER_ID, Role::Lender, LENDER_NAME);
        let lender2 = accredit(&mut f, LENDER2_ID, Role::Lender, LENDER2_NAME);

        let accredit_site = f.accredit_site(Accreditor, custodian, class_policy, SITE_CODE, LOT_KG);
        f.ok(accredit_site, Accreditor);
        let custodian_class = f.site(custodian, class_policy, SITE_CODE);

        let expires_at = NOW + AUTHORITY_LIFETIME;
        for (org, wallet, scopes) in [
            (custodian, Custodian, scope::ISSUE),
            (owner, Owner, scope::PLEDGE),
            (lender, Lender, scope::LEND | scope::POOL),
            (lender2, Lender2, scope::LEND | scope::POOL),
            (lender, LenderTreasury, scope::POOL),
        ] {
            let delegate = f.delegate(OrgAdmin, org, f.key(wallet), scopes, expires_at);
            f.ok(delegate, OrgAdmin);
        }

        let protocol = f.protocol;
        let pool = pda(&[b"pool", protocol.as_ref()]);
        let pool_authority = pda(&[b"pool_authority", pool.as_ref()]);
        let facility = pda(&[
            b"facility",
            protocol.as_ref(),
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
            lot: Pubkey::default(),
            position: Pubkey::default(),
            pool,
            pool_authority,
            pool_vault: token_account(pool_authority, POOL_MINT),
            facility,
            valuation: Pubkey::default(),
            loan,
            lock,
        };
        world.write_mint(POOL_MINT, SPL_TOKEN, MICRO);
        world.issue_lot();
        world.fund_wallets();
        world
    }

    /// Opens Lender One's facility, sets its valuation and pledges the whole lot as loan 0.
    fn open_lending(&mut self, valuation_until: i64) {
        let open = self.facility_instruction(Lender, self.lender, FACILITY_ONE, USD, MICRO, true);
        self.f.signed_ok(&[open], Lender);
        assert_eq!(
            self.f.read::<Facility>(self.facility).currency_decimals,
            MICRO
        );
        self.valuation = self.set_valuation(valuation_until);
        self.pledge();
    }

    fn advance_to(&mut self, unix_timestamp: i64) {
        self.now = unix_timestamp;
        self.f.set_time(unix_timestamp);
    }

    fn authority_of(&self, actor: Actor) -> Pubkey {
        self.f.authority(self.f.key(actor))
    }

    /// The organisation a wallet acts for.
    fn org_of(&self, actor: Actor) -> Pubkey {
        match actor {
            Lender | LenderTreasury => self.lender,
            Lender2 => self.lender2,
            Owner => self.owner,
            _ => panic!("no organisation for this wallet"),
        }
    }

    /// The wallet's ATA of the pool mint.
    fn ata(&self, actor: Actor) -> Pubkey {
        token_account(self.f.key(actor), POOL_MINT)
    }

    fn share(&self, org: Pubkey) -> Pubkey {
        pda(&[b"pool_share", self.pool.as_ref(), org.as_ref()])
    }

    fn lot_mint(&self) -> Pubkey {
        pda(&[b"mint", self.lot.as_ref()])
    }

    fn lot_vault_authority(&self) -> Pubkey {
        pda(&[b"vault", self.position.as_ref()])
    }

    fn lot_vault(&self) -> Pubkey {
        Pubkey::find_program_address(
            &[
                self.lot_vault_authority().as_ref(),
                TOKEN_2022.as_ref(),
                self.lot_mint().as_ref(),
            ],
            &ASSOCIATED_TOKEN,
        )
        .0
    }

    fn pool_state(&self) -> SimulationPool {
        self.f.read(self.pool)
    }

    fn share_state(&self, org: Pubkey) -> Option<PoolShare> {
        let share = self.share(org);
        self.f.account_exists(share).then(|| self.f.read(share))
    }

    fn loan_state(&self) -> Loan {
        self.f.read(self.loan)
    }

    fn lock_state(&self) -> LockAllocation {
        self.f.read(self.lock)
    }

    fn set_settlement_mode(&mut self, mode: SettlementMode) {
        let mut protocol: Protocol = self.f.read(self.f.protocol);
        protocol.settlement_mode = mode;
        let address = self.f.protocol;
        self.f.set_program_account(address, &protocol);
    }

    // ------------------------------------------------------------------- tokens ----

    /// A harness-written, initialised mint owned by `program`, with the sponsor as its mint
    /// authority and no supply yet.
    fn write_mint(&mut self, address: Pubkey, program: Pubkey, decimals: u8) {
        let data = mint_data(Some(self.f.payer()), 0, decimals);
        self.f.set_foreign_account(address, program, data);
    }

    /// Mints `amount` of `mint` into `account`; the sponsor is the mint authority.
    fn mint_to(&mut self, mint: Pubkey, account: Pubkey, amount: u64) {
        let payer = self.f.payer();
        let mint_to =
            spl_token::instruction::mint_to(&SPL_TOKEN, &mint, &account, &payer, &[], amount)
                .unwrap();
        self.f.sponsored_ok(&[mint_to]);
    }

    /// Creates (idempotently) the ATA of `mint` for `wallet`, paid by the sponsor.
    fn create_token_account(&mut self, wallet: Pubkey, mint: Pubkey) -> Pubkey {
        let payer = self.f.payer();
        let create = create_associated_token_account_idempotent(&payer, &wallet, &mint, &SPL_TOKEN);
        self.f.sponsored_ok(&[create]);
        token_account(wallet, mint)
    }

    /// Every wallet in `WALLETS` gets an ATA of the pool mint; Lender One, Lender Two and
    /// Outsider each get USD700,000.
    fn fund_wallets(&mut self) {
        for actor in WALLETS {
            let wallet = self.f.key(actor);
            self.create_token_account(wallet, POOL_MINT);
        }
        for actor in [Lender, Lender2, Outsider] {
            let account = self.ata(actor);
            self.mint_to(POOL_MINT, account, SEVEN_HUNDRED_K);
        }
    }

    /// A direct SPL Token `TransferChecked` of the pool mint from `actor`'s ATA to `to`,
    /// signed by `actor`: a transfer outside Thetis.
    fn send_tokens(&mut self, actor: Actor, to: Pubkey, amount: u64) {
        let from = self.ata(actor);
        let transfer = spl_token::instruction::transfer_checked(
            &SPL_TOKEN,
            &from,
            &POOL_MINT,
            &to,
            &self.f.key(actor),
            &[],
            amount,
            MICRO,
        )
        .unwrap();
        self.f.signed_ok(&[transfer], actor);
    }

    fn balance(&self, account: Pubkey) -> u64 {
        self.f.token_amount(account)
    }

    // ------------------------------------------------------------------- set-up ----

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
        let mint = self.lot_mint();
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
                vault_authority: self.lot_vault_authority(),
                vault: self.lot_vault(),
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

    /// `open_facility` by `actor` for `lender_org`, at 1,200 bps and 60% to Khunou Ore
    /// Exports, naming the canonical pool when `with_pool`.
    fn facility_instruction(
        &self,
        actor: Actor,
        lender_org: Pubkey,
        facility_id: [u8; 16],
        currency: [u8; 3],
        currency_decimals: u8,
        with_pool: bool,
    ) -> Instruction {
        ix(
            accounts::OpenFacility {
                lender: self.f.key(actor),
                payer: self.f.payer(),
                protocol: self.f.protocol,
                authority: self.authority_of(actor),
                lender_org,
                borrower_org: self.owner,
                facility: pda(&[
                    b"facility",
                    self.f.protocol.as_ref(),
                    lender_org.as_ref(),
                    &facility_id,
                ]),
                pool: with_pool.then_some(self.pool),
                system_program: SYSTEM,
            },
            instruction::OpenFacility {
                facility_id,
                currency,
                currency_decimals,
                terms_version: 1,
                rate_bps: RATE_BPS,
                max_ltv_bps: MAX_LTV_BPS,
                terms_digest: TERMS_DIGEST,
            },
        )
    }

    /// Lender One Bank's valuation of grade A at the lot's site, USD0.20/kg, haircut 0, valid
    /// until `valid_until`.
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
        let loan = self.loan_state();
        assert_eq!(loan.status, LoanStatus::Active);
        assert_eq!((loan.principal, loan.revision), (0, 0));
        assert_eq!(self.lock_state().quantity_kg, LOT_KG);
        self.assert_invariants();
    }

    // ---------------------------------------------------------------- open_pool ----

    /// `open_pool(USD)` naming `mint` and its canonical SPL Token vault, with `admin` in the
    /// admin slot.
    fn open_pool_instruction(&self, admin: Actor, mint: Pubkey) -> Instruction {
        ix(
            accounts::OpenPool {
                admin: self.f.key(admin),
                payer: self.f.payer(),
                protocol: self.f.protocol,
                pool: self.pool,
                pool_authority: self.pool_authority,
                mint,
                pool_vault: token_account(self.pool_authority, mint),
                token_program: SPL_TOKEN,
                associated_token_program: ASSOCIATED_TOKEN,
                system_program: SYSTEM,
            },
            instruction::OpenPool { currency: USD },
        )
    }

    /// The admin opens the pool on the pool mint; every field, the size, the vault and the
    /// event are checked. A balance already in the vault stays unattributed.
    fn open_pool(&mut self) -> TransactionMetadata {
        let prefunded = if self.f.account_exists(self.pool_vault) {
            self.balance(self.pool_vault)
        } else {
            0
        };
        let open = self.open_pool_instruction(Admin, POOL_MINT);
        let tx = self.f.signed_ok(&[open], Admin);
        let pool = self.pool_state();
        assert_eq!(pool.protocol, self.f.protocol);
        assert_eq!(pool.mint, POOL_MINT);
        assert_eq!(pool.vault, self.pool_vault);
        assert_eq!(pool.currency, USD);
        assert_eq!(pool.currency_decimals, MICRO);
        assert_eq!(
            (
                pool.cash_minor,
                pool.total_shares,
                pool.lent_minor,
                pool.income_minor,
                pool.revision
            ),
            (0, 0, 0, 0, 0)
        );
        assert_eq!(
            pool.bump,
            Pubkey::find_program_address(&[b"pool", self.f.protocol.as_ref()], &ID).1
        );
        assert_eq!(self.f.owner_and_data_len(self.pool), Some((ID, POOL_SPACE)));
        // The vault: an SPL Token account of the pool mint owned by the pool authority.
        assert_eq!(self.f.owner(self.pool_vault), Some(SPL_TOKEN));
        let vault = self.f.data(self.pool_vault);
        assert_eq!(&vault[0..32], POOL_MINT.as_ref());
        assert_eq!(&vault[32..64], self.pool_authority.as_ref());
        assert_eq!(self.balance(self.pool_vault), prefunded);
        assert_event(
            &tx,
            events::PoolOpened {
                pool: self.pool,
                mint: POOL_MINT,
                currency: USD,
                currency_decimals: MICRO,
            },
        );
        self.assert_invariants();
        tx
    }

    /// `open_pool` must fail with `expected`, creating neither the pool nor the vault.
    fn open_pool_refused(&mut self, admin: Actor, mint: Pubkey, expected: ThetisError) {
        let open = self.open_pool_instruction(admin, mint);
        self.f.signed_refused(&[open], admin, 0, expected);
        assert!(!self.f.account_exists(self.pool));
        assert!(!self
            .f
            .account_exists(token_account(self.pool_authority, mint)));
    }

    // ---------------------------------------------------------- deposit, withdraw ----

    fn deposit_accounts(&self, actor: Actor) -> accounts::Deposit {
        let org = self.org_of(actor);
        accounts::Deposit {
            depositor: self.f.key(actor),
            payer: self.f.payer(),
            protocol: self.f.protocol,
            authority: self.authority_of(actor),
            depositor_org: org,
            pool: self.pool,
            share: self.share(org),
            depositor_token: self.ata(actor),
            pool_vault: self.pool_vault,
            mint: POOL_MINT,
            token_program: SPL_TOKEN,
            system_program: SYSTEM,
        }
    }

    fn withdraw_accounts(&self, actor: Actor) -> accounts::Withdraw {
        let org = self.org_of(actor);
        accounts::Withdraw {
            depositor: self.f.key(actor),
            protocol: self.f.protocol,
            authority: self.authority_of(actor),
            depositor_org: org,
            pool: self.pool,
            share: self.share(org),
            depositor_token: self.ata(actor),
            pool_authority: self.pool_authority,
            pool_vault: self.pool_vault,
            mint: POOL_MINT,
            token_program: SPL_TOKEN,
        }
    }

    fn deposit_instruction(accounts: accounts::Deposit, amount: u64) -> Instruction {
        ix(accounts, instruction::Deposit { amount })
    }

    fn withdraw_instruction(accounts: accounts::Withdraw, amount: u64) -> Instruction {
        ix(accounts, instruction::Withdraw { amount })
    }

    /// Snapshot of the pool, both lenders' shares, the loan and the pool-mint balances.
    fn before(&self) -> Before {
        let mut balances: Vec<(Pubkey, u64)> = WALLETS
            .iter()
            .map(|actor| (self.ata(*actor), self.balance(self.ata(*actor))))
            .collect();
        balances.push((self.pool_vault, self.balance(self.pool_vault)));
        Before {
            pool: self.pool_state(),
            shares: [self.lender, self.lender2]
                .into_iter()
                .map(|org| (org, self.share_state(org)))
                .collect(),
            loan: self.f.account_exists(self.loan).then(|| self.loan_state()),
            balances,
        }
    }

    /// Asserts every pool-mint balance moved by exactly `deltas` (others unchanged).
    fn assert_balances(&self, before: &Before, deltas: &[(Pubkey, i128)]) {
        for (account, was) in &before.balances {
            let delta = deltas
                .iter()
                .filter(|(key, _)| key == account)
                .map(|(_, delta)| *delta)
                .sum::<i128>();
            assert_eq!(
                i128::from(self.balance(*account)),
                i128::from(*was) + delta,
                "balance of {account}"
            );
        }
    }

    fn share_before(before: &Before, org: Pubkey) -> Option<PoolShare> {
        before
            .shares
            .iter()
            .find(|(key, _)| *key == org)
            .and_then(|(_, share)| share.clone())
    }

    /// Asserts the share of every organisation other than `except` is unchanged.
    fn assert_other_shares_unchanged(&self, before: &Before, except: Option<Pubkey>) {
        for (org, share) in &before.shares {
            if Some(*org) != except {
                assert_eq!(
                    self.share_state(*org).map(|s| (s.shares, s.lent_minor)),
                    share.as_ref().map(|s| (s.shares, s.lent_minor)),
                    "share of {org}"
                );
            }
        }
    }

    /// A deposit by `actor` for its organisation, with the share, the pool, the balances and
    /// the event checked.
    fn deposit(&mut self, actor: Actor, amount: u64) -> TransactionMetadata {
        let org = self.org_of(actor);
        let before = self.before();
        let deposit = Self::deposit_instruction(self.deposit_accounts(actor), amount);
        let tx = self.f.signed_ok(&[deposit], actor);

        let previous = Self::share_before(&before, org);
        let share = self.share_state(org).expect("the share exists");
        assert_eq!(share.pool, self.pool);
        assert_eq!(share.organisation, org);
        assert_eq!(
            share.shares,
            previous.as_ref().map_or(0, |s| s.shares) + amount
        );
        assert_eq!(
            share.lent_minor,
            previous.as_ref().map_or(0, |s| s.lent_minor)
        );
        assert_eq!(
            share.bump,
            Pubkey::find_program_address(&[b"pool_share", self.pool.as_ref(), org.as_ref()], &ID).1
        );
        assert_eq!(
            self.f.owner_and_data_len(self.share(org)),
            Some((ID, SHARE_SPACE))
        );
        let pool = self.pool_state();
        assert_eq!(pool.cash_minor, before.pool.cash_minor + amount);
        assert_eq!(pool.total_shares, before.pool.total_shares + amount);
        assert_eq!(pool.lent_minor, before.pool.lent_minor);
        assert_eq!(pool.income_minor, before.pool.income_minor);
        assert_eq!(pool.revision, before.pool.revision + 1);
        self.assert_other_shares_unchanged(&before, Some(org));
        let amount_i = i128::from(amount);
        self.assert_balances(
            &before,
            &[(self.ata(actor), -amount_i), (self.pool_vault, amount_i)],
        );
        assert_event(
            &tx,
            events::Deposited {
                pool: self.pool,
                organisation: org,
                wallet: self.f.key(actor),
                amount,
                shares: share.shares,
                pool_revision: pool.revision,
            },
        );
        self.assert_invariants();
        tx
    }

    /// A withdrawal by `actor` from its organisation's share into its own ATA.
    fn withdraw(&mut self, actor: Actor, amount: u64) -> TransactionMetadata {
        let org = self.org_of(actor);
        let before = self.before();
        let withdraw = Self::withdraw_instruction(self.withdraw_accounts(actor), amount);
        let tx = self.f.signed_ok(&[withdraw], actor);

        let previous = Self::share_before(&before, org).expect("the share existed");
        let share = self.share_state(org).unwrap();
        assert_eq!(share.shares, previous.shares - amount);
        assert_eq!(share.lent_minor, previous.lent_minor);
        assert_eq!((share.pool, share.organisation), (self.pool, org));
        let pool = self.pool_state();
        assert_eq!(pool.cash_minor, before.pool.cash_minor - amount);
        assert_eq!(pool.total_shares, before.pool.total_shares - amount);
        assert_eq!(pool.lent_minor, before.pool.lent_minor);
        assert_eq!(pool.income_minor, before.pool.income_minor);
        assert_eq!(pool.revision, before.pool.revision + 1);
        self.assert_other_shares_unchanged(&before, Some(org));
        let amount_i = i128::from(amount);
        self.assert_balances(
            &before,
            &[(self.ata(actor), amount_i), (self.pool_vault, -amount_i)],
        );
        assert_event(
            &tx,
            events::Withdrawn {
                pool: self.pool,
                organisation: org,
                wallet: self.f.key(actor),
                amount,
                shares: share.shares,
                pool_revision: pool.revision,
            },
        );
        self.assert_invariants();
        tx
    }

    fn deposit_refused(
        &mut self,
        accounts: accounts::Deposit,
        actor: Actor,
        amount: u64,
        expected: ThetisError,
    ) {
        let deposit = Self::deposit_instruction(accounts, amount);
        self.f.signed_refused(&[deposit], actor, 0, expected);
        self.assert_invariants();
    }

    fn withdraw_refused(
        &mut self,
        accounts: accounts::Withdraw,
        actor: Actor,
        amount: u64,
        expected: ThetisError,
    ) {
        let withdraw = Self::withdraw_instruction(accounts, amount);
        self.f.signed_refused(&[withdraw], actor, 0, expected);
        self.assert_invariants();
    }

    // ------------------------------------------------------------------- borrow ----

    /// `borrow`'s 18 accounts, paying `destination`, drawing on Lender One Bank's share.
    fn borrow_accounts(&self, destination: Pubkey) -> accounts::Borrow {
        accounts::Borrow {
            sponsor: self.f.payer(),
            protocol: self.f.protocol,
            borrower_org: self.owner,
            borrower_authority: self.authority_of(Owner),
            lender_org: self.lender,
            facility: self.facility,
            loan: self.loan,
            lock: self.lock,
            lot: self.lot,
            valuation: self.valuation,
            pool: self.pool,
            lender_share: self.share(self.lender),
            pool_authority: self.pool_authority,
            pool_vault: self.pool_vault,
            mint: POOL_MINT,
            destination,
            token_program: SPL_TOKEN,
            instructions: INSTRUCTIONS_SYSVAR,
        }
    }

    /// The borrower's "Borrow test tokens" Ed25519 entry for `amount` to the accounts'
    /// destination at the loan's current revision, then the instruction.
    fn borrow_instructions(&self, accounts: accounts::Borrow, amount: u64) -> [Instruction; 2] {
        let loan = self.loan_state();
        let valid_until = self.now + MONEY_WINDOW;
        let text = borrow_message(
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
            MICRO,
            &accounts.destination,
            RATE_BPS,
            loan.revision,
            valid_until,
        );
        let verify = ed25519_instruction(&[(self.f.signer(Owner), text.as_slice())]);
        let borrow = ix(
            accounts,
            instruction::Borrow {
                amount,
                expected_revision: loan.revision,
                valid_until,
            },
        );
        [verify, borrow]
    }

    /// Asserts a successful `borrow` of `amount` into the Owner's ATA against `before`.
    fn assert_borrowed(&self, before: &Before, amount: u64, tx: &TransactionMetadata) {
        let was = before.loan.as_ref().unwrap();
        let (interest, remainder) = expected_accrual(
            was.principal,
            was.rate_bps,
            self.now - was.accrued_at,
            was.accrual_remainder,
        );
        let loan = self.loan_state();
        assert_eq!(loan.principal, was.principal + amount);
        assert_eq!(loan.booked_interest, was.booked_interest + interest);
        assert_eq!(loan.accrual_remainder, remainder);
        assert_eq!(loan.accrued_at, self.now);
        assert_eq!(loan.revision, was.revision + 1);
        assert_eq!(loan.status, LoanStatus::Active);
        let pool = self.pool_state();
        assert_eq!(pool.cash_minor, before.pool.cash_minor - amount);
        assert_eq!(pool.lent_minor, before.pool.lent_minor + amount);
        assert_eq!(pool.total_shares, before.pool.total_shares);
        assert_eq!(pool.income_minor, before.pool.income_minor);
        assert_eq!(pool.revision, before.pool.revision + 1);
        let previous = Self::share_before(before, self.lender).unwrap();
        let share = self.share_state(self.lender).unwrap();
        assert_eq!(share.lent_minor, previous.lent_minor + amount);
        assert_eq!(share.shares, previous.shares);
        self.assert_other_shares_unchanged(before, Some(self.lender));
        let amount_i = i128::from(amount);
        self.assert_balances(
            before,
            &[(self.ata(Owner), amount_i), (self.pool_vault, -amount_i)],
        );
        assert_event(
            tx,
            events::Borrowed {
                loan: self.loan,
                pool: self.pool,
                amount,
                principal: loan.principal,
                booked_interest: loan.booked_interest,
                revision: loan.revision,
                pool_revision: pool.revision,
            },
        );
        self.assert_invariants();
    }

    /// A borrow of `amount` into the Owner's ATA, relayed by the sponsor.
    fn borrow(&mut self, amount: u64) -> TransactionMetadata {
        let before = self.before();
        let instructions = self.borrow_instructions(self.borrow_accounts(self.ata(Owner)), amount);
        let tx = self.f.sponsored_ok(&instructions);
        self.assert_borrowed(&before, amount, &tx);
        tx
    }

    /// `borrow` must fail with `expected`, with no state change and no event.
    fn borrow_refused(&mut self, accounts: accounts::Borrow, amount: u64, expected: ThetisError) {
        let instructions = self.borrow_instructions(accounts, amount);
        self.f.sponsored_refused(&instructions, 1, expected);
        self.assert_invariants();
    }

    // -------------------------------------------------------- simulated repayment ----

    /// The simulation layout of `repay`, paid by `payer` from its own ATA.
    fn repay_accounts(&self, payer: Actor) -> accounts::Repay {
        accounts::Repay {
            signer: self.f.key(payer),
            protocol: self.f.protocol,
            facility: self.facility,
            loan: self.loan,
            authority: None,
            lender_org: None,
            payment: None,
            pool: Some(self.pool),
            pool_authority: Some(self.pool_authority),
            pool_vault: Some(self.pool_vault),
            payer_token: Some(self.ata(payer)),
            mint: Some(POOL_MINT),
            token_program: Some(SPL_TOKEN),
        }
    }

    /// The facility lender's share as the one writable remaining account.
    fn lender_share_meta(&self) -> AccountMeta {
        AccountMeta::new(self.share(self.lender), false)
    }

    fn repay_instruction(
        accounts: accounts::Repay,
        amount: u64,
        lender_share: Option<AccountMeta>,
    ) -> Instruction {
        let mut repay = ix(accounts, instruction::Repay { amount });
        repay.accounts.extend(lender_share);
        repay
    }

    /// A simulated repayment by `payer` offering `offered`; only the applied amount moves.
    fn repay(&mut self, payer: Actor, offered: u64) -> (TransactionMetadata, ExpectedRepayment) {
        let before = self.before();
        let was = before.loan.clone().unwrap();
        let expected = expected_repayment(&was, self.now, offered);
        let repay = Self::repay_instruction(
            self.repay_accounts(payer),
            offered,
            Some(self.lender_share_meta()),
        );
        let tx = self.f.signed_ok(&[repay], payer);

        let loan = self.loan_state();
        assert_eq!(loan.principal, expected.principal);
        assert_eq!(loan.booked_interest, expected.booked_interest);
        assert_eq!(loan.accrual_remainder, expected.remainder);
        assert_eq!(loan.accrued_at, self.now);
        assert_eq!(loan.revision, was.revision + 1);
        assert_eq!(loan.status, was.status);
        let pool = self.pool_state();
        assert_eq!(pool.cash_minor, before.pool.cash_minor + expected.applied);
        assert_eq!(
            pool.lent_minor,
            before.pool.lent_minor - expected.from_principal
        );
        assert_eq!(
            pool.income_minor,
            before.pool.income_minor + expected.from_interest
        );
        assert_eq!(pool.total_shares, before.pool.total_shares);
        assert_eq!(pool.revision, before.pool.revision + 1);
        let previous = Self::share_before(&before, self.lender).unwrap();
        let share = self.share_state(self.lender).unwrap();
        assert_eq!(
            share.lent_minor,
            previous.lent_minor - expected.from_principal
        );
        assert_eq!(share.shares, previous.shares);
        self.assert_other_shares_unchanged(&before, Some(self.lender));
        let applied = i128::from(expected.applied);
        self.assert_balances(
            &before,
            &[(self.ata(payer), -applied), (self.pool_vault, applied)],
        );
        assert_event(
            &tx,
            events::Repaid {
                loan: self.loan,
                payment: None,
                pool: Some(self.pool),
                pool_revision: Some(pool.revision),
                applied: expected.applied,
                from_interest: expected.from_interest,
                from_principal: expected.from_principal,
                surplus: 0,
                principal: expected.principal,
                booked_interest: expected.booked_interest,
                revision: loan.revision,
            },
        );
        self.assert_invariants();
        (tx, expected)
    }

    fn repay_refused(&mut self, repay: Instruction, payer: Actor, expected: ThetisError) {
        self.f.signed_refused(&[repay], payer, 0, expected);
        self.assert_invariants();
    }

    // ---------------------------------------------------------------- recovery ----

    fn liquidate(&mut self, expected_revision: u64) -> TransactionMetadata {
        let liquidate = ix(
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
            },
            instruction::Liquidate { expected_revision },
        );
        let tx = self.f.signed_ok(&[liquidate], Lender);
        assert_eq!(self.loan_state().status, LoanStatus::Recovery);
        self.assert_invariants();
        tx
    }

    fn close(&mut self, expected_revision: u64) -> TransactionMetadata {
        let close = ix(
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
        );
        let tx = self.f.signed_ok(&[close], Lender);
        assert_eq!(self.loan_state().status, LoanStatus::Closed);
        self.assert_invariants();
        tx
    }

    // ---------------------------------------------------------------- snapshots ----

    /// The pool, both shares and the vault: what a non-pool instruction must leave alone.
    fn pool_accounts(&self) -> Vec<Pubkey> {
        vec![
            self.pool,
            self.share(self.lender),
            self.share(self.lender2),
            self.pool_vault,
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

    // ------------------------------------------------------------- invariants ----

    /// The invariants: the Phase 1 supply and vault rules; the lock follows the
    /// loan; the pool's `cash + lent == shares + income`, its vault holds at least its cash,
    /// `lent` is the loan's principal and the sum of the shares' `lent_minor`, the shares sum to
    /// `total_shares`, and no share has lent more than it holds; the pool-mint supply is held by
    /// the wallets and the vault.
    fn assert_invariants(&self) {
        let f = &self.f;
        let lot: Lot = f.read(self.lot);
        let position: Position = f.read(self.position);
        assert_eq!(position.quantity_kg, lot.supply_kg);
        assert_eq!(f.mint_supply(self.lot_mint()), lot.supply_kg);
        assert_eq!(f.token_amount(self.lot_vault()), position.quantity_kg);
        let loan = f.account_exists(self.loan).then(|| self.loan_state());
        if let Some(loan) = &loan {
            let lock = self.lock_state();
            assert_eq!(lock.loan, self.loan);
            if loan.status == LoanStatus::Closed {
                assert_eq!(lock.quantity_kg, 0);
                assert_eq!(position.locked_kg, 0);
            } else {
                assert_eq!(position.locked_kg, lock.quantity_kg);
                assert_eq!(
                    loan.status == LoanStatus::Active,
                    lock.control == LockControl::Pledged
                );
            }
            assert!(loan.accrual_remainder < ACCRUAL_DENOMINATOR);
        }
        if f.account_exists(self.pool) {
            let pool = self.pool_state();
            assert_eq!(
                u128::from(pool.cash_minor) + u128::from(pool.lent_minor),
                u128::from(pool.total_shares) + u128::from(pool.income_minor)
            );
            assert!(self.balance(self.pool_vault) >= pool.cash_minor);
            assert_eq!(
                pool.lent_minor,
                loan.as_ref().map_or(0, |loan| loan.principal)
            );
            let shares: Vec<PoolShare> = [self.lender, self.lender2]
                .into_iter()
                .filter_map(|org| self.share_state(org))
                .collect();
            assert_eq!(
                shares.iter().map(|s| u128::from(s.shares)).sum::<u128>(),
                u128::from(pool.total_shares)
            );
            assert_eq!(
                shares
                    .iter()
                    .map(|s| u128::from(s.lent_minor))
                    .sum::<u128>(),
                u128::from(pool.lent_minor)
            );
            for share in &shares {
                assert!(share.lent_minor <= share.shares);
            }
        }
        let held: u128 = WALLETS
            .iter()
            .map(|actor| u128::from(self.balance(self.ata(*actor))))
            .sum::<u128>()
            + if f.account_exists(self.pool_vault) {
                u128::from(self.balance(self.pool_vault))
            } else {
                0
            };
        assert_eq!(held, u128::from(f.mint_supply(POOL_MINT)));
    }
}

// --------------------------------------------------------------------- open_pool ----

#[test]
fn open_pool_rejects_fiat_mode_and_non_admin() {
    // A fiat instance never opens a pool.
    let mut fiat = World::before_pool(SettlementMode::FiatAttestationTest);
    fiat.open_pool_refused(Admin, POOL_MINT, WrongSettlementMode);

    // On a simulation instance only the protocol admin may open it.
    let mut w = World::before_pool(SettlementMode::DevnetTokenSimulation);
    w.open_pool_refused(Outsider, POOL_MINT, NotAdmin);
    w.open_pool();
}

#[test]
fn open_pool_rejects_native_or_token2022_mint() {
    let mut w = World::before_pool(SettlementMode::DevnetTokenSimulation);
    // The native mint, harness-written where the cluster keeps it.
    w.f.set_foreign_account(NATIVE_MINT, SPL_TOKEN, mint_data(None, 0, 9));
    w.open_pool_refused(Admin, NATIVE_MINT, MintMismatch);
    // An SPL Token mint with more decimals than a currency has.
    w.write_mint(TEN_DECIMAL_MINT, SPL_TOKEN, 10);
    w.open_pool_refused(Admin, TEN_DECIMAL_MINT, MintMismatch);
    // A Token-2022 mint fails Anchor's owner check on the SPL Token `Mint` slot.
    w.write_mint(TOKEN_2022_MINT, TOKEN_2022, MICRO);
    let open = w.open_pool_instruction(Admin, TOKEN_2022_MINT);
    w.f.refused_anchor(open, Admin, AnchorError::AccountOwnedByWrongProgram);
    assert!(!w.f.account_exists(w.pool));

    w.open_pool();
}

#[test]
fn open_pool_accepts_prefunded_vault_as_unattributed() {
    let mut w = World::before_pool(SettlementMode::DevnetTokenSimulation);
    // Anyone can create the vault's canonical address and fund it before the pool opens.
    let vault = w.create_token_account(w.pool_authority, POOL_MINT);
    assert_eq!(vault, w.pool_vault);
    w.send_tokens(Outsider, vault, THIRTY_K);
    assert_eq!(w.balance(vault), THIRTY_K);

    w.open_pool();
    let pool = w.pool_state();
    assert_eq!((pool.cash_minor, pool.total_shares), (0, 0));
    assert_eq!(w.balance(w.pool_vault), THIRTY_K);

    // The credit is never anyone's shares or cash.
    w.deposit(Lender, FOUR_HUNDRED_K);
    assert_eq!(w.pool_state().cash_minor, FOUR_HUNDRED_K);
    assert_eq!(w.balance(w.pool_vault), FOUR_HUNDRED_K + THIRTY_K);
    w.withdraw(Lender, FOUR_HUNDRED_K);
    assert_eq!(w.pool_state().cash_minor, 0);
    assert_eq!(w.balance(w.pool_vault), THIRTY_K);
    let accounts = w.withdraw_accounts(Lender);
    w.withdraw_refused(accounts, Lender, 1, InsufficientShares);
}

#[test]
fn open_facility_simulation_requires_matching_pool() {
    let mut w = World::demo();
    let facility = pda(&[
        b"facility",
        w.f.protocol.as_ref(),
        w.lender2.as_ref(),
        &FACILITY_TWO,
    ]);
    for (currency, decimals, with_pool, expected) in [
        (USD, CENTS, true, CurrencyMismatch),
        (EUR, MICRO, true, CurrencyMismatch),
        (USD, MICRO, false, InvalidField),
    ] {
        let open = w.facility_instruction(
            Lender2,
            w.lender2,
            FACILITY_TWO,
            currency,
            decimals,
            with_pool,
        );
        w.f.signed_refused(&[open], Lender2, 0, expected);
        assert!(!w.f.account_exists(facility));
    }

    let open = w.facility_instruction(Lender2, w.lender2, FACILITY_TWO, USD, MICRO, true);
    w.f.signed_ok(&[open], Lender2);
    let opened: Facility = w.f.read(facility);
    assert_eq!(opened.lender, w.lender2);
    assert_eq!(opened.currency, USD);
    assert_eq!(opened.currency_decimals, MICRO);
    w.assert_invariants();
}

// ---------------------------------------------------------------- deposit, withdraw ----

#[test]
fn deposit_and_withdraw_one_to_one_shares() {
    let mut w = World::demo();
    assert!(w.share_state(w.lender).is_none());
    w.deposit(Lender, FOUR_HUNDRED_K);
    let share = w.share_state(w.lender).unwrap();
    assert_eq!(share.shares, 400_000_000_000);
    assert_eq!(share.lent_minor, 0);
    assert_eq!(w.pool_state().cash_minor, 400_000_000_000);
    assert_eq!(w.pool_state().revision, 1);

    // The same share is reused.
    w.deposit(Lender, TWO_TEN_K);
    assert_eq!(w.share_state(w.lender).unwrap().shares, 610_000_000_000);
    assert_eq!(w.pool_state().revision, 2);

    w.withdraw(Lender, TWO_TEN_K);
    let share = w.share_state(w.lender).unwrap();
    assert_eq!(share.shares, 400_000_000_000);
    let pool = w.pool_state();
    assert_eq!(
        (pool.cash_minor, pool.total_shares),
        (FOUR_HUNDRED_K, FOUR_HUNDRED_K)
    );
    assert_eq!(pool.revision, 3);
    assert_eq!(w.balance(w.ata(Lender)), SEVEN_HUNDRED_K - FOUR_HUNDRED_K);
    assert_eq!(w.balance(w.pool_vault), FOUR_HUNDRED_K);
}

#[test]
fn withdraw_rejects_more_than_shares() {
    let mut w = World::demo();
    w.deposit(Lender, FOUR_HUNDRED_K);
    w.deposit(Lender2, LIMIT);
    // The pool's cash would cover it; Lender One's shares don't.
    assert!(w.pool_state().cash_minor > FOUR_HUNDRED_K + 1);
    let accounts = w.withdraw_accounts(Lender);
    w.withdraw_refused(accounts, Lender, FOUR_HUNDRED_K + 1, InsufficientShares);
    w.withdraw(Lender, FOUR_HUNDRED_K);
}

#[test]
fn withdraw_rejects_more_than_free_liquidity() {
    let mut w = World::demo();
    w.deposit(Lender, LIMIT);
    w.deposit(Lender2, LIMIT);
    w.borrow(LIMIT);
    // Lender One's shares and the pool's cash cover USD30,000, but all of Lender One's
    // deposits are lent out.
    let share = w.share_state(w.lender).unwrap();
    assert_eq!((share.shares, share.lent_minor), (LIMIT, LIMIT));
    assert_eq!(w.pool_state().cash_minor, LIMIT);
    let accounts = w.withdraw_accounts(Lender);
    w.withdraw_refused(accounts, Lender, THIRTY_K, InsufficientLiquidity);
    w.withdraw(Lender2, LIMIT);
}

#[test]
fn deposit_rejects_wrong_mint() {
    let mut w = World::demo();
    w.write_mint(OTHER_MINT, SPL_TOKEN, MICRO);
    let lender_wallet = w.f.key(Lender);
    let other = w.create_token_account(lender_wallet, OTHER_MINT);
    w.mint_to(OTHER_MINT, other, THIRTY_K);

    let mut accounts = w.deposit_accounts(Lender);
    accounts.depositor_token = other;
    w.deposit_refused(accounts, Lender, THIRTY_K, MintMismatch);
    let mut accounts = w.deposit_accounts(Lender);
    accounts.mint = OTHER_MINT;
    w.deposit_refused(accounts, Lender, THIRTY_K, MintMismatch);
    let mut accounts = w.deposit_accounts(Lender);
    accounts.pool_vault = w.ata(Lender2);
    w.deposit_refused(accounts, Lender, THIRTY_K, MintMismatch);
    assert!(w.share_state(w.lender).is_none());
    assert_eq!(w.balance(other), THIRTY_K);

    w.deposit(Lender, THIRTY_K);
}

#[test]
fn unsolicited_vault_credit_is_not_liquidity() {
    let mut w = World::demo();
    w.deposit(Lender, FOUR_HUNDRED_K);
    let pool_before = w.snapshot(&[w.pool, w.share(w.lender)]);
    w.send_tokens(Outsider, w.pool_vault, TWO_TEN_K);
    w.assert_unchanged(&pool_before);
    assert_eq!(w.balance(w.pool_vault), FOUR_HUNDRED_K + TWO_TEN_K);
    w.assert_invariants();

    let accounts = w.borrow_accounts(w.ata(Owner));
    w.borrow_refused(accounts, LIMIT, InsufficientLiquidity);
    let accounts = w.withdraw_accounts(Lender);
    w.withdraw_refused(
        accounts,
        Lender,
        FOUR_HUNDRED_K + TWO_TEN_K,
        InsufficientShares,
    );

    w.borrow(FOUR_HUNDRED_K);
    assert_eq!(w.pool_state().cash_minor, 0);
    assert_eq!(w.balance(w.pool_vault), TWO_TEN_K);
    let accounts = w.withdraw_accounts(Lender);
    w.withdraw_refused(accounts, Lender, 1, InsufficientLiquidity);
}

// ------------------------------------------------------------------------ borrow ----

#[test]
fn borrow_transfers_test_tokens_within_limit() {
    let mut w = World::demo();
    w.deposit(Lender, LIMIT);
    assert_eq!(w.loan_state().revision, 0);
    w.borrow(LIMIT);

    let loan = w.loan_state();
    assert_eq!(loan.principal, 600_000_000_000);
    assert_eq!(loan.booked_interest, 0);
    assert_eq!(loan.revision, 1);
    let pool = w.pool_state();
    assert_eq!(pool.cash_minor, 0);
    assert_eq!(pool.lent_minor, 600_000_000_000);
    assert_eq!(pool.revision, 2);
    assert_eq!(w.share_state(w.lender).unwrap().lent_minor, 600_000_000_000);
    assert_eq!(w.balance(w.ata(Owner)), LIMIT);
    assert_eq!(w.balance(w.pool_vault), 0);
}

#[test]
fn borrow_rejects_over_ltv() {
    let mut w = World::demo();
    w.deposit(Lender, SEVEN_HUNDRED_K);
    let accounts = w.borrow_accounts(w.ata(Owner));
    w.borrow_refused(accounts, LIMIT + 1, OverLimit);
    w.borrow(LIMIT);
}

#[test]
fn borrow_rejects_stale_valuation() {
    let mut w = World::with_valuation_until(NOW + DAY);
    w.deposit(Lender, LIMIT);
    w.advance_to(NOW + DAY + 1);
    let accounts = w.borrow_accounts(w.ata(Owner));
    w.borrow_refused(accounts, FOUR_HUNDRED_K, ValuationStale);
}

#[test]
fn borrow_rejects_insufficient_liquidity() {
    let mut w = World::demo();
    w.deposit(Lender, FOUR_HUNDRED_K);
    let accounts = w.borrow_accounts(w.ata(Owner));
    w.borrow_refused(accounts, LIMIT, InsufficientLiquidity);
    w.borrow(FOUR_HUNDRED_K);
}

#[test]
fn borrow_rejects_destination_not_borrower() {
    let mut w = World::demo();
    w.deposit(Lender, LIMIT);
    // Each destination is named in the signed text, so the binding is the only fault.
    for destination in [w.ata(Outsider), w.pool_vault] {
        let accounts = w.borrow_accounts(destination);
        w.borrow_refused(accounts, FOUR_HUNDRED_K, InvalidField);
    }
    w.borrow(FOUR_HUNDRED_K);
}

#[test]
fn borrow_draws_only_on_facility_lender_deposits() {
    let mut w = World::demo();
    w.deposit(Lender2, LIMIT);
    // Lender Two's deposits never fund Lender One's facility.
    let mut accounts = w.borrow_accounts(w.ata(Owner));
    accounts.lender_share = w.share(w.lender2);
    w.borrow_refused(accounts, THIRTY_K, WrongOrganisation);

    w.deposit(Lender, THIRTY_K);
    let lender2_share = w.snapshot(&[w.share(w.lender2)]);
    assert_eq!(w.pool_state().cash_minor, LIMIT + THIRTY_K);
    let accounts = w.borrow_accounts(w.ata(Owner));
    w.borrow_refused(accounts, LIMIT, InsufficientLiquidity);
    w.borrow(THIRTY_K);
    w.assert_unchanged(&lender2_share);
}

#[test]
fn pool_share_is_keyed_by_organisation() {
    let mut w = World::demo();
    w.deposit(Lender, FOUR_HUNDRED_K);
    // A second wallet of Lender One Bank withdraws from the same share into its own account.
    let tx = w.withdraw(LenderTreasury, TWO_TEN_K);
    assert_event(
        &tx,
        events::Withdrawn {
            pool: w.pool,
            organisation: w.lender,
            wallet: w.f.key(LenderTreasury),
            amount: TWO_TEN_K,
            shares: FOUR_HUNDRED_K - TWO_TEN_K,
            pool_revision: 2,
        },
    );
    assert_eq!(w.balance(w.ata(LenderTreasury)), TWO_TEN_K);

    // Revoking one wallet's Authority never strands the deposit.
    let revoke = w.f.revoke(OrgAdmin, w.lender, w.authority_of(Lender));
    w.f.ok(revoke, OrgAdmin);
    let accounts = w.withdraw_accounts(Lender);
    w.withdraw_refused(accounts, Lender, THIRTY_K, AuthorityRevoked);

    // Another organisation's wallet can't reach Lender One's share.
    let mut accounts = w.withdraw_accounts(Lender2);
    accounts.share = w.share(w.lender);
    w.withdraw_refused(accounts, Lender2, THIRTY_K, WrongOrganisation);

    w.withdraw(LenderTreasury, FOUR_HUNDRED_K - TWO_TEN_K);
    assert_eq!(w.share_state(w.lender).unwrap().shares, 0);
}

// ------------------------------------------------------------- settlement mode ----

#[test]
fn simulation_only_instructions_reject_fiat_mode() {
    let mut w = World::before_pool(SettlementMode::DevnetTokenSimulation);
    w.set_settlement_mode(SettlementMode::FiatAttestationTest);
    w.open_pool_refused(Admin, POOL_MINT, WrongSettlementMode);
    w.set_settlement_mode(SettlementMode::DevnetTokenSimulation);
    w.open_pool();
    w.open_lending(NOW + VALUATION_VALIDITY);
    w.deposit(Lender, LIMIT);

    w.set_settlement_mode(SettlementMode::FiatAttestationTest);
    let accounts = w.deposit_accounts(Lender);
    w.deposit_refused(accounts, Lender, THIRTY_K, WrongSettlementMode);
    let accounts = w.withdraw_accounts(Lender);
    w.withdraw_refused(accounts, Lender, THIRTY_K, WrongSettlementMode);
    let accounts = w.borrow_accounts(w.ata(Owner));
    w.borrow_refused(accounts, FOUR_HUNDRED_K, WrongSettlementMode);

    w.set_settlement_mode(SettlementMode::DevnetTokenSimulation);
    w.deposit(Lender, THIRTY_K);
    w.withdraw(Lender, THIRTY_K);
    w.borrow(FOUR_HUNDRED_K);
}

// ------------------------------------------------------------ simulated repayment ----

#[test]
fn repay_simulated_transfer_moves_only_applied_amount() {
    let mut w = World::demo();
    w.deposit(Lender, LIMIT);
    w.borrow(LIMIT);
    // A wallet with no Authority offers USD700,000 against USD600,000 owed.
    let (_, repaid) = w.repay(Outsider, SEVEN_HUNDRED_K);
    assert_eq!(repaid.applied, 600_000_000_000);
    assert_eq!((repaid.from_interest, repaid.from_principal), (0, LIMIT));
    assert_eq!(w.balance(w.ata(Outsider)), SEVEN_HUNDRED_K - LIMIT);
    let loan = w.loan_state();
    assert_eq!((loan.principal, loan.booked_interest), (0, 0));
    assert_eq!(loan.revision, 2);
    let pool = w.pool_state();
    assert_eq!(pool.cash_minor, 600_000_000_000);
    assert_eq!((pool.lent_minor, pool.income_minor), (0, 0));
    assert_eq!(w.share_state(w.lender).unwrap().lent_minor, 0);

    // Nothing is owed: a further repayment is refused and moves nothing.
    let repay =
        World::repay_instruction(w.repay_accounts(Outsider), 1, Some(w.lender_share_meta()));
    w.repay_refused(repay, Outsider, InvalidField);
}

#[test]
fn repay_simulated_rejects_bad_slots() {
    let mut w = World::demo();
    w.deposit(Lender, LIMIT);
    w.deposit(Lender2, THIRTY_K);
    w.borrow(LIMIT);
    let share = Some(w.lender_share_meta());
    // A simulation instance can't confirm a payment, so the harness writes an unconsumed
    // Repayment attestation of the loan to put in the payment slot.
    let lender_payment = pda(&[
        b"payment",
        w.f.protocol.as_ref(),
        w.lender.as_ref(),
        &[1; 32],
    ]);
    let attestation = PaymentAttestation {
        protocol: w.f.protocol,
        lender: w.lender,
        loan: w.loan,
        payment_id: [1; 32],
        purpose: PaymentPurpose::Repayment,
        subject: w.loan,
        amount: THIRTY_K,
        currency: USD,
        evidence_digest: [0xe1; 32],
        observed_at: NOW,
        status: PaymentStatus::Unconsumed,
        applied: 0,
        surplus: 0,
        bump: Pubkey::find_program_address(
            &[
                b"payment",
                w.f.protocol.as_ref(),
                w.lender.as_ref(),
                &[1; 32],
            ],
            &ID,
        )
        .1,
    };
    w.f.set_program_account(lender_payment, &attestation);

    let mut faults: Vec<(Instruction, ThetisError)> = Vec::new();
    // A fiat slot present in simulation mode: the attestation, the signer's own canonical
    // Authority (so the slot's seeds pass), or an organisation.
    let mut accounts = w.repay_accounts(Owner);
    accounts.payment = Some(lender_payment);
    faults.push((
        World::repay_instruction(accounts, THIRTY_K, share.clone()),
        InvalidField,
    ));
    let mut accounts = w.repay_accounts(Owner);
    accounts.authority = Some(w.authority_of(Owner));
    faults.push((
        World::repay_instruction(accounts, THIRTY_K, share.clone()),
        InvalidField,
    ));
    let mut accounts = w.repay_accounts(Owner);
    accounts.lender_org = Some(w.lender);
    faults.push((
        World::repay_instruction(accounts, THIRTY_K, share.clone()),
        InvalidField,
    ));
    // A pool slot absent.
    let mut accounts = w.repay_accounts(Owner);
    accounts.mint = None;
    faults.push((
        World::repay_instruction(accounts, THIRTY_K, share.clone()),
        InvalidField,
    ));
    // No lender share, or a read-only one.
    faults.push((
        World::repay_instruction(w.repay_accounts(Owner), THIRTY_K, None),
        InvalidField,
    ));
    faults.push((
        World::repay_instruction(
            w.repay_accounts(Owner),
            THIRTY_K,
            Some(AccountMeta::new_readonly(w.share(w.lender), false)),
        ),
        InvalidField,
    ));
    // Another lender's share.
    faults.push((
        World::repay_instruction(
            w.repay_accounts(Owner),
            THIRTY_K,
            Some(AccountMeta::new(w.share(w.lender2), false)),
        ),
        WrongOrganisation,
    ));
    // A pool authority that isn't the pool's.
    let mut accounts = w.repay_accounts(Owner);
    accounts.pool_authority = Some(w.f.key(Outsider));
    faults.push((
        World::repay_instruction(accounts, THIRTY_K, share.clone()),
        MintMismatch,
    ));
    // A payer token account the signer doesn't own.
    let mut accounts = w.repay_accounts(Owner);
    accounts.payer_token = Some(w.ata(Outsider));
    faults.push((
        World::repay_instruction(accounts, THIRTY_K, share.clone()),
        InvalidField,
    ));
    // Nothing offered.
    faults.push((
        World::repay_instruction(w.repay_accounts(Owner), 0, share.clone()),
        InvalidField,
    ));
    for (repay, expected) in faults {
        w.repay_refused(repay, Owner, expected);
    }
    assert_eq!(
        w.f.read::<PaymentAttestation>(lender_payment).status,
        PaymentStatus::Unconsumed
    );

    w.repay(Owner, THIRTY_K);
}

#[test]
fn liquidation_does_not_add_pool_liquidity() {
    let mut w = World::demo();
    w.deposit(Lender, LIMIT);
    w.borrow(LIMIT);
    w.advance_to(NOW + YEAR);
    let pool = w.snapshot(&w.pool_accounts());
    w.liquidate(1);
    w.assert_unchanged(&pool);
    assert_eq!(w.lock_state().control, LockControl::Recovery);
    let accounts = w.withdraw_accounts(Lender);
    w.withdraw_refused(accounts, Lender, 1, InsufficientLiquidity);

    // Repayment stays open in Recovery; interest first, then principal.
    let (_, repaid) = w.repay(Owner, TWO_TEN_K);
    assert_eq!(repaid.from_interest, 72_000_000_000);
    assert_eq!(repaid.from_principal, 138_000_000_000);
    let pool = w.pool_state();
    assert_eq!(pool.cash_minor, 210_000_000_000);
    assert_eq!(pool.lent_minor, 462_000_000_000);
    assert_eq!(pool.income_minor, 72_000_000_000);
    assert_eq!(w.share_state(w.lender).unwrap().lent_minor, 462_000_000_000);
    assert_eq!(w.loan_state().status, LoanStatus::Recovery);
    assert_eq!(w.lock_state().control, LockControl::Recovery);

    // Only the repaid principal is free again; the interest stays unclaimed pool cash.
    let accounts = w.withdraw_accounts(Lender);
    w.withdraw_refused(accounts, Lender, 138_000_000_001, InsufficientLiquidity);
    w.withdraw(Lender, 138_000_000_000);
    let pool = w.pool_state();
    assert_eq!(pool.cash_minor, 72_000_000_000);
    assert_eq!(pool.income_minor, 72_000_000_000);
}

#[test]
fn pool_conservation_across_borrow_repay_cycles() {
    let mut w = World::demo();
    w.deposit(Lender, LIMIT);
    w.deposit(Lender2, FOUR_HUNDRED_K);

    // Cycle 1.
    w.borrow(FOUR_HUNDRED_K);
    w.advance_to(NOW + YEAR);
    let (_, repaid) = w.repay(Owner, TWO_TEN_K);
    assert_eq!(
        (repaid.from_interest, repaid.from_principal),
        (48_000_000_000, 162_000_000_000)
    );
    // Cycle 2.
    w.borrow(TWO_TEN_K);
    assert_eq!(w.loan_state().principal, 448_000_000_000);
    w.advance_to(NOW + 2 * YEAR);
    let (_, repaid) = w.repay(Owner, THIRTY_K);
    assert_eq!((repaid.from_interest, repaid.from_principal), (THIRTY_K, 0));
    assert_eq!(w.loan_state().booked_interest, 23_760_000_000);
    // Cycle 3, then repaid in full by a third wallet.
    w.borrow(THIRTY_K);
    assert_eq!(w.loan_state().principal, 478_000_000_000);
    let (_, repaid) = w.repay(Outsider, SEVEN_HUNDRED_K);
    assert_eq!(repaid.applied, 501_760_000_000);
    let loan = w.loan_state();
    assert_eq!((loan.principal, loan.booked_interest), (0, 0));

    // Closing the simulated loan releases the lock and touches no pool account.
    let pool = w.snapshot(&w.pool_accounts());
    w.close(loan.revision);
    w.assert_unchanged(&pool);
    assert_eq!(w.lock_state().quantity_kg, 0);
    assert_eq!(w.f.read::<Position>(w.position).locked_kg, 0);

    w.withdraw(Lender, LIMIT);
    w.withdraw(Lender2, FOUR_HUNDRED_K);
    let pool = w.pool_state();
    assert_eq!(pool.income_minor, 101_760_000_000);
    assert_eq!(pool.cash_minor, 101_760_000_000);
    assert_eq!((pool.total_shares, pool.lent_minor), (0, 0));
    assert_eq!(w.balance(w.pool_vault), 101_760_000_000);
}

// ------------------------------------------------------------------------- texts ----

#[test]
fn borrow_message_known_answer() {
    let instance: [u8; 16] = core::array::from_fn(|index| 0x11 * index as u8);
    let destination = Pubkey::new_from_array([0x22; 32]);
    assert_eq!(
        destination.to_string(),
        "3JF3sEqM796hk5WFqA6EtmEwJQ9quALszsfJyvXNQKy3"
    );
    let text = borrow_message(
        &ID,
        &instance,
        LOT_ID,
        OWNER_NAME,
        LENDER_NAME,
        &FACILITY_ONE,
        0,
        600_000_000_000,
        600_000_000_000,
        &USD,
        MICRO,
        &destination,
        RATE_BPS,
        0,
        1_795_098_725,
    );
    let expected = "Thetis authorisation v1\n\
                    Network: devnet\n\
                    Program: jGJpdjtoDUtXMjvc4UaEi1mBeFZKqVfe9jL8ireHMs3\n\
                    Protocol: 00112233445566778899aabbccddeeff\n\
                    Action: Borrow test tokens\n\
                    Lot: CR-0001\n\
                    Owner: Khunou Ore Exports\n\
                    Lender: Lender One Bank\n\
                    Facility: 11111111111111111111111111111111\n\
                    Loan: 0\n\
                    Amount: USD 600,000.000000\n\
                    Principal after: USD 600,000.000000\n\
                    Pay to: 3JF3sEqM796hk5WFqA6EtmEwJQ9quALszsfJyvXNQKy3\n\
                    Rate: 12.00% a year, simple, actual/365\n\
                    Revision: 0\n\
                    Valid until: 2026-11-19 16:32:05 SAST\n\
                    Test network only. Synthetic data.";
    assert_eq!(String::from_utf8(text.clone()).unwrap(), expected);
    assert_eq!(text.len(), 517);
    assert_eq!(
        solana_sha256_hasher::hash(&text).to_bytes(),
        hex32("4cb99c85b751577bc21ee7165cf52ed10269610dd25e8dafb4b68e4a0e873be2")
    );
}

/// 64 hex characters as 32 bytes.
fn hex32(hex: &str) -> [u8; 32] {
    core::array::from_fn(|index| u8::from_str_radix(&hex[2 * index..2 * index + 2], 16).unwrap())
}

// -------------------------------------------------------------------------- size ----

impl World {
    /// The per-instance table for `borrow`, with `destinations` appended.
    fn borrow_table(&mut self, destinations: &[Pubkey]) -> AddressLookupTableAccount {
        let mut addresses = vec![
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
            self.pool,
            self.pool_authority,
            self.pool_vault,
            POOL_MINT,
            SPL_TOKEN,
            self.share(self.lender),
        ];
        addresses.extend_from_slice(destinations);
        self.f.create_lookup_table(addresses)
    }

    /// Compiles the borrow as the relay sends it (v0, the table, a compute-budget instruction,
    /// the sponsor the only signer), asserts its shape and that it fits one packet.
    fn borrow_v0(
        &mut self,
        table: &AddressLookupTableAccount,
        instructions: [Instruction; 2],
        destination: Pubkey,
    ) -> (VersionedTransaction, usize) {
        let [verify, borrow] = instructions;
        let tx = self.f.sponsored_v0(
            &[compute_unit_limit(), verify, borrow],
            std::slice::from_ref(table),
        );
        assert_eq!(tx.signatures.len(), 1, "the sponsor alone signs");
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
        assert_eq!(
            loaded(&lookup.writable_indexes),
            sorted(vec![
                self.loan,
                self.pool,
                self.share(self.lender),
                self.pool_vault,
                destination,
            ])
        );
        assert_eq!(
            loaded(&lookup.readonly_indexes),
            sorted(vec![
                self.f.protocol,
                self.owner,
                self.authority_of(Owner),
                self.lender,
                self.facility,
                self.lock,
                self.lot,
                self.valuation,
                self.pool_authority,
                POOL_MINT,
                SPL_TOKEN,
                INSTRUCTIONS_SYSVAR,
            ])
        );
        let size = transaction_size(&tx);
        assert!(
            size <= PACKET_DATA_SIZE,
            "borrow v0 transaction is {size} bytes"
        );
        (tx, size)
    }
}

#[test]
fn borrow_size_fits_v0_widest() {
    // The demo borrow, executed as the relay sends it, within the compute budget.
    let mut w = World::demo();
    w.deposit(Lender, LIMIT);
    let widest_destination = Pubkey::new_from_array([0xff; 32]);
    let table = w.borrow_table(&[w.ata(Owner), widest_destination]);
    let before = w.before();
    let instructions = w.borrow_instructions(w.borrow_accounts(w.ata(Owner)), LIMIT);
    let (tx, demo_size) = w.borrow_v0(&table, instructions, w.ata(Owner));
    let meta =
        w.f.send(tx)
            .unwrap_or_else(|failure| panic!("{:?}\n{}", failure.err, failure.meta.pretty_logs()));
    let units = meta.compute_units_consumed;
    assert!(
        units < u64::from(COMPUTE_UNIT_LIMIT),
        "borrow used {units} compute units"
    );
    w.assert_borrowed(&before, LIMIT, &meta);
    println!("borrow v0 demo: {demo_size} bytes, {units} CU");

    // The widest values, serialised only: two distinct 48-byte names, a 16-byte
    // lot id, loan index u32::MAX, amount and principal after u64::MAX at one decimal, a
    // 44-character destination, rate 10,000 bps, revision u64::MAX and valid_until i64::MAX.
    let owner = "Khunou Ore Exports And Allied Holdings Pty Ltd 1";
    let lender = "Lender One Bank And Allied Trade Finance Pty Ltd";
    let lot_id = "CR-0001-WIDEST-1";
    assert_eq!(owner.len(), MAX_DISPLAY_NAME);
    assert_eq!(lender.len(), MAX_DISPLAY_NAME);
    assert_ne!(owner, lender);
    assert_eq!(lot_id.len(), MAX_LOT_ID);
    assert_eq!(widest_destination.to_string().len(), 44);
    let text = borrow_message(
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
        &widest_destination,
        10_000,
        u64::MAX,
        i64::MAX,
    );
    assert_eq!(text.len(), 652);
    let verify = ed25519_instruction(&[(w.f.signer(Owner), text.as_slice())]);
    let borrow = ix(
        w.borrow_accounts(widest_destination),
        instruction::Borrow {
            amount: u64::MAX,
            expected_revision: u64::MAX,
            valid_until: i64::MAX,
        },
    );
    let (_, widest_size) = w.borrow_v0(&table, [verify, borrow], widest_destination);
    println!("borrow v0 widest: {widest_size} bytes");
}
