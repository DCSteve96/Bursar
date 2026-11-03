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

use near_sdk::json_types::{Base64VecU8, U128};
use near_sdk::serde::{Deserialize, Serialize};
use near_sdk::store::{IterableMap, LookupSet};
use near_sdk::{
    env, ext_contract, log, near, AccountId, Gas, NearToken, PanicOnDefault, Promise, PromiseError,
    PromiseOrValue,
};

// The SDK's `require!` ends in `sys::panic_utf8`, declared `-> !`; the current toolchain drops that call and
// leaves a bare `unreachable` trap, so a failed check reached the console as "WebAssembly trap" with no
// message. This declares the same host function without `!` and calls it directly: the message survives.
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

const USDC_DECIMALS_HINT: &str = "amounts are in the token's smallest unit (USDC: 6 decimals)";
const ONE_YOCTO: NearToken = NearToken::from_yoctonear(1);
/// Raw storage key of the owner's encrypted vault (see `set_vault`).
const VAULT_KEY: &[u8] = b"vault";
/// USDC this contract has sent and whose transfer callback has not run yet. Raw storage, outside the state struct
/// (see `set_vault`), so contracts deployed before `sync_balance` existed keep working after an upgrade.
const IN_FLIGHT_KEY: &[u8] = b"inflight";
/// Refused requests the agent made today (day key, count), raw storage: a stolen agent key must not be able to fill
/// the contract's storage with blocked claims and drain the NEAR that pays for it.
const BLOCKED_TODAY_KEY: &[u8] = b"blocked_today";
const BLOCKED_PER_DAY: u32 = 200;
/// Requests and holds the agent (or an operator) may make per day: a stolen key cannot flood the books, the council
/// or the DAO bonds. The owner is not counted.
const REQUESTS_TODAY_KEY: &[u8] = b"requests_today";
const REQUESTS_PER_DAY: u32 = 500;
const HOLDS_TODAY_KEY: &[u8] = b"holds_today";
const HOLDS_PER_DAY: u32 = 50;
/// DAO proposals opened by the contract for a non-owner's holds per day: each one locks a bond; past the quota the
/// hold waits without a proposal until a person opens one (`open_dao_proposal_for`).
const DAO_TODAY_KEY: &[u8] = b"dao_today";
const DAO_PROPOSALS_PER_DAY: u32 = 10;
/// The NEAR the account must keep above its storage stake before it opens a DAO proposal (bond + headroom).
const NEAR_HEADROOM: u128 = 500_000_000_000_000_000_000_000;
/// Per payment: the vendor payout the claim was checked against (`b"ps"` + id), the DAO a proposal was opened on
/// (`b"pd"` + id). Per vendor: a payout set by an operator and not yet confirmed by the owner (`b"pu"` + vendor),
/// and the open order ids (`b"vo"` + vendor). Raw storage, no migration for deployed contracts.
const PAYOUT_SNAPSHOT_PREFIX: &[u8] = b"ps";
const PAYMENT_DAO_PREFIX: &[u8] = b"pd";
const UNCONFIRMED_PREFIX: &[u8] = b"pu";
const VENDOR_ORDERS_PREFIX: &[u8] = b"vo";
/// Per vendor: it had an order once, so its invoices need one (`b"vb"`); invoices paid without a person today
/// (`b"vd"` + vendor, a day/count pair). Per invoice file: its hash, for the duplicate check (`b"ih"` + hash).
const ORDER_BOUND_PREFIX: &[u8] = b"vb";
const VENDOR_DAY_PREFIX: &[u8] = b"vd";
const HASH_INDEX_PREFIX: &[u8] = b"ih";
/// Written once the per-vendor order index covers every vendor (new contracts, and migrated ones): a missing
/// index then means "no orders", and nothing ever scans the whole orders map again.
const ORDERS_INDEXED_KEY: &[u8] = b"orders_indexed";
/// Liquid NEAR a counted caller (the agent) must leave on the account: below it, its requests are refused so
/// a stolen key cannot write the account out of its storage stake.
const NEAR_FLOOR: u128 = 50_000_000_000_000_000_000_000;
/// Gas `upgrade` keeps back from what it attaches to `migrate`: the deploy action's fees (about 14 MGas per byte of code),
/// the function call's own fees and the end of the current execution. 15 TGas was a few TGas short at 471 KB; 40 leaves room.
const UPGRADE_RESERVE: u64 = 60_000_000_000_000; // the deploy action of a 500 KB build costs about 36 TGas, charged from what is left
/// Stored holds and autopays keep this much of the agent's receipt reference and flags; the transaction has the rest.
const STORED_REF: usize = 192;
const STORED_FLAGS: usize = 8;
/// Withholding read on the invoice may differ from the accountant's rate by rounding: one USDC at most.
const WITHHOLDING_ROUNDING: u128 = 1_000_000;
/// Invoices one vendor can get paid without a person in one day: a bill split in many small invoices still meets a human.
const AUTOPAY_PER_VENDOR_PER_DAY: u32 = 5;
const GAS_FT_VIEW: Gas = Gas::from_tgas(5);
const GAS_FT_TRANSFER: Gas = Gas::from_tgas(10);
const GAS_DAO_PROPOSAL: Gas = Gas::from_tgas(30);
const GAS_DAO_VIEW: Gas = Gas::from_tgas(10);
const GAS_CALLBACK: Gas = Gas::from_tgas(30);
const GAS_STORAGE_DEPOSIT: Gas = Gas::from_tgas(10);
/// What a NEP-141 token asks to register one account (USDC: 0.00125 NEAR). The treasury pays it for the deposit account.
const STORAGE_DEPOSIT: NearToken = NearToken::from_yoctonear(1_250_000_000_000_000_000_000);
/// Raw storage key of the ed25519 key that signs 1Click quotes, when the owner replaced the built-in one.
const QUOTE_SIGNER_KEY: &[u8] = b"quote_signer";
/// 1Click's quote-signing key, raw (`ed25519:reYaWhvwu8Jzo3WUM3zhn6VrhuMEF4eADL17qtRVifc`, the SDK's `ONE_CLICK_MANAGER_PUB_KEY`).
const ONE_CLICK_SIGNER: [u8; 32] = [12, 183, 233, 73, 227, 135, 30, 207, 40, 74, 80, 184, 231, 116, 171, 41, 179, 247, 178, 54, 62, 57, 140, 239, 29, 242, 233, 68, 87, 183, 233, 67];
/// USDC on each chain a vendor can live on, by 1Click asset id (mainnet).
const USDC_ASSETS: &[(&str, &str)] = &[
    ("base", "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near"),
    ("arb", "nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near"),
    ("eth", "nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near"),
    ("sol", "nep141:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near"),
    ("sui", "nep141:sui-c1b81ecaf27933252d31a963bc5e9458f13c18ce.omft.near"),
];
/// The most a settlement may lose to the swap: 2 percent of the net amount, checked on the quote's floor.
const MAX_FEE_BPS: u128 = 200;
/// Raw storage key of a pending ownership offer (two-step transfer).
const OFFER_KEY: &[u8] = b"owner_offer";
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
                let (a1, a2) = (a1.trim(), a2.trim());
                // only hex addresses carry their checksum in the letter case; base58 and others are exact
                let hex = a1.starts_with("0x") && a2.starts_with("0x");
                c1.trim().eq_ignore_ascii_case(c2.trim()) && if hex { a1.eq_ignore_ascii_case(a2) } else { a1 == a2 }
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

/// The answer `preview_payment` gives: what `request_payment` would record, before anyone asks.
#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct Preview {
    pub status: Status,
    pub reason: Option<String>,
    pub withheld: U128,
    pub order_id: Option<u64>,
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

/// A top-level field of the flat JSON object 1Click signed, as text: the content of a string, or a bare number or
/// boolean. The keys are unique and the values carry no escapes (ids, amounts, dates); a payload with a backslash
/// is refused before this runs. No JSON parser: the contract stays small and the check stays readable.
fn json_field<'a>(json: &'a str, key: &str) -> Option<&'a str> {
    let pat = format!("\"{key}\":");
    let rest = &json[json.find(&pat)? + pat.len()..];
    match rest.strip_prefix('"') {
        Some(r) => Some(&r[..r.find('"')?]),
        None => Some(rest[..rest.find([',', '}'])?].trim()),
    }
}

