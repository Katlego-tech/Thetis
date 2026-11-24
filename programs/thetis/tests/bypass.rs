//! ADR 0001 A02, re-run against this program's mint and vaults (program-lots.md §9).
//!
//! Alice is `Actor::Owner` (a wallet with TRANSFER under the Exporter that owns the source
//! Position), Mallory is `Actor::Outsider` (no position) and Bob is `Actor::Buyer` (the
//! legitimate recipient). In every direct Token-2022 call the attacker signs as the purported
//! authority and the sponsor pays. Each refusal is checked for the exact error code, for the
//! program that raised it, and for a before/after comparison of every account the call could
//! reach, so a refused call changes nothing but the sponsor's fee.
mod common;

use anchor_lang::prelude::Pubkey;
use anchor_spl::{
    associated_token::spl_associated_token_account::instruction::create_associated_token_account,
    token_2022::spl_token_2022::{
        error::TokenError,
        extension::{BaseStateWithExtensions, StateWithExtensions},
        instruction::{self as token, AuthorityType},
        state::{Account as TokenAccount, AccountState, Mint},
    },
};
use common::{Actor::*, *};
use solana_transaction::{Instruction, InstructionError, TransactionError};
use thetis::{
    accounts,
    error::ThetisError::{self, *},
    events, instruction,
    intent::message::{issue_message, transfer_message},
    state::{self, *},
    ID,
};

const TOKEN_2022: Pubkey = anchor_spl::token_2022::ID;
const ASSOCIATED_TOKEN: Pubkey = anchor_spl::associated_token::ID;
const INSTRUCTIONS_SYSVAR: Pubkey = solana_sdk_ids::sysvar::instructions::ID;
const LOT_VALIDITY: i64 = 30 * 86_400;
const DAY: i64 = 86_400;
/// The longest validity window a signed intent may ask for, less the margin the tests keep.
const INTENT_WINDOW: i64 = 570;

const INTAKE_DIGEST: [u8; 32] = digest(0x00);
const ORIGIN_SHA256: [u8; 32] = digest(0x20);

/// 32 ascending bytes from `base`, the shape of the signed-text known-answer vector.
const fn digest(base: u8) -> [u8; 32] {
    let mut bytes = [0; 32];
    let mut index = 0;
    while index < 32 {
        bytes[index] = base + index as u8;
        index += 1;
    }
    bytes
}

/// The demo world (demo.md §3).
const CLASS_CODE: &str = "CHROME";
const CLASS_VERSION: u32 = 1;
const GRADES: [&str; 2] = ["A", "B"];
const OWNER_NAME: &str = "Khunou Ore Exports";
const BUYER_NAME: &str = "Thaba Steel Buyers";
const OTHER_BUYER_NAME: &str = "Lesedi Metals Trading";
const CUSTODIAN_NAME: &str = "Kopano Stockyard Custody";
const SITE_CODE: &str = "PORT-STOCKYARD";
const APPROVED_CAPACITY_KG: u64 = 10_000_000;
const DOCUMENT_VERSION: u32 = 1;
const LOT_ID: &str = "CR-0001";
const LOT_QUANTITY_KG: u64 = 5_000_000;
/// What the demo moves to the Buyer so that the Buyer's vault exists before an attack.
const BUYER_QUANTITY_KG: u64 = 1_000_000;

/// Organisation ids in the demo world.
const OWNER_ID: u8 = 1;
const CUSTODIAN_ID: u8 = 2;
const ISSUER_ID: u8 = 3;
const BUYER_ID: u8 = 5;
const OTHER_BUYER_ID: u8 = 7;

/// One `transfer` call, with every input a test may vary.
#[derive(Clone)]
struct TransferArgs {
    quantity_kg: u64,
    expected_revision: u64,
    valid_until: i64,
    /// The source Organisation.
    owner: Pubkey,
    /// The destination Organisation.
    recipient: Pubkey,
    /// The Authority account passed.
    authority: Pubkey,
    /// Who signs the text, in entry order.
    signers: Vec<Actor>,
    /// A source Position to pass instead of the owner's own.
    from_position: Option<Pubkey>,
}

/// The addresses `transfer` derives for one call.
struct Addresses {
    mint: Pubkey,
    from_position: Pubkey,
    from_vault_authority: Pubkey,
    from_vault: Pubkey,
    to_position: Pubkey,
    to_vault_authority: Pubkey,
    to_vault: Pubkey,
}

/// Everything decoded from a Token-2022 mint that an attack could change.
#[derive(Debug, PartialEq)]
struct MintState {
    is_initialized: bool,
    decimals: u8,
    supply: u64,
    mint_authority: Option<Pubkey>,
    freeze_authority: Option<Pubkey>,
}

/// Everything decoded from a Token-2022 account that an attack could change.
#[derive(Debug, PartialEq)]
struct VaultState {
    mint: Pubkey,
    owner: Pubkey,
    amount: u64,
    delegate: Option<Pubkey>,
    delegated_amount: u64,
    state: AccountState,
    close_authority: Option<Pubkey>,
}

