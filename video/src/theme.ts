import { loadFont } from "@remotion/fonts";
import { staticFile } from "remotion";

// Local copies of the site's fonts (public/fonts), so the render needs no network.
const sans = "Space Grotesk", mono = "IBM Plex Mono";
void Promise.all([
  loadFont({ family: sans, url: staticFile("fonts/SpaceGrotesk-400.woff2"), weight: "400" }),
  loadFont({ family: sans, url: staticFile("fonts/SpaceGrotesk-500.woff2"), weight: "500" }),
  loadFont({ family: sans, url: staticFile("fonts/SpaceGrotesk-700.woff2"), weight: "700" }),
  loadFont({ family: mono, url: staticFile("fonts/IBMPlexMono-400.woff2"), weight: "400" }),
  loadFont({ family: mono, url: staticFile("fonts/IBMPlexMono-500.woff2"), weight: "500" }),
  loadFont({ family: mono, url: staticFile("fonts/IBMPlexMono-600.woff2"), weight: "600" }),
]);

export const theme = {
  sans: `"${sans}", Inter, sans-serif`,
  mono: `"${mono}", ui-monospace, monospace`,
  signal: "#00ec97",
  ink: "#0d0f0e",
  card: "#161918",
  line: "#262a28",
  mute: "#9a9e9a",
  text: "#ffffff",
  soft: "#d7d9d7",
  held: "#ffc266",
  blocked: "#ff6b6b",
};
