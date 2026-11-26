//! Bypass and mutation tests for the lending accounts and the simulation pool vault.
//!
//! Three kinds of attack, each refused by the current program:
//! - direct token-program calls against the pool vault (SPL Token) and against a pledged
//!   position's receipt vault (Token-2022), outside Thetis;
//! - every signed text altered one line at a time, then signed with the right key, so that only
//!   the text is wrong;
//! - every lending account a lending instruction reads, rewritten by the harness to name another
//!   protocol instance, one account at a time.
//!
//! Each refusal is checked for its exact error code and for the program that raised it, for no
//! event, and for a before/after comparison of every account the call could reach, so a refused
//! call costs the fee payer its fee and changes nothing else. Each test ends with the honest call
//! succeeding, which proves the refusals came from the one altered input.
//!
//! In the direct token calls, Alice is `Actor::Lender` for the pool vault (a `POOL` wallet of the
//! depositing lender) and `Actor::Owner` for the receipt vault (a wallet of the exporter that owns
//! the pledged position); Mallory is `Actor::Outsider`, a wallet with no Authority; for the
//! receipt vault the facility lender's wallet `Actor::Lender` attacks too.
//!
//! Demo money only: USD0.20/kg, haircut 0, LTV 60%, the 5,000 t lot CR-0001, 1,200 bps simple
//! interest, and USD600,000, USD400,000, USD210,000, USD30,000 and USD700,000, in cents on the
//! fiat instance and at 6 decimals on the simulation instance. The pool mint is a harness-written
//! SPL Token mint. The demo cast is synthetic; facility ids, payment identities, digests, site
//! codes and expiries are deterministic synthetic test inputs.

mod common;

use anchor_lang::{
    prelude::{pubkey, Pubkey},
    solana_program::program_pack::Pack,
    AccountDeserialize, AccountSerialize,
};
use anchor_spl::{
    associated_token::{
        get_associated_token_address_with_program_id,
        spl_associated_token_account::instruction::{
            create_associated_token_account, create_associated_token_account_idempotent,
        },
    },
    token::spl_token::{
        self,
        error::TokenError as SplTokenError,
        state::{Account as SplAccount, Mint as SplMint},
    },
    token_2022::spl_token_2022::{
        error::TokenError,
        extension::{BaseStateWithExtensions, StateWithExtensions},
        instruction::{self as token22, AuthorityType as Authority22},
        state::{Account as TokenAccount, AccountState, Mint},
    },
};
use common::{Actor::*, *};
use litesvm::types::TransactionMetadata;
use solana_transaction::{AccountMeta, Instruction, InstructionError, TransactionError};
use thetis::{
    accounts,
    error::ThetisError::{self, *},
    instruction,
    intent::message::{
        advance_message, borrow_message, buy_pledged_message, issue_message, pledge_message,
        release_intent_message, transfer_message,
    },
    state::*,
    ID,
};

const SPL_TOKEN: Pubkey = anchor_spl::token::ID;
const TOKEN_2022: Pubkey = anchor_spl::token_2022::ID;
const ASSOCIATED_TOKEN: Pubkey = anchor_spl::associated_token::ID;
const INSTRUCTIONS_SYSVAR: Pubkey = solana_sdk_ids::sysvar::instructions::ID;

const DAY: i64 = 86_400;
/// A fixed 365-day year, the accrual year.
const YEAR: i64 = 31_536_000;
const LOT_VALIDITY: i64 = 30 * DAY;
/// The Authorities are delegated, and the valuation is valid, for two years.
const AUTHORITY_LIFETIME: i64 = 2 * YEAR;
const VALUATION_VALIDITY: i64 = 2 * YEAR;
/// The signing window the money texts use, inside the 300 s money window.
const MONEY_WINDOW: i64 = 240;
/// The signing window the custody actions use, inside their 600 s window.
const CUSTODY_WINDOW: i64 = 570;

const CLASS_CODE: &str = "CHROME";
const GRADES: [&str; 2] = ["A", "B"];
const SITE_CODE: &str = "PORT-STOCKYARD";
const INTAKE_DIGEST: [u8; 32] = [0x0a; 32];
const SECOND_INTAKE_DIGEST: [u8; 32] = [0x0b; 32];
const SOURCE_DIGEST: [u8; 32] = [0x5e; 32];
const TERMS_DIGEST: [u8; 32] = [0x7d; 32];
/// The SHA-256 of the private bank evidence, as the lender's API would compute it.
const EVIDENCE_DIGEST: [u8; 32] = [0xe1; 32];

const USD: [u8; 3] = *b"USD";
const EUR: [u8; 3] = *b"EUR";
const CENTS: u8 = 2;
/// The pool mint's decimals.
const MICRO: u8 = 6;
const RATE_BPS: u16 = 1_200;
const MAX_LTV_BPS: u16 = 6_000;
/// USD0.20/kg, in cents.
const VALUE_CENTS_PER_KG: u64 = 20;
/// Lender One Bank's facility to Khunou Ore Exports.
const FACILITY_ONE: [u8; 16] = [0x11; 16];
/// Lender Two Bank's facility to Khunou Ore Exports.
const FACILITY_TWO: [u8; 16] = [0x22; 16];

const LOT_ID: &str = "CR-0001";
const OTHER_LOT_ID: &str = "CR-0002";
const LOT_KG: u64 = 5_000_000;
const TWO_THOUSAND_T: u64 = 2_000_000;

/// The demo amounts, in whole US dollars.
const USD_700K: u64 = 700_000;
const USD_600K: u64 = 600_000;
const USD_400K: u64 = 400_000;
const USD_210K: u64 = 210_000;
const USD_30K: u64 = 30_000;

const OWNER_ID: u8 = 1;
const CUSTODIAN_ID: u8 = 2;
const LENDER_ID: u8 = 7;
const LENDER2_ID: u8 = 8;
const BUYER_ID: u8 = 9;
const BUYER2_ID: u8 = 10;

const OWNER_NAME: &str = "Khunou Ore Exports";
const CUSTODIAN_NAME: &str = "Kopano Stockyard Custody";
const LENDER_NAME: &str = "Lender One Bank";
const LENDER2_NAME: &str = "Lender Two Bank";
const BUYER_NAME: &str = "Buyer Smelter Co";
const BUYER2_NAME: &str = "Second Buyer Smelting Co";

/// Another protocol instance's id, and another program of this workspace (the receipt spike):
/// the values the Program and Protocol lines are altered to.
const OTHER_INSTANCE: [u8; 16] = [2; 16];
const OTHER_PROGRAM: Pubkey = pubkey!("CBKfw6VcsKcQNXL5ZmjgsAu99qMswxreozhqBYeSUAqj");

/// Where an SPL Token account stores its owner.
const TOKEN_OWNER_OFFSET: usize = 32;

/// The pool mint and a second SPL Token mint, at fixed synthetic addresses.
const POOL_MINT: Pubkey = Pubkey::new_from_array([0x4d; 32]);
const OTHER_MINT: Pubkey = Pubkey::new_from_array([0x4e; 32]);

/// A deterministic synthetic payment identity: 32 bytes of `n`.
fn payment_id(n: u8) -> [u8; 32] {
    [n; 32]
}

fn accredit(f: &mut Fixture, id: u8, role: Role, name: &str) -> Pubkey {
    let accredit = f.accredit(Accreditor, id, role, name);
    f.ok(accredit, Accreditor);
    f.organisation(id)
}

/// The SPL Token associated token account of `wallet` for `mint`.
fn spl_ata(wallet: Pubkey, mint: Pubkey) -> Pubkey {
    get_associated_token_address_with_program_id(&wallet, &mint, &SPL_TOKEN)
}

/// The Token-2022 associated token account of `wallet` for `mint`.
fn ata_2022(wallet: Pubkey, mint: Pubkey) -> Pubkey {
    get_associated_token_address_with_program_id(&wallet, &mint, &TOKEN_2022)
}

fn other_protocol() -> Pubkey {
    pda(&[b"protocol", &OTHER_INSTANCE])
}

// --------------------------------------------------------------------- signed texts ----

/// Every input of the pledge text.
#[derive(Clone)]
struct PledgeText {
    program: Pubkey,
    instance: [u8; 16],
    lot_id: String,
    quantity_kg: u64,
    owner: String,
    lender: String,
    facility_id: [u8; 16],
    loan_index: u32,
    currency: [u8; 3],
    rate_bps: u16,
    max_ltv_bps: u16,
    terms_version: u32,
    expected_revision: u64,
    valid_until: i64,
}

impl PledgeText {
    fn bytes(&self) -> Vec<u8> {
        pledge_message(
            &self.program,
            &self.instance,
            &self.lot_id,
            self.quantity_kg,
            &self.owner,
            &self.lender,
            &self.facility_id,
            self.loan_index,
            &self.currency,
            self.rate_bps,
            self.max_ltv_bps,
            self.terms_version,
            self.expected_revision,
            self.valid_until,
        )
    }

    /// One text per builder argument, each with only that argument altered.
    fn altered(&self) -> Vec<(&'static str, Vec<u8>)> {
        let h = self;
        vec![
            (
                "Program",
                Self {
                    program: OTHER_PROGRAM,
                    ..h.clone()
                }
                .bytes(),
            ),
            (
                "Protocol",
                Self {
                    instance: OTHER_INSTANCE,
                    ..h.clone()
                }
                .bytes(),
            ),
            (
                "Lot",
                Self {
                    lot_id: OTHER_LOT_ID.into(),
                    ..h.clone()
                }
                .bytes(),
            ),
            (
                "Quantity",
                Self {
                    quantity_kg: TWO_THOUSAND_T,
                    ..h.clone()
                }
                .bytes(),
            ),
            (
                "Owner",
                Self {
                    owner: CUSTODIAN_NAME.into(),
                    ..h.clone()
                }
                .bytes(),
            ),
            (
                "Lender",
                Self {
                    lender: LENDER2_NAME.into(),
                    ..h.clone()
                }
                .bytes(),
            ),
            (
                "Facility",
                Self {
                    facility_id: FACILITY_TWO,
                    ..h.clone()
                }
                .bytes(),
            ),
            (
                "Loan",
                Self {
                    loan_index: h.loan_index + 1,
                    ..h.clone()
                }
                .bytes(),
            ),
            (
                "Currency",
                Self {
                    currency: EUR,
                    ..h.clone()
                }
                .bytes(),
            ),
            (
                "Rate",
                Self {
                    rate_bps: h.rate_bps + 1,
                    ..h.clone()
                }
                .bytes(),
            ),
            (
                "Max LTV",
                Self {
                    max_ltv_bps: h.max_ltv_bps + 1,
                    ..h.clone()
                }
                .bytes(),
            ),
            (
                "Terms",
                Self {
                    terms_version: h.terms_version + 1,
                    ..h.clone()
                }
                .bytes(),
            ),
            (
                "Revision",
                Self {
                    expected_revision: h.expected_revision + 1,
                    ..h.clone()
                }
                .bytes(),
            ),
            (
                "Valid until",
                Self {
                    valid_until: h.valid_until + 1,
                    ..h.clone()
                }
                .bytes(),
            ),
        ]
    }
}

/// Every input of the borrower's advance acceptance.
#[derive(Clone)]
struct AdvanceText {
    program: Pubkey,
    instance: [u8; 16],
    lot_id: String,
    owner: String,
    lender: String,
    facility_id: [u8; 16],
    loan_index: u32,
    amount: u64,
    principal_after: u64,
    currency: [u8; 3],
    decimals: u8,
    rate_bps: u16,
    terms_version: u32,
    expected_revision: u64,
    valid_until: i64,
}

impl AdvanceText {
    fn bytes(&self) -> Vec<u8> {
        advance_message(
            &self.program,
            &self.instance,
            &self.lot_id,
            &self.owner,
            &self.lender,
            &self.facility_id,
            self.loan_index,
            self.amount,
            self.principal_after,
            &self.currency,
            self.decimals,
            self.rate_bps,
            self.terms_version,
            self.expected_revision,
            self.valid_until,
        )
    }

    /// One text per builder argument; `other_amount` is the other demo figure for the money
    /// lines.
    fn altered(&self, other_amount: u64) -> Vec<(&'static str, Vec<u8>)> {
        let h = self;
        vec![
            (
                "Program",
                Self {
                    program: OTHER_PROGRAM,
                    ..h.clone()
                }
                .bytes(),
            ),
            (
                "Protocol",
                Self {
                    instance: OTHER_INSTANCE,
                    ..h.clone()
                }
                .bytes(),
            ),
            (
                "Lot",
                Self {
                    lot_id: OTHER_LOT_ID.into(),
                    ..h.clone()
                }
                .bytes(),
            ),
            (
                "Owner",
                Self {
                    owner: CUSTODIAN_NAME.into(),
                    ..h.clone()
                }
                .bytes(),
            ),
            (
                "Lender",
                Self {
                    lender: LENDER2_NAME.into(),
                    ..h.clone()
                }
                .bytes(),
            ),
            (
                "Facility",
                Self {
                    facility_id: FACILITY_TWO,
                    ..h.clone()
                }
                .bytes(),
            ),
            (
                "Loan",
                Self {
                    loan_index: h.loan_index + 1,
                    ..h.clone()
                }
                .bytes(),
            ),
            (
                "Advance",
                Self {
                    amount: other_amount,
                    ..h.clone()
                }
                .bytes(),
            ),
            (
                "Principal after",
                Self {
                    principal_after: other_amount,
                    ..h.clone()
                }
                .bytes(),
            ),
            (
                "Currency",
                Self {
                    currency: EUR,
                    ..h.clone()
                }
                .bytes(),
            ),
            (
                "Decimals",
                Self {
                    decimals: h.decimals + 1,
                    ..h.clone()
                }
                .bytes(),
            ),
            (
                "Rate",
                Self {
                    rate_bps: h.rate_bps + 1,
                    ..h.clone()
                }
                .bytes(),
            ),
            (
                "Terms",
                Self {
                    terms_version: h.terms_version + 1,
                    ..h.clone()
                }
                .bytes(),
            ),
            (
                "Revision",
                Self {
                    expected_revision: h.expected_revision + 1,
                    ..h.clone()
                }
                .bytes(),
            ),
            (
                "Valid until",
                Self {
                    valid_until: h.valid_until + 1,
                    ..h.clone()
                }
                .bytes(),
            ),
        ]
    }
}

/// Every input of the borrower's "Borrow test tokens" text.
#[derive(Clone)]
struct BorrowText {
    program: Pubkey,
    instance: [u8; 16],
    lot_id: String,
    owner: String,
    lender: String,
    facility_id: [u8; 16],
    loan_index: u32,
    amount: u64,
    principal_after: u64,
    currency: [u8; 3],
    decimals: u8,
    destination: Pubkey,
    rate_bps: u16,
    expected_revision: u64,
    valid_until: i64,
}

impl BorrowText {
    fn bytes(&self) -> Vec<u8> {
        borrow_message(
            &self.program,
            &self.instance,
            &self.lot_id,
            &self.owner,
            &self.lender,
            &self.facility_id,
            self.loan_index,
            self.amount,
            self.principal_after,
            &self.currency,
            self.decimals,
            &self.destination,
            self.rate_bps,
            self.expected_revision,
            self.valid_until,
        )
    }

    /// One text per builder argument; `other_amount` is the other demo figure for the money
    /// lines and `other_destination` another wallet's token account.
    fn altered(
        &self,
        other_amount: u64,
        other_destination: Pubkey,
    ) -> Vec<(&'static str, Vec<u8>)> {
        let h = self;
        vec![
            (
                "Program",
                Self {
                    program: OTHER_PROGRAM,
                    ..h.clone()
                }
                .bytes(),
            ),
            (
                "Protocol",
                Self {
                    instance: OTHER_INSTANCE,
                    ..h.clone()
                }
                .bytes(),
            ),
            (
                "Lot",
                Self {
                    lot_id: OTHER_LOT_ID.into(),
                    ..h.clone()
                }
                .bytes(),
            ),
            (
                "Owner",
                Self {
                    owner: CUSTODIAN_NAME.into(),
                    ..h.clone()
                }
                .bytes(),
            ),
            (
                "Lender",
                Self {
                    lender: LENDER2_NAME.into(),
                    ..h.clone()
                }
                .bytes(),
            ),
            (
                "Facility",
                Self {
                    facility_id: FACILITY_TWO,
                    ..h.clone()
                }
                .bytes(),
            ),
            (
                "Loan",
                Self {
                    loan_index: h.loan_index + 1,
                    ..h.clone()
                }
                .bytes(),
            ),
            (
                "Amount",
                Self {
                    amount: other_amount,
                    ..h.clone()
                }
                .bytes(),
            ),
            (
                "Principal after",
                Self {
                    principal_after: other_amount,
                    ..h.clone()
                }
                .bytes(),
            ),
            (
                "Currency",
                Self {
                    currency: EUR,
                    ..h.clone()
                }
                .bytes(),
            ),
            (
                "Decimals",
                Self {
                    decimals: h.decimals + 1,
                    ..h.clone()
                }
                .bytes(),
            ),
            (
                "Pay to",
                Self {
                    destination: other_destination,
                    ..h.clone()
                }
                .bytes(),
            ),
            (
                "Rate",
                Self {
                    rate_bps: h.rate_bps + 1,
                    ..h.clone()
                }
                .bytes(),
            ),
            (
                "Revision",
                Self {
                    expected_revision: h.expected_revision + 1,
                    ..h.clone()
                }
                .bytes(),
            ),
            (
                "Valid until",
                Self {
                    valid_until: h.valid_until + 1,
                    ..h.clone()
                }
                .bytes(),
            ),
        ]
    }
}

