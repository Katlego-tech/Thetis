use std::fmt::{Arguments, Write};

use anchor_lang::solana_program::pubkey::Pubkey;

use crate::state::{HandoverStage, ObservationKind, MAX_DISPLAY_NAME};

pub fn format_tonnes(kg: u64) -> String {
    format!(
        "{}.{:03} t",
        group_thousands(&(kg / 1_000).to_string()),
        kg % 1_000
    )
}

/// Writes `<code> <whole>[.<fraction>]`, with comma thousands separators in the whole part.
/// `minor` is in the currency's smallest unit and `decimals` is the number of fraction digits.
/// The code must be uppercase ASCII (facility policy guarantees it).
pub fn format_money(minor: u64, decimals: u8, code: &[u8; 3]) -> String {
    let decimals = usize::from(decimals);
    let digits = minor.to_string();
    // Pad so that there is always at least one whole digit before the fraction.
    let padded = format!("{digits:0>width$}", width = decimals + 1);
    let (whole, fraction) = padded.split_at(padded.len() - decimals);
    let code: String = code.iter().copied().map(char::from).collect();
    let whole = group_thousands(whole);
    if decimals == 0 {
        format!("{code} {whole}")
    } else {
        format!("{code} {whole}.{fraction}")
    }
}

/// Writes basis points as a percentage with two decimals: 6000 is `60.00%`.
pub fn format_bps(bps: u16) -> String {
    format!("{}.{:02}%", bps / 100, bps % 100)
}

fn group_thousands(whole: &str) -> String {
    let mut grouped = String::with_capacity(whole.len() + whole.len() / 3);
    for (index, digit) in whole.bytes().enumerate() {
        if index != 0 && (whole.len() - index).is_multiple_of(3) {
            grouped.push(',');
        }
        grouped.push(char::from(digit));
    }
    grouped
}

pub fn format_sast(unix: i64) -> String {
    const SECONDS_PER_DAY: i64 = 86_400;
    const SAST_OFFSET: i64 = 7_200;
    let local_seconds = unix.rem_euclid(SECONDS_PER_DAY) + SAST_OFFSET;
    let day = unix.div_euclid(SECONDS_PER_DAY) + local_seconds / SECONDS_PER_DAY;
    let second_of_day = local_seconds % SECONDS_PER_DAY;

    // Convert Unix days using March-based Gregorian years, where the leap day is last.
    // An era has 400 years and exactly 146,097 days.
    let march_days = day + 719_468;
    let era = march_days.div_euclid(146_097);
    let day_of_era = march_days.rem_euclid(146_097);
    let year_of_era =
        (day_of_era - day_of_era / 1_460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let march_month = (5 * day_of_year + 2) / 153;
    let day_of_month = day_of_year - (153 * march_month + 2) / 5 + 1;
    let month = if march_month < 10 {
        march_month + 3
    } else {
        march_month - 9
    };
    let year = era * 400 + year_of_era + i64::from(month <= 2);

    let hour = second_of_day / 3_600;
    let minute = second_of_day / 60 % 60;
    let second = second_of_day % 60;
    format!("{year:04}-{month:02}-{day_of_month:02} {hour:02}:{minute:02}:{second:02} SAST")
}

#[allow(
    clippy::too_many_arguments,
    reason = "the fields are the signed message contract"
)]
pub fn issue_message(
    program_id: &Pubkey,
    instance_id: &[u8; 16],
    lot_id: &str,
    class_code: &str,
    class_version: u32,
    grade: &str,
    quantity_kg: u64,
    owner: &str,
    custodian: &str,
    site_code: &str,
    intake_digest: &[u8; 32],
    origin: Option<(&[u8; 32], u32)>,
    valid_until: i64,
) -> Vec<u8> {
    let quantity = format_tonnes(quantity_kg);
    let intake = digest_hex(intake_digest);
    let origin = origin.map_or_else(
        || "not required".to_owned(),
        |(sha, version)| format!("{} v{version}", digest_hex(sha)),
    );
    signed_message(
        program_id,
        instance_id,
        "Issue lot",
        format_args!(
            "Lot: {lot_id}\n\
             Class: {class_code} v{class_version}\n\
             Grade: {grade}\n\
             Quantity: {quantity}\n\
             Owner: {owner}\n\
             Custodian: {custodian}\n\
             Site: {site_code}\n\
             Intake: {intake}\n\
             Origin document: {origin}"
        ),
        valid_until,
    )
}

