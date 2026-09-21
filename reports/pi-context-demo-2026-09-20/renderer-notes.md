# Actual Pi terminal recording renderer

This renderer converts an asciinema v2 PTY recording into an H.264 MP4, retaining
the original output-event timing. It replays the ANSI stream into a terminal
screen model; it does not manufacture terminal text. A distinct caption panel is
rendered beneath the terminal. `index.html` additionally puts a synchronized
read-only caption textarea below the video, including when opened locally.

The recording must use fixed terminal dimensions. Approximately 112 columns ×
40 rows works well at the default 1920 × 1440 render size. Caption inputs must
be ordered and nonoverlapping:

```json
[{"start": 0, "end": 6, "text": "Description of the actual recorded action."}]
```

## Run

```bash
/private/tmp/jev-video-renderer/.venv/bin/python \
  /private/tmp/jev-video-renderer/render_video.py \
  --cast /absolute/path/recording.cast \
  --captions /absolute/path/captions.json \
  --output-dir /absolute/path/video-output \
  --still-at 30 --still-at 60
```

The output directory contains the MP4, local HTML player, captions in JSON,
WebVTT, SRT and text formats, original capture, final terminal state as text,
selected PNG stills, ffmpeg log, and a validation/provenance JSON with input and
video SHA-256 hashes. The defaults add two seconds of final screen hold; no
initial/final capture time is trimmed. `--hold-final 0` disables that hold.

Dependencies are pyte 0.8.2, Pillow 12.3.0, wcwidth 0.8.2, fontTools 4.63.0, and ffmpeg 8.0. The
temporary environment uses Homebrew Python with existing system packages and
an installed pyte wheel. Font paths are the standard macOS Menlo TTC and Arial
files. Menlo TTC indices select regular/bold/italic/bold-italic. The renderer
implements alternate buffers for common xterm modes, cursor replay, scrolling,
true color, 256 colors, and text styling.

Installed Cascadia Mono NF, Gohu Nerd Font Mono, Apple Symbols and Apple Color
Emoji supply fallback glyphs when Menlo lacks a code point. The provenance file
records the selected fallback fonts and any unavailable glyph code points.
The HTML poster uses the saved still closest to 25 seconds; playback starts at
the real beginning and the timeline is unchanged.
The last caption remains visible through the final quantized video frame and in
the caption textarea after playback ends. Seeking backward restores the caption
for the actual selected playback time.

The cursor uses captured position/visibility with a static outline. Pixel
rasterization and palette can differ from a native terminal. OSC title changes,
hyperlinks, bells and keyboard/mouse negotiations are ignored; these have no
effect on recorded terminal text. Sixel/kitty inline images are not supported;
font fallback appearance and emoji scaling can differ from native rendering.
The per-recording protocol audit identifies ignored and
unsupported sequence types without logging their payloads. Inspect stills and
the audit before presenting a recording as faithful.
