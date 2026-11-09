# The demo video

A Remotion project. Slides built from the site's tokens and fonts, and a screen capture of the live console recorded by a script, so the video shows real readings and real contract decisions.

```bash
# 1. a fresh treasury on testnet, with the owner deciding held payments (no DAO)
cd ../app && npx tsx src/cli.ts setup --root <root>.testnet && npx tsx .bursar/cleardao.mts <root>.testnet
# 2. the capture: bursar.network driven with Playwright, marks for captions, zooms and cuts
cd ../video && node record.cjs <root>.testnet /tmp/take
# 3. public/screen.mp4 and src/data.ts from the capture and its marks
node marks-to-data.cjs /tmp/take
# 4. the videos: the short cut for the post on X, the full walkthrough
npm install
npx remotion render BursarShort out/bursar-short.mp4 --codec h264 --crf 18
npx remotion render Bursar out/bursar.mp4 --codec h264 --crf 18
```

Two compositions from the same capture. `BursarShort` (about two minutes) is the demo for the post on X: the problem in one slide, then straight to real actions and their results (an invoice paid, the "new bank details" invoice blocked, a large one held and approved, a vendor on Base queued, one byte of a receipt changed and the signature failing). It follows the hackathon's guidance for the demo, "skip long intros, architecture slides, and setup", and fits the 2:20 that X takes from any account. `Bursar` (3:41) is the full walkthrough with the slides on how it works.

The capture is recorded without captions; a 12 px clock strip at the bottom of every frame carries the script's clock, so every mark lands on the frame that really shows it, and the video crops the strip away. `public/music.mp3` is not in the repository.
