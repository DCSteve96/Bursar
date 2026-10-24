import React from "react";
import { AbsoluteFill, Easing, interpolate, useCurrentFrame, useVideoConfig } from "remotion";
import { theme } from "./theme";

// Every slide is built from the same reveal: parts come in one after the other, 0.5 s apart, with a soft spring.
const useReveal = (index: number, delaySeconds = 0.4, gapSeconds = 0.5) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const start = (delaySeconds + index * gapSeconds) * fps;
  return {
    opacity: interpolate(frame, [start, start + 0.6 * fps], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: Easing.bezier(0.16, 1, 0.3, 1) }),
    translate: interpolate(frame, [start, start + 0.7 * fps], ["0px 28px", "0px 0px"], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: Easing.bezier(0.16, 1, 0.3, 1) }),
  };
};

const Reveal: React.FC<{ readonly i: number; readonly children: React.ReactNode; readonly style?: React.CSSProperties }> = ({ i, children, style }) => {
  const r = useReveal(i);
  return <div style={{ ...r, ...style }}>{children}</div>;
};

const Mark: React.FC<{ readonly size?: number }> = ({ size = 96 }) => {
  const u = size / 64;
  return (
    <div style={{ width: size, height: size, background: "#000", borderRadius: 8 * u, position: "relative", border: `1px solid ${theme.line}` }}>
      <div style={{ position: "absolute", left: 14 * u, top: 16 * u, width: 36 * u, height: 8 * u, background: "#fff" }} />
      <div style={{ position: "absolute", left: 14 * u, top: 28 * u, width: 24 * u, height: 8 * u, background: theme.signal }} />
      <div style={{ position: "absolute", left: 14 * u, top: 40 * u, width: 36 * u, height: 8 * u, background: "#fff" }} />
    </div>
  );
};

const Frame: React.FC<{ readonly children: React.ReactNode; readonly foot?: string }> = ({ children, foot }) => (
  <AbsoluteFill style={{ background: "#000", color: theme.text, fontFamily: theme.sans, padding: "110px 140px" }}>
    {children}
    {foot ? <div style={{ position: "absolute", left: 140, bottom: 72, fontFamily: theme.mono, fontSize: 20, letterSpacing: "0.08em", color: theme.mute }}>{foot}</div> : null}
  </AbsoluteFill>
);

const Eyebrow: React.FC<{ readonly i: number; readonly children: React.ReactNode }> = ({ i, children }) => (
  <Reveal i={i} style={{ fontFamily: theme.mono, fontSize: 20, letterSpacing: "0.12em", textTransform: "uppercase", color: theme.signal, marginBottom: 30 }}>{children}</Reveal>
);

const H2: React.FC<{ readonly i: number; readonly children: React.ReactNode }> = ({ i, children }) => (
  <Reveal i={i} style={{ fontSize: 66, lineHeight: 1.08, letterSpacing: "-0.02em", fontWeight: 700, marginBottom: 44, maxWidth: 1500 }}>{children}</Reveal>
);

export const SlideIntro: React.FC = () => (
  <Frame foot="AN AI TREASURER FOR COMPANIES, ON NEAR">
    <Reveal i={0}><Mark /></Reveal>
    <Reveal i={1} style={{ fontSize: 96, fontWeight: 700, letterSpacing: "-0.025em", lineHeight: 1, margin: "48px 0 36px" }}>Bursar</Reveal>
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      {[["The AI ", "reads"], ["The contract ", "decides"], ["A dumb executor ", "moves the money"]].map(([a, b], i) => (
        <Reveal key={b} i={2 + i} style={{ fontSize: 76, fontWeight: 700, letterSpacing: "-0.02em", lineHeight: 1.05 }}>{a}<span style={{ color: theme.signal }}>{b}</span>.</Reveal>
      ))}
    </div>
  </Frame>
);

const Stamp: React.FC<{ readonly i: number; readonly label: string; readonly color: string; readonly text: string }> = ({ i, label, color, text }) => (
  <Reveal i={i} style={{ background: theme.card, border: `1px solid ${theme.line}`, borderRadius: 12, padding: "34px 36px", flex: 1 }}>
    <div style={{ fontFamily: theme.mono, fontSize: 48, fontWeight: 700, letterSpacing: "0.04em", color, marginBottom: 16 }}>{label}</div>
    <div style={{ fontSize: 26, lineHeight: 1.4, color: theme.soft }}>{text}</div>
  </Reveal>
);

