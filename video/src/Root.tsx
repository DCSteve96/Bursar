import React from "react";
import { Composition, staticFile } from "remotion";
import { Bursar, BursarShort, FPS, SHORT_TOTAL_FRAMES, TOTAL_FRAMES } from "./Bursar";

export const RemotionRoot: React.FC = () => {
  return (
    <>
    <Composition
      id="BursarShort"
      component={BursarShort}
      defaultProps={{ voice: [] }}
      // the narrator's clips, when voice.cjs has made them: public/voice/voice.json lists one per line of short.json
      calculateMetadata={async () => {
        try { const r = await fetch(staticFile("voice/voice.json")); if (r.ok) return { props: { voice: await r.json() } }; } catch {}
        return {};
      }}
      durationInFrames={SHORT_TOTAL_FRAMES}
      fps={FPS}
      width={1920}
      height={1080}
    />
    <Composition
      id="Bursar"
      component={Bursar}
      durationInFrames={TOTAL_FRAMES}
      fps={FPS}
      width={1920}
      height={1080}
    />
    </>
  );
};
