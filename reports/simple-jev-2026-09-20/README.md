# Simple Jev presentation report

The presentation covers the independent TypeScript rewrite, local model
selection and RFDT training, Pi/sf-pi integration, fixed-Grok controls, repetition
compaction, caveman summaries, exact excerpts, and the completed bounded
answer-effectiveness evaluation.

The implementation and evidence snapshot is commit
`b5d796c0e7bee0532e2f6c07989fada2393d6342`. Experiment execution has its own
source/protocol pins; the report does not claim inference used that later
documentation commit. No new model inference or training is required to build it.

The PDF is `../simple-jev-presentation-2026-09-20.pdf`. `build_report.py` is the
editable layout and presentation source. `slide-notes.md` is its searchable text
companion. `evidence.json` contains only sanitized scalar results and source
identities. Links inside the PDF point into the private GitHub repository at the
evidence snapshot.

From the repository root:

```sh
python3 -m venv .build/presentation-venv
.build/presentation-venv/bin/python -m pip install -r reports/simple-jev-2026-09-20/requirements.txt
.build/presentation-venv/bin/python reports/simple-jev-2026-09-20/collect_evidence.py
.build/presentation-venv/bin/python reports/simple-jev-2026-09-20/build_report.py
.build/presentation-venv/bin/python reports/simple-jev-2026-09-20/validate_report.py
```

Edit the slide text or drawing calls in `build_report.py`, then rebuild. Building
checks every pinned source hash. Validation extracts PDF text, checks page
geometry and essential measured claims, and renders all pages and a contact
sheet under `.build/presentation-review/` for visual inspection. Recollected
evidence must be reviewed if an experiment source changes; do not replace failed
results with a successful subset.

The report labels bounded successes and failures separately. Exact excerpts met
the requested 50% input-token reduction target in the recorded comparisons, but
one answer regression, execution failures, slower paced request time and
inconclusive supplementary judgments prevent a production qualification.
