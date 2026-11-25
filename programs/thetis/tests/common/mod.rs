#![allow(dead_code)]
use anchor_lang::{
    __private::base64::{engine::general_purpose::STANDARD, Engine},
    prelude::{pubkey, Pubkey, SlotHashes},
    AccountDeserialize, AccountSerialize, Event, InstructionData, ToAccountMetas,
};
use anchor_spl::token_2022::spl_token_2022::{
    extension::StateWithExtensionsMut,
    state::{Account as TokenAccount, AccountState},
};
use litesvm::{
    types::{FailedTransactionMetadata, TransactionMetadata},
    LiteSVM,
};
use solana_clock::Clock;
use solana_keypair::Keypair;
use solana_message::{v0, AddressLookupTableAccount, Message, VersionedMessage};
use solana_signer::Signer;
use solana_transaction::{
    versioned::VersionedTransaction, AccountMeta, Instruction, InstructionError, TransactionError,
};
use thetis::{accounts, error::ThetisError, instruction, state::*, ID};

pub const NOW: i64 = 1_795_098_155;
pub const INSTANCE: [u8; 16] = [1; 16];
pub const SYSTEM: Pubkey = anchor_lang::system_program::ID;

pub fn pda(seeds: &[&[u8]]) -> Pubkey {
    Pubkey::find_program_address(seeds, &ID).0
}

pub fn ix(accounts: impl ToAccountMetas, data: impl InstructionData) -> Instruction {
    Instruction {
        program_id: ID,
        accounts: accounts.to_account_metas(None),
        data: data.data(),
    }
}

pub fn assert_event(tx: &TransactionMetadata, event: impl Event) {
    assert_eq!(
        event_data(tx).collect::<Vec<_>>(),
        [STANDARD.encode(event.data())]
    );
}

pub fn event_data(tx: &TransactionMetadata) -> impl Iterator<Item = &str> {
    tx.logs
        .iter()
        .filter_map(|line| line.strip_prefix("Program data: "))
}

#[derive(Clone, Copy)]
pub enum Actor {
    Admin,
    Accreditor,
    Admin2,
    Accreditor2,
    OrgAdmin,
    Issuer,
    Issuer2,
    Custodian,
    Custodian2,
    Outsider,
    Owner,
    Buyer,
    /// A wallet of the first lender organisation.
    Lender,
    /// A wallet of a second, unrelated lender organisation.
    Lender2,
    /// A second wallet of the first lender organisation, for scopes other than lending.
    LenderTreasury,
}

use Actor::*;

/// A whole account as the ledger holds it: what a test compares before and after a refusal.
#[derive(Clone, Debug, PartialEq)]
pub struct RawAccount {
    pub lamports: u64,
    pub owner: Pubkey,
    pub data: Vec<u8>,
    pub executable: bool,
    rent_epoch: u64,
}

pub struct Fixture {
    svm: LiteSVM,
    payer: Keypair,
    admin: Keypair,
    accreditor: Keypair,
    admin2: Keypair,
    accreditor2: Keypair,
    org_admin: Keypair,
    issuer: Keypair,
    issuer2: Keypair,
    custodian: Keypair,
    custodian2: Keypair,
    outsider: Keypair,
    owner: Keypair,
    buyer: Keypair,
    lender: Keypair,
    lender2: Keypair,
    lender_treasury: Keypair,
    pub protocol: Pubkey,
}

impl Fixture {
    pub fn new() -> Self {
        let mut svm = LiteSVM::new().with_precompiles();
        svm.add_program_from_file(
            ID,
            concat!(env!("CARGO_TARGET_TMPDIR"), "/../deploy/thetis.so"),
        )
        .expect("load thetis.so built by anchor build");
        svm.set_sysvar(&Clock {
            unix_timestamp: NOW,
            ..Clock::default()
        });
        let payer = Keypair::new();
        svm.airdrop(&payer.pubkey(), 10_000_000_000).unwrap();
        Self {
            svm,
            payer,
            admin: Keypair::new(),
            accreditor: Keypair::new(),
            admin2: Keypair::new(),
            accreditor2: Keypair::new(),
            org_admin: Keypair::new(),
            issuer: Keypair::new(),
            issuer2: Keypair::new(),
            custodian: Keypair::new(),
            custodian2: Keypair::new(),
            outsider: Keypair::new(),
            owner: Keypair::new(),
            buyer: Keypair::new(),
            lender: Keypair::new(),
            lender2: Keypair::new(),
            lender_treasury: Keypair::new(),
            protocol: pda(&[b"protocol", &INSTANCE]),
        }
    }

