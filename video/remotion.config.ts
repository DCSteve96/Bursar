import { Config } from "@remotion/cli/config";

Config.setVideoImageFormat("jpeg");
Config.setOverwriteOutput(true);
// Chromium from the Playwright install, so nothing is downloaded at render time.
// Remotion downloads its own chrome-headless-shell on first use (npx remotion browser ensure).
