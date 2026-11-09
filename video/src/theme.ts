import { loadFont } from "@remotion/fonts";
import { staticFile } from "remotion";

// Local copies of the site's fonts (public/fonts), so the render needs no network. Same families as web/site.css.
const display = "Bricolage Grotesque", sans = "Manrope", mono = "JetBrains Mono";
void Promise.all([
  loadFont({ family: display, url: staticFile("fonts/BricolageGrotesque-500.woff2"), weight: "500" }),
  loadFont({ family: display, url: staticFile("fonts/BricolageGrotesque-700.woff2"), weight: "700" }),
  loadFont({ family: sans, url: staticFile("fonts/Manrope-400.woff2"), weight: "400" }),
  loadFont({ family: sans, url: staticFile("fonts/Manrope-500.woff2"), weight: "500" }),
  loadFont({ family: sans, url: staticFile("fonts/Manrope-600.woff2"), weight: "600" }),
  loadFont({ family: sans, url: staticFile("fonts/Manrope-700.woff2"), weight: "700" }),
  loadFont({ family: mono, url: staticFile("fonts/JetBrainsMono-400.woff2"), weight: "400" }),
  loadFont({ family: mono, url: staticFile("fonts/JetBrainsMono-500.woff2"), weight: "500" }),
]);

// The tokens of web/site.css.
export const theme = {
  display: `"${display}", "${sans}", sans-serif`,
  sans: `"${sans}", Inter, sans-serif`,
  mono: `"${mono}", ui-monospace, monospace`,
  signal: "#9df0c4",
  ink: "#0d0f0e",
  card: "#151917",
  line: "#232825",
  mute: "#8e9a92",
  text: "#e9efe9",
  soft: "#b9c4bc",
  held: "#ffc86e",
  blocked: "#ff8070",
};