#[allow(
    clippy::too_many_arguments,
    reason = "the fields are the signed message contract"
)]
pub fn transfer_message(
    program_id: &Pubkey,
    instance_id: &[u8; 16],
    lot_id: &str,
    quantity_kg: u64,
    from: &str,
    to: &str,
    expected_revision: u64,
    valid_until: i64,
) -> Vec<u8> {
    let quantity = format_tonnes(quantity_kg);
    signed_message(
        program_id,
        instance_id,
        "Transfer receipts",
        format_args!(
            "Lot: {lot_id}\n\
             Quantity: {quantity}\n\
             From: {from}\n\
             To: {to}\n\
             Revision: {expected_revision}"
        ),
        valid_until,
    )
}

#[allow(
    clippy::too_many_arguments,
    reason = "the fields are the signed message contract"
)]
pub fn split_message(
    program_id: &Pubkey,
    instance_id: &[u8; 16],
    lot_id: &str,
    child_lot_id: &str,
    quantity_kg: u64,
    owner: &str,
    custodian: &str,
    expected_revision: u64,
    valid_until: i64,
) -> Vec<u8> {
    let quantity = format_tonnes(quantity_kg);
    signed_message(
        program_id,
        instance_id,
        "Split lot",
        format_args!(
            "Lot: {lot_id}\n\
             New lot: {child_lot_id}\n\
             Quantity: {quantity}\n\
             Owner: {owner}\n\
             Custodian: {custodian}\n\
             Revision: {expected_revision}"
        ),
        valid_until,
    )
}

#[allow(
    clippy::too_many_arguments,
    reason = "the fields are the signed message contract"
)]
pub fn redeem_message(
    program_id: &Pubkey,
    instance_id: &[u8; 16],
    lot_id: &str,
    quantity_kg: u64,
    holder: &str,
    custodian: &str,
    collection_ticket: &[u8; 32],
    expected_revision: u64,
    valid_until: i64,
) -> Vec<u8> {
    let quantity = format_tonnes(quantity_kg);
    let ticket = digest_hex(collection_ticket);
    signed_message(
        program_id,
        instance_id,
        "Collect from stockyard",
        format_args!(
            "Lot: {lot_id}\n\
             Quantity: {quantity}\n\
             Holder: {holder}\n\
             Custodian: {custodian}\n\
             Collection ticket: {ticket}\n\
             Revision: {expected_revision}"
        ),
        valid_until,
    )
}

#[allow(
    clippy::too_many_arguments,
    reason = "the fields are the signed message contract"
)]
pub fn pledge_message(
    program_id: &Pubkey,
    instance_id: &[u8; 16],
    lot_id: &str,
    quantity_kg: u64,
    owner: &str,
    lender: &str,
    facility_id: &[u8; 16],
    loan_index: u32,
    currency: &[u8; 3],
    rate_bps: u16,
    max_ltv_bps: u16,
    terms_version: u32,
    expected_revision: u64,
    valid_until: i64,
) -> Vec<u8> {
    let quantity = format_tonnes(quantity_kg);
    let facility = hex(facility_id);
    let currency: String = currency.iter().copied().map(char::from).collect();
    let rate = format_bps(rate_bps);
    let max_ltv = format_bps(max_ltv_bps);
    signed_message(
        program_id,
        instance_id,
        "Pledge receipts",
        format_args!(
            "Lot: {lot_id}\n\
             Quantity: {quantity}\n\
             Owner: {owner}\n\
             Lender: {lender}\n\
             Facility: {facility}\n\
             Loan: {loan_index}\n\
             Currency: {currency}\n\
             Rate: {rate} a year, simple, actual/365\n\
             Max LTV: {max_ltv}\n\
             Terms: v{terms_version}\n\
             Revision: {expected_revision}"
        ),
        valid_until,
    )
}

