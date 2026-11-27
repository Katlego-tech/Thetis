//! Opening a lending facility and valuing collateral under it: `open_facility` and
//! `set_valuation`, plus the role/scope table and the pause bits the lending instructions add.
//!
//! The demo facility is in US dollar cents, valued at 20 c/kg with no haircut and a 60% LTV
//! limit, at 1,200 bps simple interest. Everything else (facility id, digests, expiries) is a
//! deterministic synthetic test input.

mod common;

use anchor_lang::{error::ErrorCode as AnchorError, prelude::Pubkey};
use common::{Actor::*, *};
use solana_transaction::Instruction;
use thetis::{accounts, error::ThetisError::*, events, instruction, state::*, ID};

const DAY: i64 = 86_400;
const HOUR: i64 = 3_600;
const LOT_VALIDITY: i64 = 30 * DAY;

const FACILITY_ID: [u8; 16] = [0x11; 16];
const OTHER_FACILITY_ID: [u8; 16] = [0x22; 16];
const USD: [u8; 3] = *b"USD";
const CENTS: u8 = 2;
const TERMS_VERSION: u32 = 1;
const RATE_BPS: u16 = 1_200;
const MAX_LTV_BPS: u16 = 6_000;
const TERMS_DIGEST: [u8; 32] = [0x7d; 32];

const CLASS_CODE: &str = "CHROME";
const OTHER_CLASS_CODE: &str = "MN";
const GRADES: [&str; 2] = ["A", "B"];
const GRADE: &str = "A";
const SITE_CODE: &str = "PORT-STOCKYARD";
const SITE_CAPACITY_KG: u64 = 5_000_000;
const VALUE_PER_KG: u64 = 20;
const HAIRCUT_BPS: u16 = 0;
const VALUATION_VALID_UNTIL: i64 = NOW + 30 * DAY;
const SOURCE_DIGEST: [u8; 32] = [0x5e; 32];

/// Organisation ids in the lending world.
const BORROWER_ID: u8 = 1;
const CUSTODIAN_ID: u8 = 2;
const LENDER_ID: u8 = 7;
const LENDER2_ID: u8 = 8;

/// Every scope bit of Phases 1 to 3, and bit 15, which no role holds, by its value.
const SCOPE_BITS: u16 = 16;

/// One `open_facility` call, with every input a test may vary.
#[derive(Clone)]
struct FacilityArgs {
    signer: Actor,
    authority: Pubkey,
    lender_org: Pubkey,
    borrower_org: Pubkey,
    pool: Option<Pubkey>,
    facility_id: [u8; 16],
    currency: [u8; 3],
    currency_decimals: u8,
    terms_version: u32,
    rate_bps: u16,
    max_ltv_bps: u16,
    terms_digest: [u8; 32],
}

/// One `set_valuation` call, with every input a test may vary.
#[derive(Clone)]
struct ValuationArgs {
    signer: Actor,
    authority: Pubkey,
    lender_org: Pubkey,
    facility: Pubkey,
    class_policy: Pubkey,
    custodian_class: Pubkey,
    grade: String,
    value_per_kg: u64,
    haircut_bps: u16,
    valid_until: i64,
    source_digest: [u8; 32],
}

/// A fiat-mode protocol with a borrower (Exporter), a custodian with one accredited chrome
/// site, and two lenders, each with one wallet delegated `LEND` for a day.
struct World {
    f: Fixture,
    borrower: Pubkey,
    custodian: Pubkey,
    lender: Pubkey,
    lender2: Pubkey,
    class_policy: Pubkey,
    custodian_class: Pubkey,
}

impl World {
    fn demo() -> Self {
        let mut f = Fixture::initialized();
        f.ok(
            f.register(Accreditor, CLASS_CODE, 1, &GRADES, LOT_VALIDITY),
            Accreditor,
        );
        let class_policy = f.class(CLASS_CODE, 1);

        let borrower = f.organisation(BORROWER_ID);
        let accredit = f.accredit(
            Accreditor,
            BORROWER_ID,
            Role::Exporter,
            "Khunou Ore Exports",
        );
        f.ok(accredit, Accreditor);
        let custodian = f.organisation(CUSTODIAN_ID);
        let accredit = f.accredit(
            Accreditor,
            CUSTODIAN_ID,
            Role::Custodian,
            "Kopano Stockyard Custody",
        );
        f.ok(accredit, Accreditor);
        let lender = f.organisation(LENDER_ID);
        let accredit = f.accredit(Accreditor, LENDER_ID, Role::Lender, "Lender One Bank");
        f.ok(accredit, Accreditor);
        let lender2 = f.organisation(LENDER2_ID);
        let accredit = f.accredit(Accreditor, LENDER2_ID, Role::Lender, "Lender Two Bank");
        f.ok(accredit, Accreditor);

        let accredit_site = f.accredit_site(
            Accreditor,
            custodian,
            class_policy,
            SITE_CODE,
            SITE_CAPACITY_KG,
        );
        f.ok(accredit_site, Accreditor);
        let custodian_class = f.site(custodian, class_policy, SITE_CODE);

        for (org, wallet) in [(lender, Lender), (lender2, Lender2)] {
            let delegate = f.delegate(OrgAdmin, org, f.key(wallet), scope::LEND, NOW + DAY);
            f.ok(delegate, OrgAdmin);
        }

        Self {
            f,
            borrower,
            custodian,
            lender,
            lender2,
            class_policy,
            custodian_class,
        }
    }

