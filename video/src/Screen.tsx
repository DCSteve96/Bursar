import React from "react";
import { Video } from "@remotion/media";
import { AbsoluteFill, Easing, interpolate, staticFile, useCurrentFrame, useVideoConfig } from "remotion";
import { theme } from "./theme";
import { data } from "./data";

// The clean capture is 1280x800. It is shown inside a frame on the 1920x1080 canvas; zooms scale the whole frame
// around the point the capture's marks recorded, captions slide in below.
const SRC_W = 1280, SRC_H = 800;
const SHOW_W = 1600, SHOW_H = 1000;
const LEFT = (1920 - SHOW_W) / 2, TOP = (1080 - SHOW_H) / 2;

type Zoom = { readonly t: number; readonly ms: number; readonly scale: number; readonly x: number; readonly y: number; readonly w: number; readonly h: number };

const zoomAt = (second: number): { scale: number; ox: number; oy: number } => {
  for (const z of data.zooms as readonly Zoom[]) {
    const from = z.t, to = z.t + z.ms / 1000 + 1.0;
    if (second >= from - 0.9 && second <= to + 0.9) {
      const k = z.scale * 0.92; // a touch gentler than the in-page zoom
      const inP = interpolate(second, [from - 0.9, from], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: Easing.bezier(0.4, 0, 0.2, 1) });
      const outP = interpolate(second, [to, to + 0.9], [1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: Easing.bezier(0.4, 0, 0.2, 1) });
      const p = Math.min(inP, outP);
      const cx = (z.x + z.w / 2) / SRC_W, cy = (z.y + Math.min(z.h / 2, 260)) / SRC_H;
      return { scale: 1 + (k - 1) * p, ox: cx * SHOW_W, oy: cy * SHOW_H };
    }
  }
  return { scale: 1, ox: SHOW_W / 2, oy: SHOW_H / 2 };
};

const Caption: React.FC<{ readonly start: number }> = ({ start }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const second = start + frame / fps;
  const caps = data.captions;
  let cur: { t: number; text: string } | null = null;
  for (const c of caps) if (c.t <= second && c.t >= start - 3) cur = c; // only this stretch's captions
  if (!cur) return null;
  const age = second - cur.t;
  const next = caps.find((c) => c.t > cur!.t);
  const left = next ? next.t - second : 99;
  const inP = interpolate(age, [0, 0.45], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: Easing.bezier(0.16, 1, 0.3, 1) });
  const outP = interpolate(left, [0, 0.3], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const p = Math.min(inP, outP);
  return (
    <div style={{ position: "absolute", left: 0, right: 0, bottom: 44, display: "flex", justifyContent: "center", opacity: p, translate: `0px ${(1 - p) * 24}px` }}>
      <div style={{ maxWidth: 1380, padding: "20px 32px", background: "rgba(0,0,0,.84)", color: "#fff", fontFamily: theme.sans, fontSize: 30, lineHeight: 1.35, fontWeight: 500, borderRadius: 10, borderLeft: `6px solid ${theme.signal}`, boxShadow: "0 12px 40px rgba(0,0,0,.45)" }}>{cur.text}</div>
    </div>
  );
};

const Zoomed: React.FC<{ readonly start: number; readonly children: React.ReactNode }> = ({ start, children }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const z = zoomAt(start + frame / fps);
  return (
    <div style={{ position: "absolute", left: LEFT, top: TOP, width: SHOW_W, height: SHOW_H, borderRadius: 14, overflow: "hidden", boxShadow: "0 30px 90px rgba(0,0,0,.6), 0 0 0 1px rgba(255,255,255,.06)", scale: String(z.scale), transformOrigin: `${z.ox}px ${z.oy}px` }}>
      {children}
    </div>
  );
};

/** One stretch of the capture, from `start` to `end` seconds of screen.mp4. */
export const Screen: React.FC<{ readonly start: number; readonly end: number }> = ({ start, end }) => {
  const { fps } = useVideoConfig();
  return (
    <AbsoluteFill style={{ background: "radial-gradient(1200px 800px at 50% 40%, #16201b 0%, #070908 70%)" }}>
      <Zoomed start={start}>
        <Video src={staticFile("screen.mp4")} trimBefore={Math.round(start * fps)} durationInFrames={Math.round((end - start) * fps)} style={{ width: SHOW_W, height: SHOW_H }} muted />
      </Zoomed>
      <Caption start={start} />
    </AbsoluteFill>
  );
};