    pub fn initialized() -> Self {
        let mut fixture = Self::new();
        let init = fixture.initialize(Admin);
        fixture.ok(init, Admin);
        fixture
    }

    pub fn signer(&self, actor: Actor) -> &Keypair {
        match actor {
            Admin => &self.admin,
            Accreditor => &self.accreditor,
            Admin2 => &self.admin2,
            Accreditor2 => &self.accreditor2,
            OrgAdmin => &self.org_admin,
            Issuer => &self.issuer,
            Issuer2 => &self.issuer2,
            Custodian => &self.custodian,
            Custodian2 => &self.custodian2,
            Outsider => &self.outsider,
            Owner => &self.owner,
            Buyer => &self.buyer,
            Lender => &self.lender,
            Lender2 => &self.lender2,
            LenderTreasury => &self.lender_treasury,
        }
    }

    pub fn key(&self, actor: Actor) -> Pubkey {
        self.signer(actor).pubkey()
    }

    pub fn initialize(&self, signer: Actor) -> Instruction {
        self.initialize_instance(INSTANCE, SettlementMode::FiatAttestationTest, signer)
    }

    pub fn initialize_instance(
        &self,
        instance_id: [u8; 16],
        settlement_mode: SettlementMode,
        signer: Actor,
    ) -> Instruction {
        self.initialize_instance_with_roles(instance_id, settlement_mode, signer, Admin, Accreditor)
    }

    pub fn initialize_instance_with_roles(
        &self,
        instance_id: [u8; 16],
        settlement_mode: SettlementMode,
        signer: Actor,
        admin: Actor,
        accreditor: Actor,
    ) -> Instruction {
        ix(
            accounts::InitializeProtocol {
                protocol: pda(&[b"protocol", &instance_id]),
                admin: self.key(signer),
                payer: self.payer.pubkey(),
                system_program: SYSTEM,
            },
            instruction::InitializeProtocol {
                instance_id,
                settlement_mode,
                admin: self.key(admin),
                accreditor: self.key(accreditor),
            },
        )
    }

    pub fn class(&self, code: &str, version: u32) -> Pubkey {
        // Overlong malformed input has no valid PDA. The program must reject the field.
        pda(&[
            b"class",
            self.protocol.as_ref(),
            &code.as_bytes()[..code.len().min(32)],
            &version.to_le_bytes(),
        ])
    }

    pub fn register(
        &self,
        signer: Actor,
        code: &str,
        version: u32,
        grades: &[&str],
        validity: i64,
    ) -> Instruction {
        self.register_with_origin(signer, code, version, grades, validity, true)
    }

    pub fn register_with_origin(
        &self,
        signer: Actor,
        code: &str,
        version: u32,
        grades: &[&str],
        validity: i64,
        origin_required: bool,
    ) -> Instruction {
        self.register_with_inheritance(
            signer,
            code,
            version,
            grades,
            validity,
            origin_required,
            true,
        )
    }

    #[allow(clippy::too_many_arguments)]
    pub fn register_with_inheritance(
        &self,
        signer: Actor,
        code: &str,
        version: u32,
        grades: &[&str],
        validity: i64,
        origin_required: bool,
        split_inherits_expiry: bool,
    ) -> Instruction {
        ix(
            accounts::RegisterClass {
                protocol: self.protocol,
                class_policy: self.class(code, version),
                accreditor: self.key(signer),
                payer: self.payer.pubkey(),
                system_program: SYSTEM,
            },
            instruction::RegisterClass {
                class_code: code.into(),
                version,
                grades: grades.iter().map(|grade| (*grade).into()).collect(),
                origin_required,
                lot_validity_secs: validity,
                split_inherits_expiry,
            },
        )
    }

    pub fn organisation(&self, id: u8) -> Pubkey {
        pda(&[b"org", self.protocol.as_ref(), &[id; 16]])
    }

    pub fn organisation_name(&self, display_name: &str) -> Pubkey {
        pda(&[
            b"org_name",
            self.protocol.as_ref(),
            &solana_sha256_hasher::hash(display_name.to_ascii_lowercase().as_bytes()).to_bytes(),
        ])
    }

