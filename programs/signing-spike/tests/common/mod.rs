use anchor_lang::{
    prelude::{pubkey, Pubkey, SlotHashes},
    solana_program::{system_instruction, system_program, sysvar::SysvarId},
};
use litesvm::{
    types::{FailedTransactionMetadata, TransactionMetadata},
    LiteSVM,
};
use sha2::{Digest, Sha256};
use solana_clock::Clock;
use solana_hash::Hash;
use solana_keypair::Keypair;
use solana_message::{v0, v1, AddressLookupTableAccount, Message, VersionedMessage};
use solana_signature::Signature;
use solana_signer::Signer;
use solana_transaction::{
    versioned::VersionedTransaction, AccountMeta, Instruction, InstructionError, TransactionError,
};
use spl_ed25519_signer_interface::{
    instruction::Instruction as SignerInstruction, pda::ProgrammaticSigner,
};
use spl_message_executor_interface::{
    instruction::Instruction as ExecutorInstruction, pda::TransitionSigner,
};
use spl_nonce_interface::{instruction::Instruction as NonceInstruction, state::Nonce};

pub const PROGRAM: Pubkey = signing_spike::ID;
pub const QUANTITY_KG: u64 = 2_000_000;
const BATCH_ID: [u8; 16] = *b"thetis-spike-001";
const PACKET_DATA_SIZE: usize = 1232;

pub struct Fixture {
    svm: LiteSVM,
    sponsor: Keypair,
    pub alice: Keypair,
    pub bob: Keypair,
    pub mallory: Keypair,
    pub batch: Pubkey,
    nonce: Pubkey,
    sender: Pubkey,
    receiver: Pubkey,
    batch_bump: u8,
    expiry_slot: u64,
    relay_table: AddressLookupTableAccount,
}

impl Fixture {
    pub fn new() -> Self {
        let mut svm = LiteSVM::new();
        svm.add_program_from_file(
            PROGRAM,
            concat!(env!("CARGO_TARGET_TMPDIR"), "/../deploy/signing_spike.so"),
        )
        .expect("load signing_spike.so built by anchor build");
        load_programmatic_signer(&mut svm);

        let sponsor = Keypair::new();
        let alice = Keypair::new();
        let bob = Keypair::new();
        let mallory = Keypair::new();
        svm.airdrop(&sponsor.pubkey(), 1_000_000_000).unwrap();
        // Give the wallets a nonzero balance so fee assertions can detect any debit.
        for wallet in [&alice, &bob] {
            svm.airdrop(&wallet.pubkey(), 1_000_000).unwrap();
        }
        let (sender, sender_bump) = party_address(alice.pubkey());
        let (receiver, receiver_bump) = party_address(bob.pubkey());
        let (batch, batch_bump) = Pubkey::find_program_address(&[b"batch", &BATCH_ID], &PROGRAM);

        for (wallet, party, bump) in [
            (alice.pubkey(), sender, sender_bump),
            (bob.pubkey(), receiver, receiver_bump),
        ] {
            let register = spike_instruction(
                "register_party",
                &[wallet.as_ref()],
                vec![
                    AccountMeta::new(sponsor.pubkey(), true),
                    AccountMeta::new(party, false),
                    readonly(system_program::ID),
                ],
            );
            send_ok(&mut svm, &[register], &[&sponsor], "register party");
            let expected = [
                discriminator("account:Party").as_slice(),
                wallet.as_ref(),
                ps_address(&wallet).as_ref(),
                &[bump],
            ]
            .concat();
            assert_eq!(svm.get_account(&party).unwrap().data, expected);
        }

        let open = spike_instruction(
            "open_batch",
            &[
                &BATCH_ID,
                alice.pubkey().as_ref(),
                bob.pubkey().as_ref(),
                &QUANTITY_KG.to_le_bytes(),
            ],
            vec![
                AccountMeta::new(sponsor.pubkey(), true),
                AccountMeta::new(batch, false),
                readonly(sender),
                readonly(receiver),
                readonly(system_program::ID),
            ],
        );
        send_ok(&mut svm, &[open], &[&sponsor], "open batch");
        let nonce = create_nonce(&mut svm, &sponsor);
        let relay_table = create_relay_table(
            &mut svm,
            &sponsor,
            vec![
                nonce,
                spl_nonce_interface::ID,
                TransitionSigner::ADDRESS,
                batch,
                sender,
                receiver,
                PROGRAM,
                spl_message_executor_interface::ID,
                alice.pubkey(),
                bob.pubkey(),
                mallory.pubkey(),
                ps_address(&alice.pubkey()),
                ps_address(&bob.pubkey()),
                ps_address(&mallory.pubkey()),
            ],
        );
        let expiry_slot = svm.get_sysvar::<Clock>().slot + 50;
        let fixture = Self {
            svm,
            sponsor,
            alice,
            bob,
            mallory,
            batch,
            nonce,
            sender,
            receiver,
            batch_bump,
            expiry_slot,
            relay_table,
        };
        fixture.assert_batch(0, false);
        fixture
    }

