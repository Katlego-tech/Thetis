use anchor_lang::{prelude::Pubkey, AccountDeserialize, InstructionData, ToAccountMetas};
use ed25519_dalek::{Signer as _, SigningKey};
use intent_spike::{accounts, instruction, message::handover_message, Batch, Party};
use litesvm::{
    types::{FailedTransactionMetadata, TransactionMetadata},
    LiteSVM,
};
use solana_clock::Clock;
use solana_keypair::Keypair;
use solana_message::{Message, VersionedMessage};
use solana_sdk_ids::{ed25519_program, system_program, sysvar};
use solana_signer::Signer;
use solana_transaction::{
    versioned::VersionedTransaction, Instruction, InstructionError, TransactionError,
};

pub const PROGRAM: Pubkey = intent_spike::ID;
pub const QUANTITY_KG: u64 = 2_000_000;
pub const BATCH_ID: [u8; 16] = 0x00112233445566778899aabbccddeeff_u128.to_be_bytes();
pub const LOT_ID: &str = "CR-0001";
pub const FROM: &str = "Kopano Stockyard Custody";
pub const TO: &str = "Mosela Haulage";
pub const VALID_UNTIL: i64 = 1_795_098_725;
pub const NOW: i64 = VALID_UNTIL - 570;
const PACKET_DATA_SIZE: usize = 1232;

pub struct Fixture {
    svm: LiteSVM,
    sponsor: Keypair,
    pub alice: SigningKey,
    pub bob: SigningKey,
    pub mallory: SigningKey,
    batch: Pubkey,
    sender: Pubkey,
    receiver: Pubkey,
    batch_bump: u8,
}

impl Fixture {
    pub fn new() -> Self {
        let mut svm = LiteSVM::new().with_precompiles();
        svm.add_program_from_file(
            PROGRAM,
            concat!(env!("CARGO_TARGET_TMPDIR"), "/../deploy/intent_spike.so"),
        )
        .expect("load intent_spike.so built by anchor build");

        let sponsor = Keypair::new();
        let alice = SigningKey::from_bytes(Keypair::new().secret_bytes());
        let bob = SigningKey::from_bytes(Keypair::new().secret_bytes());
        let mallory = SigningKey::from_bytes(Keypair::new().secret_bytes());
        svm.airdrop(&sponsor.pubkey(), 1_000_000_000).unwrap();
        for wallet in [&alice, &bob] {
            svm.airdrop(&wallet_address(wallet), 1_000_000).unwrap();
        }
        let (sender, _) = party_address(wallet_address(&alice));
        let (receiver, _) = party_address(wallet_address(&bob));
        let (batch, batch_bump) = batch_address(&BATCH_ID);
        let mut fixture = Self {
            svm,
            sponsor,
            alice,
            bob,
            mallory,
            batch,
            sender,
            receiver,
            batch_bump,
        };
        fixture.set_clock(NOW);
        for (wallet, display_name) in [
            (wallet_address(&fixture.alice), FROM),
            (wallet_address(&fixture.bob), TO),
        ] {
            let register = fixture.register_party(wallet, display_name);
            fixture.send_ok(&[register], "register party");
            let (address, bump) = party_address(wallet);
            let account = fixture.svm.get_account(&address).unwrap();
            assert_eq!(account.owner, PROGRAM);
            let party = Party::try_deserialize(&mut account.data.as_slice()).unwrap();
            assert_eq!(party.wallet, wallet);
            assert_eq!(party.display_name, display_name);
            assert_eq!(party.bump, bump);
        }

        let open = fixture.open_batch(BATCH_ID, LOT_ID);
        fixture.send_ok(&[open], "open batch");
        fixture.assert_batch(0, false);
        fixture
    }

    pub fn register_party(&self, wallet: Pubkey, display_name: &str) -> Instruction {
        Instruction {
            program_id: PROGRAM,
            accounts: accounts::RegisterParty {
                payer: self.sponsor.pubkey(),
                party: party_address(wallet).0,
                system_program: system_program::ID,
            }
            .to_account_metas(None),
            data: instruction::RegisterParty {
                wallet,
                display_name: display_name.into(),
            }
            .data(),
        }
    }

    pub fn open_batch(&self, id: [u8; 16], lot_id: &str) -> Instruction {
        Instruction {
            program_id: PROGRAM,
            accounts: accounts::OpenBatch {
                payer: self.sponsor.pubkey(),
                batch: batch_address(&id).0,
                sender: self.sender,
                receiver: self.receiver,
                system_program: system_program::ID,
            }
            .to_account_metas(None),
            data: instruction::OpenBatch {
                id,
                lot_id: lot_id.into(),
                sender_wallet: wallet_address(&self.alice),
                receiver_wallet: wallet_address(&self.bob),
                quantity_kg: QUANTITY_KG,
            }
            .data(),
        }
    }

    pub fn handover(&self, valid_until: i64, expected_sequence: u64) -> Instruction {
        Instruction {
            program_id: PROGRAM,
            accounts: accounts::Handover {
                batch: self.batch,
                sender: self.sender,
                receiver: self.receiver,
                instructions: sysvar::instructions::ID,
            }
            .to_account_metas(None),
            data: instruction::Handover {
                id: BATCH_ID,
                quantity_kg: QUANTITY_KG,
                valid_until,
                expected_sequence,
            }
            .data(),
        }
    }

    pub fn approval(&self, valid_until: i64) -> Instruction {
        let message = handover_message(
            &PROGRAM,
            LOT_ID,
            &BATCH_ID,
            QUANTITY_KG,
            FROM,
            TO,
            0,
            valid_until,
        );
        self.sign_message(&message)
    }