    fn authority_of(&self, actor: Actor) -> Pubkey {
        self.f.authority(self.f.key(actor))
    }

    fn facility(&self, lender_org: Pubkey, facility_id: [u8; 16]) -> (Pubkey, u8) {
        Pubkey::find_program_address(
            &[
                b"facility",
                self.f.protocol.as_ref(),
                lender_org.as_ref(),
                &facility_id,
            ],
            &ID,
        )
    }

    fn valuation(
        &self,
        facility: Pubkey,
        class_policy: Pubkey,
        grade: &str,
        custodian_class: Pubkey,
    ) -> (Pubkey, u8) {
        Pubkey::find_program_address(
            &[
                b"valuation",
                facility.as_ref(),
                class_policy.as_ref(),
                // Overlong malformed input has no valid PDA. The program must reject the field.
                &grade.as_bytes()[..grade.len().min(32)],
                custodian_class.as_ref(),
            ],
            &ID,
        )
    }

    fn pool(&self) -> (Pubkey, u8) {
        Pubkey::find_program_address(&[b"pool", self.f.protocol.as_ref()], &ID)
    }

    /// The demo facility: Lender One Bank lends to Khunou Ore Exports in USD cents.
    fn demo_facility(&self) -> FacilityArgs {
        FacilityArgs {
            signer: Lender,
            authority: self.authority_of(Lender),
            lender_org: self.lender,
            borrower_org: self.borrower,
            pool: None,
            facility_id: FACILITY_ID,
            currency: USD,
            currency_decimals: CENTS,
            terms_version: TERMS_VERSION,
            rate_bps: RATE_BPS,
            max_ltv_bps: MAX_LTV_BPS,
            terms_digest: TERMS_DIGEST,
        }
    }

    /// The demo valuation of chrome grade A at the custodian's site, under the demo facility.
    fn demo_valuation(&self) -> ValuationArgs {
        ValuationArgs {
            signer: Lender,
            authority: self.authority_of(Lender),
            lender_org: self.lender,
            facility: self.facility(self.lender, FACILITY_ID).0,
            class_policy: self.class_policy,
            custodian_class: self.custodian_class,
            grade: GRADE.into(),
            value_per_kg: VALUE_PER_KG,
            haircut_bps: HAIRCUT_BPS,
            valid_until: VALUATION_VALID_UNTIL,
            source_digest: SOURCE_DIGEST,
        }
    }

    fn open_facility(&self, args: &FacilityArgs) -> Instruction {
        ix(
            accounts::OpenFacility {
                lender: self.f.key(args.signer),
                payer: self.f.payer(),
                protocol: self.f.protocol,
                authority: args.authority,
                lender_org: args.lender_org,
                borrower_org: args.borrower_org,
                facility: self.facility(args.lender_org, args.facility_id).0,
                pool: args.pool,
                system_program: SYSTEM,
            },
            instruction::OpenFacility {
                facility_id: args.facility_id,
                currency: args.currency,
                currency_decimals: args.currency_decimals,
                terms_version: args.terms_version,
                rate_bps: args.rate_bps,
                max_ltv_bps: args.max_ltv_bps,
                terms_digest: args.terms_digest,
            },
        )
    }

    fn set_valuation(&self, args: &ValuationArgs) -> Instruction {
        ix(
            accounts::SetValuation {
                lender: self.f.key(args.signer),
                payer: self.f.payer(),
                protocol: self.f.protocol,
                authority: args.authority,
                lender_org: args.lender_org,
                facility: args.facility,
                class_policy: args.class_policy,
                custodian_class: args.custodian_class,
                valuation: self.valuation_address(args),
                system_program: SYSTEM,
            },
            instruction::SetValuation {
                grade: args.grade.clone(),
                value_per_kg: args.value_per_kg,
                haircut_bps: args.haircut_bps,
                valid_until: args.valid_until,
                source_digest: args.source_digest,
            },
        )
    }