#[derive(Debug, PartialEq)]
struct PositionView {
    owner: Pubkey,
    quantity_kg: u64,
    locked_kg: u64,
    reserved_kg: u64,
    revision: u64,
}

#[derive(Debug, PartialEq)]
struct LotView {
    mint: Pubkey,
    supply_kg: u64,
    state: LotState,
    restriction: Restriction,
    revision: u64,
    live_children: u32,
    expires_at: i64,
}

/// What a refused call must leave exactly as it was: every watched account whole, plus the
/// decoded mint, vaults, Positions and Lot (the sponsor is not watched; its fee is checked
/// apart).
#[derive(Debug, PartialEq)]
struct State {
    accounts: Vec<(Pubkey, Option<RawAccount>)>,
    mint: MintState,
    lot: LotView,
    /// The owner's (Alice's), the Buyer's (Bob's) and the other Buyer's Position.
    positions: [Option<PositionView>; 3],
    /// The vaults of the same three organisations, in the same order.
    vaults: [Option<VaultState>; 3],
    /// Alice's personal associated token account, when it exists.
    personal: Option<VaultState>,
}

/// Where a refusal must come from: the instruction index, the `Custom` code, the program that
/// raises it and a fragment its logs must also contain.
struct Refusal<'a> {
    index: u8,
    code: u32,
    program: Pubkey,
    log: Option<&'a str>,
}

struct World {
    f: Fixture,
    owner: Pubkey,
    buyer: Pubkey,
    other_buyer: Pubkey,
    custodian: Pubkey,
    issuer_org: Pubkey,
    class_policy: Pubkey,
    custodian_class: Pubkey,
    /// The Authority of the custodian wallet that issues the lot.
    custodian_authority: Pubkey,
    /// The Authority of the owner's wallet, scope TRANSFER.
    authority: Pubkey,
    origin: Pubkey,
    lot: Pubkey,
    /// Vaults a test has set to Frozen in the ledger.
    frozen: Vec<Pubkey>,
}

impl World {
    /// Builds the world and issues the lot to the owner.
    fn demo() -> Self {
        let mut f = Fixture::initialized();
        let class_policy = f.class(CLASS_CODE, CLASS_VERSION);
        let register = f.register_with_origin(
            Accreditor,
            CLASS_CODE,
            CLASS_VERSION,
            &GRADES,
            LOT_VALIDITY,
            true,
        );
        f.ok(register, Accreditor);

        let owner = f.organisation(OWNER_ID);
        let accredit = f.accredit(Accreditor, OWNER_ID, Role::Exporter, OWNER_NAME);
        f.ok(accredit, Accreditor);
        let custodian = f.organisation(CUSTODIAN_ID);
        let accredit = f.accredit(Accreditor, CUSTODIAN_ID, Role::Custodian, CUSTODIAN_NAME);
        f.ok(accredit, Accreditor);
        let issuer_org = f.add_org(ISSUER_ID, Role::DocumentIssuer);
        let buyer = f.organisation(BUYER_ID);
        let accredit = f.accredit(Accreditor, BUYER_ID, Role::Buyer, BUYER_NAME);
        f.ok(accredit, Accreditor);
        let other_buyer = f.organisation(OTHER_BUYER_ID);
        let accredit = f.accredit(Accreditor, OTHER_BUYER_ID, Role::Buyer, OTHER_BUYER_NAME);
        f.ok(accredit, Accreditor);

        let delegate = f.delegate(
            OrgAdmin,
            issuer_org,
            f.key(Issuer),
            state::scope::ATTEST_ORIGIN,
            NOW + DAY,
        );
        f.ok(delegate, OrgAdmin);
        let attest = f.attest(
            Issuer,
            issuer_org,
            DocumentKind::Origin,
            INTAKE_DIGEST,
            DOCUMENT_VERSION,
            ORIGIN_SHA256,
            NOW + DAY,
        );
        f.ok(attest, Issuer);
        let origin = f.document(DocumentKind::Origin, INTAKE_DIGEST, DOCUMENT_VERSION);

        let custodian_class = f.site(custodian, class_policy, SITE_CODE);
        let accredit_site = f.accredit_site(
            Accreditor,
            custodian,
            class_policy,
            SITE_CODE,
            APPROVED_CAPACITY_KG,
        );
        f.ok(accredit_site, Accreditor);
        let delegate = f.delegate(
            OrgAdmin,
            custodian,
            f.key(Custodian),
            state::scope::ISSUE,
            NOW + DAY,
        );
        f.ok(delegate, OrgAdmin);
        let delegate = f.delegate(
            OrgAdmin,
            owner,
            f.key(Owner),
            state::scope::TRANSFER,
            NOW + DAY,
        );
        f.ok(delegate, OrgAdmin);

        let custodian_authority = f.authority(f.key(Custodian));
        let authority = f.authority(f.key(Owner));
        let lot = pda(&[b"lot", f.protocol.as_ref(), LOT_ID.as_bytes()]);
        let mut world = Self {
            f,
            owner,
            buyer,
            other_buyer,
            custodian,
            issuer_org,
            class_policy,
            custodian_class,
            custodian_authority,
            authority,
            origin,
            lot,
            frozen: Vec::new(),
        };
        world.issue_lot();
        world
    }

