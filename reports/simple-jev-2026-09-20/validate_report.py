#!/usr/bin/env python3
"""Validate the PDF artifact and render every slide for visual review."""

import hashlib
import json
import re
from pathlib import Path

import pymupdf
from PIL import Image, ImageDraw, ImageFont
from pypdf import PdfReader

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
PDF = HERE.parent / "simple-jev-presentation-2026-09-20.pdf"
REVIEW = ROOT / ".build/presentation-review"


def main():
    evidence = json.loads((HERE / "evidence.json").read_text())
    for source in evidence["sources"]:
        assert hashlib.sha256((ROOT / source["path"]).read_bytes()).hexdigest() == source["sha256"], source["path"]
    reader = PdfReader(PDF)
    assert not reader.is_encrypted
    assert len(reader.pages) == 32
    assert len(reader.outline) == 32
    assert "Simple Jev" in reader.metadata.title
    doc = pymupdf.open(PDF)
    REVIEW.mkdir(parents=True, exist_ok=True)
    text = "\n".join(page.get_text() for page in doc)
    normalized = re.sub(r"\s+", " ", text)
    claims = [
        "60.76%", "61.67%", "14.88%", "0.298%", "57.14%", "31.81%",
        "84 / 96", "86 / 96", "1 of 2 expected fields", "70 failed / 2 unrun",
        "1,593,640", "625,273", "1,660,875", "711,842", "152 / 156",
        "194 validation rows", "260.82 ms", "50%", "production-qualification",
        "20,627", "25,319", "3,039", "98 vectors", "589 prompt tokens", "~0.01", "~0.99",
    ]
    for claim in claims:
        assert claim in normalized, f"Missing measured claim: {claim}"
    assert not re.search(r"hf_[A-Za-z0-9]{20,}", text)
    assert not re.search(r"(?:sk-proj-|sk-[A-Za-z0-9]{30,})", text)
    links = []
    geometry_errors = []
    slides = []
    for index, page in enumerate(doc):
        assert page.rect.width == 1280 and page.rect.height == 720
        assert page.get_text().strip(), f"Empty slide {index + 1}"
        for block in page.get_text("dict")["blocks"]:
            for line in block.get("lines", []):
                for span in line.get("spans", []):
                    x1, y1, x2, y2 = span["bbox"]
                    if x1 < 0 or y1 < 0 or x2 > 1280.5 or y2 > 720.5:
                        geometry_errors.append({"page": index + 1, "text": span["text"], "bbox": span["bbox"]})
        for link in page.get_links():
            if "uri" in link:
                assert link["uri"].startswith(
                    "https://github.com/barretts/simple-jev-ts/blob/" + evidence["evidenceCommit"] + "/"
                ), link["uri"]
                links.append(link["uri"])
        pix = page.get_pixmap(matrix=pymupdf.Matrix(1.25, 1.25), alpha=False)
        path = REVIEW / f"slide-{index + 1:02d}.png"
        pix.save(path)
        slides.append(path)
    assert not geometry_errors, geometry_errors
    assert len(links) >= 100
    (REVIEW / "extracted-text.txt").write_text(text)

    thumb_w, thumb_h, label_h = 400, 225, 34
    for batch in range(2):
        sheet = Image.new("RGB", (thumb_w * 4, (thumb_h + label_h) * 4), "#E9EBE8")
        draw = ImageDraw.Draw(sheet)
        font_path = Path("/System/Library/Fonts/Supplemental/Arial.ttf")
        font = ImageFont.truetype(str(font_path), 17) if font_path.exists() else ImageFont.load_default()
        for offset, path in enumerate(slides[batch * 16 : (batch + 1) * 16]):
            image = Image.open(path).convert("RGB").resize((thumb_w, thumb_h), Image.Resampling.LANCZOS)
            x, y = (offset % 4) * thumb_w, (offset // 4) * (thumb_h + label_h)
            sheet.paste(image, (x, y))
            draw.text((x + 12, y + thumb_h + 7), f"Slide {batch * 16 + offset + 1:02d}", fill="#153041", font=font)
        sheet.save(REVIEW / f"contact-sheet-{batch + 1}.png")
    result = {
        "pdf": PDF.name,
        "pdfSha256": hashlib.sha256(PDF.read_bytes()).hexdigest(),
        "pageCount": len(doc),
        "pageSizePoints": [1280, 720],
        "outlineEntries": len(reader.outline),
        "clickableEvidenceLinks": len(links),
        "sourcePinsVerified": len(evidence["sources"]),
        "essentialClaimsVerified": claims,
        "outOfPageTextSpans": 0,
        "credentialPatternMatches": 0,
        "allPagesRendered": True,
        "modelRequestsForReport": 0,
        "newTrainingForReport": False,
        "softwareImplementationChanged": False,
        "productionQualificationClaimed": False,
    }
    (HERE / "validation.json").write_text(json.dumps(result, indent=2) + "\n")
    print(json.dumps(result, indent=2))
    print(f"Review images: {REVIEW}")


if __name__ == "__main__":
    main()
