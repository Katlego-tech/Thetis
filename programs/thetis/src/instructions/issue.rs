#![allow(
    clippy::ptr_arg,
    reason = "Anchor derives an argument type check for the owned String"
)]

use anchor_lang::{
    prelude::*,
    solana_program::instruction::{get_stack_height, TRANSACTION_LEVEL_STACK_HEIGHT},
};
use anchor_spl::{
    associated_token::{get_associated_token_address_with_program_id, AssociatedToken, Create},
    token_2022::{MintTo, Token2022},
    token_interface::Mint,
};

use crate::{
    error::ThetisError,
    events::LotIssued,
    intent::{
        message::issue_message,
        verify::{check_ed25519_instruction, previous_instruction},
    },
    receipts::{self, MINT_AUTHORITY_SEED, VAULT_AUTHORITY_SEED},
    state::*,
    validate::{check_authority, code_seed, valid_code, CUSTODY_WINDOW_SECS},
};

#[derive(Accounts)]
#[instruction(lot_id: String, grade: String, quantity_kg: u64, intake_digest: [u8; 32])]
pub struct IssueLot<'info> {
    #[account(mut)]
    pub sponsor: Signer<'info>,
    pub protocol: Box<Account<'info, Protocol>>,
    pub authority: Box<Account<'info, Authority>>,
    pub owner: Box<Account<'info, Organisation>>,
    pub custodian: Box<Account<'info, Organisation>>,
    pub class_policy: Box<Account<'info, ClassPolicy>>,
    #[account(mut)]
    pub custodian_class: Box<Account<'info, CustodianClass>>,
    /// CHECK: Validated as a DocumentAttestation in the handler when origin is required.
    pub origin: Option<UncheckedAccount<'info>>,
    /// CHECK: Validated as the issuing Organisation when origin is required.
    pub origin_issuer: Option<UncheckedAccount<'info>>,
    #[account(
        init,
        payer = sponsor,
        space = IntakeIdentity::DISCRIMINATOR.len() + IntakeIdentity::INIT_SPACE,
        seeds = [b"intake", protocol.key().as_ref(), custodian.key().as_ref(), &intake_digest],
        bump,
    )]
    pub intake: Box<Account<'info, IntakeIdentity>>,
    #[account(
        init,
        payer = sponsor,
        space = Lot::DISCRIMINATOR.len() + Lot::INIT_SPACE,
        seeds = [b"lot", protocol.key().as_ref(), code_seed(&lot_id, MAX_LOT_ID)?],
        bump,
    )]
    pub lot: Box<Account<'info, Lot>>,
    #[account(
        init,
        payer = sponsor,
        seeds = [b"mint", lot.key().as_ref()],
        bump,
        mint::decimals = 0,
        mint::authority = mint_authority,
        mint::freeze_authority = mint_authority,
        mint::token_program = token_program,
    )]
    pub mint: Box<InterfaceAccount<'info, Mint>>,
    /// CHECK: The seeds identify the mint and freeze authority.
    #[account(seeds = [MINT_AUTHORITY_SEED, mint.key().as_ref()], bump)]
    pub mint_authority: UncheckedAccount<'info>,
    #[account(
        init,
        payer = sponsor,
        space = Position::DISCRIMINATOR.len() + Position::INIT_SPACE,
        seeds = [b"position", lot.key().as_ref(), owner.key().as_ref()],
        bump,
    )]
    pub position: Box<Account<'info, Position>>,
    /// CHECK: The seeds identify the vault's token authority.
    #[account(seeds = [VAULT_AUTHORITY_SEED, position.key().as_ref()], bump)]
    pub vault_authority: UncheckedAccount<'info>,
    /// CHECK: The address is canonical and the associated token program creates or validates it.
    #[account(
        mut,
        address = get_associated_token_address_with_program_id(
            &vault_authority.key(), &mint.key(), &token_program.key(),
        ),
    )]
    pub vault: UncheckedAccount<'info>,
    /// CHECK: The address constraint pins the Instructions sysvar.
    #[account(address = solana_sdk_ids::sysvar::instructions::ID)]
    pub instructions: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token2022>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

