#!/usr/bin/env python3
"""Editable, vector presentation built from the pinned Jev evidence snapshot."""

import hashlib
import html
import json
import re
from pathlib import Path

import reportlab
from reportlab.lib import colors
from reportlab.lib.styles import ParagraphStyle
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfgen import canvas
from reportlab.platypus import Paragraph

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
OUTPUT = HERE.parent / "simple-jev-presentation-2026-09-20.pdf"
E = json.loads((HERE / "evidence.json").read_text())
S = {source["id"]: source for source in E["sources"]}
M = E["metrics"]
W, H = 1280, 720

INK = colors.HexColor("#153041")
MUTED = colors.HexColor("#596B76")
PAPER = colors.HexColor("#F4F3EE")
WHITE = colors.HexColor("#FFFFFF")
DARK = colors.HexColor("#0B2635")
TEAL = colors.HexColor("#147D71")
MINT = colors.HexColor("#E0EEE7")
BLUE = colors.HexColor("#52758E")
PALE_BLUE = colors.HexColor("#E3ECF2")
ORANGE = colors.HexColor("#AE512C")
PALE_ORANGE = colors.HexColor("#F6E4D9")
LINE = colors.HexColor("#D7DDD9")


def register_fonts():
    system = Path("/System/Library/Fonts/Supplemental")
    fallback = Path(reportlab.__file__).parent / "fonts"
    names = [
        ("JevSans", system / "Arial.ttf", fallback / "Vera.ttf"),
        ("JevBold", system / "Arial Bold.ttf", fallback / "VeraBd.ttf"),
        ("JevItalic", system / "Arial Italic.ttf", fallback / "VeraIt.ttf"),
        ("JevBoldItalic", system / "Arial Bold Italic.ttf", fallback / "VeraBI.ttf"),
        ("JevMono", fallback / "VeraMono.ttf", fallback / "Vera.ttf"),
    ]
    for name, preferred, alternative in names:
        path = preferred if preferred.is_file() else alternative
        pdfmetrics.registerFont(TTFont(name, str(path)))
    pdfmetrics.registerFontFamily(
        "JevSans", normal="JevSans", bold="JevBold", italic="JevItalic", boldItalic="JevBoldItalic"
    )


register_fonts()
C = None
PAGE = None
PAGES = []
TOTAL = 0
LAYOUT = []


def pct(value, places=2):
    return f"{value * 100:.{places}f}%"


def plain(value):
    return html.unescape(re.sub(r"<[^>]+>", "", value)).replace("\n", " ")


def box(text, x, top, width, height, size=20, color=INK, bold=False, align=0, leading=None, note=True):
    """Draw top-aligned text and reject overflow rather than silently clipping it."""
    style = ParagraphStyle(
        "slide", fontName="JevBold" if bold else "JevSans", fontSize=size,
        leading=leading or size * 1.28, textColor=color, alignment=align,
        spaceBefore=0, spaceAfter=0, allowWidows=0, allowOrphans=0,
    )
    paragraph = Paragraph(text.replace("\n", "<br/>"), style)
    actual_w, actual_h = paragraph.wrap(width, height)
    if actual_h > height + 0.1:
        raise ValueError(f"Slide {PAGE['number']} overflow ({actual_h:.1f} > {height}): {plain(text)[:100]}")
    if x < 0 or top < 0 or x + width > W + 0.1 or top + actual_h > H + 0.1:
        raise ValueError(f"Slide {PAGE['number']} text is outside page: {plain(text)[:80]}")
    paragraph.drawOn(C, x, H - top - actual_h)
    LAYOUT.append({"page": PAGE["number"], "x": x, "top": top, "width": actual_w, "height": actual_h, "text": plain(text)})
    if note and text:
        PAGE["text"].append(plain(text))
    return actual_h


def rect(x, top, width, height, fill=WHITE, radius=12, stroke=None):
    C.setFillColor(fill)
    C.setStrokeColor(stroke or fill)
    C.roundRect(x, H - top - height, width, height, radius, stroke=bool(stroke), fill=1)


def rule(x1, top1, x2, top2, color=LINE, width=1):
    C.setStrokeColor(color)
    C.setLineWidth(width)
    C.line(x1, H - top1, x2, H - top2)


def arrow(x1, top1, x2, top2, color=BLUE, width=2):
    rule(x1, top1, x2, top2, color, width)
    C.setFillColor(color)
    path = C.beginPath()
    if top1 == top2:
        direction = 1 if x2 >= x1 else -1
        path.moveTo(x2, H - top2)
        path.lineTo(x2 - direction * 9, H - top2 + 5)
        path.lineTo(x2 - direction * 9, H - top2 - 5)
    else:
        direction = 1 if top2 >= top1 else -1
        path.moveTo(x2, H - top2)
        path.lineTo(x2 - 5, H - top2 + direction * 9)
        path.lineTo(x2 + 5, H - top2 + direction * 9)
    path.close()
    C.drawPath(path, fill=1, stroke=0)


def begin(title, section, sources, subtitle=None, dark=False):
    global PAGE
    PAGE = {"number": len(PAGES) + 1, "title": title, "section": section, "sources": sources, "text": [], "dark": dark}
    C.setFillColor(DARK if dark else PAPER)
    C.rect(0, 0, W, H, stroke=0, fill=1)
    name = f"slide-{PAGE['number']}"
    C.bookmarkPage(name)
    C.addOutlineEntry(title, name, level=0)
    if not dark:
        rect(64, 35, 7, 17, TEAL, radius=2)
        box(section.upper(), 84, 35, 1000, 22, 13, MUTED, bold=True)
        font_size = min(40, 40 * 1152 / max(1152, pdfmetrics.stringWidth(title, "JevBold", 40)))
        box(title, 64, 75, 1152, 57, font_size, INK, bold=True)
        if subtitle:
            box(subtitle, 64, 139, 1152, 49, 19, MUTED)


def finish():
    text_color = colors.HexColor("#B6C8CF") if PAGE["dark"] else MUTED
    rule(64, 658, 1216, 658, colors.HexColor("#365363") if PAGE["dark"] else LINE)
    x = 64
    for sid in PAGE["sources"]:
        source = S[sid]
        label = f"{sid} {source['title']}"
        width = pdfmetrics.stringWidth(label, "JevSans", 10.2) + 20
        if x + width > 1120:
            raise ValueError("Too many footer references")
        box(label, x, 674, width, 16, 10.2, text_color, note=False)
        C.linkURL(source["url"], (x, H - 690, x + width - 13, H - 672), relative=0, thickness=0)
        x += width
    box(f"{PAGE['number']:02d} / {TOTAL:02d}", 1140, 672, 76, 20, 12, text_color, bold=True, align=2, note=False)
    PAGES.append(PAGE)
    C.showPage()