    fn facility_address(&self, args: &FacilityArgs) -> Pubkey {
        self.facility(args.lender_org, args.facility_id).0
    }

    fn valuation_address(&self, args: &ValuationArgs) -> Pubkey {
        self.valuation(
            args.facility,
            args.class_policy,
            &args.grade,
            args.custodian_class,
        )
        .0
    }

    /// Opens `args` and checks the event and every stored field.
    fn open_facility_ok(&mut self, args: &FacilityArgs) -> Pubkey {
        let tx = self.f.ok(self.open_facility(args), args.signer);
        let (address, bump) = self.facility(args.lender_org, args.facility_id);
        assert_event(
            &tx,
            events::FacilityOpened {
                facility: address,
                lender: args.lender_org,
                borrower: args.borrower_org,
                currency: args.currency,
                currency_decimals: args.currency_decimals,
                terms_version: args.terms_version,
                rate_bps: args.rate_bps,
                max_ltv_bps: args.max_ltv_bps,
            },
        );
        let facility: Facility = self.f.read(address);
        assert_eq!(facility.protocol, self.f.protocol);
        assert_eq!(facility.lender, args.lender_org);
        assert_eq!(facility.borrower, args.borrower_org);
        assert_eq!(facility.facility_id, args.facility_id);
        assert_eq!(facility.currency, args.currency);
        assert_eq!(facility.currency_decimals, args.currency_decimals);
        assert_eq!(facility.terms_version, args.terms_version);
        assert_eq!(facility.rate_bps, args.rate_bps);
        assert_eq!(facility.max_ltv_bps, args.max_ltv_bps);
        assert_eq!(facility.terms_digest, args.terms_digest);
        assert_eq!(facility.loan_count, 0);
        assert_eq!(facility.bump, bump);
        assert_eq!(self.f.owner_and_data_len(address), Some((ID, 169)));
        address
    }

    /// Writes `args` and checks the event and every stored field, given the version and time
    /// the write must record.
    fn set_valuation_ok(&mut self, args: &ValuationArgs, version: u32, set_at: i64) -> Pubkey {
        let tx = self.f.ok(self.set_valuation(args), args.signer);
        let (address, bump) = self.valuation(
            args.facility,
            args.class_policy,
            &args.grade,
            args.custodian_class,
        );
        assert_event(
            &tx,
            events::ValuationSet {
                valuation: address,
                facility: args.facility,
                version,
                value_per_kg: args.value_per_kg,
                haircut_bps: args.haircut_bps,
                valid_until: args.valid_until,
                source_digest: args.source_digest,
                set_at,
            },
        );
        let valuation: Valuation = self.f.read(address);
        assert_eq!(valuation.protocol, self.f.protocol);
        assert_eq!(valuation.facility, args.facility);
        assert_eq!(valuation.class_policy, args.class_policy);
        assert_eq!(valuation.grade, args.grade);
        assert_eq!(valuation.custodian_class, args.custodian_class);
        assert_eq!(valuation.value_per_kg, args.value_per_kg);
        assert_eq!(valuation.haircut_bps, args.haircut_bps);
        assert_eq!(valuation.valid_until, args.valid_until);
        assert_eq!(valuation.source_digest, args.source_digest);
        assert_eq!(valuation.version, version);
        assert_eq!(valuation.set_at, set_at);
        assert_eq!(valuation.bump, bump);
        assert_eq!(self.f.owner_and_data_len(address), Some((ID, 211)));
        address
    }

    fn refuse_facility(&mut self, args: &FacilityArgs, expected: thetis::error::ThetisError) {
        let address = self.facility_address(args);
        let before = self.f.raw_account(address);
        self.f
            .refused(self.open_facility(args), args.signer, expected);
        assert_eq!(self.f.raw_account(address), before);
    }

    fn refuse_valuation(&mut self, args: &ValuationArgs, expected: thetis::error::ThetisError) {
        let address = self.valuation_address(args);
        let before = self.f.raw_account(address);
        self.f
            .refused(self.set_valuation(args), args.signer, expected);
        assert_eq!(self.f.raw_account(address), before);
    }

    /// Writes an Authority record at `signer`'s canonical Authority address whose stored wallet
    /// is `wallet`, so only the stored-wallet check can refuse it.
    fn forge_authority_for(&mut self, signer: Actor, organisation: Pubkey, wallet: Actor) {
        let (address, bump) = Pubkey::find_program_address(
            &[
                b"authority",
                self.f.protocol.as_ref(),
                self.f.key(signer).as_ref(),
            ],
            &ID,
        );
        let record = Authority {
            protocol: self.f.protocol,
            organisation,
            wallet: self.f.key(wallet),
            scopes: scope::LEND,
            expires_at: NOW + DAY,
            revoked_at: None,
            bump,
        };
        self.f.set_program_account(address, &record);
    }
}

