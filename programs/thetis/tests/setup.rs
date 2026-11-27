mod common;

use anchor_lang::prelude::Pubkey;
use common::{Actor::*, *};
use thetis::{
    error::ThetisError::*,
    events,
    state::{self, *},
};

#[test]
fn initialize_requires_admin_and_is_one_time() {
    let mut f = Fixture::new();
    f.refused(f.initialize(Outsider), Outsider, NotAdmin);
    let tx = f.ok(f.initialize(Admin), Admin);
    assert_event(
        &tx,
        events::ProtocolInitialized {
            protocol: f.protocol,
        },
    );

    let protocol: Protocol = f.read(f.protocol);
    assert_eq!(protocol.instance_id, INSTANCE);
    assert_eq!(protocol.admin, f.key(Admin));
    assert_eq!(protocol.accreditor, f.key(Accreditor));
    assert_eq!(
        protocol.settlement_mode,
        SettlementMode::FiatAttestationTest
    );
    assert_eq!(protocol.pause_flags, 0);
    assert_eq!(
        protocol.bump,
        Pubkey::find_program_address(&[b"protocol", &INSTANCE], &thetis::ID).1
    );
    f.already_initialized(f.initialize(Admin), Admin);
}

#[test]
fn register_class_checks_accreditor_fields_and_versioned_seeds() {
    let mut f = Fixture::initialized();
    f.refused(
        f.register(Admin, "CHROME", 1, &["A"], 3600),
        Admin,
        NotAccreditor,
    );
    for (code, grades, validity) in [
        ("", &["A"][..], 3600),
        ("chrome", &["A"][..], 3600),
        ("CHROME-01", &["A"][..], 3600),
        (&"A".repeat(33), &["A"][..], 3600),
        ("CHROME", &[][..], 3600),
        (
            "CHROME",
            &["A", "B", "C", "D", "E", "F", "G", "H", "I"][..],
            3600,
        ),
        ("CHROME", &["A", "A"][..], 3600),
        ("CHROME", &["A", ""][..], 3600),
        ("CHROME", &["A", "a"][..], 3600),
        ("CHROME", &["A", "GRADE-123"][..], 3600),
        ("CHROME", &["A"][..], 0),
        ("CHROME", &["A"][..], -1),
    ] {
        f.refused(
            f.register(Accreditor, code, 1, grades, validity),
            Accreditor,
            InvalidField,
        );
    }

    let grades = ["GRADE-01", "B", "C", "D", "E", "F", "G", "H"];
    for version in [1, 2] {
        let tx = f.ok(
            f.register(Accreditor, "CHROME-1", version, &grades, 3600),
            Accreditor,
        );
        let class_policy = f.class("CHROME-1", version);
        assert_event(
            &tx,
            events::ClassRegistered {
                class_policy,
                version,
            },
        );
        let class: ClassPolicy = f.read(class_policy);
        assert_eq!(class.protocol, f.protocol);
        assert_eq!(class.class_code, "CHROME-1");
        assert_eq!(class.version, version);
        assert_eq!(class.unit, QuantityUnit::Kilogram);
        assert_eq!(class.grades, grades);
        assert!(class.origin_required);
        assert_eq!(class.lot_validity_secs, 3600);
        assert!(class.split_inherits_expiry);
    }
    f.already_initialized(
        f.register(Accreditor, "CHROME-1", 1, &grades, 3600),
        Accreditor,
    );
}

#[test]
fn accredit_organisation_checks_accreditor_and_display_name() {
    let mut f = Fixture::initialized();
    f.refused(
        f.accredit(Admin, 1, Role::Exporter, "Khunou"),
        Admin,
        NotAccreditor,
    );
    for name in [
        "",
        " Khunou",
        "Khunou ",
        "Khunou  Ore",
        "Khunou\nOre",
        "Khunóu",
        &"X".repeat(49),
    ] {
        f.refused(
            f.accredit(Accreditor, 1, Role::Exporter, name),
            Accreditor,
            InvalidField,
        );
    }
    let name = "X".repeat(48);
    f.ok(f.accredit(Accreditor, 1, Role::Exporter, &name), Accreditor);
    assert_eq!(f.read::<Organisation>(f.organisation(1)).display_name, name);
    f.already_initialized(
        f.accredit(Accreditor, 1, Role::Exporter, "Another Name"),
        Accreditor,
    );
}