export const SlideProblem: React.FC = () => (
  <Frame>
    <Eyebrow i={0}>The problem</Eyebrow>
    <H2 i={1}>Every company pays invoices.<br />Sooner or later it pays one it should not.</H2>
    <div style={{ display: "flex", gap: 28 }}>
      <Stamp i={2} label="FRAUD" color={theme.blocked} text='"Please note our new bank details." The invoice is real, the account is the thief&apos;s.' />
      <Stamp i={3} label="TWICE" color={theme.held} text="The same invoice, paid twice. A number nobody checked." />
      <Stamp i={4} label="NOBODY" color={theme.signal} text="An invoice nobody ordered, from a vendor nobody chose." />
    </div>
    <Reveal i={5} style={{ fontSize: 34, lineHeight: 1.35, color: theme.soft, marginTop: 52, maxWidth: 1400 }}>Giving an AI the company&apos;s money makes this worse, unless the AI cannot touch the money at all.</Reveal>
  </Frame>
);

const Role: React.FC<{ readonly i: number; readonly k: string; readonly title: string; readonly items: readonly string[]; readonly hotFrom: number }> = ({ i, k, title, items, hotFrom }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const hot = frame >= hotFrom * fps && frame < (hotFrom + 2.6) * fps;
  return (
    <Reveal i={i} style={{ flex: 1, background: theme.card, border: `1px solid ${hot ? theme.signal : theme.line}`, boxShadow: hot ? `0 0 0 2px ${theme.signal} inset, 0 0 60px rgba(0,236,151,.18)` : "none", borderRadius: 12, padding: "34px 36px", minHeight: 420 }}>
      <div style={{ fontFamily: theme.mono, fontSize: 18, letterSpacing: "0.1em", color: theme.signal, marginBottom: 14 }}>{k}</div>
      <div style={{ fontSize: 40, fontWeight: 700, letterSpacing: "-0.01em", marginBottom: 18 }}>{title}</div>
      {items.map((t) => <div key={t} style={{ fontSize: 24, lineHeight: 1.45, color: theme.soft, marginBottom: 8 }}>{t}</div>)}
    </Reveal>
  );
};

export const SlideHow: React.FC = () => (
  <Frame foot="THE RULES LIVE IN THE COMPANY'S OWN SMART CONTRACT, WITH THE COMPANY'S KEYS">
    <Eyebrow i={0}>How it works</Eyebrow>
    <H2 i={1}>Three roles. Only one of them decides.</H2>
    <div style={{ display: "flex", gap: 0, alignItems: "stretch" }}>
      <Role i={2} k="01 / READS" title="The AI" hotFrom={3.6} items={["Reads the PDF inside a trusted execution environment (NEAR AI Cloud).", "The enclave attests itself and signs what it read.", "Anyone can verify the reading later."]} />
      <Reveal i={3} style={{ width: 90, display: "flex", alignItems: "center", justifyContent: "center", color: theme.signal, fontSize: 56 }}>&rarr;</Reveal>
      <Role i={4} k="02 / DECIDES" title="The contract" hotFrom={6.4} items={["Vendor in the allowlist, payout as registered", "Per-payment cap, daily cap, budget", "Purchase orders, duplicates, tax ids", "Above a threshold: a person decides"]} />
      <Reveal i={5} style={{ width: 90, display: "flex", alignItems: "center", justifyContent: "center", color: theme.signal, fontSize: 56 }}>&rarr;</Reveal>
      <Role i={6} k="03 / MOVES" title="The executor" hotFrom={9.2} items={["USDC on NEAR in the same transaction", "Base, Arbitrum, Solana, Sui through NEAR Intents", "Only to the payout the owner registered"]} />
    </div>
  </Frame>
);

