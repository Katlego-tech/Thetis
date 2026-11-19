use std::fmt::Write;

use anchor_lang::solana_program::pubkey::Pubkey;

const CLUSTER: &str = "devnet";
const NOTICE: &str = "Test network only. Synthetic data.";
pub(crate) const MAX_DISPLAY_NAME_BYTES: usize = 48;
pub(crate) const MAX_LOT_ID_BYTES: usize = 16;

pub fn format_tonnes(kg: u64) -> String {
    let whole = (kg / 1_000).to_string();
    let mut tonnes = String::with_capacity(whole.len() + whole.len() / 3 + 6);
    for (index, digit) in whole.bytes().enumerate() {
        if index != 0 && (whole.len() - index).is_multiple_of(3) {
            tonnes.push(',');
        }
        tonnes.push(char::from(digit));
    }
    write!(tonnes, ".{:03} t", kg % 1_000).unwrap();
    tonnes
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
pub fn handover_message(
    program_id: &Pubkey,
    lot_id: &str,
    batch_id: &[u8; 16],
    quantity_kg: u64,
    from: &str,
    to: &str,
    sequence: u64,
    valid_until: i64,
) -> Vec<u8> {
    let mut batch_hex = String::with_capacity(32);
    for byte in batch_id {
        write!(batch_hex, "{byte:02x}").unwrap();
    }
    let quantity = format_tonnes(quantity_kg);
    let expiry = format_sast(valid_until);
    format!(
        "Thetis authorisation v1\n\
         Network: {CLUSTER}\n\
         Program: {program_id}\n\
         Action: Hand over custody\n\
         Lot: {lot_id}\n\
         Batch: {batch_hex}\n\
         Quantity: {quantity}\n\
         From: {from}\n\
         To: {to}\n\
         Sequence: {sequence}\n\
         Valid until: {expiry}\n\
         {NOTICE}"
    )
    .into_bytes()
}

pub(crate) fn valid_display_name(name: &str) -> bool {
    (1..=MAX_DISPLAY_NAME_BYTES).contains(&name.len())
        && name.bytes().all(|byte| (0x20..=0x7e).contains(&byte))
        && !name.starts_with(' ')
        && !name.ends_with(' ')
        && !name.contains("  ")
}

pub(crate) fn valid_lot_id(lot_id: &str) -> bool {
    (1..=MAX_LOT_ID_BYTES).contains(&lot_id.len())
        && lot_id
            .bytes()
            .all(|byte| byte.is_ascii_uppercase() || byte.is_ascii_digit() || byte == b'-')
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        io::Write,
        process::{Command, Stdio},
    };

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

    const VECTOR_A: &str = "Thetis authorisation v1
Network: devnet
Program: 3LfZrLC2R3AdjAQgdoEjdC3YZpbHLaJGy446H74cPEyH
Action: Hand over custody
Lot: CR-0001
Batch: 00112233445566778899aabbccddeeff
Quantity: 2,000.000 t
From: Kopano Stockyard Custody
To: Mosela Haulage
Sequence: 0
Valid until: 2026-11-19 16:32:05 SAST
Test network only. Synthetic data.";

    fn vector_message(lot_id: &str, kg: u64, sequence: u64, valid_until: i64) -> Vec<u8> {
        handover_message(
            &crate::ID,
            lot_id,
            &0x00112233445566778899aabbccddeeff_u128.to_be_bytes(),
            kg,
            "Kopano Stockyard Custody",
            "Mosela Haulage",
            sequence,
            valid_until,
        )
    }

    fn assert_vector(bytes: Vec<u8>, expected: &str, length: usize, sha256: &str) {
        assert_eq!(bytes, expected.as_bytes());
        assert_eq!(bytes.len(), length);
        let mut checksum = Command::new("sha256sum")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .expect("start sha256sum");
        checksum.stdin.take().unwrap().write_all(&bytes).unwrap();
        let output = checksum.wait_with_output().unwrap();
        assert!(output.status.success());
        assert_eq!(
            String::from_utf8(output.stdout).unwrap(),
            format!("{sha256}  -\n")
        );
    }

    #[test]
    fn vector_a() {
        assert_vector(
            vector_message("CR-0001", 2_000_000, 0, 1_795_098_725),
            VECTOR_A,
            329,
            "496a14a54f2fcce926d23c22594cc08de8388af8ef9e876a44b6bd14ad3ac569",
        );
    }

    #[test]
    fn vector_b() {
        let expected = VECTOR_A
            .replace("CR-0001", "MN-0042")
            .replace("2,000.000 t", "0.001 t")
            .replace("Sequence: 0", "Sequence: 7")
            .replace("2026-11-19 16:32:05", "2100-01-01 01:59:59");
        assert_vector(
            vector_message("MN-0042", 1, 7, 4_102_444_799),
            &expected,
            325,
            "dbb342e075310715ba4e8cd78cb2eaa0fcbf9996dc129c4a893bfdb9560f538b",
        );
    }
}
