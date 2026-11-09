import React from "react";
import { AbsoluteFill, Easing, Img, interpolate, staticFile, useCurrentFrame, useVideoConfig } from "remotion";
import { theme } from "./theme";

// Every slide is built from the same reveal: parts come in one after the other, 0.45 s apart, with a soft ease.
const useReveal = (index: number, delaySeconds = 0.35, gapSeconds = 0.45) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const start = (delaySeconds + index * gapSeconds) * fps;
  return {
    opacity: interpolate(frame, [start, start + 0.6 * fps], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: Easing.bezier(0.16, 1, 0.3, 1) }),
    translate: interpolate(frame, [start, start + 0.7 * fps], ["0px 26px", "0px 0px"], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: Easing.bezier(0.16, 1, 0.3, 1) }),
  };
};

const Reveal: React.FC<{ readonly i: number; readonly children: React.ReactNode; readonly style?: React.CSSProperties }> = ({ i, children, style }) => {
  const r = useReveal(i);
  return <div style={{ ...r, ...style }}>{children}</div>;
};

const Mark: React.FC<{ readonly size?: number }> = ({ size = 96 }) => (
  <div style={{ width: size, height: size, borderRadius: size * 0.28, background: theme.signal, display: "flex", alignItems: "center", justifyContent: "center", boxShadow: "0 0 0 1px rgba(157,240,196,.25), 0 20px 60px rgba(157,240,196,.18)" }}>
    <Img src={staticFile("mark.svg")} style={{ width: size * 0.58, height: size * 0.58, borderRadius: size * 0.1 }} />
  </div>
);

// The site's background: ink, with the soft mint glow of the landing page.
const Frame: React.FC<{ readonly children: React.ReactNode; readonly foot?: string }> = ({ children, foot }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const drift = Math.sin(frame / fps / 3) * 30;
  return (
    <AbsoluteFill style={{ background: theme.ink, color: theme.text, fontFamily: theme.sans, overflow: "hidden" }}>
      <div style={{ position: "absolute", left: 1180 + drift, top: -260, width: 900, height: 900, borderRadius: "50%", background: "radial-gradient(circle, rgba(157,240,196,.16) 0%, rgba(157,240,196,0) 62%)" }} />
      <div style={{ position: "absolute", left: -320, top: 560 - drift, width: 820, height: 820, borderRadius: "50%", background: "radial-gradient(circle, rgba(157,240,196,.08) 0%, rgba(157,240,196,0) 62%)" }} />
      <div style={{ position: "absolute", inset: 0, padding: "104px 140px" }}>{children}</div>
      {foot ? <div style={{ position: "absolute", left: 140, bottom: 64, fontFamily: theme.mono, fontSize: 19, letterSpacing: "0.08em", color: theme.mute }}>{foot}</div> : null}
      <div style={{ position: "absolute", right: 140, bottom: 58, display: "flex", alignItems: "center", gap: 12, color: theme.soft, fontFamily: theme.display, fontWeight: 700, fontSize: 24 }}><Mark size={34} />Bursar</div>
    </AbsoluteFill>
  );
};

const Eyebrow: React.FC<{ readonly i: number; readonly children: React.ReactNode }> = ({ i, children }) => (
  <Reveal i={i} style={{ marginBottom: 30 }}>
    <span style={{ display: "inline-flex", alignItems: "center", gap: 12, padding: "10px 20px", borderRadius: 999, background: theme.card, border: `1px solid ${theme.line}`, fontFamily: theme.mono, fontSize: 19, letterSpacing: "0.1em", textTransform: "uppercase", color: theme.signal }}>
      <span style={{ width: 9, height: 9, borderRadius: 99, background: theme.signal, boxShadow: `0 0 12px ${theme.signal}` }} />{children}
    </span>
  </Reveal>
);

const H2: React.FC<{ readonly i: number; readonly children: React.ReactNode; readonly size?: number }> = ({ i, children, size = 66 }) => (
  <Reveal i={i} style={{ fontFamily: theme.display, fontSize: size, lineHeight: 1.06, letterSpacing: "-0.025em", fontWeight: 700, marginBottom: 44, maxWidth: 1520 }}>{children}</Reveal>
);

const Card: React.FC<{ readonly children: React.ReactNode; readonly style?: React.CSSProperties; readonly hot?: boolean }> = ({ children, style, hot }) => (
  <div style={{ background: theme.card, border: `1px solid ${hot ? theme.signal : theme.line}`, boxShadow: hot ? `0 0 0 1px ${theme.signal} inset, 0 0 70px rgba(157,240,196,.16)` : "none", borderRadius: 28, padding: "34px 36px", ...style }}>{children}</div>
);

const Pill: React.FC<{ readonly color: string; readonly children: React.ReactNode }> = ({ color, children }) => (
  <span style={{ display: "inline-block", padding: "8px 18px", borderRadius: 999, background: `${color}22`, color, border: `1px solid ${color}55`, fontFamily: theme.mono, fontSize: 26, fontWeight: 500, letterSpacing: "0.06em" }}>{children}</span>
);