/// Every input of the seller's release intent and of the buyer's acceptance; `expires_at` is
/// only in the release intent.
#[derive(Clone)]
struct ReleaseText {
    program: Pubkey,
    instance: [u8; 16],
    lot_id: String,
    quantity_kg: u64,
    seller: String,
    buyer: String,
    lender: String,
    facility_id: [u8; 16],
    loan_index: u32,
    nonce: u64,
    price: u64,
    top_up: u64,
    currency: [u8; 3],
    decimals: u8,
    expires_at: i64,
    expected_revision: u64,
    valid_until: i64,
}

impl ReleaseText {
    fn intent_bytes(&self) -> Vec<u8> {
        release_intent_message(
            &self.program,
            &self.instance,
            &self.lot_id,
            self.quantity_kg,
            &self.seller,
            &self.buyer,
            &self.lender,
            &self.facility_id,
            self.loan_index,
            self.nonce,
            self.price,
            self.top_up,
            &self.currency,
            self.decimals,
            self.expires_at,
            self.expected_revision,
            self.valid_until,
        )
    }

    fn acceptance_bytes(&self) -> Vec<u8> {
        buy_pledged_message(
            &self.program,
            &self.instance,
            &self.lot_id,
            self.quantity_kg,
            &self.seller,
            &self.buyer,
            &self.lender,
            &self.facility_id,
            self.loan_index,
            self.nonce,
            self.price,
            self.top_up,
            &self.currency,
            self.decimals,
            self.expected_revision,
            self.valid_until,
        )
    }

    /// One altered copy per builder argument, each with only that argument changed; the
    /// intent's expiry only when `with_expiry`. `other_price` and `other_top_up` are other demo
    /// figures.
    fn altered(
        &self,
        other_price: u64,
        other_top_up: u64,
        with_expiry: bool,
    ) -> Vec<(&'static str, Self)> {
        let h = self;
        let mut altered = vec![
            (
                "Program",
                Self {
                    program: OTHER_PROGRAM,
                    ..h.clone()
                },
            ),
            (
                "Protocol",
                Self {
                    instance: OTHER_INSTANCE,
                    ..h.clone()
                },
            ),
            (
                "Lot",
                Self {
                    lot_id: OTHER_LOT_ID.into(),
                    ..h.clone()
                },
            ),
            (
                "Quantity",
                Self {
                    quantity_kg: LOT_KG,
                    ..h.clone()
                },
            ),
            (
                "Seller",
                Self {
                    seller: CUSTODIAN_NAME.into(),
                    ..h.clone()
                },
            ),
            (
                "Buyer",
                Self {
                    buyer: BUYER2_NAME.into(),
                    ..h.clone()
                },
            ),
            (
                "Lender",
                Self {
                    lender: LENDER2_NAME.into(),
                    ..h.clone()
                },
            ),
            (
                "Facility",
                Self {
                    facility_id: FACILITY_TWO,
                    ..h.clone()
                },
            ),
            (
                "Loan",
                Self {
                    loan_index: h.loan_index + 1,
                    ..h.clone()
                },
            ),
            (
                "Intent",
                Self {
                    nonce: h.nonce + 1,
                    ..h.clone()
                },
            ),
            (
                "Price",
                Self {
                    price: other_price,
                    ..h.clone()
                },
            ),
            (
                "Top-up",
                Self {
                    top_up: other_top_up,
                    ..h.clone()
                },
            ),
            (
                "Currency",
                Self {
                    currency: EUR,
                    ..h.clone()
                },
            ),
            (
                "Decimals",
                Self {
                    decimals: h.decimals + 1,
                    ..h.clone()
                },
            ),
            (
                "Revision",
                Self {
                    expected_revision: h.expected_revision + 1,
                    ..h.clone()
                },
            ),
            (
                "Valid until",
                Self {
                    valid_until: h.valid_until + 1,
                    ..h.clone()
                },
            ),
        ];
        if with_expiry {
            altered.push((
                "Intent expires",
                Self {
                    expires_at: h.expires_at + 1,
                    ..h.clone()
                },
            ));
        }
        altered
    }
}

/// Replaces the last byte of line `index` with another printable byte.
fn edit_line(text: &[u8], index: usize) -> Vec<u8> {
    let mut lines: Vec<Vec<u8>> = text
        .split(|byte| *byte == b'\n')
        .map(<[u8]>::to_vec)
        .collect();
    let line = &mut lines[index];
    let last = line.last_mut().unwrap();
    *last = if *last == b'X' { b'Y' } else { b'X' };
    lines.join(&b'\n')
}

/// The structural alterations of a text: a line dropped, a line duplicated, two lines swapped
/// and a trailing newline.
fn structural(text: &[u8]) -> Vec<(&'static str, Vec<u8>)> {
    let lines: Vec<&[u8]> = text.split(|byte| *byte == b'\n').collect();
    let last_field = lines.len() - 3;
    let dropped: Vec<&[u8]> = lines
        .iter()
        .enumerate()
        .filter(|(index, _)| *index != last_field)
        .map(|(_, line)| *line)
        .collect();
    let mut duplicated = lines.clone();
    duplicated.insert(5, lines[5]);
    let mut swapped = lines.clone();
    swapped.swap(5, 6);
    let mut trailing = text.to_vec();
    trailing.push(b'\n');
    vec![
        ("last field line dropped", dropped.join(&b'\n')),
        ("first field line duplicated", duplicated.join(&b'\n')),
        ("first two field lines swapped", swapped.join(&b'\n')),
        ("trailing newline", trailing),
    ]
}

/// Every altered copy of `honest`: one per builder argument (`arguments`), a one-byte edit of
/// each line no argument sets (the title, `Network:`, `Action:` and the notice), and the
/// structural alterations. Asserts each differs from the honest text and from every other, that
/// every line of the honest text is altered by at least one copy, and that the envelope is the
/// shared one.
fn mutants(honest: &[u8], arguments: Vec<(&'static str, Vec<u8>)>) -> Vec<(String, Vec<u8>)> {
    let lines: Vec<&[u8]> = honest.split(|byte| *byte == b'\n').collect();
    assert_eq!(lines[0], b"Thetis authorisation v1");
    assert_eq!(lines[1], b"Network: devnet");
    assert!(lines[4].starts_with(b"Action: "));
    assert!(lines[lines.len() - 2].starts_with(b"Valid until: "));
    assert_eq!(
        lines[lines.len() - 1],
        b"Test network only. Synthetic data."
    );

    let mut all: Vec<(String, Vec<u8>)> = arguments
        .into_iter()
        .map(|(label, text)| (format!("{label} altered"), text))
        .collect();
    for (label, index) in [
        ("title", 0),
        ("Network", 1),
        ("Action", 4),
        ("notice", lines.len() - 1),
    ] {
        all.push((format!("{label} line edited"), edit_line(honest, index)));
    }
    all.extend(
        structural(honest)
            .into_iter()
            .map(|(label, text)| (label.to_string(), text)),
    );

    for (index, (label, text)) in all.iter().enumerate() {
        assert_ne!(text.as_slice(), honest, "{label} is not altered");
        for (other_label, other) in &all[index + 1..] {
            assert_ne!(text, other, "{label} and {other_label} are the same text");
        }
    }
    for (index, line) in lines.iter().enumerate() {
        let covered = all.iter().any(|(_, text)| {
            let altered: Vec<&[u8]> = text.split(|byte| *byte == b'\n').collect();
            altered.len() == lines.len() && altered[index] != *line
        });
        assert!(
            covered,
            "line {index} ({}) is never altered",
            String::from_utf8_lossy(line)
        );
    }
    all
}

// --------------------------------------------------------- mismatched accounts ----

/// Real accounts of the same protocol that a mismatch case names instead of the honest ones:
/// the second lot CR-0002 and the owner's position in it, Lender Two Bank's facility and its
/// loan 0 on CR-0002, and CHROME version 2 with its site at the custodian.
#[derive(Clone, Copy)]
struct Others {
    lot: Pubkey,
    position: Pubkey,
    facility: Pubkey,
    loan: Pubkey,
    class_policy: Pubkey,
    custodian_class: Pubkey,
}

/// A change the harness writes into one stored account.
type Rewrite = Box<dyn Fn(&mut Fixture)>;
/// How a case sends the instruction, when it differs from the honest call.
type SendWith = Box<dyn Fn(&World) -> Call>;

/// One single-fault case: the stored accounts it rewrites (each written back afterwards), the
/// call it sends instead of the honest one, if any, and the error it must get.
struct Mismatch {
    name: &'static str,
    rewrites: Vec<(Pubkey, Rewrite)>,
    call: Option<SendWith>,
    expected: ThetisError,
}

impl Mismatch {
    fn new(name: &'static str, expected: ThetisError) -> Self {
        Self {
            name,
            rewrites: Vec::new(),
            call: None,
            expected,
        }
    }

    /// Rewrites one field of the stored `T` at `account`.
    fn set<T: AccountSerialize + AccountDeserialize + 'static>(
        mut self,
        account: Pubkey,
        change: impl Fn(&mut T) + 'static,
    ) -> Self {
        let rewrite: Rewrite = Box::new(move |f: &mut Fixture| {
            let mut value: T = f.read(account);
            change(&mut value);
            f.set_program_account(account, &value);
        });
        self.rewrites.push((account, rewrite));
        self
    }

    /// Hands `account`, data unchanged, to another owning program.
    fn owned_by(mut self, account: Pubkey, owner: Pubkey) -> Self {
        let rewrite: Rewrite = Box::new(move |f: &mut Fixture| {
            let data = f.raw_account(account).unwrap().data;
            f.set_foreign_account(account, owner, data);
        });
        self.rewrites.push((account, rewrite));
        self
    }

    /// Writes `value` over the 32 bytes at `offset` of `account`, keeping its owning program:
    /// the owner field of a token account, say.
    fn bytes_at(mut self, account: Pubkey, offset: usize, value: Pubkey) -> Self {
        let rewrite: Rewrite = Box::new(move |f: &mut Fixture| {
            let original = f.raw_account(account).unwrap();
            let mut data = original.data;
            data[offset..offset + 32].copy_from_slice(value.as_ref());
            f.set_foreign_account(account, original.owner, data);
        });
        self.rewrites.push((account, rewrite));
        self
    }

    /// Sends `call` instead of the honest call.
    fn send(mut self, call: impl Fn(&World) -> Call + 'static) -> Self {
        self.call = Some(Box::new(call));
        self
    }
}

/// `call` with every slot of its last instruction that names `from` naming `to` instead; `from`
/// must appear exactly once.
fn swap(call: Call, from: Pubkey, to: Pubkey) -> Call {
    let (mut instructions, actor) = match call {
        Call::Sponsored(instructions) => (instructions, None),
        Call::Signed(instructions, actor) => (instructions, Some(actor)),
    };
    let last = instructions.last_mut().unwrap();
    let slots: Vec<usize> = (0..last.accounts.len())
        .filter(|&slot| last.accounts[slot].pubkey == from)
        .collect();
    assert_eq!(slots.len(), 1, "{from} is passed exactly once");
    last.accounts[slots[0]].pubkey = to;
    match actor {
        None => Call::Sponsored(instructions),
        Some(actor) => Call::Signed(instructions, actor),
    }
}

// ------------------------------------------------------------------------- the world ----

/// How a lending instruction is sent: relayed by the sponsor alone (a signed text), or signed by
/// a wallet next to the sponsor.
enum Call {
    Sponsored(Vec<Instruction>),
    Signed(Vec<Instruction>, Actor),
}

/// A protocol instance in either settlement mode with the stored chrome lot CR-0001 (5,000 t of
/// grade A at the lot's site) held by Khunou Ore Exports; Lender One Bank and Lender Two Bank;
/// Buyer Smelter Co and Second Buyer Smelting Co; the custodian Kopano Stockyard Custody.
/// Authorities, valid for two years: the Owner `PLEDGE | TRANSFER`, each lender `LEND` (and
/// `POOL` on the simulation instance), Buyer `BUY`, the custodian `ISSUE`. On the simulation
/// instance: the pool on a harness-written 6-decimal SPL Token mint with no freeze authority,
/// and USD700,000 of test tokens each for Lender One, Lender Two and Outsider.
struct World {
    f: Fixture,
    /// The clock, mirrored here so texts are signed relative to it.
    now: i64,
    decimals: u8,
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
    pool: Pubkey,
    pool_authority: Pubkey,
    pool_vault: Pubkey,
}

impl World {
    fn new(mode: SettlementMode) -> Self {
        let simulation = mode == SettlementMode::DevnetTokenSimulation;
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
        let buyer = accredit(&mut f, BUYER_ID, Role::Buyer, BUYER_NAME);
        accredit(&mut f, BUYER2_ID, Role::Buyer, BUYER2_NAME);

        // Room for two 5,000 t lots.
        let accredit_site =
            f.accredit_site(Accreditor, custodian, class_policy, SITE_CODE, 2 * LOT_KG);
        f.ok(accredit_site, Accreditor);
        let custodian_class = f.site(custodian, class_policy, SITE_CODE);

        let lending = if simulation {
            scope::LEND | scope::POOL
        } else {
            scope::LEND
        };
        let expires_at = NOW + AUTHORITY_LIFETIME;
        for (org, wallet, scopes) in [
            (custodian, Custodian, scope::ISSUE),
            (owner, Owner, scope::PLEDGE | scope::TRANSFER),
            (lender, Lender, lending),
            (lender2, Lender2, lending),
            (buyer, Buyer, scope::BUY),
        ] {
            let delegate = f.delegate(OrgAdmin, org, f.key(wallet), scopes, expires_at);
            f.ok(delegate, OrgAdmin);
        }

        let protocol = f.protocol;
        let facility = pda(&[
            b"facility",
            protocol.as_ref(),
            lender.as_ref(),
            &FACILITY_ONE,
        ]);
        let loan = pda(&[b"loan", facility.as_ref(), &0_u32.to_le_bytes()]);
        let lock = pda(&[b"lock", loan.as_ref()]);
        let lot = pda(&[b"lot", protocol.as_ref(), LOT_ID.as_bytes()]);
        let pool = pda(&[b"pool", protocol.as_ref()]);
        let pool_authority = pda(&[b"pool_authority", pool.as_ref()]);
        let valuation = pda(&[
            b"valuation",
            facility.as_ref(),
            class_policy.as_ref(),
            GRADES[0].as_bytes(),
            custodian_class.as_ref(),
        ]);
        let mut world = Self {
            f,
            now: NOW,
            decimals: if simulation { MICRO } else { CENTS },
            owner,
            custodian,
            lender,
            lender2,
            buyer,
            class_policy,
            custodian_class,
            lot,
            position: pda(&[b"position", lot.as_ref(), owner.as_ref()]),
            facility,
            valuation,
            loan,
            lock,
            pool,
            pool_authority,
            pool_vault: spl_ata(pool_authority, POOL_MINT),
        };
        world.issue_lot();
        if simulation {
            world.write_pool_mint();
            for actor in [Lender, Lender2, Outsider, Owner] {
                world.create_spl_ata(actor);
            }
            for actor in [Lender, Lender2, Outsider] {
                let account = world.ata(actor);
                world.mint_pool_tokens(account, world.usd(USD_700K));
            }
            world.open_pool();
        }
        world
    }

    /// The fiat world with Lender One's facility and valuation, nothing pledged.
    fn fiat_lending() -> Self {
        let mut w = Self::new(SettlementMode::FiatAttestationTest);
        w.open_lending();
        w
    }