def card(x, top, width, height, label, big, body, accent=TEAL, fill=WHITE, big_size=36):
    rect(x, top, width, height, fill)
    rect(x + 20, top + 22, 5, 23, accent, radius=2)
    box(label.upper(), x + 37, top + 25, width - 57, 40, 13.5, MUTED, bold=True)
    box(big, x + 24, top + 78, width - 48, 69, big_size, accent, bold=True)
    box(body, x + 24, top + 157, width - 48, height - 176, 18.5, INK)


def banner(top, text, fill=MINT, color=TEAL, height=68, size=21):
    rect(64, top, 1152, height, fill)
    box(text, 86, top + 16, 1108, height - 24, size, color, bold=True)


def item(x, top, width, label, text, accent=TEAL, detail_size=19):
    rect(x, top + 4, 6, 25, accent, radius=2)
    box(label, x + 23, top, width - 23, 38, 22, INK, bold=True)
    box(text, x + 23, top + 42, width - 23, 93, detail_size, MUTED)


def table(x, top, widths, headers, rows, row_h=60, font=18, header_h=43):
    total_w = sum(widths)
    rect(x, top, total_w, header_h, INK, radius=7)
    dx = x
    for width, label in zip(widths, headers):
        box(label, dx + 13, top + 11, width - 26, header_h - 14, 14, WHITE, bold=True)
        dx += width
    for index, row in enumerate(rows):
        y = top + header_h + index * row_h
        rect(x, y + 3, total_w, row_h - 4, WHITE if index % 2 == 0 else colors.HexColor("#EAEFEA"), radius=4)
        dx = x
        for j, (width, text) in enumerate(zip(widths, row)):
            box(str(text), dx + 13, y + 12, width - 26, row_h - 17, font, INK, bold=(j == 0))
            dx += width
    return top + header_h + len(rows) * row_h


def token_pair(x, top, width, label, raw, compressed, value_size=23, candidate_label="Excerpts"):
    box(label, x, top, width, 36, 21, INK, bold=True)
    label_w = 140
    number_w = 172
    chart_w = width - label_w - number_w - 24
    max_value = max(raw, compressed)
    for index, (name, value, fill) in enumerate([("Full context", raw, BLUE), (candidate_label, compressed, TEAL)]):
        y = top + 52 + index * 54
        box(name, x, y + 1, label_w, 31, 18, MUTED)
        rect(x + label_w, y, chart_w, 28, colors.HexColor("#E2E7E3"), radius=4)
        rect(x + label_w, y, chart_w * value / max_value, 28, fill, radius=4)
        box(f"{value:,}", x + width - number_w, y - 2, number_w, 36, value_size, fill, bold=True, align=2)


def code(text, x, top, width, height, size=17, fill=DARK):
    rect(x, top, width, height, fill)
    lines = text.splitlines()
    for index, line in enumerate(lines):
        if pdfmetrics.stringWidth(line, "JevMono", size) > width - 38:
            raise ValueError(f"Code line too wide: {line}")
        C.setFillColor(colors.HexColor("#E7F0EE"))
        C.setFont("JevMono", size)
        C.drawString(x + 19, H - top - 28 - index * size * 1.52, line)
    if 28 + (len(lines) - 1) * size * 1.52 > height - 10:
        raise ValueError("Code box too short")
    PAGE["text"].append(text)


def s01_cover():
    qa = M["effectiveness"]
    begin("Simple Jev: from TypeScript rewrite to context reduction", "Project presentation", ["S02", "S15"], dark=True)
    box("SIMPLE JEV  /  PI + SF-PI", 64, 46, 1050, 30, 15, colors.HexColor("#B6C8CF"), bold=True)
    box("From TypeScript rewrite\nto useful context reduction", 64, 129, 792, 170, 54, WHITE, bold=True, leading=62)
    box("The implementation, model experiments, compactions,\ncaveman summaries and exact-excerpt results.", 68, 334, 720, 96, 25, colors.HexColor("#C6D7DC"))
    box("20 SEPTEMBER 2026  •  PRIVATE PROJECT REPORT", 68, 507, 740, 34, 14, colors.HexColor("#B6C8CF"), bold=True)
    box("Exact excerpts exceeded the reduction target.\nQuality and speed on real developer tasks still need validation.", 68, 563, 730, 61, 20, colors.HexColor("#D0DFDB"))
    rect(897, 126, 319, 482, colors.HexColor("#143A48"), radius=18)
    box(pct(qa["promptReductionFraction"], 1), 926, 168, 262, 87, 63, colors.HexColor("#9ED6BB"), bold=True)
    box("fewer input tokens", 929, 265, 260, 42, 24, WHITE)
    rule(929, 331, 1183, 331, colors.HexColor("#42606B"))
    box("192", 929, 361, 260, 72, 47, WHITE, bold=True)
    box("recorded Pi/sf-pi workflows", 929, 431, 252, 72, 21, colors.HexColor("#C6D7DC"))
    box("Latest bounded evaluation", 929, 549, 252, 31, 15, colors.HexColor("#9ED6BB"), bold=True)
    finish()


def s02_outcomes():
    begin("A working foundation and a measured compression win", "Where we stand", ["S01", "S02", "S15"], "The engineering path works. The strongest measured result is reduced context work on frozen synthetic tasks.")
    card(64, 204, 368, 321, "Delivered", "TypeScript + Pi", "Classifier library, Pi tools, sf-pi Manager seam, HTTP/browser surfaces and a real training/export workflow.", big_size=33)
    card(456, 204, 368, 321, "Measured", "60.76%", "Fewer prompt tokens in the latest 192-workflow evaluation. Accepted workflows: 86/96 with excerpts, 84/96 with full context.")
    card(848, 204, 368, 321, "Open proof", "1 regression", "A multiline count/position answer regressed. Paced task-request time increased 18.67%; production effectiveness remains unqualified.", accent=ORANGE, big_size=32)
    banner(551, "The current deliverable is an opt-in context feature, backed by retained positive and negative evidence.", size=21)
    finish()


