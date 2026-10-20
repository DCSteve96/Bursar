//! Bursar policy contract.
//!
//! The AI reads the invoice. This contract decides. A dumb executor moves the money.
//!
//! Roles
//! - owner:    the company. Sets vendors, limits, roles. Deposits USDC here.
//! - agent:    a sub-account whose only key is a function-call key limited to `request_payment`.
//! - executor: a non-AI process run by the company that talks to NEAR Intents for cross-chain payouts.
//! - dao:      a Sputnik DAO (Trezu) that approves payments above `approval_threshold`.
//!
//! Money only ever leaves this contract towards:
//! - the vendor's NEAR account recorded by the owner (Paid), or
//! - an Intents deposit address, after the executor proves the recipient equals the vendor's recorded payout (Settled), or
//! - the owner (withdraw).

use near_sdk::json_types::U128;
use near_sdk::serde::{Deserialize, Serialize};
use near_sdk::store::{IterableMap, LookupSet};
use near_sdk::{
    env, ext_contract, log, near, require, AccountId, Gas, NearToken, PanicOnDefault, Promise,
    PromiseError, PromiseOrValue,
};

const USDC_DECIMALS_HINT: &str = "amounts are in the token's smallest unit (USDC: 6 decimals)";
const ONE_YOCTO: NearToken = NearToken::from_yoctonear(1);
const GAS_FT_TRANSFER: Gas = Gas::from_tgas(10);
const GAS_DAO_PROPOSAL: Gas = Gas::from_tgas(30);
const GAS_DAO_VIEW: Gas = Gas::from_tgas(10);
const GAS_CALLBACK: Gas = Gas::from_tgas(10);
const DAY_NS: u64 = 86_400_000_000_000;
const EVENT_STANDARD: &str = "bursar";
const EVENT_VERSION: &str = "1.0.0";

// ---------- types ----------

/// Where a vendor is paid. The owner records this once. The AI never chooses it.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Payout {
    /// A NEAR account that receives USDC (NEP-141) directly.
    Near { account: AccountId },
    /// An address on another chain, paid through NEAR Intents by the executor.
    /// `chain` uses the Intents naming, e.g. "base", "arb", "sol", "eth".
    Chain { chain: String, address: String },
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct Vendor {
    pub name: String,
    pub payout: Payout,
    /// Monthly budget in token units. 0 = no monthly budget.
    pub monthly_budget: u128,
    pub spent_this_month: u128,
    /// Month key as YYYYMM derived from block timestamp.
    pub month: u32,
    pub active: bool,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct Limits {
    pub per_payment_cap: u128,
    pub daily_cap: u128,
    /// Payments at or above this amount need DAO approval.
    pub approval_threshold: u128,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Status {
    /// Paid on NEAR right away.
    Paid,
    /// Approved by policy, waiting for the executor to route it through Intents.
    Queued,
    /// Waiting for the DAO.
    Approval,
    /// Refused by policy. See `reason`.
    Blocked,
    /// USDC sent to the Intents deposit address, waiting for the destination tx.
    Settling,
    /// Delivered on the destination chain.
    Settled,
    /// DAO rejected or owner cancelled.
    Cancelled,
}

/// What the agent claims it read in the invoice. The contract trusts none of it blindly.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct InvoiceClaim {
    pub vendor_id: String,
    pub invoice_number: String,
    pub amount: U128,
    pub due_date: String,
    /// sha256 of the invoice file, hex.
    pub invoice_hash: String,
    /// The payout details printed on the invoice, as the AI read them.
    pub payout_seen: Payout,
    /// Reference to the TEE attestation of the inference that produced this claim.
    pub attestation_ref: String,
    /// Free-text flags raised by the model (urgency, new bank details, mismatched domain...).
    pub flags: Vec<String>,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct Payment {
    pub id: u64,
    pub vendor_id: String,
    pub invoice_number: String,
    pub amount: u128,
    pub status: Status,
    pub reason: Option<String>,
    pub invoice_hash: String,
    pub attestation_ref: String,
    pub flags: Vec<String>,
    pub created_at: u64,
    pub updated_at: u64,
    /// Intents quote id and deposit address once the executor settles it.
    pub quote_id: Option<String>,
    pub deposit_address: Option<String>,
    /// Destination-chain tx hash once delivered.
    pub dest_tx: Option<String>,
    pub dao_proposal_id: Option<u64>,
}

#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct Stats {
    pub balance: U128,
    pub spent_today: U128,
    pub day: u64,
    pub payments: u64,
    pub paused: bool,
}

// ---------- external contracts ----------

#[allow(dead_code)]
#[ext_contract(ext_ft)]
trait FungibleToken {
    fn ft_transfer(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>);
}

#[allow(dead_code)]
#[ext_contract(ext_dao)]
trait SputnikDao {
    fn add_proposal(&mut self, proposal: ProposalInput) -> u64;
    fn get_proposal(&self, id: u64) -> ProposalStatusView;
}

/// The part of Sputnik's `get_proposal` output we care about. Unknown fields are ignored.
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(crate = "near_sdk::serde")]
pub struct ProposalStatusView {
    /// InProgress | Approved | Rejected | Removed | Expired | Moved | Failed
    pub status: String,
}

