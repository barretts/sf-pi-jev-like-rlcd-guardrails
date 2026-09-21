#!/usr/bin/env python3
"""Render an actual asciinema v2 PTY capture, preserving its recorded timing.

Terminal pixels originate only from output events replayed through pyte.
The title and caption panel are editorial overlays, outside the terminal.
"""
from __future__ import annotations

import argparse
import collections
import copy
import hashlib
import html
import importlib.metadata
import json
import math
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
from typing import Any
from urllib.parse import quote

import pyte
from PIL import Image, ImageDraw, ImageFont
from fontTools.ttLib import TTFont
from wcwidth import wcswidth


PALETTE = {
    "default": "#d7e0ee", "black": "#10151f", "red": "#ed7587",
    "green": "#a6d189", "brown": "#e5c890", "yellow": "#e5c890",
    "blue": "#8caaee", "magenta": "#c6a0f6", "cyan": "#81c8be",
    "white": "#d7e0ee", "brightblack": "#737e96", "brightred": "#f59cac",
    "brightgreen": "#b7e5a0", "brightbrown": "#f3dda9", "brightyellow": "#f3dda9",
    "brightblue": "#b5c9fa", "brightmagenta": "#e2c8ff", "brightcyan": "#a5e4df",
    "brightwhite": "#ffffff",
}
TERM_BG = "#111723"
PAGE_BG = "#0a0e16"
CAPTION_BG = "#18243a"
CAPTION_FG = "#f3f6fb"
MUTED = "#a0aec3"
ACCENT = "#90c7ff"


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


class ReplayScreen(pyte.Screen):
    """pyte VT screen plus xterm's alternate-buffer modes and common CSI extras."""

    def __init__(self, columns: int, lines: int):
        self.protocol_counts = collections.Counter()
        self._primary: dict[str, Any] | None = None
        self._saved_1048 = None
        self._repeat_char = " "
        super().__init__(columns, lines)

    def draw(self, data: str) -> None:
        super().draw(data)
        if data:
            self._repeat_char = data[-1]

    def set_mode(self, *modes: int, **kwargs: Any) -> None:
        if kwargs.get("private"):
            if 1048 in modes:
                self._saved_1048 = copy.copy(self.cursor)
            if any(mode in (47, 1047, 1049) for mode in modes) and self._primary is None:
                names = ("buffer", "cursor", "savepoints", "margins", "tabstops",
                         "g0_charset", "g1_charset", "charset", "mode")
                self._primary = {name: copy.deepcopy(getattr(self, name)) for name in names}
                # Reset provides a clean secondary buffer. Main state is retained separately.
                super().reset()
                self.dirty.update(range(self.lines))
            for mode in modes:
                if mode not in (1, 3, 5, 6, 7, 12, 25, 47, 1000, 1002, 1003,
                                 1004, 1006, 1015, 1047, 1048, 1049, 2004, 2026):
                    self.protocol_counts[f"private_mode_{mode}"] += 1
        super().set_mode(*modes, **kwargs)

    def reset_mode(self, *modes: int, **kwargs: Any) -> None:
        if kwargs.get("private"):
            if any(mode in (47, 1047, 1049) for mode in modes) and self._primary is not None:
                for name, value in self._primary.items():
                    setattr(self, name, value)
                self._primary = None
                self.dirty.update(range(self.lines))
            if 1048 in modes and self._saved_1048 is not None:
                self.cursor = copy.copy(self._saved_1048)
        super().reset_mode(*modes, **kwargs)

    def scroll_up(self, count: int = 1, **_: Any) -> None:
        saved = (self.cursor.x, self.cursor.y)
        top, bottom = self.margins or (0, self.lines - 1)
        self.cursor.y = bottom
        for _ in range(count or 1):
            self.index()
        self.cursor.x, self.cursor.y = saved

    def scroll_down(self, count: int = 1, **_: Any) -> None:
        saved = (self.cursor.x, self.cursor.y)
        top, bottom = self.margins or (0, self.lines - 1)
        self.cursor.y = top
        for _ in range(count or 1):
            self.reverse_index()
        self.cursor.x, self.cursor.y = saved

    def repeat_character(self, count: int = 1, **_: Any) -> None:
        self.draw(self._repeat_char * (count or 1))

    def save_cursor_csi(self, *_: Any, **__: Any) -> None:
        self.save_cursor()

    def restore_cursor_csi(self, *_: Any, **__: Any) -> None:
        self.restore_cursor()