#[test]
fn open_facility_and_set_valuation_demo_succeeds() {
    let mut w = World::demo();
    let args = w.demo_facility();
    let facility = w.open_facility_ok(&args);
    let stored: Facility = w.f.read(facility);
    assert_eq!(stored.currency, *b"USD");
    assert_eq!(stored.currency_decimals, 2);
    assert_eq!(stored.rate_bps, 1_200);
    assert_eq!(stored.max_ltv_bps, 6_000);

    let facility_before = w.f.raw_account(facility);
    let valuation = w.demo_valuation();
    let address = w.set_valuation_ok(&valuation, 1, NOW);
    let stored: Valuation = w.f.read(address);
    assert_eq!(stored.value_per_kg, 20);
    assert_eq!(stored.haircut_bps, 0);
    assert_eq!(stored.grade, "A");
    // Valuing collateral leaves the facility as it was.
    assert_eq!(w.f.raw_account(facility), facility_before);
}

#[test]
fn open_facility_rejects_non_lender() {
    let mut w = World::demo();
    // The borrower's own wallet, delegated the borrower's scope, opens a facility to itself.
    let delegate = w.f.delegate(
        OrgAdmin,
        w.borrower,
        w.f.key(Owner),
        scope::PLEDGE,
        NOW + DAY,
    );
    w.f.ok(delegate, OrgAdmin);
    let as_exporter = FacilityArgs {
        signer: Owner,
        authority: w.authority_of(Owner),
        lender_org: w.borrower,
        ..w.demo_facility()
    };
    // The role is checked before the scope, so the missing LEND bit is not what refuses it.
    w.refuse_facility(&as_exporter, WrongRole);

    // A non-lender wallet that names the lender's Authority fails the Authority seeds.
    let borrowed_authority = FacilityArgs {
        signer: Owner,
        ..w.demo_facility()
    };
    let address = w.facility_address(&borrowed_authority);
    w.f.refused_anchor(
        w.open_facility(&borrowed_authority),
        Owner,
        AnchorError::ConstraintSeeds,
    );
    assert!(!w.f.account_exists(address));

    // An Authority at the signer's own address that records the lender's wallet.
    w.forge_authority_for(Outsider, w.lender, Lender);
    let forged = FacilityArgs {
        signer: Outsider,
        authority: w.authority_of(Outsider),
        ..w.demo_facility()
    };
    w.refuse_facility(&forged, WrongSigner);

    assert!(!w.f.account_exists(w.facility(w.borrower, FACILITY_ID).0));
    assert!(!w.f.account_exists(w.facility(w.lender, FACILITY_ID).0));
}

#[test]
fn open_facility_rejects_borrower_not_exporter() {
    let mut w = World::demo();
    let mut borrowers = vec![w.custodian, w.lender2];
    for (id, role) in [
        (20, Role::Buyer),
        (21, Role::Transporter),
        (22, Role::Terminal),
        (23, Role::Inspector),
        (24, Role::DocumentIssuer),
    ] {
        borrowers.push(w.f.add_org(id, role));
    }
    for borrower_org in borrowers {
        let args = FacilityArgs {
            borrower_org,
            ..w.demo_facility()
        };
        w.refuse_facility(&args, WrongRole);
    }
    assert!(!w.f.account_exists(w.facility(w.lender, FACILITY_ID).0));
}

#[test]
fn open_facility_rejects_invalid_terms() {
    let mut w = World::demo();
    let demo = w.demo_facility();
    for args in [
        FacilityArgs {
            currency: *b"usd",
            ..demo.clone()
        },
        FacilityArgs {
            currency_decimals: 10,
            ..demo.clone()
        },
        FacilityArgs {
            max_ltv_bps: 0,
            ..demo.clone()
        },
        FacilityArgs {
            max_ltv_bps: 10_001,
            ..demo.clone()
        },
        FacilityArgs {
            rate_bps: 10_001,
            ..demo.clone()
        },
        FacilityArgs {
            terms_version: 0,
            ..demo.clone()
        },
        FacilityArgs {
            terms_digest: [0; 32],
            ..demo.clone()
        },
    ] {
        w.refuse_facility(&args, InvalidField);
    }
    assert!(!w.f.account_exists(w.facility_address(&demo)));

    // Each bound itself is accepted.
    w.open_facility_ok(&FacilityArgs {
        currency: *b"AZZ",
        currency_decimals: 0,
        rate_bps: 0,
        max_ltv_bps: 1,
        terms_version: 1,
        ..demo.clone()
    });
    w.open_facility_ok(&FacilityArgs {
        facility_id: OTHER_FACILITY_ID,
        currency: *b"ZZA",
        currency_decimals: 9,
        rate_bps: 10_000,
        max_ltv_bps: 10_000,
        terms_version: u32::MAX,
        ..demo
    });
}