/// Minimal Sputnik DAO v2 proposal input: a FunctionCall back into this contract.
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(crate = "near_sdk::serde")]
pub struct ProposalInput {
    pub description: String,
    pub kind: ProposalKind,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(crate = "near_sdk::serde")]
pub enum ProposalKind {
    FunctionCall {
        receiver_id: AccountId,
        actions: Vec<ActionCall>,
    },
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(crate = "near_sdk::serde")]
pub struct ActionCall {
    pub method_name: String,
    /// base64 encoded JSON args
    pub args: String,
    pub deposit: U128,
    pub gas: near_sdk::json_types::U64,
}

// ---------- contract ----------

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Bursar {
    owner: AccountId,
    agent: AccountId,
    executor: AccountId,
    dao: Option<AccountId>,
    /// Proposal bond the DAO requires (1 NEAR on the public testnet factory by default).
    dao_bond: NearToken,
    usdc: AccountId,
    limits: Limits,
    vendors: IterableMap<String, Vendor>,
    payments: IterableMap<u64, Payment>,
    invoice_index: LookupSet<String>,
    next_id: u64,
    balance: u128,
    spent_today: u128,
    day: u64,
    paused: bool,
}

#[near]
impl Bursar {
    #[init]
    pub fn new(
        owner: AccountId,
        agent: AccountId,
        executor: AccountId,
        dao: Option<AccountId>,
        usdc: AccountId,
        per_payment_cap: U128,
        daily_cap: U128,
        approval_threshold: U128,
    ) -> Self {
        log!("{}", USDC_DECIMALS_HINT);
        Self {
            owner,
            agent,
            executor,
            dao,
            dao_bond: NearToken::from_near(1),
            usdc,
            limits: Limits {
                per_payment_cap: per_payment_cap.0,
                daily_cap: daily_cap.0,
                approval_threshold: approval_threshold.0,
            },
            vendors: IterableMap::new(b"v"),
            payments: IterableMap::new(b"p"),
            invoice_index: LookupSet::new(b"i"),
            next_id: 1,
            balance: 0,
            spent_today: 0,
            day: 0,
            paused: false,
        }
    }

    // ----- owner -----

    pub fn add_vendor(&mut self, vendor_id: String, name: String, payout: Payout, monthly_budget: U128) {
        self.assert_owner();
        require!(!self.vendors.contains_key(&vendor_id), "vendor exists");
        self.vendors.insert(
            vendor_id.clone(),
            Vendor {
                name,
                payout,
                monthly_budget: monthly_budget.0,
                spent_this_month: 0,
                month: Self::month_key(),
                active: true,
            },
        );
        self.emit("vendor_added", &vendor_id);
    }

    /// Changing a payout is an owner action, never something an invoice can do.
    pub fn update_vendor(&mut self, vendor_id: String, payout: Option<Payout>, monthly_budget: Option<U128>, active: Option<bool>) {
        self.assert_owner();
        let mut v = self.vendors.get(&vendor_id).cloned().expect("unknown vendor");
        if let Some(p) = payout {
            v.payout = p;
        }
        if let Some(b) = monthly_budget {
            v.monthly_budget = b.0;
        }
        if let Some(a) = active {
            v.active = a;
        }
        self.vendors.insert(vendor_id.clone(), v);
        self.emit("vendor_updated", &vendor_id);
    }

    pub fn set_limits(&mut self, per_payment_cap: U128, daily_cap: U128, approval_threshold: U128) {
        self.assert_owner();
        self.limits = Limits {
            per_payment_cap: per_payment_cap.0,
            daily_cap: daily_cap.0,
            approval_threshold: approval_threshold.0,
        };
        self.emit("limits_set", "");
    }