    /// The fiat demo: the whole lot pledged as loan 0 and USD600,000 advanced at `NOW`.
    fn fiat_demo() -> Self {
        let mut w = Self::fiat_lending();
        w.pledge_whole_lot();
        w.advance_ok(w.usd(USD_600K));
        w
    }

    /// The simulation world with Lender One's facility and valuation and the whole lot pledged as
    /// loan 0; nothing deposited.
    fn pool_demo() -> Self {
        let mut w = Self::new(SettlementMode::DevnetTokenSimulation);
        w.open_lending();
        w.pledge_whole_lot();
        w
    }

    /// `dollars` in the instance's minor units.
    fn usd(&self, dollars: u64) -> u64 {
        dollars * 10_u64.pow(u32::from(self.decimals))
    }

    fn simulation(&self) -> bool {
        self.decimals == MICRO
    }

    fn authority_of(&self, actor: Actor) -> Pubkey {
        self.f.authority(self.f.key(actor))
    }

    fn advance_to(&mut self, unix_timestamp: i64) {
        self.now = unix_timestamp;
        self.f.set_time(unix_timestamp);
    }

    fn lot_mint(&self) -> Pubkey {
        pda(&[b"mint", self.lot.as_ref()])
    }

    fn mint_authority(&self) -> Pubkey {
        pda(&[b"mint_authority", self.lot_mint().as_ref()])
    }

    fn position_of(&self, organisation: Pubkey) -> Pubkey {
        pda(&[b"position", self.lot.as_ref(), organisation.as_ref()])
    }

    fn vault_authority(position: Pubkey) -> Pubkey {
        pda(&[b"vault", position.as_ref()])
    }

    /// An organisation's receipt vault for the lot.
    fn vault_of(&self, organisation: Pubkey) -> Pubkey {
        ata_2022(
            Self::vault_authority(self.position_of(organisation)),
            self.lot_mint(),
        )
    }

    /// A wallet's own Token-2022 account for the lot's receipts (not a vault).
    fn personal_ata(&self, actor: Actor) -> Pubkey {
        ata_2022(self.f.key(actor), self.lot_mint())
    }

    /// A wallet's pool-mint ATA.
    fn ata(&self, actor: Actor) -> Pubkey {
        spl_ata(self.f.key(actor), POOL_MINT)
    }

    fn share(&self, organisation: Pubkey) -> Pubkey {
        pda(&[b"pool_share", self.pool.as_ref(), organisation.as_ref()])
    }

    fn display_name(&self, organisation: Pubkey) -> String {
        self.f.read::<Organisation>(organisation).display_name
    }

    fn payment_key(&self, payment: u8) -> Pubkey {
        pda(&[
            b"payment",
            self.f.protocol.as_ref(),
            self.lender.as_ref(),
            &payment_id(payment),
        ])
    }

    fn intent_key(&self, nonce: u64) -> Pubkey {
        pda(&[b"release", self.loan.as_ref(), &nonce.to_le_bytes()])
    }

    // ----------------------------------------------------------------- sending ----

    fn call_ok(&mut self, call: Call) -> TransactionMetadata {
        match call {
            Call::Sponsored(instructions) => self.f.sponsored_ok(&instructions),
            Call::Signed(instructions, actor) => self.f.signed_ok(&instructions, actor),
        }
    }

    /// The call's last instruction must fail with `expected`, with no state change and no event.
    fn call_refused(&mut self, call: Call, expected: ThetisError) {
        match call {
            Call::Sponsored(instructions) => {
                let index = u8::try_from(instructions.len() - 1).unwrap();
                self.f.sponsored_refused(&instructions, index, expected);
            }
            Call::Signed(instructions, actor) => {
                let index = u8::try_from(instructions.len() - 1).unwrap();
                self.f.signed_refused(&instructions, actor, index, expected);
            }
        }
    }

    // ------------------------------------------------------------------- tokens ----

    /// The pool mint: an initialised 6-decimal SPL Token mint, the sponsor its mint authority,
    /// with no freeze authority (asserted).
    fn write_pool_mint(&mut self) {
        let data = mint_data(Some(self.f.payer()), 0, MICRO);
        self.f.set_foreign_account(POOL_MINT, SPL_TOKEN, data);
        let mint = self.pool_mint_state();
        assert!(mint.is_initialized);
        assert_eq!(mint.decimals, MICRO);
        assert_eq!(
            Option::<Pubkey>::from(mint.mint_authority),
            Some(self.f.payer())
        );
        assert_eq!(Option::<Pubkey>::from(mint.freeze_authority), None);
    }

    fn pool_mint_state(&self) -> SplMint {
        assert_eq!(self.f.owner(POOL_MINT), Some(SPL_TOKEN));
        SplMint::unpack(&self.f.data(POOL_MINT)).unwrap()
    }

    fn spl_account(&self, address: Pubkey) -> SplAccount {
        assert_eq!(self.f.owner(address), Some(SPL_TOKEN));
        SplAccount::unpack(&self.f.data(address)).unwrap()
    }

    fn create_spl_ata(&mut self, actor: Actor) {
        let payer = self.f.payer();
        let create = create_associated_token_account_idempotent(
            &payer,
            &self.f.key(actor),
            &POOL_MINT,
            &SPL_TOKEN,
        );
        self.f.sponsored_ok(&[create]);
    }

    /// The sponsor, the pool mint's authority, mints `amount` into `account`.
    fn mint_pool_tokens(&mut self, account: Pubkey, amount: u64) {
        let payer = self.f.payer();
        let mint_to =
            spl_token::instruction::mint_to(&SPL_TOKEN, &POOL_MINT, &account, &payer, &[], amount)
                .unwrap();
        self.f.sponsored_ok(&[mint_to]);
    }

    // ------------------------------------------------------------------- set-up ----

    fn issue_lot(&mut self) {
        let (lot, position) = self.issue_lot_as(LOT_ID, INTAKE_DIGEST);
        assert_eq!((lot, position), (self.lot, self.position));
    }

    /// Issues a 5,000 t grade A lot at the lot's site to the owner. Returns (lot, position).
    fn issue_lot_as(&mut self, lot_id: &str, intake_digest: [u8; 32]) -> (Pubkey, Pubkey) {
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
        let mint = pda(&[b"mint", lot.as_ref()]);
        let vault = ata_2022(Self::vault_authority(position), mint);
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
                vault,
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
        assert_eq!(self.f.token_amount(vault), LOT_KG);
        (lot, position)
    }

    fn open_pool(&mut self) {
        let open = ix(
            accounts::OpenPool {
                admin: self.f.key(Admin),
                payer: self.f.payer(),
                protocol: self.f.protocol,
                pool: self.pool,
                pool_authority: self.pool_authority,
                mint: POOL_MINT,
                pool_vault: self.pool_vault,
                token_program: SPL_TOKEN,
                associated_token_program: ASSOCIATED_TOKEN,
                system_program: SYSTEM,
            },
            instruction::OpenPool { currency: USD },
        );
        self.f.signed_ok(&[open], Admin);
        let pool: SimulationPool = self.f.read(self.pool);
        assert_eq!((pool.mint, pool.vault), (POOL_MINT, self.pool_vault));
        let vault = self.spl_account(self.pool_vault);
        assert_eq!((vault.mint, vault.owner), (POOL_MINT, self.pool_authority));
    }

    /// Lender One's USD facility to Khunou Ore Exports at 1,200 bps and 60%, naming the pool on
    /// the simulation instance.
    fn open_facility_call(&self) -> Call {
        self.facility_call(Lender, self.lender, FACILITY_ONE)
    }

    /// `actor`'s USD facility for `lender_org` to Khunou Ore Exports at 1,200 bps and 60%.
    fn facility_call(&self, actor: Actor, lender_org: Pubkey, facility_id: [u8; 16]) -> Call {
        let open = ix(
            accounts::OpenFacility {
                lender: self.f.key(actor),
                payer: self.f.payer(),
                protocol: self.f.protocol,
                authority: self.authority_of(actor),
                lender_org,
                borrower_org: self.owner,
                facility: Self::facility_key(&self.f, lender_org, facility_id),
                pool: self.simulation().then_some(self.pool),
                system_program: SYSTEM,
            },
            instruction::OpenFacility {
                facility_id,
                currency: USD,
                currency_decimals: self.decimals,
                terms_version: 1,
                rate_bps: RATE_BPS,
                max_ltv_bps: MAX_LTV_BPS,
                terms_digest: TERMS_DIGEST,
            },
        );
        Call::Signed(vec![open], actor)
    }

    fn facility_key(f: &Fixture, lender_org: Pubkey, facility_id: [u8; 16]) -> Pubkey {
        pda(&[
            b"facility",
            f.protocol.as_ref(),
            lender_org.as_ref(),
            &facility_id,
        ])
    }

