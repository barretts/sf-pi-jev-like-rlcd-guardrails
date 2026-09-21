#!/usr/bin/env python3
"""Focused renderer protocol checks; synthetic inputs are NOT the Pi demo."""
import json
from pathlib import Path

from render_video import TerminalReplay, active_caption, load_captions


def main():
    checks = {}
    screen = TerminalReplay(30, 6)
    screen.feed("first\r\nsecond\x1b[1;1H\x1b[31mRED\x1b[0m")
    checks["cursor_overwrite"] = screen.screen.display[0].startswith("REDst")
    checks["ansi_color"] = screen.screen.buffer[0][0].fg == "red"
    main_lines = screen.screen.display.copy()
    screen.feed("\x1b[?1049hALTERNATE\r\nsecondary")
    checks["alternate_screen_clean"] = screen.screen.display[0].startswith("ALTERNATE") and "REDst" not in "\n".join(screen.screen.display)
    screen.feed("\x1b[?1049l")
    checks["alternate_screen_restores"] = screen.screen.display == main_lines
    screen.feed("\x1b[3;1Hbefore\x1b[38;2;12;34;56mCOLOR\x1b[0m\x1b[?25l")
    checks["truecolor"] = screen.screen.buffer[2][6].fg == "0c2238"
    checks["cursor_visibility"] = screen.screen.cursor.hidden
    screen.feed("\x1b]8;;https://example.invalid\x1b\\LINK\x1b]8;;\x1b\\")
    checks["hyperlink_content_only"] = "LINK" in "\n".join(screen.screen.display) and "example.invalid" not in "\n".join(screen.screen.display)
    screen.feed("\x1bPhidden-protocol-payload\x1b\\SAFE")
    checks["unsupported_strings_hidden"] = "hidden-protocol" not in "\n".join(screen.screen.display) and "SAFE" in "\n".join(screen.screen.display)
    screen.feed("\x1b[4;")
    screen.feed("1Hchunked")
    checks["escape_chunk_boundaries"] = screen.screen.display[3].startswith("chunked")
    screen.feed("\x1b[5;1H\x1b[38:2::10:20:30mcolon\x1b[0m")
    checks["colon_truecolor"] = screen.screen.buffer[4][0].fg == "0a141e"
    captions = [{"start": 0, "end": 2, "text": "one"}, {"start": 2, "end": 4, "text": "two"}]
    checks["caption_boundaries"] = active_caption(captions, 0) == "one" and active_caption(captions, 2) == "two"
    checks["final_caption_remains_visible"] = active_caption(captions, 4) == "two" and active_caption(captions, 100) == "two"
    output = {"fixture_type": "synthetic renderer validation, not a Pi session", "checks": checks,
              "passed": all(checks.values()), "protocol_audit": screen.protocol_audit()}
    path = Path(__file__).with_name("renderer-selftest.json")
    path.write_text(json.dumps(output, indent=2) + "\n")
    print(json.dumps(output, indent=2))
    if not output["passed"]:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