#[test]
fn open_facility_rejects_pool_in_fiat_mode() {
    let mut w = World::demo();
    assert_eq!(
        w.f.read::<Protocol>(w.f.protocol).settlement_mode,
        SettlementMode::FiatAttestationTest
    );
    // A fiat instance cannot open a pool, so the harness writes one at the canonical address.
    let (pool, bump) = w.pool();
    let record = SimulationPool {
        protocol: w.f.protocol,
        mint: Pubkey::new_unique(),
        vault: Pubkey::new_unique(),
        currency: USD,
        currency_decimals: CENTS,
        cash_minor: 0,
        total_shares: 0,
        lent_minor: 0,
        income_minor: 0,
        revision: 0,
        bump,
    };
    w.f.set_program_account(pool, &record);
    assert_eq!(w.f.owner_and_data_len(pool), Some((ID, 149)));

    let args = FacilityArgs {
        pool: Some(pool),
        ..w.demo_facility()
    };
    w.refuse_facility(&args, InvalidField);
    assert!(!w.f.account_exists(w.facility_address(&args)));
}

#[test]
fn open_facility_currency_cannot_change() {
    let mut w = World::demo();
    let demo = w.demo_facility();
    let facility = w.open_facility_ok(&demo);
    let before = w.f.raw_account(facility);

    let reopen = FacilityArgs {
        currency: *b"ZAR",
        ..demo
    };
    w.f.already_initialized(w.open_facility(&reopen), reopen.signer);
    assert_eq!(w.f.raw_account(facility), before);
    let stored: Facility = w.f.read(facility);
    assert_eq!(stored.currency, USD);
    assert_eq!(stored.currency_decimals, CENTS);
}

#[test]
fn set_valuation_rejects_other_lender() {
    let mut w = World::demo();
    let facility = w.demo_facility();
    w.open_facility_ok(&facility);
    let demo = w.demo_valuation();
    let address = w.valuation_address(&demo);

    // Lender Two, with its own valid LEND Authority, values Lender One's facility.
    let own_org = ValuationArgs {
        signer: Lender2,
        authority: w.authority_of(Lender2),
        lender_org: w.lender2,
        ..demo.clone()
    };
    w.refuse_valuation(&own_org, WrongOrganisation);
    // The same, naming Lender One's organisation alongside Lender Two's Authority.
    let named_org = ValuationArgs {
        lender_org: w.lender,
        ..own_org.clone()
    };
    w.refuse_valuation(&named_org, WrongOrganisation);
    // Lender Two's wallet naming Lender One's Authority fails the Authority seeds.
    let borrowed_authority = ValuationArgs {
        signer: Lender2,
        ..demo.clone()
    };
    w.f.refused_anchor(
        w.set_valuation(&borrowed_authority),
        Lender2,
        AnchorError::ConstraintSeeds,
    );
    assert!(!w.f.account_exists(address));

    // Lender Two cannot overwrite the valuation Lender One has set.
    w.set_valuation_ok(&demo, 1, NOW);
    let before = w.f.raw_account(address);
    let overwrite = ValuationArgs {
        value_per_kg: u64::MAX,
        ..own_org.clone()
    };
    w.refuse_valuation(&overwrite, WrongOrganisation);

    // An Authority at Lender Two's address that records Lender One's wallet.
    w.forge_authority_for(Lender2, w.lender, Lender);
    let forged = ValuationArgs {
        signer: Lender2,
        authority: w.authority_of(Lender2),
        value_per_kg: u64::MAX,
        ..demo
    };
    w.refuse_valuation(&forged, WrongSigner);
    assert_eq!(w.f.raw_account(address), before);
    assert_eq!(w.f.read::<Valuation>(address).version, 1);
}

#[test]
fn set_valuation_rejects_past_valid_until() {
    let mut w = World::demo();
    let facility = w.demo_facility();
    w.open_facility_ok(&facility);
    let demo = w.demo_valuation();
    for valid_until in [NOW - 1, NOW] {
        w.refuse_valuation(
            &ValuationArgs {
                valid_until,
                ..demo.clone()
            },
            InvalidField,
        );
    }
    assert!(!w.f.account_exists(w.valuation_address(&demo)));
    w.set_valuation_ok(
        &ValuationArgs {
            valid_until: NOW + 1,
            ..demo
        },
        1,
        NOW,
    );
}