    /// Lender One's grade-A valuation at the lot's site: USD0.20/kg, haircut 0.
    fn set_valuation_call(&self, valid_until: i64) -> Call {
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
                valuation: self.valuation,
                system_program: SYSTEM,
            },
            instruction::SetValuation {
                grade: GRADES[0].into(),
                value_per_kg: VALUE_CENTS_PER_KG * 10_u64.pow(u32::from(self.decimals - CENTS)),
                haircut_bps: 0,
                valid_until,
                source_digest: SOURCE_DIGEST,
            },
        );
        Call::Signed(vec![set], Lender)
    }

    fn open_lending(&mut self) {
        let open = self.open_facility_call();
        self.call_ok(open);
        let set = self.set_valuation_call(NOW + VALUATION_VALIDITY);
        self.call_ok(set);
        assert_eq!(self.f.read::<Valuation>(self.valuation).version, 1);
    }

    // ------------------------------------------------------------------- pledge ----

    /// The honest pledge text: the whole lot as loan 0 at position revision 0.
    fn pledge_text(&self) -> PledgeText {
        PledgeText {
            program: ID,
            instance: INSTANCE,
            lot_id: LOT_ID.into(),
            quantity_kg: LOT_KG,
            owner: OWNER_NAME.into(),
            lender: LENDER_NAME.into(),
            facility_id: FACILITY_ONE,
            loan_index: 0,
            currency: USD,
            rate_bps: RATE_BPS,
            max_ltv_bps: MAX_LTV_BPS,
            terms_version: 1,
            expected_revision: 0,
            valid_until: self.now + MONEY_WINDOW,
        }
    }

    fn pledge_instruction(&self, text: &PledgeText) -> Instruction {
        ix(
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
                loan_index: text.loan_index,
                quantity_kg: text.quantity_kg,
                expected_revision: text.expected_revision,
                valid_until: text.valid_until,
            },
        )
    }

    /// Both parties sign `signed` (one shared copy); the instruction carries `args`' values.
    fn pledge_call(&self, args: &PledgeText, signed: &[u8]) -> Call {
        let signers = [self.f.signer(Owner), self.f.signer(Lender)];
        Call::Sponsored(vec![
            ed25519_shared_instruction(&signers, signed),
            self.pledge_instruction(args),
        ])
    }

    fn pledge_whole_lot(&mut self) {
        let args = self.pledge_text();
        let call = self.pledge_call(&args, &args.bytes());
        self.call_ok(call);
        let loan: Loan = self.f.read(self.loan);
        assert_eq!(
            (loan.status, loan.principal, loan.revision),
            (LoanStatus::Active, 0, 0)
        );
        assert_eq!(self.f.read::<LockAllocation>(self.lock).quantity_kg, LOT_KG);
        assert_eq!(self.f.read::<Position>(self.position).locked_kg, LOT_KG);
    }

    // ------------------------------------------------------------------ advance ----

    fn advance_text(&self, amount: u64) -> AdvanceText {
        let loan: Loan = self.f.read(self.loan);
        AdvanceText {
            program: ID,
            instance: INSTANCE,
            lot_id: LOT_ID.into(),
            owner: OWNER_NAME.into(),
            lender: LENDER_NAME.into(),
            facility_id: FACILITY_ONE,
            loan_index: loan.index,
            amount,
            principal_after: loan.principal + amount,
            currency: USD,
            decimals: self.decimals,
            rate_bps: RATE_BPS,
            terms_version: 1,
            expected_revision: loan.revision,
            valid_until: self.now + MONEY_WINDOW,
        }
    }

    fn advance_call(&self, args: &AdvanceText, signed: &[u8]) -> Call {
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
                amount: args.amount,
                currency: USD,
                expected_revision: args.expected_revision,
                valid_until: args.valid_until,
            },
        );
        let verify = ed25519_instruction(&[(self.f.signer(Owner), signed)]);
        Call::Signed(vec![verify, advance], Lender)
    }

    fn advance_ok(&mut self, amount: u64) {
        let args = self.advance_text(amount);
        let call = self.advance_call(&args, &args.bytes());
        self.call_ok(call);
        let loan: Loan = self.f.read(self.loan);
        assert_eq!(loan.principal, args.principal_after);
        assert_eq!(loan.revision, args.expected_revision + 1);
    }

    // ---------------------------------------------------------- release intent ----

    /// The honest release intent `nonce`: `quantity_kg` at `price`, no top-up, expiring a day
    /// from now, at the position's current revision.
    fn intent_text(&self, nonce: u64, quantity_kg: u64, price: u64) -> ReleaseText {
        ReleaseText {
            program: ID,
            instance: INSTANCE,
            lot_id: LOT_ID.into(),
            quantity_kg,
            seller: OWNER_NAME.into(),
            buyer: BUYER_NAME.into(),
            lender: LENDER_NAME.into(),
            facility_id: FACILITY_ONE,
            loan_index: 0,
            nonce,
            price,
            top_up: 0,
            currency: USD,
            decimals: self.decimals,
            expires_at: self.now + DAY,
            expected_revision: self.f.read::<Position>(self.position).revision,
            valid_until: self.now + MONEY_WINDOW,
        }
    }

    fn create_intent_call(&self, args: &ReleaseText, signed: &[u8]) -> Call {
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
                intent: self.intent_key(args.nonce),
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
        );
        let verify = ed25519_instruction(&[(self.f.signer(Owner), signed)]);
        Call::Sponsored(vec![verify, create])
    }

    fn create_intent_ok(&mut self, args: &ReleaseText) -> Pubkey {
        let call = self.create_intent_call(args, &args.intent_bytes());
        self.call_ok(call);
        let intent = self.intent_key(args.nonce);
        let stored: ReleaseIntent = self.f.read(intent);
        assert_eq!(stored.status, IntentStatus::Open);
        assert_eq!(
            (stored.quantity_kg, stored.price),
            (args.quantity_kg, args.price)
        );
        intent
    }

    // ----------------------------------------------------------------- payments ----

    /// Lender One's `confirm_payment` of `amount` on loan 0.
    fn confirm_call(
        &self,
        id: u8,
        purpose: PaymentPurpose,
        subject: Pubkey,
        target: Option<Pubkey>,
        amount: u64,
    ) -> Call {
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
                payment: self.payment_key(id),
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
        Call::Signed(vec![confirm], Lender)
    }

    fn confirm_ok(
        &mut self,
        id: u8,
        purpose: PaymentPurpose,
        subject: Pubkey,
        amount: u64,
    ) -> Pubkey {
        let call = self.confirm_call(id, purpose, subject, None, amount);
        self.call_ok(call);
        let payment = self.payment_key(id);
        let record: PaymentAttestation = self.f.read(payment);
        assert_eq!(record.status, PaymentStatus::Unconsumed);
        assert_eq!((record.subject, record.amount), (subject, amount));
        payment
    }

    /// The fiat `repay` of `payment` by Lender One.
    fn repay_fiat_call(&self, payment: Pubkey, amount: u64) -> Call {
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
        Call::Signed(vec![repay], Lender)
    }

    // ------------------------------------------------------------- sell_pledged ----

    /// The honest buyer acceptance of the stored intent, at its signed position revision.
    fn acceptance_text(&self, intent: Pubkey) -> ReleaseText {
        let stored: ReleaseIntent = self.f.read(intent);
        ReleaseText {
            program: ID,
            instance: INSTANCE,
            lot_id: LOT_ID.into(),
            quantity_kg: stored.quantity_kg,
            seller: OWNER_NAME.into(),
            buyer: BUYER_NAME.into(),
            lender: LENDER_NAME.into(),
            facility_id: FACILITY_ONE,
            loan_index: 0,
            nonce: stored.nonce,
            price: stored.price,
            top_up: stored.top_up,
            currency: USD,
            decimals: self.decimals,
            expires_at: stored.expires_at,
            expected_revision: stored.position_revision,
            valid_until: self.now + MONEY_WINDOW,
        }
    }

    fn sell_call(
        &self,
        intent: Pubkey,
        payment: Pubkey,
        args: &ReleaseText,
        signed: &[u8],
    ) -> Call {
        self.sell_call_by(intent, payment, args, signed, self.buyer, Buyer)
    }

    /// `sell_pledged` accepted by `buyer`'s wallet for `buyer_org`, into that organisation's
    /// position of the lot.
    fn sell_call_by(
        &self,
        intent: Pubkey,
        payment: Pubkey,
        args: &ReleaseText,
        signed: &[u8],
        buyer_org: Pubkey,
        buyer: Actor,
    ) -> Call {
        let buyer_position = self.position_of(buyer_org);
        let seller_position = self.position;
        let sell = ix(
            accounts::SellPledged {
                sponsor: self.f.payer(),
                protocol: self.f.protocol,
                facility: self.facility,
                lender_org: self.lender,
                loan: self.loan,
                lock: self.lock,
                valuation: self.valuation,
                intent,
                payment,
                lot: self.lot,
                mint: self.lot_mint(),
                seller_org: self.owner,
                buyer_org,
                buyer_authority: self.authority_of(buyer),
                seller_position,
                seller_vault_authority: Self::vault_authority(seller_position),
                seller_vault: self.vault_of(self.owner),
                buyer_position,
                buyer_vault_authority: Self::vault_authority(buyer_position),
                buyer_vault: self.vault_of(buyer_org),
                instructions: INSTRUCTIONS_SYSVAR,
                token_program: TOKEN_2022,
                associated_token_program: ASSOCIATED_TOKEN,
                system_program: SYSTEM,
            },
            instruction::SellPledged {
                expected_revision: args.expected_revision,
                valid_until: args.valid_until,
            },
        );
        let verify = ed25519_instruction(&[(self.f.signer(buyer), signed)]);
        Call::Sponsored(vec![verify, sell])
    }

    fn sell_ok(&mut self, intent: Pubkey, payment: Pubkey) {
        let quantity = self.f.read::<ReleaseIntent>(intent).quantity_kg;
        let before = self.f.read::<Position>(self.position).quantity_kg;
        let args = self.acceptance_text(intent);
        let call = self.sell_call(intent, payment, &args, &args.acceptance_bytes());
        self.call_ok(call);
        assert_eq!(
            self.f.read::<ReleaseIntent>(intent).status,
            IntentStatus::Executed
        );
        assert_eq!(
            self.f.read::<PaymentAttestation>(payment).status,
            PaymentStatus::Consumed
        );
        let after: Position = self.f.read(self.position);
        assert_eq!(after.quantity_kg, before - quantity);
        assert_eq!(
            self.f.token_amount(self.vault_of(self.owner)),
            after.quantity_kg
        );
    }

    // ---------------------------------------------------------------- recovery ----

    fn liquidate_call(&self) -> Call {
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
            instruction::Liquidate {
                expected_revision: self.f.read::<Loan>(self.loan).revision,
            },
        );
        Call::Signed(vec![liquidate], Lender)
    }

    fn close_call(&self) -> Call {
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
            instruction::CloseLoan {
                expected_revision: self.f.read::<Loan>(self.loan).revision,
            },
        );
        Call::Signed(vec![close], Lender)
    }

    // ------------------------------------------------------------- the pool ----

    fn deposit_call(&self, actor: Actor, organisation: Pubkey, amount: u64) -> Call {
        let deposit = ix(
            accounts::Deposit {
                depositor: self.f.key(actor),
                payer: self.f.payer(),
                protocol: self.f.protocol,
                authority: self.authority_of(actor),
                depositor_org: organisation,
                pool: self.pool,
                share: self.share(organisation),
                depositor_token: self.ata(actor),
                pool_vault: self.pool_vault,
                mint: POOL_MINT,
                token_program: SPL_TOKEN,
                system_program: SYSTEM,
            },
            instruction::Deposit { amount },
        );
        Call::Signed(vec![deposit], actor)
    }

    fn withdraw_call(&self, actor: Actor, organisation: Pubkey, amount: u64) -> Call {
        let withdraw = ix(
            accounts::Withdraw {
                depositor: self.f.key(actor),
                protocol: self.f.protocol,
                authority: self.authority_of(actor),
                depositor_org: organisation,
                pool: self.pool,
                share: self.share(organisation),
                depositor_token: self.ata(actor),
                pool_authority: self.pool_authority,
                pool_vault: self.pool_vault,
                mint: POOL_MINT,
                token_program: SPL_TOKEN,
            },
            instruction::Withdraw { amount },
        );
        Call::Signed(vec![withdraw], actor)
    }

    /// Lender One deposits `amount`; the share and the pool's cash grow by exactly that.
    fn deposit_ok(&mut self, amount: u64) {
        let before: SimulationPool = self.f.read(self.pool);
        let call = self.deposit_call(Lender, self.lender, amount);
        self.call_ok(call);
        let pool: SimulationPool = self.f.read(self.pool);
        assert_eq!(pool.cash_minor, before.cash_minor + amount);
        assert_eq!(pool.total_shares, before.total_shares + amount);
    }

    /// The honest borrow text: `amount` to the Owner's ATA at the loan's current revision.
    fn borrow_text(&self, amount: u64) -> BorrowText {
        let loan: Loan = self.f.read(self.loan);
        BorrowText {
            program: ID,
            instance: INSTANCE,
            lot_id: LOT_ID.into(),
            owner: OWNER_NAME.into(),
            lender: LENDER_NAME.into(),
            facility_id: FACILITY_ONE,
            loan_index: loan.index,
            amount,
            principal_after: loan.principal + amount,
            currency: USD,
            decimals: self.decimals,
            destination: self.ata(Owner),
            rate_bps: RATE_BPS,
            expected_revision: loan.revision,
            valid_until: self.now + MONEY_WINDOW,
        }
    }

    fn borrow_call(&self, args: &BorrowText, signed: &[u8]) -> Call {
        let borrow = ix(
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
                destination: self.ata(Owner),
                token_program: SPL_TOKEN,
                instructions: INSTRUCTIONS_SYSVAR,
            },
            instruction::Borrow {
                amount: args.amount,
                expected_revision: args.expected_revision,
                valid_until: args.valid_until,
            },
        );
        let verify = ed25519_instruction(&[(self.f.signer(Owner), signed)]);
        Call::Sponsored(vec![verify, borrow])
    }

    fn borrow_ok(&mut self, amount: u64) {
        let owner_before = self.f.token_amount(self.ata(Owner));
        let args = self.borrow_text(amount);
        let call = self.borrow_call(&args, &args.bytes());
        self.call_ok(call);
        assert_eq!(
            self.f.read::<Loan>(self.loan).principal,
            args.principal_after
        );
        assert_eq!(self.f.token_amount(self.ata(Owner)), owner_before + amount);
    }

    /// The simulated `repay` of `amount` by `payer` from its own ATA, with Lender One's share as
    /// the one writable remaining account.
    fn repay_pool_call(&self, payer: Actor, amount: u64) -> Call {
        let mut repay = ix(
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
            },
            instruction::Repay { amount },
        );
        repay
            .accounts
            .push(AccountMeta::new(self.share(self.lender), false));
        Call::Signed(vec![repay], payer)
    }

    // ---------------------------------------------------- direct token calls ----

    /// Sends `instruction`, signed by `actor` next to the sponsor, and asserts it fails in
    /// `program` with `Custom(code)` (and in no other program), that no event is emitted, that
    /// the sponsor pays only the fee, and that every account in `watched` and every writable
    /// account of the instruction is unchanged.
    fn refuse_direct(
        &mut self,
        label: &str,
        instruction: Instruction,
        actor: Actor,
        program: Pubkey,
        code: u32,
        watched: &[Pubkey],
    ) {
        assert_eq!(instruction.program_id, program, "{label}");
        let payer = self.f.payer();
        let mut keys: Vec<Pubkey> = watched.to_vec();
        keys.extend(
            instruction
                .accounts
                .iter()
                .filter(|meta| meta.is_writable && meta.pubkey != payer)
                .map(|meta| meta.pubkey),
        );
        keys.sort_unstable();
        keys.dedup();
        let before: Vec<_> = keys.iter().map(|key| self.f.raw_account(*key)).collect();
        let payer_before = self.f.balance(payer);

        let failure = match self.f.send_signed(&[instruction], actor) {
            Err(failure) => failure,
            Ok(success) => panic!("{label} unexpectedly succeeded: {:?}", success.logs),
        };
        let logs = failure.meta.pretty_logs();
        assert_eq!(
            failure.err,
            TransactionError::InstructionError(0, InstructionError::Custom(code)),
            "{label}\n{logs}"
        );
        let failed: Vec<&String> = failure
            .meta
            .logs
            .iter()
            .filter(|line| line.contains(" failed: "))
            .collect();
        assert_eq!(
            failed,
            [&format!(
                "Program {program} failed: custom program error: {code:#x}"
            )],
            "{label} failed in the wrong program\n{logs}"
        );
        assert!(
            event_data(&failure.meta).next().is_none(),
            "{label} emitted an event"
        );
        assert!(failure.meta.fee > 0);
        assert_eq!(
            self.f.balance(payer) + failure.meta.fee,
            payer_before,
            "{label} cost the sponsor more than its fee"
        );
        let after: Vec<_> = keys.iter().map(|key| self.f.raw_account(*key)).collect();
        assert_eq!(before, after, "{label} changed state\n{logs}");
    }

    // ------------------------------------------------------ mismatched accounts ----

    /// Issues CR-0002 to the owner, opens Lender Two Bank's facility and pledges all of
    /// CR-0002 to it as its loan 0, and registers CHROME version 2 with a site at the
    /// custodian: real accounts the mismatch cases name.
    fn others(&mut self) -> Others {
        let (lot, position) = self.issue_lot_as(OTHER_LOT_ID, SECOND_INTAKE_DIGEST);
        let lender2 = self.lender2;
        let open = self.facility_call(Lender2, lender2, FACILITY_TWO);
        self.call_ok(open);
        let facility = Self::facility_key(&self.f, lender2, FACILITY_TWO);
        let loan = pda(&[b"loan", facility.as_ref(), &0_u32.to_le_bytes()]);
        let lock = pda(&[b"lock", loan.as_ref()]);
        let text = PledgeText {
            lot_id: OTHER_LOT_ID.into(),
            lender: LENDER2_NAME.into(),
            facility_id: FACILITY_TWO,
            ..self.pledge_text()
        };
        let pledge = ix(
            accounts::Pledge {
                sponsor: self.f.payer(),
                protocol: self.f.protocol,
                lot,
                position,
                borrower_org: self.owner,
                borrower_authority: self.authority_of(Owner),
                lender_org: lender2,
                lender_authority: self.authority_of(Lender2),
                facility,
                loan,
                lock,
                instructions: INSTRUCTIONS_SYSVAR,
                system_program: SYSTEM,
            },
            instruction::Pledge {
                loan_index: 0,
                quantity_kg: LOT_KG,
                expected_revision: 0,
                valid_until: text.valid_until,
            },
        );
        let signers = [self.f.signer(Owner), self.f.signer(Lender2)];
        let verify = ed25519_shared_instruction(&signers, &text.bytes());
        self.f.sponsored_ok(&[verify, pledge]);
        assert_eq!(self.f.read::<Loan>(loan).lot, lot);
        assert_eq!(self.f.read::<LockAllocation>(lock).position, position);

        let register =
            self.f
                .register_with_origin(Accreditor, CLASS_CODE, 2, &GRADES, LOT_VALIDITY, false);
        self.f.ok(register, Accreditor);
        let class_policy = self.f.class(CLASS_CODE, 2);
        let site =
            self.f
                .accredit_site(Accreditor, self.custodian, class_policy, SITE_CODE, LOT_KG);
        self.f.ok(site, Accreditor);
        let custodian_class = self.f.site(self.custodian, class_policy, SITE_CODE);
        assert_eq!(
            self.f.read::<CustodianClass>(custodian_class).class_policy,
            class_policy
        );
        Others {
            lot,
            position,
            facility,
            loan,
            class_policy,
            custodian_class,
        }
    }

    /// Runs each case: rewrites its accounts, sends its call (or `call`), asserts the exact
    /// error with no state change and no event, and writes every rewritten account back.
    fn refuse_mismatched(
        &mut self,
        instruction: &str,
        cases: Vec<Mismatch>,
        call: impl Fn(&World) -> Call,
    ) {
        for case in cases {
            let originals: Vec<(Pubkey, RawAccount)> = case
                .rewrites
                .iter()
                .map(|(account, _)| (*account, self.f.raw_account(*account).unwrap()))
                .collect();
            for (_, rewrite) in &case.rewrites {
                rewrite(&mut self.f);
            }
            for (account, original) in &originals {
                let now = self.f.raw_account(*account).unwrap();
                assert_ne!(
                    (now.owner, now.data),
                    (original.owner, original.data.clone()),
                    "{instruction}: {} leaves {account} as it was",
                    case.name
                );
            }
            println!("{instruction}: {} -> {:?}", case.name, case.expected);
            let sent = match &case.call {
                Some(send) => send(self),
                None => call(self),
            };
            self.call_refused(sent, case.expected);
            for (account, original) in originals.iter().rev() {
                self.f
                    .set_foreign_account(*account, original.owner, original.data.clone());
                assert_eq!(self.f.raw_account(*account).as_ref(), Some(original));
            }
        }
    }

    // -------------------------------------------------------------- signers ----

    /// Writes an Authority at `signer`'s own canonical address that records `recorded`'s wallet,
    /// for `organisation` with `scopes`. No instruction writes one: `delegate_authority` derives
    /// the address from the wallet it stores. It is the only way to reach the signer check after
    /// the Authority seeds, which is defence in depth.
    fn forge_wallet_record(
        &mut self,
        signer: Actor,
        organisation: Pubkey,
        recorded: Actor,
        scopes: u16,
    ) {
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
            wallet: self.f.key(recorded),
            scopes,
            expires_at: NOW + AUTHORITY_LIFETIME,
            revoked_at: None,
            bump,
        };
        self.f.set_program_account(address, &record);
        assert_eq!(
            self.f.read::<Authority>(address).wallet,
            self.f.key(recorded)
        );
    }

    /// `call` signed by `to` instead of `from`: the signing wallet's slot names `to`'s wallet,
    /// and the Authority slot names `authority`.
    fn resigned(&self, call: Call, from: Actor, to: Actor, authority: Pubkey) -> Call {
        let call = swap(call, self.f.key(from), self.f.key(to));
        let call = swap(call, self.authority_of(from), authority);
        match call {
            Call::Signed(instructions, _) => Call::Signed(instructions, to),
            Call::Sponsored(_) => panic!("a sponsored call has no signing wallet"),
        }
    }

    /// The call's last instruction must fail in Anchor's account checks with `expected`, with
    /// no state change and no event; the sponsor pays only the fee.
    fn call_refused_anchor(&mut self, call: Call, expected: anchor_lang::error::ErrorCode) {
        let Call::Signed(instructions, actor) = call else {
            panic!("a signed call");
        };
        let payer = self.f.payer();
        let mut keys: Vec<Pubkey> = instructions
            .iter()
            .flat_map(|instruction| &instruction.accounts)
            .map(|meta| meta.pubkey)
            .filter(|key| *key != payer)
            .collect();
        keys.sort_unstable();
        keys.dedup();
        let before: Vec<_> = keys.iter().map(|key| self.f.raw_account(*key)).collect();
        let payer_before = self.f.balance(payer);
        let index = u8::try_from(instructions.len() - 1).unwrap();
        let failure = match self.f.send_signed(&instructions, actor) {
            Err(failure) => failure,
            Ok(success) => panic!("unexpectedly succeeded: {:?}", success.logs),
        };
        let code: u32 = expected.into();
        assert_eq!(
            failure.err,
            TransactionError::InstructionError(index, InstructionError::Custom(code)),
            "{}",
            failure.meta.pretty_logs()
        );
        assert!(event_data(&failure.meta).next().is_none());
        assert_eq!(self.f.balance(payer) + failure.meta.fee, payer_before);
        let after: Vec<_> = keys.iter().map(|key| self.f.raw_account(*key)).collect();
        assert_eq!(before, after, "{}", failure.meta.pretty_logs());
    }

    /// Outsider, a wallet with no Authority of its own, signs `call` in place of `from`: with
    /// `from`'s real Authority account (the Authority seeds refuse it), then with the forged
    /// Authority at its own address that records `from`'s wallet (`WrongSigner`).
    fn refuse_other_signer(
        &mut self,
        instruction: &str,
        from: Actor,
        call: impl Fn(&World) -> Call,
    ) {
        println!("{instruction}: Outsider with the signer's Authority -> ConstraintSeeds");
        let real = self.authority_of(from);
        let literal = self.resigned(call(self), from, Outsider, real);
        self.call_refused_anchor(literal, anchor_lang::error::ErrorCode::ConstraintSeeds);
        println!("{instruction}: Outsider with an Authority recording the signer -> WrongSigner");
        let forged = self.authority_of(Outsider);
        let forged_call = self.resigned(call(self), from, Outsider, forged);
        self.call_refused(forged_call, WrongSigner);
    }

    // --------------------------------------------------- foreign-protocol rewrites ----

    /// For each `(name, account, expected)`, rewrites the account's first field (`protocol`, or
    /// the `pool` of a share) to name another protocol instance, sends `call`, asserts it fails
    /// with `expected` and changes nothing, and writes the account back.
    fn refuse_foreign(
        &mut self,
        instruction: &str,
        cases: &[(&str, Pubkey, ThetisError)],
        call: impl Fn(&World) -> Call,
    ) {
        let other = other_protocol();
        let other_pool = pda(&[b"pool", other.as_ref()]);
        for (name, account, expected) in cases {
            let original = self.f.raw_account(*account).expect("the account exists");
            assert_eq!(original.owner, ID);
            let field = Pubkey::try_from(&original.data[8..40]).unwrap();
            let replacement = if field == self.f.protocol {
                other
            } else {
                assert_eq!(
                    field, self.pool,
                    "{instruction}: {name} names the protocol or pool"
                );
                other_pool
            };
            let mut data = original.data.clone();
            data[8..40].copy_from_slice(replacement.as_ref());
            self.f.set_foreign_account(*account, ID, data);
            println!("{instruction}: {name} of another protocol -> {expected:?}");
            let refused = call(self);
            self.call_refused(refused, *expected);
            self.f
                .set_foreign_account(*account, ID, original.data.clone());
            let restored = self.f.raw_account(*account).unwrap();
            assert_eq!(
                (restored.lamports, restored.owner, restored.data),
                (original.lamports, original.owner, original.data)
            );
        }
    }
}