#[test]
fn accredit_rejects_duplicate_display_name() {
    let mut f = Fixture::initialized();
    f.ok(
        f.accredit(Accreditor, 1, Role::Exporter, "Khunou Ore"),
        Accreditor,
    );
    f.already_initialized(
        f.accredit(Accreditor, 2, Role::Custodian, "Khunou Ore"),
        Accreditor,
    );
    assert!(!f.account_exists(f.organisation(2)));
}

#[test]
fn accredit_rejects_duplicate_display_name_other_case() {
    let mut f = Fixture::initialized();
    assert_eq!(
        f.organisation_name("Khunou Ore"),
        f.organisation_name("KHUNOU ore")
    );
    f.ok(
        f.accredit(Accreditor, 1, Role::Exporter, "Khunou Ore"),
        Accreditor,
    );
    f.already_initialized(
        f.accredit(Accreditor, 2, Role::Custodian, "KHUNOU ore"),
        Accreditor,
    );
    assert!(!f.account_exists(f.organisation(2)));
}

#[test]
fn accredit_accepts_distinct_names() {
    let mut f = Fixture::initialized();
    f.ok(
        f.accredit(Accreditor, 1, Role::Exporter, "Khunou Ore"),
        Accreditor,
    );
    f.ok(
        f.accredit(Accreditor, 2, Role::Custodian, "Khunou Ores"),
        Accreditor,
    );
    let first = f.organisation_name("Khunou Ore");
    let second = f.organisation_name("Khunou Ores");
    assert_ne!(first, second);
    for marker in [first, second] {
        let (owner, data_len) = f.owner_and_data_len(marker).expect("name marker exists");
        assert_eq!(owner, thetis::ID);
        assert_eq!(data_len, 8);
    }
    assert_eq!(
        f.read::<Organisation>(f.organisation(1)).display_name,
        "Khunou Ore"
    );
    assert_eq!(
        f.read::<Organisation>(f.organisation(2)).display_name,
        "Khunou Ores"
    );
}

#[test]
fn relationship_is_bidirectional_unique_and_bounded() {
    let mut f = Fixture::initialized();
    let a = f.add_org(1, Role::Exporter);
    let b = f.add_org(2, Role::Custodian);
    f.refused(f.relationship(Admin, a, b), Admin, NotAccreditor);
    f.refused(f.relationship(Accreditor, a, a), Accreditor, InvalidField);
    let tx = f.ok(f.relationship(Accreditor, a, b), Accreditor);
    assert_event(&tx, events::RelationshipDeclared { a, b });
    assert_eq!(f.read::<Organisation>(a).related, [b]);
    assert_eq!(f.read::<Organisation>(b).related, [a]);
    for (left, right) in [(a, b), (b, a)] {
        f.refused(
            f.relationship(Accreditor, left, right),
            Accreditor,
            InvalidField,
        );
    }

    let mut related = vec![b];
    for id in 3..=9 {
        let other = f.add_org(id, Role::Buyer);
        f.ok(f.relationship(Accreditor, a, other), Accreditor);
        related.push(other);
        assert_eq!(f.read::<Organisation>(a).related, related);
        assert_eq!(f.read::<Organisation>(other).related, [a]);
    }
    let other = f.add_org(10, Role::Buyer);
    for (left, right) in [(a, other), (other, a)] {
        f.refused(
            f.relationship(Accreditor, left, right),
            Accreditor,
            InvalidField,
        );
    }
}

#[test]
fn delegation_checks_admin_expiry_and_one_authority_per_wallet() {
    let mut f = Fixture::initialized();
    let exporter = f.add_org(1, Role::Exporter);
    let buyer = f.add_org(2, Role::Buyer);
    let wallet = Pubkey::new_unique();
    let scopes = state::scope::TRANSFER | state::scope::REDEEM;

    f.refused(
        f.delegate(Accreditor, exporter, wallet, scopes, NOW + 1),
        Accreditor,
        NotOrganisationAdmin,
    );
    for expiry in [NOW - 1, NOW] {
        f.refused(
            f.delegate(OrgAdmin, exporter, wallet, scopes, expiry),
            OrgAdmin,
            InvalidField,
        );
    }
    let tx = f.ok(
        f.delegate(OrgAdmin, exporter, wallet, scopes, NOW + 1),
        OrgAdmin,
    );
    let address = f.authority(wallet);
    assert_event(
        &tx,
        events::AuthorityDelegated {
            authority: address,
            organisation: exporter,
            scopes,
            expires_at: NOW + 1,
        },
    );
    let authority: Authority = f.read(address);
    assert_eq!(authority.protocol, f.protocol);
    assert_eq!(authority.organisation, exporter);
    assert_eq!(authority.wallet, wallet);
    assert_eq!(authority.scopes, scopes);
    assert_eq!(authority.expires_at, NOW + 1);
    assert_eq!(authority.revoked_at, None);
    f.already_initialized(
        f.delegate(OrgAdmin, buyer, wallet, scopes, NOW + 1),
        OrgAdmin,
    );
}