class ReplayStream(pyte.Stream):
    csi = dict(pyte.Stream.csi, S="scroll_up", T="scroll_down", b="repeat_character",
               s="save_cursor_csi", u="restore_cursor_csi")


class TerminalReplay:
    """Incremental protocol filter; unsupported strings never leak into visible text."""

    def __init__(self, columns: int, lines: int):
        self.screen = ReplayScreen(columns, lines)
        self.stream = ReplayStream(self.screen)
        self.pending = ""
        self.protocol_counts = collections.Counter()

    def feed(self, data: str) -> None:
        data = self.pending + data
        self.pending = ""
        output: list[str] = []
        pos = 0
        while pos < len(data):
            char = data[pos]
            if char not in ("\x1b", "\x9b", "\x9d", "\x90", "\x9f", "\x9e"):
                output.append(char)
                pos += 1
                continue
            start = pos
            if char == "\x1b":
                if pos + 1 == len(data):
                    self.pending = data[pos:]
                    break
                introducer = data[pos + 1]
                pos += 2
            else:
                introducer = {"\x9b": "[", "\x9d": "]", "\x90": "P",
                              "\x9f": "_", "\x9e": "^"}[char]
                pos += 1
            if introducer == "[":
                scan = pos
                while scan < len(data) and not ("@" <= data[scan] <= "~"):
                    scan += 1
                if scan == len(data):
                    self.pending = data[start:]
                    break
                body, final = data[pos:scan], data[scan]
                sequence = data[start:scan + 1]
                # Keyboard reporting, cursor style, and synchronization are non-pixel protocols.
                if body.startswith((">", "=", "<")) or any(" " <= c <= "/" for c in body):
                    self.protocol_counts[f"ignored_csi_{final}"] += 1
                elif final in ReplayStream.csi:
                    if ":" in body:
                        body = body.replace(":", ";").replace(";;", ";")
                        sequence = "\x1b[" + body + final
                        self.protocol_counts["normalized_colon_csi"] += 1
                    output.append(sequence)
                else:
                    self.protocol_counts[f"unsupported_csi_{final}"] += 1
                pos = scan + 1
            elif introducer in ("]", "P", "_", "^", "X"):
                scan = pos
                while scan < len(data):
                    if data[scan] in ("\x07", "\x9c"):
                        end = scan + 1
                        break
                    if data[scan:scan + 2] == "\x1b\\":
                        end = scan + 2
                        break
                    scan += 1
                else:
                    self.pending = data[start:]
                    break
                if introducer == "]":
                    self.protocol_counts["ignored_osc"] += 1
                else:
                    self.protocol_counts[f"unsupported_string_{introducer}"] += 1
                pos = end
            elif introducer in ("(", ")", "#", "%"):
                if pos == len(data):
                    self.pending = data[start:]
                    break
                output.append(data[start:pos + 1])
                pos += 1
            else:
                output.append(data[start:pos])
        if output:
            self.stream.feed("".join(output))

    def protocol_audit(self) -> dict[str, Any]:
        counts = self.protocol_counts + self.screen.protocol_counts
        return {"counts": dict(counts), "incomplete_trailing_escape": bool(self.pending),
                "unsupported": {key: value for key, value in counts.items()
                                if key.startswith(("unsupported_", "private_mode_"))}}


def load_cast(path: Path) -> tuple[dict[str, Any], list[list[Any]]]:
    with path.open(encoding="utf-8") as source:
        header = json.loads(source.readline())
        if header.get("version") != 2:
            raise ValueError("Input must be an asciinema version 2 recording")
        events = [json.loads(line) for line in source if line.strip()]
    if not isinstance(header.get("width"), int) or not isinstance(header.get("height"), int):
        raise ValueError("Recording must declare integer terminal dimensions")
    previous = -1.0
    for event in events:
        if len(event) != 3 or not isinstance(event[0], (float, int)):
            raise ValueError("Each capture event must be [seconds, type, text]")
        if event[0] < previous:
            raise ValueError("Capture event timestamps must be ordered")
        previous = event[0]
        if event[1] not in ("o", "i", "r", "m"):
            raise ValueError(f"Unsupported asciinema event type: {event[1]}")
    return header, events