/// Seconds since the epoch of an ISO timestamp `YYYY-MM-DDTHH:MM:SS[.fff]Z`, or None.
fn iso_seconds(s: &str) -> Option<u64> {
    let b = s.as_bytes();
    if b.len() < 20 || b[4] != b'-' || b[7] != b'-' || b[10] != b'T' || b[13] != b':' || b[16] != b':' || b[b.len() - 1] != b'Z' {
        return None;
    }
    let num = |from: usize, to: usize| s.get(from..to)?.parse::<i64>().ok();
    let (y, m, d, hh, mm, ss) = (num(0, 4)?, num(5, 7)?, num(8, 10)?, num(11, 13)?, num(14, 16)?, num(17, 19)?);
    if !(1..=12).contains(&m) || !(1..=31).contains(&d) || hh > 23 || mm > 59 || ss > 60 {
        return None;
    }
    // days from civil (Howard Hinnant)
    let (y, m) = if m <= 2 { (y - 1, m + 9) } else { (y, m - 3) };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let doy = (153 * m + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    u64::try_from(days * 86_400 + hh * 3_600 + mm * 60 + ss).ok()
}

// ---------- external contracts ----------

#[allow(dead_code)]
#[ext_contract(ext_ft)]
trait FungibleToken {
    fn ft_transfer(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>);
    fn ft_balance_of(&self, account_id: AccountId) -> U128;
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
        env::storage_write(ORDERS_INDEXED_KEY, b"1");
        Self {
            owner,
            agent,
            executor,
            dao,
            dao_bond: NearToken::from_millinear(100), // what setup and the console configure on the DAO they create
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
        if env::predecessor_account_id() != self.owner {
            self.set_unconfirmed(&vendor_id, true);
        }
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
        env::storage_write(&Self::key(VENDOR_ORDERS_PREFIX, vendor_id.as_bytes()), &near_sdk::borsh::to_vec(&Vec::<u64>::new()).unwrap());
        self.emit("vendor_added", &vendor_id);
    }

    /// Changing a payout is an owner action, never something an invoice can do.
    pub fn update_vendor(&mut self, vendor_id: String, payout: Option<Payout>, monthly_budget: Option<U128>, active: Option<bool>, tax_id: Option<String>, country: Option<String>, withholding_bps: Option<u32>) {
        self.assert_can(|r| r.manage_vendors, "manage vendors");
        let mut v = self.vendors.get(&vendor_id).cloned().unwrap_or_else(|| crate::fail("unknown vendor"));
        // reactivation, the tax id and the withholding rate are the owner's: an operator may only switch a vendor off
        if env::predecessor_account_id() != self.owner {
            require!(active != Some(true) && tax_id.is_none() && withholding_bps.is_none(), "only the owner reactivates a vendor or changes its tax id or withholding");
        }
        if let Some(c) = country {
            v.country = if c.trim().is_empty() { None } else { Some(c.trim().to_ascii_uppercase()) };
        }
        if let Some(w) = withholding_bps {
            require!(w <= 5000, "withholding above 50%");
            v.withholding_bps = w;
        }
        if let Some(p) = payout {
            v.payout = p;
            // an operator changed where the money goes: nothing is paid there until the owner confirms it
            self.set_unconfirmed(&vendor_id, env::predecessor_account_id() != self.owner);
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

    /// The owner has checked the payout an operator recorded: payments to this vendor may go out again.
    pub fn confirm_vendor_payout(&mut self, vendor_id: String) {
        self.assert_owner();
        require!(self.vendors.contains_key(&vendor_id), "unknown vendor");
        self.set_unconfirmed(&vendor_id, false);
        self.emit("vendor_payout_confirmed", &vendor_id);
    }

    /// Where the executor may send queued cross-chain payments: the Intents deposit account (or its sub-accounts),
    /// or the one-off implicit account (64 hex characters) a 1Click quote names as its deposit address, registered by the
    /// owner after seeing the quote. Unset, nothing is settled: the executor cannot pick a destination on its own.
    /// The key that signs 1Click quotes, raw 32 bytes in base64. The built-in one is 1Click's; the owner can replace it
    /// if 1Click rotates keys, or set a key of its own on testnet. `None` goes back to the built-in one.
    pub fn set_quote_signer(&mut self, public_key: Option<Base64VecU8>) {
        self.assert_owner();
        match public_key {
            Some(k) => {
                require!(k.0.len() == 32, "not an ed25519 public key");
                env::storage_write(QUOTE_SIGNER_KEY, &k.0);
            }
            None => {
                env::storage_remove(QUOTE_SIGNER_KEY);
            }
        }
        self.emit("quote_signer_set", "");
    }

    pub fn get_quote_signer(&self) -> Base64VecU8 {
        Base64VecU8(self.quote_signer().to_vec())
    }

    fn quote_signer(&self) -> [u8; 32] {
        env::storage_read(QUOTE_SIGNER_KEY).and_then(|r| r.try_into().ok()).unwrap_or(ONE_CLICK_SIGNER)
    }

    pub fn set_limits(&mut self, per_payment_cap: U128, daily_cap: U128, approval_threshold: U128) {
        self.assert_owner();
        require!(per_payment_cap.0 > 0, "a zero per-payment cap would refuse everything: pause the treasury instead");
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
    /// Ownership moves in two steps: the owner offers, the new owner accepts. A wallet talked into one signature
    /// gives nothing away; the offer can be withdrawn until it is accepted.
    pub fn offer_ownership(&mut self, new_owner: AccountId) {
        self.assert_owner();
        require!(new_owner != self.owner, "already the owner");
        require!(new_owner != self.agent && new_owner != self.executor && new_owner != env::current_account_id(), "the agent, the executor and the treasury itself cannot own the treasury");
        env::storage_write(OFFER_KEY, new_owner.as_bytes());
        self.emit("owner_offered", new_owner.as_str());
    }

    pub fn cancel_ownership_offer(&mut self) {
        self.assert_owner();
        env::storage_remove(OFFER_KEY);
        self.emit("owner_offer_cancelled", "");
    }

    pub fn accept_ownership(&mut self) {
        let offer = self.get_ownership_offer().unwrap_or_else(|| crate::fail("no ownership offer"));
        require!(env::predecessor_account_id() == offer, "the offer is for another account");
        env::storage_remove(OFFER_KEY);
        self.operators.remove(&offer);
        self.owner = offer.clone();
        self.emit("owner_changed", offer.as_str());
    }

    pub fn get_ownership_offer(&self) -> Option<AccountId> {
        env::storage_read(OFFER_KEY).and_then(|b| String::from_utf8(b).ok()).and_then(|s| s.parse().ok())
    }

    // ----- operators: the owner delegates parts of its power, on chain, revocably -----

    pub fn add_operator(&mut self, account: AccountId, role: Role) {
        self.assert_owner();
        require!(account != self.owner, "the owner is not an operator");
        require!(account != self.agent && account != self.executor, "the agent and the executor only do their own job");
        require!(role.approve || role.manage_vendors || role.manage_orders, "an operator needs at least one role");
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
        require!(period_days <= 3660, "period too long");
        let kind = OrderKind::Recurring { amount_per_period: amount_per_period.0, period_days, last_period: None };
        self.insert_order(vendor_id, String::new(), description, kind, expires_at.unwrap_or(0))
    }

    /// Whether this vendor's invoices must match an order. Set when its first order is recorded; the owner lifts it here.
    pub fn set_order_bound(&mut self, vendor_id: String, bound: bool) {
        self.assert_owner();
        require!(self.vendors.contains_key(&vendor_id), "unknown vendor");
        let k = Self::key(ORDER_BOUND_PREFIX, vendor_id.as_bytes());
        if bound { env::storage_write(&k, b"1"); } else { env::storage_remove(&k); }
        self.emit("order_bound_set", &format!("{vendor_id}:{bound}"));
    }

    pub fn close_order(&mut self, id: u64) {
        self.assert_can(|r| r.manage_orders, "manage orders");
        let mut o = self.orders.get(&id).cloned().unwrap_or_else(|| crate::fail("unknown order"));
        o.active = false;
        let open: Vec<u64> = self.vendor_order_ids(&o.vendor_id).into_iter().filter(|x| *x != id).collect();
        env::storage_write(&Self::key(VENDOR_ORDERS_PREFIX, o.vendor_id.as_bytes()), &near_sdk::borsh::to_vec(&open).unwrap());
        self.orders.insert(id, o);
        self.emit("order_closed", &id.to_string());
    }

    pub fn set_roles(&mut self, agent: Option<AccountId>, executor: Option<AccountId>, dao: Option<AccountId>, dao_bond: Option<NearToken>) {
        self.assert_owner();
        if let Some(b) = dao_bond {
            self.dao_bond = b;
        }
        if let Some(a) = agent {
            require!(a != self.owner && !self.operators.contains_key(&a), "the agent cannot be the owner or an operator");
            self.agent = a;
        }
        if let Some(e) = executor {
            require!(e != self.owner && !self.operators.contains_key(&e), "the executor cannot be the owner or an operator");
            self.executor = e;
        }
        if let Some(d) = dao.as_ref() {
            require!(*d != self.agent && *d != self.executor && !self.operators.contains_key(d), "the dao cannot be the agent, the executor or an operator");
        }
        if dao.is_some() {
            self.dao = dao;
        }
        self.emit("roles_set", "");
    }

    /// Back to the owner and the approvers deciding held payments, the ones with a proposal already open included.
    pub fn clear_dao(&mut self) {
        self.assert_owner();
        self.dao = None;
        self.emit("dao_cleared", "");
    }

    pub fn set_paused(&mut self, paused: bool) {
        self.assert_owner();
        self.paused = paused;
        self.emit(if paused { "paused" } else { "unpaused" }, "");
    }

    pub fn mark_withholding_remitted(&mut self, amount: U128) {
        self.assert_owner();
        require!(amount.0 <= self.withheld_due, "more than is due");
        self.withheld_due -= amount.0;
        self.emit("withholding_remitted", &amount.0.to_string());
    }

    /// The company's own money leaves to the owner; the withheld tax does not, see `remit_withholding`.
    pub fn withdraw(&mut self, amount: U128) -> Promise {
        self.assert_owner();
        require!(amount.0 <= self.spendable(), "insufficient balance: the withheld tax is not spendable, remit it with remit_withholding");
        self.balance -= amount.0;
        self.emit("withdraw", &amount.0.to_string());
        self.ft_transfer(self.owner.clone(), amount.0, "bursar withdraw".into())
            .then(Self::ext(env::current_account_id()).with_static_gas(GAS_CALLBACK).on_ft_transfer(None, amount))
    }

    /// The withheld tax goes to the owner, who pays the state with it: both the balance and the debt drop together.
    pub fn remit_withholding(&mut self, amount: U128) -> Promise {
        self.assert_owner();
        require!(amount.0 > 0 && amount.0 <= self.withheld_due, "more than is due");
        require!(amount.0 <= self.balance, "insufficient balance");
        self.balance -= amount.0;
        self.withheld_due -= amount.0;
        self.emit("withholding_remitted", &amount.0.to_string());
        self.ft_transfer(self.owner.clone(), amount.0, "bursar withholding remittance".into())
            .then(Self::ext(env::current_account_id()).with_static_gas(GAS_CALLBACK).on_remit(amount))
    }

    #[private]
    pub fn on_remit(&mut self, amount: U128, #[callback_result] result: Result<(), PromiseError>) -> bool {
        self.set_in_flight(self.in_flight().saturating_sub(amount.0));
        if result.is_ok() {
            return true;
        }
        self.balance += amount.0;
        self.withheld_due += amount.0;
        self.emit("transfer_failed", "remit");
        false
    }

    /// Nothing moved: the owner paid the state from elsewhere and clears that much of the debt, which frees the same
    /// amount of the balance. Prefer `remit_withholding`, which moves the money and clears the debt in one step.

    pub fn cancel_payment(&mut self, id: u64) {
        self.assert_can(|r| r.approve, "approve");
        let mut p = self.payments.get(&id).cloned().unwrap_or_else(|| crate::fail("unknown payment"));
        require!(matches!(p.status, Status::Queued | Status::Approval), "cannot cancel in this state");
        self.release_reservation(&p);
        self.forget_payment_keys(id);
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
        Self::check_claim_size(&claim);
        require!(!self.paused, "paused");
        // quotas per caller: a flooding agent key does not lock an operator out
        let counted = caller != self.owner;
        // a key that is not the owner's cannot write the account out of its storage stake
        if counted {
            require!(self.liquid_near() >= NEAR_FLOOR, "the treasury account is low on NEAR for storage: the owner tops it up");
        }
        let quota = |k: &[u8]| Self::key(k, caller.as_bytes());
        if counted {
            self.bump_daily(&quota(REQUESTS_TODAY_KEY), REQUESTS_PER_DAY, "daily quota of requests reached: this key is sending too many claims, the owner should look at it");
        }
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

        let decision = self.decide(&claim).and_then(|()| {
            // a hold costs a person's time and, with a DAO, a bond: the agent gets a daily quota of them,
            // and no proposal opens when the account could not pay the bond
            let would_hold = !self.holds(&claim, self.find_order(&claim).is_some()).0.is_empty();
            if would_hold && counted && self.daily_count(&quota(HOLDS_TODAY_KEY)) >= HOLDS_PER_DAY {
                return Err("hold_quota_reached".into());
            }
            Ok(())
        });
        match decision {
            Err(reason) => {
                if counted {
                    self.bump_daily(&quota(BLOCKED_TODAY_KEY), BLOCKED_PER_DAY, "daily quota of refused requests reached: this key is sending bad claims, the owner should look at it");
                    // a refusal is recorded small: the reason, not the agent's payload
                    p.flags.truncate(2);
                    Self::clip(&mut p.attestation_ref, 64);
                    Self::clip(&mut p.invoice_hash, 64);
                }
                p.reason = Some(reason.clone());
                self.payments.insert(id, p);
                self.emit("payment_blocked", &format!("{id}:{reason}"));
                id
            }
            Ok(()) => {
                // Reserve budget now so two invoices cannot both pass the same cap.
                self.reserve(&claim.vendor_id, amount);
                // the payout this claim was checked against: the money goes there or nowhere
                self.set_payout_snapshot(id, &claim.payout_seen);
                if !Self::norm_id(&claim.invoice_number).is_empty() {
                    self.invoice_index.insert(Self::invoice_key(&claim.vendor_id, &claim.invoice_number));
                }
                self.set_hash_seen(&claim.invoice_hash, true);
                // What the company agreed to buy: consume the matching order, or note that there is none.
                let (order_id, covered) = self.consume_order(&claim);
                p.order_id = order_id;
                let (holds, withheld) = self.holds(&claim, covered);
                p.withheld = withheld;
                // what is stored stays small: the transaction carries the agent's whole claim
                p.flags.truncate(STORED_FLAGS);
                Self::clip(&mut p.attestation_ref, STORED_REF);
                if !holds.is_empty() {
                    if counted {
                        self.bump_daily(&quota(HOLDS_TODAY_KEY), HOLDS_PER_DAY, "daily quota of holds reached");
                    }
                    let reason = holds.join("+");
                    p.status = Status::Approval;
                    p.reason = Some(reason.clone());
                    self.payments.insert(id, p);
                    self.emit("payment_needs_approval", &format!("{id}:{reason}"));
                    // a proposal costs a bond: not for a hold the council could not approve anyway, not past the day's
                    // quota for this key, not without NEAR for it; then the hold waits for a person to open one
                    let opens = self.dao.is_some()
                        && !holds.contains(&"payout_unconfirmed")
                        && (!counted || self.daily_count(&quota(DAO_TODAY_KEY)) < DAO_PROPOSALS_PER_DAY)
                        && self.can_pay_bond();
                    if opens {
                        if counted {
                            self.bump_daily(&quota(DAO_TODAY_KEY), DAO_PROPOSALS_PER_DAY, "daily quota of proposals reached");
                        }
                        self.open_dao_proposal(id, amount, &claim.vendor_id, &reason);
                    }
                    id
                } else {
                    // paid without a person: one more of the vendor's daily allowance
                    self.bump_daily(&Self::key(VENDOR_DAY_PREFIX, claim.vendor_id.as_bytes()), u32::MAX, "");
                    self.execute(p);
                    id
                }
            }
        }
    }

    // ----- dao -----

    /// A held payment with no proposal (the day's quota was spent, the account had no NEAR for the bond, or the
    /// vendor's payout was unconfirmed): the owner or an approver opens the proposal now, bond from the contract.
    pub fn open_dao_proposal_for(&mut self, id: u64) {
        self.assert_can(|r| r.approve, "approve");
        require!(self.dao.is_some(), "no dao");
        let p = self.payments.get(&id).cloned().unwrap_or_else(|| crate::fail("unknown payment"));
        require!(p.status == Status::Approval, "not waiting for approval");
        require!(p.dao_proposal_id.is_none() && self.payment_dao(id).is_none(), "a proposal is already open");
        require!(!self.is_unconfirmed(&p.vendor_id), "the vendor's payout was set by an operator: the owner must confirm it first");
        require!(self.can_pay_bond(), "the treasury account has no NEAR for the bond");
        let reason = p.reason.clone().unwrap_or_default();
        self.open_dao_proposal(id, p.amount, &p.vendor_id, &reason);
    }

    /// Called by the DAO when the council approves the proposal, or by the owner or an approver when there is no DAO.
    pub fn approve_payment(&mut self, id: u64) {
        match &self.dao {
            Some(dao) => require!(env::predecessor_account_id() == *dao, "only the dao"),
            None => self.assert_can(|r| r.approve, "approve"),
        }
        let p = self.payments.get(&id).cloned().unwrap_or_else(|| crate::fail("unknown payment"));
        require!(p.status == Status::Approval, "not waiting for approval");
        // the world may have moved since the hold: a pause or a switched-off vendor refuses the approval too
        require!(!self.paused, "paused");
        let v = self.vendors.get(&p.vendor_id).unwrap_or_else(|| crate::fail("unknown vendor"));
        require!(v.active, "vendor deactivated by the owner since the hold");
        require!(!self.is_unconfirmed(&p.vendor_id), "the vendor's payout was set by an operator: the owner must confirm it first");
        self.emit("payment_approved", &id.to_string());
        self.execute(p);
    }

    /// Callback of `add_proposal`: records the Sputnik proposal id on the payment.
    /// If the DAO refused the proposal (bond missing, DAO misconfigured), the payment is blocked and
    /// its budget reservation released, so the owner can fix the DAO and the agent can resubmit.
    #[private]
    pub fn on_dao_proposal(&mut self, id: u64, #[callback_result] result: Result<u64, PromiseError>) {
        let mut p = self.payments.get(&id).cloned().unwrap_or_else(|| crate::fail("unknown payment"));
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
                self.forget_payment_keys(id);
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
        let dao = self.dao.clone().unwrap_or_else(|| crate::fail("no dao"));
        let p = self.payments.get(&id).unwrap_or_else(|| crate::fail("unknown payment"));
        require!(p.status == Status::Approval, "not waiting for approval");
        let proposal_id = p.dao_proposal_id.unwrap_or_else(|| crate::fail("proposal id not recorded yet"));
        if let Some(opened_on) = self.payment_dao(id) {
            require!(opened_on == dao, "this proposal was opened on another dao");
        }
        ext_dao::ext(dao)
            .with_static_gas(GAS_DAO_VIEW)
            .get_proposal(proposal_id)
            .then(Self::ext(env::current_account_id()).with_static_gas(GAS_CALLBACK).on_dao_status(id))
    }

    #[private]
    pub fn on_dao_status(&mut self, id: u64, #[callback_result] result: Result<ProposalStatusView, PromiseError>) -> String {
        let view = result.unwrap_or_else(|_| crate::fail("dao did not answer"));
        let mut p = self.payments.get(&id).cloned().unwrap_or_else(|| crate::fail("unknown payment"));
        if p.status != Status::Approval {
            return view.status;
        }
        if matches!(view.status.as_str(), "Rejected" | "Removed" | "Expired" | "Failed" | "Moved") {
            self.release_reservation(&p);
            self.forget_payment_keys(id);
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
        self.set_in_flight(self.in_flight().saturating_sub(amount.0));
        if result.is_ok() {
            return true;
        }
        self.balance += amount.0;
        if let Some(id) = id {
            if let Some(mut p) = self.payments.get(&id).cloned() {
                match p.status {
                    Status::Paid => {
                        self.withheld_due = self.withheld_due.saturating_sub(p.withheld);
                        self.release_reservation(&p);
                        p.status = Status::Blocked;
                        p.reason = Some("transfer_failed".into());
                    }
                    Status::Settling => {
                        self.withheld_due = self.withheld_due.saturating_sub(p.withheld);
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
    /// Settle a queued cross-chain payment on a quote 1Click signed: the contract checks the signature, that the quote
    /// pays the vendor's recorded address in USDC on the vendor's chain for exactly the net amount, that the swap keeps
    /// at least 98 percent of it, and that the quote has not expired; then it registers the one-off deposit account on
    /// the token (the treasury pays the storage) and sends the USDC there, in one receipt. Nobody registers anything by
    /// hand, and the executor cannot name a destination: 1Click did, under its signature, for the vendor's address.
    pub fn settle(&mut self, id: u64, payload: String, signature: Base64VecU8) -> Promise {
        require!(env::predecessor_account_id() == self.executor, "only the executor");
        require!(payload.len() <= 4096, "payload too long");
        require!(!self.paused, "paused");
        let mut p = self.payments.get(&id).cloned().unwrap_or_else(|| crate::fail("unknown payment"));
        require!(p.status == Status::Queued, "not queued");
        let v = self.vendors.get(&p.vendor_id).unwrap_or_else(|| crate::fail("unknown vendor"));
        require!(v.active, "vendor deactivated by the owner");
        let (chain, address) = match &v.payout {
            Payout::Chain { chain, address } => (chain.clone(), address.clone()),
            Payout::Near { .. } => crate::fail("near vendors are paid directly"),
        };
        if let Some(seen) = self.payout_snapshot(id) {
            require!(v.payout.same_as(&seen), "the vendor's payout changed since this claim was checked");
        }
        require!(!self.is_unconfirmed(&p.vendor_id), "the vendor's payout was set by an operator: the owner must confirm it first");
        // the signature: ed25519 by 1Click over the base58 sha256 of exactly these bytes
        let digest = env::sha256(payload.as_bytes());
        let message = bs58::encode(&digest).into_string();
        let sig: [u8; 64] = signature.0.try_into().unwrap_or_else(|_| crate::fail("bad signature length"));
        require!(env::ed25519_verify(&sig, message.as_bytes(), &self.quote_signer()), "the quote is not signed by 1Click");
        // the quote must be the swap this payment needs, and nothing else
        require!(!payload.contains('\\'), "the quote could not be read");
        let field = |k: &str| json_field(&payload, k).unwrap_or_else(|| crate::fail("the quote could not be read"));
        let net = p.amount - p.withheld;
        require!(field("dry") == "false", "a dry quote has no deposit address");
        require!(field("swapType") == "EXACT_INPUT", "the quote must be EXACT_INPUT");
        require!(field("originAsset") == format!("nep141:{}", self.usdc), "the quote does not spend this treasury's USDC");
        let want = USDC_ASSETS.iter().find(|(c, _)| *c == chain).map(|(_, a)| *a).unwrap_or_else(|| crate::fail("no USDC asset known for the vendor's chain"));
        require!(field("destinationAsset") == want, "the quote does not deliver USDC on the vendor's chain");
        require!(field("depositType") == "ORIGIN_CHAIN" && field("refundType") == "ORIGIN_CHAIN" && field("recipientType") == "DESTINATION_CHAIN", "the quote must deposit from NEAR, refund to NEAR and pay the destination chain");
        require!(field("refundTo") == env::current_account_id().as_str(), "refunds must come back to the treasury");
        require!(field("recipient").eq_ignore_ascii_case(&address), "the quote does not pay the vendor's recorded address");
        require!(field("amountIn").parse::<u128>().ok() == Some(net), "the quote amount is not this payment's net amount");
        let floor: u128 = field("minAmountOut").parse().unwrap_or(0);
        require!(floor >= net - net * MAX_FEE_BPS / 10_000, "the swap would keep less than 98 percent of the payment");
        let deadline = iso_seconds(field("deadline")).unwrap_or_else(|| crate::fail("the quote deadline could not be read"));
        require!(deadline > env::block_timestamp() / 1_000_000_000 + 60, "the quote has expired");
        let dep = json_field(&payload, "depositAddress").unwrap_or_else(|| crate::fail("the quote names no deposit address"));
        require!(dep.len() == 64 && dep.bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase()), "the deposit address is not an implicit account");
        let deposit: AccountId = dep.parse().unwrap_or_else(|_| crate::fail("bad deposit address"));
        require!(p.amount <= self.spendable(), "insufficient balance");
        require!(self.in_flight() == 0, "a transfer is in flight: ask again in a few seconds");
        require!(env::account_balance().as_yoctonear() >= NEAR_FLOOR.saturating_add(STORAGE_DEPOSIT.as_yoctonear()), "the treasury needs NEAR to register the deposit account");
        self.balance -= net;
        self.withheld_due += p.withheld;
        p.status = Status::Settling;
        p.quote_id = Some(message.clone());
        p.deposit_address = Some(deposit.to_string());
        p.updated_at = env::block_timestamp();
        self.payments.insert(id, p);
        self.emit("payment_settling", &format!("{id}:{message}"));
        // one receipt on the token: register the deposit account (a no-op refund if it exists), then send; atomic
        self.set_in_flight(self.in_flight() + net);
        Promise::new(self.usdc.clone())
            .function_call(
                "storage_deposit".to_string(),
                format!("{{\"account_id\":\"{deposit}\",\"registration_only\":true}}").into_bytes(), // the address is 64 hex chars: no escaping needed
                STORAGE_DEPOSIT,
                GAS_STORAGE_DEPOSIT,
            )
            .function_call(
                "ft_transfer".to_string(),
                format!("{{\"receiver_id\":\"{deposit}\",\"amount\":\"{net}\",\"memo\":\"bursar payment {id}\"}}").into_bytes(),
                ONE_YOCTO,
                GAS_FT_TRANSFER,
            )
            .then(Self::ext(env::current_account_id()).with_static_gas(GAS_CALLBACK).on_ft_transfer(Some(id), U128(net)))
    }

    pub fn mark_settled(&mut self, id: u64, dest_tx: String) {
        require!(env::predecessor_account_id() == self.executor, "only the executor");
        require!(dest_tx.len() <= 128, "dest_tx too long");
        let mut p = self.payments.get(&id).cloned().unwrap_or_else(|| crate::fail("unknown payment"));
        require!(p.status == Status::Settling, "not settling");
        require!(self.in_flight() == 0, "the transfer to the deposit address has not landed yet");
        p.status = Status::Settled;
        self.forget_payment_keys(id);
        p.dest_tx = Some(dest_tx);
        p.updated_at = env::block_timestamp();
        self.payments.insert(id, p);
        self.emit("payment_settled", &id.to_string());
    }

    /// Intents did not deliver and refunded the USDC to this account with a plain transfer (the quote expired, the
    /// route failed). The executor or the owner reports it; the contract checks the token holds the refund, takes it
    /// back on the books, and holds the payment for a person to send again or cancel. Only once the deposit transfer's
    /// callback has run.
    pub fn mark_settlement_failed(&mut self, id: u64) -> Promise {
        let caller = env::predecessor_account_id();
        require!(caller == self.executor || caller == self.owner, "only the executor or the owner");
        require!(self.in_flight() == 0, "the transfer to the deposit address has not landed yet");
        let p = self.payments.get(&id).unwrap_or_else(|| crate::fail("unknown payment"));
        require!(p.status == Status::Settling, "not settling");
        // nobody's word: the token says whether the USDC came back before the payment can move again
        ext_ft::ext(self.usdc.clone())
            .with_static_gas(GAS_FT_VIEW)
            .ft_balance_of(env::current_account_id())
            .then(Self::ext(env::current_account_id()).with_static_gas(GAS_CALLBACK).on_settlement_failed(id))
    }

    #[private]
    pub fn on_settlement_failed(&mut self, id: u64, #[callback_result] held: Result<U128, PromiseError>) -> bool {
        let held = held.unwrap_or_else(|_| crate::fail("the token did not answer")).0;
        require!(self.in_flight() == 0, "a transfer started meanwhile: ask again in a few seconds");
        let mut p = self.payments.get(&id).cloned().unwrap_or_else(|| crate::fail("unknown payment"));
        require!(p.status == Status::Settling, "not settling");
        let net = p.amount - p.withheld;
        require!(held >= self.balance.saturating_add(net), "the refund has not arrived: the token holds less than the books plus this payment");
        // the refund is on the account: the books take back exactly this payment's net (anything else on the token is
        // a deposit, for sync_balance), and a person decides whether it is sent again: on chain a refund and a deposit
        // look the same, so the executor alone must not be able to pay an invoice twice
        let old = self.balance;
        self.balance = self.balance.saturating_add(net);
        self.withheld_due = self.withheld_due.saturating_sub(p.withheld);
        p.status = Status::Approval;
        p.reason = Some("settlement_failed".into());
        p.quote_id = None;
        p.deposit_address = None;
        p.updated_at = env::block_timestamp();
        self.payments.insert(id, p);
        self.emit("settlement_failed", &format!("{id}:{old}:{held}"));
        true
    }

    /// A settlement nobody can finish through the executor (it vanished, or the refund was already counted by
    /// `sync_balance`): the owner records what happened. Delivered: the payment is Settled. Not delivered: it is
    /// Cancelled, its reservations released, the withholding booked at settle undone; the USDC itself is wherever
    /// the token says, which `sync_balance` reads.
    pub fn close_settlement(&mut self, id: u64, delivered: bool) {
        self.assert_owner();
        let mut p = self.payments.get(&id).cloned().unwrap_or_else(|| crate::fail("unknown payment"));
        require!(p.status == Status::Settling, "not settling");
        require!(self.in_flight() == 0, "the transfer to the deposit address has not landed yet");
        if delivered {
            p.status = Status::Settled;
            p.dest_tx = Some("closed by the owner".into());
        } else {
            self.release_reservation(&p);
            self.withheld_due = self.withheld_due.saturating_sub(p.withheld);
            p.status = Status::Cancelled;
            p.reason = Some("settlement_closed".into());
        }
        self.forget_payment_keys(id);
        p.updated_at = env::block_timestamp();
        self.payments.insert(id, p);
        self.emit(if delivered { "payment_settled" } else { "payment_cancelled" }, &id.to_string());
    }

    // ----- token deposits (NEP-141 receiver) -----

    /// If a transfer callback never ran (out of gas, a storage-starved account), the in-flight counter would stay up
    /// and block `sync_balance` for good. The owner clears it after checking the token's balance; the next
    /// `sync_balance` then reads the truth.
    pub fn reset_in_flight(&mut self) {
        self.assert_owner();
        let was = self.in_flight();
        self.set_in_flight(0);
        self.emit("in_flight_reset", &was.to_string());
    }

    /// Align the balance with what the token contract actually holds. USDC sent with a plain `ft_transfer`
    /// (a wallet, an exchange) lands in the account without `ft_on_transfer` running, so the contract would
    /// refuse payments for lack of funds it has. The owner or any operator asks; the answer is the token's,
    /// minus the transfers this contract sent whose callback has not run yet.
    pub fn sync_balance(&mut self) -> Promise {
        self.assert_can(|_| true, "sync the balance");
        require!(self.in_flight() == 0, "a transfer is in flight: ask again in a few seconds");
        ext_ft::ext(self.usdc.clone())
            .with_static_gas(GAS_FT_VIEW)
            .ft_balance_of(env::current_account_id())
            .then(Self::ext(env::current_account_id()).with_static_gas(GAS_CALLBACK).on_sync_balance())
    }

    #[private]
    pub fn on_sync_balance(&mut self, #[callback_result] held: Result<U128, PromiseError>) -> U128 {
        let held = held.unwrap_or_else(|_| crate::fail("the token did not answer")).0;
        let in_flight = self.in_flight();
        require!(in_flight == 0, "a transfer started meanwhile: ask again in a few seconds");
        let new = held.saturating_sub(in_flight);
        let old = self.balance;
        self.balance = new;
        self.emit("balance_synced", &format!("{old}:{new}:{in_flight}"));
        U128(new)
    }

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
        // ids are dense: walk them instead of scanning the map from the start
        let from = from.unwrap_or(0);
        let limit = limit.unwrap_or(50).min(200);
        (from.saturating_add(1)..self.next_id).filter_map(|id| self.payments.get(&id).cloned()).take(limit as usize).collect()
    }

    pub fn get_vendor(&self, vendor_id: String) -> Option<Vendor> {
        self.vendors.get(&vendor_id).cloned()
    }

    pub fn list_vendors(&self, from: Option<u64>, limit: Option<u64>) -> Vec<(String, Vendor)> {
        self.vendors.iter().skip(from.unwrap_or(0) as usize).take(limit.unwrap_or(500).min(500) as usize).map(|(k, v)| (k.clone(), v.clone())).collect()
    }

    /// What the raw-storage marks say about a vendor: its payout waits for the owner's confirmation; its invoices need an order.
    pub fn vendor_state(&self, vendor_id: String) -> (bool, bool) {
        (self.is_unconfirmed(&vendor_id), env::storage_has_key(&Self::key(ORDER_BOUND_PREFIX, vendor_id.as_bytes())))
    }

    pub fn get_in_flight(&self) -> U128 {
        U128(self.in_flight())
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

    /// Why a person must decide, and the withholding kept back. Pure: `request_payment` and `preview_payment` share it.
    /// A human decides when: the amount is above the threshold; no order covers the invoice (always in strict mode,
    /// otherwise only for vendors that have orders); the model raised flags; the tax ids do not match what the owner
    /// recorded; the withholding shown differs from the accountant's rate. The AI can add scrutiny, never remove it.
    fn holds(&self, claim: &InvoiceClaim, covered: bool) -> (Vec<&'static str>, u128) {
        let amount = claim.amount.0;
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
        if self.is_unconfirmed(&claim.vendor_id) {
            holds.push("payout_unconfirmed");
        }
        if self.daily_count(&Self::key(VENDOR_DAY_PREFIX, claim.vendor_id.as_bytes())) >= AUTOPAY_PER_VENDOR_PER_DAY {
            holds.push("many_invoices");
        }
        // Identity, when the owner recorded it: a misread id must not refuse a real invoice, so these are holds, not blocks.
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
        // Withholding, as the company's accountant set it on the vendor: the treasury keeps that share back for the
        // state and pays the rest. A different withholding on the invoice, or one the company did not configure, waits.
        let bps = self.vendors.get(&claim.vendor_id).map(|v| v.withholding_bps).unwrap_or(0) as u128;
        let expected = amount * bps / 10_000;
        let seen = claim.withholding_seen.0;
        let mut withheld = 0;
        if bps > 0 {
            withheld = expected;
            if seen > 0 && seen.abs_diff(expected) > (amount / 100).min(WITHHOLDING_ROUNDING) {
                holds.push("withholding_mismatch");
            }
        } else if seen > 0 {
            holds.push("withholding_mismatch");
        }
        (holds, withheld)
    }

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
        if c.invoice_number.trim().is_empty() && c.invoice_hash.trim().is_empty() {
            return Err("no_invoice_identity".into());
        }
        let numbered = !Self::norm_id(&c.invoice_number).is_empty();
        if (numbered && (self.invoice_index.contains(&Self::invoice_key(&c.vendor_id, &c.invoice_number)) || self.invoice_index.contains(&Self::old_invoice_key(&c.vendor_id, &c.invoice_number))))
            || self.hash_seen(&c.invoice_hash)
        {
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
        if v.monthly_budget > 0 && spent_month.saturating_add(amount) > v.monthly_budget {
            return Err("over_monthly_budget".into());
        }
        let spent_today = if self.day == Self::day_key() { self.spent_today } else { 0 };
        if self.limits.daily_cap > 0 && spent_today.saturating_add(amount) > self.limits.daily_cap {
            return Err("over_daily_cap".into());
        }
        if amount > self.spendable() {
            return Err("insufficient_treasury".into());
        }
        Ok(())
    }

    fn execute(&mut self, mut p: Payment) {
        let v = self.vendors.get(&p.vendor_id).cloned().unwrap_or_else(|| crate::fail("unknown vendor"));
        // the payout may have been edited since the claim was checked: then this payment goes nowhere
        if let Some(seen) = self.payout_snapshot(p.id) {
            require!(v.payout.same_as(&seen), "the vendor's payout changed since this claim was checked: cancel it; the vendor sends an invoice with the new details, or the owner restores the payout first");
        }
        p.updated_at = env::block_timestamp();
        match v.payout {
            Payout::Near { account } => {
                // the withheld share stays in the treasury, earmarked for the state; the vendor gets the net
                let net = p.amount - p.withheld;
                // the gross: the net leaves, the withheld share stays and must be there too
                require!(p.amount <= self.spendable(), "insufficient balance");
                self.balance -= net;
                self.withheld_due += p.withheld;
                p.status = Status::Paid;
                let id = p.id;
                let memo = format!("bursar payment {id}");
                self.forget_payment_keys(id);
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
        env::storage_write(&Self::key(PAYMENT_DAO_PREFIX, &id.to_le_bytes()), dao.as_bytes());
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
                    gas: near_sdk::json_types::U64(Gas::from_tgas(80).as_gas()),
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
        // the counters belong to a day and a month; subtract only if they are the ones the reservation went into
        if let Some(mut v) = self.vendors.get(&p.vendor_id).cloned() {
            if v.month == Self::month_key_at(p.created_at) {
                v.spent_this_month = v.spent_this_month.saturating_sub(p.amount);
                self.vendors.insert(p.vendor_id.clone(), v);
            }
        }
        if self.day == p.created_at / DAY_NS {
            self.spent_today = self.spent_today.saturating_sub(p.amount);
        }
        if !Self::norm_id(&p.invoice_number).is_empty() {
            self.invoice_index.remove(&Self::invoice_key(&p.vendor_id, &p.invoice_number));
            self.invoice_index.remove(&Self::old_invoice_key(&p.vendor_id, &p.invoice_number));
        }
        self.set_hash_seen(&p.invoice_hash, false);
        if let Some(oid) = p.order_id {
            if let Some(mut o) = self.orders.get(&oid).cloned() {
                match &mut o.kind {
                    OrderKind::Single { remaining } => *remaining += p.amount,
                    OrderKind::Recurring { last_period, period_days, .. } => {
                        if *last_period == Some(Self::period_key_at(*period_days, p.created_at)) {
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
        let mut open = self.vendor_order_ids(&vendor_id);
        require!(open.len() < 64, "too many open orders for this vendor: close some first");
        env::storage_write(&Self::key(ORDER_BOUND_PREFIX, vendor_id.as_bytes()), b"1");
        open.push(id);
        env::storage_write(&Self::key(VENDOR_ORDERS_PREFIX, vendor_id.as_bytes()), &near_sdk::borsh::to_vec(&open).unwrap());
        self.orders.insert(id, Order { id, vendor_id, reference: reference.trim().to_string(), description, kind, expires_at, active: true, created_at: env::block_timestamp() });
        self.emit("order_added", &id.to_string());
        id
    }

    /// The open order ids of a vendor, from the index. A contract from before the index scans its orders instead
    /// (views cannot write storage); the index is written the next time an order is added or closed.
    fn vendor_order_ids(&self, vendor_id: &str) -> Vec<u64> {
        match env::storage_read(&Self::key(VENDOR_ORDERS_PREFIX, vendor_id.as_bytes())) {
            Some(b) => near_sdk::borsh::from_slice::<Vec<u64>>(&b).unwrap_or_default(),
            None if env::storage_has_key(ORDERS_INDEXED_KEY) => Vec::new(),
            None => self.orders.iter().filter(|(_, o)| o.vendor_id == vendor_id && o.active).map(|(id, _)| *id).collect(),
        }
    }

    fn vendor_open_orders(&self, vendor_id: &str) -> Vec<Order> {
        self.vendor_order_ids(vendor_id).into_iter().filter_map(|id| self.orders.get(&id).cloned()).filter(Self::order_is_open).collect()
    }

    fn order_is_open(o: &Order) -> bool {
        o.active && (o.expires_at == 0 || env::block_timestamp() <= o.expires_at)
    }

    /// A vendor that ever had an order is held to orders, even once they are all closed; `set_order_bound` lifts it.
    fn vendor_has_orders(&self, vendor_id: &str) -> bool {
        env::storage_has_key(&Self::key(ORDER_BOUND_PREFIX, vendor_id.as_bytes())) || !self.vendor_open_orders(vendor_id).is_empty()
    }

    /// Find the order this claim fits and consume it. A purchase order is matched by the reference printed on
    /// the invoice; a standing order by vendor, once per period. Returns the order id and whether one covered it.
    /// The order that would cover this invoice, with its consumption applied on the returned copy. Pure.
    fn find_order(&self, c: &InvoiceClaim) -> Option<Order> {
        let amount = c.amount.0;
        let reference = c.order_ref.as_deref().map(|r| r.trim().to_lowercase()).unwrap_or_default();
        let candidates: Vec<Order> = self.vendor_open_orders(&c.vendor_id);
        if !reference.is_empty() {
            let mut named = false;
            for mut o in candidates.iter().cloned() {
                if let OrderKind::Single { remaining } = &mut o.kind {
                    if o.reference.to_lowercase() == reference {
                        named = true;
                        if *remaining >= amount {
                            *remaining -= amount;
                            return Some(o);
                        }
                    }
                }
            }
            // the invoice names an order that cannot cover it: a standing order does not quietly take its place
            if named {
                return None;
            }
        }
        for mut o in candidates.into_iter() {
            if let OrderKind::Recurring { amount_per_period, period_days, last_period } = &mut o.kind {
                let period = Self::period_key(*period_days);
                if *amount_per_period >= amount && *last_period != Some(period) {
                    *last_period = Some(period);
                    return Some(o);
                }
            }
        }
        None
    }

    fn consume_order(&mut self, c: &InvoiceClaim) -> (Option<u64>, bool) {
        match self.find_order(c) {
            Some(o) => {
                let id = o.id;
                self.orders.insert(id, o);
                (Some(id), true)
            }
            None => (None, false),
        }
    }

    /// Calendar month for monthly orders, epoch-aligned periods otherwise.
    fn period_key(period_days: u32) -> u64 {
        Self::period_key_at(period_days, env::block_timestamp())
    }

    fn period_key_at(period_days: u32, ts: u64) -> u64 {
        if (28..=31).contains(&period_days) {
            Self::month_key_at(ts) as u64
        } else {
            ts / (DAY_NS * period_days as u64)
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
            _ => crate::fail(&format!("only the owner or an operator allowed to {what}")),
        }
    }

    /// Every string in a claim has a sensible size: the contract stores the claim and pays its storage.
    fn check_claim_size(c: &InvoiceClaim) {
        let ok = c.vendor_id.len() <= 64
            && c.invoice_number.len() <= 128
            && c.due_date.len() <= 32
            && c.invoice_hash.len() <= 128
            && c.attestation_ref.len() <= 512
            && c.flags.len() <= 16
            && c.flags.iter().all(|f| f.len() <= 64)
            && c.vendor_tax_id.len() <= 64
            && c.buyer_tax_id.len() <= 64
            && c.order_ref.as_ref().map_or(true, |r| r.len() <= 128)
            && match &c.payout_seen {
                Payout::Near { .. } => true,
                Payout::Chain { chain, address } => chain.len() <= 32 && address.len() <= 256,
            };
        require!(ok, "claim field too long");
    }

    /// A (day, count) pair in raw storage.
    fn daily_count(&self, key: &[u8]) -> u32 {
        let day = Self::day_key();
        env::storage_read(key)
            .and_then(|b| b.try_into().ok())
            .map(|b: [u8; 12]| (u64::from_le_bytes(b[..8].try_into().unwrap()), u32::from_le_bytes(b[8..].try_into().unwrap())))
            .filter(|(d, _)| *d == day)
            .map(|(_, n)| n)
            .unwrap_or(0)
    }

    /// Count one more today, or refuse with `why` when the quota is spent (nothing is stored then).
    fn bump_daily(&self, key: &[u8], max: u32, why: &str) {
        let n = self.daily_count(key);
        require!(n < max, why);
        let mut b = [0u8; 12];
        b[..8].copy_from_slice(&Self::day_key().to_le_bytes());
        b[8..].copy_from_slice(&(n + 1).to_le_bytes());
        env::storage_write(key, &b);
    }

    /// NEAR above the storage stake.
    fn liquid_near(&self) -> u128 {
        let staked = env::storage_usage() as u128 * env::storage_byte_cost().as_yoctonear();
        env::account_balance().as_yoctonear().saturating_sub(staked)
    }

    /// Liquid NEAR above the storage stake covers the DAO bond plus headroom.
    fn can_pay_bond(&self) -> bool {
        self.liquid_near() >= self.dao_bond.as_yoctonear().saturating_add(NEAR_HEADROOM)
    }

    /// Cut a string to at most `n` bytes on a character boundary.
    fn clip(s: &mut String, n: usize) {
        if s.len() > n {
            let mut cut = n;
            while !s.is_char_boundary(cut) {
                cut -= 1;
            }
            s.truncate(cut);
        }
    }

    fn key(prefix: &[u8], rest: &[u8]) -> Vec<u8> {
        [prefix, rest].concat()
    }

    /// The snapshot and the proposal's DAO are only read while the payment can still move: drop them after.
    fn forget_payment_keys(&self, id: u64) {
        env::storage_remove(&Self::key(PAYOUT_SNAPSHOT_PREFIX, &id.to_le_bytes()));
        env::storage_remove(&Self::key(PAYMENT_DAO_PREFIX, &id.to_le_bytes()));
    }

    fn set_payout_snapshot(&self, id: u64, payout: &Payout) {
        env::storage_write(&Self::key(PAYOUT_SNAPSHOT_PREFIX, &id.to_le_bytes()), &near_sdk::borsh::to_vec(payout).unwrap());
    }

    fn payout_snapshot(&self, id: u64) -> Option<Payout> {
        env::storage_read(&Self::key(PAYOUT_SNAPSHOT_PREFIX, &id.to_le_bytes())).and_then(|b| near_sdk::borsh::from_slice(&b).ok())
    }

    fn payment_dao(&self, id: u64) -> Option<AccountId> {
        env::storage_read(&Self::key(PAYMENT_DAO_PREFIX, &id.to_le_bytes())).and_then(|b| String::from_utf8(b).ok()).and_then(|s| s.parse().ok())
    }

    fn set_unconfirmed(&self, vendor_id: &str, unconfirmed: bool) {
        let k = Self::key(UNCONFIRMED_PREFIX, vendor_id.as_bytes());
        if unconfirmed { env::storage_write(&k, b"1"); } else { env::storage_remove(&k); }
    }

    fn is_unconfirmed(&self, vendor_id: &str) -> bool {
        env::storage_has_key(&Self::key(UNCONFIRMED_PREFIX, vendor_id.as_bytes()))
    }

    /// What the company may spend: the balance minus the tax it holds for the state.
    fn spendable(&self) -> u128 {
        self.balance.saturating_sub(self.withheld_due)
    }

    fn in_flight(&self) -> u128 {
        env::storage_read(IN_FLIGHT_KEY).and_then(|b| b.try_into().ok()).map(u128::from_le_bytes).unwrap_or(0)
    }

    fn set_in_flight(&self, v: u128) {
        env::storage_write(IN_FLIGHT_KEY, &v.to_le_bytes());
    }

    fn ft_transfer(&self, to: AccountId, amount: u128, memo: String) -> Promise {
        self.set_in_flight(self.in_flight() + amount);
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
        Self::month_key_at(env::block_timestamp())
    }

    fn month_key_at(ts: u64) -> u32 {
        let days = (ts / DAY_NS) as i64;
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

    /// "AH-0923", "ah 0923" and "AH0923." are the same invoice: letters and digits only, uppercase.
    fn invoice_key(vendor_id: &str, invoice_number: &str) -> String {
        format!("{}|{}", vendor_id.to_lowercase(), Self::norm_id(invoice_number))
    }

    /// The key contracts wrote before the normalization above; still checked, so old payments stay duplicates.
    fn old_invoice_key(vendor_id: &str, invoice_number: &str) -> String {
        format!("{}|{}", vendor_id.to_lowercase(), invoice_number.trim().to_lowercase())
    }

    fn hash_seen(&self, hash: &str) -> bool {
        let h = Self::norm_id(hash);
        !h.is_empty() && env::storage_has_key(&Self::key(HASH_INDEX_PREFIX, h.as_bytes()))
    }

    fn set_hash_seen(&self, hash: &str, seen: bool) {
        let h = Self::norm_id(hash);
        if h.is_empty() {
            return;
        }
        let k = Self::key(HASH_INDEX_PREFIX, h.as_bytes());
        if seen { env::storage_write(&k, b"1"); } else { env::storage_remove(&k); }
    }

    // ----- preview -----

    /// What `request_payment` would answer for this claim right now, without recording anything: the same checks,
    /// in the same order, on the same state. The console shows it before a person presses the button.
    pub fn preview_payment(&self, claim: InvoiceClaim) -> Preview {
        match self.decide(&claim) {
            Err(reason) => Preview { status: Status::Blocked, reason: Some(reason), withheld: U128(0), order_id: None },
            Ok(()) => {
                let order = self.find_order(&claim);
                let (holds, withheld) = self.holds(&claim, order.is_some());
                // the caller's hold quota, as request_payment would apply it (a view has no predecessor: the agent's)
                if !holds.is_empty() && self.daily_count(&Self::key(HOLDS_TODAY_KEY, self.agent.as_bytes())) >= HOLDS_PER_DAY {
                    return Preview { status: Status::Blocked, reason: Some("hold_quota_reached".into()), withheld: U128(0), order_id: None };
                }
                let paid = match self.vendors.get(&claim.vendor_id).map(|v| &v.payout) {
                    Some(Payout::Near { .. }) => Status::Paid,
                    _ => Status::Queued,
                };
                Preview {
                    status: if holds.is_empty() { paid } else { Status::Approval },
                    reason: if holds.is_empty() { None } else { Some(holds.join("+")) },
                    withheld: U128(withheld),
                    order_id: order.map(|o| o.id),
                }
            }
        }
    }

    // ----- upgrade: the owner replaces the code, no treasury key needed -----

    /// Deploy a new build of this contract. The owner signs it from the console with the wallet; a treasury created
    /// from a browser has no full-access key anywhere, so this is the only way its code moves. The state is kept:
    /// every build so far reads the previous layout (new data lives in raw storage keys, see `set_vault`).
    pub fn upgrade(&mut self, code: Base64VecU8) -> Promise {
        self.assert_owner();
        require!(code.0.len() > 1024, "that is not a contract");
        self.emit("upgrade", &code.0.len().to_string());
        // deploy, then let the new code bring the state to its own layout in the same batch
        Promise::new(env::current_account_id())
            .deploy_contract(code.0)
            .function_call(String::from("migrate"), Vec::new(), NearToken::from_yoctonear(0), Gas::from_gas(env::prepaid_gas().as_gas().saturating_sub(env::used_gas().as_gas()).saturating_sub(UPGRADE_RESERVE)))
    }

    /// Bring the stored state to this build's layout. Idempotent: a state already in this layout is returned as it is;
    /// the October 20 layout (vendors without tax ids and withholding, payments without `withheld`, company without
    /// tax id, no `withheld_due`) is rewritten entry by entry. Called by `upgrade` right after the deploy.
    #[private]
    #[init(ignore_state)]
    pub fn migrate() -> Self {
        let raw = env::storage_read(b"STATE").unwrap_or_else(|| crate::fail("no state to migrate"));
        let mut current: Bursar = near_sdk::borsh::from_slice(&raw).unwrap_or_else(|_| crate::fail("unknown state layout: builds before 20 October 2026 upgrade through build 17 first"));
        current.index_once();
        current
    }

    /// Contracts from before the per-vendor order index and the normalized invoice keys: build both once.
    fn index_once(&mut self) {
        if env::storage_has_key(ORDERS_INDEXED_KEY) {
            return;
        }
        let mut by_vendor: std::collections::BTreeMap<String, Vec<u64>> = std::collections::BTreeMap::new();
        for (k, _) in self.vendors.iter() {
            by_vendor.entry(k.clone()).or_default();
        }
        for (id, o) in self.orders.iter() {
            if o.active {
                by_vendor.entry(o.vendor_id.clone()).or_default().push(*id);
            }
        }
        for (vendor, ids) in by_vendor {
            env::storage_write(&Self::key(VENDOR_ORDERS_PREFIX, vendor.as_bytes()), &near_sdk::borsh::to_vec(&ids).unwrap());
        }
        let live: Vec<(String, String)> = self.payments.iter().filter(|(_, p)| matches!(p.status, Status::Paid | Status::Settled | Status::Queued | Status::Approval | Status::Settling)).map(|(_, p)| (p.vendor_id.clone(), p.invoice_number.clone())).collect();
        for (vendor, number) in live {
            if !Self::norm_id(&number).is_empty() {
                self.invoice_index.insert(Self::invoice_key(&vendor, &number));
            }
        }
        env::storage_write(ORDERS_INDEXED_KEY, b"1");
        self.emit("indexed", "");
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
        // quotes, backslashes and control characters are escaped: a vendor id or a quote id cannot forge another event
        log!("EVENT_JSON:{{\"standard\":\"{}\",\"version\":\"{}\",\"event\":\"{}\",\"data\":\"{}\"}}", EVENT_STANDARD, EVENT_VERSION, event, Self::json_escape(data));
    }

    fn json_escape(s: &str) -> String {
        let mut out = String::with_capacity(s.len());
        for c in s.chars() {
            match c {
                '"' => out.push_str("\\\""),
                '\\' => out.push_str("\\\\"),
                '\n' => out.push_str("\\n"),
                '\r' => out.push_str("\\r"),
                '\t' => out.push_str("\\t"),
                c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
                c => out.push(c),
            }
        }
        out
    }
}

/// The stored layouts of the October 20 build, read once by `migrate` and never written again.
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
            // one file per invoice: the hash follows the number (a shared hash would be a duplicate now)
            invoice_hash: format!("{:0>8}{}", vendor.len(), number.chars().filter(|c| c.is_ascii_alphanumeric()).collect::<String>()),
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
        c.offer_ownership(accounts(5));
        assert_eq!(c.get_roles().0, accounts(0), "an offer changes nothing yet");
        assert_eq!(c.get_ownership_offer(), Some(accounts(5)));
        testing_env!(ctx(accounts(4)).build());
        let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| c.accept_ownership()));
        assert!(r.is_err(), "only the account the offer names can accept");
        testing_env!(ctx(accounts(5)).build());
        c.accept_ownership();
        assert_eq!(c.get_roles().0, accounts(5));
        assert_eq!(c.get_ownership_offer(), None);
        testing_env!(ctx(accounts(0)).build());
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
        testing_env!(ctx(accounts(0)).build());
        c.set_quote_signer(Some(test_signer()));
        let payload = quote_payload("0xevil", 1_250_000_000, 1_240_000_000, DEP, LATER, "base");
        let sig = sign_payload(&payload);
        testing_env!(ctx(accounts(2)).account_balance(NearToken::from_near(2)).build());
        let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| { let _ = c.settle(id, payload, sig); }));
        assert!(r.is_err(), "a signed quote for another address is not the vendor's");
        assert_eq!(c.get_payment(id).unwrap().status, Status::Queued);
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



    // ----- audit round two: one test per finding -----

    fn plain() -> Bursar {
        testing_env!(ctx(accounts(0)).build());
        let mut c = Bursar::new(accounts(0), accounts(1), accounts(2), None, accounts(4), U128(5_000_000_000), U128(20_000_000_000), U128(2_000_000_000));
        c.add_vendor("hosting".into(), "Acme Hosting".into(), Payout::Near { account: accounts(5) }, U128(10_000_000_000), None, None, None);
        c.add_vendor("design".into(), "DesignCo".into(), Payout::Chain { chain: "base".into(), address: "0xabc".into() }, U128(0), None, None, None);
        testing_env!(ctx(accounts(4)).build());
        let _ = c.ft_on_transfer(accounts(0), U128(50_000_000_000), "".into());
        c
    }
    const T0: u64 = 1_760_000_000_000_000_000;
    fn near(a: AccountId) -> Payout { Payout::Near { account: a } }
    /// The executor settles `id` on a quote signed by the test key for the vendor's address and the net amount.
    /// Leaves the context on the executor. Returns Err when the contract refused it.
    fn settle_signed(c: &mut Bursar, id: u64) -> std::thread::Result<()> {
        let p = c.get_payment(id).unwrap();
        let v = c.get_vendor(p.vendor_id.clone()).unwrap();
        let (chain, address) = match v.payout { Payout::Chain { chain, address } => (chain, address), _ => panic!("not a cross-chain vendor") };
        let net = p.amount - p.withheld;
        testing_env!(ctx(accounts(0)).build());
        c.set_quote_signer(Some(test_signer()));
        let payload = quote_payload(&address, net, net - net / 100, DEP, LATER, &chain);
        let sig = sign_payload(&payload);
        testing_env!(ctx(accounts(2)).account_balance(NearToken::from_near(2)).build());
        std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| { let _ = c.settle(id, payload, sig); }))
    }

    #[test]
    fn audit_cancelling_yesterdays_hold_does_not_free_todays_cap() {
        let mut c = plain();
        testing_env!(ctx(accounts(0)).build());
        c.update_vendor("hosting".into(), None, Some(U128(0)), None, None, None, None);
        testing_env!(ctx(accounts(1)).build());
        let h = c.request_payment(claim("hosting", "H", 4_999_000_000, near(accounts(5))));
        assert_eq!(c.get_payment(h).unwrap().status, Status::Approval);
        let t1 = T0 + DAY_NS;
        testing_env!(ctx(accounts(1)).block_timestamp(t1).build());
        for i in 0..5 { c.request_payment(claim("hosting", &format!("D{i}"), 1_999_000_000, near(accounts(5)))); }
        assert_eq!(c.get_stats().spent_today.0, 5 * 1_999_000_000);
        testing_env!(ctx(accounts(0)).block_timestamp(t1).build());
        c.cancel_payment(h);
        assert_eq!(c.get_stats().spent_today.0, 5 * 1_999_000_000, "a day-1 hold must not reduce day-2 spend");
        // monthly: a hold from October cancelled in November leaves November's budget alone
        let mut c = plain();
        testing_env!(ctx(accounts(1)).build());
        let h = c.request_payment(claim("hosting", "M", 4_999_000_000, near(accounts(5))));
        let t2 = T0 + 30 * DAY_NS;
        testing_env!(ctx(accounts(1)).block_timestamp(t2).build());
        c.request_payment(claim("hosting", "N", 1_000_000_000, near(accounts(5))));
        testing_env!(ctx(accounts(0)).block_timestamp(t2).build());
        c.cancel_payment(h);
        assert_eq!(c.get_vendor("hosting".into()).unwrap().spent_this_month, 1_000_000_000);
    }

    #[test]
    fn audit_many_small_invoices_meet_a_person() {
        let mut c = plain();
        testing_env!(ctx(accounts(1)).build());
        for i in 0..5 { let id = c.request_payment(claim("hosting", &format!("S{i}"), 100_000_000, near(accounts(5)))); assert_eq!(c.get_payment(id).unwrap().status, Status::Paid); }
        let sixth = c.request_payment(claim("hosting", "S5", 100_000_000, near(accounts(5))));
        let p = c.get_payment(sixth).unwrap();
        assert_eq!(p.status, Status::Approval);
        assert_eq!(p.reason.as_deref(), Some("many_invoices"));
        // the next day the allowance is back
        testing_env!(ctx(accounts(1)).block_timestamp(T0 + DAY_NS).build());
        let id = c.request_payment(claim("hosting", "S6", 100_000_000, near(accounts(5))));
        assert_eq!(c.get_payment(id).unwrap().status, Status::Paid);
    }

    #[test]
    fn audit_refunded_settlement_goes_back_to_the_queue() {
        let mut c = plain();
        testing_env!(ctx(accounts(0)).build());
        let pay = Payout::Chain { chain: "base".into(), address: "0xabc".into() };
        testing_env!(ctx(accounts(1)).build());
        let id = c.request_payment(claim("design", "1107", 1_250_000_000, pay.clone()));
        testing_env!(ctx(accounts(2)).build());
        let _ = settle_signed(&mut c, id);
        assert_eq!(c.get_stats().balance.0, 50_000_000_000 - 1_250_000_000);
        testing_env!(as_self().build());
        assert!(c.on_ft_transfer(Some(id), U128(1_250_000_000), Ok(())));
        // the executor says Intents refunded; the token has not seen the money back: nothing moves
        testing_env!(ctx(accounts(2)).build());
        let _ = c.mark_settlement_failed(id);
        testing_env!(as_self().build());
        let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| c.on_settlement_failed(id, Ok(U128(50_000_000_000 - 1_250_000_000)))));
        assert!(r.is_err(), "no refund on the account, no second chance");
        assert_eq!(c.get_payment(id).unwrap().status, Status::Settling);
        testing_env!(ctx(accounts(2)).build());
        let r = settle_signed(&mut c, id);
        assert!(r.is_err(), "still settling: cannot be paid twice");
        // the refund lands (plain transfer): now the token says so; the books take this payment's net back, and a
        // person decides whether it goes out again: on chain a refund and a deposit look the same
        testing_env!(as_self().build());
        assert!(c.on_settlement_failed(id, Ok(U128(50_000_000_000))));
        let p = c.get_payment(id).unwrap();
        assert_eq!(p.status, Status::Approval);
        assert_eq!(p.reason.as_deref(), Some("settlement_failed"));
        assert_eq!(c.get_stats().balance.0, 50_000_000_000);
        testing_env!(ctx(accounts(2)).build());
        let r = settle_signed(&mut c, id);
        assert!(r.is_err(), "the executor alone cannot send it again");
        testing_env!(ctx(accounts(0)).build());
        c.cancel_payment(id);
        testing_env!(ctx(accounts(1)).build());
        let again = c.request_payment(claim("design", "1107", 1_250_000_000, pay));
        assert_eq!(c.get_payment(again).unwrap().status, Status::Queued, "the invoice is free again");
    }

    #[test]
    fn audit3_approval_and_settle_check_the_gross() {
        let mut c = plain();
        testing_env!(ctx(accounts(0)).build());
        c.add_vendor("consultant".into(), "Studio".into(), near(accounts(5)), U128(0), None, None, Some(2000));
        testing_env!(ctx(accounts(1)).build());
        let id = c.request_payment(claim("consultant", "C-1", 3_000_000_000, near(accounts(5))));
        assert_eq!(c.get_payment(id).unwrap().status, Status::Approval);
        testing_env!(ctx(accounts(0)).build());
        let _ = c.withdraw(U128(47_500_000_000));
        assert_eq!(c.get_stats().balance.0, 2_500_000_000);
        let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| c.approve_payment(id)));
        assert!(r.is_err(), "gross 3000 > spendable 2500");
        let s = c.get_stats();
        assert!(s.withheld_due.0 <= s.balance.0);
    }

    #[test]
    fn audit3_cancelling_last_periods_hold_does_not_free_this_period() {
        let mut c = no_dao();
        c.add_recurring_order("hosting".into(), "server, monthly".into(), U128(3_000_000_000), 30, None);
        testing_env!(ctx(accounts(1)).build());
        let a = c.request_payment(claim("hosting", "OCT", 2_500_000_000, near(accounts(5))));
        assert_eq!(c.get_payment(a).unwrap().reason.as_deref(), Some("over_threshold"));
        let nov = T0 + 35 * DAY_NS;
        testing_env!(ctx(accounts(1)).block_timestamp(nov).build());
        let b = c.request_payment(claim("hosting", "NOV1", 400_000_000, near(accounts(5))));
        assert_eq!(c.get_payment(b).unwrap().status, Status::Paid);
        testing_env!(ctx(accounts(0)).block_timestamp(nov).build());
        c.cancel_payment(a);
        testing_env!(ctx(accounts(1)).block_timestamp(nov).build());
        let d = c.request_payment(claim("hosting", "NOV2", 400_000_000, near(accounts(5))));
        assert_eq!(c.get_payment(d).unwrap().reason.as_deref(), Some("no_order"));
    }

    #[test]
    fn audit3_two_refunds_are_both_taken_back_and_a_deposit_is_not_a_refund() {
        let mut c = plain();
        testing_env!(ctx(accounts(0)).build());
        let pay = Payout::Chain { chain: "base".into(), address: "0xabc".into() };
        testing_env!(ctx(accounts(1)).build());
        let a = c.request_payment(claim("design", "A", 1_250_000_000, pay.clone()));
        let b = c.request_payment(claim("design", "B", 1_000_000_000, pay.clone()));
        testing_env!(ctx(accounts(2)).build());
        let _ = settle_signed(&mut c, a);
        testing_env!(as_self().build());
        assert!(c.on_ft_transfer(Some(a), U128(1_250_000_000), Ok(())));
        testing_env!(ctx(accounts(2)).build());
        let _ = settle_signed(&mut c, b);
        testing_env!(as_self().build());
        assert!(c.on_ft_transfer(Some(b), U128(1_000_000_000), Ok(())));
        // both refunded: the token holds everything again; each callback takes back its own net only
        assert!(c.on_settlement_failed(a, Ok(U128(50_000_000_000))));
        assert_eq!(c.get_stats().balance.0, 50_000_000_000 - 1_000_000_000);
        assert!(c.on_settlement_failed(b, Ok(U128(50_000_000_000))), "B's refund is on the account too");
        assert_eq!(c.get_payment(b).unwrap().status, Status::Approval);
        assert_eq!(c.get_stats().balance.0, 50_000_000_000);
        // a plain deposit while a settlement is delivering passes the token check, but the executor still cannot resend
        testing_env!(ctx(accounts(0)).build());
        c.approve_payment(a);
        assert_eq!(c.get_payment(a).unwrap().status, Status::Queued);
        testing_env!(ctx(accounts(2)).build());
        let _ = settle_signed(&mut c, a);
        testing_env!(as_self().build());
        assert!(c.on_ft_transfer(Some(a), U128(1_250_000_000), Ok(())));
        assert!(c.on_settlement_failed(a, Ok(U128(50_000_000_000 + 2_000_000_000))), "a 2,000 deposit passes for the refund");
        assert_eq!(c.get_payment(a).unwrap().status, Status::Approval, "but a person decides, not the executor");
        testing_env!(ctx(accounts(2)).build());
        let r = settle_signed(&mut c, a);
        assert!(r.is_err());
    }

    #[test]
    fn audit3_owner_closes_a_settlement_nobody_can_finish() {
        let mut c = plain();
        testing_env!(ctx(accounts(0)).build());
        let pay = Payout::Chain { chain: "base".into(), address: "0xabc".into() };
        testing_env!(ctx(accounts(1)).build());
        let id = c.request_payment(claim("design", "1107", 1_250_000_000, pay.clone()));
        testing_env!(ctx(accounts(2)).build());
        let _ = settle_signed(&mut c, id);
        testing_env!(as_self().build());
        assert!(c.on_ft_transfer(Some(id), U128(1_250_000_000), Ok(())));
        // the refund was counted by a sync first: the token check can never pass again
        assert_eq!(c.on_sync_balance(Ok(U128(50_000_000_000))).0, 50_000_000_000);
        let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| c.on_settlement_failed(id, Ok(U128(50_000_000_000)))));
        assert!(r.is_err());
        testing_env!(ctx(accounts(2)).build());
        let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| c.close_settlement(id, false)));
        assert!(r.is_err(), "owner only");
        testing_env!(ctx(accounts(0)).build());
        c.close_settlement(id, false);
        assert_eq!(c.get_payment(id).unwrap().status, Status::Cancelled);
        assert_eq!(c.get_stats().balance.0, 50_000_000_000, "the books were already right");
        testing_env!(ctx(accounts(1)).build());
        let again = c.request_payment(claim("design", "1107", 1_250_000_000, pay));
        assert_eq!(c.get_payment(again).unwrap().status, Status::Queued, "the invoice number is free again");
    }

    #[test]
    fn audit3_roles_stay_separate() {
        let mut c = plain();
        testing_env!(ctx(accounts(0)).build());
        c.add_operator(accounts(3), Role { approve: true, manage_vendors: false, manage_orders: false });
        let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| c.set_roles(Some(accounts(3)), None, None, None)));
        assert!(r.is_err(), "an approver cannot become the agent");
        let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| c.set_roles(None, Some(accounts(0)), None, None)));
        assert!(r.is_err(), "the owner cannot be the executor");
        let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| c.set_roles(None, None, Some(accounts(1)), None)));
        assert!(r.is_err(), "the agent cannot be the dao");
        c.set_roles(Some(accounts(4)), None, None, None);
        assert_eq!(c.get_roles().1, accounts(4));
    }

    #[test]
    fn audit3_an_invoice_over_its_purchase_order_is_not_covered_by_the_standing_order() {
        let mut c = no_dao();
        let po = c.add_order("hosting".into(), "PO-7".into(), "one-off".into(), U128(100_000_000), None);
        let so = c.add_recurring_order("hosting".into(), "monthly server".into(), U128(1_000_000_000), 30, None);
        testing_env!(ctx(accounts(1)).build());
        let id = c.request_payment(with_ref(claim("hosting", "X1", 500_000_000, near(accounts(5))), "PO-7"));
        let p = c.get_payment(id).unwrap();
        assert_eq!(p.status, Status::Approval);
        assert_eq!(p.reason.as_deref(), Some("no_order"));
        assert_eq!(c.get_order(po).unwrap().kind, OrderKind::Single { remaining: 100_000_000 });
        // without a reference the standing order still covers a normal invoice
        let id2 = c.request_payment(claim("hosting", "X2", 500_000_000, near(accounts(5))));
        assert_eq!(c.get_payment(id2).unwrap().order_id, Some(so));
    }

    #[test]
    fn audit3_an_operator_cannot_undo_the_owners_vendor_controls() {
        let mut c = plain();
        testing_env!(ctx(accounts(0)).build());
        c.add_operator(accounts(3), Role { approve: false, manage_vendors: true, manage_orders: false });
        c.update_vendor("hosting".into(), None, Some(U128(1_000_000_000)), Some(false), Some("PT123".into()), None, Some(2000));
        testing_env!(ctx(accounts(3)).build());
        for (active, tax, bps) in [(Some(true), None, None), (None, Some("".to_string()), None), (None, None, Some(0))] {
            let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| c.update_vendor("hosting".into(), None, None, active, tax.clone(), None, bps)));
            assert!(r.is_err());
        }
        c.update_vendor("hosting".into(), None, Some(U128(0)), None, None, None, None); // the budget it may change
        c.update_vendor("hosting".into(), None, None, Some(false), None, None, None); // and switch off
        assert!(!c.get_vendor("hosting".into()).unwrap().active);
    }

    #[test]
    fn audit3_numberless_invoices_are_told_apart_by_their_file() {
        let mut c = plain();
        testing_env!(ctx(accounts(1)).build());
        let mut a = claim("hosting", "", 100_000_000, near(accounts(5))); a.invoice_hash = "file-one".into();
        let mut b = claim("hosting", "", 100_000_000, near(accounts(5))); b.invoice_hash = "file-two".into();
        let mut a2 = claim("hosting", "", 100_000_000, near(accounts(5))); a2.invoice_hash = "file-one".into();
        let ia = c.request_payment(a);
        assert_eq!(c.get_payment(ia).unwrap().status, Status::Paid);
        let ib = c.request_payment(b);
        assert_eq!(c.get_payment(ib).unwrap().status, Status::Paid, "a different file is a different invoice");
        let ia2 = c.request_payment(a2);
        assert_eq!(c.get_payment(ia2).unwrap().reason.as_deref(), Some("duplicate_invoice"), "the same file is the same invoice");
    }

    #[test]
    fn audit3_a_held_claim_is_stored_small_too() {
        let mut c = plain();
        testing_env!(ctx(accounts(1)).build());
        let mut cl = claim("hosting", &"n".repeat(128), 1, near(accounts(5)));
        cl.invoice_hash = "h".repeat(128); cl.attestation_ref = "a".repeat(512); cl.flags = vec!["f".repeat(64); 16];
        let id = c.request_payment(cl);
        let p = c.get_payment(id).unwrap();
        assert_eq!(p.status, Status::Approval);
        assert_eq!(p.attestation_ref.len(), STORED_REF);
        assert_eq!(p.flags.len(), STORED_FLAGS);
    }

    #[test]
    fn audit3_dao_failure_and_rejection_drop_the_payment_keys() {
        let mut c = setup();
        let id = approval_payment(&mut c);
        assert!(c.payment_dao(id).is_some() && c.payout_snapshot(id).is_some());
        testing_env!(as_self().build());
        c.on_dao_proposal(id, Err(PromiseError::Failed));
        assert!(c.payment_dao(id).is_none() && c.payout_snapshot(id).is_none(), "a blocked payment keeps no raw keys");
    }

    #[test]
    fn audit3_withholding_tolerance_is_rounding_not_a_percent() {
        let mut c = plain();
        testing_env!(ctx(accounts(0)).build());
        c.add_vendor("consultant".into(), "Studio".into(), near(accounts(5)), U128(0), None, None, Some(2000));
        testing_env!(ctx(accounts(1)).build());
        let mut cl = claim("consultant", "W1", 1_000_000_000, near(accounts(5))); cl.withholding_seen = U128(190_000_000); // 190 instead of 200 on a 1,000 invoice
        let id = c.request_payment(cl);
        assert!(c.get_payment(id).unwrap().reason.unwrap().contains("withholding_mismatch"), "ten USDC off is not rounding");
        let mut cl = claim("consultant", "W2", 1_000_000_000, near(accounts(5))); cl.withholding_seen = U128(199_950_000);
        let id = c.request_payment(cl);
        assert_eq!(c.get_payment(id).unwrap().status, Status::Paid, "five cents is rounding");
    }

    #[test]
    fn audit3_order_index_covers_every_vendor_after_migrate() {
        let mut c = plain();
        testing_env!(ctx(accounts(0)).build());
        for i in 0..5 { let id = c.add_order("hosting".into(), format!("PO-{i}"), "".into(), U128(1_000_000), None); c.close_order(id); }
        assert!(env::storage_has_key(&Bursar::key(VENDOR_ORDERS_PREFIX, b"design")), "a vendor that never had an order has an empty index");
        assert!(c.vendor_order_ids("design").is_empty());
        assert!(c.vendor_order_ids("nobody").is_empty(), "an unknown vendor scans nothing");
    }

    #[test]
    fn audit_withheld_tax_is_not_spendable() {
        let mut c = plain();
        testing_env!(ctx(accounts(0)).build());
        c.add_vendor("consultant".into(), "Studio".into(), near(accounts(5)), U128(0), None, None, Some(2000));
        c.set_limits(U128(50_000_000_000), U128(0), U128(100_000_000_000));
        c.update_vendor("hosting".into(), None, Some(U128(0)), None, None, None, None);
        testing_env!(ctx(accounts(1)).build());
        c.request_payment(claim("consultant", "C-1", 10_000_000_000, near(accounts(5))));
        assert_eq!(c.get_stats().withheld_due.0, 2_000_000_000);
        assert_eq!(c.get_stats().balance.0, 42_000_000_000);
        let id = c.request_payment(claim("hosting", "H-1", 41_000_000_000, near(accounts(5))));
        assert_eq!(c.get_payment(id).unwrap().reason.as_deref(), Some("insufficient_treasury"), "the state's 2000 are not the company's");
        let id = c.request_payment(claim("hosting", "H-2", 40_000_000_000, near(accounts(5))));
        assert_eq!(c.get_payment(id).unwrap().status, Status::Paid);
        testing_env!(ctx(accounts(0)).build());
        let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| c.withdraw(U128(1_000_000_000))));
        assert!(r.is_err(), "withdraw cannot touch the withheld tax");
        let _ = c.remit_withholding(U128(2_000_000_000));
        assert_eq!(c.get_stats().withheld_due.0, 0);
        assert_eq!(c.get_stats().balance.0, 0);
        // a failed remittance puts both back
        testing_env!(as_self().build());
        assert!(!c.on_remit(U128(2_000_000_000), Err(PromiseError::Failed)));
        assert_eq!(c.get_stats().withheld_due.0, 2_000_000_000);
        assert_eq!(c.get_stats().balance.0, 2_000_000_000);
    }

    #[test]
    fn audit_executor_cannot_choose_the_deposit_account() {
        let mut c = plain();
        let pay = Payout::Chain { chain: "base".into(), address: "0xabc".into() };
        testing_env!(ctx(accounts(1)).build());
        let id = c.request_payment(claim("design", "1107", 1_250_000_000, pay.clone()));
        testing_env!(ctx(accounts(0)).build());
        c.set_quote_signer(Some(test_signer()));
        // the executor's own account, or any named account, as the deposit address: refused even under a valid signature
        for dep in ["bob.near", "deposit1.intents.near", "7edc23480a02bf440881022d5274c80d9fd53064cff1202c0d98af2bbdba43fd.near"] {
            let payload = quote_payload("0xabc", 1_250_000_000, 1_240_000_000, dep, LATER, "base");
            let sig = sign_payload(&payload);
            testing_env!(ctx(accounts(2)).account_balance(NearToken::from_near(2)).build());
            let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| { let _ = c.settle(id, payload, sig); }));
            assert!(r.is_err(), "{dep}: only an implicit account 1Click derived can receive the USDC");
        }
        assert_eq!(c.get_payment(id).unwrap().status, Status::Queued);
        assert_eq!(c.get_stats().balance.0, 50_000_000_000);
        assert!(settle_signed(&mut c, id).is_ok());
        let p = c.get_payment(id).unwrap();
        assert_eq!(p.status, Status::Settling);
        assert_eq!(p.deposit_address.as_deref(), Some(DEP));
    }

    #[test]
    fn audit_settle_honours_pause_and_deactivation() {
        let mut c = plain();
        testing_env!(ctx(accounts(0)).build());
        let pay = Payout::Chain { chain: "base".into(), address: "0xabc".into() };
        testing_env!(ctx(accounts(1)).build());
        let id = c.request_payment(claim("design", "Q1", 1_000_000_000, pay.clone()));
        testing_env!(ctx(accounts(0)).build());
        c.set_paused(true);
        testing_env!(ctx(accounts(2)).build());
        let r = settle_signed(&mut c, id);
        assert!(r.is_err());
        assert_eq!(c.get_payment(id).unwrap().status, Status::Queued);
    }

    #[test]
    fn audit_payout_changed_after_the_hold_is_not_paid() {
        let mut c = plain();
        testing_env!(ctx(accounts(1)).build());
        let id = c.request_payment(claim("hosting", "2210", 3_000_000_000, near(accounts(5))));
        assert_eq!(c.get_payment(id).unwrap().status, Status::Approval);
        testing_env!(ctx(accounts(0)).build());
        c.update_vendor("hosting".into(), Some(near(accounts(3))), None, None, None, None, None);
        let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| c.approve_payment(id)));
        assert!(r.is_err(), "the claim was checked against another payout");
        assert_eq!(c.get_payment(id).unwrap().status, Status::Approval);
        assert_eq!(c.get_stats().balance.0, 50_000_000_000);
    }

    #[test]
    fn audit_operator_payout_waits_for_the_owner() {
        let mut c = plain();
        testing_env!(ctx(accounts(0)).build());
        c.add_operator(accounts(3), Role { approve: true, manage_vendors: true, manage_orders: false });
        testing_env!(ctx(accounts(3)).build());
        c.add_vendor("me".into(), "Me".into(), near(accounts(3)), U128(0), None, None, None);
        let id = c.request_payment(claim("me", "1", 500_000_000, near(accounts(3))));
        let p = c.get_payment(id).unwrap();
        assert_eq!(p.status, Status::Approval);
        assert_eq!(p.reason.as_deref(), Some("payout_unconfirmed"));
        let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| c.approve_payment(id)));
        assert!(r.is_err(), "the same operator cannot approve it either");
        testing_env!(ctx(accounts(0)).build());
        c.confirm_vendor_payout("me".into());
        c.approve_payment(id);
        assert_eq!(c.get_payment(id).unwrap().status, Status::Paid);
        // an operator editing an existing payout puts the vendor back on hold
        testing_env!(ctx(accounts(3)).build());
        c.update_vendor("hosting".into(), Some(near(accounts(3))), None, None, None, None, None);
        let id = c.request_payment(claim("hosting", "7", 500_000_000, near(accounts(3))));
        assert_eq!(c.get_payment(id).unwrap().reason.as_deref(), Some("payout_unconfirmed"));
    }

    #[test]
    fn audit_agent_holds_and_requests_have_daily_quotas() {
        let mut c = plain();
        testing_env!(ctx(accounts(1)).build());
        let mut held = 0;
        for i in 0..80 {
            testing_env!(ctx(accounts(1)).build());
            let mut cl = claim("hosting", &format!("h{i}"), 1, near(accounts(5))); cl.flags = vec!["x".into()];
            let id = c.request_payment(cl);
            if c.get_payment(id).unwrap().status == Status::Approval { held += 1; } else { assert_eq!(c.get_payment(id).unwrap().reason.as_deref(), Some("hold_quota_reached")); }
        }
        assert_eq!(held, HOLDS_PER_DAY as usize);
        // the owner is not quota'd
        testing_env!(ctx(accounts(0)).build());
        let mut cl = claim("hosting", "owner-h", 1, near(accounts(5))); cl.flags = vec!["x".into()];
        { let id = c.request_payment(cl); assert_eq!(c.get_payment(id).unwrap().status, Status::Approval); }
        // requests overall
        let mut c = plain();
        testing_env!(ctx(accounts(1)).build());
        let mut ok = 0;
        for i in 0..(REQUESTS_PER_DAY + 20) {
            let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| c.request_payment(claim("nobody", &format!("r{i}"), 1, near(accounts(5))))));
            if r.is_ok() { ok += 1; }
        }
        assert!(ok <= BLOCKED_PER_DAY as usize, "refusals are capped first, got {ok}");
    }

    #[test]
    fn audit_no_dao_proposal_without_near_for_the_bond() {
        let mut c = setup(); // has a dao
        // below the NEAR floor the agent is refused outright: a stolen key cannot write the account dry
        let stake = env::storage_usage() as u128 * env::storage_byte_cost().as_yoctonear();
        testing_env!(ctx(accounts(1)).account_balance(NearToken::from_yoctonear(stake + NearToken::from_millinear(40).as_yoctonear())).build());
        let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| c.request_payment(claim("hosting", "dry", 1, near(accounts(5))))));
        assert!(r.is_err(), "the agent cannot spend the last NEAR");
        // above the floor but below bond plus headroom: the hold is recorded, no proposal
        testing_env!(ctx(accounts(1)).account_balance(NearToken::from_yoctonear(stake + NearToken::from_millinear(400).as_yoctonear())).build());
        let mut cl = claim("hosting", "poor", 1, near(accounts(5))); cl.flags = vec!["x".into()];
        let id = c.request_payment(cl);
        let p = c.get_payment(id).unwrap();
        assert_eq!(p.status, Status::Approval, "the hold is recorded");
        assert!(c.payment_dao(id).is_none(), "but no proposal was opened: the account could not pay the bond");
        // with NEAR back on the account, an approver opens it by hand
        testing_env!(ctx(accounts(0)).account_balance(NearToken::from_near(20)).build());
        c.open_dao_proposal_for(id);
        assert!(c.payment_dao(id).is_some());
        let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| c.open_dao_proposal_for(id)));
        assert!(r.is_err(), "once");
        // the agent's proposals are quota'd per day; the owner's are not
        let mut c = setup();
        testing_env!(ctx(accounts(1)).account_balance(NearToken::from_near(100)).build());
        let mut opened = 0;
        for i in 0..(DAO_PROPOSALS_PER_DAY + 5) {
            let mut cl = claim("hosting", &format!("q{i}"), 1, near(accounts(5))); cl.flags = vec!["x".into()];
            let id = c.request_payment(cl);
            if c.payment_dao(id).is_some() { opened += 1; }
        }
        assert_eq!(opened, DAO_PROPOSALS_PER_DAY);
    }

    #[test]
    fn audit_agent_flood_does_not_lock_out_operators() {
        let mut c = plain();
        testing_env!(ctx(accounts(0)).build());
        c.add_operator(accounts(3), Role { approve: true, manage_vendors: false, manage_orders: false });
        testing_env!(ctx(accounts(1)).build());
        // the mock VM allows 100 logs per context: a fresh context per call
        for i in 0..(BLOCKED_PER_DAY + 5) { testing_env!(ctx(accounts(1)).build()); let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| c.request_payment(claim("nobody", &format!("f{i}"), 1, near(accounts(5)))))); }
        testing_env!(ctx(accounts(3)).build());
        let id = c.request_payment(claim("nobody", "op1", 1, near(accounts(5))));
        assert_eq!(c.get_payment(id).unwrap().reason.as_deref(), Some("unknown_vendor"), "an operator has its own quota");
        // a refused claim is stored small (the operator's quota is fresh), and nothing is recorded while paused
        testing_env!(ctx(accounts(3)).build());
        let mut cl = claim("nobody", &"n".repeat(128), 1, near(accounts(5))); cl.invoice_hash = "h".repeat(128); cl.attestation_ref = "a".repeat(512); cl.flags = vec!["f".repeat(64); 16];
        let id = c.request_payment(cl);
        let p = c.get_payment(id).unwrap();
        assert!(p.flags.len() <= 2 && p.attestation_ref.len() <= 64 && p.invoice_hash.len() <= 64);
        testing_env!(ctx(accounts(0)).build());
        c.set_paused(true);
        let before = c.get_stats().payments;
        let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| c.request_payment(claim("hosting", "paused1", 1, near(accounts(5))))));
        assert!(r.is_err());
        assert_eq!(c.get_stats().payments, before);
        assert_eq!(c.list_payments(Some(u64::MAX), None).len(), 0);
    }

    #[test]
    fn audit_operator_needs_a_role_and_ownership_has_limits() {
        let mut c = plain();
        testing_env!(ctx(accounts(0)).build());
        let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| c.add_operator(accounts(5), Role::default())));
        assert!(r.is_err());
        let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| c.offer_ownership(accounts(1))));
        assert!(r.is_err(), "not to the agent");
        let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| c.offer_ownership(accounts(2))));
        assert!(r.is_err(), "not to the executor");
        c.add_operator(accounts(3), Role { approve: true, manage_vendors: false, manage_orders: false });
        c.offer_ownership(accounts(3));
        c.cancel_ownership_offer();
        testing_env!(ctx(accounts(3)).build());
        let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| c.accept_ownership()));
        assert!(r.is_err(), "a cancelled offer cannot be accepted");
        testing_env!(ctx(accounts(0)).build());
        c.offer_ownership(accounts(3));
        testing_env!(ctx(accounts(3)).build());
        c.accept_ownership();
        assert!(c.list_operators().is_empty(), "the new owner is no longer an operator");
    }

    // ----- settle_quote: a quote 1Click signed, checked by the contract -----
    const TEST_SEED: [u8; 32] = [7u8; 32];
    fn quote_payload(recipient: &str, amount_in: u128, min_out: u128, deposit: &str, deadline: &str, chain: &str) -> String {
        let dest = USDC_ASSETS.iter().find(|(c, _)| *c == chain).map(|(_, a)| *a).unwrap_or("nep141:x");
        // the exact shape 1Click signs: request fields + quote fields + timestamp, keys sorted (json-stable-stringify)
        format!(
            "{{\"amount\":\"{amount_in}\",\"amountIn\":\"{amount_in}\",\"amountInFormatted\":\"x\",\"amountInUsd\":\"x\",\"amountOut\":\"{min_out}\",\"amountOutFormatted\":\"x\",\"amountOutUsd\":\"x\",\"deadline\":\"{deadline}\",\"depositAddress\":\"{deposit}\",\"depositType\":\"ORIGIN_CHAIN\",\"destinationAsset\":\"{dest}\",\"dry\":false,\"minAmountIn\":\"{amount_in}\",\"minAmountOut\":\"{min_out}\",\"originAsset\":\"nep141:{usdc}\",\"recipient\":\"{recipient}\",\"recipientType\":\"DESTINATION_CHAIN\",\"refundTo\":\"{me}\",\"refundType\":\"ORIGIN_CHAIN\",\"slippageTolerance\":50,\"swapType\":\"EXACT_INPUT\",\"timeEstimate\":22,\"timestamp\":\"2026-11-02T18:40:00.000Z\",\"withdrawFee\":\"2400\"}}",
            usdc = accounts(4), me = env::current_account_id()
        )
    }
    fn sign_payload(payload: &str) -> Base64VecU8 {
        use ed25519_dalek::Signer;
        let key = ed25519_dalek::SigningKey::from_bytes(&TEST_SEED);
        let message = bs58::encode(env::sha256(payload.as_bytes())).into_string();
        Base64VecU8(key.sign(message.as_bytes()).to_bytes().to_vec())
    }
    fn test_signer() -> Base64VecU8 {
        Base64VecU8(ed25519_dalek::SigningKey::from_bytes(&TEST_SEED).verifying_key().to_bytes().to_vec())
    }
    const DEP: &str = "b14472b888e01ed3280ea9fd390d138f655f98980f30a69160fea7704549ebc3";
    const LATER: &str = "2026-11-03T12:00:00.000Z";

    #[test]
    fn iso_timestamps_parse() {
        assert_eq!(iso_seconds("1970-01-01T00:00:00Z"), Some(0));
        assert_eq!(iso_seconds("2026-11-02T18:40:00.000Z"), Some(1_793_644_800));
        assert_eq!(iso_seconds("2026-11-02T18:40:00"), None);
        assert_eq!(iso_seconds("2026-13-02T18:40:00Z"), None);
    }

    #[test]
    fn settle_quote_pays_the_deposit_address_1click_signed_for_the_vendor() {
        let mut c = plain();
        testing_env!(ctx(accounts(0)).build());
        assert_eq!(c.get_quote_signer().0, ONE_CLICK_SIGNER.to_vec(), "1Click's key by default");
        c.set_quote_signer(Some(test_signer()));
        let pay = Payout::Chain { chain: "base".into(), address: "0xabc".into() };
        testing_env!(ctx(accounts(1)).build());
        let id = c.request_payment(claim("design", "1107", 1_250_000_000, pay.clone()));
        assert_eq!(c.get_payment(id).unwrap().status, Status::Queued);
        let payload = quote_payload("0xABC", 1_250_000_000, 1_240_000_000, DEP, LATER, "base");
        let sig = sign_payload(&payload);
        testing_env!(ctx(accounts(2)).account_balance(NearToken::from_near(2)).build());
        let _ = c.settle(id, payload.clone(), sig.clone());
        let p = c.get_payment(id).unwrap();
        assert_eq!(p.status, Status::Settling);
        assert_eq!(p.deposit_address.as_deref(), Some(DEP), "the deposit address comes from the signed quote, not from the executor");
        assert_eq!(c.in_flight(), 1_250_000_000);
        testing_env!(as_self().build());
        assert!(c.on_ft_transfer(Some(id), U128(1_250_000_000), Ok(())));
        testing_env!(ctx(accounts(2)).build());
        c.mark_settled(id, "0xdead".into());
        assert_eq!(c.get_payment(id).unwrap().status, Status::Settled);
        // replaying the same quote on another payment: not queued / amount differs
        testing_env!(ctx(accounts(1)).build());
        let id2 = c.request_payment(claim("design", "1108", 1_000_000_000, pay));
        testing_env!(ctx(accounts(2)).account_balance(NearToken::from_near(2)).build());
        let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| c.settle(id2, payload, sig)));
        assert!(r.is_err(), "a quote for another amount does not settle this payment");
    }

    #[test]
    fn settle_quote_refuses_every_quote_that_is_not_the_vendors() {
        let mut c = plain();
        testing_env!(ctx(accounts(0)).build());
        c.set_quote_signer(Some(test_signer()));
        let pay = Payout::Chain { chain: "base".into(), address: "0xabc".into() };
        testing_env!(ctx(accounts(1)).build());
        let id = c.request_payment(claim("design", "1107", 1_250_000_000, pay));
        let good = quote_payload("0xabc", 1_250_000_000, 1_240_000_000, DEP, LATER, "base");
        let cases: Vec<(&str, String, Base64VecU8)> = vec![
            ("another recipient", quote_payload("0xdef", 1_250_000_000, 1_240_000_000, DEP, LATER, "base"), Base64VecU8(vec![])),
            ("another amount", quote_payload("0xabc", 1_000_000_000, 990_000_000, DEP, LATER, "base"), Base64VecU8(vec![])),
            ("fee over 2 percent", quote_payload("0xabc", 1_250_000_000, 1_200_000_000, DEP, LATER, "base"), Base64VecU8(vec![])),
            ("another chain", quote_payload("0xabc", 1_250_000_000, 1_240_000_000, DEP, LATER, "arb"), Base64VecU8(vec![])),
            ("expired", quote_payload("0xabc", 1_250_000_000, 1_240_000_000, DEP, "2025-10-01T00:00:00.000Z", "base"), Base64VecU8(vec![])), // the mock clock reads 9 October 2025
            ("named deposit account", quote_payload("0xabc", 1_250_000_000, 1_240_000_000, "attacker.near", LATER, "base"), Base64VecU8(vec![])),
            ("unsigned", good.clone(), Base64VecU8(vec![1u8; 64])),
            ("signed bytes differ", good.clone(), sign_payload(&good.replace("0xabc", "0xdef"))),
        ];
        for (what, payload, sig) in cases {
            let sig = if sig.0.is_empty() { sign_payload(&payload) } else { sig };
            testing_env!(ctx(accounts(2)).account_balance(NearToken::from_near(2)).build());
            let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| c.settle(id, payload.clone(), sig)));
            assert!(r.is_err(), "{what}: must be refused");
            assert_eq!(c.get_payment(id).unwrap().status, Status::Queued, "{what}: nothing moved");
        }
        // the owner's key wins: with 1Click's built-in key, a quote signed by the test key is refused
        testing_env!(ctx(accounts(0)).build());
        c.set_quote_signer(None);
        testing_env!(ctx(accounts(2)).account_balance(NearToken::from_near(2)).build());
        let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| c.settle(id, good.clone(), sign_payload(&good))));
        assert!(r.is_err(), "not 1Click's signature");
        // and only the executor may call it
        testing_env!(ctx(accounts(0)).build());
        c.set_quote_signer(Some(test_signer()));
        testing_env!(ctx(accounts(0)).account_balance(NearToken::from_near(2)).build());
        let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| c.settle(id, good.clone(), sign_payload(&good))));
        assert!(r.is_err(), "only the executor");
    }

    #[test]
    fn audit_mark_settled_waits_for_the_transfer() {
        let mut c = plain();
        testing_env!(ctx(accounts(0)).build());
        let pay = Payout::Chain { chain: "base".into(), address: "0xabc".into() };
        testing_env!(ctx(accounts(1)).build());
        let id = c.request_payment(claim("design", "1107", 1_250_000_000, pay.clone()));
        testing_env!(ctx(accounts(2)).build());
        let _ = settle_signed(&mut c, id);
        let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| c.mark_settled(id, "0xtx".into())));
        assert!(r.is_err(), "the deposit transfer has not landed");
        testing_env!(as_self().build());
        assert!(c.on_ft_transfer(Some(id), U128(1_250_000_000), Ok(())));
        testing_env!(ctx(accounts(2)).build());
        c.mark_settled(id, "0xtx".into());
        assert_eq!(c.get_payment(id).unwrap().status, Status::Settled);
    }

    #[test]
    fn audit_long_periods_are_refused_and_orders_are_indexed() {
        let mut c = plain();
        testing_env!(ctx(accounts(0)).build());
        let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| c.add_recurring_order("hosting".into(), "x".into(), U128(1_000_000_000), 300_000, None)));
        assert!(r.is_err());
        for i in 0..64 { c.add_order("hosting".into(), format!("PO-{i}"), "".into(), U128(1_000_000), None); }
        let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| c.add_order("hosting".into(), "PO-65".into(), "".into(), U128(1_000_000), None)));
        assert!(r.is_err(), "64 open orders per vendor at most");
        c.close_order(1);
        c.add_order("hosting".into(), "PO-65".into(), "".into(), U128(1_000_000), None);
        assert_eq!(c.list_orders(Some("hosting".into())).len(), 65);
    }

    #[test]
    fn audit_order_bound_vendor_stays_bound_after_its_orders_close() {
        let mut c = plain();
        testing_env!(ctx(accounts(0)).build());
        let po = c.add_order("hosting".into(), "PO-1".into(), "".into(), U128(1_000_000_000), None);
        c.close_order(po);
        testing_env!(ctx(accounts(1)).build());
        let id = c.request_payment(claim("hosting", "C2", 100_000_000, near(accounts(5))));
        assert_eq!(c.get_payment(id).unwrap().reason.as_deref(), Some("no_order"));
        testing_env!(ctx(accounts(0)).build());
        c.set_order_bound("hosting".into(), false);
        testing_env!(ctx(accounts(1)).build());
        let id = c.request_payment(claim("hosting", "C3", 100_000_000, near(accounts(5))));
        assert_eq!(c.get_payment(id).unwrap().status, Status::Paid);
    }

    #[test]
    fn audit_duplicates_by_normalized_number_and_by_file_hash() {
        let mut c = plain();
        testing_env!(ctx(accounts(1)).build());
        let first = c.request_payment(claim("hosting", "AH-0923", 100_000_000, near(accounts(5))));
        assert_eq!(c.get_payment(first).unwrap().status, Status::Paid);
        for n in ["AH0923", "ah 0923", "AH-0923."] {
            let mut cl = claim("hosting", n, 100_000_000, near(accounts(5))); cl.invoice_hash = format!("other-{n}");
            { let id = c.request_payment(cl); assert_eq!(c.get_payment(id).unwrap().reason.as_deref(), Some("duplicate_invoice"), "{n}"); }
        }
        let mut same_file = claim("hosting", "AH-0999", 100_000_000, near(accounts(5))); same_file.invoice_hash = claim("hosting", "AH-0923", 0, near(accounts(5))).invoice_hash;
        { let id = c.request_payment(same_file); assert_eq!(c.get_payment(id).unwrap().reason.as_deref(), Some("duplicate_invoice")); }
        let mut blank = claim("hosting", "", 100_000_000, near(accounts(5))); blank.invoice_hash = String::new();
        { let id = c.request_payment(blank); assert_eq!(c.get_payment(id).unwrap().reason.as_deref(), Some("no_invoice_identity")); }
    }

    #[test]
    fn audit_chain_addresses_fold_case_only_when_hex() {
        let sol = Payout::Chain { chain: "sol".into(), address: "9xQeWvG816oWg9W3rCFeZ5s9h8Y2bD4zTk1pQmNr7LvU".into() };
        let sol2 = Payout::Chain { chain: "sol".into(), address: "9xqewvg816owg9w3rcfez5s9h8y2bd4ztk1pqmnr7lvu".into() };
        assert!(!sol.same_as(&sol2));
        let evm = Payout::Chain { chain: "base".into(), address: "0xABCdef".into() };
        let evm2 = Payout::Chain { chain: " Base ".into(), address: " 0xabcDEF ".into() };
        assert!(evm.same_as(&evm2));
    }

    #[test]
    fn audit_events_cannot_be_forged_by_a_quote_in_a_string() {
        let mut c = plain();
        testing_env!(ctx(accounts(0)).build());
        c.add_vendor("x\",\"event\":\"withdraw\",\"data\":\"1".into(), "Evil".into(), near(accounts(5)), U128(0), None, None, None);
        let line = near_sdk::test_utils::get_logs().last().unwrap().clone();
        let json: near_sdk::serde_json::Value = near_sdk::serde_json::from_str(line.strip_prefix("EVENT_JSON:").unwrap()).unwrap();
        assert_eq!(json["event"], "vendor_added");
    }

    #[test]
    fn audit_list_payments_pages_by_id() {
        let mut c = plain();
        testing_env!(ctx(accounts(1)).build());
        for i in 0..4 { c.request_payment(claim("hosting", &format!("L{i}"), 100_000_000, near(accounts(5)))); }
        let page = c.list_payments(Some(2), Some(1));
        assert_eq!(page.len(), 1);
        assert_eq!(page[0].id, 3);
        assert_eq!(c.list_payments(Some(4), None).len(), 0);
    }

    #[test]
    fn audit_only_the_owner_upgrades() {
        let mut c = plain();
        testing_env!(ctx(accounts(1)).build());
        let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| { let _ = c.upgrade(Base64VecU8(vec![0u8; 2048])); }));
        assert!(r.is_err());
        testing_env!(ctx(accounts(0)).build());
        let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| { let _ = c.upgrade(Base64VecU8(vec![0u8; 10])); }));
        assert!(r.is_err(), "not a contract");
        let _ = c.upgrade(Base64VecU8(vec![0u8; 2048]));
    }

    #[test]
    fn audit_owner_can_reset_a_stuck_in_flight_counter() {
        let mut c = plain();
        testing_env!(ctx(accounts(1)).build());
        c.request_payment(claim("hosting", "0923", 480_000_000, near(accounts(5))));
        testing_env!(ctx(accounts(0)).build());
        let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| c.sync_balance()));
        assert!(r.is_err());
        c.reset_in_flight();
        let _ = c.sync_balance();
    }

    // ----- audit reproductions (21 October) -----

    #[test]
    fn audit_approval_after_vendor_deactivated_must_not_pay() {
        let mut c = setup();
        testing_env!(ctx(accounts(0)).build());
        c.set_roles(None, None, None, None);
        let mut c2 = Bursar::new(accounts(0), accounts(1), accounts(2), None, accounts(4), U128(5_000_000_000), U128(20_000_000_000), U128(2_000_000_000));
        c2.add_vendor("hosting".into(), "Acme".into(), Payout::Near { account: accounts(5) }, U128(0), None, None, None);
        testing_env!(ctx(accounts(4)).build());
        let _ = c2.ft_on_transfer(accounts(0), U128(50_000_000_000), "".into());
        testing_env!(ctx(accounts(1)).build());
        let id = c2.request_payment(claim("hosting", "0923", 3_000_000_000, Payout::Near { account: accounts(5) }));
        assert_eq!(c2.get_payment(id).unwrap().status, Status::Approval);
        testing_env!(ctx(accounts(0)).build());
        c2.update_vendor("hosting".into(), None, None, Some(false), None, None, None);
        let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| c2.approve_payment(id)));
        assert!(r.is_err(), "approving a hold for a vendor the owner switched off must be refused");
        assert_eq!(c2.get_payment(id).unwrap().status, Status::Approval);
        let _ = c;
    }

    #[test]
    fn audit_approval_while_paused_must_not_pay() {
        let mut c = Bursar::new(accounts(0), accounts(1), accounts(2), None, accounts(4), U128(5_000_000_000), U128(20_000_000_000), U128(2_000_000_000));
        testing_env!(ctx(accounts(0)).build());
        c.add_vendor("hosting".into(), "Acme".into(), Payout::Near { account: accounts(5) }, U128(0), None, None, None);
        testing_env!(ctx(accounts(4)).build());
        let _ = c.ft_on_transfer(accounts(0), U128(50_000_000_000), "".into());
        testing_env!(ctx(accounts(1)).build());
        let id = c.request_payment(claim("hosting", "0923", 3_000_000_000, Payout::Near { account: accounts(5) }));
        testing_env!(ctx(accounts(0)).build());
        c.set_paused(true);
        let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| c.approve_payment(id)));
        assert!(r.is_err(), "nothing is paid while the treasury is paused");
        assert_eq!(c.get_stats().balance.0, 50_000_000_000);
    }

    #[test]
    fn audit_owner_can_remove_the_dao() {
        let mut c = setup();
        testing_env!(ctx(accounts(0)).build());
        assert_eq!(c.get_roles().3, Some(accounts(3)));
        c.set_roles(None, None, None, None);
        assert_eq!(c.get_roles().3, Some(accounts(3)), "None leaves the dao alone");
        c.clear_dao();
        assert_eq!(c.get_roles().3, None, "the owner can go back to approving payments itself");
    }

    #[test]
    fn audit_sync_balance_refuses_while_a_transfer_is_in_flight() {
        let mut c = setup();
        testing_env!(ctx(accounts(1)).build());
        let _ = c.request_payment(claim("hosting", "0923", 480_000_000, Payout::Near { account: accounts(5) }));
        // the transfer left the books; its callback has not run; the token may or may not have executed it yet
        testing_env!(ctx(accounts(0)).build());
        let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| c.sync_balance()));
        assert!(r.is_err(), "a sync now could read the token either before or after the transfer: refuse");
        // and the callback refuses too, in case the transfer started after the call
        testing_env!(as_self().build());
        let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| c.on_sync_balance(Ok(U128(50_000_000_000)))));
        assert!(r.is_err());
        assert_eq!(c.get_stats().balance.0, 50_000_000_000 - 480_000_000);
    }

    #[test]
    fn audit_agent_cannot_fill_the_storage_with_blocked_claims() {
        let mut c = setup();
        testing_env!(ctx(accounts(1)).build());
        let before = env::storage_usage();
        let big = "x".repeat(50_000);
        let mut cl = claim("nobody", &big, 1, Payout::Near { account: accounts(5) });
        cl.invoice_hash = big.clone(); cl.attestation_ref = big.clone(); cl.flags = vec![big.clone(); 10];
        let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| c.request_payment(cl)));
        assert!(r.is_err(), "oversized claim strings are refused before anything is stored");
        assert_eq!(env::storage_usage(), before);
        // and a flood of refusals stops being recorded after a daily quota, so a stolen agent key cannot drain the NEAR
        let mut blocked = 0;
        for i in 0..400 {
            let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| c.request_payment(claim("nobody", &format!("n{i}"), 1, Payout::Near { account: accounts(5) }))));
            if r.is_ok() { blocked += 1; }
        }
        assert!(blocked <= 200, "at most a daily quota of refusals is written to storage, got {blocked}");
    }

    #[test]
    fn sync_balance_counts_plain_transfers_and_not_money_in_flight() {
        let mut c = setup();
        assert_eq!(c.get_stats().balance.0, 50_000_000_000);
        // a payment goes out: the balance drops at once, the USDC is in flight until the callback
        testing_env!(ctx(accounts(1)).build());
        let id = c.request_payment(claim("hosting", "0923", 480_000_000, Payout::Near { account: accounts(5) }));
        assert_eq!(c.get_stats().balance.0, 50_000_000_000 - 480_000_000);
        // while the transfer is in flight a sync is refused (see audit_sync_balance_refuses_while_a_transfer_is_in_flight);
        // the transfer lands: nothing in flight any more, a sync now reads the token as it is, plus 1000 USDC someone sent with a plain ft_transfer
        testing_env!(as_self().build());
        assert!(c.on_ft_transfer(Some(id), U128(480_000_000), Ok(())));
        let synced = c.on_sync_balance(Ok(U128(50_000_000_000 + 1_000_000_000 - 480_000_000)));
        assert_eq!(synced.0, 50_000_000_000 + 1_000_000_000 - 480_000_000);
        // a failed transfer puts the money back and clears the in-flight count too
        testing_env!(ctx(accounts(1)).build());
        let id2 = c.request_payment(claim("hosting", "0924", 100_000_000, Payout::Near { account: accounts(5) }));
        testing_env!(as_self().build());
        assert!(!c.on_ft_transfer(Some(id2), U128(100_000_000), Err(PromiseError::Failed)));
        assert_eq!(c.get_stats().balance.0, 50_000_000_000 + 1_000_000_000 - 480_000_000);
        let synced = c.on_sync_balance(Ok(U128(50_000_000_000 + 1_000_000_000 - 480_000_000)));
        assert_eq!(synced.0, c.get_stats().balance.0);
    }

    #[test]
    fn sync_balance_needs_the_owner_or_an_operator() {
        let mut c = setup();
        testing_env!(ctx(accounts(5)).build());
        let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| c.sync_balance()));
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

    #[test]
    fn preview_matches_the_decision_and_records_nothing() {
        let mut c = setup();
        testing_env!(ctx(accounts(1)).build());
        let ok = claim("hosting", "p1", 1_000_000, Payout::Near { account: accounts(5) });
        let pv = c.preview_payment(ok.clone());
        assert_eq!(pv.status, Status::Paid);
        assert_eq!(pv.reason, None);
        assert_eq!(c.get_stats().payments, 0);
        let id = c.request_payment(ok);
        assert_eq!(c.get_payment(id).unwrap().status, Status::Paid);
        // the same invoice again: preview says duplicate, exactly as the contract would
        let again = claim("hosting", "p1", 1_000_000, Payout::Near { account: accounts(5) });
        let pv = c.preview_payment(again);
        assert_eq!(pv.status, Status::Blocked);
        assert_eq!(pv.reason.as_deref(), Some("duplicate_invoice"));
        // a big one is a hold, and an inactive vendor a block
        let big = claim("hosting", "p2", 3_000_000_000, Payout::Near { account: accounts(5) });
        let pv = c.preview_payment(big);
        assert_eq!(pv.status, Status::Approval);
        assert_eq!(pv.reason.as_deref(), Some("over_threshold"));
        testing_env!(ctx(accounts(0)).build());
        c.update_vendor("hosting".into(), None, None, Some(false), None, None, None);
        let pv = c.preview_payment(claim("hosting", "p3", 1_000_000, Payout::Near { account: accounts(5) }));
        assert_eq!(pv.reason.as_deref(), Some("vendor_inactive"));
        assert_eq!(c.get_stats().payments, 1);
    }
}