def s03_journey():
    begin("The project moved from integration to measured outcomes", "Journey • 19–20 September", ["S02", "S03", "S05", "S15"], "Milestones below follow the actual work sequence; model and harness evidence remain separate.")
    milestones = [
        ("01", "Independent TypeScript rewrite", "Recreate the classifier contracts and fit the Pi extension model."),
        ("02", "Local model selection + RFDT", "Compare Gemma prompts and sizes; train, export and reject failed students."),
        ("03", "Developer and routing controls", "Measure complete decision work; reuse prior-thread dispatch lessons."),
        ("04", "Fixed-Grok context compaction", "Hold the task model fixed; repair lifecycle and rate-capacity handling."),
        ("05", "First exact-excerpt success", "Exceed the 50% reduction target on three long trace fixtures."),
        ("06", "Caveman comparison + selection", "Evaluate summary overhead; retain exact excerpts as the selected solution."),
        ("07", "Answer-effectiveness evaluation", "Record all 192 workflows, including the one paired answer regression."),
    ]
    for index, (number, label, text) in enumerate(milestones):
        x = 64 if index < 4 else 656
        y = 202 + (index if index < 4 else index - 4) * 106
        rect(x, y + 1, 42, 42, TEAL if index in [4, 6] else PALE_BLUE, radius=8)
        box(number, x + 5, y + 9, 32, 26, 18, WHITE if index in [4, 6] else BLUE, bold=True, align=1)
        box(label, x + 58, y, 492, 35, 22, INK, bold=True)
        box(text, x + 58, y + 39, 492, 62, 17.5, MUTED)
    finish()


def s04_goal():
    begin("The acceptance target became concrete", "Goal and scope", ["S01", "S03", "S15"], "The original aim was better developer work in Pi/sf-pi. The user later prioritized 50% reduction before judging effectiveness.")
    item(64, 211, 534, "Platform and model constraints", "TypeScript for Pi/sf-pi. Google Gemma locally; user-selected Grok for controls. Qwen and Chinese-lineage models excluded.")
    item(656, 211, 560, "Original developer-improvement bar", "Correct outcomes plus faster accepted work or less complete generative work. Standalone classifier speed could not prove that.")
    item(64, 405, 534, "Immediate compression target", "At least 50% fewer whole-workflow prompt tokens, including extra task, recovery and summary requests.")
    item(656, 405, 560, "Subsequent effectiveness check", "Strict frozen answers, full scheduled denominators, original preservation, wire delivery and lifecycle cleanup.")
    finish()


def s05_architecture():
    begin("The rewrite fits the normal Pi tool loop", "TypeScript implementation", ["S01", "S02"], "The classifier uses local llama.cpp selected-token logits and returns typed results with zero generated classifier tokens.")
    steps = [("Pi prompt", "User request"), ("Validate", "Typed arguments"), ("Dispatch", "jev_classify"), ("Gemma", "Local inference"), ("Return", "Tool result"), ("Continue", "Next assistant turn")]
    for index, (label, detail) in enumerate(steps):
        x = 64 + index * 196
        rect(x, 236, 174, 113, WHITE)
        box(label, x + 15, 257, 144, 35, 24, TEAL if index == 3 else INK, bold=True, align=1)
        box(detail, x + 13, 302, 148, 36, 15.5, MUTED, align=1)
        if index < 5:
            arrow(x + 176, 292, x + 194, 292)
    arrow(652, 350, 652, 390, TEAL)
    rect(456, 395, 392, 110, MINT)
    box("Choice • truth • evidence score", 478, 416, 348, 33, 22, TEAL, bold=True, align=1)
    box("Same library contracts across surfaces", 478, 458, 348, 30, 17.5, MUTED, align=1)
    for x, title, description in [(64, "TypeScript library", "Typed requests and results"), (456, "Pi extension + Manager", "Commands, lifecycle and session status"), (848, "HTTP + browser", "Optional local API and inspection")]:
        rect(x, 542, 368, 82, WHITE)
        box(title, x + 19, 556, 330, 34, 21, INK, bold=True)
        box(description, x + 19, 592, 330, 28, 15.5, MUTED)
    finish()


def s06_rewrite():
    begin("Independent rewrite, explicit compatibility boundaries", "Rewrite method and contracts", ["S01", "S02"], "Documentation and source inspection were permitted. This was not a source-separated legal clean-room process.")
    table(64, 212, [255, 495, 402], ["Contract", "Resulting behavior", "Evidence boundary"], [
        ["Choice", "Select the strongest permitted candidate label.", "Confidence is uncalibrated."],
        ["Evidence score", "Expected zero-based rubric index.", "An estimate, with exact provenance."],
        ["Noul / truth", "Map nine rating bins into [0.01, 0.99].", "Unknown handling is tested separately."],
        ["v1 compatibility", "72 whole-Plan and 432 answer/usage comparisons.", "Exact on the captured comparison set."],
    ], row_h=68, font=18)
    banner(559, "Original Python checkout preserved. First-party TypeScript is Apache 2.0; model terms remain separate.", size=20)
    finish()


def s07_pi():
    begin("Integration progressed to real autonomous tool use", "Pi and sf-pi proof", ["S02", "S03"], "The initial harness proved dispatch. A separate real-provider run later proved automatic selection for controlled prompts.")
    card(64, 211, 552, 325, "Initial integration", "1 tool / 2 turns", "All 23 sf-pi extensions loaded alongside Jev. Pi validated arguments, dispatched real Gemma inference and consumed all three result types. The harness authored the tool call.", big_size=33)
    card(640, 211, 576, 325, "Separate autonomous lane", "Gemma 4 selected Jev", "The local Gemma 4 agent chose one jev_classify call from 33 tools. The Gemma 3 1B classifier used 683 input tokens and generated zero output tokens.", big_size=31)
    banner(560, "The warm classification workflow took 154.27 seconds. Two controlled prompts establish functionality; broad speed and selection quality remain open.", fill=PALE_ORANGE, color=ORANGE, height=77, size=19)
    finish()


def s08_models():
    begin("First model selection exposed quality limits", "Gemma classifier selection", ["S02", "S23"], "An explicit refund request initially scored ~0.01 under v1. v2 repaired that sample (~0.99), while the frozen 60-record validation gates still failed.")
    table(64, 212, [312, 210, 220, 210, 200], ["Candidate", "Choice accuracy", "Clear truth", "Score MAE", "Regressions"], [
        ["Gemma 3 1B • v1", "50.0%", "50.0%", "0.25437", "2 / 6"],
        ["Gemma 3 1B • v2 C2", "80.0%", "50.0%", "0.20082", "4 / 6"],
        ["Gemma 3 4B • v2 C7", "85.0%", "100.0%", "0.07971", "6 / 6"],
    ], row_h=68, font=20)
    box("Formal gates: choice ≥90%, clear truth ≥95%, Brier ≤0.10, normalized score MAE ≤0.10, all regressions and zero execution errors.", 64, 478, 1152, 60, 20, MUTED)
    banner(557, "The 4B candidate missed choice by one answer: 17/20 versus 18/20 required. Its unknown-truth MAE was also poor (~0.490).", fill=PALE_ORANGE, color=ORANGE, height=76, size=20)
    finish()