    pub fn accredit(&self, signer: Actor, id: u8, role: Role, name: &str) -> Instruction {
        ix(
            accounts::AccreditOrganisation {
                protocol: self.protocol,
                organisation: self.organisation(id),
                organisation_name: self.organisation_name(name),
                accreditor: self.key(signer),
                payer: self.payer.pubkey(),
                system_program: SYSTEM,
            },
            instruction::AccreditOrganisation {
                org_id: [id; 16],
                role,
                display_name: name.into(),
                admin: self.key(OrgAdmin),
            },
        )
    }

    pub fn add_org(&mut self, id: u8, role: Role) -> Pubkey {
        self.add_org_with_accreditor(Accreditor, id, role)
    }

    pub fn add_org_with_accreditor(&mut self, accreditor: Actor, id: u8, role: Role) -> Pubkey {
        let name = format!("Kopano Stockyard Custody {id}");
        let address = self.organisation(id);
        let tx = self.ok(self.accredit(accreditor, id, role, &name), accreditor);
        assert_event(
            &tx,
            thetis::events::OrganisationAccredited {
                organisation: address,
                role,
            },
        );
        let organisation: Organisation = self.read(address);
        assert_eq!(organisation.protocol, self.protocol);
        assert_eq!(organisation.org_id, [id; 16]);
        assert_eq!(organisation.role, role);
        assert_eq!(organisation.display_name, name);
        assert_eq!(organisation.admin, self.key(OrgAdmin));
        assert!(organisation.related.is_empty());
        address
    }

    pub fn relationship(&self, signer: Actor, a: Pubkey, b: Pubkey) -> Instruction {
        ix(
            accounts::DeclareRelationship {
                protocol: self.protocol,
                a,
                b,
                accreditor: self.key(signer),
            },
            instruction::DeclareRelationship {},
        )
    }

    pub fn authority(&self, wallet: Pubkey) -> Pubkey {
        pda(&[b"authority", self.protocol.as_ref(), wallet.as_ref()])
    }

    pub fn delegate(
        &self,
        signer: Actor,
        organisation: Pubkey,
        wallet: Pubkey,
        scopes: u16,
        expires_at: i64,
    ) -> Instruction {
        ix(
            accounts::DelegateAuthority {
                protocol: self.protocol,
                organisation,
                authority: self.authority(wallet),
                admin: self.key(signer),
                payer: self.payer.pubkey(),
                system_program: SYSTEM,
            },
            instruction::DelegateAuthority {
                wallet,
                scopes,
                expires_at,
            },
        )
    }

    pub fn revoke(&self, signer: Actor, organisation: Pubkey, authority: Pubkey) -> Instruction {
        ix(
            accounts::RevokeAuthority {
                protocol: self.protocol,
                organisation,
                authority,
                signer: self.key(signer),
            },
            instruction::RevokeAuthority {},
        )
    }

    pub fn site(&self, custodian: Pubkey, class: Pubkey, site_code: &str) -> Pubkey {
        pda(&[
            b"custodian_class",
            self.protocol.as_ref(),
            custodian.as_ref(),
            class.as_ref(),
            &site_code.as_bytes()[..site_code.len().min(32)],
        ])
    }

    pub fn accredit_site(
        &self,
        signer: Actor,
        custodian: Pubkey,
        class_policy: Pubkey,
        site_code: &str,
        approved_capacity_kg: u64,
    ) -> Instruction {
        ix(
            accounts::AccreditCustodianClass {
                protocol: self.protocol,
                custodian,
                class_policy,
                custodian_class: self.site(custodian, class_policy, site_code),
                accreditor: self.key(signer),
                payer: self.payer.pubkey(),
                system_program: SYSTEM,
            },
            instruction::AccreditCustodianClass {
                site_code: site_code.into(),
                approved_capacity_kg,
            },
        )
    }

    pub fn change_pause(&self, signer: Actor, flags: u16, paused: bool) -> Instruction {
        let accounts = accounts::SetPause {
            protocol: self.protocol,
            admin: self.key(signer),
        };
        if paused {
            ix(accounts, instruction::Pause { flags })
        } else {
            ix(accounts, instruction::Unpause { flags })
        }
    }

    pub fn set_clock(&mut self, unix_timestamp: i64) {
        self.svm.set_sysvar(&Clock {
            unix_timestamp,
            ..Clock::default()
        });
    }

    /// Moves the clock to `unix_timestamp` and keeps the slot, so it is safe after a warp.
    pub fn set_time(&mut self, unix_timestamp: i64) {
        let mut clock = self.svm.get_sysvar::<Clock>();
        clock.unix_timestamp = unix_timestamp;
        self.svm.set_sysvar(&clock);
    }