    pub fn set_roles(&mut self, agent: Option<AccountId>, executor: Option<AccountId>, dao: Option<AccountId>, dao_bond: Option<NearToken>) {
        self.assert_owner();
        if let Some(b) = dao_bond {
            self.dao_bond = b;
        }
        if let Some(a) = agent {
            self.agent = a;
        }
        if let Some(e) = executor {
            self.executor = e;
        }
        if dao.is_some() {
            self.dao = dao;
        }
        self.emit("roles_set", "");
    }

    pub fn set_paused(&mut self, paused: bool) {
        self.assert_owner();
        self.paused = paused;
        self.emit(if paused { "paused" } else { "unpaused" }, "");
    }

    pub fn withdraw(&mut self, amount: U128) -> Promise {
        self.assert_owner();
        require!(amount.0 <= self.balance, "insufficient balance");
        self.balance -= amount.0;
        self.emit("withdraw", &amount.0.to_string());
        self.ft_transfer(self.owner.clone(), amount.0, "bursar withdraw".into())
            .then(Self::ext(env::current_account_id()).with_static_gas(GAS_CALLBACK).on_ft_transfer(None, amount))
    }

    pub fn cancel_payment(&mut self, id: u64) {
        self.assert_owner();
        let mut p = self.payments.get(&id).cloned().expect("unknown payment");
        require!(matches!(p.status, Status::Queued | Status::Approval), "cannot cancel in this state");
        self.release_reservation(&p);
        p.status = Status::Cancelled;
        p.updated_at = env::block_timestamp();
        self.payments.insert(id, p);
        self.emit("payment_cancelled", &id.to_string());
    }

    // ----- agent -----

    /// The only method the agent's key can call. Returns the payment id.
    /// The decision is deterministic and fully on chain; the claim is checked, not trusted.
    pub fn request_payment(&mut self, claim: InvoiceClaim) -> u64 {
        require!(env::predecessor_account_id() == self.agent, "only the agent");
        self.roll_day();
        let id = self.next_id;
        self.next_id += 1;
        let now = env::block_timestamp();
        let amount = claim.amount.0;
        let mut p = Payment {
            id,
            vendor_id: claim.vendor_id.clone(),
            invoice_number: claim.invoice_number.clone(),
            amount,
            status: Status::Blocked,
            reason: None,
            invoice_hash: claim.invoice_hash.clone(),
            attestation_ref: claim.attestation_ref.clone(),
            flags: claim.flags.clone(),
            created_at: now,
            updated_at: now,
            quote_id: None,
            deposit_address: None,
            dest_tx: None,
            dao_proposal_id: None,
        };

        match self.decide(&claim) {
            Err(reason) => {
                p.reason = Some(reason.clone());
                self.payments.insert(id, p);
                self.emit("payment_blocked", &format!("{id}:{reason}"));
                id
            }
            Ok(()) => {
                // Reserve budget now so two invoices cannot both pass the same cap.
                self.reserve(&claim.vendor_id, amount);
                let key = Self::invoice_key(&claim.vendor_id, &claim.invoice_number);
                self.invoice_index.insert(key);
                if amount >= self.limits.approval_threshold && self.dao.is_some() {
                    p.status = Status::Approval;
                    self.payments.insert(id, p);
                    self.emit("payment_needs_approval", &id.to_string());
                    self.open_dao_proposal(id, amount, &claim.vendor_id);
                    id
                } else {
                    self.execute(p);
                    id
                }
            }
        }
    }

    // ----- dao -----

    /// Called by the DAO when the council approves the proposal.
    pub fn approve_payment(&mut self, id: u64) {
        let dao = self.dao.clone().expect("no dao");
        require!(env::predecessor_account_id() == dao, "only the dao");
        let p = self.payments.get(&id).cloned().expect("unknown payment");
        require!(p.status == Status::Approval, "not waiting for approval");
        self.emit("payment_approved", &id.to_string());
        self.execute(p);
    }

    /// Callback of `add_proposal`: records the Sputnik proposal id on the payment.
    /// If the DAO refused the proposal (bond missing, DAO misconfigured), the payment is blocked and
    /// its budget reservation released, so the owner can fix the DAO and the agent can resubmit.
    #[private]
    pub fn on_dao_proposal(&mut self, id: u64, #[callback_result] result: Result<u64, PromiseError>) {
        let mut p = self.payments.get(&id).cloned().expect("unknown payment");
        if p.status != Status::Approval {
            return;
        }
        match result {
            Ok(proposal_id) => {
                p.dao_proposal_id = Some(proposal_id);
                p.updated_at = env::block_timestamp();
                self.payments.insert(id, p);
                self.emit("dao_proposal_opened", &format!("{id}:{proposal_id}"));
            }
            Err(_) => {
                self.release_reservation(&p);
                p.status = Status::Blocked;
                p.reason = Some("dao_proposal_failed".into());
                p.updated_at = env::block_timestamp();
                self.payments.insert(id, p);
                self.emit("payment_blocked", &format!("{id}:dao_proposal_failed"));
            }
        }
    }

