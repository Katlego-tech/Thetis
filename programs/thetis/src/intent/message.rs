use anchor_lang::solana_program::pubkey::Pubkey;

pub fn format_tonnes(kg: u64) -> String {
    let _ = kg;
    unimplemented!()
}

pub fn format_sast(unix: i64) -> String {
    let _ = unix;
    unimplemented!()
}

#[allow(
    clippy::too_many_arguments,
    reason = "the fields are the signed message contract"
)]
pub fn issue_message(
    program_id: &Pubkey,
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
    let _ = (
        program_id,
        lot_id,
        class_code,
        class_version,
        grade,
        quantity_kg,
        owner,
        custodian,
        site_code,
        intake_digest,
        origin,
        valid_until,
    );
    unimplemented!()
}

pub fn transfer_message(
    program_id: &Pubkey,
    lot_id: &str,
    quantity_kg: u64,
    from: &str,
    to: &str,
    expected_revision: u64,
    valid_until: i64,
) -> Vec<u8> {
    let _ = (
        program_id,
        lot_id,
        quantity_kg,
        from,
        to,
        expected_revision,
        valid_until,
    );
    unimplemented!()
}

#[allow(
    clippy::too_many_arguments,
    reason = "the fields are the signed message contract"
)]
pub fn split_message(
    program_id: &Pubkey,
    lot_id: &str,
    child_lot_id: &str,
    quantity_kg: u64,
    owner: &str,
    custodian: &str,
    expected_revision: u64,
    valid_until: i64,
) -> Vec<u8> {
    let _ = (
        program_id,
        lot_id,
        child_lot_id,
        quantity_kg,
        owner,
        custodian,
        expected_revision,
        valid_until,
    );
    unimplemented!()
}

#[allow(
    clippy::too_many_arguments,
    reason = "the fields are the signed message contract"
)]
pub fn redeem_message(
    program_id: &Pubkey,
    lot_id: &str,
    quantity_kg: u64,
    holder: &str,
    custodian: &str,
    collection_ticket: &[u8; 32],
    expected_revision: u64,
    valid_until: i64,
) -> Vec<u8> {
    let _ = (
        program_id,
        lot_id,
        quantity_kg,
        holder,
        custodian,
        collection_ticket,
        expected_revision,
        valid_until,
    );
    unimplemented!()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        io::Write,
        process::{Command, Stdio},
    };

    const VALID_UNTIL: i64 = 1_795_098_725;

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

    fn issue(origin: Option<(&[u8; 32], u32)>) -> Vec<u8> {
        issue_message(
            &crate::ID,
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
    fn issue_text_matches_known_vector() {
        assert_vector(
            issue(Some((&digest(0x20), 1))),
            ISSUE_TEXT,
            485,
            "1e4f121b37480b64b7fe9f82fd6822cb07144101a09bb0cd5739a7c06e0ed26e",
        );
    }

    #[test]
    fn origin_not_required_line_reads_not_required() {
        let origin_line =
            "Origin document: 202122232425262728292a2b2c2d2e2f303132333435363738393a3b3c3d3e3f v1";
        assert!(ISSUE_TEXT.contains(origin_line));
        let expected = ISSUE_TEXT.replace(origin_line, "Origin document: not required");
        let bytes = issue(None);
        assert!(String::from_utf8(bytes.clone())
            .unwrap()
            .contains("\nOrigin document: not required\n"));
        assert_vector(
            bytes,
            &expected,
            430,
            "b1cef511ce1c133fa69f352c9110e7da42c2b6907a3ce200999b9f17db28efda",
        );
    }

    #[test]
    fn transfer_text_matches_known_vector() {
        assert_vector(
            transfer_message(
                &crate::ID,
                "CR-0001",
                2_000_000,
                "Khunou Ore Exports",
                "Buyer Smelter Co",
                0,
                VALID_UNTIL,
            ),
            TRANSFER_TEXT,
            284,
            "a7ba52e4567d5f0ce35cb5052862224ef3d471f5e3fa7bc42bccbd0234cec26f",
        );
    }

    #[test]
    fn split_text_matches_known_vector() {
        assert_vector(
            split_message(
                &crate::ID,
                "CR-0001",
                "CR-0002",
                1_000_000,
                "Khunou Ore Exports",
                "Kopano Stockyard Custody",
                1,
                VALID_UNTIL,
            ),
            SPLIT_TEXT,
            309,
            "6f338fd268988ad6e12578ecd9f9af49189fe4f27cfb65d8de292866006f0df8",
        );
    }

    #[test]
    fn redeem_text_matches_known_vector() {
        assert_vector(
            redeem_message(
                &crate::ID,
                "CR-0001",
                2_000_000,
                "Buyer Smelter Co",
                "Kopano Stockyard Custody",
                &digest(0x40),
                0,
                VALID_UNTIL,
            ),
            REDEEM_TEXT,
            388,
            "3fde8cb8cd766fca4b3584d65e65b6b2537fa3a7de2940cb77433f8e33271f55",
        );
    }
}