    pub fn nonce_value(&self) -> Hash {
        let account = self.svm.get_account(&self.nonce).unwrap();
        Nonce::view(&account.data).unwrap().nonce
    }

    pub fn handover(&self, quantity_kg: u64, expected_sequence: u64) -> Instruction {
        spike_instruction(
            "handover",
            &[
                &BATCH_ID,
                &quantity_kg.to_le_bytes(),
                &self.expiry_slot.to_le_bytes(),
                &expected_sequence.to_le_bytes(),
            ],
            vec![
                AccountMeta::new(self.batch, false),
                readonly(self.sender),
                readonly(self.receiver),
                AccountMeta::new_readonly(ps_address(&self.alice.pubkey()), true),
                AccountMeta::new_readonly(ps_address(&self.bob.pubkey()), true),
            ],
        )
    }

    pub fn endorse(&self, handover: Instruction, authorities: &[&Keypair]) -> Authorization {
        let execution = v1::Message::try_compile(
            &ps_address(&self.alice.pubkey()),
            &[handover],
            self.nonce_value(),
        )
        .unwrap();

        let sponsor = self.sponsor.pubkey();
        let mut execute_accounts = vec![
            AccountMeta::new_readonly(sponsor, true),
            AccountMeta::new(self.nonce, false),
            readonly(spl_nonce_interface::ID),
            readonly(TransitionSigner::ADDRESS),
        ];
        execute_accounts.extend(message_accounts(&execution, true));
        let execute = Instruction::new_with_wincode(
            spl_message_executor_interface::ID,
            &ExecutorInstruction::Execute(VersionedMessage::V1(execution)),
            execute_accounts,
        );

        // PDA signatures are granted by Submit, and the sponsor signs the relay itself.
        let mut envelope = execute;
        for meta in &mut envelope.accounts {
            meta.is_signer = meta.pubkey == sponsor;
        }
        let execute_account_count = envelope.accounts.len();
        envelope.accounts.extend(
            authorities
                .iter()
                .map(|key| AccountMeta::new_readonly(key.pubkey(), true)),
        );
        // The wallets are included in the authorization signer keys only. The Executor
        // receives the original account list.
        let mut message = v1::Message::try_compile(&sponsor, &[envelope], Hash::default()).unwrap();
        message.instructions[0]
            .accounts
            .truncate(execute_account_count);

        let signed_bytes = message.serialize();
        let signatures = message.account_keys
            [..usize::from(message.header.num_required_signatures)]
            .iter()
            .map(|key| {
                if *key == sponsor {
                    None
                } else {
                    let authority = authorities
                        .iter()
                        .find(|authority| authority.pubkey() == *key)
                        .expect("each required authority must sign the authorization");
                    Some(authority.sign_message(&signed_bytes))
                }
            })
            .collect();
        Authorization {
            message,
            signatures,
        }
    }

    pub fn approve_handover(&self) -> Authorization {
        self.endorse(self.handover(QUANTITY_KG, 0), &[&self.alice, &self.bob])
    }

    pub fn relay(&mut self, submit: Instruction) -> TransactionMetadata {
        self.send_handover(submit).unwrap_or_else(|failure| {
            panic!(
                "relay handover: {:?}\n{}",
                failure.err,
                failure.meta.pretty_logs()
            )
        })
    }

    pub fn assert_refused(
        &mut self,
        label: &str,
        instruction: Instruction,
        error_source: Pubkey,
        error_name: &str,
        error_code: u32,
    ) {
        let batch_before = self.svm.get_account(&self.batch).unwrap();
        let nonce_before = self.nonce_value();
        let result = self.send_handover(instruction);
        assert_eq!(
            self.svm.get_account(&self.batch).unwrap(),
            batch_before,
            "{label} changed the batch"
        );
        assert_eq!(
            self.nonce_value(),
            nonce_before,
            "{label} changed the nonce"
        );
        let failure = result.expect_err(label);
        assert_eq!(
            failure.err,
            TransactionError::InstructionError(0, InstructionError::Custom(error_code)),
            "{label}: {}",
            failure.meta.pretty_logs()
        );
        let expected_log =
            format!("Program {error_source} failed: custom program error: {error_code:#x}");
        assert!(
            failure.meta.logs.contains(&expected_log),
            "{label}: {}",
            failure.meta.pretty_logs()
        );
        if error_source == PROGRAM {
            assert!(
                failure
                    .meta
                    .logs
                    .iter()
                    .any(|line| line.contains(&format!("Error Code: {error_name}."))),
                "{label}: {}",
                failure.meta.pretty_logs()
            );
        }
        println!("D32 {label}: refused ({error_name})");
    }