#[test]
fn delegate_rejects_zero_scopes() {
    let mut f = Fixture::initialized();
    let org = f.add_org(1, Role::Exporter);
    let wallet = Pubkey::new_unique();
    f.refused(
        f.delegate(OrgAdmin, org, wallet, 0, NOW + 1),
        OrgAdmin,
        InvalidField,
    );
    assert!(!f.account_exists(f.authority(wallet)));

    // The refusal did not use up the wallet's one Authority.
    f.ok(
        f.delegate(OrgAdmin, org, wallet, state::scope::TRANSFER, NOW + 1),
        OrgAdmin,
    );
    assert_eq!(
        f.read::<Authority>(f.authority(wallet)).scopes,
        state::scope::TRANSFER
    );
}

#[test]
fn delegation_enforces_the_complete_role_scope_table() {
    let mut f = Fixture::initialized();
    for (index, (role, mask)) in [
        (Role::Exporter, 0x22e),
        (Role::Buyer, 0x24e),
        (Role::Custodian, 0x4c09),
        (Role::Transporter, 0xc00),
        (Role::Terminal, 0x5c00),
        (Role::Lender, 0x180),
        (Role::Inspector, 0x2800),
        (Role::DocumentIssuer, 0x4010),
    ]
    .into_iter()
    .enumerate()
    {
        let org = f.add_org(index as u8, role);
        for scopes in (0..=31).chain([
            0x20, 0x2e, 0x40, 0x4e, 0x80, 0x100, 0x180, 0x200, 0x8000, 0xffff,
        ]) {
            let wallet = Pubkey::new_unique();
            let ix = f.delegate(OrgAdmin, org, wallet, scopes, NOW + 1);
            if scopes == 0 {
                f.refused(ix, OrgAdmin, InvalidField);
            } else if scopes & !mask == 0 {
                f.ok(ix, OrgAdmin);
                assert_eq!(f.read::<Authority>(f.authority(wallet)).scopes, scopes);
            } else {
                f.refused(ix, OrgAdmin, ScopeNotAllowed);
            }
        }
    }
}

#[test]
fn revocation_is_permanent_and_accepts_either_authorized_signer() {
    let mut f = Fixture::initialized();
    let org = f.add_org(1, Role::Exporter);
    let other = f.add_org(2, Role::Exporter);
    for signer in [OrgAdmin, Accreditor] {
        let wallet = Pubkey::new_unique();
        let scopes = state::scope::TRANSFER;
        f.ok(f.delegate(OrgAdmin, org, wallet, scopes, NOW + 1), OrgAdmin);
        let authority = f.authority(wallet);
        f.refused(f.revoke(Admin, org, authority), Admin, NotOrganisationAdmin);
        f.refused(
            f.revoke(OrgAdmin, other, authority),
            OrgAdmin,
            WrongOrganisation,
        );
        let tx = f.ok(f.revoke(signer, org, authority), signer);
        assert_event(&tx, events::AuthorityRevoked { authority, at: NOW });
        let account: Authority = f.read(authority);
        assert_eq!(account.revoked_at, Some(NOW));
        assert_eq!(account.wallet, wallet);
        assert_eq!(account.organisation, org);
        assert_eq!(account.scopes, scopes);
        assert_eq!(account.expires_at, NOW + 1);
        f.refused(f.revoke(signer, org, authority), signer, AuthorityRevoked);
        f.already_initialized(f.delegate(OrgAdmin, org, wallet, scopes, NOW + 2), OrgAdmin);
    }
}