    /// The demo world after Alice's Exporter moved `BUYER_QUANTITY_KG` to the Buyer through
    /// Thetis, so Alice's and Bob's Positions and vaults both exist.
    fn with_buyer() -> Self {
        let mut world = Self::demo();
        let args = world.args(BUYER_QUANTITY_KG, 0);
        world.transfer_ok(&args);
        world
    }

    fn mint(&self) -> Pubkey {
        pda(&[b"mint", self.lot.as_ref()])
    }

    fn mint_authority(&self) -> Pubkey {
        pda(&[b"mint_authority", self.mint().as_ref()])
    }

    fn position(&self, organisation: Pubkey) -> Pubkey {
        pda(&[b"position", self.lot.as_ref(), organisation.as_ref()])
    }

    /// The PDA that owns an organisation's vault.
    fn vault_authority(&self, organisation: Pubkey) -> Pubkey {
        pda(&[b"vault", self.position(organisation).as_ref()])
    }

    /// The Token-2022 associated token account of a token owner for the lot's mint.
    fn vault(&self, token_owner: Pubkey) -> Pubkey {
        Pubkey::find_program_address(
            &[
                token_owner.as_ref(),
                TOKEN_2022.as_ref(),
                self.mint().as_ref(),
            ],
            &ASSOCIATED_TOKEN,
        )
        .0
    }

    /// An organisation's vault: the associated token account of its vault authority.
    fn vault_of(&self, organisation: Pubkey) -> Pubkey {
        self.vault(self.vault_authority(organisation))
    }

    /// Alice's personal associated token account for the lot's mint (not a vault).
    fn personal_ata(&self) -> Pubkey {
        self.vault(self.f.key(Owner))
    }

    fn addresses(&self, args: &TransferArgs) -> Addresses {
        let from_position = args
            .from_position
            .unwrap_or_else(|| self.position(args.owner));
        let from_vault_authority = pda(&[b"vault", from_position.as_ref()]);
        let to_position = self.position(args.recipient);
        let to_vault_authority = pda(&[b"vault", to_position.as_ref()]);
        Addresses {
            mint: self.mint(),
            from_position,
            from_vault_authority,
            from_vault: self.vault(from_vault_authority),
            to_position,
            to_vault_authority,
            to_vault: self.vault(to_vault_authority),
        }
    }

    /// Issues the lot to the owner through the Ed25519 verification instruction and
    /// `issue_lot`, asserting that it succeeds and leaves the owner holding everything.
    fn issue_lot(&mut self) {
        let grade = GRADES[0];
        let valid_until = NOW + INTENT_WINDOW;
        let protocol = self.f.protocol;
        let intake = pda(&[
            b"intake",
            protocol.as_ref(),
            self.custodian.as_ref(),
            &INTAKE_DIGEST,
        ]);
        let mint = self.mint();
        let position = self.position(self.owner);
        let vault_authority = pda(&[b"vault", position.as_ref()]);
        let vault = self.vault(vault_authority);

        let document = self.f.read::<DocumentAttestation>(self.origin);
        let text = issue_message(
            &ID,
            &INSTANCE,
            LOT_ID,
            CLASS_CODE,
            CLASS_VERSION,
            grade,
            LOT_QUANTITY_KG,
            OWNER_NAME,
            CUSTODIAN_NAME,
            SITE_CODE,
            &INTAKE_DIGEST,
            Some((&document.sha256, document.version)),
            valid_until,
        );
        let verify = ed25519_instruction(&[(self.f.signer(Custodian), text.as_slice())]);
        let issue = ix(
            accounts::IssueLot {
                sponsor: self.f.payer(),
                protocol,
                authority: self.custodian_authority,
                owner: self.owner,
                custodian: self.custodian,
                class_policy: self.class_policy,
                custodian_class: self.custodian_class,
                origin: Some(self.origin),
                origin_issuer: Some(self.issuer_org),
                intake,
                lot: self.lot,
                mint,
                mint_authority: self.mint_authority(),
                position,
                vault_authority,
                vault,
                instructions: INSTRUCTIONS_SYSVAR,
                token_program: TOKEN_2022,
                associated_token_program: ASSOCIATED_TOKEN,
                system_program: SYSTEM,
            },
            instruction::IssueLot {
                lot_id: LOT_ID.into(),
                grade: grade.into(),
                quantity_kg: LOT_QUANTITY_KG,
                intake_digest: INTAKE_DIGEST,
                valid_until,
            },
        );
        self.f.sponsored_ok(&[verify, issue]);

        let lot: Lot = self.f.read(self.lot);
        assert_eq!(lot.lot_id, LOT_ID);
        assert_eq!(lot.state, LotState::Stored);
        assert_eq!(lot.supply_kg, LOT_QUANTITY_KG);
        let position: Position = self.f.read(position);
        assert_eq!(position.owner, self.owner);
        assert_eq!(position.quantity_kg, LOT_QUANTITY_KG);
        assert_eq!(self.f.token_amount(vault), LOT_QUANTITY_KG);
        assert_eq!(self.f.mint_supply(mint), LOT_QUANTITY_KG);
    }