export const SlideIntro: React.FC = () => (
  <Frame foot="AN AI TREASURER FOR COMPANIES OF ANY SIZE, ON NEAR">
    <Reveal i={0}><Mark /></Reveal>
    <Reveal i={1} style={{ fontFamily: theme.display, fontSize: 100, fontWeight: 700, letterSpacing: "-0.03em", lineHeight: 1, margin: "44px 0 40px" }}>Bursar</Reveal>
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      {[["The AI ", "reads", theme.text], ["The contract ", "decides", theme.signal], ["A dumb executor ", "moves the money", theme.mute]].map(([a, b, c], i) => (
        <Reveal key={b} i={2 + i} style={{ fontFamily: theme.display, fontSize: 74, fontWeight: 700, letterSpacing: "-0.025em", lineHeight: 1.06, color: c }}>{a}{b}.</Reveal>
      ))}
    </div>
  </Frame>
);

const Stamp: React.FC<{ readonly i: number; readonly label: string; readonly color: string; readonly text: string }> = ({ i, label, color, text }) => (
  <Reveal i={i} style={{ flex: 1, display: "flex" }}>
    <Card style={{ flex: 1 }}>
      <div style={{ marginBottom: 22 }}><Pill color={color}>{label}</Pill></div>
      <div style={{ fontSize: 27, lineHeight: 1.42, color: theme.soft }}>{text}</div>
    </Card>
  </Reveal>
);

export const SlideProblem: React.FC = () => (
  <Frame>
    <Eyebrow i={0}>The problem</Eyebrow>
    <H2 i={1}>Every company pays invoices.<br />Sooner or later it pays one it should not.</H2>
    <div style={{ display: "flex", gap: 24 }}>
      <Stamp i={2} label="FRAUD" color={theme.blocked} text='"Please note our new bank details." The invoice is real, the account is the thief&apos;s.' />
      <Stamp i={3} label="TWICE" color={theme.held} text="The same invoice, paid twice. A number nobody checked." />
      <Stamp i={4} label="NOBODY" color={theme.signal} text="An invoice nobody ordered, from a vendor nobody chose." />
    </div>
    <Reveal i={5} style={{ fontSize: 34, lineHeight: 1.38, color: theme.soft, marginTop: 52, maxWidth: 1400 }}>Giving an AI the company&apos;s money makes this worse, unless the AI cannot touch the money at all.</Reveal>
  </Frame>
);

const Role: React.FC<{ readonly i: number; readonly k: string; readonly title: string; readonly items: readonly string[]; readonly hotFrom: number }> = ({ i, k, title, items, hotFrom }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const hot = frame >= hotFrom * fps && frame < (hotFrom + 2.5) * fps;
  return (
    <Reveal i={i} style={{ flex: 1, display: "flex" }}>
      <Card hot={hot} style={{ flex: 1, minHeight: 440 }}>
        <div style={{ fontFamily: theme.mono, fontSize: 18, letterSpacing: "0.1em", color: theme.signal, marginBottom: 14 }}>{k}</div>
        <div style={{ fontFamily: theme.display, fontSize: 42, fontWeight: 700, letterSpacing: "-0.02em", marginBottom: 20 }}>{title}</div>
        {items.map((t) => <div key={t} style={{ fontSize: 23, lineHeight: 1.42, color: theme.soft, marginBottom: 10, paddingLeft: 22, position: "relative" }}><span style={{ position: "absolute", left: 0, top: 13, width: 8, height: 8, borderRadius: 99, background: theme.signal }} />{t}</div>)}
      </Card>
    </Reveal>
  );
};

const Arrow: React.FC<{ readonly i: number }> = ({ i }) => (
  <Reveal i={i} style={{ width: 80, display: "flex", alignItems: "center", justifyContent: "center", color: theme.signal, fontSize: 52, fontFamily: theme.sans }}>&rarr;</Reveal>
);

export const SlideHow: React.FC = () => (
  <Frame foot="THE RULES LIVE IN THE COMPANY'S OWN SMART CONTRACT, UNDER THE COMPANY'S KEYS">
    <Eyebrow i={0}>How it works</Eyebrow>
    <H2 i={1}>Three roles. Only one of them decides.</H2>
    <div style={{ display: "flex", alignItems: "stretch" }}>
      <Role i={2} k="01 / READS" title="The AI" hotFrom={3.4} items={["Has the invoice PDF read inside a trusted execution environment, NEAR AI Cloud.", "The enclave attests itself and signs what it read.", "Anyone can verify the reading later. The AI picks nothing."]} />
      <Arrow i={3} />
      <Role i={4} k="02 / DECIDES" title="The contract" hotFrom={6.2} items={["Vendor in the allowlist, payout as the owner registered it", "Per-payment cap, daily cap, monthly budget per vendor", "Purchase orders, duplicates, tax ids, withholding", "At or above a threshold: a person decides"]} />
      <Arrow i={5} />
      <Role i={6} k="03 / MOVES" title="The executor" hotFrom={9.0} items={["USDC on NEAR: the contract pays, in the same transaction", "Base, Arbitrum, Ethereum, Solana, Sui through NEAR Intents", "Only on a quote 1Click signed for the vendor's recorded payout, and the contract verifies that signature"]} />
    </div>
  </Frame>
);