    /// Sputnik does not call back when a proposal is rejected or expires. Anyone can ask this contract
    /// to read the proposal status from the DAO; if the DAO said no, the payment is cancelled and its
    /// reservation released. Only the DAO's own answer can trigger that, never the caller.
    pub fn sync_dao_proposal(&mut self, id: u64) -> Promise {
        let dao = self.dao.clone().expect("no dao");
        let p = self.payments.get(&id).expect("unknown payment");
        require!(p.status == Status::Approval, "not waiting for approval");
        let proposal_id = p.dao_proposal_id.expect("proposal id not recorded yet");
        ext_dao::ext(dao)
            .with_static_gas(GAS_DAO_VIEW)
            .get_proposal(proposal_id)
            .then(Self::ext(env::current_account_id()).with_static_gas(GAS_CALLBACK).on_dao_status(id))
    }

    #[private]
    pub fn on_dao_status(&mut self, id: u64, #[callback_result] result: Result<ProposalStatusView, PromiseError>) -> String {
        let view = result.expect("dao did not answer");
        let mut p = self.payments.get(&id).cloned().expect("unknown payment");
        if p.status != Status::Approval {
            return view.status;
        }
        if matches!(view.status.as_str(), "Rejected" | "Removed" | "Expired" | "Failed" | "Moved") {
            self.release_reservation(&p);
            p.status = Status::Cancelled;
            p.reason = Some(format!("dao_{}", view.status.to_lowercase()));
            p.updated_at = env::block_timestamp();
            self.payments.insert(id, p);
            self.emit("payment_cancelled", &format!("{id}:dao_{}", view.status.to_lowercase()));
        }
        view.status
    }

    /// Callback of every USDC transfer this contract makes. A failed transfer (vendor not registered on
    /// the token, token paused) puts the money back on the books instead of silently losing track of it.
    #[private]
    pub fn on_ft_transfer(&mut self, id: Option<u64>, amount: U128, #[callback_result] result: Result<(), PromiseError>) -> bool {
        if result.is_ok() {
            return true;
        }
        self.balance += amount.0;
        if let Some(id) = id {
            if let Some(mut p) = self.payments.get(&id).cloned() {
                match p.status {
                    Status::Paid => {
                        self.release_reservation(&p);
                        p.status = Status::Blocked;
                        p.reason = Some("transfer_failed".into());
                    }
                    Status::Settling => {
                        p.status = Status::Queued;
                        p.quote_id = None;
                        p.deposit_address = None;
                    }
                    _ => {}
                }
                p.updated_at = env::block_timestamp();
                self.payments.insert(id, p);
                self.emit("transfer_failed", &id.to_string());
            }
        } else {
            self.emit("transfer_failed", "withdraw");
        }
        false
    }

    // ----- executor -----

    /// The executor got an Intents quote whose recipient it reports here.
    /// Funds move only if that recipient is exactly the vendor's recorded payout.
    pub fn settle(&mut self, id: u64, quote_id: String, deposit_address: AccountId, recipient: Payout) -> Promise {
        require!(env::predecessor_account_id() == self.executor, "only the executor");
        let mut p = self.payments.get(&id).cloned().expect("unknown payment");
        require!(p.status == Status::Queued, "not queued");
        let v = self.vendors.get(&p.vendor_id).expect("unknown vendor");
        require!(v.payout == recipient, "recipient does not match vendor payout");
        require!(matches!(v.payout, Payout::Chain { .. }), "near vendors are paid directly");
        require!(p.amount <= self.balance, "insufficient balance");
        self.balance -= p.amount;
        p.status = Status::Settling;
        p.quote_id = Some(quote_id.clone());
        p.deposit_address = Some(deposit_address.to_string());
        p.updated_at = env::block_timestamp();
        self.payments.insert(id, p.clone());
        self.emit("payment_settling", &format!("{id}:{quote_id}"));
        self.ft_transfer(deposit_address, p.amount, format!("bursar payment {id} invoice {}", p.invoice_number))
            .then(Self::ext(env::current_account_id()).with_static_gas(GAS_CALLBACK).on_ft_transfer(Some(id), U128(p.amount)))
    }

