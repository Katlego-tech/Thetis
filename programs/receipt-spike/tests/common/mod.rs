use anchor_lang::{
    prelude::Pubkey,
    solana_program::{
        instruction::{AccountMeta, Instruction},
        system_program,
    },
    AnchorDeserialize,
};
use litesvm::{
    types::{FailedTransactionMetadata, TransactionMetadata},
    LiteSVM,
};
use solana_keypair::Keypair;
use solana_message::{Message, VersionedMessage};
use solana_signer::Signer;
use solana_transaction::versioned::VersionedTransaction;
use spl_associated_token_account_interface::{
    address::get_associated_token_address_with_program_id,
    instruction::create_associated_token_account,
};
use spl_token_2022_interface::{
    error::TokenError,
    extension::{BaseStateWithExtensions, StateWithExtensions, StateWithExtensionsMut},
    state::{Account, AccountState, Mint},
    ID as TOKEN,
};

const ALICE_QUANTITY: u64 = 1_000;
const BOB_QUANTITY: u64 = 100;
const PROGRAM: Pubkey = receipt_spike::ID;
const ATA_PROGRAM: Pubkey = spl_associated_token_account_interface::program::ID;
// Anchor discriminators let these tests drive the agreed ABI against the built program.
const CREATE_MINT: [u8; 8] = [80, 60, 150, 99, 245, 244, 209, 133];
const ISSUE: [u8; 8] = [190, 1, 98, 214, 81, 99, 222, 247];
const MOVE: [u8; 8] = [73, 208, 25, 242, 174, 26, 226, 155];
const POSITION: [u8; 8] = [170, 188, 143, 228, 122, 64, 247, 208];

#[derive(AnchorDeserialize, Debug, PartialEq)]
struct Position {
    owner: Pubkey,
    mint: Pubkey,
    quantity: u64,
    bump: u8,
}

#[derive(Debug, PartialEq)]
struct AccountSnapshot {
    lamports: u64,
    owner: Pubkey,
    data: Vec<u8>,
}

pub struct Holding {
    pub owner: Keypair,
    pub position: Pubkey,
    pub vault_authority: Pubkey,
    pub vault: Pubkey,
    bump: u8,
}

impl Holding {
    pub fn new(mint: Pubkey) -> Self {
        let owner = Keypair::new();
        let (position, bump) = Pubkey::find_program_address(
            &[b"position", mint.as_ref(), owner.pubkey().as_ref()],
            &PROGRAM,
        );
        let (vault_authority, _) =
            Pubkey::find_program_address(&[b"vault", position.as_ref()], &PROGRAM);
        let vault = get_associated_token_address_with_program_id(&vault_authority, &mint, &TOKEN);
        Self {
            owner,
            position,
            vault_authority,
            vault,
            bump,
        }
    }
}

pub struct Fixture {
    svm: LiteSVM,
    issuer: Keypair,
    pub alice: Holding,
    pub bob: Holding,
    pub mallory: Keypair,
    pub mint: Pubkey,
    mint_authority: Pubkey,
    pub personal_ata: Pubkey,
}

impl Fixture {
    pub fn new() -> Self {
        let mut svm = LiteSVM::new();
        svm.add_program_from_file(
            PROGRAM,
            concat!(env!("CARGO_TARGET_TMPDIR"), "/../deploy/receipt_spike.so"),
        )
        .unwrap();
        let issuer = Keypair::new();
        let mint = Keypair::new();
        let (mint_authority, _) =
            Pubkey::find_program_address(&[b"mint_authority", mint.pubkey().as_ref()], &PROGRAM);
        let alice = Holding::new(mint.pubkey());
        let bob = Holding::new(mint.pubkey());
        let mallory = Keypair::new();
        for signer in [&issuer, &alice.owner, &bob.owner, &mallory] {
            svm.airdrop(&signer.pubkey(), 1_000_000_000).unwrap();
        }
        let personal_ata = get_associated_token_address_with_program_id(
            &alice.owner.pubkey(),
            &mint.pubkey(),
            &TOKEN,
        );
        let mut fixture = Self {
            svm,
            issuer,
            alice,
            bob,
            mallory,
            mint: mint.pubkey(),
            mint_authority,
            personal_ata,
        };
        let create = fixture.create_mint(&mint, 0);
        send(&mut fixture.svm, create, &[&fixture.issuer, &mint]).expect("create receipt mint");
        fixture.assert_mint(0);
        for (holding, quantity) in [
            (&fixture.alice, ALICE_QUANTITY),
            (&fixture.bob, BOB_QUANTITY),
        ] {
            let issue = fixture.issue(holding, &fixture.issuer, quantity);
            send(&mut fixture.svm, issue, &[&fixture.issuer]).expect("issue to position");
            fixture.assert_holding(holding, quantity);
        }
        fixture.assert_mint(ALICE_QUANTITY + BOB_QUANTITY);

        let personal_ata = create_associated_token_account(
            &fixture.alice.owner.pubkey(),
            &fixture.alice.owner.pubkey(),
            &fixture.mint,
            &TOKEN,
        );
        send(&mut fixture.svm, personal_ata, &[&fixture.alice.owner]).expect("create Alice's ATA");
        let personal = fixture.token_account(fixture.personal_ata);
        assert_eq!(personal.owner, fixture.alice.owner.pubkey());
        assert_eq!(personal.mint, fixture.mint);
        assert_eq!(personal.amount, 0);
        fixture
    }