    pub fn document(&self, kind: DocumentKind, subject: [u8; 32], version: u32) -> Pubkey {
        pda(&[
            b"document",
            self.protocol.as_ref(),
            &[kind as u8],
            &subject,
            &version.to_le_bytes(),
        ])
    }

    #[allow(clippy::too_many_arguments)]
    pub fn attest(
        &self,
        signer: Actor,
        organisation: Pubkey,
        kind: DocumentKind,
        subject: [u8; 32],
        version: u32,
        sha256: [u8; 32],
        valid_until: i64,
    ) -> Instruction {
        ix(
            accounts::AttestDocument {
                protocol: self.protocol,
                organisation,
                authority: self.authority(self.key(signer)),
                document: self.document(kind, subject, version),
                wallet: self.key(signer),
                payer: self.payer.pubkey(),
                system_program: SYSTEM,
            },
            instruction::AttestDocument {
                kind,
                subject,
                version,
                sha256,
                valid_until,
            },
        )
    }

    pub fn revoke_document(
        &self,
        signer: Actor,
        organisation: Pubkey,
        document: Pubkey,
    ) -> Instruction {
        ix(
            accounts::RevokeDocument {
                protocol: self.protocol,
                organisation,
                authority: self.authority(self.key(signer)),
                document,
                wallet: self.key(signer),
            },
            instruction::RevokeDocument {},
        )
    }

    /// Writes an Authority account directly. Real delegation can never give
    /// ATTEST_ORIGIN to a non-issuer (delegate_authority refuses it), so this is the
    /// only way to reach the role check, which is defence in depth.
    pub fn forge_authority(
        &mut self,
        organisation: Pubkey,
        wallet: Pubkey,
        scopes: u16,
        expires_at: i64,
    ) {
        let address = self.authority(wallet);
        let bump = Pubkey::find_program_address(
            &[b"authority", self.protocol.as_ref(), wallet.as_ref()],
            &ID,
        )
        .1;
        let authority = Authority {
            protocol: self.protocol,
            organisation,
            wallet,
            scopes,
            expires_at,
            revoked_at: None,
            bump,
        };
        let mut data = Vec::new();
        authority.try_serialize(&mut data).unwrap();
        // Reuse the payer's account as a template: solana-account is not a dev-dependency.
        let mut account = self.svm.get_account(&self.payer.pubkey()).unwrap();
        account.lamports = self.svm.minimum_balance_for_rent_exemption(data.len());
        account.data = data;
        account.owner = ID;
        self.svm.set_account(address, account).unwrap();
    }

    /// Overwrites the data of a program-owned account with `value` serialised, keeping its
    /// lamports and its allocated length (zero-padded), so the program can still write it back.
    /// Reaches states the instructions cannot yet produce (a redeemed Lot, locked units, a
    /// revision near `u64::MAX`). An account that does not exist is created owned by the
    /// program.
    pub fn set_program_account<T: AccountSerialize>(&mut self, address: Pubkey, value: &T) {
        let mut data = Vec::new();
        value.try_serialize(&mut data).unwrap();
        let rent = self.svm.minimum_balance_for_rent_exemption(data.len());
        let mut account = match self.svm.get_account(&address) {
            Some(existing) => {
                assert_eq!(existing.owner, ID);
                existing
            }
            // Reuse the payer's account as a template: solana-account is not a dev-dependency.
            None => {
                let mut template = self.svm.get_account(&self.payer.pubkey()).unwrap();
                template.lamports = 0;
                template
            }
        };
        data.resize(data.len().max(account.data.len()), 0);
        account.lamports = account.lamports.max(rent);
        account.data = data;
        account.owner = ID;
        self.svm.set_account(address, account).unwrap();
    }

    pub fn account_exists(&self, address: Pubkey) -> bool {
        self.svm.get_account(&address).is_some()
    }

    /// Every field of an account that a refused transaction must leave alone.
    pub fn raw_account(&self, address: Pubkey) -> Option<RawAccount> {
        self.svm.get_account(&address).map(|account| RawAccount {
            lamports: account.lamports,
            owner: account.owner,
            data: account.data,
            executable: account.executable,
            rent_epoch: account.rent_epoch,
        })
    }

