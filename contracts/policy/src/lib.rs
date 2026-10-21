//! Bursar policy contract.
//!
//! The AI reads the invoice. This contract decides. A dumb executor moves the money.
//!
//! Roles
//! - owner:    the company. Sets vendors, limits, roles. Deposits USDC here.
//! - agent:    a sub-account whose only key is a function-call key limited to `request_payment`.
//! - executor: a non-AI process run by the company that talks to NEAR Intents for cross-chain payouts.
//! - dao:      a Sputnik DAO (Trezu) that approves payments above `approval_threshold`.
//! - operators: accounts the owner trusts with a subset of its powers (approve, manage vendors, manage orders).
//!
//! Orders are what the company agreed to buy, recorded before the invoice arrives: a purchase order with a
//! total, or a standing order (one invoice per period, up to an amount). An invoice that matches no order is
//! never paid on the AI's word alone: it waits for a human. So do invoices the model flagged.
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
/// Raw storage key of the owner's encrypted vault (see `set_vault`).
const VAULT_KEY: &[u8] = b"vault";
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

impl Payout {
    /// Case-insensitive equality for chain addresses: EVM addresses carry an optional checksum in their
    /// letter case, and an invoice may print the same address in a different case than the owner recorded.
    /// NEAR account ids are already lowercase by construction.
    pub fn same_as(&self, other: &Payout) -> bool {
        match (self, other) {
            (Payout::Near { account: a }, Payout::Near { account: b }) => a == b,
            (Payout::Chain { chain: c1, address: a1 }, Payout::Chain { chain: c2, address: a2 }) => {
                c1.eq_ignore_ascii_case(c2) && a1.trim().eq_ignore_ascii_case(a2.trim())
            }
            _ => false,
        }
    }
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
    /// What the vendor prints on its invoices to identify itself: a VAT number, an EIN, a CNPJ, or a supplier
    /// code the company assigned. Compared after normalization. None = not checked.
    #[serde(default)]
    pub tax_id: Option<String>,
    /// ISO country code of the vendor, informational: it tells the company's accountant which rules apply.
    #[serde(default)]
    pub country: Option<String>,
    /// Withholding the company must keep back when paying this vendor, in basis points of the invoice total
    /// (2000 = 20%). Set by the company's accountant; Bursar applies it and never decides it. 0 = none.
    #[serde(default)]
    pub withholding_bps: u32,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct Limits {
    pub per_payment_cap: u128,
    pub daily_cap: u128,
    /// Payments at or above this amount need a human: the DAO council, or the owner / an approver when there is no DAO.
    pub approval_threshold: u128,
    /// When true, every invoice needs a matching order or a human. When false, only vendors that have
    /// active orders are held to them.
    pub require_orders: bool,
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
    /// The vendor's tax id as printed on the invoice, empty if none.
    #[serde(default)]
    pub vendor_tax_id: String,
    /// The buyer's tax id as printed on the invoice, empty if none.
    #[serde(default)]
    pub buyer_tax_id: String,
    /// Withholding tax the invoice itself shows as deducted (ritenuta d'acconto, TDS, retencion), 0 if none.
    #[serde(default)]
    pub withholding_seen: U128,
    /// Purchase order or reference printed on the invoice, if any.
    #[serde(default)]
    pub order_ref: Option<String>,
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
    /// The order this payment consumed, if any.
    pub order_id: Option<u64>,
    /// Part of `amount` kept back in the treasury as withholding tax, owed to the state; the vendor gets the rest.
    #[serde(default)]
    pub withheld: u128,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct Company {
    pub name: String,
    pub description: String,
    /// ISO country code of the company, informational.
    #[serde(default)]
    pub country: Option<String>,
    /// The company's own tax id. When set, an invoice must be addressed to it or it waits for a person.
    #[serde(default)]
    pub tax_id: Option<String>,
}

/// What an operator may do. The owner keeps everything else (limits, roles, withdraw, pause).
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, Default)]
pub struct Role {
    pub approve: bool,
    pub manage_vendors: bool,
    pub manage_orders: bool,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum OrderKind {
    /// A purchase order: invoices referencing it consume `remaining`.
    Single { remaining: u128 },
    /// A standing order: at most one invoice per period, up to `amount_per_period`.
    /// Periods of 28 to 31 days follow the calendar month; others are counted from the epoch.
    Recurring { amount_per_period: u128, period_days: u32, last_period: Option<u64> },
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct Order {
    pub id: u64,
    pub vendor_id: String,
    /// The reference the invoice is expected to print (purchase order number). Empty for standing orders.
    pub reference: String,
    pub description: String,
    pub kind: OrderKind,
    /// Block timestamp after which the order no longer covers invoices. 0 = never.
    pub expires_at: u64,
    pub active: bool,
    pub created_at: u64,
}

#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct Stats {
    pub balance: U128,
    pub spent_today: U128,
    pub day: u64,
    pub payments: u64,
    pub paused: bool,
    /// Withholding kept back and not yet remitted to the state, in token units.
    #[serde(default)]
    pub withheld_due: U128,
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
    orders: IterableMap<u64, Order>,
    operators: IterableMap<AccountId, Role>,
    company: Option<Company>,
    next_order_id: u64,
    next_id: u64,
    balance: u128,
    spent_today: u128,
    day: u64,
    paused: bool,
    /// Withholding kept in the treasury for the state, not yet remitted (see `mark_withholding_remitted`).
    withheld_due: u128,
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
                require_orders: false,
            },
            vendors: IterableMap::new(b"v"),
            payments: IterableMap::new(b"p"),
            invoice_index: LookupSet::new(b"i"),
            orders: IterableMap::new(b"o"),
            operators: IterableMap::new(b"r"),
            company: None,
            next_order_id: 1,
            next_id: 1,
            balance: 0,
            spent_today: 0,
            day: 0,
            paused: false,
            withheld_due: 0,
        }
    }

    // ----- owner -----

    pub fn add_vendor(&mut self, vendor_id: String, name: String, payout: Payout, monthly_budget: U128, tax_id: Option<String>, country: Option<String>, withholding_bps: Option<u32>) {
        self.assert_can(|r| r.manage_vendors, "manage vendors");
        require!(!self.vendors.contains_key(&vendor_id), "vendor exists");
        let withholding_bps = withholding_bps.unwrap_or(0);
        require!(withholding_bps <= 5000, "withholding above 50%");
        self.vendors.insert(
            vendor_id.clone(),
            Vendor {
                name,
                payout,
                monthly_budget: monthly_budget.0,
                spent_this_month: 0,
                month: Self::month_key(),
                active: true,
                tax_id: tax_id.filter(|t| !Self::norm_id(t).is_empty()),
                country: country.filter(|c| !c.trim().is_empty()).map(|c| c.trim().to_ascii_uppercase()),
                withholding_bps,
            },
        );
        self.emit("vendor_added", &vendor_id);
    }

    /// Changing a payout is an owner action, never something an invoice can do.
    pub fn update_vendor(&mut self, vendor_id: String, payout: Option<Payout>, monthly_budget: Option<U128>, active: Option<bool>, tax_id: Option<String>, country: Option<String>, withholding_bps: Option<u32>) {
        self.assert_can(|r| r.manage_vendors, "manage vendors");
        let mut v = self.vendors.get(&vendor_id).cloned().expect("unknown vendor");
        if let Some(c) = country {
            v.country = if c.trim().is_empty() { None } else { Some(c.trim().to_ascii_uppercase()) };
        }
        if let Some(w) = withholding_bps {
            require!(w <= 5000, "withholding above 50%");
            v.withholding_bps = w;
        }
        if let Some(p) = payout {
            v.payout = p;
        }
        if let Some(t) = tax_id {
            // an empty string clears the check
            v.tax_id = if Self::norm_id(&t).is_empty() { None } else { Some(t) };
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
            require_orders: self.limits.require_orders,
        };
        self.emit("limits_set", "");
    }

    /// Strict mode: every invoice needs a matching order, or a human. Off by default: then only vendors
    /// with active orders are held to them.
    pub fn set_order_policy(&mut self, require_orders: bool) {
        self.assert_owner();
        self.limits.require_orders = require_orders;
        self.emit("order_policy_set", if require_orders { "required" } else { "per_vendor" });
    }

    pub fn set_company(&mut self, name: String, description: String, country: Option<String>, tax_id: Option<String>) {
        self.assert_owner();
        self.company = Some(Company { name: name.clone(), description, country, tax_id: tax_id.filter(|t| !Self::norm_id(t).is_empty()) });
        self.emit("company_set", &name);
    }

    /// Hand the treasury to another account. Used when a payer account bootstraps a treasury for a
    /// wallet owner, and to move a company to new keys.
    pub fn transfer_ownership(&mut self, new_owner: AccountId) {
        self.assert_owner();
        self.owner = new_owner.clone();
        self.emit("owner_changed", new_owner.as_str());
    }

    // ----- operators: the owner delegates parts of its power, on chain, revocably -----

    pub fn add_operator(&mut self, account: AccountId, role: Role) {
        self.assert_owner();
        require!(account != self.owner, "the owner is not an operator");
        self.operators.insert(account.clone(), role);
        self.emit("operator_added", account.as_str());
    }

    pub fn remove_operator(&mut self, account: AccountId) {
        self.assert_owner();
        require!(self.operators.remove(&account).is_some(), "unknown operator");
        self.emit("operator_removed", account.as_str());
    }

    // ----- orders: what the company agreed to buy, before the invoice -----

    /// A purchase order with a total. Invoices that print `reference` consume it.
    pub fn add_order(&mut self, vendor_id: String, reference: String, description: String, amount: U128, expires_at: Option<u64>) -> u64 {
        self.assert_can(|r| r.manage_orders, "manage orders");
        require!(self.vendors.contains_key(&vendor_id), "unknown vendor");
        require!(!reference.trim().is_empty(), "a purchase order needs a reference");
        require!(amount.0 > 0, "zero amount");
        self.insert_order(vendor_id, reference, description, OrderKind::Single { remaining: amount.0 }, expires_at.unwrap_or(0))
    }

    /// A standing order: one invoice per period, up to `amount_per_period`. Matched by vendor, no reference needed.
    pub fn add_recurring_order(&mut self, vendor_id: String, description: String, amount_per_period: U128, period_days: u32, expires_at: Option<u64>) -> u64 {
        self.assert_can(|r| r.manage_orders, "manage orders");
        require!(self.vendors.contains_key(&vendor_id), "unknown vendor");
        require!(amount_per_period.0 > 0 && period_days > 0, "zero amount or period");
        let kind = OrderKind::Recurring { amount_per_period: amount_per_period.0, period_days, last_period: None };
        self.insert_order(vendor_id, String::new(), description, kind, expires_at.unwrap_or(0))
    }

    pub fn close_order(&mut self, id: u64) {
        self.assert_can(|r| r.manage_orders, "manage orders");
        let mut o = self.orders.get(&id).cloned().expect("unknown order");
        o.active = false;
        self.orders.insert(id, o);
        self.emit("order_closed", &id.to_string());
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

    /// The company paid the withheld tax to the state (off chain, from a `withdraw`): clear that much of the debt.
    pub fn mark_withholding_remitted(&mut self, amount: U128) {
        self.assert_owner();
        require!(amount.0 <= self.withheld_due, "more than is due");
        self.withheld_due -= amount.0;
        self.emit("withholding_remitted", &amount.0.to_string());
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
        self.assert_can(|r| r.approve, "approve");
        let mut p = self.payments.get(&id).cloned().expect("unknown payment");
        require!(matches!(p.status, Status::Queued | Status::Approval), "cannot cancel in this state");
        self.release_reservation(&p);
        p.status = Status::Cancelled;
        p.updated_at = env::block_timestamp();
        self.payments.insert(id, p);
        self.emit("payment_cancelled", &id.to_string());
    }

    // ----- agent -----

    /// The only method the agent's key can call. The owner and the operators may call it too: a person
    /// in the console asks the same question the agent asks, and the contract decides the same way.
    /// Returns the payment id. The decision is deterministic and fully on chain; the claim is checked, not trusted.
    pub fn request_payment(&mut self, claim: InvoiceClaim) -> u64 {
        let caller = env::predecessor_account_id();
        require!(
            caller == self.agent || caller == self.owner || self.operators.contains_key(&caller),
            "only the agent, the owner or an operator"
        );
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
            order_id: None,
            withheld: 0,
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
                // What the company agreed to buy: consume the matching order, or note that there is none.
                let (order_id, covered) = self.consume_order(&claim);
                p.order_id = order_id;
                // A human decides when: the amount is above the threshold; no order covers the invoice
                // (always in strict mode, otherwise only for vendors that have orders); the model raised flags.
                // The AI can add scrutiny through its flags, never remove it.
                let mut holds: Vec<&str> = Vec::new();
                if amount >= self.limits.approval_threshold {
                    holds.push("over_threshold");
                }
                if !covered && (self.limits.require_orders || self.vendor_has_orders(&claim.vendor_id)) {
                    holds.push("no_order");
                }
                if !claim.flags.is_empty() {
                    holds.push("flagged");
                }
                // Identity, when the owner recorded it: the vendor's tax id on the invoice must be the registered one,
                // and the invoice must be addressed to this company. A misread id must not refuse a real invoice, so
                // both are holds for a person, not blocks.
                if let Some(t) = self.vendors.get(&claim.vendor_id).and_then(|v| v.tax_id.as_ref()) {
                    if Self::norm_id(&claim.vendor_tax_id) != Self::norm_id(t) {
                        holds.push("identity_mismatch");
                    }
                }
                if let Some(t) = self.company.as_ref().and_then(|c| c.tax_id.as_ref()) {
                    if Self::norm_id(&claim.buyer_tax_id) != Self::norm_id(t) {
                        holds.push("buyer_mismatch");
                    }
                }
                // Withholding, as the company's accountant set it on the vendor: the treasury keeps that share back
                // for the state and pays the rest. An invoice that shows a different withholding, or shows one the
                // company did not configure, waits for a person.
                let bps = self.vendors.get(&claim.vendor_id).map(|v| v.withholding_bps).unwrap_or(0) as u128;
                let expected = amount * bps / 10_000;
                let seen = claim.withholding_seen.0;
                if bps > 0 {
                    p.withheld = expected;
                    if seen > 0 && seen.abs_diff(expected) > amount / 100 {
                        holds.push("withholding_mismatch");
                    }
                } else if seen > 0 {
                    holds.push("withholding_mismatch");
                }
                if !holds.is_empty() {
                    let reason = holds.join("+");
                    p.status = Status::Approval;
                    p.reason = Some(reason.clone());
                    self.payments.insert(id, p);
                    self.emit("payment_needs_approval", &format!("{id}:{reason}"));
                    if self.dao.is_some() {
                        self.open_dao_proposal(id, amount, &claim.vendor_id, &reason);
                    }
                    id
                } else {
                    self.execute(p);
                    id
                }
            }
        }
    }

    // ----- dao -----

    /// Called by the DAO when the council approves the proposal, or by the owner or an approver when there is no DAO.
    pub fn approve_payment(&mut self, id: u64) {
        match &self.dao {
            Some(dao) => require!(env::predecessor_account_id() == *dao, "only the dao"),
            None => self.assert_can(|r| r.approve, "approve"),
        }
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
                self.withheld_due = self.withheld_due.saturating_sub(p.withheld);
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
        require!(v.payout.same_as(&recipient), "recipient does not match vendor payout");
        require!(matches!(v.payout, Payout::Chain { .. }), "near vendors are paid directly");
        let net = p.amount - p.withheld;
        require!(net <= self.balance, "insufficient balance");
        self.balance -= net;
        self.withheld_due += p.withheld;
        p.status = Status::Settling;
        p.quote_id = Some(quote_id.clone());
        p.deposit_address = Some(deposit_address.to_string());
        p.updated_at = env::block_timestamp();
        self.payments.insert(id, p.clone());
        self.emit("payment_settling", &format!("{id}:{quote_id}"));
        self.ft_transfer(deposit_address, net, format!("bursar payment {id} invoice {}", p.invoice_number))
            .then(Self::ext(env::current_account_id()).with_static_gas(GAS_CALLBACK).on_ft_transfer(Some(id), U128(net)))
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

    pub fn get_company(&self) -> Option<Company> {
        self.company.clone()
    }

    pub fn list_operators(&self) -> Vec<(AccountId, Role)> {
        self.operators.iter().map(|(k, v)| (k.clone(), v.clone())).collect()
    }

    pub fn get_order(&self, id: u64) -> Option<Order> {
        self.orders.get(&id).cloned()
    }

    pub fn list_orders(&self, vendor_id: Option<String>) -> Vec<Order> {
        self.orders
            .iter()
            .filter(|(_, o)| vendor_id.as_ref().map_or(true, |v| &o.vendor_id == v))
            .map(|(_, o)| o.clone())
            .collect()
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
            withheld_due: U128(self.withheld_due),
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
        if !c.payout_seen.same_as(&v.payout) {
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
                // the withheld share stays in the treasury, earmarked for the state; the vendor gets the net
                let net = p.amount - p.withheld;
                require!(net <= self.balance, "insufficient balance");
                self.balance -= net;
                self.withheld_due += p.withheld;
                p.status = Status::Paid;
                let id = p.id;
                let memo = format!("bursar payment {id} invoice {}", p.invoice_number);
                self.payments.insert(id, p.clone());
                self.emit("payment_paid", &id.to_string());
                let _ = self
                    .ft_transfer(account, net, memo)
                    .then(Self::ext(env::current_account_id()).with_static_gas(GAS_CALLBACK).on_ft_transfer(Some(id), U128(net)));
            }
            Payout::Chain { .. } => {
                p.status = Status::Queued;
                let id = p.id;
                self.payments.insert(id, p);
                self.emit("payment_queued", &id.to_string());
            }
        }
    }

    fn open_dao_proposal(&mut self, id: u64, amount: u128, vendor_id: &str, reason: &str) {
        let dao = self.dao.clone().unwrap();
        let args = near_sdk::base64::Engine::encode(
            &near_sdk::base64::prelude::BASE64_STANDARD,
            format!("{{\"id\":{id}}}"),
        );
        let proposal = ProposalInput {
            description: format!("Bursar payment #{id}: {amount} to vendor {vendor_id} ({reason})"),
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
        if let Some(oid) = p.order_id {
            if let Some(mut o) = self.orders.get(&oid).cloned() {
                match &mut o.kind {
                    OrderKind::Single { remaining } => *remaining += p.amount,
                    OrderKind::Recurring { last_period, period_days, .. } => {
                        if *last_period == Some(Self::period_key(*period_days)) {
                            *last_period = None;
                        }
                    }
                }
                self.orders.insert(oid, o);
            }
        }
    }

    fn insert_order(&mut self, vendor_id: String, reference: String, description: String, kind: OrderKind, expires_at: u64) -> u64 {
        let id = self.next_order_id;
        self.next_order_id += 1;
        self.orders.insert(id, Order { id, vendor_id, reference: reference.trim().to_string(), description, kind, expires_at, active: true, created_at: env::block_timestamp() });
        self.emit("order_added", &id.to_string());
        id
    }

    fn order_is_open(o: &Order) -> bool {
        o.active && (o.expires_at == 0 || env::block_timestamp() <= o.expires_at)
    }

    fn vendor_has_orders(&self, vendor_id: &str) -> bool {
        self.orders.iter().any(|(_, o)| o.vendor_id == vendor_id && Self::order_is_open(o))
    }

    /// Find the order this claim fits and consume it. A purchase order is matched by the reference printed on
    /// the invoice; a standing order by vendor, once per period. Returns the order id and whether one covered it.
    fn consume_order(&mut self, c: &InvoiceClaim) -> (Option<u64>, bool) {
        let amount = c.amount.0;
        let reference = c.order_ref.as_deref().map(|r| r.trim().to_lowercase()).unwrap_or_default();
        let candidates: Vec<Order> = self
            .orders
            .iter()
            .filter(|(_, o)| o.vendor_id == c.vendor_id && Self::order_is_open(o))
            .map(|(_, o)| o.clone())
            .collect();
        if !reference.is_empty() {
            for mut o in candidates.iter().cloned() {
                if let OrderKind::Single { remaining } = &mut o.kind {
                    if o.reference.to_lowercase() == reference && *remaining >= amount {
                        *remaining -= amount;
                        let id = o.id;
                        self.orders.insert(id, o);
                        return (Some(id), true);
                    }
                }
            }
        }
        for mut o in candidates.into_iter() {
            if let OrderKind::Recurring { amount_per_period, period_days, last_period } = &mut o.kind {
                let period = Self::period_key(*period_days);
                if *amount_per_period >= amount && *last_period != Some(period) {
                    *last_period = Some(period);
                    let id = o.id;
                    self.orders.insert(id, o);
                    return (Some(id), true);
                }
            }
        }
        (None, false)
    }

    /// Calendar month for monthly orders, epoch-aligned periods otherwise.
    fn period_key(period_days: u32) -> u64 {
        if (28..=31).contains(&period_days) {
            Self::month_key() as u64
        } else {
            env::block_timestamp() / (DAY_NS * period_days as u64)
        }
    }

    /// The owner can do everything; an operator only what its role allows.
    fn assert_can(&self, allowed: fn(&Role) -> bool, what: &str) {
        let caller = env::predecessor_account_id();
        if caller == self.owner {
            return;
        }
        match self.operators.get(&caller) {
            Some(role) if allowed(role) => {}
            _ => env::panic_str(&format!("only the owner or an operator allowed to {what}")),
        }
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

    /// Tax ids compared as uppercase letters and digits only: "IT 01234567890" equals "it01234567890".
    fn norm_id(s: &str) -> String {
        s.chars().filter(|c| c.is_ascii_alphanumeric()).map(|c| c.to_ascii_uppercase()).collect()
    }

    fn invoice_key(vendor_id: &str, invoice_number: &str) -> String {
        format!("{}|{}", vendor_id.to_lowercase(), invoice_number.trim().to_lowercase())
    }

    // ----- vault: the owner's secrets, encrypted in the browser, kept here so any browser can get them back -----

    /// Store an opaque blob for the owner (the console keeps its secrets here, encrypted with a key only the
    /// owner's wallet can derive). The contract never reads it. Raw storage, outside the state struct, so a
    /// contract deployed before this method existed can be upgraded without a migration.
    pub fn set_vault(&mut self, blob: String) {
        self.assert_owner();
        require!(blob.len() <= 16_384, "vault blob too large (16 KB max)");
        if blob.is_empty() {
            env::storage_remove(VAULT_KEY);
        } else {
            env::storage_write(VAULT_KEY, blob.as_bytes());
        }
    }

    pub fn get_vault(&self) -> Option<String> {
        env::storage_read(VAULT_KEY).map(|b| String::from_utf8(b).unwrap_or_default())
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
            None,
            None,
            None,
        );
        c.add_vendor(
            "design".into(),
            "DesignCo".into(),
            Payout::Chain { chain: "base".into(), address: "0xabc".into() },
            U128(0),
            None,
            None,
            None,
        );
        // fund
        testing_env!(ctx(accounts(4)).build());
        let _ = c.ft_on_transfer(accounts(0), U128(50_000_000_000), "".into());
        c
    }

    fn claim(vendor: &str, number: &str, amount: u128, payout: Payout) -> InvoiceClaim {
        InvoiceClaim {
            order_ref: None,
            vendor_tax_id: String::new(),
            buyer_tax_id: String::new(),
            withholding_seen: U128(0),
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
    fn chain_address_case_does_not_matter() {
        let mut c = setup();
        testing_env!(ctx(accounts(1)).build());
        let id = c.request_payment(claim("design", "1108", 100_000_000, Payout::Chain { chain: "Base".into(), address: "0xABC".into() }));
        assert_eq!(c.get_payment(id).unwrap().status, Status::Queued);
        let other = c.request_payment(claim("design", "1109", 100_000_000, Payout::Chain { chain: "base".into(), address: "0xabd".into() }));
        assert_eq!(c.get_payment(other).unwrap().reason.as_deref(), Some("payout_changed"));
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
    fn without_a_dao_the_owner_approves_above_threshold() {
        testing_env!(ctx(accounts(0)).build());
        let mut c = Bursar::new(accounts(0), accounts(1), accounts(2), None, accounts(4), U128(5_000_000_000), U128(20_000_000_000), U128(2_000_000_000));
        c.add_vendor("hosting".into(), "Acme Hosting".into(), Payout::Near { account: accounts(5) }, U128(10_000_000_000), None, None, None);
        testing_env!(ctx(accounts(4)).build());
        let _ = c.ft_on_transfer(accounts(0), U128(15_000_000_000), "".into());
        testing_env!(ctx(accounts(1)).build());
        let id = c.request_payment(claim("hosting", "2210", 3_000_000_000, Payout::Near { account: accounts(5) }));
        assert_eq!(c.get_payment(id).unwrap().status, Status::Approval);
        assert_eq!(c.get_payment(id).unwrap().dao_proposal_id, None);
        // the agent cannot approve its own request
        let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| c.approve_payment(id)));
        assert!(r.is_err());
        testing_env!(ctx(accounts(0)).build());
        c.approve_payment(id);
        assert_eq!(c.get_payment(id).unwrap().status, Status::Paid);
    }

    #[test]
    fn identity_on_the_invoice_is_checked_when_recorded() {
        let mut c = setup();
        testing_env!(ctx(accounts(0)).build());
        c.update_vendor("hosting".into(), None, None, None, Some("PT 123 456 789".into()), None, None);
        c.set_company("Northwind".into(), "".into(), Some("IT".into()), Some("IT01234567890".into()));
        testing_env!(ctx(accounts(1)).build());
        // right ids in any formatting: paid
        let mut ok = claim("hosting", "A-1", 100_000_000, Payout::Near { account: accounts(5) });
        ok.vendor_tax_id = "pt123456789".into();
        ok.buyer_tax_id = "IT 0123 4567 890".into();
        let id = c.request_payment(ok);
        assert_eq!(c.get_payment(id).unwrap().status, Status::Paid);
        // another company's id on the invoice: held, not blocked
        let mut other = claim("hosting", "A-2", 100_000_000, Payout::Near { account: accounts(5) });
        other.vendor_tax_id = "DE999".into();
        other.buyer_tax_id = "IT01234567890".into();
        let id = c.request_payment(other);
        let p = c.get_payment(id).unwrap();
        assert_eq!(p.status, Status::Approval);
        assert_eq!(p.reason.as_deref(), Some("identity_mismatch"));
        // not addressed to us: held
        let mut wrong_buyer = claim("hosting", "A-3", 100_000_000, Payout::Near { account: accounts(5) });
        wrong_buyer.vendor_tax_id = "PT123456789".into();
        let id = c.request_payment(wrong_buyer);
        assert_eq!(c.get_payment(id).unwrap().reason.as_deref(), Some("buyer_mismatch"));
        // a vendor without a recorded id is not checked
        let id = c.request_payment({ let mut x = claim("design", "D-1", 100_000_000, Payout::Chain { chain: "base".into(), address: "0xabc".into() }); x.buyer_tax_id = "IT01234567890".into(); x });
        assert_eq!(c.get_payment(id).unwrap().status, Status::Queued);
    }

    #[test]
    fn withholding_set_by_the_accountant_is_kept_back_for_the_state() {
        let mut c = setup();
        testing_env!(ctx(accounts(0)).build());
        c.add_vendor("consultant".into(), "Studio Bianchi".into(), Payout::Near { account: accounts(5) }, U128(0), None, Some("it".into()), Some(2000));
        assert_eq!(c.get_vendor("consultant".into()).unwrap().country.as_deref(), Some("IT"));
        testing_env!(ctx(accounts(1)).build());
        // the invoice shows the 20% withholding: paid net, the share stays in the treasury as a debt to the state
        let mut inv = claim("consultant", "C-1", 1_000_000_000, Payout::Near { account: accounts(5) });
        inv.withholding_seen = U128(200_000_000);
        let before = c.get_stats().balance.0;
        let id = c.request_payment(inv);
        let p = c.get_payment(id).unwrap();
        assert_eq!(p.status, Status::Paid);
        assert_eq!(p.withheld, 200_000_000);
        assert_eq!(before - c.get_stats().balance.0, 800_000_000, "only the net leaves");
        assert_eq!(c.get_stats().withheld_due.0, 200_000_000);
        assert_eq!(c.get_vendor("consultant".into()).unwrap().spent_this_month, 1_000_000_000, "budgets count the gross");
        // the invoice shows another withholding than the accountant set: held
        let mut odd = claim("consultant", "C-2", 1_000_000_000, Payout::Near { account: accounts(5) });
        odd.withholding_seen = U128(100_000_000);
        let id = c.request_payment(odd);
        assert_eq!(c.get_payment(id).unwrap().reason.as_deref(), Some("withholding_mismatch"));
        // an invoice that shows a withholding for a vendor with none configured: held too
        let mut unexpected = claim("hosting", "H-9", 1_000_000_000, Payout::Near { account: accounts(5) });
        unexpected.withholding_seen = U128(200_000_000);
        let id = c.request_payment(unexpected);
        assert_eq!(c.get_payment(id).unwrap().reason.as_deref(), Some("withholding_mismatch"));
        // not printed on the invoice: the accountant's rate applies anyway; a failed transfer gives the share back
        let id3 = c.request_payment(claim("consultant", "C-3", 1_000_000_000, Payout::Near { account: accounts(5) }));
        assert_eq!(c.get_payment(id3).unwrap().withheld, 200_000_000);
        assert_eq!(c.get_stats().withheld_due.0, 400_000_000);
        testing_env!(ctx(env::current_account_id()).build());
        assert!(!c.on_ft_transfer(Some(id3), U128(800_000_000), Err(PromiseError::Failed)));
        assert_eq!(c.get_stats().withheld_due.0, 200_000_000);
        // the owner remits to the state and clears the debt
        testing_env!(ctx(accounts(0)).build());
        c.mark_withholding_remitted(U128(200_000_000));
        assert_eq!(c.get_stats().withheld_due.0, 0);
    }

    #[test]
    fn transfer_ownership_moves_every_owner_power() {
        let mut c = setup();
        testing_env!(ctx(accounts(0)).build());
        c.transfer_ownership(accounts(5));
        assert_eq!(c.get_roles().0, accounts(5));
        let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| c.set_company("x".into(), "".into(), None, None)));
        assert!(r.is_err(), "the old owner is out");
        testing_env!(ctx(accounts(5)).build());
        c.set_company("Wallet Co".into(), "".into(), None, None);
        assert_eq!(c.get_company().unwrap().name, "Wallet Co");
    }

    fn no_dao() -> Bursar {
        testing_env!(ctx(accounts(0)).build());
        let mut c = Bursar::new(accounts(0), accounts(1), accounts(2), None, accounts(4), U128(5_000_000_000), U128(20_000_000_000), U128(2_000_000_000));
        c.add_vendor("hosting".into(), "Acme Hosting".into(), Payout::Near { account: accounts(5) }, U128(10_000_000_000), None, None, None);
        c.add_vendor("design".into(), "DesignCo".into(), Payout::Near { account: accounts(5) }, U128(0), None, None, None);
        testing_env!(ctx(accounts(4)).build());
        let _ = c.ft_on_transfer(accounts(0), U128(50_000_000_000), "".into());
        testing_env!(ctx(accounts(0)).build());
        c
    }

    fn with_ref(mut c: InvoiceClaim, r: &str) -> InvoiceClaim {
        c.order_ref = Some(r.into());
        c
    }

    #[test]
    fn purchase_order_covers_invoices_until_spent_then_a_human_decides() {
        let mut c = no_dao();
        let oid = c.add_order("design".into(), "PO-118".into(), "landing page".into(), U128(1_500_000_000), None);
        testing_env!(ctx(accounts(1)).build());
        let a = c.request_payment(with_ref(claim("design", "1107", 1_250_000_000, Payout::Near { account: accounts(5) }), "po-118"));
        assert_eq!(c.get_payment(a).unwrap().status, Status::Paid);
        assert_eq!(c.get_payment(a).unwrap().order_id, Some(oid));
        assert_eq!(c.get_order(oid).unwrap().kind, OrderKind::Single { remaining: 250_000_000 });
        // a second invoice on the same order, beyond what is left: not blocked, but not paid on the AI's word either
        let b = c.request_payment(with_ref(claim("design", "1108", 400_000_000, Payout::Near { account: accounts(5) }), "PO-118"));
        assert_eq!(c.get_payment(b).unwrap().status, Status::Approval);
        assert_eq!(c.get_payment(b).unwrap().reason.as_deref(), Some("no_order"));
        // an invoice with no reference at all, from a vendor that has orders: same
        let d = c.request_payment(claim("design", "1109", 100_000_000, Payout::Near { account: accounts(5) }));
        assert_eq!(c.get_payment(d).unwrap().reason.as_deref(), Some("no_order"));
        // the owner cancels the held one: nothing consumed, budget released
        testing_env!(ctx(accounts(0)).build());
        c.cancel_payment(b);
        assert_eq!(c.get_payment(b).unwrap().status, Status::Cancelled);
        assert_eq!(c.get_order(oid).unwrap().kind, OrderKind::Single { remaining: 250_000_000 });
    }

    #[test]
    fn standing_order_pays_one_invoice_per_month() {
        let mut c = no_dao();
        c.add_recurring_order("hosting".into(), "server, monthly".into(), U128(500_000_000), 30, None);
        testing_env!(ctx(accounts(1)).build());
        let a = c.request_payment(claim("hosting", "0923", 480_000_000, Payout::Near { account: accounts(5) }));
        assert_eq!(c.get_payment(a).unwrap().status, Status::Paid);
        // the vendor invents a second invoice this month: a human has to look at it
        let b = c.request_payment(claim("hosting", "0924", 320_000_000, Payout::Near { account: accounts(5) }));
        assert_eq!(c.get_payment(b).unwrap().status, Status::Approval);
        assert_eq!(c.get_payment(b).unwrap().reason.as_deref(), Some("no_order"));
        // next month the standing order covers one invoice again
        testing_env!(ctx(accounts(1)).block_timestamp(1_760_000_000_000_000_000 + 35 * DAY_NS).build());
        let d = c.request_payment(claim("hosting", "1001", 500_000_000, Payout::Near { account: accounts(5) }));
        assert_eq!(c.get_payment(d).unwrap().status, Status::Paid);
    }

    #[test]
    fn vendors_without_orders_pay_as_before_unless_strict() {
        let mut c = no_dao();
        c.add_recurring_order("hosting".into(), "server".into(), U128(500_000_000), 30, None);
        testing_env!(ctx(accounts(1)).build());
        // design has no orders: the caps alone decide
        let a = c.request_payment(claim("design", "1", 100_000_000, Payout::Near { account: accounts(5) }));
        assert_eq!(c.get_payment(a).unwrap().status, Status::Paid);
        testing_env!(ctx(accounts(0)).build());
        c.set_order_policy(true);
        testing_env!(ctx(accounts(1)).build());
        let b = c.request_payment(claim("design", "2", 100_000_000, Payout::Near { account: accounts(5) }));
        assert_eq!(c.get_payment(b).unwrap().reason.as_deref(), Some("no_order"));
    }

    #[test]
    fn model_flags_add_scrutiny_never_remove_it() {
        let mut c = no_dao();
        testing_env!(ctx(accounts(1)).build());
        let mut cl = claim("hosting", "0923", 480_000_000, Payout::Near { account: accounts(5) });
        cl.flags = vec!["urgency".into()];
        let a = c.request_payment(cl);
        assert_eq!(c.get_payment(a).unwrap().status, Status::Approval);
        assert_eq!(c.get_payment(a).unwrap().reason.as_deref(), Some("flagged"));
        testing_env!(ctx(accounts(0)).build());
        c.approve_payment(a);
        assert_eq!(c.get_payment(a).unwrap().status, Status::Paid);
    }

    #[test]
    fn operators_do_only_what_their_role_allows() {
        let mut c = no_dao();
        c.add_operator(accounts(3), Role { approve: true, manage_vendors: false, manage_orders: true });
        c.set_company("Northwind Studio".into(), "design studio".into(), None, None);
        assert_eq!(c.get_company().unwrap().name, "Northwind Studio");
        assert_eq!(c.list_operators().len(), 1);
        testing_env!(ctx(accounts(1)).build());
        let id = c.request_payment(claim("hosting", "2210", 3_000_000_000, Payout::Near { account: accounts(5) }));
        assert_eq!(c.get_payment(id).unwrap().reason.as_deref(), Some("over_threshold"));
        // the approver approves
        testing_env!(ctx(accounts(3)).build());
        c.approve_payment(id);
        assert_eq!(c.get_payment(id).unwrap().status, Status::Paid);
        // the approver may add orders but not vendors
        c.add_order("hosting".into(), "PO-1".into(), "".into(), U128(1), None);
        let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| c.add_vendor("x".into(), "X".into(), Payout::Near { account: accounts(5) }, U128(0), None, None, None)));
        assert!(r.is_err());
        // a stranger can do neither
        testing_env!(ctx(accounts(5)).build());
        let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| c.add_order("hosting".into(), "PO-2".into(), "".into(), U128(1), None)));
        assert!(r.is_err());
        // revoked
        testing_env!(ctx(accounts(0)).build());
        c.remove_operator(accounts(3));
        testing_env!(ctx(accounts(3)).build());
        let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| c.add_order("hosting".into(), "PO-3".into(), "".into(), U128(1), None)));
        assert!(r.is_err());
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
    fn a_stranger_cannot_request() {
        let mut c = setup();
        testing_env!(ctx(accounts(4)).build());
        let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            c.request_payment(claim("hosting", "1", 1, Payout::Near { account: accounts(5) }));
        }));
        assert!(r.is_err());
    }

    #[test]
    fn owner_and_operator_can_request_payment_a_stranger_cannot() {
        let mut c = setup();
        testing_env!(ctx(accounts(0)).build());
        c.add_operator(accounts(5), Role { approve: true, manage_vendors: false, manage_orders: false });
        let id = c.request_payment(claim("hosting", "o1", 1_000_000, Payout::Near { account: accounts(5) }));
        assert_eq!(c.get_payment(id).unwrap().status, Status::Paid);
        testing_env!(ctx(accounts(5)).build());
        let id = c.request_payment(claim("hosting", "o2", 1_000_000, Payout::Near { account: accounts(5) }));
        assert_eq!(c.get_payment(id).unwrap().status, Status::Paid);
        testing_env!(ctx(accounts(4)).build());
        let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            c.request_payment(claim("hosting", "o3", 1, Payout::Near { account: accounts(5) }));
        }));
        assert!(r.is_err());
    }

    #[test]
    fn vault_is_owner_only_and_round_trips() {
        let mut c = setup();
        assert_eq!(c.get_vault(), None);
        testing_env!(ctx(accounts(0)).build());
        c.set_vault("v1:ciphertext".into());
        assert_eq!(c.get_vault().as_deref(), Some("v1:ciphertext"));
        c.set_vault(String::new());
        assert_eq!(c.get_vault(), None);
        testing_env!(ctx(accounts(1)).build());
        let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| c.set_vault("x".into())));
        assert!(r.is_err());
    }
}