    fn issue(&self, holding: &Holding, issuer: &Keypair, quantity: u64) -> Instruction {
        let owner = holding.owner.pubkey();
        receipt_instruction(
            ISSUE,
            &[owner.as_ref(), &quantity.to_le_bytes()],
            vec![
                AccountMeta::new(issuer.pubkey(), true),
                AccountMeta::new(self.mint, false),
                readonly(self.mint_authority),
                AccountMeta::new(holding.position, false),
                readonly(holding.vault_authority),
                AccountMeta::new(holding.vault, false),
                readonly(TOKEN),
                readonly(ATA_PROGRAM),
                readonly(system_program::ID),
            ],
        )
    }

    pub fn move_units(
        &self,
        signer: &Keypair,
        destination: &Holding,
        quantity: u64,
    ) -> Instruction {
        receipt_instruction(
            MOVE,
            &[&quantity.to_le_bytes()],
            vec![
                AccountMeta::new_readonly(signer.pubkey(), true),
                readonly(self.mint),
                AccountMeta::new(self.alice.position, false),
                readonly(self.alice.vault_authority),
                AccountMeta::new(self.alice.vault, false),
                AccountMeta::new(destination.position, false),
                readonly(destination.vault_authority),
                AccountMeta::new(destination.vault, false),
                readonly(TOKEN),
            ],
        )
    }

    pub fn move_as_alice(&mut self, quantity: u64) {
        let ix = self.move_units(&self.alice.owner, &self.bob, quantity);
        send(&mut self.svm, ix, &[&self.alice.owner]).expect("move receipt units");
        self.assert_holding(&self.alice, ALICE_QUANTITY - quantity);
        self.assert_holding(&self.bob, BOB_QUANTITY + quantity);
        self.assert_mint(ALICE_QUANTITY + BOB_QUANTITY);
        assert_eq!(self.token_account(self.personal_ata).amount, 0);
    }

    pub fn refuse_token(
        &mut self,
        label: &str,
        ix: Instruction,
        mallory: bool,
        expected: TokenError,
    ) {
        assert_eq!(ix.program_id, TOKEN);
        let signer = if mallory {
            &self.mallory
        } else {
            &self.alice.owner
        };
        let before = self.snapshot();
        let failure = send_refused(&mut self.svm, ix, signer, label);
        let error = format!("{:?}", failure.err);
        let token_failure = format!("Program {TOKEN} failed:");
        assert_eq!(
            error,
            format!("InstructionError(0, Custom({}))", expected.clone() as u32),
            "{label} returned {error}; logs: {:?}",
            failure.meta.logs
        );
        assert!(
            failure
                .meta
                .logs
                .iter()
                .any(|log| log.starts_with(&token_failure)),
            "{label} did not reach Token-2022: {error}; logs: {:?}",
            failure.meta.logs
        );
        assert_eq!(
            before,
            self.snapshot(),
            "{label} changed receipt state despite {error}"
        );
        println!("A02 {label}: refused ({expected:?}; {error})");
    }

    pub fn refuse_move(&mut self, label: &str, ix: Instruction, mallory: bool, expected_log: &str) {
        let signer = if mallory {
            &self.mallory
        } else {
            &self.alice.owner
        };
        let before = self.snapshot();
        let failure = send_refused(&mut self.svm, ix, signer, label);
        assert_program_log(&failure, label, expected_log);
        assert_eq!(
            before,
            self.snapshot(),
            "{label} changed receipt state despite {:?}",
            failure.err
        );
        println!("A02 {label}: refused ({expected_log}; {:?})", failure.err);
    }

    pub fn refuse_issue(
        &mut self,
        label: &str,
        holding: &Holding,
        quantity: u64,
        unauthorized: bool,
        expected_log: &str,
    ) {
        let signer = if unauthorized {
            &self.mallory
        } else {
            &self.issuer
        };
        let before = self.snapshot();
        let position_before = self.svm.get_account(&holding.position);
        let vault_before = self.svm.get_account(&holding.vault);
        let ix = self.issue(holding, signer, quantity);
        let failure = send_refused(&mut self.svm, ix, signer, label);
        assert_program_log(&failure, label, expected_log);
        assert_eq!(
            before,
            self.snapshot(),
            "{label} changed receipt state despite {:?}",
            failure.err
        );
        assert_eq!(position_before, self.svm.get_account(&holding.position));
        assert_eq!(vault_before, self.svm.get_account(&holding.vault));
    }