#[test]
fn set_valuation_rejects_bad_fields() {
    let mut w = World::demo();
    let facility = w.demo_facility();
    w.open_facility_ok(&facility);
    let demo = w.demo_valuation();
    for args in [
        ValuationArgs {
            grade: "C".into(),
            ..demo.clone()
        },
        ValuationArgs {
            grade: "a".into(),
            ..demo.clone()
        },
        ValuationArgs {
            value_per_kg: 0,
            ..demo.clone()
        },
        ValuationArgs {
            haircut_bps: 10_001,
            ..demo.clone()
        },
        ValuationArgs {
            source_digest: [0; 32],
            ..demo.clone()
        },
    ] {
        w.refuse_valuation(&args, InvalidField);
        assert!(!w.f.account_exists(w.valuation_address(&args)));
    }

    // The bounds themselves are accepted.
    w.set_valuation_ok(
        &ValuationArgs {
            value_per_kg: 1,
            haircut_bps: 10_000,
            ..demo
        },
        1,
        NOW,
    );
}

#[test]
fn set_valuation_rejects_class_site_mismatch() {
    let mut w = World::demo();
    let facility = w.demo_facility();
    w.open_facility_ok(&facility);
    w.f.ok(
        w.f.register(Accreditor, OTHER_CLASS_CODE, 1, &GRADES, LOT_VALIDITY),
        Accreditor,
    );
    let other_class = w.f.class(OTHER_CLASS_CODE, 1);
    let accredit_site = w.f.accredit_site(
        Accreditor,
        w.custodian,
        other_class,
        SITE_CODE,
        SITE_CAPACITY_KG,
    );
    w.f.ok(accredit_site, Accreditor);
    let other_site = w.f.site(w.custodian, other_class, SITE_CODE);
    assert_eq!(
        w.f.read::<CustodianClass>(other_site).class_policy,
        other_class
    );

    let demo = w.demo_valuation();
    for (class_policy, custodian_class) in [
        (w.class_policy, other_site),
        (other_class, w.custodian_class),
    ] {
        let args = ValuationArgs {
            class_policy,
            custodian_class,
            ..demo.clone()
        };
        w.refuse_valuation(&args, WrongOrganisation);
        assert!(!w.f.account_exists(w.valuation_address(&args)));
    }

    // The other class at its own site is a valid pair.
    w.set_valuation_ok(
        &ValuationArgs {
            class_policy: other_class,
            custodian_class: other_site,
            ..demo
        },
        1,
        NOW,
    );
}

#[test]
fn set_valuation_update_increments_version() {
    let mut w = World::demo();
    let facility_args = w.demo_facility();
    let facility = w.open_facility_ok(&facility_args);
    let first = w.demo_valuation();
    let address = w.set_valuation_ok(&first, 1, NOW);

    w.f.set_time(NOW + HOUR);
    let facility_before = w.f.raw_account(facility);
    let second = ValuationArgs {
        value_per_kg: 1,
        haircut_bps: 10_000,
        valid_until: NOW + 60 * DAY,
        source_digest: [0x6f; 32],
        ..first.clone()
    };
    assert_eq!(w.valuation_address(&second), address);
    // Checks the new payload, version 2, the new set_at, the unchanged identity fields and
    // bump at the same address, and the second ValuationSet event.
    assert_eq!(w.set_valuation_ok(&second, 2, NOW + HOUR), address);
    let stored: Valuation = w.f.read(address);
    assert_eq!(stored.protocol, w.f.protocol);
    assert_eq!(stored.facility, first.facility);
    assert_eq!(stored.class_policy, first.class_policy);
    assert_eq!(stored.grade, first.grade);
    assert_eq!(stored.custodian_class, first.custodian_class);
    assert_ne!(stored.value_per_kg, first.value_per_kg);
    assert_ne!(stored.source_digest, first.source_digest);
    assert_eq!(w.f.raw_account(facility), facility_before);
}