export const SlideNever: React.FC = () => (
  <Frame foot="GIVE AN AI MONEY WITHOUT GIVING IT THE KEYS TO ANYTHING">
    <Eyebrow i={0}>What the AI can never do</Eyebrow>
    <H2 i={1}>Its key can only ask.</H2>
    {["It never picks an address: the payout comes from the owner's record.", "It never changes a limit, a vendor, a budget: owner only, signed with the wallet.", "It never touches the funds: they sit in the company's contract, and only the contract pays.", "It never hides what it read: the enclave's signed receipt is on the record."].map((t, i) => (
      <Reveal key={t} i={2 + i} style={{ display: "flex", gap: 28, alignItems: "baseline", padding: "20px 0", borderTop: `1px solid ${theme.line}`, fontSize: 37, lineHeight: 1.3 }}>
        <span style={{ fontFamily: theme.mono, color: theme.signal, fontSize: 25 }}>{String(i + 1).padStart(2, "0")}</span><span>{t}</span>
      </Reveal>
    ))}
  </Frame>
);

export const SlideOutcomes: React.FC = () => (
  <Frame>
    <Eyebrow i={0}>Three answers</Eyebrow>
    <H2 i={1}>Every invoice ends in one of three places.</H2>
    <div style={{ display: "flex", gap: 24 }}>
      <Stamp i={2} label="PAID" color={theme.signal} text="Known vendor, registered payout, within the caps and the orders. Paid in the same transaction. Nobody had to look." />
      <Stamp i={3} label="HELD" color={theme.held} text="At or above the threshold, no order, a mismatch, a flag. The budget is reserved; the owner, an approver or a DAO council decides." />
      <Stamp i={4} label="BLOCKED" color={theme.blocked} text="Changed payout, duplicate, unknown vendor, over the cap. Refused on the spot, reason on the record." />
    </div>
    <Reveal i={5} style={{ fontSize: 34, lineHeight: 1.38, color: theme.soft, marginTop: 52 }}>A person sees only what the rules hold back.</Reveal>
  </Frame>
);

const Fact: React.FC<{ readonly i: number; readonly big: string; readonly text: string }> = ({ i, big, text }) => (
  <Reveal i={i} style={{ flex: 1, display: "flex" }}>
    <Card style={{ flex: 1 }}>
      <div style={{ fontFamily: theme.display, fontSize: 54, fontWeight: 700, letterSpacing: "-0.02em", color: theme.signal, marginBottom: 14, lineHeight: 1.05 }}>{big}</div>
      <div style={{ fontSize: 24, lineHeight: 1.42, color: theme.soft }}>{text}</div>
    </Card>
  </Reveal>
);

export const SlideProof: React.FC = () => (
  <Frame foot="EVERY LINK IN THE README IS A PUBLIC TRANSACTION">
    <Eyebrow i={0}>Not a mockup</Eyebrow>
    <H2 i={1}>Done on mainnet, with real USDC, in November.</H2>
    <div style={{ display: "flex", gap: 24 }}>
      <Fact i={2} big="Mainnet" text="A treasury created from a browser. An invoice read in the enclave, held by the rules, approved by the owner's wallet. A vendor paid on Base through NEAR Intents, settled on a 1Click-signed quote the contract verified." />
      <Fact i={3} big="67 tests" text="On the policy contract, plus three internal review rounds by separate AI reviewer agents: every contract finding reproduced by a unit test before the fix." />
      <Fact i={4} big="Open" text="Web console, Telegram inbox and approvals, CLI agent and relayer, an MCP server with ten tools for AI assistants, a public registry and explorer. MIT." />
    </div>
  </Frame>
);

export const SlideClose: React.FC = () => (
  <Frame foot="BUILT AT THE NEAR HACKATHON, NOVEMBER 2026">
    <Reveal i={0}><Mark /></Reveal>
    <Reveal i={1} style={{ fontFamily: theme.display, fontSize: 96, fontWeight: 700, letterSpacing: "-0.03em", lineHeight: 1, margin: "44px 0 36px" }}>bursar.network</Reveal>
    <Reveal i={2} style={{ fontSize: 36, lineHeight: 1.4, color: theme.soft, maxWidth: 1400 }}>Software, not a payment service. Funds stay in the company&apos;s own contract, with the company&apos;s keys.</Reveal>
    <Reveal i={3} style={{ display: "flex", gap: 14, marginTop: 40, flexWrap: "wrap" }}>
      {["Try it on testnet, free", "Read the code", "Verify a receipt"].map((t) => <span key={t} style={{ padding: "12px 24px", borderRadius: 999, border: `1px solid ${theme.line}`, background: theme.card, fontSize: 24, color: theme.text }}>{t}</span>)}
    </Reveal>
    <Reveal i={4} style={{ fontFamily: theme.display, fontSize: 44, fontWeight: 700, letterSpacing: "-0.02em", marginTop: 56 }}>The AI reads. <span style={{ color: theme.signal }}>The contract decides.</span> <span style={{ color: theme.mute }}>A dumb executor moves the money.</span></Reveal>
  </Frame>
);
