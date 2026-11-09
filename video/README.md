# The demo video

A Remotion project. Slides built from the site's tokens and fonts, and a screen capture of the live console recorded by a script, so the video shows real readings and real contract decisions.

```bash
# 1. a fresh treasury on testnet, with the owner deciding held payments (no DAO)
cd ../app && npx tsx src/cli.ts setup --root <root>.testnet && npx tsx .bursar/cleardao.mts <root>.testnet
# 2. the capture: bursar.network driven with Playwright, marks for captions, zooms and cuts
cd ../video && node record.cjs <root>.testnet /tmp/take
# 3. public/screen.mp4 and src/data.ts from the capture and its marks
node marks-to-data.cjs /tmp/take
# 4. the video
npm install && npx remotion render Bursar out/bursar.mp4 --codec h264 --crf 18
```

The capture is recorded without captions; a 12 px clock strip at the bottom of every frame carries the script's clock, so every mark lands on the frame that really shows it, and the video crops the strip away. `public/music.mp3` is not in the repository.
