mod common;

use anchor_lang::prelude::Pubkey;
use common::{Actor::*, *};
use solana_transaction::Instruction;
use thetis::{
    error::ThetisError::*,
    events,
    state::{self, *},
};

const INTAKE_DIGEST: [u8; 32] = [0x5a; 32];
const SHA256: [u8; 32] = [0xc3; 32];
const OTHER_SHA256: [u8; 32] = [0x7e; 32];
const VALID_UNTIL: i64 = NOW + 365 * 86_400;
const KIND: DocumentKind = DocumentKind::Origin;

/// An initialised protocol with a DocumentIssuer organisation whose delegated wallet
/// (`Issuer`) may attest origin documents.
fn issuer_setup() -> (Fixture, Pubkey) {
    let mut f = Fixture::initialized();
    let issuer_org = f.add_org(1, Role::DocumentIssuer);
    let delegate = f.delegate(
        OrgAdmin,
        issuer_org,
        f.key(Issuer),
        state::scope::ATTEST_ORIGIN,
        NOW + 86_400,
    );
    f.ok(delegate, OrgAdmin);
    (f, issuer_org)
}

fn attest_origin(f: &Fixture, signer: Actor, organisation: Pubkey) -> Instruction {
    f.attest(
        signer,
        organisation,
        KIND,
        INTAKE_DIGEST,
        1,
        SHA256,
        VALID_UNTIL,
    )
}

#[test]
fn attest_document_by_issuer_succeeds() {
    let (mut f, issuer_org) = issuer_setup();
    let tx = f.ok(attest_origin(&f, Issuer, issuer_org), Issuer);

    let document = f.document(KIND, INTAKE_DIGEST, 1);
    assert_event(
        &tx,
        events::DocumentAttested {
            document,
            kind: KIND,
            subject: INTAKE_DIGEST,
            version: 1,
        },
    );
    let attestation: DocumentAttestation = f.read(document);
    assert_eq!(attestation.protocol, f.protocol);
    assert_eq!(attestation.kind, DocumentKind::Origin);
    assert_eq!(attestation.subject, INTAKE_DIGEST);
    assert_eq!(attestation.version, 1);
    assert_eq!(attestation.issuer, issuer_org);
    assert_eq!(attestation.sha256, SHA256);
    assert_eq!(attestation.valid_until, VALID_UNTIL);
    assert_eq!(attestation.revoked_at, None);
    assert_eq!(
        attestation.bump,
        Pubkey::find_program_address(
            &[
                b"document",
                f.protocol.as_ref(),
                &[KIND as u8],
                &INTAKE_DIGEST,
                &1u32.to_le_bytes(),
            ],
            &thetis::ID
        )
        .1
    );
}

#[test]
fn attest_rejects_wallet_without_attest_origin_scope() {
    let mut f = Fixture::initialized();
    let custodian_org = f.add_org(2, Role::Custodian);
    let delegate = f.delegate(
        OrgAdmin,
        custodian_org,
        f.key(Issuer2),
        state::scope::ISSUE,
        NOW + 86_400,
    );
    f.ok(delegate, OrgAdmin);

    f.refused(
        attest_origin(&f, Issuer2, custodian_org),
        Issuer2,
        ScopeMissing,
    );
    assert!(!f.account_exists(f.document(KIND, INTAKE_DIGEST, 1)));
}

#[test]
fn attest_rejects_non_document_issuer_organisation() {
    let mut f = Fixture::initialized();
    let exporter_org = f.add_org(3, Role::Exporter);
    f.forge_authority(
        exporter_org,
        f.key(Issuer2),
        state::scope::ATTEST_ORIGIN,
        NOW + 86_400,
    );

    f.refused(attest_origin(&f, Issuer2, exporter_org), Issuer2, WrongRole);
    assert!(!f.account_exists(f.document(KIND, INTAKE_DIGEST, 1)));
}

#[test]
fn attest_rejects_revoked_authority() {
    let (mut f, issuer_org) = issuer_setup();
    let authority = f.authority(f.key(Issuer));
    let revoke = f.revoke(OrgAdmin, issuer_org, authority);
    f.ok(revoke, OrgAdmin);

    f.refused(
        attest_origin(&f, Issuer, issuer_org),
        Issuer,
        AuthorityRevoked,
    );
    assert!(!f.account_exists(f.document(KIND, INTAKE_DIGEST, 1)));
}

#[test]
fn attest_rejects_expired_authority() {
    let mut f = Fixture::initialized();
    let issuer_org = f.add_org(1, Role::DocumentIssuer);
    let delegate = f.delegate(
        OrgAdmin,
        issuer_org,
        f.key(Issuer),
        state::scope::ATTEST_ORIGIN,
        NOW + 100,
    );
    f.ok(delegate, OrgAdmin);
    f.set_clock(NOW + 100);

    f.refused(
        attest_origin(&f, Issuer, issuer_org),
        Issuer,
        AuthorityExpired,
    );
    assert!(!f.account_exists(f.document(KIND, INTAKE_DIGEST, 1)));
}

#[test]
fn attest_rejects_valid_until_in_the_past() {
    let (mut f, issuer_org) = issuer_setup();
    // valid_until == now counts as already lapsed.
    for valid_until in [NOW, NOW - 1] {
        let attest = f.attest(
            Issuer,
            issuer_org,
            KIND,
            INTAKE_DIGEST,
            1,
            SHA256,
            valid_until,
        );
        f.refused(attest, Issuer, InvalidField);
    }
    assert!(!f.account_exists(f.document(KIND, INTAKE_DIGEST, 1)));
}