// ------------------------------------------------------------------- pool vault ----

/// Every account a direct call against the pool vault could change, and the shares.
fn pool_watched(w: &World, attacker_ata: Pubkey) -> Vec<Pubkey> {
    vec![
        w.pool,
        w.pool_vault,
        w.pool_authority,
        w.share(w.lender),
        w.share(w.lender2),
        w.loan,
        w.lock,
        POOL_MINT,
        attacker_ata,
        w.ata(Owner),
    ]
}

/// The SPL Token calls an attacker can make against the pool vault, each naming the attacker as
/// the authority: debits to the attacker's own ATA, burns, delegations and authority changes.
fn pool_vault_attacks(w: &World, signer: Pubkey, to: Pubkey) -> Vec<(&'static str, Instruction)> {
    let vault = w.pool_vault;
    let one = 1;
    vec![
        (
            "Transfer",
            spl_token::instruction::transfer(&SPL_TOKEN, &vault, &to, &signer, &[], one).unwrap(),
        ),
        (
            "TransferChecked",
            spl_token::instruction::transfer_checked(
                &SPL_TOKEN,
                &vault,
                &POOL_MINT,
                &to,
                &signer,
                &[],
                one,
                MICRO,
            )
            .unwrap(),
        ),
        (
            "Burn",
            spl_token::instruction::burn(&SPL_TOKEN, &vault, &POOL_MINT, &signer, &[], one)
                .unwrap(),
        ),
        (
            "BurnChecked",
            spl_token::instruction::burn_checked(
                &SPL_TOKEN,
                &vault,
                &POOL_MINT,
                &signer,
                &[],
                one,
                MICRO,
            )
            .unwrap(),
        ),
        (
            "Approve",
            spl_token::instruction::approve(&SPL_TOKEN, &vault, &signer, &signer, &[], one)
                .unwrap(),
        ),
        (
            "ApproveChecked",
            spl_token::instruction::approve_checked(
                &SPL_TOKEN,
                &vault,
                &POOL_MINT,
                &signer,
                &signer,
                &[],
                one,
                MICRO,
            )
            .unwrap(),
        ),
        (
            "SetAuthority AccountOwner",
            spl_token::instruction::set_authority(
                &SPL_TOKEN,
                &vault,
                Some(&signer),
                spl_token::instruction::AuthorityType::AccountOwner,
                &signer,
                &[],
            )
            .unwrap(),
        ),
        (
            "SetAuthority CloseAccount",
            spl_token::instruction::set_authority(
                &SPL_TOKEN,
                &vault,
                Some(&signer),
                spl_token::instruction::AuthorityType::CloseAccount,
                &signer,
                &[],
            )
            .unwrap(),
        ),
    ]
}

fn close_vault(w: &World, signer: Pubkey) -> Instruction {
    spl_token::instruction::close_account(&SPL_TOKEN, &w.pool_vault, &signer, &signer, &[]).unwrap()
}

#[test]
fn pool_vault_unauthorised_debits_refused() {
    // Lender One deposits USD600,000 and the borrower borrows USD400,000, so the vault holds
    // USD200,000 of accounted cash.
    let mut w = World::pool_demo();
    w.deposit_ok(w.usd(USD_600K));
    w.borrow_ok(w.usd(USD_400K));
    let vault = w.spl_account(w.pool_vault);
    assert_eq!(vault.amount, w.usd(USD_600K) - w.usd(USD_400K));
    assert_eq!(vault.owner, w.pool_authority);
    assert_eq!(Option::<Pubkey>::from(vault.delegate), None);
    assert_eq!(Option::<Pubkey>::from(vault.close_authority), None);
    assert_eq!(
        Option::<Pubkey>::from(w.pool_mint_state().freeze_authority),
        None
    );

    let owner_mismatch = SplTokenError::OwnerMismatch as u32;
    let has_balance = SplTokenError::NonNativeHasBalance as u32;
    assert_eq!((owner_mismatch, has_balance), (4, 11));
    for (who, actor) in [("Alice", Lender), ("Mallory", Outsider)] {
        let signer = w.f.key(actor);
        let to = w.ata(actor);
        let watched = pool_watched(&w, to);
        for (operation, attack) in pool_vault_attacks(&w, signer, to) {
            let label = format!("{operation} on the pool vault ({who})");
            w.refuse_direct(&label, attack, actor, SPL_TOKEN, owner_mismatch, &watched);
        }
        let label = format!("CloseAccount on the funded pool vault ({who})");
        let close = close_vault(&w, signer);
        w.refuse_direct(&label, close, actor, SPL_TOKEN, has_balance, &watched);
    }
    let pool: SimulationPool = w.f.read(w.pool);
    assert_eq!(w.f.token_amount(w.pool_vault), pool.cash_minor);

    // Through Thetis the vault still pays out: Lender One withdraws USD30,000.
    let lender_before = w.f.token_amount(w.ata(Lender));
    let withdraw = w.withdraw_call(Lender, w.lender, w.usd(USD_30K));
    w.call_ok(withdraw);
    assert_eq!(
        w.f.token_amount(w.ata(Lender)),
        lender_before + w.usd(USD_30K)
    );

    // An empty vault of a fresh pool: closing it needs the owner's signature.
    let mut fresh = World::new(SettlementMode::DevnetTokenSimulation);
    assert_eq!(fresh.f.token_amount(fresh.pool_vault), 0);
    for (who, actor) in [("Alice", Lender), ("Mallory", Outsider)] {
        let signer = fresh.f.key(actor);
        let watched = pool_watched(&fresh, fresh.ata(actor));
        let label = format!("CloseAccount on the empty pool vault ({who})");
        let close = close_vault(&fresh, signer);
        fresh.refuse_direct(&label, close, actor, SPL_TOKEN, owner_mismatch, &watched);
    }
    assert!(fresh.f.account_exists(fresh.pool_vault));
}

#[test]
fn pool_vault_inbound_credit_changes_no_accounting() {
    // Lender One deposits USD400,000; nothing is borrowed, so the limit leaves room above the
    // pool's cash and a borrow is stopped by liquidity alone.
    let mut w = World::pool_demo();
    w.deposit_ok(w.usd(USD_400K));
    let accounting = [
        w.pool,
        w.share(w.lender),
        w.share(w.lender2),
        w.loan,
        w.lock,
    ];
    let snapshot: Vec<_> = accounting.iter().map(|key| w.f.raw_account(*key)).collect();
    let credit = w.usd(USD_30K);
    let outsider = w.f.key(Outsider);
    let payer = w.f.payer();
    let credits = [
        (
            "an Outsider Transfer",
            spl_token::instruction::transfer(
                &SPL_TOKEN,
                &w.ata(Outsider),
                &w.pool_vault,
                &outsider,
                &[],
                credit,
            )
            .unwrap(),
            Some(Outsider),
        ),
        (
            "an Outsider TransferChecked",
            spl_token::instruction::transfer_checked(
                &SPL_TOKEN,
                &w.ata(Outsider),
                &POOL_MINT,
                &w.pool_vault,
                &outsider,
                &[],
                credit,
                MICRO,
            )
            .unwrap(),
            Some(Outsider),
        ),
        (
            "a MintTo by the mint authority",
            spl_token::instruction::mint_to(
                &SPL_TOKEN,
                &POOL_MINT,
                &w.pool_vault,
                &payer,
                &[],
                credit,
            )
            .unwrap(),
            None,
        ),
    ];
    for (count, (label, instruction, actor)) in (1_u64..).zip(credits) {
        let vault_before = w.f.token_amount(w.pool_vault);
        let tx = match actor {
            Some(actor) => w.f.signed_ok(&[instruction], actor),
            None => w.f.sponsored_ok(&[instruction]),
        };
        assert!(event_data(&tx).next().is_none(), "{label} emitted an event");
        assert_eq!(
            w.f.token_amount(w.pool_vault),
            vault_before + credit,
            "{label}"
        );
        let now: Vec<_> = accounting.iter().map(|key| w.f.raw_account(*key)).collect();
        assert_eq!(now, snapshot, "{label} changed the pool's accounting");

        let pool: SimulationPool = w.f.read(w.pool);
        assert_eq!(pool.cash_minor, w.usd(USD_400K));
        assert_eq!(
            w.f.token_amount(w.pool_vault) - pool.cash_minor,
            credit * count,
            "{label}: the vault holds the credits beyond the accounted cash"
        );
        let share: PoolShare = w.f.read(w.share(w.lender));
        println!("after {label}: withdraw shares + 1, borrow cash + 1");
        let withdraw = w.withdraw_call(Lender, w.lender, share.shares + 1);
        w.call_refused(withdraw, InsufficientShares);
        let args = w.borrow_text(pool.cash_minor + 1);
        let borrow = w.borrow_call(&args, &args.bytes());
        w.call_refused(borrow, InsufficientLiquidity);
    }

    // The accounted cash is all a borrower can draw; the credits stay in the vault, unattributed.
    w.borrow_ok(w.usd(USD_400K));
    let pool: SimulationPool = w.f.read(w.pool);
    assert_eq!(pool.cash_minor, 0);
    assert_eq!(pool.total_shares, w.usd(USD_400K));
    assert_eq!(w.f.token_amount(w.pool_vault), 3 * credit);
}

// ---------------------------------------------------------- pledged receipt vault ----

/// The receipt accounts, the loan and lock, and every personal account a direct call against
/// the pledged vault could change.
fn receipt_watched(w: &World) -> Vec<Pubkey> {
    vec![
        w.f.protocol,
        w.owner,
        w.lender,
        w.buyer,
        w.lot,
        w.lot_mint(),
        w.mint_authority(),
        w.position,
        World::vault_authority(w.position),
        w.vault_of(w.owner),
        w.position_of(w.buyer),
        w.vault_of(w.buyer),
        w.facility,
        w.valuation,
        w.loan,
        w.lock,
        w.personal_ata(Owner),
        w.personal_ata(Outsider),
        w.personal_ata(Lender),
    ]
}

/// The ADR 0001 configuration and the pledge, asserted: the mint has no extension and its PDA is
/// both mint and freeze authority; the owner's vault is held by its PDA with no delegate or
/// close authority and holds the whole position, all of it locked to loan 0.
fn assert_pledged_receipts(w: &World) {
    let mint_account = w.f.raw_account(w.lot_mint()).unwrap();
    assert_eq!(mint_account.owner, TOKEN_2022);
    let mint = StateWithExtensions::<Mint>::unpack(&mint_account.data).unwrap();
    assert!(mint.get_extension_types().unwrap().is_empty());
    assert_eq!(
        Option::<Pubkey>::from(mint.base.mint_authority),
        Some(w.mint_authority())
    );
    assert_eq!(
        Option::<Pubkey>::from(mint.base.freeze_authority),
        Some(w.mint_authority())
    );
    assert_eq!(mint.base.supply, LOT_KG);

    let vault_account = w.f.raw_account(w.vault_of(w.owner)).unwrap();
    let vault = StateWithExtensions::<TokenAccount>::unpack(&vault_account.data)
        .unwrap()
        .base;
    assert_eq!(vault.owner, World::vault_authority(w.position));
    assert_eq!(vault.amount, LOT_KG);
    assert_eq!(Option::<Pubkey>::from(vault.delegate), None);
    assert_eq!(Option::<Pubkey>::from(vault.close_authority), None);

    let position: Position = w.f.read(w.position);
    assert_eq!((position.quantity_kg, position.locked_kg), (LOT_KG, LOT_KG));
    let lock: LockAllocation = w.f.read(w.lock);
    assert_eq!(
        (lock.quantity_kg, lock.control),
        (LOT_KG, LockControl::Pledged)
    );
    let loan: Loan = w.f.read(w.loan);
    assert_eq!(
        (loan.status, loan.principal),
        (LoanStatus::Active, w.usd(USD_600K))
    );
}

/// The direct Token-2022 calls of the ADR 0001 A02 list against the pledged vault, each naming
/// `signer` as the authority; `own` is the signer's personal account and `alice` the owner
/// wallet's. Closing an empty vault is not reachable: a pledged position always holds units.
fn receipt_vault_attacks(
    w: &World,
    signer: Pubkey,
    own: Pubkey,
    alice: Pubkey,
) -> Vec<(&'static str, u32, Instruction)> {
    let vault = w.vault_of(w.owner);
    let mint = w.lot_mint();
    let owner = TokenError::OwnerMismatch as u32;
    #[allow(deprecated)]
    let transfer = token22::transfer(&TOKEN_2022, &vault, &own, &signer, &[], 1).unwrap();
    vec![
        ("Transfer", owner, transfer),
        (
            "TransferChecked",
            owner,
            token22::transfer_checked(&TOKEN_2022, &vault, &mint, &own, &signer, &[], 1, 0)
                .unwrap(),
        ),
        (
            "Burn",
            owner,
            token22::burn(&TOKEN_2022, &vault, &mint, &signer, &[], 1).unwrap(),
        ),
        (
            "BurnChecked",
            owner,
            token22::burn_checked(&TOKEN_2022, &vault, &mint, &signer, &[], 1, 0).unwrap(),
        ),
        (
            "Approve",
            owner,
            token22::approve(&TOKEN_2022, &vault, &signer, &signer, &[], 1).unwrap(),
        ),
        (
            "ApproveChecked",
            owner,
            token22::approve_checked(&TOKEN_2022, &vault, &mint, &signer, &signer, &[], 1, 0)
                .unwrap(),
        ),
        (
            "CloseAccount with a balance",
            TokenError::NonNativeHasBalance as u32,
            token22::close_account(&TOKEN_2022, &vault, &signer, &signer, &[]).unwrap(),
        ),
        (
            "SetAuthority vault owner",
            owner,
            token22::set_authority(
                &TOKEN_2022,
                &vault,
                Some(&signer),
                Authority22::AccountOwner,
                &signer,
                &[],
            )
            .unwrap(),
        ),
        (
            "SetAuthority vault close",
            owner,
            token22::set_authority(
                &TOKEN_2022,
                &vault,
                Some(&signer),
                Authority22::CloseAccount,
                &signer,
                &[],
            )
            .unwrap(),
        ),
        (
            "SetAuthority mint",
            owner,
            token22::set_authority(
                &TOKEN_2022,
                &mint,
                Some(&signer),
                Authority22::MintTokens,
                &signer,
                &[],
            )
            .unwrap(),
        ),
        (
            "SetAuthority freeze",
            owner,
            token22::set_authority(
                &TOKEN_2022,
                &mint,
                Some(&signer),
                Authority22::FreezeAccount,
                &signer,
                &[],
            )
            .unwrap(),
        ),
        (
            "MintTo the vault",
            owner,
            token22::mint_to(&TOKEN_2022, &mint, &vault, &signer, &[], 1).unwrap(),
        ),
        (
            "FreezeAccount",
            owner,
            token22::freeze_account(&TOKEN_2022, &vault, &mint, &signer, &[]).unwrap(),
        ),
        (
            "TransferChecked to Alice's account",
            owner,
            token22::transfer_checked(&TOKEN_2022, &vault, &mint, &alice, &signer, &[], 1, 0)
                .unwrap(),
        ),
        (
            "MintTo Alice's account",
            owner,
            token22::mint_to(&TOKEN_2022, &mint, &alice, &signer, &[], 1).unwrap(),
        ),
    ]
}

