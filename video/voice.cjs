// The narrator of the short cut. The lines and where each one starts are in src/short.json.
//   node voice.cjs script            writes narration.txt: the text to paste into ElevenLabs, one paragraph per line,
//                                    with a pause between them so the recording can be cut back into lines
//   node voice.cjs <recording.mp3>   one recording of the whole text: cut at its longest pauses into one clip per line
//   node voice.cjs <folder>          or one file per line, named 01.mp3, 02.mp3, ... (mp3, wav or m4a)
// Each clip is trimmed, levelled, checked against the time it has before the next line starts (sped up by at most
// 12 percent when it runs over, reported when that is not enough) and written to public/voice with voice.json, which
// the BursarShort composition reads. Then: npx remotion render BursarShort out/bursar-short.mp4
const fs = require("fs"), path = require("path");
const { execFileSync, spawnSync } = require("child_process");
const here = __dirname;
const short = JSON.parse(fs.readFileSync(path.join(here, "src", "short.json"), "utf8"));
const data = JSON.parse(fs.readFileSync(path.join(here, "src", "data.ts"), "utf8").replace(/^[\s\S]*?export const data = /, "").replace(/ as const;\s*$/, ""));
const FPS = 30, T = 20 / FPS; // the crossfade between scenes, as in Bursar.tsx
const lines = short.narration;
const sceneSeconds = (s) => s.seg === undefined ? s.seconds : (s.to ?? data.segments[s.seg].seconds) - (s.from ?? 0);
const starts = short.scenes.map((_, i) => short.scenes.slice(0, i).reduce((a, s) => a + sceneSeconds(s) - T, 0));
const total = starts[starts.length - 1] + sceneSeconds(short.scenes[short.scenes.length - 1]);
const startOf = (l) => starts[l.scene] + l.at;
// the time a line has: until the next line starts, or until the video ends
const slotOf = (i) => (i + 1 < lines.length ? startOf(lines[i + 1]) - 0.25 : total - 0.8) - startOf(lines[i]);
const clock = (s) => `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, "0")}`;
const PAUSE = 1.5;

const arg = process.argv[2];
if (!arg) { console.error("usage: node voice.cjs script | <recording> | <folder of 01.mp3, 02.mp3, ...>"); process.exit(1); }

if (arg === "script") {
  const text = lines.map((l) => l.say ?? l.text).join(`\n\n<break time="${PAUSE}s" />\n\n`) + "\n";
  fs.writeFileSync(path.join(here, "narration.txt"), text);
  console.log(`narration.txt written: ${lines.length} lines, ${text.split(/\s+/).filter((w) => !/[<>]|break|time=/.test(w)).length} words, video ${clock(total)}\n`);
  lines.forEach((l, i) => console.log(`${String(i + 1).padStart(2, "0")}  starts ${clock(startOf(l))}  has ${slotOf(i).toFixed(1)} s  ${(l.say ?? l.text).split(" ").length} words\n    ${l.say ?? l.text}`));
  process.exit(0);
}

const ffmpeg = (args) => { const r = spawnSync("ffmpeg", ["-hide_banner", "-nostdin", ...args], { encoding: "utf8", maxBuffer: 1 << 28 }); if (r.status !== 0) throw new Error("ffmpeg: " + r.stderr.slice(-400)); return r.stderr; };
const seconds = (f) => Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", f], { encoding: "utf8" }).trim());
const outDir = path.join(here, "public", "voice"), tmp = path.join(outDir, ".tmp");
fs.rmSync(outDir, { recursive: true, force: true }); fs.mkdirSync(tmp, { recursive: true });
const raw = (i) => path.join(tmp, `${String(i + 1).padStart(2, "0")}.wav`);