    /// The default transfer: the owner moves `quantity_kg` to the Buyer, signed by the owner's
    /// wallet for under ten minutes.
    fn args(&self, quantity_kg: u64, expected_revision: u64) -> TransferArgs {
        TransferArgs {
            quantity_kg,
            expected_revision,
            valid_until: NOW + INTENT_WINDOW,
            owner: self.owner,
            recipient: self.buyer,
            authority: self.authority,
            signers: vec![Owner],
            from_position: None,
        }
    }

    /// The revision of an organisation's Position, which `transfer` expects.
    fn revision_of(&self, organisation: Pubkey) -> u64 {
        self.f
            .read::<Position>(self.position(organisation))
            .revision
    }

    /// The text the program rebuilds from chain state and the arguments (program-lots.md §6.3).
    fn text(&self, args: &TransferArgs) -> Vec<u8> {
        let owner = self.f.read::<Organisation>(args.owner).display_name;
        let recipient = self.f.read::<Organisation>(args.recipient).display_name;
        transfer_message(
            &ID,
            &INSTANCE,
            LOT_ID,
            args.quantity_kg,
            &owner,
            &recipient,
            args.expected_revision,
            args.valid_until,
        )
    }

    /// The Ed25519 verification instruction followed by `transfer`.
    fn transfer(&self, args: &TransferArgs) -> [Instruction; 2] {
        let text = self.text(args);
        let entries: Vec<_> = args
            .signers
            .iter()
            .map(|actor| (self.f.signer(*actor), text.as_slice()))
            .collect();
        [
            ed25519_instruction(&entries),
            self.transfer_instruction(args),
        ]
    }

    fn transfer_instruction(&self, args: &TransferArgs) -> Instruction {
        let a = self.addresses(args);
        ix(
            accounts::Transfer {
                sponsor: self.f.payer(),
                protocol: self.f.protocol,
                authority: args.authority,
                lot: self.lot,
                mint: a.mint,
                owner: args.owner,
                from_position: a.from_position,
                from_vault_authority: a.from_vault_authority,
                from_vault: a.from_vault,
                recipient: args.recipient,
                to_position: a.to_position,
                to_vault_authority: a.to_vault_authority,
                to_vault: a.to_vault,
                instructions: INSTRUCTIONS_SYSVAR,
                token_program: TOKEN_2022,
                associated_token_program: ASSOCIATED_TOKEN,
                system_program: SYSTEM,
            },
            instruction::Transfer {
                quantity_kg: args.quantity_kg,
                expected_revision: args.expected_revision,
                valid_until: args.valid_until,
            },
        )
    }

    /// A legitimate Thetis transfer: it must succeed, move exactly `quantity_kg` between the
    /// two Positions and vaults, and leave every invariant standing.
    fn transfer_ok(&mut self, args: &TransferArgs) {
        let a = self.addresses(args);
        let before = self.capture(&[]);
        let tx = self.f.sponsored_ok(&self.transfer(args));
        let after = self.capture(&[]);
        self.assert_invariants(&after);

        let q = args.quantity_kg;
        let from: Position = self.f.read(a.from_position);
        let to: Position = self.f.read(a.to_position);
        let from_before = before.positions[0].as_ref().expect("source Position");
        assert_eq!(from.quantity_kg, from_before.quantity_kg - q);
        let to_before = before.positions[1].as_ref().map_or(0, |p| p.quantity_kg);
        assert_eq!(to.quantity_kg, to_before + q);
        assert_eq!(self.f.token_amount(a.from_vault), from.quantity_kg);
        assert_eq!(self.f.token_amount(a.to_vault), to.quantity_kg);
        assert_eq!(after.mint.supply, before.mint.supply);
        assert_event(
            &tx,
            events::UnitsTransferred {
                lot: self.lot,
                from: args.owner,
                to: args.recipient,
                quantity_kg: q,
                revision: before.lot.revision + 1,
            },
        );
    }

    /// Alice's personal associated token account, created by the sponsor with Alice as owner,
    /// asserted initialised and empty.
    fn create_personal_ata(&mut self) {
        let alice = self.f.key(Owner);
        let create =
            create_associated_token_account(&self.f.payer(), &alice, &self.mint(), &TOKEN_2022);
        self.f.sponsored_ok(&[create]);
        let personal = self
            .read_vault(self.personal_ata())
            .expect("Alice's personal token account exists");
        assert_eq!(personal.mint, self.mint());
        assert_eq!(personal.owner, alice);
        assert_eq!(personal.amount, 0);
        assert_eq!(personal.state, AccountState::Initialized);
        assert_eq!(personal.delegate, None);
        assert_eq!(personal.close_authority, None);
    }

    /// Sets a vault to Frozen in the ledger, so a thaw has something to thaw.
    fn freeze_vault(&mut self, vault: Pubkey) {
        self.f.freeze_token_account(vault);
        self.frozen.push(vault);
        let frozen = self.read_vault(vault).expect("the frozen vault");
        assert_eq!(frozen.state, AccountState::Frozen);
    }

