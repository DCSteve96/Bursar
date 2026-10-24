//! A stepping stone, not part of Bursar: a tiny contract a key-less treasury can be upgraded to through Bursar's own
//! `upgrade`, so that a build whose `upgrade` kept too little gas back can still be replaced. It touches no storage:
//! `migrate` does nothing, `redeploy` lets the hard-coded owner deploy the real code and run its `migrate`.
use near_sdk::json_types::Base64VecU8;
use near_sdk::{env, near, require, Gas, NearToken, PanicOnDefault, Promise};

const OWNER: &str = env!("STONE_OWNER");

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Stone {}

#[near]
impl Stone {
    /// Called by the previous build's `upgrade` right after the deploy. Nothing to do: the state stays as Bursar left it.
    pub fn migrate() {}

    /// Deploy the real code and run its `migrate` with a fixed, ample gas.
    pub fn redeploy(code: Base64VecU8) -> Promise {
        require!(env::predecessor_account_id().as_str() == OWNER, "owner only");
        require!(code.0.len() > 1024, "that is not a contract");
        Promise::new(env::current_account_id())
            .deploy_contract(code.0)
            .function_call(String::from("migrate"), Vec::new(), NearToken::from_yoctonear(0), Gas::from_tgas(150))
    }
}