#[test]
fn lending_tx_rejects_revoked_expired_or_unscoped_authority() {
    // Revoked: the lender's wallet opened a facility, then its Authority was revoked.
    let mut w = World::demo();
    let facility = w.demo_facility();
    w.open_facility_ok(&facility);
    let revoke = w.f.revoke(OrgAdmin, w.lender, w.authority_of(Lender));
    w.f.ok(revoke, OrgAdmin);
    let second = FacilityArgs {
        facility_id: OTHER_FACILITY_ID,
        ..w.demo_facility()
    };
    w.refuse_facility(&second, AuthorityRevoked);
    let valuation = w.demo_valuation();
    w.refuse_valuation(&valuation, AuthorityRevoked);
    assert!(!w.f.account_exists(w.facility_address(&second)));
    assert!(!w.f.account_exists(w.valuation_address(&valuation)));

    // Expired: the clock reaches the Authority's expiry exactly.
    let mut w = World::demo();
    let facility = w.demo_facility();
    w.open_facility_ok(&facility);
    let expires_at = w.f.read::<Authority>(w.authority_of(Lender)).expires_at;
    assert_eq!(expires_at, NOW + DAY);
    w.f.set_time(expires_at);
    let second = FacilityArgs {
        facility_id: OTHER_FACILITY_ID,
        ..w.demo_facility()
    };
    w.refuse_facility(&second, AuthorityExpired);
    let valuation = w.demo_valuation();
    assert!(valuation.valid_until > expires_at);
    w.refuse_valuation(&valuation, AuthorityExpired);
    assert!(!w.f.account_exists(w.facility_address(&second)));
    assert!(!w.f.account_exists(w.valuation_address(&valuation)));

    // Unscoped: a second wallet of Lender One, really delegated POOL only.
    let mut w = World::demo();
    let facility = w.demo_facility();
    w.open_facility_ok(&facility);
    let delegate = w.f.delegate(
        OrgAdmin,
        w.lender,
        w.f.key(LenderTreasury),
        scope::POOL,
        NOW + DAY,
    );
    w.f.ok(delegate, OrgAdmin);
    assert_eq!(
        w.f.read::<Authority>(w.authority_of(LenderTreasury)).scopes,
        scope::POOL
    );
    let second = FacilityArgs {
        signer: LenderTreasury,
        authority: w.authority_of(LenderTreasury),
        facility_id: OTHER_FACILITY_ID,
        ..w.demo_facility()
    };
    w.refuse_facility(&second, ScopeMissing);
    let valuation = ValuationArgs {
        signer: LenderTreasury,
        authority: w.authority_of(LenderTreasury),
        ..w.demo_valuation()
    };
    w.refuse_valuation(&valuation, ScopeMissing);
    assert!(!w.f.account_exists(w.facility_address(&second)));
    assert!(!w.f.account_exists(w.valuation_address(&valuation)));
}

#[test]
fn delegate_authority_phase2_scope_table() {
    assert_eq!(scope::PLEDGE, 1 << 5);
    assert_eq!(scope::BUY, 1 << 6);
    assert_eq!(scope::LEND, 1 << 7);
    assert_eq!(scope::POOL, 1 << 8);

    let mut f = Fixture::initialized();
    let table = [
        (
            Role::Exporter,
            scope::TRANSFER | scope::SPLIT | scope::REDEEM | scope::PLEDGE | scope::SHIP,
        ),
        (
            Role::Buyer,
            scope::TRANSFER | scope::SPLIT | scope::REDEEM | scope::BUY | scope::SHIP,
        ),
        (
            Role::Custodian,
            scope::ISSUE | scope::REDEEM | scope::CARRY | scope::OBSERVE | scope::ATTEST_TRANSPORT,
        ),
        (Role::Transporter, scope::CARRY | scope::OBSERVE),
        (
            Role::Terminal,
            scope::CARRY | scope::OBSERVE | scope::LOAD | scope::ATTEST_TRANSPORT,
        ),
        (Role::Lender, scope::LEND | scope::POOL),
        (Role::Inspector, scope::OBSERVE | scope::INSPECT),
        (
            Role::DocumentIssuer,
            scope::ATTEST_ORIGIN | scope::ATTEST_TRANSPORT,
        ),
    ];
    let mut granted = 0;
    let mut refused = 0;
    for (index, (role, mask)) in table.into_iter().enumerate() {
        let org = f.add_org(index as u8, role);
        // Every single bit, the unknown bit 15 included, then the role's whole set.
        let cases = (0..SCOPE_BITS).map(|bit| 1_u16 << bit).chain([mask]);
        for scopes in cases.filter(|scopes| *scopes != 0) {
            let wallet = Pubkey::new_unique();
            let delegate = f.delegate(OrgAdmin, org, wallet, scopes, NOW + 1);
            if scopes & !mask == 0 {
                f.ok(delegate, OrgAdmin);
                assert_eq!(f.read::<Authority>(f.authority(wallet)).scopes, scopes);
                granted += 1;
            } else {
                f.refused(delegate, OrgAdmin, ScopeNotAllowed);
                assert!(!f.account_exists(f.authority(wallet)));
                refused += 1;
            }
        }
        // Zero scopes stays a field error, whatever the role.
        let wallet = Pubkey::new_unique();
        f.refused(
            f.delegate(OrgAdmin, org, wallet, 0, NOW + 1),
            OrgAdmin,
            InvalidField,
        );
    }
    // Single bits allowed: Exporter 5, Buyer 5, Custodian 5, Transporter 2, Terminal 4,
    // Lender 2, Inspector 2, DocumentIssuer 2; plus the whole set of each of the eight roles.
    assert_eq!(granted, 27 + 8);
    assert_eq!(refused, 8 * SCOPE_BITS as usize - 27);
    assert_eq!(refused, 101);
}