#[allow(
    clippy::too_many_arguments,
    reason = "the fields are the signed message contract"
)]
pub fn advance_message(
    program_id: &Pubkey,
    instance_id: &[u8; 16],
    lot_id: &str,
    owner: &str,
    lender: &str,
    facility_id: &[u8; 16],
    loan_index: u32,
    amount: u64,
    principal_after: u64,
    currency: &[u8; 3],
    decimals: u8,
    rate_bps: u16,
    terms_version: u32,
    expected_revision: u64,
    valid_until: i64,
) -> Vec<u8> {
    let facility = hex(facility_id);
    let advance = format_money(amount, decimals, currency);
    let principal_after = format_money(principal_after, decimals, currency);
    let rate = format_bps(rate_bps);
    signed_message(
        program_id,
        instance_id,
        "Accept advance",
        format_args!(
            "Lot: {lot_id}\n\
             Owner: {owner}\n\
             Lender: {lender}\n\
             Facility: {facility}\n\
             Loan: {loan_index}\n\
             Advance: {advance}\n\
             Principal after: {principal_after}\n\
             Rate: {rate} a year, simple, actual/365\n\
             Terms: v{terms_version}\n\
             Revision: {expected_revision}"
        ),
        valid_until,
    )
}

#[allow(
    clippy::too_many_arguments,
    reason = "the fields are the signed message contract"
)]
pub fn release_intent_message(
    program_id: &Pubkey,
    instance_id: &[u8; 16],
    lot_id: &str,
    quantity_kg: u64,
    seller: &str,
    buyer: &str,
    lender: &str,
    facility_id: &[u8; 16],
    loan_index: u32,
    nonce: u64,
    price: u64,
    top_up: u64,
    currency: &[u8; 3],
    decimals: u8,
    expires_at: i64,
    expected_revision: u64,
    valid_until: i64,
) -> Vec<u8> {
    let quantity = format_tonnes(quantity_kg);
    let facility = hex(facility_id);
    let price = format_money(price, decimals, currency);
    let top_up = format_money(top_up, decimals, currency);
    let intent_expires = format_sast(expires_at);
    signed_message(
        program_id,
        instance_id,
        "Create release intent",
        format_args!(
            "Lot: {lot_id}\n\
             Quantity: {quantity}\n\
             Seller: {seller}\n\
             Buyer: {buyer}\n\
             Lender: {lender}\n\
             Facility: {facility}\n\
             Loan: {loan_index}\n\
             Intent: {nonce}\n\
             Price: {price}\n\
             Top-up: {top_up}\n\
             Intent expires: {intent_expires}\n\
             Revision: {expected_revision}"
        ),
        valid_until,
    )
}

#[allow(
    clippy::too_many_arguments,
    reason = "the fields are the signed message contract"
)]
pub fn buy_pledged_message(
    program_id: &Pubkey,
    instance_id: &[u8; 16],
    lot_id: &str,
    quantity_kg: u64,
    seller: &str,
    buyer: &str,
    lender: &str,
    facility_id: &[u8; 16],
    loan_index: u32,
    nonce: u64,
    price: u64,
    top_up: u64,
    currency: &[u8; 3],
    decimals: u8,
    expected_revision: u64,
    valid_until: i64,
) -> Vec<u8> {
    let quantity = format_tonnes(quantity_kg);
    let facility = hex(facility_id);
    let price = format_money(price, decimals, currency);
    let top_up = format_money(top_up, decimals, currency);
    signed_message(
        program_id,
        instance_id,
        "Buy pledged receipts",
        format_args!(
            "Lot: {lot_id}\n\
             Quantity: {quantity}\n\
             Seller: {seller}\n\
             Buyer: {buyer}\n\
             Lender: {lender}\n\
             Facility: {facility}\n\
             Loan: {loan_index}\n\
             Intent: {nonce}\n\
             Price: {price}\n\
             Top-up: {top_up}\n\
             Revision: {expected_revision}"
        ),
        valid_until,
    )
}

