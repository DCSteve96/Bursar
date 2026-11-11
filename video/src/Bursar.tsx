import React from "react";
import { Audio } from "@remotion/media";
import { TransitionSeries, linearTiming } from "@remotion/transitions";
import { fade } from "@remotion/transitions/fade";
import { AbsoluteFill, Sequence, interpolate, staticFile, useCurrentFrame, useVideoConfig } from "remotion";
import { SlideClose, SlideCloseShort, SlideHook, SlideHow, SlideIntro, SlideNever, SlideOutcomes, SlideProblem, SlideProof } from "./Slides";
import { Screen } from "./Screen";
import { data } from "./data";
import short from "./short.json";

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

// ---- the short cut for the post on X: the problem in one slide, then straight to a real action and its result.
// The hackathon's guidance for the demo ("skip long intros, architecture slides, and setup") and the 140 seconds X
// takes from any account. Scenes and narration are in short.json; the narrator's clips (public/voice, made by
// voice.cjs from an ElevenLabs recording) are optional: without them the video is the same, with music only.
export type VoiceClip = { readonly file: string; readonly seconds: number } | null;
type ShortScene = { readonly name: string; readonly slide?: string; readonly seconds?: number; readonly seg?: number; readonly from?: number; readonly to?: number | null };
type Line = { readonly scene: number; readonly at: number; readonly text: string; readonly say?: string };
const SCENES_SHORT = short.scenes as readonly ShortScene[];
const LINES = short.narration as readonly Line[];
const secondsOf = (s: ShortScene) => s.seg === undefined ? s.seconds! : (s.to ?? data.segments[s.seg].seconds) - (s.from ?? 0);
const framesOf = (s: ShortScene) => Math.round(secondsOf(s) * FPS);
// the frame every scene starts at: each crossfade overlaps the scene before it
const STARTS = SCENES_SHORT.map((_, i) => SCENES_SHORT.slice(0, i).reduce((a, s) => a + framesOf(s) - T, 0));
export const SHORT_TOTAL_FRAMES = STARTS[STARTS.length - 1] + framesOf(SCENES_SHORT[SCENES_SHORT.length - 1]);
const lineFrame = (l: Line) => STARTS[l.scene] + Math.round(l.at * FPS);
// how long a line stays on screen as a subtitle: its clip, or a reading time when there is no voice
const lineSeconds = (l: Line, v: VoiceClip | undefined) => v ? v.seconds + 0.5 : l.text.split(" ").length / 2.6 + 1.2;

// Music under the narrator: full between the lines, down to a third while a clip plays.
const ShortMusic: React.FC<{ readonly voice: readonly VoiceClip[] }> = ({ voice }) => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();
  const base = interpolate(frame, [0, 2 * fps, durationInFrames - 5 * fps, durationInFrames - 1], [0, 0.4, 0.4, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  let duck = 0;
  LINES.forEach((l, i) => {
    const v = voice[i]; if (!v) return;
    const a = lineFrame(l), b = a + v.seconds * fps;
    duck = Math.max(duck, Math.min(interpolate(frame, [a - 0.4 * fps, a], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }), interpolate(frame, [b, b + 0.6 * fps], [1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" })));
  });
  return <Audio src={staticFile("music.mp3")} volume={base * (1 - 0.68 * duck)} />;
};

export const BursarShort: React.FC<{ readonly voice: readonly VoiceClip[] }> = ({ voice }) => {
  const scene = (i: number) => {
    const s = SCENES_SHORT[i];
    if (s.slide === "hook") return <SlideHook />;
    if (s.slide === "close") return <SlideCloseShort />;
    // the subtitles of a window are the narrator's lines, so the video reads the same with the sound off
    const captions = LINES.map((l, k) => ({ l, k })).filter(({ l }) => l.scene === i).map(({ l, k }) => ({ at: l.at, text: l.text, until: l.at + lineSeconds(l, voice[k]) }));
    return <Screen seg={s.seg!} from={s.from ?? 0} to={(s.from ?? 0) + secondsOf(s)} captions={captions} />;
  };
  return (
    <AbsoluteFill style={{ background: "#0d0f0e" }}>
      <ShortMusic voice={voice} />
      {LINES.map((l, i) => voice[i] ? (
        <Sequence key={i} name={`Voice ${i + 1}`} from={lineFrame(l)} durationInFrames={Math.ceil(voice[i]!.seconds * FPS) + 3}>
          <Audio src={staticFile(voice[i]!.file)} />
        </Sequence>
      ) : null)}
      <TransitionSeries>
        <TransitionSeries.Sequence name={SCENES_SHORT[0].name} durationInFrames={framesOf(SCENES_SHORT[0])}>{scene(0)}</TransitionSeries.Sequence>
        <TransitionSeries.Transition presentation={fade()} timing={linearTiming({ durationInFrames: T })} />
        <TransitionSeries.Sequence name={SCENES_SHORT[1].name} durationInFrames={framesOf(SCENES_SHORT[1])}>{scene(1)}</TransitionSeries.Sequence>
        <TransitionSeries.Transition presentation={fade()} timing={linearTiming({ durationInFrames: T })} />
        <TransitionSeries.Sequence name={SCENES_SHORT[2].name} durationInFrames={framesOf(SCENES_SHORT[2])}>{scene(2)}</TransitionSeries.Sequence>
        <TransitionSeries.Transition presentation={fade()} timing={linearTiming({ durationInFrames: T })} />
        <TransitionSeries.Sequence name={SCENES_SHORT[3].name} durationInFrames={framesOf(SCENES_SHORT[3])}>{scene(3)}</TransitionSeries.Sequence>
        <TransitionSeries.Transition presentation={fade()} timing={linearTiming({ durationInFrames: T })} />
        <TransitionSeries.Sequence name={SCENES_SHORT[4].name} durationInFrames={framesOf(SCENES_SHORT[4])}>{scene(4)}</TransitionSeries.Sequence>
      </TransitionSeries>
    </AbsoluteFill>
  );
};