def load_captions(path: Path) -> list[dict[str, Any]]:
    captions = json.loads(path.read_text(encoding="utf-8"))
    previous = 0.0
    for item in captions:
        if not isinstance(item.get("text"), str):
            raise ValueError("Every caption needs a text string")
        if item["start"] < previous or item["end"] <= item["start"]:
            raise ValueError("Captions must be nonoverlapping and ordered, with end > start")
        previous = item["end"]
    return captions


def color(value: str, background: bool = False) -> str:
    if value == "default":
        return TERM_BG if background else PALETTE["default"]
    if re.fullmatch("[0-9a-fA-F]{6}", value):
        return "#" + value
    return PALETTE.get(value, PALETTE["default"])


def wrap_text(text: str, font: ImageFont.FreeTypeFont, max_width: int) -> list[str]:
    lines: list[str] = []
    for paragraph in text.split("\n"):
        words = paragraph.split()
        if not words:
            lines.append("")
            continue
        line = ""
        for word in words:
            candidate = line + (" " if line else "") + word
            if font.getlength(candidate) <= max_width:
                line = candidate
                continue
            if line:
                lines.append(line)
                line = ""
            # Split exceptional long words, rather than clipping the caption.
            for letter in word:
                if line and font.getlength(line + letter) > max_width:
                    lines.append(line)
                    line = ""
                line += letter
        lines.append(line)
    return lines