#[allow(
    clippy::too_many_arguments,
    reason = "the fields are the signed message contract"
)]
pub fn borrow_message(
    program_id: &Pubkey,
    instance_id: &[u8; 16],
    lot_id: &str,
    owner: &str,
    lender: &str,
    facility_id: &[u8; 16],
    loan_index: u32,
    amount: u64,
    principal_after: u64,
    currency: &[u8; 3],
    decimals: u8,
    destination: &Pubkey,
    rate_bps: u16,
    expected_revision: u64,
    valid_until: i64,
) -> Vec<u8> {
    let facility = hex(facility_id);
    let amount = format_money(amount, decimals, currency);
    let principal_after = format_money(principal_after, decimals, currency);
    let rate = format_bps(rate_bps);
    signed_message(
        program_id,
        instance_id,
        "Borrow test tokens",
        format_args!(
            "Lot: {lot_id}\n\
             Owner: {owner}\n\
             Lender: {lender}\n\
             Facility: {facility}\n\
             Loan: {loan_index}\n\
             Amount: {amount}\n\
             Principal after: {principal_after}\n\
             Pay to: {destination}\n\
             Rate: {rate} a year, simple, actual/365\n\
             Revision: {expected_revision}"
        ),
        valid_until,
    )
}

#[allow(
    clippy::too_many_arguments,
    reason = "the fields are the signed message contract"
)]
pub fn prepare_shipment_message(
    program_id: &Pubkey,
    instance_id: &[u8; 16],
    lot_id: &str,
    shipment_id: &[u8; 16],
    quantity_kg: u64,
    owner: &str,
    destination: &str,
    site_code: &str,
    batch_count: u8,
    manifest_root: &[u8; 32],
    departure: (&[u8; 32], u32),
    expected_revision: u64,
    valid_until: i64,
) -> Vec<u8> {
    let shipment = hex(shipment_id);
    let quantity = format_tonnes(quantity_kg);
    let manifest = digest_hex(manifest_root);
    let (departure_sha, departure_version) = departure;
    let departure_sha = digest_hex(departure_sha);
    signed_message(
        program_id,
        instance_id,
        "Prepare shipment",
        format_args!(
            "Lot: {lot_id}\n\
             Shipment: {shipment}\n\
             Quantity: {quantity}\n\
             Owner: {owner}\n\
             To: {destination}\n\
             Site: {site_code}\n\
             Batches: {batch_count}\n\
             Manifest: {manifest}\n\
             Departure document: {departure_sha} v{departure_version}\n\
             Revision: {expected_revision}"
        ),
        valid_until,
    )
}

#[allow(
    clippy::too_many_arguments,
    reason = "the fields are the signed message contract"
)]
pub fn cancel_shipment_message(
    program_id: &Pubkey,
    instance_id: &[u8; 16],
    lot_id: &str,
    shipment_id: &[u8; 16],
    owner: &str,
    destination: &str,
    site_code: &str,
    expected_revision: u64,
    valid_until: i64,
) -> Vec<u8> {
    let shipment = hex(shipment_id);
    signed_message(
        program_id,
        instance_id,
        "Cancel shipment",
        format_args!(
            "Lot: {lot_id}\n\
             Shipment: {shipment}\n\
             Owner: {owner}\n\
             To: {destination}\n\
             Site: {site_code}\n\
             Revision: {expected_revision}"
        ),
        valid_until,
    )
}

