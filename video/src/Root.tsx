import React from "react";
import { Composition } from "remotion";
import { Bursar, FPS, TOTAL_FRAMES } from "./Bursar";

export const RemotionRoot: React.FC = () => {
  return (
    <Composition
      id="Bursar"
      component={Bursar}
      durationInFrames={TOTAL_FRAMES}
      fps={FPS}
      width={1920}
      height={1080}
    />
  );
};
