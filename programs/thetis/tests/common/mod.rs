use anchor_lang::{
    __private::base64::{engine::general_purpose::STANDARD, Engine},
    prelude::Pubkey,
    AccountDeserialize, Event, InstructionData, ToAccountMetas,
};
use litesvm::{
    types::{FailedTransactionMetadata, TransactionMetadata},
    LiteSVM,
};
use solana_clock::Clock;
use solana_keypair::Keypair;
use solana_message::{Message, VersionedMessage};
use solana_signer::Signer;
use solana_transaction::{
    versioned::VersionedTransaction, Instruction, InstructionError, TransactionError,
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
    Outsider,
}

use Actor::*;

pub struct Fixture {
    svm: LiteSVM,
    payer: Keypair,
    admin: Keypair,
    accreditor: Keypair,
    admin2: Keypair,
    accreditor2: Keypair,
    org_admin: Keypair,
    outsider: Keypair,
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
            outsider: Keypair::new(),
            protocol: pda(&[b"protocol", &INSTANCE]),
        }
    }

    pub fn initialized() -> Self {
        let mut fixture = Self::new();
        let init = fixture.initialize(Admin);
        fixture.ok(init, Admin);
        fixture
    }

    fn signer(&self, actor: Actor) -> &Keypair {
        match actor {
            Admin => &self.admin,
            Accreditor => &self.accreditor,
            Admin2 => &self.admin2,
            Accreditor2 => &self.accreditor2,
            OrgAdmin => &self.org_admin,
            Outsider => &self.outsider,
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
                origin_required: true,
                lot_validity_secs: validity,
                split_inherits_expiry: true,
            },
        )
    }

    pub fn organisation(&self, id: u8) -> Pubkey {
        pda(&[b"org", self.protocol.as_ref(), &[id; 16]])
    }

    pub fn accredit(&self, signer: Actor, id: u8, role: Role, name: &str) -> Instruction {
        ix(
            accounts::AccreditOrganisation {
                protocol: self.protocol,
                organisation: self.organisation(id),
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
        let name = "Kopano Stockyard Custody";
        let address = self.organisation(id);
        let tx = self.ok(self.accredit(accreditor, id, role, name), accreditor);
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

    pub fn account_exists(&self, address: Pubkey) -> bool {
        self.svm.get_account(&address).is_some()
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
        let keys: Vec<_> = instruction
            .accounts
            .iter()
            .map(|meta| meta.pubkey)
            .collect();
        let payer = self.payer.pubkey();
        let state_before: Vec<_> = keys.iter().map(|key| self.svm.get_account(key)).collect();
        let tx = self.transaction(&instruction, actor);
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
}