#[test]
fn attest_rejects_version_zero() {
    let (mut f, issuer_org) = issuer_setup();
    let attest = f.attest(
        Issuer,
        issuer_org,
        KIND,
        INTAKE_DIGEST,
        0,
        SHA256,
        VALID_UNTIL,
    );
    f.refused(attest, Issuer, InvalidField);
    assert!(!f.account_exists(f.document(KIND, INTAKE_DIGEST, 0)));
}

#[test]
fn attest_rejects_duplicate_subject_and_version() {
    let (mut f, issuer_org) = issuer_setup();
    f.ok(attest_origin(&f, Issuer, issuer_org), Issuer);

    let duplicate = f.attest(
        Issuer,
        issuer_org,
        KIND,
        INTAKE_DIGEST,
        1,
        OTHER_SHA256,
        VALID_UNTIL,
    );
    f.already_initialized(duplicate, Issuer);
    let attestation: DocumentAttestation = f.read(f.document(KIND, INTAKE_DIGEST, 1));
    assert_eq!(attestation.sha256, SHA256);

    // A new version of the same subject is a different document.
    let next = f.attest(
        Issuer,
        issuer_org,
        KIND,
        INTAKE_DIGEST,
        2,
        OTHER_SHA256,
        VALID_UNTIL,
    );
    f.ok(next, Issuer);
    let attestation: DocumentAttestation = f.read(f.document(KIND, INTAKE_DIGEST, 2));
    assert_eq!(attestation.version, 2);
    assert_eq!(attestation.sha256, OTHER_SHA256);
}

#[test]
fn revoke_document_sets_revoked_at() {
    let (mut f, issuer_org) = issuer_setup();
    f.ok(attest_origin(&f, Issuer, issuer_org), Issuer);
    let document = f.document(KIND, INTAKE_DIGEST, 1);
    let before: DocumentAttestation = f.read(document);

    f.set_clock(NOW + 3_600);
    let revoke = f.revoke_document(Issuer, issuer_org, document);
    let tx = f.ok(revoke, Issuer);

    assert_event(
        &tx,
        events::DocumentRevoked {
            document,
            at: NOW + 3_600,
        },
    );
    assert!(f.account_exists(document));
    let after: DocumentAttestation = f.read(document);
    assert_eq!(after.revoked_at, Some(NOW + 3_600));
    assert_eq!(after.protocol, before.protocol);
    assert_eq!(after.kind, before.kind);
    assert_eq!(after.subject, before.subject);
    assert_eq!(after.version, before.version);
    assert_eq!(after.issuer, before.issuer);
    assert_eq!(after.sha256, before.sha256);
    assert_eq!(after.valid_until, before.valid_until);
    assert_eq!(after.bump, before.bump);
}

#[test]
fn revoke_rejects_other_organisation_as_not_issuer() {
    let (mut f, issuer_org) = issuer_setup();
    let other_org = f.add_org(4, Role::DocumentIssuer);
    let delegate = f.delegate(
        OrgAdmin,
        other_org,
        f.key(Issuer2),
        state::scope::ATTEST_ORIGIN,
        NOW + 86_400,
    );
    f.ok(delegate, OrgAdmin);
    f.ok(attest_origin(&f, Issuer, issuer_org), Issuer);
    let document = f.document(KIND, INTAKE_DIGEST, 1);

    let revoke = f.revoke_document(Issuer2, other_org, document);
    f.refused(revoke, Issuer2, NotIssuer);
    assert_eq!(f.read::<DocumentAttestation>(document).revoked_at, None);
}

#[test]
fn revoke_rejects_already_revoked_document() {
    let (mut f, issuer_org) = issuer_setup();
    f.ok(attest_origin(&f, Issuer, issuer_org), Issuer);
    let document = f.document(KIND, INTAKE_DIGEST, 1);
    let revoke = f.revoke_document(Issuer, issuer_org, document);
    f.ok(revoke, Issuer);

    f.set_clock(NOW + 7_200);
    let again = f.revoke_document(Issuer, issuer_org, document);
    f.refused(again, Issuer, DocumentRevoked);
    assert_eq!(
        f.read::<DocumentAttestation>(document).revoked_at,
        Some(NOW)
    );
}

#[test]
fn revoke_rejects_revoked_authority() {
    let (mut f, issuer_org) = issuer_setup();
    f.ok(attest_origin(&f, Issuer, issuer_org), Issuer);
    let document = f.document(KIND, INTAKE_DIGEST, 1);
    let revoke = f.revoke(OrgAdmin, issuer_org, f.authority(f.key(Issuer)));
    f.ok(revoke, OrgAdmin);

    let revoke_document = f.revoke_document(Issuer, issuer_org, document);
    f.refused(revoke_document, Issuer, AuthorityRevoked);
    assert_eq!(f.read::<DocumentAttestation>(document).revoked_at, None);
}

#[test]
fn attest_rejects_authority_of_another_wallet() {
    let (mut f, issuer_org) = issuer_setup();
    // Issuer2 signs but passes Issuer's Authority (accounts[2] is `authority`).
    let mut attest = attest_origin(&f, Issuer2, issuer_org);
    attest.accounts[2].pubkey = f.authority(f.key(Issuer));
    f.refused(attest, Issuer2, WrongSigner);
    assert!(!f.account_exists(f.document(KIND, INTAKE_DIGEST, 1)));
}