#[test]
fn custodian_class_checks_accreditor_role_site_code_and_capacity() {
    let mut f = Fixture::initialized();
    let custodian = f.add_org(1, Role::Custodian);
    let exporter = f.add_org(2, Role::Exporter);
    f.ok(
        f.register(Accreditor, "CHROME", 1, &["A"], 3600),
        Accreditor,
    );
    let class = f.class("CHROME", 1);
    let site = "SITE-01234567890";
    f.refused(
        f.accredit_site(Admin, custodian, class, site, 1),
        Admin,
        NotAccreditor,
    );
    f.refused(
        f.accredit_site(Accreditor, exporter, class, site, 1),
        Accreditor,
        WrongRole,
    );
    f.refused(
        f.accredit_site(Accreditor, custodian, class, site, 0),
        Accreditor,
        InvalidField,
    );
    for invalid in ["", "site-1", "SITE-012345678901", &"A".repeat(33)] {
        f.refused(
            f.accredit_site(Accreditor, custodian, class, invalid, 1),
            Accreditor,
            InvalidField,
        );
    }
    let tx = f.ok(
        f.accredit_site(Accreditor, custodian, class, site, 1),
        Accreditor,
    );
    let custodian_class = f.site(custodian, class, site);
    assert_event(
        &tx,
        events::CustodianClassAccredited {
            custodian_class,
            approved_capacity_kg: 1,
        },
    );
    let account: CustodianClass = f.read(custodian_class);
    assert_eq!(account.protocol, f.protocol);
    assert_eq!(account.custodian, custodian);
    assert_eq!(account.class_policy, class);
    assert_eq!(account.site_code, site);
    assert_eq!(account.approved_capacity_kg, 1);
    assert_eq!(account.occupied_kg, 0);
    assert_eq!(account.reserved_inbound_kg, 0);
    f.already_initialized(
        f.accredit_site(Accreditor, custodian, class, site, 2),
        Accreditor,
    );
}

#[test]
fn pause_and_unpause_check_admin_and_preserve_unselected_bits() {
    let mut f = Fixture::initialized();
    for paused in [true, false] {
        f.refused(f.change_pause(Accreditor, 1, paused), Accreditor, NotAdmin);
        for flags in [0x1000, 0x1001, 0x8000, 0xffff] {
            f.refused(f.change_pause(Admin, flags, paused), Admin, InvalidField);
        }
    }
    for (flags, paused, expected) in [
        (state::pause::ISSUE, true, 1),
        (state::pause::TRANSFER | state::pause::REDEEM, true, 11),
        (state::pause::SPLIT, true, 15),
        (state::pause::TRANSFER, false, 13),
        (0, false, 13),
        (15, false, 0),
    ] {
        let tx = f.ok(f.change_pause(Admin, flags, paused), Admin);
        if flags == 0 {
            assert!(event_data(&tx).next().is_none());
        } else {
            assert_event(&tx, events::PauseChanged { flags: expected });
        }
        assert_eq!(f.read::<Protocol>(f.protocol).pause_flags, expected);
    }
}

#[test]
fn nonzero_pause_no_ops_preserve_flags_without_events() {
    let mut f = Fixture::initialized();
    let set_bit = state::pause::ISSUE;
    let clear_bit = state::pause::TRANSFER;
    let tx = f.ok(f.change_pause(Admin, set_bit, true), Admin);
    assert_event(&tx, events::PauseChanged { flags: set_bit });
    assert_eq!(f.read::<Protocol>(f.protocol).pause_flags, set_bit);

    for (flags, paused) in [(set_bit, true), (clear_bit, false)] {
        let tx = f.ok(f.change_pause(Admin, flags, paused), Admin);
        assert_eq!(f.read::<Protocol>(f.protocol).pause_flags, set_bit);
        assert!(event_data(&tx).next().is_none());
    }
}

