# Candidate 11 report PDF reproduction

The PDF is an offline rendering of the adjacent Markdown report. The renderer
uses Pandoc and an isolated, temporary Chrome profile. It does not start a model,
run scoring or training, execute report commands, or access a remote host.
External document resources are blocked. The source bytes must remain unchanged
throughout rendering.

From the repository root:

```sh
python3 reports/guardrail-risk-2026-09-21/candidate-11-report-assets/render-report-pdf.py \
  reports/guardrail-risk-2026-09-21/candidate-11-stop-report-2026-09-23.md \
  reports/guardrail-risk-2026-09-21/candidate-11-stop-report-2026-09-23.pdf
```

The renderer prints the Markdown and PDF SHA-256 values, PDF byte count, and
tool versions. The original export used Pandoc 3.9.0.2 and Google Chrome
152.0.7977.134 extended on macOS. Set `CHROME_BIN` to use a different local
Chromium executable. PDF bytes may differ between runs because Chrome includes
export metadata; the Markdown bytes define report content.

Pages use US Letter dimensions, numbered footers, repeated table headers, and
wrapping for long paths, URLs and hashes. Relative link annotations resolve
against the Markdown source directory. Existing local artifact links therefore
depend on their actual filesystem locations after a checkout is moved.
