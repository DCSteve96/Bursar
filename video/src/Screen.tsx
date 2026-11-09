import React from "react";
import { Video } from "@remotion/media";
import { AbsoluteFill, Easing, Series, interpolate, staticFile, useCurrentFrame, useVideoConfig } from "remotion";
import { theme } from "./theme";
import { data } from "./data";

// The capture is 1600x1012: the page at 1600x1000 plus the 12 px clock strip record.cjs adds, cropped here. It is
// shown in a frame on the 1920x1080 canvas; zooms scale the frame around the element the capture's marks recorded,
// captions rise from below in the site's type.
const SRC_W = 1600, SRC_H = 1012;
const SHOW_W = 1600, SHOW_H = 1000;
const LEFT = (1920 - SHOW_W) / 2, TOP = (1080 - SHOW_H) / 2;

type Segment = (typeof data.segments)[number];
type Zoom = Segment["zooms"][number];
type Cap = Segment["captions"][number];

const ease = Easing.bezier(0.4, 0, 0.2, 1);

const zoomAt = (zooms: readonly Zoom[], second: number): { scale: number; ox: number; oy: number } => {
  for (const z of zooms) {
    const from = z.at, to = z.at + z.ms / 1000 + 1.0;
    if (second >= from - 0.9 && second <= to + 0.9) {
      const k = z.scale * 0.92;
      const inP = interpolate(second, [from - 0.9, from], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: ease });
      const outP = interpolate(second, [to, to + 0.9], [1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: ease });
      const p = Math.min(inP, outP);
      // keep the zoomed frame inside the canvas: the origin stays away from the edges
      const cx = Math.min(Math.max((z.x + z.w / 2) / SHOW_W, 0.25), 0.75), cy = Math.min(Math.max((z.y + Math.min(z.h / 2, 260)) / SHOW_H, 0.25), 0.75);
      return { scale: 1 + (k - 1) * p, ox: cx * SHOW_W, oy: cy * SHOW_H };
    }
  }
  return { scale: 1, ox: SHOW_W / 2, oy: SHOW_H / 2 };
};

const Caption: React.FC<{ readonly caps: readonly Cap[] }> = ({ caps }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const second = frame / fps;
  let cur: Cap | null = null;
  for (const c of caps) if (c.at <= second) cur = c;
  if (!cur) return null;
  const age = second - cur.at;
  const next = caps.find((c) => c.at > cur!.at);
  const left = next ? next.at - second : 99;
  const inP = interpolate(age, [0, 0.45], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: Easing.bezier(0.16, 1, 0.3, 1) });
  const outP = interpolate(left, [0, 0.3], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const p = Math.min(inP, outP);
  return (
    <div style={{ position: "absolute", left: 0, right: 0, bottom: 40, display: "flex", justifyContent: "center", opacity: p, translate: `0px ${(1 - p) * 24}px` }}>
      <div style={{ maxWidth: 1420, padding: "20px 34px 22px", background: "rgba(13,15,14,.9)", color: theme.text, fontFamily: theme.sans, fontSize: 30, lineHeight: 1.38, fontWeight: 500, borderRadius: 20, border: `1px solid ${theme.line}`, boxShadow: `0 14px 50px rgba(0,0,0,.5), inset 4px 0 0 ${theme.signal}` }}>{cur.text}</div>
    </div>
  );
};

const Zoomed: React.FC<{ readonly zooms: readonly Zoom[]; readonly children: React.ReactNode }> = ({ zooms, children }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const z = zoomAt(zooms, frame / fps);
  return (
    <div style={{ position: "absolute", left: LEFT, top: TOP, width: SHOW_W, height: SHOW_H, borderRadius: 22, overflow: "hidden", boxShadow: "0 30px 90px rgba(0,0,0,.6), 0 0 0 1px rgba(255,255,255,.07)", scale: String(z.scale), transformOrigin: `${z.ox}px ${z.oy}px`, background: "#0d0f0e" }}>
      {children}
    </div>
  );
};

/** One segment of the capture: its clips back to back (the waits cut out), its captions and zooms. */
export const Screen: React.FC<{ readonly seg: number }> = ({ seg }) => {
  const { fps } = useVideoConfig();
  const s: Segment = data.segments[seg];
  return (
    <AbsoluteFill style={{ background: "radial-gradient(1300px 900px at 50% 38%, #1a2a21 0%, #0a0c0b 70%)" }}>
      <Zoomed zooms={s.zooms}>
        <Series>
          {s.clips.map((c, i) => (
            <Series.Sequence key={i} durationInFrames={Math.max(1, Math.round((c.to - c.from) * fps))}>
              <Video src={staticFile("screen.mp4")} trimBefore={Math.round(c.from * fps)} style={{ width: SRC_W, height: SRC_H, position: "absolute", left: 0, top: 0 }} muted />
            </Series.Sequence>
          ))}
        </Series>
      </Zoomed>
      <Caption caps={s.captions} />
    </AbsoluteFill>
  );
};