    fn send_handover(&mut self, instruction: Instruction) -> SendResult {
        if instruction.program_id == PROGRAM {
            return send(
                &mut self.svm,
                &[instruction],
                &[&self.sponsor, &self.alice, &self.bob],
                &[],
            );
        }
        send(
            &mut self.svm,
            &[instruction],
            &[&self.sponsor],
            std::slice::from_ref(&self.relay_table),
        )
    }

    pub fn assert_batch(&self, sequence: u64, handed_over: bool) {
        let expected = [
            discriminator("account:Batch").as_slice(),
            &BATCH_ID,
            self.sender.as_ref(),
            self.receiver.as_ref(),
            &QUANTITY_KG.to_le_bytes(),
            &sequence.to_le_bytes(),
            &[u8::from(handed_over), self.batch_bump],
        ]
        .concat();
        assert_eq!(self.svm.get_account(&self.batch).unwrap().data, expected);
    }

    pub fn party_balances(&self) -> [u64; 2] {
        [self.alice.pubkey(), self.bob.pubkey()].map(|key| self.svm.get_balance(&key).unwrap())
    }

    pub fn sponsor_balance(&self) -> u64 {
        self.svm.get_balance(&self.sponsor.pubkey()).unwrap()
    }

    pub fn warp_past_expiry(&mut self) {
        self.svm.warp_to_slot(self.expiry_slot + 1);
        assert_eq!(self.svm.get_sysvar::<Clock>().slot, self.expiry_slot + 1);
    }
}

pub struct Authorization {
    pub message: v1::Message,
    pub signatures: Vec<Option<Signature>>,
}

impl Authorization {
    pub fn submit(self) -> Instruction {
        let accounts = message_accounts(&self.message, false);
        Instruction::new_with_wincode(
            spl_ed25519_signer_interface::ID,
            &SignerInstruction::Submit {
                message: VersionedMessage::V1(self.message),
                signatures: self.signatures,
            },
            accounts,
        )
    }
}

pub fn ps_address(wallet: &Pubkey) -> Pubkey {
    ProgrammaticSigner::derive_address(&spl_ed25519_signer_interface::ID, wallet)
}

fn party_address(wallet: Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[b"party", wallet.as_ref()], &PROGRAM)
}

fn readonly(key: Pubkey) -> AccountMeta {
    AccountMeta::new_readonly(key, false)
}

fn message_accounts(message: &v1::Message, include_signers: bool) -> Vec<AccountMeta> {
    message
        .account_keys
        .iter()
        .enumerate()
        .map(|(index, &pubkey)| AccountMeta {
            pubkey,
            is_signer: include_signers && message.is_signer(index),
            is_writable: message.is_maybe_writable_with_reserved_addresses(
                index,
                None::<&std::collections::BTreeSet<_>>,
            ),
        })
        .collect()
}

fn discriminator(name: &str) -> [u8; 8] {
    Sha256::digest(name)[..8].try_into().unwrap()
}

fn spike_instruction(name: &str, args: &[&[u8]], accounts: Vec<AccountMeta>) -> Instruction {
    Instruction {
        program_id: PROGRAM,
        accounts,
        data: [
            discriminator(&format!("global:{name}")).as_slice(),
            &args.concat(),
        ]
        .concat(),
    }
}

type SendResult = Result<TransactionMetadata, Box<FailedTransactionMetadata>>;