    /// Sets a Token-2022 account's state to Frozen in the ledger, so a thaw has something to
    /// thaw. The account must be initialised.
    pub fn freeze_token_account(&mut self, address: Pubkey) {
        let mut account = self.svm.get_account(&address).unwrap();
        {
            let mut token = StateWithExtensionsMut::<TokenAccount>::unpack(&mut account.data)
                .expect("a Token-2022 account");
            assert_eq!(token.base.state, AccountState::Initialized);
            token.base.state = AccountState::Frozen;
            token.pack_base();
        }
        self.svm.set_account(address, account).unwrap();
    }

    pub fn owner_and_data_len(&self, address: Pubkey) -> Option<(Pubkey, usize)> {
        let account = self.svm.get_account(&address)?;
        Some((account.owner, account.data.len()))
    }

    pub fn read<T: AccountDeserialize>(&self, address: Pubkey) -> T {
        let account = self.svm.get_account(&address).unwrap();
        assert_eq!(account.owner, ID);
        T::try_deserialize(&mut account.data.as_slice()).unwrap()
    }

    fn transaction(&mut self, instruction: &Instruction, actor: Actor) -> VersionedTransaction {
        self.svm.expire_blockhash();
        let message = Message::new_with_blockhash(
            std::slice::from_ref(instruction),
            Some(&self.payer.pubkey()),
            &self.svm.latest_blockhash(),
        );
        VersionedTransaction::try_new(
            VersionedMessage::Legacy(message),
            &[&self.payer, self.signer(actor)],
        )
        .unwrap()
    }