#[test]
fn setup_records_are_isolated_by_protocol_instance() {
    let mut f = Fixture::initialized();
    let first_protocol = f.protocol;
    let first_org = f.add_org(1, Role::Custodian);
    let wallet = Pubkey::new_unique();
    let scopes = state::scope::ISSUE;
    f.ok(
        f.delegate(OrgAdmin, first_org, wallet, scopes, NOW + 1),
        OrgAdmin,
    );
    let first_authority = f.authority(wallet);
    f.ok(
        f.register(Accreditor, "CHROME", 1, &["A"], 3600),
        Accreditor,
    );
    let first_class = f.class("CHROME", 1);

    let second_id = [2; 16];
    let mode = SettlementMode::DevnetTokenSimulation;
    f.ok(f.initialize_instance(second_id, mode, Admin), Admin);
    f.protocol = pda(&[b"protocol", &second_id]);
    assert_ne!(f.protocol, first_protocol);
    assert_eq!(f.read::<Protocol>(f.protocol).settlement_mode, mode);
    let second_org = f.add_org(1, Role::Custodian);
    assert_ne!(first_org, second_org);
    assert_ne!(first_class, f.class("CHROME", 1));

    f.refused(
        f.relationship(Accreditor, first_org, second_org),
        Accreditor,
        WrongOrganisation,
    );
    f.refused(
        f.relationship(Accreditor, second_org, first_org),
        Accreditor,
        WrongOrganisation,
    );
    f.refused(
        f.delegate(OrgAdmin, first_org, wallet, scopes, NOW + 1),
        OrgAdmin,
        WrongOrganisation,
    );
    f.refused(
        f.revoke(Accreditor, second_org, first_authority),
        Accreditor,
        WrongOrganisation,
    );
    // Preserve the authority's organisation link and vary the protocol account.
    // Delegation binds an authority to its organisation and that organisation's protocol,
    // so valid setup cannot produce a matched pair with just one foreign protocol field.
    f.refused(
        f.revoke(Accreditor, first_org, first_authority),
        Accreditor,
        WrongOrganisation,
    );
    f.refused(
        f.accredit_site(Accreditor, second_org, first_class, "SITE", 1),
        Accreditor,
        WrongOrganisation,
    );
    f.ok(
        f.register(Accreditor, "CHROME", 1, &["A"], 3600),
        Accreditor,
    );
    let second_class = f.class("CHROME", 1);
    assert_eq!(f.read::<ClassPolicy>(second_class).protocol, f.protocol);
    f.refused(
        f.accredit_site(Accreditor, first_org, second_class, "SITE", 1),
        Accreditor,
        WrongOrganisation,
    );
    f.ok(
        f.delegate(OrgAdmin, second_org, wallet, scopes, NOW + 1),
        OrgAdmin,
    );
    let second_authority = f.authority(wallet);
    assert_ne!(first_authority, second_authority);
    assert_eq!(
        f.read::<Authority>(second_authority).organisation,
        second_org
    );
    assert_eq!(f.read::<Authority>(first_authority).organisation, first_org);
}

#[test]
fn setup_signer_roles_are_isolated_by_protocol_instance() {
    let mut f = Fixture::initialized();
    let second_id = [2; 16];
    let initialize = f.initialize_instance_with_roles(
        second_id,
        SettlementMode::FiatAttestationTest,
        Admin2,
        Admin2,
        Accreditor2,
    );
    f.ok(initialize, Admin2);
    f.protocol = pda(&[b"protocol", &second_id]);
    let protocol: Protocol = f.read(f.protocol);
    assert_eq!(protocol.admin, f.key(Admin2));
    assert_ne!(protocol.admin, f.key(Admin));
    assert_eq!(protocol.accreditor, f.key(Accreditor2));
    assert_ne!(protocol.accreditor, f.key(Accreditor));

    f.refused(
        f.register(Accreditor, "CHROME", 1, &["A"], 3600),
        Accreditor,
        NotAccreditor,
    );
    f.ok(
        f.register(Accreditor2, "CHROME", 1, &["A"], 3600),
        Accreditor2,
    );
    let class = f.class("CHROME", 1);
    assert_eq!(f.read::<ClassPolicy>(class).protocol, f.protocol);
    f.refused(
        f.accredit(Accreditor, 1, Role::Custodian, "Kopano Stockyard Custody"),
        Accreditor,
        NotAccreditor,
    );
    let custodian = f.add_org_with_accreditor(Accreditor2, 1, Role::Custodian);
    let buyer = f.add_org_with_accreditor(Accreditor2, 2, Role::Buyer);
    f.refused(
        f.relationship(Accreditor, custodian, buyer),
        Accreditor,
        NotAccreditor,
    );
    f.refused(
        f.accredit_site(Accreditor, custodian, class, "SITE", 1),
        Accreditor,
        NotAccreditor,
    );

    let flags = state::pause::ISSUE;
    f.refused(f.change_pause(Admin, flags, true), Admin, NotAdmin);
    f.ok(f.change_pause(Admin2, flags, true), Admin2);
    assert_eq!(f.read::<Protocol>(f.protocol).pause_flags, flags);
    f.refused(f.change_pause(Admin, flags, false), Admin, NotAdmin);

    let wallet = Pubkey::new_unique();
    f.ok(
        f.delegate(OrgAdmin, custodian, wallet, state::scope::ISSUE, NOW + 1),
        OrgAdmin,
    );
    let authority = f.authority(wallet);
    let record: Authority = f.read(authority);
    assert_eq!(record.protocol, f.protocol);
    assert_eq!(record.organisation, custodian);
    assert_eq!(record.revoked_at, None);
    f.refused(
        f.revoke(Accreditor, custodian, authority),
        Accreditor,
        NotOrganisationAdmin,
    );
    let tx = f.ok(f.revoke(Accreditor2, custodian, authority), Accreditor2);
    assert_event(&tx, events::AuthorityRevoked { authority, at: NOW });
    assert_eq!(f.read::<Authority>(authority).revoked_at, Some(NOW));
}