/// The custody-window `transfer` of `quantity_kg` from `owner`'s view of the pledged position
/// to Buyer Smelter Co, signed by `signer` with its Authority.
fn thetis_transfer(w: &World, signer: Actor, owner: Pubkey, quantity_kg: u64) -> Call {
    let revision = w.f.read::<Position>(w.position).revision;
    let valid_until = w.now + CUSTODY_WINDOW;
    let text = transfer_message(
        &ID,
        &INSTANCE,
        LOT_ID,
        quantity_kg,
        &w.display_name(owner),
        BUYER_NAME,
        revision,
        valid_until,
    );
    let to_position = w.position_of(w.buyer);
    let transfer = ix(
        accounts::Transfer {
            sponsor: w.f.payer(),
            protocol: w.f.protocol,
            authority: w.authority_of(signer),
            lot: w.lot,
            mint: w.lot_mint(),
            owner,
            from_position: w.position,
            from_vault_authority: World::vault_authority(w.position),
            from_vault: w.vault_of(w.owner),
            recipient: w.buyer,
            to_position,
            to_vault_authority: World::vault_authority(to_position),
            to_vault: w.vault_of(w.buyer),
            instructions: INSTRUCTIONS_SYSVAR,
            token_program: TOKEN_2022,
            associated_token_program: ASSOCIATED_TOKEN,
            system_program: SYSTEM,
        },
        instruction::Transfer {
            quantity_kg,
            expected_revision: revision,
            valid_until,
        },
    );
    let verify = ed25519_instruction(&[(w.f.signer(signer), text.as_slice())]);
    Call::Sponsored(vec![verify, transfer])
}

#[test]
fn pledged_vault_direct_token_paths_refused() {
    // The fiat demo: all 5,000 t pledged as loan 0, after the USD600,000 advance.
    let mut w = World::fiat_demo();
    let payer = w.f.payer();
    for actor in [Owner, Outsider, Lender] {
        let create =
            create_associated_token_account(&payer, &w.f.key(actor), &w.lot_mint(), &TOKEN_2022);
        w.f.sponsored_ok(&[create]);
        assert_eq!(w.f.token_amount(w.personal_ata(actor)), 0);
    }
    assert_pledged_receipts(&w);
    let watched = receipt_watched(&w);
    let alice = w.personal_ata(Owner);

    for (who, actor) in [
        ("Alice", Owner),
        ("Mallory", Outsider),
        ("the lender", Lender),
    ] {
        let signer = w.f.key(actor);
        let own = w.personal_ata(actor);
        for (operation, code, attack) in receipt_vault_attacks(&w, signer, own, alice) {
            let label = format!("{operation} on the pledged vault ({who}) -> {code}");
            w.refuse_direct(&label, attack, actor, TOKEN_2022, code, &watched);
        }
        assert_pledged_receipts(&w);
    }

    // The Thetis lines: nothing of the position is available, and only its owner may move it.
    let position: Position = w.f.read(w.position);
    let available = position.quantity_kg - position.locked_kg - position.reserved_kg;
    assert_eq!(available, 0);
    let owner = w.owner;
    let over = thetis_transfer(&w, Owner, owner, available + 1);
    w.call_refused(over, InsufficientAvailable);
    let delegate = w.f.delegate(
        OrgAdmin,
        w.buyer,
        w.f.key(Outsider),
        scope::TRANSFER,
        NOW + AUTHORITY_LIFETIME,
    );
    w.f.ok(delegate, OrgAdmin);
    let buyer = w.buyer;
    let foreign = thetis_transfer(&w, Outsider, buyer, 1);
    w.call_refused(foreign, WrongOrganisation);
    assert_pledged_receipts(&w);

    // A thaw needs a frozen vault: the harness freezes it in the ledger first, and puts it back
    // afterwards.
    let vault = w.vault_of(w.owner);
    let unfrozen = w.f.raw_account(vault).unwrap();
    w.f.freeze_token_account(vault);
    let frozen = StateWithExtensions::<TokenAccount>::unpack(&w.f.data(vault))
        .unwrap()
        .base;
    assert_eq!(frozen.state, AccountState::Frozen);
    for (who, actor) in [
        ("Alice", Owner),
        ("Mallory", Outsider),
        ("the lender", Lender),
    ] {
        let signer = w.f.key(actor);
        let thaw = token22::thaw_account(&TOKEN_2022, &vault, &w.lot_mint(), &signer, &[]).unwrap();
        let label = format!("ThawAccount on the pledged vault ({who})");
        let code = TokenError::OwnerMismatch as u32;
        w.refuse_direct(&label, thaw, actor, TOKEN_2022, code, &watched);
    }
    w.f.set_foreign_account(vault, TOKEN_2022, unfrozen.data);
    assert_pledged_receipts(&w);
}

// ----------------------------------------------------------------- text mutations ----

#[test]
fn pledge_text_field_mutations_refused() {
    let mut w = World::fiat_lending();
    let honest = w.pledge_text();
    let text = honest.bytes();
    let cases = mutants(&text, honest.altered());
    let pledge = w.pledge_instruction(&honest);
    for (label, altered) in &cases {
        let both = ed25519_shared_instruction(&[w.f.signer(Owner), w.f.signer(Lender)], altered);
        let borrower =
            ed25519_instruction(&[(w.f.signer(Owner), altered), (w.f.signer(Lender), &text)]);
        let lender =
            ed25519_instruction(&[(w.f.signer(Owner), &text), (w.f.signer(Lender), altered)]);
        for (variant, verify) in [
            ("both parties sign it", both),
            ("only the borrower's copy", borrower),
            ("only the lender's copy", lender),
        ] {
            println!("pledge: {label}, {variant}");
            w.call_refused(
                Call::Sponsored(vec![verify, pledge.clone()]),
                MessageMismatch,
            );
        }
    }
    assert!(!w.f.account_exists(w.loan));
    assert!(!w.f.account_exists(w.lock));
    w.pledge_whole_lot();
}

#[test]
fn advance_text_field_mutations_refused() {
    let mut w = World::fiat_lending();
    w.pledge_whole_lot();
    let honest = w.advance_text(w.usd(USD_600K));
    let cases = mutants(&honest.bytes(), honest.altered(w.usd(USD_700K)));
    let before: Loan = w.f.read(w.loan);
    for (label, altered) in &cases {
        println!("advance: {label}");
        let call = w.advance_call(&honest, altered);
        w.call_refused(call, MessageMismatch);
    }
    assert_eq!(w.f.read::<Loan>(w.loan).principal, before.principal);
    w.advance_ok(w.usd(USD_600K));
}

#[test]
fn borrow_text_field_mutations_refused() {
    let mut w = World::pool_demo();
    w.deposit_ok(w.usd(USD_600K));
    let honest = w.borrow_text(w.usd(USD_600K));
    let cases = mutants(
        &honest.bytes(),
        honest.altered(w.usd(USD_700K), w.ata(Outsider)),
    );
    for (label, altered) in &cases {
        println!("borrow: {label}");
        let call = w.borrow_call(&honest, altered);
        w.call_refused(call, MessageMismatch);
    }
    assert_eq!(w.f.read::<Loan>(w.loan).principal, 0);
    w.borrow_ok(w.usd(USD_600K));
}

#[test]
fn release_intent_text_field_mutations_refused() {
    let mut w = World::fiat_demo();
    let honest = w.intent_text(1, TWO_THOUSAND_T, w.usd(USD_400K));
    let altered = honest
        .altered(w.usd(USD_210K), w.usd(USD_30K), true)
        .into_iter()
        .map(|(label, text)| (label, text.intent_bytes()))
        .collect();
    let cases = mutants(&honest.intent_bytes(), altered);
    for (label, altered) in &cases {
        println!("release intent: {label}");
        let call = w.create_intent_call(&honest, altered);
        w.call_refused(call, MessageMismatch);
    }
    assert!(!w.f.account_exists(w.intent_key(1)));
    w.create_intent_ok(&honest);
}

#[test]
fn buyer_acceptance_text_field_mutations_refused() {
    let mut w = World::fiat_demo();
    let terms = w.intent_text(1, TWO_THOUSAND_T, w.usd(USD_400K));
    let intent = w.create_intent_ok(&terms);
    let payment = w.confirm_ok(1, PaymentPurpose::Release, intent, w.usd(USD_400K));
    let honest = w.acceptance_text(intent);
    let altered = honest
        .altered(w.usd(USD_210K), w.usd(USD_30K), false)
        .into_iter()
        .map(|(label, text)| (label, text.acceptance_bytes()))
        .collect();
    let cases = mutants(&honest.acceptance_bytes(), altered);
    for (label, altered) in &cases {
        println!("buyer acceptance: {label}");
        let call = w.sell_call(intent, payment, &honest, altered);
        w.call_refused(call, MessageMismatch);
    }
    assert_eq!(w.f.read::<ReleaseIntent>(intent).status, IntentStatus::Open);
    w.sell_ok(intent, payment);
}

// ---------------------------------------------------------- foreign-protocol accounts ----

/// The fiat release path: facility, valuation, pledge, advance, release intent, payment and
/// two sales, each first refused once per foreign account and then sent as is.
fn fiat_release_path_refuses_foreign_accounts() {
    let mut w = World::new(SettlementMode::FiatAttestationTest);
    let lender_authority = w.authority_of(Lender);
    let owner_authority = w.authority_of(Owner);
    let buyer_authority = w.authority_of(Buyer);
    let (owner, lender, buyer) = (w.owner, w.lender, w.buyer);
    let (facility, loan, lock, lot, position) = (w.facility, w.loan, w.lock, w.lot, w.position);
    let valuation = w.valuation;

    w.refuse_foreign(
        "open_facility",
        &[
            ("authority", lender_authority, WrongOrganisation),
            ("lender_org", lender, WrongOrganisation),
            ("borrower_org", owner, WrongOrganisation),
        ],
        World::open_facility_call,
    );
    let open = w.open_facility_call();
    w.call_ok(open);

    let valid_until = NOW + VALUATION_VALIDITY;
    let set = w.set_valuation_call(valid_until);
    w.call_ok(set);
    w.refuse_foreign(
        "set_valuation",
        &[
            ("authority", lender_authority, WrongOrganisation),
            ("lender_org", lender, WrongOrganisation),
            ("facility", facility, WrongOrganisation),
            ("class_policy", w.class_policy, WrongOrganisation),
            ("custodian_class", w.custodian_class, WrongOrganisation),
            ("valuation", valuation, WrongOrganisation),
        ],
        |w| w.set_valuation_call(valid_until),
    );
    let set = w.set_valuation_call(valid_until);
    w.call_ok(set);
    assert_eq!(w.f.read::<Valuation>(valuation).version, 2);

    let pledge = w.pledge_text();
    w.refuse_foreign(
        "pledge",
        &[
            ("borrower_authority", owner_authority, WrongOrganisation),
            ("lender_authority", lender_authority, WrongOrganisation),
            ("borrower_org", owner, WrongOrganisation),
            ("lender_org", lender, WrongOrganisation),
            ("lot", lot, WrongOrganisation),
            ("position", position, WrongOrganisation),
            ("facility", facility, WrongOrganisation),
        ],
        |w| w.pledge_call(&pledge, &pledge.bytes()),
    );
    w.pledge_whole_lot();

    let advance = w.advance_text(w.usd(USD_600K));
    w.refuse_foreign(
        "record_advance",
        &[
            ("lender_authority", lender_authority, WrongOrganisation),
            ("borrower_authority", owner_authority, WrongOrganisation),
            ("lender_org", lender, WrongOrganisation),
            ("borrower_org", owner, WrongOrganisation),
            ("facility", facility, WrongOrganisation),
            ("loan", loan, WrongOrganisation),
            ("lock", lock, WrongOrganisation),
            ("lot", lot, WrongOrganisation),
            ("valuation", valuation, ValuationMismatch),
        ],
        |w| w.advance_call(&advance, &advance.bytes()),
    );
    w.advance_ok(w.usd(USD_600K));

    let terms = w.intent_text(1, TWO_THOUSAND_T, w.usd(USD_400K));
    w.refuse_foreign(
        "create_release_intent",
        &[
            ("seller_authority", owner_authority, WrongOrganisation),
            ("seller_org", owner, WrongOrganisation),
            ("buyer_org", buyer, RecipientNotApproved),
            ("lender_org", lender, WrongOrganisation),
            ("facility", facility, WrongOrganisation),
            ("loan", loan, WrongOrganisation),
            ("lock", lock, WrongOrganisation),
            ("lot", lot, WrongOrganisation),
            ("position", position, WrongOrganisation),
        ],
        |w| w.create_intent_call(&terms, &terms.intent_bytes()),
    );
    let intent = w.create_intent_ok(&terms);

    let price = w.usd(USD_400K);
    w.refuse_foreign(
        "confirm_payment (Release)",
        &[
            ("authority", lender_authority, WrongOrganisation),
            ("lender_org", lender, WrongOrganisation),
            ("facility", facility, WrongOrganisation),
            ("loan", loan, WrongOrganisation),
            ("subject (the release intent)", intent, PaymentNotBound),
        ],
        |w| w.confirm_call(1, PaymentPurpose::Release, intent, None, price),
    );
    let payment = w.confirm_ok(1, PaymentPurpose::Release, intent, price);

    let acceptance = w.acceptance_text(intent);
    w.refuse_foreign(
        "sell_pledged",
        &[
            ("buyer_authority", buyer_authority, WrongOrganisation),
            ("buyer_org", buyer, WrongOrganisation),
            ("facility", facility, WrongOrganisation),
            ("lender_org", lender, WrongOrganisation),
            ("loan", loan, WrongOrganisation),
            ("lock", lock, WrongOrganisation),
            ("valuation", valuation, ValuationMismatch),
            ("intent", intent, WrongOrganisation),
            ("payment", payment, PaymentNotBound),
            ("lot", lot, WrongOrganisation),
            ("seller_org", owner, WrongOrganisation),
            ("seller_position", position, WrongOrganisation),
        ],
        |w| w.sell_call(intent, payment, &acceptance, &acceptance.acceptance_bytes()),
    );
    w.sell_ok(intent, payment);

    // A second sale reuses the buyer's position, so its protocol field is read too.
    let terms = w.intent_text(2, TWO_THOUSAND_T, w.usd(USD_210K));
    let second = w.create_intent_ok(&terms);
    let second_payment = w.confirm_ok(2, PaymentPurpose::Release, second, w.usd(USD_210K));
    let acceptance = w.acceptance_text(second);
    let buyer_position = w.position_of(buyer);
    w.refuse_foreign(
        "sell_pledged (existing buyer position)",
        &[("buyer_position", buyer_position, WrongOrganisation)],
        |w| {
            w.sell_call(
                second,
                second_payment,
                &acceptance,
                &acceptance.acceptance_bytes(),
            )
        },
    );
    w.sell_ok(second, second_payment);
}

