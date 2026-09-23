#!/usr/bin/env python3
"""Render a Markdown report offline with Pandoc and an isolated Chrome profile.

Usage: python3 render_report.py INPUT.md OUTPUT.pdf
Requires pandoc and Google Chrome (or CHROME_BIN pointing to Chromium).
No model, training, evaluation, network service, or remote host is used.
"""

import argparse
import hashlib
import html
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import tempfile
import time


CSS = r"""
@page {
  size: Letter;
  margin: 0.62in 0.64in 0.69in;
  @bottom-left {
    content: "Jev guardrail risk — Candidate 11 stop report";
    font: 8pt Arial, sans-serif;
    color: #5b6470;
  }
  @bottom-right {
    content: "Page " counter(page) " of " counter(pages);
    font: 8pt Arial, sans-serif;
    color: #5b6470;
  }
}
* { box-sizing: border-box; }
html { color: #182330; background: white; }
body {
  margin: 0;
  font: 10pt/1.42 Arial, Helvetica, sans-serif;
  overflow-wrap: anywhere;
  -webkit-print-color-adjust: exact;
  print-color-adjust: exact;
}
h1, h2, h3, h4, h5, h6 {
  line-height: 1.2;
  color: #17324d;
  break-after: avoid-page;
  page-break-after: avoid;
}
h1 { font-size: 23pt; margin: 0 0 15pt; }
h2 {
  font-size: 15pt;
  margin: 20pt 0 8pt;
  border-bottom: 1px solid #c7d2de;
  padding-bottom: 4pt;
}
h3 { font-size: 12pt; margin: 15pt 0 7pt; }
h4, h5, h6 { font-size: 10.5pt; margin: 12pt 0 6pt; }
p { margin: 0 0 8pt; orphans: 3; widows: 3; }
ul, ol { margin: 4pt 0 10pt; padding-left: 19pt; }
li { margin: 0 0 4pt; orphans: 2; widows: 2; }
li > p { margin-bottom: 4pt; }
strong { color: #111c28; }
a { color: #164e87; text-decoration: underline; overflow-wrap: anywhere; }
code {
  font-family: "SFMono-Regular", Menlo, Monaco, monospace;
  font-size: 8.6pt;
  color: #203c54;
  overflow-wrap: anywhere;
  word-break: break-all;
}
pre {
  background: #f1f4f7;
  border: 1px solid #d4dde6;
  border-radius: 3pt;
  padding: 8pt;
  margin: 8pt 0 11pt;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  word-break: break-all;
  break-inside: auto;
}
pre code { font-size: 8pt; line-height: 1.35; color: #243345; }
table {
  border-collapse: collapse;
  width: 100%;
  margin: 9pt 0 13pt;
  font-size: 8.8pt;
  table-layout: auto;
}
thead { display: table-header-group; }
tfoot { display: table-footer-group; }
th, td {
  border: 1px solid #bfcbd6;
  padding: 5pt 6pt;
  vertical-align: top;
  overflow-wrap: anywhere;
}
th { background: #e8eef4; text-align: left; font-weight: bold; }
tr { break-inside: avoid; }
td code, th code { font-size: 7.9pt; }
blockquote {
  margin: 9pt 0 12pt;
  border-left: 3pt solid #7d9db9;
  padding: 5pt 10pt;
  background: #f2f6f9;
}
blockquote p:last-child { margin-bottom: 0; }
hr { border: 0; border-top: 1px solid #c7d2de; margin: 13pt 0; }
img { max-width: 100%; height: auto; }
.sourceCode { overflow: visible; }
"""


def run(command, **kwargs):
    return subprocess.run(command, check=True, capture_output=True, text=True,
                          timeout=120, **kwargs)


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def print_with_chrome(command, workspace, pdf):
    # Some Chrome builds keep a browser service alive after printing. Close only
    # this new process group once its complete PDF has been written.
    with (workspace / "chrome.log").open("w", encoding="utf-8") as log:
        process = subprocess.Popen(command, cwd=workspace, stdout=log, stderr=log,
                                   start_new_session=True)
        deadline = time.monotonic() + 120
        try:
            while time.monotonic() < deadline:
                if pdf.exists() and pdf.read_bytes().rstrip().endswith(b"%%EOF"):
                    return
                if process.poll() is not None:
                    raise RuntimeError("Chrome exited before writing a complete PDF: "
                                       + (workspace / "chrome.log").read_text())
                time.sleep(0.1)
            raise TimeoutError("Chrome did not write a complete PDF within 120 seconds")
        finally:
            try:
                os.killpg(process.pid, signal.SIGTERM)
                process.wait(timeout=10)
            except ProcessLookupError:
                pass
            except subprocess.TimeoutExpired:
                os.killpg(process.pid, signal.SIGKILL)
                process.wait(timeout=10)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    source = args.source.resolve(strict=True)
    output = args.output.resolve()
    pandoc = shutil.which("pandoc")
    chrome = os.environ.get("CHROME_BIN", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome")
    if not pandoc:
        parser.error("pandoc is required")
    if not Path(chrome).is_file():
        parser.error("Google Chrome is required; set CHROME_BIN to its executable")
    source_bytes = source.read_bytes()
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="jev-report-pdf-") as temporary:
        workspace = Path(temporary)
        # Copy the Markdown into this private directory to freeze renderer input.
        frozen_source = workspace / "report.md"
        frozen_source.write_bytes(source_bytes)
        fragment = run([pandoc, str(frozen_source), "--from=gfm", "--to=html5",
                        "--wrap=none", "--no-highlight"]).stdout
        document = workspace / "report.html"
        document.write_text(
            "<!DOCTYPE html><html lang='en'><head><meta charset='utf-8'>"
            "<title>" + html.escape(source.stem) + "</title>"
            "<base href='" + html.escape(source.parent.as_uri() + "/", quote=True) + "'>"
            "<meta name='color-scheme' content='light'>"
            "<meta http-equiv='Content-Security-Policy' "
            "content=\"default-src 'none'; style-src 'unsafe-inline'; "
            "img-src data:; font-src 'none'\">"
            "<style>" + CSS + "</style></head><body>" + fragment + "</body></html>",
            encoding="utf-8",
        )
        temporary_pdf = workspace / "report.pdf"
        print_with_chrome([chrome, "--headless", "--disable-gpu", "--no-first-run",
             "--no-default-browser-check", "--disable-background-networking",
             "--disable-component-update", "--disable-sync",
             "--host-resolver-rules=MAP * ~NOTFOUND",
             "--user-data-dir=" + str(workspace / "chrome-profile"),
             "--no-pdf-header-footer", "--print-to-pdf=" + str(temporary_pdf),
             document.as_uri()], workspace, temporary_pdf)
        if not temporary_pdf.read_bytes().startswith(b"%PDF-"):
            raise RuntimeError("Chrome did not produce a PDF")
        if source.read_bytes() != source_bytes:
            raise RuntimeError("Source changed during rendering; rerun on the final source")
        shutil.copyfile(temporary_pdf, output)
    print(json.dumps({
        "source": str(source), "source_sha256": digest(source),
        "pdf": str(output), "pdf_sha256": digest(output),
        "bytes": output.stat().st_size,
        "pandoc": run([pandoc, "--version"]).stdout.splitlines()[0],
        "chrome": run([chrome, "--version"]).stdout.strip(),
    }, indent=2))


if __name__ == "__main__":
    main()