export const SlideNever: React.FC = () => (
  <Frame foot="GIVE AI MONEY WITHOUT GIVING IT THE KEYS TO EVERYTHING">
    <Eyebrow i={0}>What the AI can never do</Eyebrow>
    <H2 i={1}>Its key can only ask.</H2>
    {["It never picks an address: the payout comes from the owner's record.", "It never changes a limit, a vendor, a budget: owner only, signed with the wallet.", "It never touches the funds: they sit in the contract, and only the contract pays.", "It never hides what it read: the enclave's signed receipt is on the record."].map((t, i) => (
      <Reveal key={t} i={2 + i} style={{ display: "flex", gap: 28, alignItems: "baseline", padding: "20px 0", borderTop: `1px solid ${theme.line}`, fontSize: 38, lineHeight: 1.3 }}>
        <span style={{ fontFamily: theme.mono, color: theme.signal, fontSize: 26 }}>{String(i + 1).padStart(2, "0")}</span><span>{t}</span>
      </Reveal>
    ))}
  </Frame>
);

export const SlideOutcomes: React.FC = () => (
  <Frame>
    <Eyebrow i={0}>Three answers</Eyebrow>
    <H2 i={1}>Every invoice ends in one of three places.</H2>
    <div style={{ display: "flex", gap: 28 }}>
      <Stamp i={2} label="PAID" color={theme.signal} text="Known vendor, registered payout, within the caps and the orders. Paid in the same transaction. No human." />
      <Stamp i={3} label="HELD" color={theme.held} text="Above the threshold, no order, a mismatch, a flag. The budget is reserved; the owner, an approver or a DAO council decides." />
      <Stamp i={4} label="BLOCKED" color={theme.blocked} text="Changed payout, duplicate, unknown vendor, over the cap. Refused on the spot, reason on the record." />
    </div>
    <Reveal i={5} style={{ fontSize: 34, lineHeight: 1.35, color: theme.soft, marginTop: 52 }}>A person sees only what the rules hold back.</Reveal>
  </Frame>
);

const List: React.FC<{ readonly i: number; readonly title: string; readonly items: readonly string[] }> = ({ i, title, items }) => (
  <Reveal i={i} style={{ flex: 1, background: theme.card, border: `1px solid ${theme.line}`, borderRadius: 12, padding: "34px 38px" }}>
    <div style={{ fontSize: 38, fontWeight: 700, marginBottom: 20 }}>{title}</div>
    {items.map((t) => <div key={t} style={{ fontSize: 27, lineHeight: 1.5, color: theme.soft, marginBottom: 6, paddingLeft: 26, position: "relative" }}><span style={{ position: "absolute", left: 0, color: theme.signal }}>&bull;</span>{t}</div>)}
  </Reveal>
);

export const SlideInOut: React.FC = () => (
  <Frame foot="SOFTWARE, NOT A PAYMENT SERVICE: FUNDS STAY IN THE COMPANY'S CONTRACT">
    <Eyebrow i={0}>In and out</Eyebrow>
    <H2 i={1}>Invoices come in the way vendors already send them.</H2>
    <div style={{ display: "flex", gap: 32 }}>
      <List i={2} title="In" items={["A Telegram bot: vendors send the PDF, the owner approves from the phone", "Trusted vendors skip the question; the contract still decides", "The console: drop a file, see the reading, ask the contract", "An agent watching a folder, an MCP server for AI assistants"]} />
      <List i={3} title="Out" items={["USDC on NEAR, paid by the contract itself", "Base, Arbitrum, Solana, Sui through NEAR Intents", "Withholding tax kept for the state, as the accountant set it", "Every decision public and verifiable on chain"]} />
    </div>
  </Frame>
);

export const SlideClose: React.FC = () => (
  <Frame foot="BUILT AT THE NEAR HACKATHON 2026">
    <Reveal i={0}><Mark /></Reveal>
    <Reveal i={1} style={{ fontSize: 96, fontWeight: 700, letterSpacing: "-0.025em", lineHeight: 1, margin: "48px 0 36px" }}>bursar.network</Reveal>
    <Reveal i={2} style={{ fontSize: 34, lineHeight: 1.4, color: theme.soft, maxWidth: 1400 }}>Policy contract with 53 tests and two independent audit rounds. Web console, Telegram approvals, MCP server, public registry and explorer. Load-tested on 1,030 invoices.</Reveal>
    <Reveal i={3} style={{ fontSize: 34, lineHeight: 1.4, color: theme.soft, maxWidth: 1400, marginTop: 30 }}>Next: mainnet pilot, email inbox, phone app, approval chains for larger companies, ERP connectors.</Reveal>
  </Frame>
);