#[allow(
    clippy::too_many_arguments,
    reason = "the fields are the signed message contract"
)]
pub fn custody_handover_message(
    program_id: &Pubkey,
    instance_id: &[u8; 16],
    lot_id: &str,
    shipment_id: &[u8; 16],
    batch_number: u8,
    batch_count: u8,
    quantity_kg: u64,
    from: &str,
    to: &str,
    stage: HandoverStage,
    manifest_digest: &[u8; 32],
    expected_sequence: u64,
    valid_until: i64,
) -> Vec<u8> {
    let shipment = hex(shipment_id);
    let quantity = format_tonnes(quantity_kg);
    let stage = match stage {
        HandoverStage::Departure => "Departure",
        HandoverStage::Transfer => "Transfer",
        HandoverStage::Arrival => "Arrival",
    };
    let manifest = digest_hex(manifest_digest);
    signed_message(
        program_id,
        instance_id,
        "Hand over custody",
        format_args!(
            "Lot: {lot_id}\n\
             Shipment: {shipment}\n\
             Batch: {batch_number} of {batch_count}\n\
             Quantity: {quantity}\n\
             From: {from}\n\
             To: {to}\n\
             Stage: {stage}\n\
             Manifest: {manifest}\n\
             Sequence: {expected_sequence}"
        ),
        valid_until,
    )
}

#[allow(
    clippy::too_many_arguments,
    reason = "the fields are the signed message contract"
)]
pub fn observation_message(
    program_id: &Pubkey,
    instance_id: &[u8; 16],
    lot_id: &str,
    shipment_id: &[u8; 16],
    batch_number: u8,
    batch_count: u8,
    holder: &str,
    observer: &str,
    kind: ObservationKind,
    location_code: &str,
    evidence_digest: &[u8; 32],
    observed_at: i64,
    expected_observation: u32,
    valid_until: i64,
) -> Vec<u8> {
    let shipment = hex(shipment_id);
    let kind = match kind {
        ObservationKind::Checkpoint => "Checkpoint",
        ObservationKind::Border => "Border",
    };
    let evidence = digest_hex(evidence_digest);
    let observed = format_sast(observed_at);
    signed_message(
        program_id,
        instance_id,
        "Record observation",
        format_args!(
            "Lot: {lot_id}\n\
             Shipment: {shipment}\n\
             Batch: {batch_number} of {batch_count}\n\
             Holder: {holder}\n\
             Observer: {observer}\n\
             Kind: {kind}\n\
             Location: {location_code}\n\
             Evidence: {evidence}\n\
             Observed at: {observed}\n\
             Observation: {expected_observation}"
        ),
        valid_until,
    )
}

fn signed_message(
    program_id: &Pubkey,
    instance_id: &[u8; 16],
    action: &str,
    fields: Arguments<'_>,
    valid_until: i64,
) -> Vec<u8> {
    let expiry = format_sast(valid_until);
    let instance = hex(instance_id);
    format!(
        "Thetis authorisation v1\n\
         Network: devnet\n\
         Program: {program_id}\n\
         Protocol: {instance}\n\
         Action: {action}\n\
         {fields}\n\
         Valid until: {expiry}\n\
         Test network only. Synthetic data."
    )
    .into_bytes()
}

fn digest_hex(digest: &[u8; 32]) -> String {
    hex(digest)
}

fn hex(bytes: &[u8]) -> String {
    let mut hex = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        write!(hex, "{byte:02x}").unwrap();
    }
    hex
}

pub(crate) fn valid_display_name(name: &str) -> bool {
    (1..=MAX_DISPLAY_NAME).contains(&name.len())
        && name.bytes().all(|byte| (0x20..=0x7e).contains(&byte))
        && !name.starts_with(' ')
        && !name.ends_with(' ')
        && !name.contains("  ")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        io::Write,
        process::{Command, Stdio},
    };

    const VALID_UNTIL: i64 = 1_795_098_725;

    const INSTANCE_ID: [u8; 16] = [
        0x60, 0x61, 0x62, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68, 0x69, 0x6a, 0x6b, 0x6c, 0x6d, 0x6e,
        0x6f,
    ];

    const OTHER_INSTANCE_ID: [u8; 16] = [
        0x70, 0x71, 0x72, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78, 0x79, 0x7a, 0x7b, 0x7c, 0x7d, 0x7e,
        0x7f,
    ];

    #[test]
    fn tonnes_known_answers() {
        for (kg, expected) in [
            (1, "0.001 t"),
            (999, "0.999 t"),
            (1_000, "1.000 t"),
            (2_000_000, "2,000.000 t"),
            (1_234_567_890, "1,234,567.890 t"),
            (u64::MAX, "18,446,744,073,709,551.615 t"),
        ] {
            assert_eq!(format_tonnes(kg), expected, "{kg} kg");
        }
    }

    #[test]
    fn sast_known_answers() {
        for (unix, expected) in [
            (0, "1970-01-01 02:00:00 SAST"),
            (951_782_400, "2000-02-29 02:00:00 SAST"),
            (1_795_098_725, "2026-11-19 16:32:05 SAST"),
            (1_795_105_799, "2026-11-19 18:29:59 SAST"),
            (4_102_444_799, "2100-01-01 01:59:59 SAST"),
        ] {
            assert_eq!(format_sast(unix), expected, "{unix}");
        }
    }

    const ISSUE_TEXT: &str = "Thetis authorisation v1