    fn read_vault(&self, address: Pubkey) -> Option<VaultState> {
        let account = self.f.raw_account(address)?;
        assert_eq!(
            account.owner, TOKEN_2022,
            "{address} is a Token-2022 account"
        );
        let token = StateWithExtensions::<TokenAccount>::unpack(&account.data)
            .expect("a Token-2022 account")
            .base;
        Some(VaultState {
            mint: token.mint,
            owner: token.owner,
            amount: token.amount,
            delegate: token.delegate.into(),
            delegated_amount: token.delegated_amount,
            state: token.state,
            close_authority: token.close_authority.into(),
        })
    }

    fn read_position(&self, organisation: Pubkey) -> Option<PositionView> {
        let address = self.position(organisation);
        if !self.f.account_exists(address) {
            return None;
        }
        let position: Position = self.f.read(address);
        Some(PositionView {
            owner: position.owner,
            quantity_kg: position.quantity_kg,
            locked_kg: position.locked_kg,
            reserved_kg: position.reserved_kg,
            revision: position.revision,
        })
    }

    /// Receipt accounts and any other writable accounts, such as the wallet receiving
    /// lamports from a close attempt. The sponsor's fee is checked separately.
    fn watched(&self, instructions: &[Instruction]) -> Vec<Pubkey> {
        let organisations = [self.owner, self.buyer, self.other_buyer];
        let mut keys = vec![
            self.f.protocol,
            self.owner,
            self.buyer,
            self.other_buyer,
            self.custodian,
            self.custodian_class,
            self.lot,
            self.mint(),
            self.mint_authority(),
            self.authority,
            self.f.authority(self.f.key(Outsider)),
            self.personal_ata(),
        ];
        for organisation in organisations {
            keys.push(self.position(organisation));
            keys.push(self.vault_authority(organisation));
            keys.push(self.vault_of(organisation));
        }
        let payer = self.f.payer();
        keys.extend(
            instructions
                .iter()
                .flat_map(|instruction| &instruction.accounts)
                .filter(|account| account.is_writable && account.pubkey != payer)
                .map(|account| account.pubkey),
        );
        keys.sort_unstable();
        keys.dedup();
        keys
    }

    fn capture(&self, instructions: &[Instruction]) -> State {
        let mint_account = self.f.raw_account(self.mint()).expect("the lot's mint");
        assert_eq!(mint_account.owner, TOKEN_2022);
        let mint = StateWithExtensions::<Mint>::unpack(&mint_account.data).expect("a mint");
        assert!(
            mint.get_extension_types().unwrap().is_empty(),
            "the receipt mint has no Token-2022 extension"
        );
        let mint = MintState {
            is_initialized: mint.base.is_initialized,
            decimals: mint.base.decimals,
            supply: mint.base.supply,
            mint_authority: mint.base.mint_authority.into(),
            freeze_authority: mint.base.freeze_authority.into(),
        };
        let lot: Lot = self.f.read(self.lot);
        let organisations = [self.owner, self.buyer, self.other_buyer];
        State {
            accounts: self
                .watched(instructions)
                .into_iter()
                .map(|key| (key, self.f.raw_account(key)))
                .collect(),
            mint,
            lot: LotView {
                mint: lot.mint,
                supply_kg: lot.supply_kg,
                state: lot.state,
                restriction: lot.restriction,
                revision: lot.revision,
                live_children: lot.live_children,
                expires_at: lot.expires_at,
            },
            positions: organisations.map(|organisation| self.read_position(organisation)),
            vaults: organisations.map(|organisation| self.read_vault(self.vault_of(organisation))),
            personal: self.read_vault(self.personal_ata()),
        }
    }

    /// The ADR 0001 configuration, asserted on a captured state: the mint has no extension and
    /// the PDA is both its mint and freeze authority; every vault is held by its own PDA with
    /// no delegate and no close authority and holds what its Position says; the supply is the
    /// Lot's and the sum of the Positions; Alice's personal account is empty and hers.
    fn assert_invariants(&self, state: &State) {
        let pda = Some(self.mint_authority());
        assert!(state.mint.is_initialized);
        assert_eq!(state.mint.decimals, 0);
        assert_eq!(state.mint.mint_authority, pda);
        assert_eq!(state.mint.freeze_authority, pda);
        assert_eq!(state.lot.mint, self.mint());
        assert_eq!(state.mint.supply, state.lot.supply_kg);
        let held: u64 = state
            .positions
            .iter()
            .flatten()
            .map(|p| p.quantity_kg)
            .sum();
        assert_eq!(state.mint.supply, held);

        let organisations = [self.owner, self.buyer, self.other_buyer];
        for ((organisation, position), vault) in organisations
            .iter()
            .zip(&state.positions)
            .zip(&state.vaults)
        {
            match (position, vault) {
                (Some(position), Some(vault)) => {
                    assert_eq!(position.owner, *organisation);
                    assert_eq!(vault.mint, self.mint());
                    assert_eq!(vault.owner, self.vault_authority(*organisation));
                    assert_eq!(vault.amount, position.quantity_kg);
                    assert_eq!(vault.delegate, None);
                    assert_eq!(vault.delegated_amount, 0);
                    assert_eq!(vault.close_authority, None);
                    let expected = if self.frozen.contains(&self.vault_of(*organisation)) {
                        AccountState::Frozen
                    } else {
                        AccountState::Initialized
                    };
                    assert_eq!(vault.state, expected);
                }
                (None, None) => {}
                _ => panic!("a Position and its vault exist together or not at all"),
            }
        }
        // Alice always holds a Position, and so a vault.
        assert!(state.positions[0].is_some() && state.vaults[0].is_some());

        if let Some(personal) = &state.personal {
            assert_eq!(personal.mint, self.mint());
            assert_eq!(personal.owner, self.f.key(Owner));
            assert_eq!(personal.amount, 0);
            assert_eq!(personal.delegate, None);
            assert_eq!(personal.delegated_amount, 0);
            assert_eq!(personal.close_authority, None);
            assert_eq!(personal.state, AccountState::Initialized);
        }
    }