class FrameRenderer:
    def __init__(self, width: int, height: int, columns: int, rows: int,
                 caption_height: int, title: str, mono_path: str):
        self.width, self.height = width, height
        self.columns, self.rows = columns, rows
        self.caption_height = caption_height
        self.title = title
        self.title_height = 72
        self.margin = 20
        available_width = width - 2 * self.margin
        available_height = height - self.title_height - caption_height - 2 * self.margin
        self.font_size = 30
        while self.font_size >= 10:
            font = ImageFont.truetype(mono_path, self.font_size, index=0)
            ascent, descent = font.getmetrics()
            cell_width = font.getlength("M")
            cell_height = ascent + descent + 1
            if cell_width * columns <= available_width and cell_height * rows <= available_height:
                break
            self.font_size -= 1
        if self.font_size < 10:
            raise ValueError("Terminal is too large for the requested output dimensions")
        self.fonts = {key: ImageFont.truetype(mono_path, self.font_size, index=index)
                      for key, index in [((False, False), 0), ((True, False), 1),
                                         ((False, True), 2), ((True, True), 3)]}
        self.cell_width = cell_width
        self.cell_height = cell_height
        self.primary_ascent = font.getmetrics()[0]
        self.glyph_sources: list[dict[str, Any]] = []
        self.glyph_cache: dict[str, dict[str, Any] | None] = {}
        self.missing_glyph_codepoints: set[int] = set()
        self.fallback_glyphs: dict[str, str] = {}
        for path, is_emoji in [(mono_path, False),
                               ("/Users/bsonntag/Library/Fonts/CascadiaMonoNF.ttf", False),
                               ("/Users/bsonntag/Library/Fonts/GohuFontuni14NerdFontMono-Regular.ttf", False),
                               ("/System/Library/Fonts/Apple Symbols.ttf", False),
                               ("/System/Library/Fonts/Apple Color Emoji.ttc", True)]:
            if not Path(path).exists():
                continue
            table = TTFont(path, fontNumber=0, lazy=True)
            cmap = set(table.getBestCmap())
            table.close()
            self.glyph_sources.append({"path": path, "cmap": cmap, "emoji": is_emoji,
                                       "font": ImageFont.truetype(path, 32 if is_emoji else self.font_size)})
        self.term_width = math.ceil(cell_width * columns)
        self.term_height = math.ceil(cell_height * rows)
        self.x_origin = (width - self.term_width) // 2
        self.y_origin = self.title_height + (available_height + 2 * self.margin - self.term_height) // 2
        self.ui_font = ImageFont.truetype("/System/Library/Fonts/Supplemental/Arial.ttf", 25)
        self.caption_font = ImageFont.truetype("/System/Library/Fonts/Supplemental/Arial.ttf", 34)
        self.caption_label_font = ImageFont.truetype("/System/Library/Fonts/Supplemental/Arial Bold.ttf", 23)
        self.caption_cache: dict[str, tuple[ImageFont.FreeTypeFont, list[str]]] = {}

    def glyph_source(self, text: str) -> dict[str, Any] | None:
        if text in self.glyph_cache:
            return self.glyph_cache[text]
        codepoints = {ord(char) for char in text if ord(char) not in (0xfe0e, 0xfe0f, 0x200d)}
        selected = next((source for source in self.glyph_sources if codepoints <= source["cmap"]), None)
        self.glyph_cache[text] = selected
        if selected is None:
            self.missing_glyph_codepoints.update(codepoints)
        elif selected != self.glyph_sources[0]:
            self.fallback_glyphs[" ".join(f"U+{value:04X}" for value in sorted(codepoints))] = selected["path"]
        return selected

    def draw_glyph(self, image: Image.Image, draw: ImageDraw.ImageDraw,
                   left: int, top: int, text: str, cell: Any, foreground: str) -> None:
        source = self.glyph_source(text)
        if source is None or source == self.glyph_sources[0]:
            draw.text((left, top), text, font=self.fonts[(cell.bold, cell.italics)],
                      fill=foreground, anchor="la")
        elif source["emoji"]:
            emoji = Image.new("RGBA", (64, 64), (0, 0, 0, 0))
            ImageDraw.Draw(emoji).text((0, 0), text, font=source["font"], embedded_color=True, anchor="lt")
            box = emoji.getbbox()
            if box:
                emoji = emoji.crop(box)
                emoji.thumbnail((self.font_size, self.font_size), Image.Resampling.LANCZOS)
                width = max(1, wcswidth(text)) * self.cell_width
                image.paste(emoji, (round(left + (width - emoji.width) / 2),
                                   round(top + (self.cell_height - emoji.height) / 2)), emoji)
        else:
            offset = self.primary_ascent - source["font"].getmetrics()[0]
            draw.text((left, top + offset), text, font=source["font"], fill=foreground, anchor="la")

    def draw_frame(self, screen: ReplayScreen, seconds: float, caption: str) -> Image.Image:
        if screen.columns != self.columns or screen.lines != self.rows:
            raise ValueError("Terminal dimensions changed through a mode sequence; capture fixed dimensions")
        image = Image.new("RGB", (self.width, self.height), PAGE_BG)
        draw = ImageDraw.Draw(image)
        draw.text((26, 25), self.title, font=self.ui_font, fill=CAPTION_FG, anchor="lt")
        stamp = f"{int(seconds // 60):02}:{int(seconds % 60):02}  |  actual PTY recording"
        draw.text((self.width - 26, 25), stamp, font=self.ui_font, fill=MUTED, anchor="rt")
        x0, y0 = self.x_origin, self.y_origin
        draw.rectangle((x0 - 13, y0 - 13, x0 + self.term_width + 13,
                        y0 + self.term_height + 13), fill=TERM_BG)
        for row in range(screen.lines):
            line = screen.buffer.get(row, {})
            for col in range(screen.columns):
                cell = line.get(col, screen.default_char)
                foreground, background = color(cell.fg), color(cell.bg, True)
                if cell.reverse:
                    foreground, background = background, foreground
                left = round(x0 + col * self.cell_width)
                top = round(y0 + row * self.cell_height)
                right = round(x0 + (col + 1) * self.cell_width)
                if background != TERM_BG:
                    draw.rectangle((left, top, right, top + self.cell_height), fill=background)
        # Backgrounds precede text so the continuation cell of a wide glyph cannot erase it.
        for row in range(screen.lines):
            line = screen.buffer.get(row, {})
            for col in range(screen.columns):
                cell = line.get(col, screen.default_char)
                foreground, background = color(cell.fg), color(cell.bg, True)
                if cell.reverse:
                    foreground, background = background, foreground
                left = round(x0 + col * self.cell_width)
                top = round(y0 + row * self.cell_height)
                right = round(x0 + (col + 1) * self.cell_width)
                if cell.data and cell.data != " ":
                    self.draw_glyph(image, draw, left, top, cell.data, cell, foreground)
                if cell.underscore:
                    draw.line((left, top + self.cell_height - 3, right,
                               top + self.cell_height - 3), fill=foreground)
                if cell.strikethrough:
                    draw.line((left, top + self.cell_height // 2, right,
                               top + self.cell_height // 2), fill=foreground)
        # Cursor position and visibility come from the capture; the renderer uses a static outline.
        if not screen.cursor.hidden:
            left = round(x0 + min(screen.cursor.x, screen.columns - 1) * self.cell_width)
            top = round(y0 + min(screen.cursor.y, screen.lines - 1) * self.cell_height)
            draw.rectangle((left, top, left + round(self.cell_width) - 1,
                            top + self.cell_height - 1), outline=ACCENT, width=1)
        caption_top = self.height - self.caption_height
        draw.rectangle((0, caption_top, self.width, self.height), fill=CAPTION_BG)
        draw.rectangle((0, caption_top, 8, self.height), fill=ACCENT)
        draw.text((35, caption_top + 20), "WHAT IS HAPPENING", font=self.caption_label_font,
                  fill=ACCENT, anchor="lt")
        if caption:
            if caption not in self.caption_cache:
                size = 34
                while size >= 20:
                    font = ImageFont.truetype("/System/Library/Fonts/Supplemental/Arial.ttf", size)
                    lines = wrap_text(caption, font, self.width - 70)
                    line_height = sum(font.getmetrics()) + 8
                    if line_height * len(lines) <= self.caption_height - 77:
                        break
                    size -= 1
                if size < 20:
                    raise ValueError("Caption does not fit its panel; shorten it or increase --caption-height")
                self.caption_cache[caption] = (font, lines)
            font, lines = self.caption_cache[caption]
            line_height = sum(font.getmetrics()) + 8
            for index, line in enumerate(lines):
                draw.text((35, caption_top + 61 + index * line_height), line,
                          font=font, fill=CAPTION_FG, anchor="lt")
        return image


def active_caption(captions: list[dict[str, Any]], time: float) -> str:
    for item in captions:
        if item["start"] <= time < item["end"]:
            return item["text"]
    if captions and time >= captions[-1]["end"]:
        return captions[-1]["text"]
    return ""


def timestamp(seconds: float, comma: bool = False) -> str:
    milliseconds = round(seconds * 1000)
    hours, remainder = divmod(milliseconds, 3600000)
    minutes, remainder = divmod(remainder, 60000)
    seconds, milliseconds = divmod(remainder, 1000)
    return f"{hours:02}:{minutes:02}:{seconds:02}{',' if comma else '.'}{milliseconds:03}"


def write_player(output: Path, video_name: str, captions: list[dict[str, Any]], title: str,
                 poster: str = "") -> None:
    caption_json = json.dumps(captions, ensure_ascii=False).replace("<", "\\u003c")
    page = """<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>__TITLE__</title><style>
:root{color-scheme:dark}*{box-sizing:border-box}body{margin:0;background:#0a0e16;color:#f3f6fb;font:17px/1.5 system-ui,sans-serif}
main{max-width:1240px;margin:28px auto;padding:0 22px}h1{font-size:27px;margin:0 0 8px}p{color:#a0aec3;margin:8px 0 18px}
video{display:block;width:100%;background:#111723;border:1px solid #33425a;border-radius:12px 12px 0 0;max-height:78vh}
.caption-panel{background:#18243a;padding:18px 22px 20px;border:1px solid #33425a;border-top:0;border-radius:0 0 12px 12px}
label{display:block;color:#90c7ff;font-size:13px;font-weight:700;letter-spacing:.08em;margin-bottom:8px}
textarea{display:block;width:100%;min-height:100px;resize:vertical;border:0;border-radius:5px;padding:10px 12px;background:#111d31;color:#f3f6fb;font:20px/1.5 system-ui,sans-serif}
.timeline{color:#a0aec3;font-variant-numeric:tabular-nums;font-size:14px;margin-top:9px}a{color:#90c7ff}nav{display:flex;gap:22px;flex-wrap:wrap;margin:18px 0}details{margin-top:20px;color:#a0aec3}li{margin:7px 0}
</style></head><body><main><h1>__TITLE__</h1>
<p>Actual Pi terminal recording. The captions describe the recorded actions and observed results.</p>
<video id="recording" controls preload="metadata" playsinline poster="__POSTER_URL__"><source src="__VIDEO_URL__" type="video/mp4">
<track kind="captions" src="captions.vtt" srclang="en" label="English action captions">Your browser cannot play the MP4.</video>
<section class="caption-panel"><label for="caption">WHAT IS HAPPENING — SYNCHRONIZED CAPTION</label>
<textarea id="caption" readonly aria-live="polite" spellcheck="false"></textarea><div class="timeline" id="position">00:00</div></section>
<nav><a href="__VIDEO_URL__" download>Download video</a><a href="captions.txt">Read all captions</a><a href="recording.cast">Original PTY capture</a><a href="render-validation.json">Recording provenance</a></nav>
<details><summary>Playback and fidelity</summary><ul>
<li>The upper screen replays real ANSI terminal output. The lower panel contains editorial captions.</li>
<li>Original capture timing is retained. The recording has no added audio.</li>
<li>The cursor is drawn as a static outline. Font rasterization and color palette may differ from your native terminal.</li>
<li>Protocol audit and source hashes are recorded in the provenance file.</li>
</ul></details></main><script>
const captions=__CAPTIONS__;
const video=document.getElementById('recording'),area=document.getElementById('caption'),position=document.getElementById('position');
let previous='';function update(){const t=video.currentTime;const last=captions[captions.length-1];const item=captions.find(c=>t>=c.start&&t<c.end)||(last&&t>=last.end?last:null);const text=item?item.text:'';if(text!==previous){area.value=text;previous=text;}position.textContent=`${String(Math.floor(t/60)).padStart(2,'0')}:${String(Math.floor(t%60)).padStart(2,'0')} / ${Number.isFinite(video.duration)?`${String(Math.floor(video.duration/60)).padStart(2,'0')}:${String(Math.floor(video.duration%60)).padStart(2,'0')}`:'…'}`;}
['timeupdate','seeking','seeked','loadedmetadata','play','pause','ended'].forEach(event=>video.addEventListener(event,update));update();
</script></body></html>"""
    page = page.replace("__TITLE__", html.escape(title)).replace("__VIDEO_URL__", quote(video_name))
    page = page.replace("__POSTER_URL__", quote(poster))
    page = page.replace("__CAPTIONS__", caption_json)
    (output / "index.html").write_text(page, encoding="utf-8")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cast", type=Path, required=True)
    parser.add_argument("--captions", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--title", default="Pi + sf-pi · Jev context in practice")
    parser.add_argument("--video-name", default="jev-context-pi-demo.mp4")
    parser.add_argument("--width", type=int, default=1920)
    parser.add_argument("--height", type=int, default=1440)
    parser.add_argument("--caption-height", type=int, default=230)
    parser.add_argument("--fps", type=int, default=12)
    parser.add_argument("--hold-final", type=float, default=2.0)
    parser.add_argument("--ffmpeg", default="/opt/homebrew/bin/ffmpeg")
    parser.add_argument("--font", default="/System/Library/Fonts/Menlo.ttc")
    parser.add_argument("--still-at", type=float, action="append", default=[])
    args = parser.parse_args()
    if args.width % 2 or args.height % 2:
        parser.error("H.264 dimensions must be even")
    if args.fps < 1 or args.hold_final < 0:
        parser.error("Frame rate must be positive; final hold cannot be negative")
    if Path(args.video_name).name != args.video_name or not args.video_name.endswith(".mp4"):
        parser.error("--video-name must be an MP4 basename")
    header, events = load_cast(args.cast)
    captions = load_captions(args.captions)
    if any(event[1] == "r" for event in events):
        parser.error("This renderer requires constant terminal dimensions; record without resizing")
    if not events or not any(event[1] == "o" for event in events):
        parser.error("Capture contains no terminal output")
    source_end = max(float(event[0]) for event in events)
    caption_end = max((float(item["end"]) for item in captions), default=0.0)
    duration = max(source_end + args.hold_final, caption_end)
    # Include a sample at/after the final event even when --hold-final is zero.
    frame_count = math.ceil(duration * args.fps) + 1
    output = args.output_dir.resolve()
    output.mkdir(parents=True, exist_ok=True)
    still_dir = output / "stills"
    still_dir.mkdir(exist_ok=True)
    terminal = TerminalReplay(header["width"], header["height"])
    renderer = FrameRenderer(args.width, args.height, header["width"], header["height"],
                             args.caption_height, args.title, args.font)
    video = output / args.video_name
    log_path = output / "ffmpeg-render.log"
    command = [args.ffmpeg, "-hide_banner", "-loglevel", "warning", "-y", "-f", "rawvideo",
               "-pix_fmt", "rgb24", "-s", f"{args.width}x{args.height}", "-r", str(args.fps),
               "-i", "pipe:0", "-an", "-c:v", "libx264", "-preset", "veryfast", "-crf", "18",
               "-pix_fmt", "yuv420p", "-movflags", "+faststart", str(video)]
    requested_stills = sorted(set([0.0, source_end] + args.still_at +
                                 [float(item["start"]) for item in captions]))
    saved_stills: list[dict[str, Any]] = []
    next_still = 0
    next_event = 0
    last_key = None
    last_frame_bytes = None
    output_event_count = 0
    output_text_bytes = 0
    last_report = -1
    with log_path.open("wb") as log:
        process = subprocess.Popen(command, stdin=subprocess.PIPE, stderr=log)
        try:
            for frame_index in range(frame_count):
                seconds = frame_index / args.fps
                changed = False
                while next_event < len(events) and events[next_event][0] <= seconds + 1e-9:
                    _, event_type, text = events[next_event]
                    if event_type == "o":
                        terminal.feed(text)
                        changed = True
                        output_event_count += 1
                        output_text_bytes += len(text.encode("utf-8"))
                    next_event += 1
                caption = active_caption(captions, seconds)
                key = (caption, int(seconds))
                if changed or key != last_key:
                    image = renderer.draw_frame(terminal.screen, seconds, caption)
                    last_frame_bytes = image.tobytes()
                    last_key = key
                assert last_frame_bytes is not None
                assert process.stdin is not None
                process.stdin.write(last_frame_bytes)
                while next_still < len(requested_stills) and requested_stills[next_still] <= seconds + 1e-9:
                    name = f"frame-{seconds:08.3f}.png"
                    image.save(still_dir / name)
                    saved_stills.append({"requested_seconds": requested_stills[next_still],
                                         "actual_seconds": seconds, "file": f"stills/{name}"})
                    next_still += 1
                progress = int(seconds // 15)
                if progress != last_report:
                    print(f"Rendering {seconds:.1f}s / {duration:.1f}s", flush=True)
                    last_report = progress
            process.stdin.close()
            return_code = process.wait()
        except BaseException:
            if process.stdin is not None:
                process.stdin.close()
            process.terminate()
            process.wait()
            raise
    if return_code:
        raise RuntimeError(f"ffmpeg failed ({return_code}); see {log_path}")
    # Copy only capture/caption inputs explicitly supplied for this recording.
    for source, target in [(args.cast, output / "recording.cast"),
                           (args.captions, output / "captions.json")]:
        if source.resolve() != target.resolve():
            shutil.copyfile(source, target)
    vtt = "WEBVTT\n\n" + "\n\n".join(
        f"{timestamp(item['start'])} --> {timestamp(item['end'])}\n{item['text']}" for item in captions)
    srt = "\n\n".join(f"{index}\n{timestamp(item['start'], True)} --> {timestamp(item['end'], True)}\n{item['text']}"
                         for index, item in enumerate(captions, 1)) + "\n"
    (output / "captions.vtt").write_text(vtt, encoding="utf-8")
    (output / "captions.srt").write_text(srt, encoding="utf-8")
    (output / "captions.txt").write_text("\n\n".join(
        f"{timestamp(item['start'])}–{timestamp(item['end'])}\n{item['text']}" for item in captions) + "\n", encoding="utf-8")
    poster_frame = min(saved_stills, key=lambda item: abs(item["actual_seconds"] - 25))
    write_player(output, args.video_name, captions, args.title, poster_frame["file"])
    final_screen = "\n".join(terminal.screen.display)
    (output / "final-screen.txt").write_text(final_screen + "\n", encoding="utf-8")
    probe = subprocess.run([str(Path(args.ffmpeg).with_name("ffprobe")), "-v", "error",
                            "-show_entries", "format=duration,size:stream=codec_name,width,height,avg_frame_rate,nb_frames",
                            "-of", "json", str(video)], check=True, capture_output=True, text=True)
    audit = terminal.protocol_audit()
    validation = {
        "source": {"cast_sha256": sha256(args.cast), "captions_sha256": sha256(args.captions),
                   "header": {key: header.get(key) for key in ("version", "width", "height", "timestamp")},
                   "events": len(events), "output_events": output_event_count,
                   "terminal_output_utf8_bytes": output_text_bytes, "source_end_seconds": source_end},
        "render": {"video": args.video_name, "sha256": sha256(video), "frame_count": frame_count,
                   "fps": args.fps, "duration_seconds": frame_count / args.fps,
                   "initial_trim_seconds": 0, "final_trim_seconds": 0,
                   "added_final_hold_seconds": args.hold_final,
                   "caption_count": len(captions), "terminal_font": args.font,
                   "terminal_font_size": renderer.font_size, "caption_panel_height": args.caption_height,
                   "fallback_glyph_fonts": renderer.fallback_glyphs,
                   "missing_glyph_codepoints": [f"U+{codepoint:04X}" for codepoint in sorted(renderer.missing_glyph_codepoints)],
                   "terminal_bounds": {"x": renderer.x_origin, "y": renderer.y_origin,
                                       "width": renderer.term_width, "height": renderer.term_height},
                   "dimensions": [args.width, args.height], "probe": json.loads(probe.stdout)},
        "player": {"poster": poster_frame, "caption_display": "Synchronized read-only textarea below video",
                   "end_behavior": "Last caption remains in burned caption panel and read-only textarea through final quantized frame and after playback ends"},
        "fidelity": {"terminal_pixels": "ANSI output events replayed by pyte; no invented terminal content",
                     "caption_pixels": "Editorial captions supplied separately",
                     "timing": "Original monotonic output timings, sampled at the stated frame rate",
                     "cursor": "Captured cursor position/visibility; static outline rather than terminal-specific blink/shape",
                     "limitations": ["Font rasterization and configured palette differ from native terminal",
                                     "Font fallbacks and emoji scaling can differ from native terminal rendering; sixel/kitty inline images are not supported",
                                     "OSC hyperlinks, title changes, bells, mouse modes, and keyboard protocol negotiations have no pixel effect",
                                     "Asciinema resize events require a separate recording with fixed terminal dimensions"],
                     "protocol_audit": audit},
        "dependencies": {name: importlib.metadata.version(name) for name in ("pyte", "Pillow", "wcwidth", "fonttools")},
        "stills": saved_stills,
        "checks": {"all_output_events_replayed": output_event_count == sum(event[1] == "o" for event in events),
                   "terminal_in_bounds": (renderer.x_origin >= 0 and renderer.y_origin >= 0 and
                                          renderer.y_origin + renderer.term_height < args.height - args.caption_height),
                   "unsupported_terminal_protocols_present": bool(audit["unsupported"]),
                   "all_rendered_glyphs_available": not renderer.missing_glyph_codepoints,
                   "no_timing_trim": True,
                   "caption_panel_distinct_from_terminal": True},
    }
    (output / "render-validation.json").write_text(json.dumps(validation, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(json.dumps({"video": str(video), "player": str(output / "index.html"),
                      "duration_seconds": frame_count / args.fps, "protocol_audit": audit,
                      "validation": str(output / "render-validation.json")}, indent=2), flush=True)


if __name__ == "__main__":
    main()