Network: devnet
Program: jGJpdjtoDUtXMjvc4UaEi1mBeFZKqVfe9jL8ireHMs3
Protocol: 606162636465666768696a6b6c6d6e6f
Action: Issue lot
Lot: CR-0001
Class: CHROME v1
Grade: A
Quantity: 5,000.000 t
Owner: Khunou Ore Exports
Custodian: Kopano Stockyard Custody
Site: PORT-STOCKYARD
Intake: 000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f
Origin document: 202122232425262728292a2b2c2d2e2f303132333435363738393a3b3c3d3e3f v1
Valid until: 2026-11-19 16:32:05 SAST
Test network only. Synthetic data.";

    const TRANSFER_TEXT: &str = "Thetis authorisation v1
Network: devnet
Program: jGJpdjtoDUtXMjvc4UaEi1mBeFZKqVfe9jL8ireHMs3
Protocol: 606162636465666768696a6b6c6d6e6f
Action: Transfer receipts
Lot: CR-0001
Quantity: 2,000.000 t
From: Khunou Ore Exports
To: Buyer Smelter Co
Revision: 0
Valid until: 2026-11-19 16:32:05 SAST
Test network only. Synthetic data.";

    const SPLIT_TEXT: &str = "Thetis authorisation v1
Network: devnet
Program: jGJpdjtoDUtXMjvc4UaEi1mBeFZKqVfe9jL8ireHMs3
Protocol: 606162636465666768696a6b6c6d6e6f
Action: Split lot
Lot: CR-0001
New lot: CR-0002
Quantity: 1,000.000 t
Owner: Khunou Ore Exports
Custodian: Kopano Stockyard Custody
Revision: 1
Valid until: 2026-11-19 16:32:05 SAST
Test network only. Synthetic data.";

    const REDEEM_TEXT: &str = "Thetis authorisation v1
