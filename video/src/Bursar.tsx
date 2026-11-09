import React from "react";
import { Audio } from "@remotion/media";
import { TransitionSeries, linearTiming } from "@remotion/transitions";
import { fade } from "@remotion/transitions/fade";
import { AbsoluteFill, interpolate, staticFile, useCurrentFrame, useVideoConfig } from "remotion";
import { SlideClose, SlideHow, SlideIntro, SlideNever, SlideOutcomes, SlideProblem, SlideProof } from "./Slides";
import { Screen } from "./Screen";
import { data } from "./data";

export const FPS = 30;
const T = 20; // frames of crossfade between scenes

// Seconds for every scene, in order. The screen stretches are the capture's segments (see record.cjs), with the
// waits cut out by marks-to-data.cjs.
const seg = (i: number) => data.segments[i].seconds;
export const SCENES: readonly { readonly name: string; readonly seconds: number }[] = [
  { name: "Intro", seconds: 7 },
  { name: "Problem", seconds: 9 },
  { name: "How it works", seconds: 12 },
  { name: "Console: the first invoices", seconds: seg(0) },
  { name: "Never", seconds: 9 },
  { name: "Console: held, cross-chain, attention", seconds: seg(1) },
  { name: "Three answers", seconds: 9 },
  { name: "Explorer and verify", seconds: seg(2) },
  { name: "Proof", seconds: 10 },
  { name: "Close", seconds: 9 },
];
export const TOTAL_FRAMES = Math.round(SCENES.reduce((a, s) => a + s.seconds * FPS, 0) - (SCENES.length - 1) * T);

const Music: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();
  return (
    <Audio
      src={staticFile("music.mp3")}
      volume={interpolate(frame, [0, 2 * fps, durationInFrames - 7 * fps, durationInFrames - 1], [0, 0.4, 0.4, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" })}
    />
  );
};

export const Bursar: React.FC = () => {
  const { fps } = useVideoConfig();
  const f = (i: number) => Math.round(SCENES[i].seconds * fps);
  return (
    <AbsoluteFill style={{ background: "#0d0f0e" }}>
      <Music />
      <TransitionSeries>
        <TransitionSeries.Sequence name="Intro" durationInFrames={f(0)}><SlideIntro /></TransitionSeries.Sequence>
        <TransitionSeries.Transition presentation={fade()} timing={linearTiming({ durationInFrames: T })} />
        <TransitionSeries.Sequence name="Problem" durationInFrames={f(1)}><SlideProblem /></TransitionSeries.Sequence>
        <TransitionSeries.Transition presentation={fade()} timing={linearTiming({ durationInFrames: T })} />
        <TransitionSeries.Sequence name="How it works" durationInFrames={f(2)}><SlideHow /></TransitionSeries.Sequence>
        <TransitionSeries.Transition presentation={fade()} timing={linearTiming({ durationInFrames: T })} />
        <TransitionSeries.Sequence name="Console 1" durationInFrames={f(3)}><Screen seg={0} /></TransitionSeries.Sequence>
        <TransitionSeries.Transition presentation={fade()} timing={linearTiming({ durationInFrames: T })} />
        <TransitionSeries.Sequence name="Never" durationInFrames={f(4)}><SlideNever /></TransitionSeries.Sequence>
        <TransitionSeries.Transition presentation={fade()} timing={linearTiming({ durationInFrames: T })} />
        <TransitionSeries.Sequence name="Console 2" durationInFrames={f(5)}><Screen seg={1} /></TransitionSeries.Sequence>
        <TransitionSeries.Transition presentation={fade()} timing={linearTiming({ durationInFrames: T })} />
        <TransitionSeries.Sequence name="Three answers" durationInFrames={f(6)}><SlideOutcomes /></TransitionSeries.Sequence>
        <TransitionSeries.Transition presentation={fade()} timing={linearTiming({ durationInFrames: T })} />
        <TransitionSeries.Sequence name="Explorer and verify" durationInFrames={f(7)}><Screen seg={2} /></TransitionSeries.Sequence>
        <TransitionSeries.Transition presentation={fade()} timing={linearTiming({ durationInFrames: T })} />
        <TransitionSeries.Sequence name="Proof" durationInFrames={f(8)}><SlideProof /></TransitionSeries.Sequence>
        <TransitionSeries.Transition presentation={fade()} timing={linearTiming({ durationInFrames: T })} />
        <TransitionSeries.Sequence name="Close" durationInFrames={f(9)}><SlideClose /></TransitionSeries.Sequence>
      </TransitionSeries>
    </AbsoluteFill>
  );
};
