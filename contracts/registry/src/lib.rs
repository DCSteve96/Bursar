//! Bursar registry: a public list of policy contracts (treasuries) and who owns them.
//!
//! Anyone can register a treasury for a fee that covers the storage. Entries are hints, not
//! proof: the explorer and the sign-in page read `get_roles` on each treasury and drop entries
//! whose owner does not match. An entry can only be changed by the account that registered it
//! or by the owner it names.
use near_sdk::store::IterableMap;
use near_sdk::{env, near, require, AccountId, NearToken, PanicOnDefault};

/// What a registration costs: storage for the entry, with a margin. Returned to nobody.
const FEE: NearToken = NearToken::from_millinear(10);

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct Entry {
    pub owner: AccountId,
    /// Who paid for the entry: the treasury's owner, or the account that created the treasury.
    pub registrant: AccountId,
    /// Milliseconds since the epoch.
    pub registered_at: u64,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Registry {
    entries: IterableMap<AccountId, Entry>,
}

#[near]
impl Registry {
    #[init]
    pub fn new() -> Self {
        Self { entries: IterableMap::new(b"e") }
    }

    /// Register a treasury, or update its owner. Costs `FEE` the first time.
    #[payable]
    pub fn register(&mut self, treasury: AccountId, owner: AccountId) {
        let who = env::predecessor_account_id();
        if let Some(e) = self.entries.get(&treasury) {
            require!(who == e.registrant || who == e.owner, "only the registrant or the owner can change an entry");
        } else {
            require!(env::attached_deposit() >= FEE, "attach 0.01 NEAR for the storage");
        }
        let registrant = self.entries.get(&treasury).map(|e| e.registrant.clone()).unwrap_or(who);
        self.entries.insert(treasury, Entry { owner, registrant, registered_at: env::block_timestamp_ms() });
    }

    /// Remove an entry: the registrant or the owner.
    pub fn unregister(&mut self, treasury: AccountId) {
        let who = env::predecessor_account_id();
        let e = self.entries.get(&treasury).expect("not registered");
        require!(who == e.registrant || who == e.owner, "only the registrant or the owner can remove an entry");
        self.entries.remove(&treasury);
    }

    pub fn count(&self) -> u32 {
        self.entries.len()
    }

    /// Entries in registration order, paged.
    pub fn list(&self, from: Option<u32>, limit: Option<u32>) -> Vec<(AccountId, Entry)> {
        self.entries
            .iter()
            .skip(from.unwrap_or(0) as usize)
            .take(limit.unwrap_or(100) as usize)
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect()
    }

    pub fn get(&self, treasury: AccountId) -> Option<Entry> {
        self.entries.get(&treasury).cloned()
    }

    /// The treasuries an account owns, as registered. Verify against each treasury's `get_roles`.
    pub fn of(&self, owner: AccountId) -> Vec<AccountId> {
        self.entries.iter().filter(|(_, e)| e.owner == owner).map(|(k, _)| k.clone()).collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::{accounts, VMContextBuilder};
    use near_sdk::testing_env;

    fn ctx(who: AccountId, deposit: NearToken) {
        testing_env!(VMContextBuilder::new().predecessor_account_id(who).attached_deposit(deposit).build());
    }

    #[test]
    fn register_list_of() {
        let mut r = Registry::new();
        ctx(accounts(0), FEE);
        r.register("treasury.a.testnet".parse().unwrap(), accounts(1));
        ctx(accounts(2), FEE);
        r.register("treasury.b.testnet".parse().unwrap(), accounts(2));
        assert_eq!(r.count(), 2);
        assert_eq!(r.of(accounts(1)), vec!["treasury.a.testnet".parse::<AccountId>().unwrap()]);
        assert_eq!(r.list(Some(1), None).len(), 1);
        assert_eq!(r.get("treasury.a.testnet".parse().unwrap()).unwrap().registrant, accounts(0));
    }

    #[test]
    #[should_panic(expected = "attach 0.01 NEAR")]
    fn needs_fee() {
        let mut r = Registry::new();
        ctx(accounts(0), NearToken::from_yoctonear(0));
        r.register("treasury.a.testnet".parse().unwrap(), accounts(1));
    }

    #[test]
    #[should_panic(expected = "only the registrant or the owner")]
    fn no_hijack() {
        let mut r = Registry::new();
        ctx(accounts(0), FEE);
        r.register("treasury.a.testnet".parse().unwrap(), accounts(1));
        ctx(accounts(3), FEE);
        r.register("treasury.a.testnet".parse().unwrap(), accounts(3));
    }

    #[test]
    fn owner_can_update_and_remove() {
        let mut r = Registry::new();
        ctx(accounts(0), FEE);
        r.register("treasury.a.testnet".parse().unwrap(), accounts(1));
        ctx(accounts(1), NearToken::from_yoctonear(0));
        r.register("treasury.a.testnet".parse().unwrap(), accounts(4));
        assert_eq!(r.get("treasury.a.testnet".parse().unwrap()).unwrap().owner, accounts(4));
        ctx(accounts(0), NearToken::from_yoctonear(0));
        r.unregister("treasury.a.testnet".parse().unwrap());
        assert_eq!(r.count(), 0);
    }
}