    pub fn sign_message(&self, message: &[u8]) -> Instruction {
        ed25519_instruction(&[&self.alice, &self.bob], message)
    }

    pub fn assert_batch(&self, sequence: u64, handed_over: bool) {
        let account = self.svm.get_account(&self.batch).unwrap();
        assert_eq!(account.owner, PROGRAM);
        let batch = Batch::try_deserialize(&mut account.data.as_slice()).unwrap();
        assert_eq!(batch.id, BATCH_ID);
        assert_eq!(batch.lot_id, LOT_ID);
        assert_eq!(batch.sender, self.sender);
        assert_eq!(batch.receiver, self.receiver);
        assert_eq!(batch.quantity_kg, QUANTITY_KG);
        assert_eq!(batch.sequence, sequence);
        assert_eq!(batch.handed_over, handed_over);
        assert_eq!(batch.bump, self.batch_bump);
    }

    pub fn set_clock(&mut self, unix_timestamp: i64) {
        let mut clock = self.svm.get_sysvar::<Clock>();
        clock.unix_timestamp = unix_timestamp;
        self.svm.set_sysvar(&clock);
    }

    pub fn balances(&self) -> [u64; 3] {
        [
            self.sponsor.pubkey(),
            wallet_address(&self.alice),
            wallet_address(&self.bob),
        ]
        .map(|key| self.svm.get_balance(&key).unwrap())
    }

    pub fn send_honest(&mut self, instructions: &[Instruction]) -> TransactionMetadata {
        let tx = self.signed_transaction(instructions);
        assert_eq!(tx.signatures.len(), 1);
        let size = Instruction::new_with_wincode(PROGRAM, &tx, vec![])
            .data
            .len();
        println!("D32-inhouse honest handover: {size} bytes");
        assert!(size <= PACKET_DATA_SIZE);
        self.svm.send_transaction(tx).unwrap_or_else(|failure| {
            panic!(
                "handover: {:?}\n{}",
                failure.err,
                failure.meta.pretty_logs()
            )
        })
    }

    pub fn assert_program_refused(
        &mut self,
        label: &str,
        instructions: &[Instruction],
        error_name: &str,
        code: u32,
    ) {
        let error = self.refusal(label, instructions);
        let handover_index = u8::try_from(instructions.len() - 1).unwrap();
        assert_eq!(
            error.err,
            TransactionError::InstructionError(handover_index, InstructionError::Custom(code)),
            "{label}: {}",
            error.meta.pretty_logs()
        );
        assert!(
            error
                .meta
                .logs
                .iter()
                .any(|line| line.contains(&format!("Error Code: {error_name}."))),
            "{label}: {}",
            error.meta.pretty_logs()
        );
        println!("D32-inhouse {label}: refused ({error_name})");
    }

    pub fn refusal(
        &mut self,
        label: &str,
        instructions: &[Instruction],
    ) -> Box<FailedTransactionMetadata> {
        let before = self.svm.get_account(&self.batch).unwrap();
        let tx = self.signed_transaction(instructions);
        let result = self.svm.send_transaction(tx);
        assert_eq!(
            self.svm.get_account(&self.batch).unwrap(),
            before,
            "{label} changed the Batch"
        );
        Box::new(result.expect_err(label))
    }

    fn send_ok(&mut self, instructions: &[Instruction], label: &str) {
        let tx = self.signed_transaction(instructions);
        self.svm.send_transaction(tx).unwrap_or_else(|failure| {
            panic!("{label}: {:?}\n{}", failure.err, failure.meta.pretty_logs())
        });
    }

    fn signed_transaction(&mut self, instructions: &[Instruction]) -> VersionedTransaction {
        // Replayed instructions must arrive in a distinct, freshly signed transaction.
        self.svm.expire_blockhash();
        let message = Message::new_with_blockhash(
            instructions,
            Some(&self.sponsor.pubkey()),
            &self.svm.latest_blockhash(),
        );
        VersionedTransaction::try_new(VersionedMessage::Legacy(message), &[&self.sponsor]).unwrap()
    }
}

pub fn wallet_address(key: &SigningKey) -> Pubkey {
    Pubkey::new_from_array(key.verifying_key().to_bytes())
}

fn party_address(wallet: Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[b"party", wallet.as_ref()], &PROGRAM)
}

fn batch_address(id: &[u8; 16]) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[b"batch", id], &PROGRAM)
}

pub fn ed25519_instruction(signers: &[&SigningKey], message: &[u8]) -> Instruction {
    let count = u8::try_from(signers.len()).unwrap();
    let payload_offset = 2 + 14 * u16::from(count);
    let message_offset = payload_offset + 96 * u16::from(count);
    let message_size = u16::try_from(message.len()).unwrap();

    let mut data = vec![count, 0];
    for index in 0..u16::from(count) {
        let key_offset = payload_offset + 96 * index;
        for field in [
            key_offset + 32,
            u16::MAX,
            key_offset,
            u16::MAX,
            message_offset,
            message_size,
            u16::MAX,
        ] {
            data.extend_from_slice(&field.to_le_bytes());
        }
    }
    for key in signers {
        data.extend_from_slice(key.verifying_key().as_bytes());
        data.extend_from_slice(&key.sign(message).to_bytes());
    }
    data.extend_from_slice(message);
    Instruction {
        program_id: ed25519_program::ID,
        accounts: vec![],
        data,
    }
}