#[test]
fn pause_accepts_phase2_bits_and_rejects_unknown_bit() {
    assert_eq!(pause::PLEDGE, 1 << 4);
    assert_eq!(pause::ADVANCE, 1 << 5);
    assert_eq!(pause::RELEASE, 1 << 6);
    assert_eq!(pause::LIQUIDATE, 1 << 7);
    assert_eq!(pause::POOL, 1 << 8);
    assert_eq!(pause::ALL, 0xfff);

    let mut f = Fixture::initialized();
    for (flags, expected) in [
        (pause::PLEDGE, 0x010),
        (pause::ADVANCE, 0x030),
        (pause::RELEASE, 0x070),
        (pause::LIQUIDATE, 0x0f0),
        (pause::POOL, 0x1f0),
        (pause::ALL, 0xfff),
    ] {
        let tx = f.ok(f.change_pause(Admin, flags, true), Admin);
        assert_event(&tx, events::PauseChanged { flags: expected });
        assert_eq!(f.read::<Protocol>(f.protocol).pause_flags, expected);
    }

    // Bit 12, the first unknown bit, alone or with valid bits, is refused both ways and changes
    // nothing.
    for paused in [true, false] {
        for flags in [0x1000, 0x1001, 0x1010, 0x1fff, 0xffff] {
            f.refused(f.change_pause(Admin, flags, paused), Admin, InvalidField);
            assert_eq!(f.read::<Protocol>(f.protocol).pause_flags, 0xfff);
        }
    }

    for (flags, expected) in [(pause::PLEDGE | pause::POOL, 0xeef), (pause::ALL, 0)] {
        let tx = f.ok(f.change_pause(Admin, flags, false), Admin);
        assert_event(&tx, events::PauseChanged { flags: expected });
        assert_eq!(f.read::<Protocol>(f.protocol).pause_flags, expected);
    }
}

#[test]
fn open_facility_in_simulation_mode_binds_the_pool() {
    let mut w = World::demo();
    let mut protocol: Protocol = w.f.read(w.f.protocol);
    protocol.settlement_mode = SettlementMode::DevnetTokenSimulation;
    w.f.set_program_account(w.f.protocol, &protocol);
    let demo = w.demo_facility();

    // A simulation facility needs the instance's pool.
    w.refuse_facility(&demo, InvalidField);

    let (pool, bump) = w.pool();
    let mut record = SimulationPool {
        protocol: w.f.protocol,
        mint: Pubkey::new_unique(),
        vault: Pubkey::new_unique(),
        currency: *b"ZAR",
        currency_decimals: CENTS,
        cash_minor: 0,
        total_shares: 0,
        lent_minor: 0,
        income_minor: 0,
        revision: 0,
        bump,
    };
    let with_pool = FacilityArgs {
        pool: Some(pool),
        ..demo
    };
    // The pool is in another currency, then in the right currency at other decimals.
    for (currency, decimals) in [(*b"ZAR", CENTS), (USD, 6)] {
        record.currency = currency;
        record.currency_decimals = decimals;
        w.f.set_program_account(pool, &record);
        w.refuse_facility(&with_pool, CurrencyMismatch);
    }

    record.currency = USD;
    record.currency_decimals = CENTS;
    w.f.set_program_account(pool, &record);
    let facility = w.open_facility_ok(&with_pool);
    assert_eq!(w.f.read::<Facility>(facility).currency, USD);
}

#[test]
fn set_valuation_reuse_checks_the_stored_identity() {
    let mut w = World::demo();
    let facility = w.demo_facility();
    w.open_facility_ok(&facility);
    let demo = w.demo_valuation();
    let address = w.set_valuation_ok(&demo, 1, NOW);

    // A stored record that names another facility cannot be updated through this address.
    let mut stored: Valuation = w.f.read(address);
    stored.facility = Pubkey::new_unique();
    w.f.set_program_account(address, &stored);
    w.refuse_valuation(&demo, WrongOrganisation);
    assert_eq!(w.f.read::<Valuation>(address).version, 1);
}