    /// Sends `instructions` in one legacy transaction that the sponsor pays for and `actor`
    /// also signs: a direct call to a program, as a wallet would make it.
    #[allow(
        clippy::result_large_err,
        reason = "test helpers return LiteSVM metadata for assertions"
    )]
    pub fn send_signed(
        &mut self,
        instructions: &[Instruction],
        actor: Actor,
    ) -> Result<TransactionMetadata, FailedTransactionMetadata> {
        self.svm.expire_blockhash();
        let message = Message::new_with_blockhash(
            instructions,
            Some(&self.payer.pubkey()),
            &self.svm.latest_blockhash(),
        );
        let tx = VersionedTransaction::try_new(
            VersionedMessage::Legacy(message),
            &[&self.payer, self.signer(actor)],
        )
        .unwrap();
        self.svm.send_transaction(tx)
    }

    /// A legacy transaction of `instructions` that the sponsor pays for and `actor` also signs.
    fn signed_transaction(
        &mut self,
        instructions: &[Instruction],
        actor: Actor,
    ) -> VersionedTransaction {
        self.svm.expire_blockhash();
        let message = Message::new_with_blockhash(
            instructions,
            Some(&self.payer.pubkey()),
            &self.svm.latest_blockhash(),
        );
        VersionedTransaction::try_new(
            VersionedMessage::Legacy(message),
            &[&self.payer, self.signer(actor)],
        )
        .unwrap()
    }

    /// Sends `instructions` signed by the sponsor (fee payer) and `actor`, and expects success:
    /// the shape of a TX instruction that also carries an Ed25519 entry.
    pub fn signed_ok(&mut self, instructions: &[Instruction], actor: Actor) -> TransactionMetadata {
        let tx = self.signed_transaction(instructions, actor);
        self.svm.send_transaction(tx).unwrap_or_else(|failure| {
            panic!(
                "signed transaction failed: {:?}\n{}",
                failure.err,
                failure.meta.pretty_logs()
            )
        })
    }

    /// As `signed_ok`, but instruction `index` must fail with `expected`, with no state change
    /// and no event.
    pub fn signed_refused(
        &mut self,
        instructions: &[Instruction],
        actor: Actor,
        index: u8,
        expected: ThetisError,
    ) {
        let code: u32 = expected.into();
        let mut keys = touched_keys(instructions);
        if !keys.contains(&self.payer.pubkey()) {
            keys.push(self.payer.pubkey());
        }
        let tx = self.signed_transaction(instructions, actor);
        let failure = self.failure_without_effect(&keys, tx);
        assert_eq!(
            failure.err,
            TransactionError::InstructionError(index, InstructionError::Custom(code)),
            "{}",
            failure.meta.pretty_logs()
        );
    }

    /// A signed v0 transaction that the sponsor pays for and `actor` also signs.
    pub fn signed_v0(
        &mut self,
        instructions: &[Instruction],
        tables: &[AddressLookupTableAccount],
        actor: Actor,
    ) -> VersionedTransaction {
        self.svm.expire_blockhash();
        let message = v0::Message::try_compile(
            &self.payer.pubkey(),
            instructions,
            tables,
            self.svm.latest_blockhash(),
        )
        .unwrap();
        VersionedTransaction::try_new(
            VersionedMessage::V0(message),
            &[&self.payer, self.signer(actor)],
        )
        .unwrap()
    }

    pub fn ok(&mut self, instruction: Instruction, actor: Actor) -> TransactionMetadata {
        let tx = self.transaction(&instruction, actor);
        self.svm.send_transaction(tx).unwrap()
    }

    pub fn refused(&mut self, instruction: Instruction, actor: Actor, expected: ThetisError) {
        let code: u32 = expected.into();
        let failure = self.refusal(instruction, actor);
        assert_eq!(
            failure.err,
            TransactionError::InstructionError(0, InstructionError::Custom(code)),
            "{}",
            failure.meta.pretty_logs()
        );
    }

    /// As `refused`, for a fault Anchor's account checks catch before the handler runs.
    pub fn refused_anchor(
        &mut self,
        instruction: Instruction,
        actor: Actor,
        expected: anchor_lang::error::ErrorCode,
    ) {
        let code: u32 = expected.into();
        let failure = self.refusal(instruction, actor);
        assert_eq!(
            failure.err,
            TransactionError::InstructionError(0, InstructionError::Custom(code)),
            "{}",
            failure.meta.pretty_logs()
        );
    }

    pub fn already_initialized(&mut self, instruction: Instruction, actor: Actor) {
        let failure = self.refusal(instruction, actor);
        // System program AccountAlreadyInUse from Anchor's init allocation.
        assert_eq!(
            failure.err,
            TransactionError::InstructionError(0, InstructionError::Custom(0)),
            "{}",
            failure.meta.pretty_logs()
        );
        assert!(failure
            .meta
            .logs
            .iter()
            .any(|line| line.contains("already in use")));
    }

    fn refusal(&mut self, instruction: Instruction, actor: Actor) -> FailedTransactionMetadata {
        let keys = touched_keys(std::slice::from_ref(&instruction));
        let tx = self.transaction(&instruction, actor);
        self.failure_without_effect(&keys, tx)
    }

    /// Sends a transaction that must fail and asserts that it changed nothing but the
    /// payer's balance (by the fee) and emitted no event.
    fn failure_without_effect(
        &mut self,
        keys: &[Pubkey],
        tx: VersionedTransaction,
    ) -> FailedTransactionMetadata {
        let payer = self.payer.pubkey();
        let state_before: Vec<_> = keys.iter().map(|key| self.svm.get_account(key)).collect();
        let failure = self.svm.send_transaction(tx).unwrap_err();
        let mut state_after: Vec<_> = keys.iter().map(|key| self.svm.get_account(key)).collect();
        for (key, account) in keys.iter().zip(&mut state_after) {
            if *key == payer {
                // Solana still charges the transaction fee when an instruction rolls back.
                account.as_mut().unwrap().lamports += failure.meta.fee;
            }
        }
        assert_eq!(state_before, state_after, "{}", failure.meta.pretty_logs());
        assert!(event_data(&failure.meta).next().is_none());
        failure
    }

    pub fn payer(&self) -> Pubkey {
        self.payer.pubkey()
    }

    pub fn balance(&self, address: Pubkey) -> u64 {
        self.svm.get_balance(&address).unwrap_or(0)
    }

    /// The owning program of an account, if it exists.
    pub fn owner(&self, address: Pubkey) -> Option<Pubkey> {
        Some(self.svm.get_account(&address)?.owner)
    }

    /// The raw data of an account, empty when it does not exist.
    pub fn data(&self, address: Pubkey) -> Vec<u8> {
        self.svm
            .get_account(&address)
            .map(|account| account.data)
            .unwrap_or_default()
    }

    /// Token (Token-2022 or Token) account balance: the u64 at bytes 64..72 of the base layout.
    pub fn token_amount(&self, address: Pubkey) -> u64 {
        let data = self.data(address);
        u64::from_le_bytes(data[64..72].try_into().unwrap())
    }

    /// Mint supply: the u64 at bytes 36..44 of the base layout.
    pub fn mint_supply(&self, address: Pubkey) -> u64 {
        let data = self.data(address);
        u64::from_le_bytes(data[36..44].try_into().unwrap())
    }

    /// A signed v0 transaction paid for and signed by the sponsor only.
    pub fn sponsored_v0(
        &mut self,
        instructions: &[Instruction],
        tables: &[AddressLookupTableAccount],
    ) -> VersionedTransaction {
        self.svm.expire_blockhash();
        let message = v0::Message::try_compile(
            &self.payer.pubkey(),
            instructions,
            tables,
            self.svm.latest_blockhash(),
        )
        .unwrap();
        VersionedTransaction::try_new(VersionedMessage::V0(message), &[&self.payer]).unwrap()
    }

    #[allow(
        clippy::result_large_err,
        reason = "test helpers return LiteSVM metadata for assertions"
    )]
    pub fn send(
        &mut self,
        tx: VersionedTransaction,
    ) -> Result<TransactionMetadata, FailedTransactionMetadata> {
        self.svm.send_transaction(tx)
    }

    fn sponsored_transaction(&mut self, instructions: &[Instruction]) -> VersionedTransaction {
        self.svm.expire_blockhash();
        let message = Message::new_with_blockhash(
            instructions,
            Some(&self.payer.pubkey()),
            &self.svm.latest_blockhash(),
        );
        VersionedTransaction::try_new(VersionedMessage::Legacy(message), &[&self.payer]).unwrap()
    }

    /// Sends a legacy transaction that the fee payer alone signs: the shape of a sponsored
    /// intent, whose authority signatures live in an Ed25519 instruction.
    #[allow(
        clippy::result_large_err,
        reason = "test helpers return LiteSVM metadata for assertions"
    )]
    pub fn send_sponsored(
        &mut self,
        instructions: &[Instruction],
    ) -> Result<TransactionMetadata, FailedTransactionMetadata> {
        let tx = self.sponsored_transaction(instructions);
        self.svm.send_transaction(tx)
    }

    pub fn sponsored_ok(&mut self, instructions: &[Instruction]) -> TransactionMetadata {
        self.send_sponsored(instructions).unwrap_or_else(|failure| {
            panic!(
                "sponsored transaction failed: {:?}\n{}",
                failure.err,
                failure.meta.pretty_logs()
            )
        })
    }

    /// Asserts instruction `index` fails with `expected`, with no state change and no event.
    pub fn sponsored_refused(
        &mut self,
        instructions: &[Instruction],
        index: u8,
        expected: ThetisError,
    ) {
        let code: u32 = expected.into();
        let failure = self.sponsored_failure(instructions);
        assert_eq!(
            failure.err,
            TransactionError::InstructionError(index, InstructionError::Custom(code)),
            "{}",
            failure.meta.pretty_logs()
        );
    }

    /// Asserts instruction `index` fails because an account it creates already exists.
    pub fn sponsored_already_in_use(&mut self, instructions: &[Instruction], index: u8) {
        let failure = self.sponsored_failure(instructions);
        // System program AccountAlreadyInUse from Anchor's init allocation.
        assert_eq!(
            failure.err,
            TransactionError::InstructionError(index, InstructionError::Custom(0)),
            "{}",
            failure.meta.pretty_logs()
        );
        assert!(failure
            .meta
            .logs
            .iter()
            .any(|line| line.contains("already in use")));
    }

    fn sponsored_failure(&mut self, instructions: &[Instruction]) -> FailedTransactionMetadata {
        let mut keys = touched_keys(instructions);
        if !keys.contains(&self.payer.pubkey()) {
            keys.push(self.payer.pubkey());
        }
        let tx = self.sponsored_transaction(instructions);
        self.failure_without_effect(&keys, tx)
    }

    /// Creates an address lookup table holding `addresses` and warps one slot so that it is
    /// active. The clock keeps its time.
    pub fn create_lookup_table(&mut self, addresses: Vec<Pubkey>) -> AddressLookupTableAccount {
        const LOOKUP_PROGRAM: Pubkey = pubkey!("AddressLookupTab1e1111111111111111111111111");
        // The table is derived from a slot present in SlotHashes; `set_clock` leaves slot 0.
        let slot = self.svm.get_sysvar::<SlotHashes>()[0].0;
        let mut clock = self.svm.get_sysvar::<Clock>();
        clock.slot = slot;
        self.svm.set_sysvar(&clock);

        let payer = self.payer.pubkey();
        let (key, bump) =
            Pubkey::find_program_address(&[payer.as_ref(), &slot.to_le_bytes()], &LOOKUP_PROGRAM);
        // Native lookup-table bincode ABI: CreateLookupTable = 0, ExtendLookupTable = 2.
        let table_accounts = vec![
            AccountMeta::new(key, false),
            AccountMeta::new_readonly(payer, true),
            AccountMeta::new(payer, true),
            AccountMeta::new_readonly(SYSTEM, false),
        ];
        let create = Instruction::new_with_bincode(
            LOOKUP_PROGRAM,
            &(0_u32, slot, bump),
            table_accounts.clone(),
        );
        let extend =
            Instruction::new_with_bincode(LOOKUP_PROGRAM, &(2_u32, &addresses), table_accounts);
        self.sponsored_ok(&[create, extend]);
        // Extended addresses become available in the slot after the extension.
        self.svm.warp_to_slot(slot + 1);
        AddressLookupTableAccount { key, addresses }
    }
}