    pub fn mark_settled(&mut self, id: u64, dest_tx: String) {
        require!(env::predecessor_account_id() == self.executor, "only the executor");
        let mut p = self.payments.get(&id).cloned().expect("unknown payment");
        require!(p.status == Status::Settling, "not settling");
        p.status = Status::Settled;
        p.dest_tx = Some(dest_tx);
        p.updated_at = env::block_timestamp();
        self.payments.insert(id, p);
        self.emit("payment_settled", &id.to_string());
    }

    // ----- token deposits (NEP-141 receiver) -----

    /// The company funds the treasury with `ft_transfer_call` on the USDC contract.
    pub fn ft_on_transfer(&mut self, sender_id: AccountId, amount: U128, msg: String) -> PromiseOrValue<U128> {
        require!(env::predecessor_account_id() == self.usdc, "only usdc");
        let _ = msg;
        self.balance += amount.0;
        self.emit("deposit", &format!("{}:{}", sender_id, amount.0));
        PromiseOrValue::Value(U128(0))
    }

    // ----- views -----

    pub fn get_payment(&self, id: u64) -> Option<Payment> {
        self.payments.get(&id).cloned()
    }

    pub fn list_payments(&self, from: Option<u64>, limit: Option<u64>) -> Vec<Payment> {
        let from = from.unwrap_or(0);
        let limit = limit.unwrap_or(50);
        self.payments
            .iter()
            .filter(|(id, _)| **id > from)
            .take(limit as usize)
            .map(|(_, p)| p.clone())
            .collect()
    }

    pub fn get_vendor(&self, vendor_id: String) -> Option<Vendor> {
        self.vendors.get(&vendor_id).cloned()
    }

    pub fn list_vendors(&self) -> Vec<(String, Vendor)> {
        self.vendors.iter().map(|(k, v)| (k.clone(), v.clone())).collect()
    }

    pub fn get_limits(&self) -> Limits {
        self.limits.clone()
    }

    pub fn get_roles(&self) -> (AccountId, AccountId, AccountId, Option<AccountId>, AccountId) {
        (
            self.owner.clone(),
            self.agent.clone(),
            self.executor.clone(),
            self.dao.clone(),
            self.usdc.clone(),
        )
    }

    pub fn get_stats(&self) -> Stats {
        Stats {
            balance: U128(self.balance),
            spent_today: U128(self.spent_today),
            day: self.day,
            payments: self.next_id - 1,
            paused: self.paused,
        }
    }

    /// Dry run of the policy for a claim, without recording anything. Handy for the dashboard and the MCP.
    pub fn check(&self, claim: InvoiceClaim) -> Option<String> {
        self.decide(&claim).err()
    }

    // ----- internals -----

    fn decide(&self, c: &InvoiceClaim) -> Result<(), String> {
        if self.paused {
            return Err("paused".into());
        }
        let v = self.vendors.get(&c.vendor_id).ok_or("unknown_vendor")?;
        if !v.active {
            return Err("vendor_inactive".into());
        }
        if c.payout_seen != v.payout {
            // The classic invoice fraud: same vendor, "new bank details".
            return Err("payout_changed".into());
        }
        if self.invoice_index.contains(&Self::invoice_key(&c.vendor_id, &c.invoice_number)) {
            return Err("duplicate_invoice".into());
        }
        let amount = c.amount.0;
        if amount == 0 {
            return Err("zero_amount".into());
        }
        if amount > self.limits.per_payment_cap {
            return Err("over_payment_cap".into());
        }
        let spent_month = if v.month == Self::month_key() { v.spent_this_month } else { 0 };
        if v.monthly_budget > 0 && spent_month + amount > v.monthly_budget {
            return Err("over_monthly_budget".into());
        }
        let spent_today = if self.day == Self::day_key() { self.spent_today } else { 0 };
        if self.limits.daily_cap > 0 && spent_today + amount > self.limits.daily_cap {
            return Err("over_daily_cap".into());
        }
        if amount > self.balance {
            return Err("insufficient_treasury".into());
        }
        Ok(())
    }