def s09_training():
    begin("RFDT became a real training-to-native workflow", "Training and acceptance", ["S01", "S02"], "Training execution, reload equivalence, exported artifact identity and answer quality were checked independently.")
    phases = ["Pinned Gemma base", "Validated TRAIN labels", "Adapter optimization", "Reload + fuse + GGUF", "Native validation/test"]
    for index, label in enumerate(phases):
        x = 64 + index * 235
        rect(x, 216, 213, 84, WHITE)
        box(label, x + 14, 235, 185, 57, 19, INK, bold=True, align=1)
        if index < 4:
            arrow(x + 216, 258, x + 233, 258)
    item(64, 353, 544, "Initial 64-step student", "TRAIN loss fell 4.23194 → 0.11660; fresh reload delta was zero. Native validation passed, including 19/20 choice and 16/16 clear truth.")
    item(656, 353, 560, "Held-out test rejected promotion", "Score MAE was 0.113934 against a 0.10 maximum. The candidate stayed unapproved; the official base remained the default.", accent=ORANGE)
    banner(561, "The teacher path also gained strict typed validation and cache checks after a real invalid-target failure. Supplied labels remain distinct from teacher estimates.", size=19, height=76)
    finish()


def s10_training_rounds():
    begin("More 1B training fit did not yield reliable developer truth", "Expanded developer corpus", ["S03", "S05"], "A cancelled 64.3 GiB physical-footprint attempt led to MLX cache clearing. Fresh R2 recorded a 5.05 GiB MLX peak; these are separate memory measures.")
    table(64, 206, [323, 202, 207, 200, 220], ["Gemma 3 1B round", "Developer choice", "Clear truth", "Score MAE", "Diagnosis"], [
        ["R2 • 570 rows / 64 steps", "4 / 26", "12 / 20", "0.28322", "Not run"],
        ["R5 • 570 rows / 512 steps", "24 / 26", "12 / 20", "0.12008", "16 / 56"],
        ["R6 • 730 rows / 512 steps", "23 / 26", "10 / 20", "0.18656", "44 / 56"],
        ["R7 • 970 rows / 512 steps", "22 / 26", "8 / 20", "0.15389", "48 / 56"],
    ], row_h=65, font=18)
    banner(543, "R7 TRAIN loss fell 6.70021 → 0.08457, and all 194 validation rows executed. Every suite still failed its unchanged quality gates.", fill=PALE_ORANGE, color=ORANGE, height=88, size=21)
    finish()


def s11_large_model():
    begin("A larger Gemma control improved judgments", "Separate model research", ["S03", "S04"], "The Gemma 4 successor passed the 194-record validation stage and completed a matched 312-attempt direct/generated comparison.")
    table(64, 211, [440, 350, 362], ["Matched developer comparison", "Direct selected labels", "Generated RFDT targets"], [
        ["Correct judgments", "152 / 156  •  97.44%", "146 / 156  •  93.59%"],
        ["Correct individual scores", "48 / 52  •  92.31%", "42 / 52  •  80.77%"],
        ["Elapsed per correct judgment", "6.103 seconds", "7.948 seconds"],
        ["Generated output tokens", "0", "2,348"],
    ], row_h=63, font=20)
    box("The observed elapsed-per-correct advantage was ~1.30×. The predeclared 2× timing requirement failed in both repetitions; natural Pi task improvement remains unproven.", 64, 535, 1152, 64, 20, MUTED)
    box("The successor report was reconstructed from a complete retained audit after a serializer failure; inference was not replayed. The logical and physical changes were not isolated.", 64, 607, 1152, 39, 15, MUTED)
    finish()


def s12_prior_router():
    begin("The prior thread supplied useful routing lessons", "Reuse and performance boundaries", ["S04", "S05"], "The two projects had different tasks and timing scopes. No matched experiment ranks one project ahead of the other overall.")
    item(64, 207, 536, "Reusable findings", "Cache frozen features for fitting. Keep safety checks on every fast branch. Use adversarial missing-fact, quoted-instruction and label-order regressions.")
    item(656, 207, 560, "Current-request dispatch", "Pi captures its model before before_agent_start. A provider dispatcher is implemented to choose the executing target inside the current stream.")
    rect(64, 408, 552, 215, WHITE)
    box("Prior specialized router", 88, 429, 504, 34, 23, INK, bold=True)
    box("HTTP p95 9.22 ms; actual Pi routing p95 79.53 ms. Routed answers: 45/48; always-strong controls: 24/24. Its practical improvement gate failed.", 88, 475, 504, 100, 20, MUTED)
    box("MiniLM was not qualified for this project's allowlist.", 88, 587, 504, 29, 15, MUTED)
    rect(640, 408, 576, 215, PALE_ORANGE)
    box("Our frozen-Gemma head diagnostic", 664, 429, 528, 34, 23, ORANGE, bold=True)
    box("35/40 strong-required requests routed fast in each pass. Warm operational p95: 260.82 ms versus a 100 ms target. The head remains unapproved.", 664, 475, 528, 110, 21, ORANGE)
    finish()


def s13_surfaces():
    begin("The rewrite also built the developer-facing surfaces", "Product and hardening work", ["S01", "S02", "S03", "S12"], "Source/distribution checks and controlled live checks establish different layers of evidence.")
    item(64, 211, 536, "Pi and sf-pi Manager", "External contribution seam, scoped preferences, lazy startup, explicit warmup, and opt-in advisory routing and answer-evaluation hooks.")
    item(656, 211, 560, "HTTP and browser inspection", "Real local classification, structured errors, exact response rendering and read-only RFDT inspection that displays failed gates.")
    item(64, 407, 536, "Runtime recovery and concurrency", "One active plus 16 pending requests; shared warmup, cancellation, deadlines, explicit native recovery and awaited process cleanup.")
    item(656, 407, 560, "Pinned artifacts and packaging", "Reviewed lineage, role, size and SHA-256; no weights in the package. Excerpt checkpoint 2860d17 passed 969 Vitest and 241 Node protocol checks.")
    banner(570, "Tool-schema optimization saved 589 prompt tokens (2.85%) across the full 33-tool catalog; validator parity passed 98 vectors. Complete-task gains remain unproven.", height=75, size=19)
    finish()


