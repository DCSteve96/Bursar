import React from "react";
import { Audio } from "@remotion/media";
import { TransitionSeries, linearTiming } from "@remotion/transitions";
import { fade } from "@remotion/transitions/fade";
import { AbsoluteFill, interpolate, staticFile, useCurrentFrame, useVideoConfig } from "remotion";
import { SlideClose, SlideHow, SlideInOut, SlideIntro, SlideNever, SlideOutcomes, SlideProblem } from "./Slides";
import { Screen } from "./Screen";
import { data } from "./data";

export const FPS = 30;
const T = 20; // frames of crossfade between scenes

// Seconds for every scene, in order. Screen stretches come from the capture's marks (the gaps between the slides).
// the first seconds of every stretch are the page loading after a slide: skipped
const LEAD = 2.4;
const seg = (i: number) => { const s = data.segments.filter((x) => x.end > x.start)[i]; return { start: s.start + LEAD, end: s.end }; };
export const SCENES: readonly { readonly name: string; readonly seconds: number }[] = [
  { name: "Intro", seconds: 7 },
  { name: "Problem", seconds: 9 },
  { name: "How it works", seconds: 13 },
  { name: "Console, first invoices", seconds: seg(0).end - seg(0).start },
  { name: "Never", seconds: 9 },
  { name: "Held, cross-chain, withholding", seconds: seg(1).end - seg(1).start },
  { name: "Three answers", seconds: 9 },
  { name: "Attention, analytics", seconds: seg(2).end - seg(2).start },
  { name: "In and out", seconds: 8 },
  { name: "Settings, explorer", seconds: seg(3).end - seg(3).start },
  { name: "Close", seconds: 9 },
];
export const TOTAL_FRAMES = Math.round(SCENES.reduce((a, s) => a + s.seconds * FPS, 0) - (SCENES.length - 1) * T);

const Music: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();
  return (
    <Audio
      src={staticFile("music.mp3")}
      volume={interpolate(frame, [0, 2 * fps, durationInFrames - 7 * fps, durationInFrames - 1], [0, 0.42, 0.42, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" })}
    />
  );
};


export const Bursar: React.FC = () => {
  const { fps } = useVideoConfig();
  const f = (i: number) => Math.round(SCENES[i].seconds * fps);
  return (
    <AbsoluteFill style={{ background: "#000" }}>
      <Music />
      <TransitionSeries>
        <TransitionSeries.Sequence name="Intro" durationInFrames={f(0)}><SlideIntro /></TransitionSeries.Sequence>
        <TransitionSeries.Transition presentation={fade()} timing={linearTiming({ durationInFrames: T })} />
        <TransitionSeries.Sequence name="Problem" durationInFrames={f(1)}><SlideProblem /></TransitionSeries.Sequence>
        <TransitionSeries.Transition presentation={fade()} timing={linearTiming({ durationInFrames: T })} />
        <TransitionSeries.Sequence name="How it works" durationInFrames={f(2)}><SlideHow /></TransitionSeries.Sequence>
        <TransitionSeries.Transition presentation={fade()} timing={linearTiming({ durationInFrames: T })} />
        <TransitionSeries.Sequence name="Console 1" durationInFrames={f(3)}><Screen start={seg(0).start} end={seg(0).end} /></TransitionSeries.Sequence>
        <TransitionSeries.Transition presentation={fade()} timing={linearTiming({ durationInFrames: T })} />
        <TransitionSeries.Sequence name="Never" durationInFrames={f(4)}><SlideNever /></TransitionSeries.Sequence>
        <TransitionSeries.Transition presentation={fade()} timing={linearTiming({ durationInFrames: T })} />
        <TransitionSeries.Sequence name="Console 2" durationInFrames={f(5)}><Screen start={seg(1).start} end={seg(1).end} /></TransitionSeries.Sequence>
        <TransitionSeries.Transition presentation={fade()} timing={linearTiming({ durationInFrames: T })} />
        <TransitionSeries.Sequence name="Three answers" durationInFrames={f(6)}><SlideOutcomes /></TransitionSeries.Sequence>
        <TransitionSeries.Transition presentation={fade()} timing={linearTiming({ durationInFrames: T })} />
        <TransitionSeries.Sequence name="Console 3" durationInFrames={f(7)}><Screen start={seg(2).start} end={seg(2).end} /></TransitionSeries.Sequence>
        <TransitionSeries.Transition presentation={fade()} timing={linearTiming({ durationInFrames: T })} />
        <TransitionSeries.Sequence name="In and out" durationInFrames={f(8)}><SlideInOut /></TransitionSeries.Sequence>
        <TransitionSeries.Transition presentation={fade()} timing={linearTiming({ durationInFrames: T })} />
        <TransitionSeries.Sequence name="Console 4" durationInFrames={f(9)}><Screen start={seg(3).start} end={seg(3).end} /></TransitionSeries.Sequence>
        <TransitionSeries.Transition presentation={fade()} timing={linearTiming({ durationInFrames: T })} />
        <TransitionSeries.Sequence name="Close" durationInFrames={f(10)}><SlideClose /></TransitionSeries.Sequence>
      </TransitionSeries>
    </AbsoluteFill>
  );
};
