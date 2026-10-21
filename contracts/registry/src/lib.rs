//! Bursar registry: a public list of policy contracts (treasuries) and who owns them.
//!
//! Anyone can register a treasury for a fee that covers the storage. Entries are hints, not
//! proof: the explorer and the sign-in page read `get_roles` on each treasury and drop entries
//! whose owner does not match. An entry can only be changed by the account that registered it
//! or by the owner it names.
use near_sdk::store::IterableMap;
use near_sdk::{env, ext_contract, near, AccountId, Gas, NearToken, PanicOnDefault, Promise, PromiseError};

// With `panic = "abort"` the SDK's panic path reaches the chain as a bare trap; this import keeps the message.
#[cfg(target_arch = "wasm32")]
mod host {
    #[link(wasm_import_module = "env")]
    unsafe extern "C" {
        pub fn panic_utf8(len: u64, ptr: u64);
    }
}
#[cfg(target_arch = "wasm32")]
#[inline(never)]
pub(crate) fn fail(msg: &str) -> ! {
    unsafe { host::panic_utf8(msg.len() as u64, msg.as_ptr() as u64) };
    loop {}
}
#[cfg(not(target_arch = "wasm32"))]
pub(crate) fn fail(msg: &str) -> ! {
    env::panic_str(msg)
}
macro_rules! require {
    ($cond:expr, $msg:expr $(,)?) => {
        if !$cond {
            let m: &str = &$msg;
            crate::fail(m)
        }
    };
}

/// What a registration costs: storage for the entry, with a margin. Returned to nobody.
const FEE: NearToken = NearToken::from_millinear(10);
/// Per owner, the treasuries registered under it (raw storage `b"o"` + owner): `of` reads this instead of scanning.
const OWNER_PREFIX: &[u8] = b"o";
const GAS_VIEW: Gas = Gas::from_tgas(10);
const GAS_CALLBACK: Gas = Gas::from_tgas(10);