def s14_fixed_model():
    begin("Fixed Grok separated harness changes from model changes", "Context-compression pivot", ["S03", "S05", "S15"], "The user chose llmgw Grok 4.6 for task controls and context judgments; local model training remained a separate lane.")
    rect(64, 215, 270, 184, WHITE)
    box("Same frozen task", 88, 242, 222, 38, 26, INK, bold=True)
    box("Same tool trace\nSame expected answer\nSame task model", 88, 299, 222, 86, 21, MUTED)
    arrow(337, 263, 399, 263)
    arrow(337, 354, 399, 354)
    rect(408, 216, 350, 76, PALE_BLUE)
    box("Full-context request", 431, 239, 304, 34, 24, BLUE, bold=True, align=1)
    rect(408, 323, 350, 76, MINT)
    box("Projected request", 431, 346, 304, 34, 24, TEAL, bold=True, align=1)
    arrow(760, 263, 816, 263)
    arrow(760, 354, 816, 354)
    rect(827, 215, 389, 184, WHITE)
    box("Grok 4.6 in both arms", 851, 242, 341, 39, 26, INK, bold=True)
    box("Provider usage and every physical request counted, including recovery and summaries.", 851, 304, 341, 85, 20, MUTED)
    item(64, 465, 536, "Host-only literal gold", "Deterministic strict scoring supplies the acceptance decision; the task model never receives expected answers.")
    item(656, 465, 560, "Supplementary judge", "Separate Grok preservation/support judgments add evidence. They cannot override failed answers or missing execution.")
    finish()


def s15_pilot():
    begin("The first lossless pilot showed savings and extra work", "Context pilot • outside the later Pi hook", ["S03", "S06"], "Six fixed synthetic extraction tasks used repeated-line encoding; Grok 4.6 ran both task arms and preservation judgments.")
    card(64, 211, 368, 304, "Correctness", "6 / 6 each", "All literal task answers and all six preservation judges passed. Independent round trips reconstructed exact originals.", big_size=35)
    card(456, 211, 368, 304, "Prompt tokens", "59.90% less", "13,858 → 5,557 prompt tokens. Generated output increased from 3,376 to 6,195 tokens.", big_size=32)
    card(848, 211, 368, 304, "Task time", "57.01% more", "20.864 → 32.760 seconds. The compressed representation required more generated work despite less prompt context.", accent=ORANGE, big_size=31)
    banner(543, "Observed prompt caching prevented a billing claim. Earlier temperature-rejected and length-limited judge runs remain retained failures.", fill=PALE_ORANGE, color=ORANGE, height=83, size=20)
    finish()


def s16_harness():
    begin("Pi/sf-pi testing exposed harness and capacity failures", "Integration lessons", ["S03", "S05"], "These failures were preserved, diagnosed and followed by separately recorded runs.")
    table(64, 211, [330, 437, 385], ["Observed problem", "What changed", "Subsequent evidence"], [
        ["Gateway compatibility", "Omit store:false; use explicit in-memory SDK compatibility settings.", "Real streaming/tool requests reached Grok."],
        ["169 / 192 HTTP 429 failures", "Shared pacing, cooldown and circuit breaker; no hidden retries.", "Later bounded SF campaigns had zero HTTP 429."],
        ["SF extension lifecycle errors", "Emit bounded session_shutdown before disposal.", "SF smoke 4 passed 4/4 workflows and its judge."],
    ], row_h=100, font=19)
    box("That passing SF smoke reduced prompt tokens only 12.59% and took 1.75× baseline elapsed time. Functional recovery did not qualify the 50% reduction target.", 64, 583, 1152, 60, 20, MUTED)
    finish()


def s17_repetition():
    r = M["repetition"]
    begin("The full repetition campaign fell far short of 50%", "Full SF comparison • 192 scheduled workflows", ["S05", "S07", "S08"], "The reversible codec compressed eligible repeated lines, but the complete workflow showed almost no prompt reduction.")
    token_pair(64, 211, 755, "Whole-workflow prompt tokens", r["raw"]["promptTokens"], r["compressed"]["promptTokens"], candidate_label="Codec")
    rect(864, 214, 352, 196, PALE_ORANGE)
    box(pct(r["promptReductionFraction"], 3), 888, 245, 304, 69, 45, ORANGE, bold=True)
    box("reduction versus 50% target", 888, 326, 304, 62, 21, ORANGE)
    table(64, 420, [360, 280, 280, 232], ["Recorded outcome", "Full context", "Repetition codec", "Change"], [
        ["Accepted workflows", "88 / 96", "89 / 96", "1 output-limit error"],
        ["Total tokens", "565,960", "583,259", "+3.06%"],
        ["Summed workflow time", "3,821.50 s", "4,050.17 s", "+5.98%"],
    ], row_h=49, font=17.5)
    delta = r["requestOrdinalPromptDeltas"]
    box(f"First requests added {delta['0']:,} prompt tokens; after-read requests saved {-delta['1']:,}; one extra request added {delta['2']:,}. Net saving: 1,653 tokens. Output also grew 2.69×.", 64, 615, 1152, 41, 15.5, MUTED)
    finish()


def s18_approaches():
    begin("Three compression approaches had different tradeoffs", "From repeated lines to selected evidence", ["S01", "S09", "S14", "S21"], "The key design choice was how much evidence to send immediately, and how to preserve access to everything else.")
    card(64, 209, 368, 348, "Repetition codec", "Encode repeats", "Keep every distinct line and order in a reversible representation. Helps highly repetitive output; adds decoding instructions and cannot remove unique irrelevant content.", accent=BLUE, big_size=31)
    card(456, 209, 368, 348, "Caveman summary", "Rewrite briefly", "A host-injected model writes a terse summary. Summary requests and incomplete responses add work; excerpt fallback remains possible.", accent=ORANGE, big_size=31)
    card(848, 209, 368, 348, "Exact excerpts", "Select verbatim", "Deterministic task terms select original passages. Omission markers expose missing spans; scoped recovery can read retained originals. No summary-model call.", big_size=31)
    banner(583, "Verbatim excerpts preserve wording; omitted spans can contain facts needed for a correct answer.", size=21, height=59)
    finish()