if (fs.statSync(arg).isDirectory()) {
  lines.forEach((_, i) => {
    const n = String(i + 1).padStart(2, "0"), f = ["mp3", "wav", "m4a"].map((e) => path.join(arg, `${n}.${e}`)).find((p) => fs.existsSync(p));
    if (!f) throw new Error(`no file ${n}.mp3 in ${arg}: ${lines.length} lines need ${lines.length} files`);
    ffmpeg(["-y", "-i", f, "-ac", "1", "-ar", "48000", raw(i)]);
  });
} else {
  // one recording: the pauses between the lines are the longest silences in it
  const whole = seconds(arg);
  const log = ffmpeg(["-i", arg, "-af", "silencedetect=noise=-38dB:d=0.35", "-f", "null", "-"]);
  const sil = []; let open = null;
  for (const m of log.matchAll(/silence_(start|end): (-?[\d.]+)/g)) { if (m[1] === "start") open = Math.max(0, Number(m[2])); else if (open !== null) { sil.push({ from: open, to: Number(m[2]) }); open = null; } }
  const inner = sil.filter((s) => s.from > 0.2 && s.to < whole - 0.2);
  if (inner.length < lines.length - 1) throw new Error(`the recording has ${inner.length} pauses, ${lines.length - 1} are needed between ${lines.length} lines: record one file per line instead (01.mp3, 02.mp3, ...)`);
  const cuts = inner.slice().sort((a, b) => (b.to - b.from) - (a.to - a.from)).slice(0, lines.length - 1).sort((a, b) => a.from - b.from);
  const shortest = Math.min(...cuts.map((c) => c.to - c.from)), rest = inner.filter((s) => !cuts.includes(s)).map((s) => s.to - s.from), longestLeft = rest.length ? Math.max(...rest) : 0;
  console.log(`recording ${clock(whole)}: cut at ${cuts.length} pauses of ${shortest.toFixed(2)} s or more (the longest pause inside a line is ${longestLeft.toFixed(2)} s)`);
  if (longestLeft > shortest * 0.75) console.log("WARNING: a pause inside a line is almost as long as a pause between lines; listen to the clips, or record one file per line");
  const edges = [0, ...cuts.map((c) => (c.from + c.to) / 2), whole];
  lines.forEach((_, i) => ffmpeg(["-y", "-ss", String(edges[i]), "-to", String(edges[i + 1]), "-i", arg, "-ac", "1", "-ar", "48000", raw(i)]));
}

// trim the silence at both ends, level, fit
const TRIM = "silenceremove=start_periods=1:start_threshold=-45dB:start_silence=0.03,areverse,silenceremove=start_periods=1:start_threshold=-45dB:start_silence=0.08,areverse";
const voice = []; let over = 0;
console.log("\n line  starts   has     clip    tempo");
lines.forEach((l, i) => {
  const n = String(i + 1).padStart(2, "0"), trimmed = path.join(tmp, `${n}-t.wav`), out = path.join(outDir, `${n}.mp3`);
  ffmpeg(["-y", "-i", raw(i), "-af", `${TRIM},loudnorm=I=-16:TP=-1.5:LRA=11`, "-ar", "48000", trimmed]);
  const len = seconds(trimmed), slot = slotOf(i), tempo = len > slot ? Math.min(1.12, len / slot) : 1;
  ffmpeg(["-y", "-i", trimmed, ...(tempo > 1 ? ["-af", `atempo=${tempo.toFixed(4)}`] : []), "-c:a", "libmp3lame", "-b:a", "192k", out]);
  const final = seconds(out), fits = final <= slot + 0.05;
  if (!fits) over++;
  console.log(`  ${n}   ${clock(startOf(l))}  ${slot.toFixed(1).padStart(5)}  ${final.toFixed(1).padStart(5)}   ${tempo > 1 ? "x" + tempo.toFixed(2) : "     "}  ${fits ? "" : `TOO LONG by ${(final - slot).toFixed(1)} s: shorten the line in src/short.json`}`);
  voice.push({ file: `voice/${n}.mp3`, seconds: Number(final.toFixed(2)) });
});
fs.rmSync(tmp, { recursive: true, force: true });
fs.writeFileSync(path.join(outDir, "voice.json"), JSON.stringify(voice, null, 1));
console.log(`\n${voice.length} clips in public/voice, video ${clock(total)}.` + (over ? ` ${over} line(s) run over the next one: fix them before rendering.` : " Every line fits. Render: npx remotion render BursarShort out/bursar-short.mp4 --codec h264 --crf 18"));
process.exit(over ? 2 : 0);