/// Every account the instructions name, once each, in first-seen order.
fn touched_keys(instructions: &[Instruction]) -> Vec<Pubkey> {
    let mut keys = Vec::new();
    for meta in instructions.iter().flat_map(|ix| &ix.accounts) {
        if !keys.contains(&meta.pubkey) {
            keys.push(meta.pubkey);
        }
    }
    keys
}

/// The serialised size of a signed transaction, as the network counts it against the
/// 1,232-byte packet limit.
pub fn transaction_size(tx: &VersionedTransaction) -> usize {
    Instruction::new_with_wincode(ID, tx, vec![]).data.len()
}

/// An Ed25519 precompile instruction with one entry per `(signer, message)` pair; every
/// instruction-index field is `0xFFFF`, so the data refers to the instruction itself.
pub fn ed25519_instruction(entries: &[(&Keypair, &[u8])]) -> Instruction {
    ed25519_instruction_at(entries, u16::MAX)
}

/// As `ed25519_instruction`, but every instruction-index field is `instruction_index`: an
/// explicit number instead of the self-reference sentinel.
pub fn ed25519_instruction_at(
    entries: &[(&Keypair, &[u8])],
    instruction_index: u16,
) -> Instruction {
    const OFFSETS_LEN: u16 = 14;
    let count = u8::try_from(entries.len()).unwrap();
    let mut payload_offset = 2 + OFFSETS_LEN * u16::from(count);
    let mut data = vec![count, 0];
    let mut payloads = Vec::new();
    for (signer, message) in entries {
        let message_size = u16::try_from(message.len()).unwrap();
        let signature_offset = payload_offset;
        let public_key_offset = signature_offset + 64;
        let message_offset = public_key_offset + 32;
        for field in [
            signature_offset,
            instruction_index,
            public_key_offset,
            instruction_index,
            message_offset,
            message_size,
            instruction_index,
        ] {
            data.extend_from_slice(&field.to_le_bytes());
        }
        payloads.extend_from_slice(signer.sign_message(message).as_ref());
        payloads.extend_from_slice(signer.pubkey().as_ref());
        payloads.extend_from_slice(message);
        payload_offset = message_offset + message_size;
    }
    data.extend_from_slice(&payloads);
    Instruction {
        program_id: solana_sdk_ids::ed25519_program::ID,
        accounts: vec![],
        data,
    }
}