def s19_caveman():
    v = M["caveman"]
    begin("Caveman summaries did not reach the reduction target", "Optional summary comparison", ["S13", "S14", "S05"], "This later comparison reused the three frozen long cases and source, with its own full-context arm and all summary requests counted.")
    card(64, 211, 368, 306, "Whole-workflow prompt reduction", pct(v["promptReductionFraction"]), "141,186 → 120,175 prompt tokens. Task-only savings were 17.17%, also below target; summary work belongs in the total.", accent=ORANGE)
    card(456, 211, 368, 306, "Summary execution", "3 / 8 complete", "Five requests were recorded as incomplete. Summary usage: 3,226 input and 7,680 output tokens. Fallback could occur.", accent=ORANGE, big_size=31)
    card(848, 211, 368, 306, "Workflow elapsed", "2.31× baseline", "All 12 workflows completed, but elapsed increased. Total tokens fell only 7.03%; answer quality was deliberately not graded.", accent=ORANGE, big_size=29)
    banner(546, "The CLI exited 1 for the missed 50% reduction objective. Exact excerpts remained the selected ordinary strategy.", fill=PALE_ORANGE, color=ORANGE, height=79, size=21)
    finish()


def s20_excerpts():
    begin("Exact excerpts change the request view and retain originals", "Selected solution", ["S01", "S09", "S21", "S22"], "Lexical task terms and named symbols rank three-line windows; merged ranges retain source order and literal text.")
    code("Task: Why did build alpha fail?\n\n001 build alpha started\n002 compiler: missing symbol Render\n003 build alpha failed\n... 300 unrelated telemetry lines ...", 64, 210, 552, 237, size=18)
    arrow(619, 321, 650, 321, TEAL)
    code("reference: <host-issued handle>\n[lines 1-3]\nbuild alpha started\ncompiler: missing symbol Render\nbuild alpha failed\n[omitted lines 4-303]", 664, 210, 552, 237, size=18)
    box("Illustrative invented example; no captured provider text.", 64, 459, 1152, 27, 15, MUTED)
    item(64, 503, 536, "Canonical history stays exact", "Only eligible completed text tool results are projected. Roles, IDs, images and errors are preserved; guards restore literal text when required.", detail_size=18)
    item(656, 503, 560, "Original recovery is explicit", "jev_context_read pages exact text by scoped reference: 100 lines by default, 200 maximum, and 16 KiB of original text per page.", detail_size=18)
    finish()


def s21_first_win():
    v = M["excerptSmoke"]
    begin("The first exact-excerpt run exceeded 50% reduction", "First bounded compression success", ["S10", "S11", "S12"], "Actual Pi/Grok execution, all 23 controlled SF factories, three invented 20–40 KiB traces and two counterbalanced repetitions.")
    token_pair(64, 214, 784, "Whole-workflow prompt tokens", v["rawPromptTokens"], v["compressedPromptTokens"])
    rect(890, 217, 326, 190, MINT)
    box(pct(v["promptReductionFraction"]), 914, 247, 278, 71, 48, TEAL, bold=True)
    box("Target met on long outputs", 914, 329, 278, 61, 22, TEAL)
    table(64, 435, [323, 258, 273, 298], ["Coverage", "Physical requests", "Extra work", "Measured tradeoff"], [
        ["12 / 12 completed", "12 raw / 14 excerpt", "0 summary calls", "40.45% more elapsed"],
        ["Exact originals + wire", "All usage known", "Recovery included", "59.16% fewer total tokens"],
    ], row_h=63, font=18)
    box("This success proved the requested reduction on its frozen workload. Answer effectiveness was deferred, and generated output increased 3.03×. Billing was not measured.", 64, 610, 1152, 45, 17.5, MUTED)
    finish()


def s22_quality_protocol():
    begin("The next evaluation tested answers across a full schedule", "Exact-excerpt answer effectiveness", ["S15", "S20", "S24", "S25"], "The task model, source, gold and scoring contract were frozen; no training or case changes followed inference results.")
    rect(64, 214, 1152, 105, WHITE)
    factors = [("24", "native short cases"), ("+ 24", "scoped long variants"), ("× 2", "counterbalanced repeats"), ("× 2", "full / excerpt arms"), ("= 192", "recorded workflows")]
    for index, (number, label) in enumerate(factors):
        x = 82 + index * 231
        box(number, x, 228, 213, 56, 36, TEAL, bold=True, align=1)
        box(label, x, 286, 213, 27, 16, MUTED, align=1)
    item(64, 369, 536, "Fourteen authored task families", "Counts, last writes, failures, arithmetic, diffs, timestamps, quoted instructions, exact multiline bodies, Unicode and lookup lookalikes.")
    item(656, 369, 560, "Acceptance required all checks", "Strict JSON keys, types and values plus exact canonical originals, provider-wire delivery and affirmative lifecycle cleanup.")
    banner(554, "The 48 cases are synthetic. Long variants use deterministic unrelated padding; repeated variants are correlated observations, not new independent scenarios.", fill=PALE_BLUE, color=BLUE, height=80, size=20)
    finish()


def s23_quality_result():
    q = M["effectiveness"]
    begin("Observed answer acceptance was mostly retained", "Complete bounded quality result", ["S15", "S17", "S18"], "Wrong completed answers and execution failures remain in the scheduled denominators; the result is not a production qualification.")
    table(64, 211, [500, 325, 327], ["Outcome", "Full context", "Exact excerpts"], [
        ["Accepted workflows", "84 / 96  •  87.50%", "86 / 96  •  89.58%"],
        ["Wrong completed answers", "9", "8"],
        ["Execution errors", "3", "2"],
        ["Native short accepted / compression applied", "41 / 48  •  none", "41 / 48  •  0"],
        ["Scoped long accepted / compression applied", "43 / 48  •  none", "45 / 48  •  48"],
    ], row_h=59, font=19)
    banner(573, "96 pairs: 83 both accepted • 3 favor excerpts • 1 favors full context • 9 neither accepted.", height=62, size=21)
    finish()


def s24_regression():
    begin("One exact-answer regression remains real evidence", "Discordant workflows", ["S15", "S19"], "Recoverable originals do not guarantee that the assistant retrieves and uses every necessary fact.")
    rect(64, 212, 552, 342, PALE_ORANGE)
    box("Multiline count / position", 88, 235, 504, 38, 27, ORANGE, bold=True)
    box("quality-v3-22-long__r1", 88, 282, 504, 33, 19, ORANGE, bold=True)
    box("Full context answered correctly. The excerpt workflow returned valid JSON matching only 1 of 2 expected fields, despite a recovery turn. Its second repetition passed.", 88, 333, 504, 130, 23, ORANGE)
    box("The wrong field and an omission-only cause are unknown; final model text was deliberately not retained.", 88, 472, 504, 52, 16.5, ORANGE)
    rect(640, 212, 576, 342, WHITE)
    box("Three excerpt-favored workflow pairs", 664, 235, 528, 75, 25, TEAL, bold=True)
    item(664, 326, 504, "Two completed-answer improvements", "Long Unicode/spacing: both full-context answers failed JSON parsing; excerpt answers passed strict scoring.", detail_size=18)
    item(664, 444, 504, "One execution improvement", "A correct excerpt answer was paired with a full-context execution error; only one side completed.", detail_size=18)
    banner(565, "Next candidate fix: verify global counts and exact positions against originals before accepting an answer, then evaluate on a fresh frozen suite.", size=20, height=78)
    finish()


