#!/usr/bin/env python3
"""Check final video decoding, provenance, caption binding, and an encoded still."""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess

from PIL import Image, ImageChops, ImageStat


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--source-captions", type=Path)
    parser.add_argument("--ffmpeg", default="/opt/homebrew/bin/ffmpeg")
    args = parser.parse_args()
    output = args.output_dir.resolve()
    metadata = json.loads((output / "render-validation.json").read_text())
    video = output / metadata["render"]["video"]
    captions = json.loads((output / "captions.json").read_text())
    page = (output / "index.html").read_text()
    embedded = json.loads(page.split("const captions=", 1)[1].split(";\nconst video=", 1)[0])
    decoded = subprocess.run([args.ffmpeg, "-v", "error", "-i", str(video), "-f", "null", "-"],
                             capture_output=True, text=True)
    still = min(metadata["stills"], key=lambda item: abs(item["actual_seconds"] - 25))
    decoded_still = output / "stills" / "decoded-video-0025.png"
    subprocess.run([args.ffmpeg, "-v", "error", "-y", "-ss", str(still["actual_seconds"]),
                    "-i", str(video), "-frames:v", "1", str(decoded_still)], check=True)
    final_still = output / "stills" / "decoded-video-final.png"
    subprocess.run([args.ffmpeg, "-v", "error", "-y", "-sseof", "-0.1",
                    "-i", str(video), "-frames:v", "1", str(final_still)], check=True)
    rendered = Image.open(output / still["file"]).convert("RGB")
    encoded = Image.open(decoded_still).convert("RGB")
    difference = ImageStat.Stat(ImageChops.difference(rendered, encoded))
    final_image = Image.open(final_still).convert("RGB")
    caption_top = final_image.height - metadata["render"]["caption_panel_height"]
    closing_caption = final_image.crop((20, caption_top + 60, final_image.width - 20, final_image.height - 10))
    final_caption_white_pixels = sum(all(channel >= 190 for channel in pixel)
                                     for pixel in closing_caption.getdata())
    checks = {
        "full_video_decodes_without_error": decoded.returncode == 0 and not decoded.stderr,
        "video_sha256_matches_provenance": digest(video) == metadata["render"]["sha256"],
        "cast_sha256_matches_provenance": digest(output / "recording.cast") == metadata["source"]["cast_sha256"],
        "captions_sha256_matches_provenance": digest(output / "captions.json") == metadata["source"]["captions_sha256"],
        "html_caption_data_matches_subtitle_input": embedded == captions,
        "html_caption_textarea_is_readonly": '<textarea id="caption" readonly' in page,
        "html_caption_logic_needs_no_fetch": "fetch(" not in page and "XMLHttpRequest" not in page,
        "html_poster_exists": (output / metadata["player"]["poster"]["file"]).is_file(),
        "decoded_still_dimensions_match_rendered": encoded.size == rendered.size,
        "final_encoded_frame_caption_panel_has_text": final_caption_white_pixels > 500,
        "all_output_events_replayed": metadata["checks"]["all_output_events_replayed"],
        "terminal_in_bounds": metadata["checks"]["terminal_in_bounds"],
        "all_rendered_glyphs_available": metadata["checks"]["all_rendered_glyphs_available"],
        "no_unsupported_terminal_protocols": not metadata["checks"]["unsupported_terminal_protocols_present"],
    }
    if args.source_captions:
        checks["latest_source_captions_included"] = digest(args.source_captions) == digest(output / "captions.json")
    result = {"checks": checks, "passed": all(checks.values()),
              "video_sha256": digest(video), "caption_sha256": digest(output / "captions.json"),
              "encoded_still": {"file": "stills/decoded-video-0025.png", "time_seconds": still["actual_seconds"],
                                "mean_absolute_rgb_difference_from_rendered": difference.mean},
              "final_encoded_still": {"file": "stills/decoded-video-final.png",
                                      "caption_text_white_pixels": final_caption_white_pixels},
              "limits": ["HTML checks inspect binding code; interactive playback is separately reviewed in the browser",
                         "Pixel differences quantify codec changes, not semantic answer quality"]}
    (output / "video-review.json").write_text(json.dumps(result, indent=2) + "\n")
    print(json.dumps(result, indent=2))
    if not result["passed"]:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