Network: devnet
Program: jGJpdjtoDUtXMjvc4UaEi1mBeFZKqVfe9jL8ireHMs3
Protocol: 606162636465666768696a6b6c6d6e6f
Action: Collect from stockyard
Lot: CR-0001
Quantity: 2,000.000 t
Holder: Buyer Smelter Co
Custodian: Kopano Stockyard Custody
Collection ticket: 404142434445464748494a4b4c4d4e4f505152535455565758595a5b5c5d5e5f
Revision: 0
Valid until: 2026-11-19 16:32:05 SAST
Test network only. Synthetic data.";

    fn digest(base: u8) -> [u8; 32] {
        core::array::from_fn(|index| index as u8 + base)
    }

    fn issue(instance_id: &[u8; 16], origin: Option<(&[u8; 32], u32)>) -> Vec<u8> {
        issue_message(
            &crate::ID,
            instance_id,
            "CR-0001",
            "CHROME",
            1,
            "A",
            5_000_000,
            "Khunou Ore Exports",
            "Kopano Stockyard Custody",
            "PORT-STOCKYARD",
            &digest(0x00),
            origin,
            VALID_UNTIL,
        )
    }

    fn sha256_hex(bytes: &[u8]) -> String {
        let mut checksum = Command::new("sha256sum")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .expect("start sha256sum");
        checksum.stdin.take().unwrap().write_all(bytes).unwrap();
        let output = checksum.wait_with_output().unwrap();
        assert!(output.status.success());
        let stdout = String::from_utf8(output.stdout).unwrap();
        let hex = stdout
            .strip_suffix("  -\n")
            .expect("sha256sum output format");
        assert_eq!(hex.len(), 64);
        hex.to_owned()
    }

    fn assert_vector(bytes: Vec<u8>, expected: &str, length: usize, sha256: &str) {
        assert_eq!(bytes, expected.as_bytes());
        assert_eq!(bytes.len(), length);
        assert_eq!(sha256_hex(&bytes), sha256);
    }

    #[test]
    fn issue_text_matches_known_vector() {
        assert_vector(
            issue(&INSTANCE_ID, Some((&digest(0x20), 1))),
            ISSUE_TEXT,
            528,
            "7e9bbb750a8629a70fefb9c4bce48e0c2869c512511538513546b3c570084638",
        );
    }

    #[test]
    fn origin_not_required_line_reads_not_required() {
        let origin_line =
            "Origin document: 202122232425262728292a2b2c2d2e2f303132333435363738393a3b3c3d3e3f v1";
        assert!(ISSUE_TEXT.contains(origin_line));
        let expected = ISSUE_TEXT.replace(origin_line, "Origin document: not required");
        let bytes = issue(&INSTANCE_ID, None);
        assert!(String::from_utf8(bytes.clone())
            .unwrap()
            .contains("\nOrigin document: not required\n"));
        assert_vector(
            bytes,
            &expected,
            473,
            "7ad36cd94680f1b3a3417b0357c02635cd52d684794ec5236a110e772e119712",
        );
    }

    #[test]
    fn transfer_text_matches_known_vector() {
        assert_vector(
            transfer_message(
                &crate::ID,
                &INSTANCE_ID,
                "CR-0001",
                2_000_000,
                "Khunou Ore Exports",
                "Buyer Smelter Co",
                0,
                VALID_UNTIL,
            ),
            TRANSFER_TEXT,
            327,
            "e6bbf185e764a8bd172de5fa2c100d41eb1ad12ef713ee0a0122467dc43f246e",
        );
    }

    #[test]
    fn split_text_matches_known_vector() {
        assert_vector(
            split_message(
                &crate::ID,
                &INSTANCE_ID,
                "CR-0001",
                "CR-0002",
                1_000_000,
                "Khunou Ore Exports",
                "Kopano Stockyard Custody",
                1,
                VALID_UNTIL,
            ),
            SPLIT_TEXT,
            352,
            "950c1c074b08857c6b92a1d67acd2d76b4e1141d08a3af28387c8b3e411e8c85",
        );
    }

    #[test]
    fn redeem_text_matches_known_vector() {
        assert_vector(
            redeem_message(
                &crate::ID,
                &INSTANCE_ID,
                "CR-0001",
                2_000_000,
                "Buyer Smelter Co",
                "Kopano Stockyard Custody",
                &digest(0x40),
                0,
                VALID_UNTIL,
            ),
            REDEEM_TEXT,
            431,
            "411d5fdfde1297fd212b6c4a85aefaf030a4b7a66987e19fc68d7821567a9be7",
        );
    }

    #[test]
    fn text_names_protocol_instance() {
        let first = issue(&INSTANCE_ID, Some((&digest(0x20), 1)));
        let second = issue(&OTHER_INSTANCE_ID, Some((&digest(0x20), 1)));
        assert_eq!(first, ISSUE_TEXT.as_bytes());
        let first_text = String::from_utf8(first.clone()).unwrap();
        let second_text = String::from_utf8(second.clone()).unwrap();
        assert!(first_text.contains("\nProtocol: 606162636465666768696a6b6c6d6e6f\n"));
        assert!(second_text.contains("\nProtocol: 707172737475767778797a7b7c7d7e7f\n"));
        assert!(second_text
            .contains("Program: jGJpdjtoDUtXMjvc4UaEi1mBeFZKqVfe9jL8ireHMs3\nProtocol: 7071"));
        assert_ne!(first, second);
        assert_eq!(first.len(), second.len());
        assert_ne!(sha256_hex(&first), sha256_hex(&second));
    }
}