def s25_resource():
    q = M["effectiveness"]
    raw, comp = q["raw"], q["compressed"]
    begin("The larger quality campaign repeated the compression win", "All physical task requests included", ["S15", "S16", "S17"], "Usage includes failed calls and recovery. Supplementary judge requests are reported separately; excerpts make zero summary-model calls.")
    token_pair(64, 215, 810, "Prompt tokens", raw["promptTokens"], comp["promptTokens"])
    token_pair(64, 416, 810, "Total task tokens", raw["totalTokens"], comp["totalTokens"])
    rect(920, 214, 296, 392, MINT)
    box(pct(q["promptReductionFraction"]), 943, 238, 250, 61, 39, TEAL, bold=True)
    box("fewer prompt tokens", 943, 307, 250, 35, 20, TEAL)
    rule(943, 360, 1193, 360, colors.HexColor("#B5CDBE"))
    box("57.14%", 943, 384, 250, 60, 37, TEAL, bold=True)
    box("fewer total task tokens", 943, 448, 250, 55, 20, TEAL)
    box("Output: +28.76%\nRequests: 193 → 206\nPaced task time: +18.67%", 943, 516, 250, 78, 17.5, MUTED)
    box("Paced request-time sums include shared spacing and failures, exclude judges, and do not establish production latency or billing savings.", 64, 615, 1152, 41, 16, MUTED)
    finish()


def s26_judge():
    begin("Judgments were incomplete; preserved evidence stayed explicit", "Evidence quality and execution limits", ["S15", "S16", "S18"], "Strict host scoring supplies the answer result. The supplementary Grok judge did not validate the whole campaign.")
    table(64, 211, [568, 584], ["Supplementary judgments", "Recorded outcome"], [
        ["Scheduled judgments", "96"],
        ["Valid / supporting", "24 / 24 valid judgments"],
        ["Failed / unrun", "70 failed / 2 unrun"],
        ["Disagreements in valid subset", "0; failed cases remain unknown"],
    ], row_h=54, font=20)
    item(64, 501, 536, "Originals, wire and cleanup", "All 187 completed workflows verified canonical text and wire delivery. Original proof: 190/192 total; all 192 session cleanups affirmative.", detail_size=18)
    item(656, 501, 560, "Whole-campaign status", "Five execution errors; zero HTTP 429. The CLI exited 1, and the successful-execution and production-qualification gates remained false.", accent=ORANGE, detail_size=18)
    finish()


def s27_dx():
    begin("The current developer value is more room for useful context", "Practical developer experience", ["S01", "S15"], "The measured benefit applies to large completed tool outputs; natural coding-task completion remains unproven.")
    item(64, 210, 536, "Potential useful workflow", "Long build logs, inspection output or large read results can use fewer prompt tokens while preserving exact selected passages and accessible originals.")
    item(656, 210, 560, "Observed applicability boundary", "Every scoped-long excerpt workflow compressed. Native short controls stayed literal and showed zero compression; protected content limits possible savings.")
    code("In Pi:\n/jev-context excerpts\n/jev-context status\n\nTurn off:\n/jev-context off", 64, 411, 552, 218, size=20)
    rect(640, 411, 576, 218, WHITE)
    box("Opt-in and session-scoped", 664, 434, 528, 37, 26, TEAL, bold=True)
    box("Disabled by default. The ordinary extension uses excerpts when enabled. Status token numbers are estimates; provider usage supplies measured savings.", 664, 490, 528, 96, 21, MUTED)
    box("Enable the mode, then start a subsequent task turn.", 664, 599, 528, 28, 16.5, MUTED)
    finish()


def s28_next():
    begin("The next work should close the remaining correctness gap", "Proposed next steps", ["S03", "S15", "S19"], "These are proposed follow-ups. They are not implemented or qualified by the report.")
    steps = [
        ("1", "Verify exact global facts", "Add deterministic checks or required-original recovery for counts, positions, event multiplicity and final-write questions."),
        ("2", "Run fresh natural developer tasks", "Freeze a separate paired suite of real coding/read workflows, with strict success checks and all failures retained."),
        ("3", "Reduce complete request time", "Measure recovery frequency, output growth, pacing-free latency and cache behavior while holding task model and correctness fixed."),
        ("4", "Repair supplementary judgments", "Capture bounded failure classifications and obtain complete support checks without changing the host gold or hiding failed judgments."),
    ]
    for index, (number, title, description) in enumerate(steps):
        y = 207 + index * 109
        rect(64, y + 3, 51, 51, TEAL if index == 0 else PALE_BLUE, radius=10)
        box(number, 73, y + 12, 33, 33, 24, WHITE if index == 0 else BLUE, bold=True, align=1)
        box(title, 142, y, 1074, 36, 24, INK, bold=True)
        box(description, 142, y + 44, 1074, 57, 19, MUTED)
    finish()


def s29_ledger():
    rep, ex, cav, qa = [M[key] for key in ["repetition", "excerptSmoke", "caveman", "effectiveness"]]
    begin("Recorded comparisons preserve both wins and setbacks", "Measurement ledger", ["S06", "S07", "S11", "S14", "S15"], "Rows use different frozen workloads and protocols; they are milestones, not an apples-to-apples model or strategy ranking.")
    table(64, 214, [320, 157, 200, 211, 264], ["Experiment", "Scope", "Prompt change", "Total-token change", "Elapsed / quality"], [
        ["Repeated-line pilot", "6 tasks / arm", "−59.90%", f"−{pct(1 - (5557 + 6195) / (13858 + 3376))}", "+57.01%; 6/6 each"],
        ["Full SF repetition codec", "96 flows / arm", "−0.298%", "+3.06%", "+5.98%; 88/96 → 89/96"],
        ["First exact-excerpt smoke", "6 flows / arm", "−61.67%", "−59.16%", "+40.45%; quality deferred"],
        ["Later caveman comparison", "6 flows / arm", "−14.88%", "−7.03%", "+130.54%; quality deferred"],
        ["Exact-excerpt effectiveness", "96 flows / arm", "−60.76%", "−57.14%", "+18.67%; 84/96 → 86/96"],
    ], row_h=66, font=17.5)
    box("Elapsed definitions vary: pilot task time; earlier campaigns summed workflow time; latest quality campaign summed physical task-request time including pacing, excluding judges. Billing is unmeasured.", 64, 603, 1152, 49, 16.5, MUTED)
    finish()


