---
name: hex-annotate
description: Read and dig into Hex Annotate captures, where someone recorded their screen while talking, clicking and drawing red marks on it. Hex writes them as Scrawl bundles. Use whenever a message contains a capture (a line like `[scrawl 0:12 · App “Window” · /path/to/….scrawl]`, a `.scrawl` bundle path, or a contact-sheet.png from one), when the user says "look at my annotation", "my capture" or "my scrawl" or refers to something they just recorded or drew, or when you need `hex annotate` to list, show or send a capture, or ffmpeg to zoom into a moment, pull frames or export a video.
---

# Hex Annotate captures

Hex's Annotate records someone's screen, voice, clicks and red ink, then packs the result into a `.scrawl` folder (a bundle, in Scrawl's format). They send it to show you a problem instead of describing it, so the capture is the bug report. Read it closely before you answer, and don't ask them to explain again what the capture already shows. If something is unclear, look closer at the video first (see "Look closer at a moment").

## What a paste looks like

```text
[scrawl 0:33 · OpenCode “Settings” · /Users/me/Library/Application Support/scrawl/captures/1792432139176.scrawl]
Open contact-sheet.png and frames/ in that folder before changing anything: the marks and words only make sense on the images, which can show more than the text does.
Cropped to: the activity in OpenCode (full frames in frames-full/)
- #1 (0:04) [clicked “New tab”] “Command T makes a new session, but here it should make a tab.”
- #2 (0:07) “No, it doesn't.”
- #3 (0:10) ⚑ “It says command shift B makes a new tab.”
- #4 (0:18) clicked (x 0.51, y 0.93)
```

- The first line has the length, the app and window recorded, and the bundle path.
- The next line asks you to open the images first. Do: the text is only what was said and done, and a problem can show in a frame without being marked or mentioned.
- Each `#N (M:SS)` line is a keyframe: what they did at that moment in brackets, then what they said while it was on screen. A line with no quote has the action alone.
- `⚑` means they flagged the moment on purpose. `⟨Name⟩` means the app reported a new screen. Lines starting `·` are events or values the app logged.
- Optional lines near the top: `For session:` (where Hex sent it), `Screen:` with app context, `Note:`, and `Cropped to:`.
- Coordinates are fractions of the captured area, from the top left (x 0.51 is just right of centre).

When you answer, refer to moments the same way, as in "#3 (0:10)", so the person can find them on the contact sheet.

## Reading a bundle

1. Look at `contact-sheet.png` in the bundle first (it's often attached already). It shows every keyframe in time order, left to right and top to bottom, each with its number `N` in a small white chip in a top corner (the `#N` in `summary.md`).
2. Read the transcript lines next to it. Speech recognition mishears names and code terms, so trust the screen when the two disagree.
3. Open `frames/frame-NN.png` for any keyframe you need at full size (`frame-03.png` is #3). When the summary says `Cropped to:`, the uncropped screens are in `frames-full/`.

What the drawings mean:

- Red strokes, circles, underlines and arrows are the person's marks, and they point at the problem. Marks drawn on the same screen all show on one keyframe. When there are several, the text numbers them in drawing order (`✎① 0:06 …`, `✎② 0:09 …`). The image shows only the ink; `marks` in `scrawl.json` says which is which (below).
- A ripple around the cursor shows a click or tap, and a finger trail shows a swipe.
- A glowing red trail that tapers off is the laser pointer, used to point without leaving a mark.

`scrawl.json` is the full manifest:

- `keyframes`: `index` (the `#N`), `t` in ms, `reason`, `file`, `event`, `said`, and `markId` when a mark made it.
- `marks`: `id` (`m1`), `t0`/`t1` in ms, `shape`, `description`, `frame`, and `boxNorm` as `[x0, y0, x1, y1]` fractions of the captured area. Use the box to see what a mark encloses.
- `transcript.words` with times, `events`, app `context`, `autocrop`, and `videoOffsetMs`.

`recording.mp4` (or `recording.mov`) and `audio.wav` are the source media. `capture.json` is Hex's record of the capture sources and any audio gaps.

## Times

Every time in `summary.md` and `scrawl.json` is on the capture's clock, which starts at 0 with the audio. The video starts `videoOffsetMs` later, so capture time `t` is video time `t - videoOffsetMs`. Subtract it before seeking in `recording.mp4`.

## The hex annotate CLI

`hex` is the Hex app's own binary. If `command -v hex` finds nothing, use `/Applications/Hex.app/Contents/MacOS/hex`. It runs only on the Mac with Hex installed; elsewhere, read `contact-sheet.png`, `frames/` and `scrawl.json` directly. Commands take a bundle name, a path, or `latest`. Quote paths, because they usually contain `Application Support`.

```sh
hex annotate list [--limit N] [--json]      # newest captures first
hex annotate show <capture> [--json]        # one capture's words, files, and where it went
hex annotate status [--json]                # what records, what is being written, the last capture
hex annotate route <capture> [--json]       # what routing sees and decides; sends nothing
hex annotate send <capture> [--to <session>] [--json]   # send to an OpenCode session
hex annotate undo                           # take back the newest send while it can be undone
```

- `send` without `--to` goes where the capture's route or last send says. Check with the person before sending somewhere else, and never pass `--always`, which saves a routing rule, unless they ask.
- `start`, `stop`, `cancel` and `toggle` record a new capture in the running Hex; the person usually does this with the Annotate shortcut instead.

## Look closer at a moment

Use the video when the problem is motion (an animation, a jump, a flicker) or happens between keyframes, or when you can't tell what a mark points at. `ffmpeg` reads `recording.mp4`. Write output to a temporary folder, never into the bundle: Hex manages the bundle's files and removes them on its retention schedule.

```sh
bundle="/path/to/….scrawl"; out="$(mktemp -d)"
offset=0.171        # videoOffsetMs / 1000, from scrawl.json
# A 4x3 sheet of 12 frames over 2 s around capture time 3.05 s (a quarter before it):
ffmpeg -v error -ss "$(echo "3.05 - $offset - 0.5" | bc)" -t 2 -i "$bundle/recording.mp4" \
  -vf "fps=6,scale=640:-2,tile=4x3" -frames:v 1 "$out/zoom.png"
# Plain PNGs of capture time 2.5-3.5 s at 4 fps:
ffmpeg -v error -ss "$(echo "2.5 - $offset" | bc)" -t 1 -i "$bundle/recording.mp4" \
  -vf fps=4 "$out/frame-%02d.png"
```

Open the PNGs and look at them before you act on the feedback. Sheet cells run left to right, top to bottom, `span / count` seconds apart. The video is the whole display, uncropped; crop to a mark with its `boxNorm` (`-vf "crop=iw*(x1-x0):ih*(y1-y0):iw*x0:ih*y0"`) or to the `autocrop` region. Ink and the capsule are in the video only when Annotate's "Show in screen recordings" setting is on; otherwise use the keyframes and `boxNorm` for what was drawn.

## Export a shareable video

`recording.mp4` has no audio track. Join it with `audio.wav`, trimming the audio by the offset so speech stays in sync:

```sh
ffmpeg -v error -i "$bundle/recording.mp4" -ss "$offset" -i "$bundle/audio.wav" \
  -map 0:v -map 1:a -c:v copy -c:a aac -shortest "$out/capture.mp4"
```

Video and audio are removed after the person's Annotate retention period (7 days unless they changed it in Settings › Annotate). After that only `frames/`, the contact sheets, `summary.md` and `scrawl.json` remain, so the video steps above can't run.