#[allow(dead_code)]
#[ext_contract(ext_treasury)]
trait Treasury {
    fn get_roles(&self) -> (AccountId, AccountId, AccountId, Option<AccountId>, AccountId);
}

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
        self.put(treasury, Entry { owner, registrant, registered_at: env::block_timestamp_ms() });
    }

    /// The treasury's real owner takes the entry over, whoever registered it: the registry asks the treasury
    /// contract who its owner is and only its answer decides. Costs `FEE` when the entry is new.
    #[payable]
    pub fn claim(&mut self, treasury: AccountId) -> Promise {
        if !self.entries.contains_key(&treasury) {
            require!(env::attached_deposit() >= FEE, "attach 0.01 NEAR for the storage");
        }
        ext_treasury::ext(treasury.clone())
            .with_static_gas(GAS_VIEW)
            .get_roles()
            .then(Self::ext(env::current_account_id()).with_static_gas(GAS_CALLBACK).on_claim(treasury, env::predecessor_account_id()))
    }

    #[private]
    pub fn on_claim(&mut self, treasury: AccountId, claimant: AccountId, #[callback_result] roles: Result<(AccountId, AccountId, AccountId, Option<AccountId>, AccountId), PromiseError>) -> bool {
        let owner = match roles { Ok(r) => r.0, Err(_) => crate::fail("the treasury did not answer get_roles") };
        require!(owner == claimant, "the treasury contract names another owner");
        let registrant = self.entries.get(&treasury).map(|e| e.registrant.clone()).unwrap_or(claimant.clone());
        self.put(treasury, Entry { owner, registrant, registered_at: env::block_timestamp_ms() });
        true
    }

    fn put(&mut self, treasury: AccountId, entry: Entry) {
        if let Some(old) = self.entries.get(&treasury) {
            if old.owner != entry.owner {
                self.index_remove(&old.owner, &treasury);
            }
        }
        self.index_add(&entry.owner, &treasury);
        self.entries.insert(treasury, entry);
    }

    fn index_key(owner: &AccountId) -> Vec<u8> {
        [OWNER_PREFIX, owner.as_bytes()].concat()
    }

    fn index_get(&self, owner: &AccountId) -> Option<Vec<AccountId>> {
        env::storage_read(&Self::index_key(owner)).and_then(|b| near_sdk::borsh::from_slice(&b).ok())
    }

    fn index_add(&self, owner: &AccountId, treasury: &AccountId) {
        let mut list = self.index_get(owner).unwrap_or_default();
        if !list.contains(treasury) {
            list.push(treasury.clone());
        }
        env::storage_write(&Self::index_key(owner), &near_sdk::borsh::to_vec(&list).unwrap());
    }

    fn index_remove(&self, owner: &AccountId, treasury: &AccountId) {
        let list: Vec<AccountId> = self.index_get(owner).unwrap_or_default().into_iter().filter(|t| t != treasury).collect();
        env::storage_write(&Self::index_key(owner), &near_sdk::borsh::to_vec(&list).unwrap());
    }

    /// Build the per-owner index for entries registered before it existed, a page at a time. Anyone may call it.
    pub fn reindex(&mut self, from: Option<u32>, limit: Option<u32>) -> u32 {
        let page: Vec<(AccountId, AccountId)> = self.entries.iter().skip(from.unwrap_or(0) as usize).take(limit.unwrap_or(50).min(100) as usize).map(|(k, e)| (e.owner.clone(), k.clone())).collect();
        for (owner, treasury) in &page {
            self.index_add(owner, treasury);
        }
        page.len() as u32
    }

    /// Remove an entry: the registrant or the owner.
    pub fn unregister(&mut self, treasury: AccountId) {
        let who = env::predecessor_account_id();
        let e = self.entries.get(&treasury).cloned().unwrap_or_else(|| crate::fail("not registered"));
        require!(who == e.registrant || who == e.owner, "only the registrant or the owner can remove an entry");
        self.index_remove(&e.owner, &treasury);
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
            .take(limit.unwrap_or(100).min(100) as usize)
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect()
    }

    pub fn get(&self, treasury: AccountId) -> Option<Entry> {
        self.entries.get(&treasury).cloned()
    }

    /// The treasuries an account owns, as registered. Verify against each treasury's `get_roles`.
    pub fn of(&self, owner: AccountId) -> Vec<AccountId> {
        // from the index; a registry from before the index falls back to the scan until `reindex` has run
        match self.index_get(&owner) {
            Some(list) => list.into_iter().filter(|t| self.entries.get(t).map_or(false, |e| e.owner == owner)).collect(),
            None => self.entries.iter().filter(|(_, e)| e.owner == owner).map(|(k, _)| k.clone()).collect(),
        }
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
    fn index_follows_owner_changes_and_the_real_owner_can_claim() {
        let mut r = Registry::new();
        ctx(accounts(0), FEE);
        r.register("treasury.a.testnet".parse().unwrap(), accounts(1));
        ctx(accounts(1), NearToken::from_yoctonear(0));
        r.register("treasury.a.testnet".parse().unwrap(), accounts(2));
        assert!(r.of(accounts(1)).is_empty());
        assert_eq!(r.of(accounts(2)).len(), 1);
        // a squatter registered a treasury under itself; the treasury says accounts(3) owns it
        ctx(accounts(5), FEE);
        r.register("treasury.b.testnet".parse().unwrap(), accounts(5));
        testing_env!(VMContextBuilder::new().current_account_id(accounts(0)).predecessor_account_id(accounts(0)).build());
        assert!(r.on_claim("treasury.b.testnet".parse().unwrap(), accounts(3), Ok((accounts(3), accounts(1), accounts(2), None, accounts(4)))));
        assert_eq!(r.get("treasury.b.testnet".parse().unwrap()).unwrap().owner, accounts(3));
        assert_eq!(r.of(accounts(3)).len(), 1);
        assert!(r.of(accounts(5)).is_empty());
        let res = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| r.on_claim("treasury.b.testnet".parse().unwrap(), accounts(5), Ok((accounts(3), accounts(1), accounts(2), None, accounts(4))))));
        assert!(res.is_err(), "the treasury names another owner");
        ctx(accounts(3), NearToken::from_yoctonear(0));
        r.unregister("treasury.b.testnet".parse().unwrap());
        assert!(r.of(accounts(3)).is_empty());
        assert_eq!(r.list(None, Some(1000)).len(), 1, "limit capped");
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