    /// Sends `instructions` and asserts the transaction fails at `index` with
    /// `Custom(code)` raised by `program` (and no other program), that nothing but the
    /// sponsor's fee changed, and that no event was emitted. `actor` signs next to the
    /// sponsor when given; otherwise the sponsor alone signs. `log` is a fragment the
    /// failure's logs must also contain.
    fn refuse(
        &mut self,
        label: &str,
        instructions: &[Instruction],
        actor: Option<Actor>,
        expected: Refusal,
    ) {
        let Refusal {
            index,
            code,
            program,
            log,
        } = expected;
        let before = self.capture(instructions);
        self.assert_invariants(&before);
        let payer = self.f.payer();
        let payer_before = self.f.balance(payer);

        let sent = match actor {
            Some(actor) => self.f.send_signed(instructions, actor),
            None => self.f.send_sponsored(instructions),
        };
        let failure = match sent {
            Err(failure) => failure,
            Ok(success) => panic!("{label} unexpectedly succeeded: {:?}", success.logs),
        };
        let logs = failure.meta.pretty_logs();

        assert_eq!(
            failure.err,
            TransactionError::InstructionError(index, InstructionError::Custom(code)),
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
        if let Some(fragment) = log {
            assert!(
                failure.meta.logs.iter().any(|line| line.contains(fragment)),
                "{label}: no log line contains {fragment:?}\n{logs}"
            );
        }
        assert!(
            event_data(&failure.meta).next().is_none(),
            "{label} emitted an event\n{logs}"
        );

        // The sponsor pays the fee for a refused transaction and nothing else.
        assert!(failure.meta.fee > 0);
        assert_eq!(
            self.f.balance(payer) + failure.meta.fee,
            payer_before,
            "{label} cost the sponsor more than its fee"
        );
        let after = self.capture(instructions);
        assert_eq!(before, after, "{label} changed receipt state\n{logs}");
        self.assert_invariants(&after);
    }

    /// Runs one direct Token-2022 call twice, as Alice and then as Mallory, each as a separate
    /// transaction. `build` makes the instruction for the signer, who is named as the
    /// authority in it. Both must fail in the token program with `expected` and change nothing.
    fn refuse_token(
        &mut self,
        label: &str,
        expected: TokenError,
        build: impl Fn(&World, Pubkey) -> Instruction,
    ) {
        let name = format!("{expected:?}");
        let code = expected as u32;
        for (who, actor) in [("Alice", Owner), ("Mallory", Outsider)] {
            let signer = self.f.key(actor);
            let instruction = build(self, signer);
            assert_eq!(instruction.program_id, TOKEN_2022);
            let label = format!("{label} ({who}) -> {name}");
            let expected = Refusal {
                index: 0,
                code,
                program: TOKEN_2022,
                log: None,
            };
            self.refuse(&label, &[instruction], Some(actor), expected);
        }
    }

    /// A refused Thetis call: the Ed25519 verification instruction passes at index 0 and
    /// `transfer` fails at index 1 with `expected`.
    fn refuse_thetis(
        &mut self,
        label: &str,
        instructions: &[Instruction; 2],
        expected: ThetisError,
    ) {
        let fragment = format!("Error Code: {expected:?}");
        let code: u32 = expected.into();
        let expected = Refusal {
            index: 1,
            code,
            program: ID,
            log: Some(&fragment),
        };
        self.refuse(label, instructions, None, expected);
    }
}

// The 17 operations of the ADR 0001 A02 list, each as Alice and as Mallory.

#[test]
fn bypass_refuses_transfer() {
    let mut w = World::with_buyer();
    w.refuse_token("Transfer", TokenError::OwnerMismatch, |w, signer| {
        #[allow(deprecated)]
        let transfer = token::transfer(
            &TOKEN_2022,
            &w.vault_of(w.owner),
            &w.vault_of(w.buyer),
            &signer,
            &[],
            1,
        );
        transfer.unwrap()
    });
}

#[test]
fn bypass_refuses_transfer_checked() {
    let mut w = World::with_buyer();
    w.refuse_token("TransferChecked", TokenError::OwnerMismatch, |w, signer| {
        token::transfer_checked(
            &TOKEN_2022,
            &w.vault_of(w.owner),
            &w.mint(),
            &w.vault_of(w.buyer),
            &signer,
            &[],
            1,
            0,
        )
        .unwrap()
    });
}

#[test]
fn bypass_refuses_burn() {
    let mut w = World::with_buyer();
    w.refuse_token("Burn", TokenError::OwnerMismatch, |w, signer| {
        token::burn(
            &TOKEN_2022,
            &w.vault_of(w.owner),
            &w.mint(),
            &signer,
            &[],
            1,
        )
        .unwrap()
    });
}

#[test]
fn bypass_refuses_burn_checked() {
    let mut w = World::with_buyer();
    w.refuse_token("BurnChecked", TokenError::OwnerMismatch, |w, signer| {
        token::burn_checked(
            &TOKEN_2022,
            &w.vault_of(w.owner),
            &w.mint(),
            &signer,
            &[],
            1,
            0,
        )
        .unwrap()
    });
}

#[test]
fn bypass_refuses_approve() {
    let mut w = World::with_buyer();
    w.refuse_token("Approve", TokenError::OwnerMismatch, |w, signer| {
        token::approve(
            &TOKEN_2022,
            &w.vault_of(w.owner),
            &w.f.key(Buyer),
            &signer,
            &[],
            1,
        )
        .unwrap()
    });
}

#[test]
fn bypass_refuses_approve_checked() {
    let mut w = World::with_buyer();
    w.refuse_token("ApproveChecked", TokenError::OwnerMismatch, |w, signer| {
        token::approve_checked(
            &TOKEN_2022,
            &w.vault_of(w.owner),
            &w.mint(),
            &w.f.key(Buyer),
            &signer,
            &[],
            1,
            0,
        )
        .unwrap()
    });
}

#[test]
fn bypass_refuses_close_account_with_balance() {
    let mut w = World::with_buyer();
    assert!(w.f.token_amount(w.vault_of(w.owner)) > 0);
    w.refuse_token(
        "CloseAccount",
        TokenError::NonNativeHasBalance,
        |w, signer| {
            token::close_account(&TOKEN_2022, &w.vault_of(w.owner), &signer, &signer, &[]).unwrap()
        },
    );
}

#[test]
fn bypass_refuses_close_account_empty_vault() {
    // A whole-position Thetis transfer leaves Alice's vault open at zero.
    let mut w = World::demo();
    let args = w.args(LOT_QUANTITY_KG, 0);
    w.transfer_ok(&args);
    let vault = w.vault_of(w.owner);
    assert!(w.f.account_exists(vault));
    assert_eq!(w.f.token_amount(vault), 0);
    assert_eq!(w.read_position(w.owner).unwrap().quantity_kg, 0);
    w.refuse_token(
        "CloseAccount empty vault",
        TokenError::OwnerMismatch,
        |w, signer| {
            token::close_account(&TOKEN_2022, &w.vault_of(w.owner), &signer, &signer, &[]).unwrap()
        },
    );
    assert!(w.f.account_exists(vault));
}

#[test]
fn bypass_refuses_set_authority_vault_owner() {
    let mut w = World::with_buyer();
    w.refuse_token(
        "SetAuthority vault owner",
        TokenError::OwnerMismatch,
        |w, signer| {
            token::set_authority(
                &TOKEN_2022,
                &w.vault_of(w.owner),
                Some(&signer),
                AuthorityType::AccountOwner,
                &signer,
                &[],
            )
            .unwrap()
        },
    );
}

#[test]
fn bypass_refuses_set_authority_vault_close() {
    let mut w = World::with_buyer();
    w.refuse_token(
        "SetAuthority vault close",
        TokenError::OwnerMismatch,
        |w, signer| {
            token::set_authority(
                &TOKEN_2022,
                &w.vault_of(w.owner),
                Some(&signer),
                AuthorityType::CloseAccount,
                &signer,
                &[],
            )
            .unwrap()
        },
    );
}

#[test]
fn bypass_refuses_set_authority_mint() {
    let mut w = World::with_buyer();
    w.refuse_token(
        "SetAuthority mint",
        TokenError::OwnerMismatch,
        |w, signer| {
            token::set_authority(
                &TOKEN_2022,
                &w.mint(),
                Some(&signer),
                AuthorityType::MintTokens,
                &signer,
                &[],
            )
            .unwrap()
        },
    );
}

#[test]
fn bypass_refuses_set_authority_freeze() {
    let mut w = World::with_buyer();
    w.refuse_token(
        "SetAuthority freeze",
        TokenError::OwnerMismatch,
        |w, signer| {
            token::set_authority(
                &TOKEN_2022,
                &w.mint(),
                Some(&signer),
                AuthorityType::FreezeAccount,
                &signer,
                &[],
            )
            .unwrap()
        },
    );
}

#[test]
fn bypass_refuses_mint_to() {
    let mut w = World::with_buyer();
    w.refuse_token("MintTo", TokenError::OwnerMismatch, |w, signer| {
        token::mint_to(
            &TOKEN_2022,
            &w.mint(),
            &w.vault_of(w.owner),
            &signer,
            &[],
            1,
        )
        .unwrap()
    });
}

#[test]
fn bypass_refuses_freeze_account() {
    let mut w = World::with_buyer();
    w.refuse_token("FreezeAccount", TokenError::OwnerMismatch, |w, signer| {
        token::freeze_account(&TOKEN_2022, &w.vault_of(w.owner), &w.mint(), &signer, &[]).unwrap()
    });
}

#[test]
fn bypass_refuses_thaw_account() {
    let mut w = World::with_buyer();
    // Freeze the vault in the ledger first, so a thaw by a non-authority has something to thaw;
    // the baseline is taken after that.
    w.freeze_vault(w.vault_of(w.owner));
    w.refuse_token("ThawAccount", TokenError::OwnerMismatch, |w, signer| {
        token::thaw_account(&TOKEN_2022, &w.vault_of(w.owner), &w.mint(), &signer, &[]).unwrap()
    });
    assert_eq!(
        w.read_vault(w.vault_of(w.owner)).unwrap().state,
        AccountState::Frozen
    );
}

#[test]
fn bypass_refuses_transfer_checked_to_personal_ata() {
    let mut w = World::with_buyer();
    w.create_personal_ata();
    w.refuse_token(
        "TransferChecked to Alice's ATA",
        TokenError::OwnerMismatch,
        |w, signer| {
            token::transfer_checked(
                &TOKEN_2022,
                &w.vault_of(w.owner),
                &w.mint(),
                &w.personal_ata(),
                &signer,
                &[],
                1,
                0,
            )
            .unwrap()
        },
    );
    assert_eq!(w.read_vault(w.personal_ata()).unwrap().amount, 0);
}

#[test]
fn bypass_refuses_mint_to_personal_ata() {
    let mut w = World::with_buyer();
    w.create_personal_ata();
    w.refuse_token(
        "MintTo Alice's ATA",
        TokenError::OwnerMismatch,
        |w, signer| {
            token::mint_to(&TOKEN_2022, &w.mint(), &w.personal_ata(), &signer, &[], 1).unwrap()
        },
    );
    assert_eq!(w.read_vault(w.personal_ata()).unwrap().amount, 0);
}

// The Thetis lines of the A02 list: its own instruction refuses what the token program cannot.

#[test]
fn bypass_refuses_thetis_transfer_by_non_owner() {
    let mut w = World::with_buyer();
    // Mallory holds a valid TRANSFER Authority under another Buyer organisation and names
    // Alice's Position as the source.
    let delegate = w.f.delegate(
        OrgAdmin,
        w.other_buyer,
        w.f.key(Outsider),
        state::scope::TRANSFER,
        NOW + DAY,
    );
    w.f.ok(delegate, OrgAdmin);
    let args = TransferArgs {
        owner: w.other_buyer,
        recipient: w.buyer,
        authority: w.f.authority(w.f.key(Outsider)),
        signers: vec![Outsider],
        from_position: Some(w.position(w.owner)),
        ..w.args(1_000, w.revision_of(w.owner))
    };
    let instructions = w.transfer(&args);

    w.refuse_thetis(
        "Thetis transfer by non-owner",
        &instructions,
        WrongOrganisation,
    );
}

#[test]
fn bypass_refuses_thetis_transfer_over_quantity() {
    let mut w = World::with_buyer();
    let position = w.read_position(w.owner).unwrap();
    let available = position.quantity_kg - position.locked_kg - position.reserved_kg;
    assert_eq!(available, LOT_QUANTITY_KG - BUYER_QUANTITY_KG);
    let args = w.args(available + 1, position.revision);
    let instructions = w.transfer(&args);

    w.refuse_thetis(
        "Thetis transfer over quantity",
        &instructions,
        InsufficientAvailable,
    );
}

#[test]
fn bypass_refuses_thetis_transfer_to_self() {
    let mut w = World::with_buyer();
    let args = TransferArgs {
        recipient: w.owner,
        ..w.args(1_000, w.revision_of(w.owner))
    };
    let instructions = w.transfer(&args);

    w.refuse_thetis("Thetis transfer to self", &instructions, InvalidField);
}

#[test]
fn bypass_refuses_thetis_transfer_to_personal_ata() {
    let mut w = World::with_buyer();
    w.create_personal_ata();
    let args = w.args(1_000, w.revision_of(w.owner));
    let a = w.addresses(&args);
    let [verify, mut transfer] = w.transfer(&args);
    // The recipient's vault is replaced by Alice's personal associated token account.
    let slots: Vec<usize> = (0..transfer.accounts.len())
        .filter(|&slot| transfer.accounts[slot].pubkey == a.to_vault)
        .collect();
    assert_eq!(slots.len(), 1, "to_vault is passed exactly once");
    transfer.accounts[slots[0]].pubkey = w.personal_ata();

    let code = anchor_lang::error::ErrorCode::ConstraintAddress as u32;
    assert_eq!(code, 2012);
    let expected = Refusal {
        index: 1,
        code,
        program: ID,
        log: Some("Error Code: ConstraintAddress"),
    };
    w.refuse(
        "Thetis transfer to Alice's ATA",
        &[verify, transfer],
        None,
        expected,
    );
}