pub fn issue_lot(
    ctx: Context<IssueLot>,
    lot_id: String,
    grade: String,
    quantity_kg: u64,
    intake_digest: [u8; 32],
    valid_until: i64,
) -> Result<()> {
    let accounts = ctx.accounts;
    let protocol = &accounts.protocol;
    require_eq!(
        get_stack_height(),
        TRANSACTION_LEVEL_STACK_HEIGHT,
        ThetisError::NotTopLevel
    );
    require!(
        protocol.pause_flags & pause::ISSUE == 0,
        ThetisError::Paused
    );

    let now = Clock::get()?.unix_timestamp;
    require!(now <= valid_until, ThetisError::Expired);
    let window = valid_until
        .checked_sub(now)
        .ok_or(ThetisError::WindowTooLong)?;
    require!(window <= CUSTODY_WINDOW_SECS, ThetisError::WindowTooLong);

    let authority = &accounts.authority;
    check_authority(authority, now, scope::ISSUE)?;

    let protocol_key = protocol.key();
    let owner = &accounts.owner;
    let custodian = &accounts.custodian;
    let class_policy = &accounts.class_policy;
    let site = &mut accounts.custodian_class;
    require!(
        authority.protocol == protocol_key
            && owner.protocol == protocol_key
            && custodian.protocol == protocol_key
            && class_policy.protocol == protocol_key
            && site.protocol == protocol_key
            && site.class_policy == class_policy.key()
            && site.custodian == custodian.key()
            && site.custodian == authority.organisation,
        ThetisError::WrongOrganisation
    );

    require!(owner.role == Role::Exporter, ThetisError::WrongRole);
    require!(
        !owner.related.contains(&custodian.key()) && !custodian.related.contains(&owner.key()),
        ThetisError::RelatedCustodian
    );
    let origin = if class_policy.origin_required {
        Some(check_origin(
            accounts.origin.as_ref(),
            accounts.origin_issuer.as_ref(),
            protocol_key,
            intake_digest,
            now,
        )?)
    } else {
        None
    };
    require!(
        valid_code(&lot_id, MAX_LOT_ID)
            && class_policy.grades.contains(&grade)
            && valid_code(&site.site_code, MAX_SITE_CODE),
        ThetisError::InvalidField
    );
    require!(quantity_kg > 0, ThetisError::ZeroQuantity);
    let occupied = site
        .occupied_kg
        .checked_add(quantity_kg)
        .ok_or(ThetisError::ArithmeticOverflow)?;
    let used_capacity = occupied
        .checked_add(site.reserved_inbound_kg)
        .ok_or(ThetisError::ArithmeticOverflow)?;
    require!(
        used_capacity <= site.approved_capacity_kg,
        ThetisError::OverCapacity
    );
    let expires_at = now
        .checked_add(class_policy.lot_validity_secs)
        .ok_or(ThetisError::ArithmeticOverflow)?;

    let text = issue_message(
        ctx.program_id,
        &protocol.instance_id,
        &lot_id,
        &class_policy.class_code,
        class_policy.version,
        &grade,
        quantity_kg,
        &owner.display_name,
        &custodian.display_name,
        &site.site_code,
        &intake_digest,
        origin.as_ref().map(|doc| (&doc.sha256, doc.version)),
        valid_until,
    );
    let verification = previous_instruction(&accounts.instructions)?;
    check_ed25519_instruction(&verification, &[authority.wallet], &text)?;

    receipts::create_vault(
        accounts.associated_token_program.key(),
        Create {
            payer: accounts.sponsor.to_account_info(),
            associated_token: accounts.vault.to_account_info(),
            authority: accounts.vault_authority.to_account_info(),
            mint: accounts.mint.to_account_info(),
            system_program: accounts.system_program.to_account_info(),
            token_program: accounts.token_program.to_account_info(),
        },
    )?;
    receipts::mint_receipts(
        accounts.token_program.key(),
        MintTo {
            mint: accounts.mint.to_account_info(),
            to: accounts.vault.to_account_info(),
            authority: accounts.mint_authority.to_account_info(),
        },
        ctx.bumps.mint_authority,
        quantity_kg,
    )?;

    let lot = accounts.lot.key();
    let intake = accounts.intake.key();
    accounts.intake.set_inner(IntakeIdentity {
        protocol: protocol_key,
        custodian: custodian.key(),
        intake_digest,
        lot,
        retired: false,
        bump: ctx.bumps.intake,
    });
    accounts.lot.set_inner(Lot {
        protocol: protocol_key,
        lot_id,
        class_policy: class_policy.key(),
        class_version: class_policy.version,
        grade,
        custodian_class: site.key(),
        intake,
        parent: None,
        root: lot,
        mint: accounts.mint.key(),
        supply_kg: quantity_kg,
        state: LotState::Stored,
        restriction: Restriction::Normal,
        expires_at,
        revision: 0,
        live_children: 0,
        bump: ctx.bumps.lot,
    });
    accounts.position.set_inner(Position {
        protocol: protocol_key,
        lot,
        owner: owner.key(),
        quantity_kg,
        locked_kg: 0,
        reserved_kg: 0,
        revision: 0,
        bump: ctx.bumps.position,
    });
    site.occupied_kg = occupied;

    receipts::check_vault_balance(&accounts.vault, accounts.position.quantity_kg)?;
    accounts.mint.reload()?;
    require_eq!(
        accounts.mint.supply,
        accounts.lot.supply_kg,
        ThetisError::BalanceMismatch
    );
    emit!(LotIssued {
        lot,
        owner: owner.key(),
        quantity_kg,
        intake,
        revision: 0,
    });
    Ok(())
}

fn check_origin(
    origin: Option<&UncheckedAccount<'_>>,
    issuer: Option<&UncheckedAccount<'_>>,
    protocol: Pubkey,
    intake_digest: [u8; 32],
    now: i64,
) -> Result<DocumentAttestation> {
    let origin = origin.ok_or(ThetisError::OriginInvalid)?;
    let issuer = issuer.ok_or(ThetisError::OriginInvalid)?;
    require!(
        origin.owner == &crate::ID && issuer.owner == &crate::ID,
        ThetisError::OriginInvalid
    );
    let origin_data = origin
        .try_borrow_data()
        .map_err(|_| ThetisError::OriginInvalid)?;
    let document = DocumentAttestation::try_deserialize(&mut origin_data.as_ref())
        .map_err(|_| ThetisError::OriginInvalid)?;
    let issuer_data = issuer
        .try_borrow_data()
        .map_err(|_| ThetisError::OriginInvalid)?;
    let organisation = Organisation::try_deserialize(&mut issuer_data.as_ref())
        .map_err(|_| ThetisError::OriginInvalid)?;
    require!(
        document.protocol == protocol
            && document.kind == DocumentKind::Origin
            && document.subject == intake_digest
            && document.revoked_at.is_none()
            && document.valid_until > now
            && document.issuer == issuer.key()
            && organisation.protocol == protocol
            && organisation.role == Role::DocumentIssuer,
        ThetisError::OriginInvalid
    );
    Ok(document)
}