    fn execute(&mut self, mut p: Payment) {
        let v = self.vendors.get(&p.vendor_id).cloned().expect("unknown vendor");
        p.updated_at = env::block_timestamp();
        match v.payout {
            Payout::Near { account } => {
                require!(p.amount <= self.balance, "insufficient balance");
                self.balance -= p.amount;
                p.status = Status::Paid;
                let id = p.id;
                let memo = format!("bursar payment {id} invoice {}", p.invoice_number);
                self.payments.insert(id, p.clone());
                self.emit("payment_paid", &id.to_string());
                let _ = self
                    .ft_transfer(account, p.amount, memo)
                    .then(Self::ext(env::current_account_id()).with_static_gas(GAS_CALLBACK).on_ft_transfer(Some(id), U128(p.amount)));
            }
            Payout::Chain { .. } => {
                p.status = Status::Queued;
                let id = p.id;
                self.payments.insert(id, p);
                self.emit("payment_queued", &id.to_string());
            }
        }
    }

    fn open_dao_proposal(&mut self, id: u64, amount: u128, vendor_id: &str) {
        let dao = self.dao.clone().unwrap();
        let args = near_sdk::base64::Engine::encode(
            &near_sdk::base64::prelude::BASE64_STANDARD,
            format!("{{\"id\":{id}}}"),
        );
        let proposal = ProposalInput {
            description: format!("Bursar payment #{id}: {amount} to vendor {vendor_id} (above approval threshold)"),
            kind: ProposalKind::FunctionCall {
                receiver_id: env::current_account_id(),
                actions: vec![ActionCall {
                    method_name: "approve_payment".into(),
                    args,
                    deposit: U128(0),
                    gas: near_sdk::json_types::U64(Gas::from_tgas(50).as_gas()),
                }],
            },
        };
        // Sputnik requires the proposal bond as attached deposit. The owner keeps this contract topped up with NEAR for it.
        let _ = ext_dao::ext(dao)
            .with_attached_deposit(self.dao_bond)
            .with_static_gas(GAS_DAO_PROPOSAL)
            .add_proposal(proposal)
            .then(Self::ext(env::current_account_id()).with_static_gas(GAS_CALLBACK).on_dao_proposal(id));
    }

    fn reserve(&mut self, vendor_id: &str, amount: u128) {
        let mut v = self.vendors.get(vendor_id).cloned().unwrap();
        if v.month != Self::month_key() {
            v.month = Self::month_key();
            v.spent_this_month = 0;
        }
        v.spent_this_month += amount;
        self.vendors.insert(vendor_id.to_string(), v);
        self.spent_today += amount;
    }

    /// Undo what `reserve` did for a payment that will not happen: monthly budget, daily cap, duplicate index.
    fn release_reservation(&mut self, p: &Payment) {
        if let Some(mut v) = self.vendors.get(&p.vendor_id).cloned() {
            if v.month == Self::month_key() {
                v.spent_this_month = v.spent_this_month.saturating_sub(p.amount);
                self.vendors.insert(p.vendor_id.clone(), v);
            }
        }
        if self.day == Self::day_key() {
            self.spent_today = self.spent_today.saturating_sub(p.amount);
        }
        self.invoice_index.remove(&Self::invoice_key(&p.vendor_id, &p.invoice_number));
    }

    fn ft_transfer(&self, to: AccountId, amount: u128, memo: String) -> Promise {
        ext_ft::ext(self.usdc.clone())
            .with_attached_deposit(ONE_YOCTO)
            .with_static_gas(GAS_FT_TRANSFER)
            .ft_transfer(to, U128(amount), Some(memo))
    }

    fn roll_day(&mut self) {
        let d = Self::day_key();
        if self.day != d {
            self.day = d;
            self.spent_today = 0;
        }
    }

    fn day_key() -> u64 {
        env::block_timestamp() / DAY_NS
    }

    /// YYYYMM from the block timestamp (civil calendar, UTC).
    fn month_key() -> u32 {
        let days = (env::block_timestamp() / DAY_NS) as i64;
        // Howard Hinnant's civil_from_days
        let z = days + 719_468;
        let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
        let doe = z - era * 146_097;
        let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
        let y = yoe + era * 400;
        let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
        let mp = (5 * doy + 2) / 153;
        let m = if mp < 10 { mp + 3 } else { mp - 9 };
        let y = if m <= 2 { y + 1 } else { y };
        (y as u32) * 100 + m as u32
    }

    fn invoice_key(vendor_id: &str, invoice_number: &str) -> String {
        format!("{}|{}", vendor_id.to_lowercase(), invoice_number.trim().to_lowercase())
    }

    fn assert_owner(&self) {
        require!(env::predecessor_account_id() == self.owner, "only the owner");
    }