    pub fn precreate_and_issue(&mut self, holding: &Holding, quantity: u64) {
        let ix = create_associated_token_account(
            &self.alice.owner.pubkey(),
            &holding.vault_authority,
            &self.mint,
            &TOKEN,
        );
        send(&mut self.svm, ix, &[&self.alice.owner]).expect("pre-create empty vault ATA");
        let ix = self.issue(holding, &self.issuer, quantity);
        send(&mut self.svm, ix, &[&self.issuer]).expect("issue into existing empty vault ATA");
        self.assert_holding(holding, quantity);
        self.assert_mint(ALICE_QUANTITY + BOB_QUANTITY + quantity);
    }

    pub fn freeze_fixture_vault(&mut self) {
        // Set the fixture to frozen so ThawAccount must check the actual authority.
        let mut account = self.svm.get_account(&self.alice.vault).unwrap();
        let mut token = StateWithExtensionsMut::<Account>::unpack(&mut account.data).unwrap();
        token.base.state = AccountState::Frozen;
        token.pack_base();
        self.svm.set_account(self.alice.vault, account).unwrap();
    }

    fn create_mint(&self, mint: &Keypair, decimals: u8) -> Instruction {
        receipt_instruction(
            CREATE_MINT,
            &[&[decimals]],
            vec![
                AccountMeta::new(self.issuer.pubkey(), true),
                AccountMeta::new(mint.pubkey(), true),
                AccountMeta::new(self.mint_authority, false),
                readonly(TOKEN),
                readonly(system_program::ID),
            ],
        )
    }

    fn assert_mint(&self, supply: u64) {
        let account = self.svm.get_account(&self.mint).unwrap();
        assert_eq!(account.owner, TOKEN);
        let mint = StateWithExtensions::<Mint>::unpack(&account.data).unwrap();
        assert!(mint.get_extension_types().unwrap().is_empty());
        assert_eq!(mint.base.decimals, 0);
        assert_eq!(mint.base.mint_authority.unwrap(), self.mint_authority);
        assert_eq!(mint.base.freeze_authority.unwrap(), self.mint_authority);
        assert_eq!(mint.base.supply, supply);
    }

    fn assert_holding(&self, holding: &Holding, quantity: u64) {
        let account = self.svm.get_account(&holding.position).unwrap();
        assert_eq!(account.owner, PROGRAM);
        let body = account
            .data
            .strip_prefix(&POSITION)
            .expect("Position discriminator");
        assert_eq!(
            Position::try_from_slice(body).unwrap(),
            Position {
                owner: holding.owner.pubkey(),
                mint: self.mint,
                quantity,
                bump: holding.bump
            },
        );
        let vault = self.token_account(holding.vault);
        assert_eq!(vault.owner, holding.vault_authority);
        assert_eq!(vault.mint, self.mint);
        assert_eq!(vault.amount, quantity);
        assert!(vault.delegate.is_none());
        assert!(vault.close_authority.is_none());
    }

    fn token_account(&self, address: Pubkey) -> Account {
        let account = self.svm.get_account(&address).unwrap();
        assert_eq!(account.owner, TOKEN);
        StateWithExtensions::<Account>::unpack(&account.data)
            .unwrap()
            .base
    }

    fn snapshot(&self) -> [Option<AccountSnapshot>; 7] {
        // Preserve full account data, including balances, supply, authority, delegate and state.
        [
            self.mint,
            self.mint_authority,
            self.alice.position,
            self.alice.vault,
            self.bob.position,
            self.bob.vault,
            self.personal_ata,
        ]
        .map(|key| {
            self.svm.get_account(&key).map(|account| AccountSnapshot {
                lamports: account.lamports,
                owner: account.owner,
                data: account.data,
            })
        })
    }
}

fn readonly(key: Pubkey) -> AccountMeta {
    AccountMeta::new_readonly(key, false)
}

fn receipt_instruction(
    discriminator: [u8; 8],
    args: &[&[u8]],
    accounts: Vec<AccountMeta>,
) -> Instruction {
    let mut data = discriminator.to_vec();
    for arg in args {
        data.extend_from_slice(arg);
    }
    Instruction {
        program_id: PROGRAM,
        data,
        accounts,
    }
}

fn send(
    svm: &mut LiteSVM,
    ix: Instruction,
    signers: &[&Keypair],
) -> Result<TransactionMetadata, Box<FailedTransactionMetadata>> {
    svm.expire_blockhash();
    let message =
        Message::new_with_blockhash(&[ix], Some(&signers[0].pubkey()), &svm.latest_blockhash());
    let transaction =
        VersionedTransaction::try_new(VersionedMessage::Legacy(message), signers).unwrap();
    svm.send_transaction(transaction).map_err(Box::new)
}

fn send_refused(
    svm: &mut LiteSVM,
    ix: Instruction,
    signer: &Keypair,
    label: &str,
) -> FailedTransactionMetadata {
    match send(svm, ix, &[signer]) {
        Err(failure) => *failure,
        Ok(success) => panic!("{label} unexpectedly succeeded: {:?}", success.logs),
    }
}

fn assert_program_log(failure: &FailedTransactionMetadata, label: &str, expected: &str) {
    assert!(
        failure.meta.logs.iter().any(|line| line.contains(expected)),
        "{label} returned {:?}; logs: {:?}",
        failure.err,
        failure.meta.logs
    );
}