/// The fiat recovery path: a year of accrual, liquidation, a correction, a repayment of
/// USD700,000 and the close, each first refused once per foreign account.
fn fiat_recovery_path_refuses_foreign_accounts() {
    let mut w = World::fiat_demo();
    let lender_authority = w.authority_of(Lender);
    let lender = w.lender;
    let (facility, loan, lock, lot, position, valuation) =
        (w.facility, w.loan, w.lock, w.lot, w.position, w.valuation);
    w.advance_to(NOW + YEAR);

    w.refuse_foreign(
        "liquidate",
        &[
            ("authority", lender_authority, WrongOrganisation),
            ("lender_org", lender, WrongOrganisation),
            ("facility", facility, WrongOrganisation),
            ("loan", loan, WrongOrganisation),
            ("lock", lock, WrongOrganisation),
            ("lot", lot, WrongOrganisation),
            ("valuation", valuation, ValuationMismatch),
        ],
        World::liquidate_call,
    );
    let liquidate = w.liquidate_call();
    w.call_ok(liquidate);
    assert_eq!(w.f.read::<Loan>(loan).status, LoanStatus::Recovery);

    let overpayment = w.usd(USD_700K);
    let target = w.confirm_ok(1, PaymentPurpose::Repayment, loan, overpayment);
    w.refuse_foreign(
        "confirm_payment (Correction)",
        &[("target", target, PaymentNotBound)],
        |w| w.confirm_call(2, PaymentPurpose::Correction, target, Some(target), 0),
    );
    let correct = w.confirm_call(2, PaymentPurpose::Correction, target, Some(target), 0);
    w.call_ok(correct);
    assert_eq!(
        w.f.read::<PaymentAttestation>(target).status,
        PaymentStatus::Voided
    );

    let payment = w.confirm_ok(3, PaymentPurpose::Repayment, loan, overpayment);
    w.refuse_foreign(
        "repay (fiat)",
        &[
            ("authority", lender_authority, WrongOrganisation),
            ("lender_org", lender, WrongOrganisation),
            ("facility", facility, WrongOrganisation),
            ("loan", loan, WrongOrganisation),
            ("payment", payment, PaymentNotBound),
        ],
        |w| w.repay_fiat_call(payment, overpayment),
    );
    let repay = w.repay_fiat_call(payment, overpayment);
    w.call_ok(repay);
    let repaid: Loan = w.f.read(loan);
    assert_eq!((repaid.principal, repaid.booked_interest), (0, 0));

    w.refuse_foreign(
        "close_loan",
        &[
            ("authority", lender_authority, WrongOrganisation),
            ("lender_org", lender, WrongOrganisation),
            ("facility", facility, WrongOrganisation),
            ("loan", loan, WrongOrganisation),
            ("lock", lock, WrongOrganisation),
            ("position", position, WrongOrganisation),
        ],
        World::close_call,
    );
    let close = w.close_call();
    w.call_ok(close);
    assert_eq!(w.f.read::<Loan>(loan).status, LoanStatus::Closed);
}

/// The simulation path: a facility naming the pool, deposits, a withdrawal, a borrow and a
/// simulated repayment, each first refused once per foreign account or foreign pool share.
fn pool_path_refuses_foreign_accounts() {
    let mut w = World::new(SettlementMode::DevnetTokenSimulation);
    let lender_authority = w.authority_of(Lender);
    let owner_authority = w.authority_of(Owner);
    let (owner, lender, pool) = (w.owner, w.lender, w.pool);
    let (facility, loan, lock, lot, valuation) = (w.facility, w.loan, w.lock, w.lot, w.valuation);
    let share = w.share(lender);

    w.refuse_foreign(
        "open_facility (simulation)",
        &[("pool", pool, WrongOrganisation)],
        World::open_facility_call,
    );
    let open = w.open_facility_call();
    w.call_ok(open);
    let set = w.set_valuation_call(NOW + VALUATION_VALIDITY);
    w.call_ok(set);
    w.pledge_whole_lot();
    w.deposit_ok(w.usd(USD_400K));

    let amount = w.usd(USD_210K);
    let depositor = [
        ("authority", lender_authority, WrongOrganisation),
        ("depositor_org", lender, WrongOrganisation),
        ("pool", pool, WrongOrganisation),
        ("share (its pool)", share, WrongOrganisation),
    ];
    w.refuse_foreign("deposit", &depositor, |w| {
        w.deposit_call(Lender, lender, amount)
    });
    w.deposit_ok(amount);
    w.refuse_foreign("withdraw", &depositor, |w| {
        w.withdraw_call(Lender, lender, amount)
    });
    let withdraw = w.withdraw_call(Lender, lender, amount);
    w.call_ok(withdraw);

    let borrow = w.borrow_text(w.usd(USD_400K));
    w.refuse_foreign(
        "borrow",
        &[
            ("borrower_authority", owner_authority, WrongOrganisation),
            ("borrower_org", owner, WrongOrganisation),
            ("lender_org", lender, WrongOrganisation),
            ("facility", facility, WrongOrganisation),
            ("loan", loan, WrongOrganisation),
            ("lock", lock, WrongOrganisation),
            ("lot", lot, WrongOrganisation),
            ("valuation", valuation, ValuationMismatch),
            ("pool", pool, WrongOrganisation),
            ("lender_share (its pool)", share, WrongOrganisation),
        ],
        |w| w.borrow_call(&borrow, &borrow.bytes()),
    );
    w.borrow_ok(w.usd(USD_400K));

    w.refuse_foreign(
        "repay (simulation)",
        &[
            ("facility", facility, WrongOrganisation),
            ("loan", loan, WrongOrganisation),
            ("pool", pool, WrongOrganisation),
            ("lender share (its pool)", share, WrongOrganisation),
        ],
        |w| w.repay_pool_call(Owner, amount),
    );
    let repay = w.repay_pool_call(Owner, amount);
    w.call_ok(repay);
    assert_eq!(
        w.f.read::<Loan>(loan).principal,
        w.usd(USD_400K) - w.usd(USD_210K)
    );
}

#[test]
fn lending_accounts_from_other_protocol_refused() {
    fiat_release_path_refuses_foreign_accounts();
    fiat_recovery_path_refuses_foreign_accounts();
    pool_path_refuses_foreign_accounts();
}

// ------------------------------------------------- accounts of other loans and lots ----

/// The fiat release path: pledge, advance, release intent, payment and two sales. Each
/// instruction is first sent once per same-protocol account whose stored link to the loan,
/// lot, position, facility or organisations has been rewritten to another real account, then
/// sent honestly.
#[test]
fn release_path_accounts_of_other_loans_refused() {
    let mut w = World::fiat_lending();
    let o = w.others();
    let (owner, custodian, lender2, buyer) = (w.owner, w.custodian, w.lender2, w.buyer);
    let (facility, loan, lock, position, valuation) =
        (w.facility, w.loan, w.lock, w.position, w.valuation);

    let pledge = w.pledge_text();
    w.refuse_mismatched(
        "pledge",
        vec![
            Mismatch::new("a position of another lot", WrongOrganisation)
                .set(position, move |p: &mut Position| p.lot = o.lot),
        ],
        |w| w.pledge_call(&pledge, &pledge.bytes()),
    );
    w.pledge_whole_lot();

    let advance = w.advance_text(w.usd(USD_600K));
    w.refuse_mismatched(
        "record_advance",
        vec![
            Mismatch::new("a loan of another facility", WrongOrganisation)
                .set(loan, move |l: &mut Loan| l.facility = o.facility),
            Mismatch::new("a lock of another loan", WrongOrganisation)
                .set(lock, move |l: &mut LockAllocation| l.loan = o.loan),
            Mismatch::new("a lock of another position", WrongOrganisation)
                .set(lock, move |l: &mut LockAllocation| l.position = o.position),
            Mismatch::new("a loan of another lot", WrongOrganisation)
                .set(loan, move |l: &mut Loan| l.lot = o.lot),
            Mismatch::new("a valuation of another facility", ValuationMismatch)
                .set(valuation, move |v: &mut Valuation| v.facility = o.facility),
            Mismatch::new("a valuation of another class", ValuationMismatch)
                .set(valuation, move |v: &mut Valuation| {
                    v.class_policy = o.class_policy
                }),
        ],
        |w| w.advance_call(&advance, &advance.bytes()),
    );
    w.advance_ok(w.usd(USD_600K));

    let terms = w.intent_text(1, TWO_THOUSAND_T, w.usd(USD_400K));
    w.refuse_mismatched(
        "create_release_intent",
        vec![
            Mismatch::new("a position of another owner", WrongOrganisation)
                .set(position, move |p: &mut Position| p.owner = buyer),
            Mismatch::new("a facility of another lender", WrongOrganisation)
                .set(facility, move |f: &mut Facility| f.lender = lender2),
            Mismatch::new("a loan of another facility", WrongOrganisation)
                .set(loan, move |l: &mut Loan| l.facility = o.facility),
            Mismatch::new("a loan of another position", WrongOrganisation)
                .set(loan, move |l: &mut Loan| l.position = o.position),
            Mismatch::new("a lock of another loan", WrongOrganisation)
                .set(lock, move |l: &mut LockAllocation| l.loan = o.loan),
            Mismatch::new("a lock of another position", WrongOrganisation)
                .set(lock, move |l: &mut LockAllocation| l.position = o.position),
            Mismatch::new("a loan of another lot", WrongOrganisation)
                .set(loan, move |l: &mut Loan| l.lot = o.lot),
            Mismatch::new("a position of another lot", WrongOrganisation)
                .set(position, move |p: &mut Position| p.lot = o.lot),
        ],
        |w| w.create_intent_call(&terms, &terms.intent_bytes()),
    );
    let intent = w.create_intent_ok(&terms);

    let price = w.usd(USD_400K);
    w.refuse_mismatched(
        "confirm_payment (Release)",
        vec![
            Mismatch::new("a release intent owned by another program", PaymentNotBound)
                .owned_by(intent, SYSTEM),
        ],
        |w| w.confirm_call(1, PaymentPurpose::Release, intent, None, price),
    );
    let payment = w.confirm_ok(1, PaymentPurpose::Release, intent, price);

    let acceptance = w.acceptance_text(intent);
    w.refuse_mismatched(
        "sell_pledged",
        vec![
            Mismatch::new("an intent of another loan", WrongOrganisation)
                .set(intent, move |i: &mut ReleaseIntent| i.loan = o.loan),
            Mismatch::new("a loan of another facility", WrongOrganisation)
                .set(loan, move |l: &mut Loan| l.facility = o.facility),
            Mismatch::new("a facility of another lender", WrongOrganisation)
                .set(facility, move |f: &mut Facility| f.lender = lender2),
            Mismatch::new("a lock of another loan", WrongOrganisation)
                .set(lock, move |l: &mut LockAllocation| l.loan = o.loan),
            Mismatch::new("a lock of another position", WrongOrganisation)
                .set(lock, move |l: &mut LockAllocation| l.position = o.position),
            Mismatch::new("a loan and lock of another position", WrongOrganisation)
                .set(loan, move |l: &mut Loan| l.position = o.position)
                .set(lock, move |l: &mut LockAllocation| l.position = o.position),
            Mismatch::new(
                "a loan, lock and intent of another position",
                WrongOrganisation,
            )
            .set(loan, move |l: &mut Loan| l.position = o.position)
            .set(lock, move |l: &mut LockAllocation| l.position = o.position)
            .set(intent, move |i: &mut ReleaseIntent| i.position = o.position),
            Mismatch::new("an intent of another lot", WrongOrganisation)
                .set(intent, move |i: &mut ReleaseIntent| i.lot = o.lot),
            Mismatch::new("a seller position of another lot", WrongOrganisation)
                .set(position, move |p: &mut Position| p.lot = o.lot),
            Mismatch::new("a loan of another lot", WrongOrganisation)
                .set(loan, move |l: &mut Loan| l.lot = o.lot),
            Mismatch::new("an intent of another seller", WrongOrganisation)
                .set(intent, move |i: &mut ReleaseIntent| i.seller = custodian),
            Mismatch::new(
                "a seller position and loan of another owner",
                WrongOrganisation,
            )
            .set(position, move |p: &mut Position| p.owner = custodian)
            .set(loan, move |l: &mut Loan| l.borrower = custodian),
            Mismatch::new("a loan of another borrower", WrongOrganisation)
                .set(loan, move |l: &mut Loan| l.borrower = custodian),
            Mismatch::new("a valuation of another facility", ValuationMismatch)
                .set(valuation, move |v: &mut Valuation| v.facility = o.facility),
            Mismatch::new("a valuation of another class", ValuationMismatch)
                .set(valuation, move |v: &mut Valuation| {
                    v.class_policy = o.class_policy
                }),
            Mismatch::new("a valuation of another grade", ValuationMismatch)
                .set(valuation, |v: &mut Valuation| v.grade = GRADES[1].into()),
            Mismatch::new("a valuation of another site", ValuationMismatch)
                .set(valuation, move |v: &mut Valuation| {
                    v.custodian_class = o.custodian_class
                }),
        ],
        |w| w.sell_call(intent, payment, &acceptance, &acceptance.acceptance_bytes()),
    );
    w.sell_ok(intent, payment);

    // A second sale reuses the buyer's position, so its stored lot and owner are read too.
    let terms = w.intent_text(2, TWO_THOUSAND_T, w.usd(USD_210K));
    let second = w.create_intent_ok(&terms);
    let second_payment = w.confirm_ok(2, PaymentPurpose::Release, second, w.usd(USD_210K));
    let acceptance = w.acceptance_text(second);
    let buyer_position = w.position_of(buyer);
    w.refuse_mismatched(
        "sell_pledged (existing buyer position)",
        vec![
            Mismatch::new("a buyer position of another lot", WrongOrganisation)
                .set(buyer_position, move |p: &mut Position| p.lot = o.lot),
            Mismatch::new("a buyer position of another owner", WrongOrganisation)
                .set(buyer_position, move |p: &mut Position| p.owner = owner),
        ],
        |w| {
            w.sell_call(
                second,
                second_payment,
                &acceptance,
                &acceptance.acceptance_bytes(),
            )
        },
    );
    w.sell_ok(second, second_payment);
}

/// The fiat recovery path: a year of accrual, liquidation, a correction, a repayment of
/// USD700,000 and the close, each first refused once per mismatched account.
#[test]
fn recovery_path_accounts_of_other_loans_refused() {
    let mut w = World::fiat_demo();
    let o = w.others();
    let lender2 = w.lender2;
    let (loan, lock, position, valuation) = (w.loan, w.lock, w.position, w.valuation);
    w.advance_to(NOW + YEAR);

    w.refuse_mismatched(
        "liquidate",
        vec![
            Mismatch::new("a loan of another facility", WrongOrganisation)
                .set(loan, move |l: &mut Loan| l.facility = o.facility),
            Mismatch::new("a lock of another loan", WrongOrganisation)
                .set(lock, move |l: &mut LockAllocation| l.loan = o.loan),
            Mismatch::new("a lock of another position", WrongOrganisation)
                .set(lock, move |l: &mut LockAllocation| l.position = o.position),
            Mismatch::new("a loan of another lot", WrongOrganisation)
                .set(loan, move |l: &mut Loan| l.lot = o.lot),
            Mismatch::new("a valuation of another facility", ValuationMismatch)
                .set(valuation, move |v: &mut Valuation| v.facility = o.facility),
            Mismatch::new("a valuation of another class", ValuationMismatch)
                .set(valuation, move |v: &mut Valuation| {
                    v.class_policy = o.class_policy
                }),
            Mismatch::new("a valuation of another grade", ValuationMismatch)
                .set(valuation, |v: &mut Valuation| v.grade = GRADES[1].into()),
            Mismatch::new("a valuation of another site", ValuationMismatch)
                .set(valuation, move |v: &mut Valuation| {
                    v.custodian_class = o.custodian_class
                }),
        ],
        World::liquidate_call,
    );
    let liquidate = w.liquidate_call();
    w.call_ok(liquidate);
    assert_eq!(w.f.read::<Loan>(loan).status, LoanStatus::Recovery);

    let overpayment = w.usd(USD_700K);
    w.refuse_mismatched(
        "confirm_payment (Repayment)",
        vec![
            Mismatch::new("a loan of another facility", WrongOrganisation)
                .set(loan, move |l: &mut Loan| l.facility = o.facility),
        ],
        |w| w.confirm_call(5, PaymentPurpose::Repayment, loan, None, overpayment),
    );
    let target = w.confirm_ok(1, PaymentPurpose::Repayment, loan, overpayment);
    let other_record = w.confirm_ok(4, PaymentPurpose::Repayment, loan, overpayment);
    w.refuse_mismatched(
        "confirm_payment (Correction)",
        vec![
            Mismatch::new("a subject other than the target", PaymentNotBound).send(move |w| {
                w.confirm_call(2, PaymentPurpose::Correction, other_record, Some(target), 0)
            }),
            Mismatch::new("a target of another lender", PaymentNotBound)
                .set(target, move |p: &mut PaymentAttestation| p.lender = lender2),
            Mismatch::new("a target of another loan", PaymentNotBound)
                .set(target, move |p: &mut PaymentAttestation| p.loan = o.loan),
        ],
        |w| w.confirm_call(2, PaymentPurpose::Correction, target, Some(target), 0),
    );
    let correct = w.confirm_call(2, PaymentPurpose::Correction, target, Some(target), 0);
    w.call_ok(correct);
    assert_eq!(
        w.f.read::<PaymentAttestation>(target).status,
        PaymentStatus::Voided
    );

    let payment = w.confirm_ok(3, PaymentPurpose::Repayment, loan, overpayment);
    w.refuse_mismatched(
        "repay (fiat)",
        vec![
            Mismatch::new("a loan of another facility", WrongOrganisation)
                .set(loan, move |l: &mut Loan| l.facility = o.facility),
            Mismatch::new("a payment of another lender", PaymentNotBound)
                .set(payment, move |p: &mut PaymentAttestation| {
                    p.lender = lender2
                }),
            Mismatch::new("a payment of another loan", PaymentNotBound)
                .set(payment, move |p: &mut PaymentAttestation| p.loan = o.loan),
            Mismatch::new("a payment in another currency", CurrencyMismatch)
                .set(payment, |p: &mut PaymentAttestation| p.currency = EUR),
        ],
        |w| w.repay_fiat_call(payment, overpayment),
    );
    let repay = w.repay_fiat_call(payment, overpayment);
    w.call_ok(repay);
    let repaid: Loan = w.f.read(loan);
    assert_eq!((repaid.principal, repaid.booked_interest), (0, 0));

    w.refuse_mismatched(
        "close_loan",
        vec![
            Mismatch::new("a loan of another facility", WrongOrganisation)
                .set(loan, move |l: &mut Loan| l.facility = o.facility),
            Mismatch::new("a lock of another loan", WrongOrganisation)
                .set(lock, move |l: &mut LockAllocation| l.loan = o.loan),
            Mismatch::new("a loan of another position", WrongOrganisation)
                .set(loan, move |l: &mut Loan| l.position = o.position),
            Mismatch::new("a lock of another position", WrongOrganisation)
                .set(lock, move |l: &mut LockAllocation| l.position = o.position),
            Mismatch::new("a position of another lot", WrongOrganisation)
                .set(position, move |p: &mut Position| p.lot = o.lot),
        ],
        World::close_call,
    );
    let close = w.close_call();
    w.call_ok(close);
    assert_eq!(w.f.read::<Loan>(loan).status, LoanStatus::Closed);
    assert_eq!(w.f.read::<Position>(position).locked_kg, 0);
}