def s30_sources():
    begin("The report links directly to the preserved evidence", "Evidence index • private repository", ["S02", "S15", "S18"], "Implementation/evidence snapshot: b5d796c. Actual experiments retain their separately pinned execution sources and protocols.")
    groups = [
        (64, ["S01", "S02", "S03", "S04", "S05", "S06"]),
        (656, ["S07", "S09", "S11", "S14", "S15", "S18"]),
    ]
    for x, ids in groups:
        for index, sid in enumerate(ids):
            source = S[sid]
            y = 205 + index * 66
            box(f"{sid}  {source['title']}", x, y, 544, 32, 21, TEAL, bold=True)
            display = source["path"].replace("research/", "", 1)
            box(html.escape(display), x, y + 33, 544, 27, 12.5, MUTED)
            C.linkURL(source["url"], (x, H - y - 59, x + 544, H - y), relative=0, thickness=0)
    box("Every slide has clickable evidence references. The editable source includes all 26 source paths and full SHA-256 pins in evidence.json.", 64, 613, 1152, 34, 18, MUTED)
    finish()


def s31_models_appendix():
    begin("Model identities and roles were explicit", "Appendix • model policy", ["S01", "S02", "S04", "S23"], "Google Gemma, user-selected xAI Grok, and user-attested OpenAI are the permitted lineages for this project.")
    table(64, 211, [415, 399, 338], ["Identity", "Role in the work", "Qualification boundary"], [
        ["google/gemma-3-1b-it", "Default local classifier; RFDT base; decoder feature experiments.", "Base quality and router safety failed."],
        ["google/gemma-3-4b-it", "Reviewed larger first-pass classifier candidate.", "C7 validation missed choice gate."],
        ["google/gemma-4-31B-it-qat-q4_0", "Local autonomous agent/teacher and direct-label research.", "Validation improved; timing gate failed."],
        ["llmgw/grok-4.6", "Fixed task model and supplementary context judge.", "Context control, not a trained student."],
        ["llmgw/gpt-5.6-sol", "User's configured default; catalog/lineage inspected.", "OpenAI mapping user-attested; no matched inference here."],
    ], row_h=72, font=17.5)
    box("Qwen and Chinese-lineage models were excluded. Local files have pinned sizes, revisions and SHA-256; this report contains no credentials or weights.", 64, 615, 1152, 41, 15.5, MUTED)
    finish()


def s32_method_appendix():
    begin("How to read the results and their practical limits", "Appendix • methods and interpretation", ["S15", "S18", "S20", "S24"], "A completed evaluation can contain failures. An observed token reduction is a narrower claim than production improvement.")
    item(64, 209, 536, "Full denominator and complete physical work", "All 192 scheduled workflows were recorded. The 399 task requests include failed calls and recovery; 94 supplementary judge requests are separate.", detail_size=18.5)
    item(656, 209, 560, "Synthetic and correlated evidence", "Twenty-four source-blind originals became 24 scoped long variants. Two repetitions of those shared cases cannot establish population noninferiority.", detail_size=18.5)
    item(64, 415, 536, "Independent audit scope", "Pins, scalar records and scorer provenance were audited. The CPU gold checker was added after inference began; earlier pre-freeze checks were author-attested. Final text was not retained for rescoring.", detail_size=18)
    item(656, 415, 560, "Cost, speed and installed behavior", "Cache accounting is incomplete; dollars saved are unknown. Controlled sf-pi setup and paced timings do not establish natural installed task latency.", detail_size=18.5)
    box("The report keeps the rewrite method, rejected students, answer regression and incomplete judge evidence explicit.", 64, 613, 1152, 37, 18, MUTED)
    finish()


SLIDES = [
    s01_cover, s02_outcomes, s03_journey, s04_goal, s05_architecture, s06_rewrite,
    s07_pi, s08_models, s09_training, s10_training_rounds, s11_large_model,
    s12_prior_router, s13_surfaces, s14_fixed_model, s15_pilot, s16_harness,
    s17_repetition, s18_approaches, s19_caveman, s20_excerpts, s21_first_win,
    s22_quality_protocol, s23_quality_result, s24_regression, s25_resource,
    s26_judge, s27_dx, s28_next, s29_ledger, s30_sources, s31_models_appendix,
    s32_method_appendix,
]


def main():
    global C, TOTAL
    for source in E["sources"]:
        actual = hashlib.sha256((ROOT / source["path"]).read_bytes()).hexdigest()
        if actual != source["sha256"]:
            raise ValueError(f"Pinned source changed: {source['path']}")
    TOTAL = len(SLIDES)
    C = canvas.Canvas(str(OUTPUT), pagesize=(W, H), pageCompression=1, invariant=1)
    C.setTitle("Simple Jev — From TypeScript Rewrite to Context Reduction")
    C.setAuthor("Simple Jev project")
    C.setSubject("Presentation of preserved implementation and controlled Pi/sf-pi experiment evidence, 20 September 2026")
    C.setKeywords("Simple Jev, TypeScript, Pi, sf-pi, Gemma, RFDT, context compression, exact excerpts")
    for slide in SLIDES:
        slide()
    C.save()
    assert len(PAGES) == TOTAL == 32
    notes = ["# Simple Jev presentation — slide text", "", f"Evidence snapshot: `{E['evidenceCommit']}`.", "", "This is a searchable companion to the PDF. Edit `build_report.py` to change the presentation and rebuild this file.", ""]
    for page in PAGES:
        notes += [f"## {page['number']:02d}. {page['title']}", "", f"*{page['section']}*", ""]
        for text in page["text"]:
            notes += [text, ""]
        links = [f"[{sid} — {S[sid]['title']}]({S[sid]['url']})" for sid in page["sources"]]
        notes += ["Sources: " + "; ".join(links) + ".", ""]
    (HERE / "slide-notes.md").write_text("\n".join(notes))
    review = ROOT / ".build/presentation-review"
    review.mkdir(parents=True, exist_ok=True)
    (review / "layout.json").write_text(json.dumps(LAYOUT, indent=2) + "\n")
    (review / "pages.json").write_text(json.dumps([{k: v for k, v in page.items() if k != 'text'} for page in PAGES], indent=2) + "\n")
    print(f"Built {TOTAL} vector slides: {OUTPUT}")


if __name__ == "__main__":
    main()