    fn emit(&self, event: &str, data: &str) {
        log!(
            "EVENT_JSON:{{\"standard\":\"{}\",\"version\":\"{}\",\"event\":\"{}\",\"data\":\"{}\"}}",
            EVENT_STANDARD,
            EVENT_VERSION,
            event,
            data
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::{accounts, VMContextBuilder};
    use near_sdk::testing_env;

    fn ctx(pred: AccountId) -> VMContextBuilder {
        let mut b = VMContextBuilder::new();
        b.predecessor_account_id(pred).block_timestamp(1_760_000_000_000_000_000);
        b
    }

    fn setup() -> Bursar {
        testing_env!(ctx(accounts(0)).build());
        let mut c = Bursar::new(
            accounts(0),
            accounts(1),
            accounts(2),
            Some(accounts(3)),
            accounts(4),
            U128(5_000_000_000),
            U128(20_000_000_000),
            U128(2_000_000_000),
        );
        c.add_vendor(
            "hosting".into(),
            "Acme Hosting".into(),
            Payout::Near { account: accounts(5) },
            U128(10_000_000_000),
        );
        c.add_vendor(
            "design".into(),
            "DesignCo".into(),
            Payout::Chain { chain: "base".into(), address: "0xabc".into() },
            U128(0),
        );
        // fund
        testing_env!(ctx(accounts(4)).build());
        let _ = c.ft_on_transfer(accounts(0), U128(50_000_000_000), "".into());
        c
    }

    fn claim(vendor: &str, number: &str, amount: u128, payout: Payout) -> InvoiceClaim {
        InvoiceClaim {
            vendor_id: vendor.into(),
            invoice_number: number.into(),
            amount: U128(amount),
            due_date: "2026-11-30".into(),
            invoice_hash: "deadbeef".into(),
            payout_seen: payout,
            attestation_ref: "att:1".into(),
            flags: vec![],
        }
    }

    #[test]
    fn pays_near_vendor_under_threshold() {
        let mut c = setup();
        testing_env!(ctx(accounts(1)).build());
        let id = c.request_payment(claim("hosting", "0923", 480_000_000, Payout::Near { account: accounts(5) }));
        let p = c.get_payment(id).unwrap();
        assert_eq!(p.status, Status::Paid);
        assert_eq!(c.get_stats().balance.0, 50_000_000_000 - 480_000_000);
    }

    #[test]
    fn queues_cross_chain_vendor() {
        let mut c = setup();
        testing_env!(ctx(accounts(1)).build());
        let id = c.request_payment(claim("design", "1107", 1_250_000_000, Payout::Chain { chain: "base".into(), address: "0xabc".into() }));
        assert_eq!(c.get_payment(id).unwrap().status, Status::Queued);
    }

    #[test]
    fn blocks_changed_payout() {
        let mut c = setup();
        testing_env!(ctx(accounts(1)).build());
        let id = c.request_payment(claim("hosting", "0924", 480_000_000, Payout::Near { account: accounts(2) }));
        let p = c.get_payment(id).unwrap();
        assert_eq!(p.status, Status::Blocked);
        assert_eq!(p.reason.as_deref(), Some("payout_changed"));
    }

    #[test]
    fn blocks_duplicate_and_caps() {
        let mut c = setup();
        testing_env!(ctx(accounts(1)).build());
        let ok = claim("hosting", "0923", 480_000_000, Payout::Near { account: accounts(5) });
        c.request_payment(ok.clone());
        let dup = c.request_payment(ok);
        assert_eq!(c.get_payment(dup).unwrap().reason.as_deref(), Some("duplicate_invoice"));
        let big = c.request_payment(claim("hosting", "0999", 6_000_000_000, Payout::Near { account: accounts(5) }));
        assert_eq!(c.get_payment(big).unwrap().reason.as_deref(), Some("over_payment_cap"));
        let unknown = c.request_payment(claim("nobody", "1", 1, Payout::Near { account: accounts(5) }));
        assert_eq!(c.get_payment(unknown).unwrap().reason.as_deref(), Some("unknown_vendor"));
    }

    #[test]
    fn needs_approval_above_threshold_then_dao_approves() {
        let mut c = setup();
        testing_env!(ctx(accounts(1)).build());
        let id = c.request_payment(claim("hosting", "2210", 3_000_000_000, Payout::Near { account: accounts(5) }));
        assert_eq!(c.get_payment(id).unwrap().status, Status::Approval);
        testing_env!(ctx(accounts(3)).build());
        c.approve_payment(id);
        assert_eq!(c.get_payment(id).unwrap().status, Status::Paid);
    }

    #[test]
    fn executor_cannot_redirect_funds() {
        let mut c = setup();
        testing_env!(ctx(accounts(1)).build());
        let id = c.request_payment(claim("design", "1107", 1_250_000_000, Payout::Chain { chain: "base".into(), address: "0xabc".into() }));
        testing_env!(ctx(accounts(2)).build());
        let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _ = c.settle(id, "q1".into(), accounts(5), Payout::Chain { chain: "base".into(), address: "0xevil".into() });
        }));
        assert!(r.is_err());
    }

    fn as_self() -> VMContextBuilder {
        let mut b = VMContextBuilder::new();
        b.current_account_id(accounts(0)).predecessor_account_id(accounts(0)).block_timestamp(1_760_000_000_000_000_000);
        b
    }

    fn approval_payment(c: &mut Bursar) -> u64 {
        testing_env!(ctx(accounts(1)).build());
        let id = c.request_payment(claim("hosting", "2210", 3_000_000_000, Payout::Near { account: accounts(5) }));
        assert_eq!(c.get_payment(id).unwrap().status, Status::Approval);
        id
    }

    #[test]
    fn dao_proposal_id_is_recorded_by_callback() {
        let mut c = setup();
        let id = approval_payment(&mut c);
        assert_eq!(c.get_payment(id).unwrap().dao_proposal_id, None);
        testing_env!(as_self().build());
        c.on_dao_proposal(id, Ok(7));
        let p = c.get_payment(id).unwrap();
        assert_eq!(p.dao_proposal_id, Some(7));
        assert_eq!(p.status, Status::Approval);
    }

    #[test]
    fn failed_dao_proposal_blocks_and_releases_budget() {
        let mut c = setup();
        let id = approval_payment(&mut c);
        testing_env!(as_self().build());
        c.on_dao_proposal(id, Err(PromiseError::Failed));
        let p = c.get_payment(id).unwrap();
        assert_eq!(p.status, Status::Blocked);
        assert_eq!(p.reason.as_deref(), Some("dao_proposal_failed"));
        assert_eq!(c.get_vendor("hosting".into()).unwrap().spent_this_month, 0);
        // the same invoice can be submitted again once the DAO is fixed
        testing_env!(ctx(accounts(1)).build());
        let again = c.request_payment(claim("hosting", "2210", 3_000_000_000, Payout::Near { account: accounts(5) }));
        assert_eq!(c.get_payment(again).unwrap().status, Status::Approval);
    }

    #[test]
    fn dao_rejection_cancels_payment() {
        let mut c = setup();
        let id = approval_payment(&mut c);
        testing_env!(as_self().build());
        c.on_dao_proposal(id, Ok(3));
        // still in progress: nothing changes
        c.on_dao_status(id, Ok(ProposalStatusView { status: "InProgress".into() }));
        assert_eq!(c.get_payment(id).unwrap().status, Status::Approval);
        c.on_dao_status(id, Ok(ProposalStatusView { status: "Rejected".into() }));
        let p = c.get_payment(id).unwrap();
        assert_eq!(p.status, Status::Cancelled);
        assert_eq!(p.reason.as_deref(), Some("dao_rejected"));
        assert_eq!(c.get_vendor("hosting".into()).unwrap().spent_this_month, 0);
        // a later DAO approval cannot pay a cancelled payment
        testing_env!(ctx(accounts(3)).build());
        let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| c.approve_payment(id)));
        assert!(r.is_err());
    }

    #[test]
    fn failed_transfer_restores_balance() {
        let mut c = setup();
        testing_env!(ctx(accounts(1)).build());
        let id = c.request_payment(claim("hosting", "0923", 480_000_000, Payout::Near { account: accounts(5) }));
        assert_eq!(c.get_stats().balance.0, 50_000_000_000 - 480_000_000);
        testing_env!(as_self().build());
        assert!(!c.on_ft_transfer(Some(id), U128(480_000_000), Err(PromiseError::Failed)));
        let p = c.get_payment(id).unwrap();
        assert_eq!(p.status, Status::Blocked);
        assert_eq!(p.reason.as_deref(), Some("transfer_failed"));
        assert_eq!(c.get_stats().balance.0, 50_000_000_000);
        assert_eq!(c.get_stats().spent_today.0, 0);
        assert_eq!(c.get_vendor("hosting".into()).unwrap().spent_this_month, 0);
    }

    #[test]
    fn only_agent_can_request() {
        let mut c = setup();
        testing_env!(ctx(accounts(0)).build());
        let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            c.request_payment(claim("hosting", "1", 1, Payout::Near { account: accounts(5) }));
        }));
        assert!(r.is_err());
    }
}