/// An Ed25519 precompile instruction with one entry per signer, all signing one `message` that
/// the data holds once: every entry's message offset points at that single copy. Every
/// instruction-index field is `0xFFFF`.
pub fn ed25519_shared_instruction(signers: &[&Keypair], message: &[u8]) -> Instruction {
    const OFFSETS_LEN: u16 = 14;
    const ENTRY_LEN: u16 = 64 + 32;
    let count = u8::try_from(signers.len()).unwrap();
    let message_size = u16::try_from(message.len()).unwrap();
    let entries_at = 2 + OFFSETS_LEN * u16::from(count);
    let message_offset = entries_at + ENTRY_LEN * u16::from(count);
    let mut data = vec![count, 0];
    let mut payloads = Vec::new();
    for (index, signer) in (0_u16..).zip(signers) {
        let signature_offset = entries_at + ENTRY_LEN * index;
        let public_key_offset = signature_offset + 64;
        for field in [
            signature_offset,
            u16::MAX,
            public_key_offset,
            u16::MAX,
            message_offset,
            message_size,
            u16::MAX,
        ] {
            data.extend_from_slice(&field.to_le_bytes());
        }
        payloads.extend_from_slice(signer.sign_message(message).as_ref());
        payloads.extend_from_slice(signer.pubkey().as_ref());
    }
    data.extend_from_slice(&payloads);
    data.extend_from_slice(message);
    Instruction {
        program_id: solana_sdk_ids::ed25519_program::ID,
        accounts: vec![],
        data,
    }
}
