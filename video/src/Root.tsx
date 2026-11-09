import React from "react";
import { Composition } from "remotion";
import { Bursar, BursarShort, FPS, SHORT_TOTAL_FRAMES, TOTAL_FRAMES } from "./Bursar";

export const RemotionRoot: React.FC = () => {
  return (
    <>
    <Composition
      id="BursarShort"
      component={BursarShort}
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