/// The simulation path: a borrow and a simulated repayment, each first refused once per
/// mismatched account or token slot: a loan, lock or valuation linked elsewhere, the other
/// lender's organisation, another SPL Token mint, another token account in the vault slot, and
/// a borrower account of another mint.
#[test]
fn pool_path_accounts_of_other_loans_refused() {
    let mut w = World::pool_demo();
    let o = w.others();
    let payer = w.f.payer();
    w.f.set_foreign_account(OTHER_MINT, SPL_TOKEN, mint_data(Some(payer), 0, MICRO));
    let create = create_associated_token_account_idempotent(
        &payer,
        &w.f.key(Owner),
        &OTHER_MINT,
        &SPL_TOKEN,
    );
    w.f.sponsored_ok(&[create]);
    let owner_other_mint = spl_ata(w.f.key(Owner), OTHER_MINT);
    assert_eq!(w.spl_account(owner_other_mint).mint, OTHER_MINT);
    w.deposit_ok(w.usd(USD_600K));
    let (lender, lender2, loan, lock, valuation) =
        (w.lender, w.lender2, w.loan, w.lock, w.valuation);
    let (pool_vault, lender2_tokens, owner_tokens) = (w.pool_vault, w.ata(Lender2), w.ata(Owner));

    let amount = w.usd(USD_400K);
    let borrow = w.borrow_text(amount);
    let other_lender = BorrowText {
        lender: LENDER2_NAME.into(),
        ..borrow.clone()
    };
    let other_destination = BorrowText {
        destination: owner_other_mint,
        ..borrow.clone()
    };
    w.refuse_mismatched(
        "borrow",
        vec![
            Mismatch::new("the other lender's organisation", WrongOrganisation).send(move |w| {
                swap(
                    w.borrow_call(&other_lender, &other_lender.bytes()),
                    lender,
                    lender2,
                )
            }),
            Mismatch::new("a loan of another facility", WrongOrganisation)
                .set(loan, move |l: &mut Loan| l.facility = o.facility),
            Mismatch::new("a lock of another loan", WrongOrganisation)
                .set(lock, move |l: &mut LockAllocation| l.loan = o.loan),
            Mismatch::new("a lock of another position", WrongOrganisation)
                .set(lock, move |l: &mut LockAllocation| l.position = o.position),
            Mismatch::new("a loan of another lot", WrongOrganisation)
                .set(loan, move |l: &mut Loan| l.lot = o.lot),
            Mismatch::new("another mint", MintMismatch).send({
                let borrow = borrow.clone();
                move |w| {
                    swap(
                        w.borrow_call(&borrow, &borrow.bytes()),
                        POOL_MINT,
                        OTHER_MINT,
                    )
                }
            }),
            Mismatch::new("another token account as the vault", MintMismatch).send({
                let borrow = borrow.clone();
                move |w| {
                    swap(
                        w.borrow_call(&borrow, &borrow.bytes()),
                        pool_vault,
                        lender2_tokens,
                    )
                }
            }),
            Mismatch::new("a destination of another mint", MintMismatch).send(move |w| {
                swap(
                    w.borrow_call(&other_destination, &other_destination.bytes()),
                    owner_tokens,
                    owner_other_mint,
                )
            }),
            Mismatch::new("a valuation of another facility", ValuationMismatch)
                .set(valuation, move |v: &mut Valuation| v.facility = o.facility),
            Mismatch::new("a valuation of another class", ValuationMismatch)
                .set(valuation, move |v: &mut Valuation| {
                    v.class_policy = o.class_policy
                }),
            Mismatch::new("a valuation of another grade", ValuationMismatch)
                .set(valuation, |v: &mut Valuation| v.grade = GRADES[1].into()),
            Mismatch::new("a valuation of another site", ValuationMismatch)
                .set(valuation, move |v: &mut Valuation| {
                    v.custodian_class = o.custodian_class
                }),
        ],
        |w| w.borrow_call(&borrow, &borrow.bytes()),
    );
    w.borrow_ok(amount);

    let repayment = w.usd(USD_210K);
    w.refuse_mismatched(
        "repay (simulation)",
        vec![
            Mismatch::new("a loan of another facility", WrongOrganisation)
                .set(loan, move |l: &mut Loan| l.facility = o.facility),
            Mismatch::new("another mint", MintMismatch)
                .send(move |w| swap(w.repay_pool_call(Owner, repayment), POOL_MINT, OTHER_MINT)),
            Mismatch::new("another token account as the vault", MintMismatch).send(move |w| {
                swap(
                    w.repay_pool_call(Owner, repayment),
                    pool_vault,
                    lender2_tokens,
                )
            }),
            Mismatch::new("a payer account of another mint", MintMismatch).send(move |w| {
                swap(
                    w.repay_pool_call(Owner, repayment),
                    owner_tokens,
                    owner_other_mint,
                )
            }),
        ],
        |w| w.repay_pool_call(Owner, repayment),
    );
    let repay = w.repay_pool_call(Owner, repayment);
    w.call_ok(repay);
    assert_eq!(w.f.read::<Loan>(loan).principal, amount - repayment);
}

/// A valuation update whose stored valuation names another class, grade or site, and a sale
/// accepted into the seller's own position.
#[test]
fn valuation_reuse_and_sale_to_own_position_refused() {
    let mut w = World::fiat_demo();
    let o = w.others();
    let (owner, valuation) = (w.owner, w.valuation);

    let valid_until = NOW + VALUATION_VALIDITY;
    w.refuse_mismatched(
        "set_valuation (update)",
        vec![
            Mismatch::new("a stored valuation of another class", WrongOrganisation)
                .set(valuation, move |v: &mut Valuation| {
                    v.class_policy = o.class_policy
                }),
            Mismatch::new("a stored valuation of another grade", WrongOrganisation)
                .set(valuation, |v: &mut Valuation| v.grade = GRADES[1].into()),
            Mismatch::new("a stored valuation of another site", WrongOrganisation)
                .set(valuation, move |v: &mut Valuation| {
                    v.custodian_class = o.custodian_class
                }),
        ],
        |w| w.set_valuation_call(valid_until),
    );
    let set = w.set_valuation_call(valid_until);
    w.call_ok(set);
    assert_eq!(w.f.read::<Valuation>(valuation).version, 2);

    // The owner's organisation stored as a Buyer, named as the intent's buyer, and the owner's
    // Authority holding BUY: every check before the position comparison passes, and the buyer
    // position the seeds give is the seller's own.
    let terms = w.intent_text(1, TWO_THOUSAND_T, w.usd(USD_400K));
    let intent = w.create_intent_ok(&terms);
    let payment = w.confirm_ok(1, PaymentPurpose::Release, intent, w.usd(USD_400K));
    let acceptance = w.acceptance_text(intent);
    let own = ReleaseText {
        buyer: OWNER_NAME.into(),
        ..acceptance.clone()
    };
    let owner_authority = w.authority_of(Owner);
    assert_eq!(w.position_of(owner), w.position);
    w.refuse_mismatched(
        "sell_pledged",
        vec![
            Mismatch::new("a buyer position that is the seller's", InvalidField)
                .set(owner, |org: &mut Organisation| org.role = Role::Buyer)
                .set(intent, move |i: &mut ReleaseIntent| i.buyer = owner)
                .set(owner_authority, |a: &mut Authority| a.scopes |= scope::BUY)
                .send(move |w| {
                    w.sell_call_by(intent, payment, &own, &own.acceptance_bytes(), owner, Owner)
                }),
        ],
        |w| w.sell_call(intent, payment, &acceptance, &acceptance.acceptance_bytes()),
    );
    w.sell_ok(intent, payment);
}

/// The pool token slots: another organisation's pool-mint account as the depositor's account, a
/// stored share of another organisation, and the vault itself named as the depositor's account,
/// the borrow destination or the repayer's account. For the vault cases the harness writes the
/// wallet in as the vault's token owner, so that the owner check passes and only the vault
/// comparison is left to refuse.
#[test]
fn pool_token_accounts_of_other_owners_refused() {
    let mut w = World::pool_demo();
    w.deposit_ok(w.usd(USD_600K));
    let (lender, lender2, pool_vault) = (w.lender, w.lender2, w.pool_vault);
    let (lender_tokens, lender2_tokens, owner_tokens) =
        (w.ata(Lender), w.ata(Lender2), w.ata(Owner));
    let (lender_wallet, owner_wallet) = (w.f.key(Lender), w.f.key(Owner));
    let share = w.share(lender);
    let amount = w.usd(USD_30K);

    w.refuse_mismatched(
        "deposit",
        vec![
            Mismatch::new("another organisation's token account", InvalidField).send(move |w| {
                swap(
                    w.deposit_call(Lender, lender, amount),
                    lender_tokens,
                    lender2_tokens,
                )
            }),
            Mismatch::new("a stored share of another organisation", WrongOrganisation)
                .set(share, move |s: &mut PoolShare| s.organisation = lender2),
            Mismatch::new("the vault as the depositor's account", InvalidField)
                .bytes_at(pool_vault, TOKEN_OWNER_OFFSET, lender_wallet)
                .send(move |w| {
                    swap(
                        w.deposit_call(Lender, lender, amount),
                        lender_tokens,
                        pool_vault,
                    )
                }),
        ],
        |w| w.deposit_call(Lender, lender, amount),
    );
    w.deposit_ok(amount);

    w.refuse_mismatched(
        "withdraw",
        vec![
            Mismatch::new("another organisation's token account", InvalidField).send(move |w| {
                swap(
                    w.withdraw_call(Lender, lender, amount),
                    lender_tokens,
                    lender2_tokens,
                )
            }),
            Mismatch::new("the vault as the depositor's account", InvalidField)
                .bytes_at(pool_vault, TOKEN_OWNER_OFFSET, lender_wallet)
                .send(move |w| {
                    swap(
                        w.withdraw_call(Lender, lender, amount),
                        lender_tokens,
                        pool_vault,
                    )
                }),
        ],
        |w| w.withdraw_call(Lender, lender, amount),
    );
    let withdraw = w.withdraw_call(Lender, lender, amount);
    w.call_ok(withdraw);

    let borrowed = w.usd(USD_400K);
    let borrow = w.borrow_text(borrowed);
    let to_vault = BorrowText {
        destination: pool_vault,
        ..borrow.clone()
    };
    w.refuse_mismatched(
        "borrow",
        vec![Mismatch::new("the vault as the destination", InvalidField)
            .bytes_at(pool_vault, TOKEN_OWNER_OFFSET, owner_wallet)
            .send(move |w| {
                swap(
                    w.borrow_call(&to_vault, &to_vault.bytes()),
                    owner_tokens,
                    pool_vault,
                )
            })],
        |w| w.borrow_call(&borrow, &borrow.bytes()),
    );
    w.borrow_ok(borrowed);

    let repayment = w.usd(USD_210K);
    w.refuse_mismatched(
        "repay (simulation)",
        vec![
            Mismatch::new("the vault as the repayer's account", InvalidField)
                .bytes_at(pool_vault, TOKEN_OWNER_OFFSET, owner_wallet)
                .send(move |w| {
                    swap(
                        w.repay_pool_call(Owner, repayment),
                        owner_tokens,
                        pool_vault,
                    )
                }),
        ],
        |w| w.repay_pool_call(Owner, repayment),
    );
    let repay = w.repay_pool_call(Owner, repayment);
    w.call_ok(repay);
    assert_eq!(w.f.read::<Loan>(w.loan).principal, borrowed - repayment);
}

/// Each lending instruction that a wallet signs binds that wallet to the Authority it names.
/// Outsider signs in a lender's place, first naming the lender's real Authority (refused by the
/// Authority seeds), then an Authority at its own address that records the lender's wallet
/// for the lender's organisation (`WrongSigner`). Each honest call then succeeds.
#[test]
fn lending_signer_with_another_wallets_authority_refused() {
    let mut w = World::fiat_lending();
    let lender = w.lender;
    w.forge_wallet_record(Outsider, lender, Lender, scope::LEND);
    w.pledge_whole_lot();

    let advance = w.advance_text(w.usd(USD_600K));
    w.refuse_other_signer("record_advance", Lender, |w| {
        w.advance_call(&advance, &advance.bytes())
    });
    w.advance_ok(w.usd(USD_600K));

    w.advance_to(NOW + YEAR);
    w.refuse_other_signer("liquidate", Lender, World::liquidate_call);
    let liquidate = w.liquidate_call();
    w.call_ok(liquidate);

    let loan = w.loan;
    let overpayment = w.usd(USD_700K);
    w.refuse_other_signer("confirm_payment", Lender, |w| {
        w.confirm_call(1, PaymentPurpose::Repayment, loan, None, overpayment)
    });
    let payment = w.confirm_ok(1, PaymentPurpose::Repayment, loan, overpayment);

    w.refuse_other_signer("repay (fiat)", Lender, |w| {
        w.repay_fiat_call(payment, overpayment)
    });
    let repay = w.repay_fiat_call(payment, overpayment);
    w.call_ok(repay);

    w.refuse_other_signer("close_loan", Lender, World::close_call);
    let close = w.close_call();
    w.call_ok(close);
    assert_eq!(w.f.read::<Loan>(loan).status, LoanStatus::Closed);

    // The pool: Outsider holds test tokens of its own, so with the binding gone it could move
    // them into, and out of, Lender One Bank's share.
    let mut w = World::pool_demo();
    let lender = w.lender;
    w.forge_wallet_record(Outsider, lender, Lender, scope::POOL);
    let amount = w.usd(USD_30K);
    for (instruction, deposit) in [("deposit", true), ("withdraw", false)] {
        let forged = w.authority_of(Outsider);
        let real = w.authority_of(Lender);
        let call = |w: &World, authority: Pubkey| {
            let call = if deposit {
                w.deposit_call(Outsider, lender, amount)
            } else {
                w.withdraw_call(Outsider, lender, amount)
            };
            swap(call, forged, authority)
        };
        println!("{instruction}: Outsider with Lender's Authority -> ConstraintSeeds");
        let literal = call(&w, real);
        w.call_refused_anchor(literal, anchor_lang::error::ErrorCode::ConstraintSeeds);
        println!("{instruction}: Outsider with an Authority recording Lender -> WrongSigner");
        let refused = call(&w, forged);
        w.call_refused(refused, WrongSigner);
        if deposit {
            w.deposit_ok(amount);
        } else {
            let withdraw = w.withdraw_call(Lender, lender, amount);
            w.call_ok(withdraw);
        }
    }
    let share: PoolShare = w.f.read(w.share(lender));
    assert_eq!(share.shares, 0);
}
