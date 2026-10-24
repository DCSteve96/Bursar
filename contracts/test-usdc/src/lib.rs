//! tUSDC: a NEP-141 token with 6 decimals and an open `mint`, for testnet demos only.
use near_contract_standards::fungible_token::metadata::{FungibleTokenMetadata, FungibleTokenMetadataProvider, FT_METADATA_SPEC};
use near_contract_standards::fungible_token::FungibleToken;
use near_sdk::json_types::U128;
use near_contract_standards::storage_management::{StorageBalance, StorageBalanceBounds, StorageManagement};
use near_sdk::{env, near, AccountId, NearToken, PanicOnDefault, PromiseOrValue};

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Contract {
    token: FungibleToken,
}

#[near]
impl Contract {
    #[init]
    pub fn new() -> Self {
        let mut token = FungibleToken::new(b"t".to_vec());
        token.internal_register_account(&env::predecessor_account_id());
        Self { token }
    }

    /// Open faucet: mints `amount` (6 decimals) to `to`; a new account needs the storage deposit attached (0.00125 NEAR).
    #[payable]
    pub fn mint(&mut self, to: AccountId, amount: U128) {
        // a faucet, not a money printer: one call mints at most a million tUSDC and the supply stays far from u128::MAX
        assert!(amount.0 <= 1_000_000_000_000, "at most 1,000,000 tUSDC per call");
        assert!(self.token.total_supply.saturating_add(amount.0) <= 1_000_000_000_000_000_000, "supply cap reached");
        if !self.token.accounts.contains_key(&to) {
            // whoever registers a new account pays its storage (0.00125 NEAR), not the token: a loop of mints to
            // junk accounts cannot write the token out of its stake; the excess deposit is refunded
            self.token.storage_deposit(Some(to.clone()), Some(true));
        }
        self.token.internal_deposit(&to, amount.0);
        near_contract_standards::fungible_token::events::FtMint { owner_id: &to, amount: amount, memo: Some("faucet") }.emit();
    }

    pub fn storage_cost(&self) -> NearToken {
        env::storage_byte_cost().saturating_mul(125)
    }
}

near_contract_standards::impl_fungible_token_core!(Contract, token);

#[near]
impl StorageManagement for Contract {
    #[payable]
    fn storage_deposit(&mut self, account_id: Option<AccountId>, registration_only: Option<bool>) -> StorageBalance {
        self.token.storage_deposit(account_id, registration_only)
    }
    #[payable]
    fn storage_withdraw(&mut self, amount: Option<NearToken>) -> StorageBalance {
        self.token.storage_withdraw(amount)
    }
    #[payable]
    fn storage_unregister(&mut self, force: Option<bool>) -> bool {
        self.token.storage_unregister(force)
    }
    fn storage_balance_bounds(&self) -> StorageBalanceBounds {
        self.token.storage_balance_bounds()
    }
    fn storage_balance_of(&self, account_id: AccountId) -> Option<StorageBalance> {
        self.token.storage_balance_of(account_id)
    }
}

#[near]
impl FungibleTokenMetadataProvider for Contract {
    fn ft_metadata(&self) -> FungibleTokenMetadata {
        FungibleTokenMetadata {
            spec: FT_METADATA_SPEC.to_string(),
            name: "Test USDC (Bursar demo)".to_string(),
            symbol: "tUSDC".to_string(),
            icon: None,
            reference: None,
            reference_hash: None,
            decimals: 6,
        }
    }
}