fn send(
    svm: &mut LiteSVM,
    instructions: &[Instruction],
    signers: &[&Keypair],
    lookup_tables: &[AddressLookupTableAccount],
) -> SendResult {
    // A reused authorization must reach the Executor in a new transaction to test nonce replay.
    svm.expire_blockhash();
    let payer = signers[0].pubkey();
    let blockhash = svm.latest_blockhash();
    let message = if lookup_tables.is_empty() {
        VersionedMessage::Legacy(Message::new_with_blockhash(
            instructions,
            Some(&payer),
            &blockhash,
        ))
    } else {
        VersionedMessage::V0(
            v0::Message::try_compile(&payer, instructions, lookup_tables, blockhash).unwrap(),
        )
    };
    let transaction = VersionedTransaction::try_new(message, signers).unwrap();
    // These transactions use a one-byte compact signature count followed by 64 bytes per signature.
    let packet_size = 1 + 64 * transaction.signatures.len() + transaction.message.serialize().len();
    assert!(
        packet_size <= PACKET_DATA_SIZE,
        "relay packet is {packet_size} bytes"
    );
    svm.send_transaction(transaction).map_err(Box::new)
}

fn send_ok(
    svm: &mut LiteSVM,
    instructions: &[Instruction],
    signers: &[&Keypair],
    label: &str,
) -> TransactionMetadata {
    send(svm, instructions, signers, &[]).unwrap_or_else(|failure| {
        panic!("{label}: {:?}\n{}", failure.err, failure.meta.pretty_logs())
    })
}

fn create_nonce(svm: &mut LiteSVM, sponsor: &Keypair) -> Pubkey {
    let nonce = Keypair::new();
    let address = nonce.pubkey();
    let payer = sponsor.pubkey();
    let create = system_instruction::create_account(
        &payer,
        &address,
        svm.minimum_balance_for_rent_exemption(Nonce::LEN),
        Nonce::LEN as u64,
        &spl_nonce_interface::ID,
    );
    let initialize = Instruction::new_with_wincode(
        spl_nonce_interface::ID,
        &NonceInstruction::Initialize,
        vec![
            AccountMeta::new(address, false),
            readonly(payer),
            readonly(SlotHashes::id()),
        ],
    );
    send_ok(
        svm,
        &[create, initialize],
        &[sponsor, &nonce],
        "create and initialize nonce",
    );
    let account = svm.get_account(&address).unwrap();
    assert_eq!(Nonce::view(&account.data).unwrap().authority, payer);
    address
}

fn create_relay_table(
    svm: &mut LiteSVM,
    sponsor: &Keypair,
    addresses: Vec<Pubkey>,
) -> AddressLookupTableAccount {
    const LOOKUP_PROGRAM: Pubkey = pubkey!("AddressLookupTab1e1111111111111111111111111");
    let payer = sponsor.pubkey();
    let slot = svm.get_sysvar::<Clock>().slot;
    let (key, bump) =
        Pubkey::find_program_address(&[payer.as_ref(), &slot.to_le_bytes()], &LOOKUP_PROGRAM);
    // Native lookup-table bincode ABI: CreateLookupTable = 0, ExtendLookupTable = 2.
    let table_accounts = vec![
        AccountMeta::new(key, false),
        AccountMeta::new_readonly(payer, true),
        AccountMeta::new(payer, true),
        readonly(system_program::ID),
    ];
    let create =
        Instruction::new_with_bincode(LOOKUP_PROGRAM, &(0_u32, slot, bump), table_accounts.clone());
    let extend =
        Instruction::new_with_bincode(LOOKUP_PROGRAM, &(2_u32, &addresses), table_accounts);
    send_ok(
        svm,
        &[create, extend],
        &[sponsor],
        "create relay address lookup table",
    );
    // Extended addresses become available in the slot after the extension.
    svm.warp_to_slot(slot + 1);
    AddressLookupTableAccount { key, addresses }
}

fn load_programmatic_signer(svm: &mut LiteSVM) {
    for (name, id, bytes, sha256) in [
        (
            "ed25519_signer.so",
            spl_ed25519_signer_interface::ID,
            include_bytes!("../fixtures/ed25519_signer.so").as_slice(),
            "4824c901ee53e6658024a6cc89aec92e8d29608f315f835a640e11039637c80b",
        ),
        (
            "message_executor.so",
            spl_message_executor_interface::ID,
            include_bytes!("../fixtures/message_executor.so").as_slice(),
            "276692a010a2f04aa4d540cf8c0f0f74d64d821d72f826f9964782ec2d190344",
        ),
        (
            "nonce.so",
            spl_nonce_interface::ID,
            include_bytes!("../fixtures/nonce.so").as_slice(),
            "095be5b6bcdf10003db710558a765221dd442a3a13aa7d62747d82871f60d3f7",
        ),
    ] {
        assert_eq!(
            format!("{:x}", Sha256::digest(bytes)),
            sha256,
            "{name} SHA-256 mismatch"
        );
        svm.add_program(id, bytes)
            .unwrap_or_else(|error| panic!("load {name} at {id}: {error:?}"));
    }
}
