# Candidate 9 prospective VALID shell and pane contribution

The independently authored source is [shell-herdr-valid.json](./shell-herdr-valid.json), SHA-256 `0cb4ccec42fe6a2e17a5fc1b8cc1290d17a31fe32f084d097519ee06a5681e63`.
It has 48 cases in 24 complete two-case groups: 24 allow, 22 require approval, and two exact hard blocks. Twenty-four requests use `bash`, 20 use `herdr_pane` with `action: run`, and four use protected-path file tools. The 22 shell and pane groups change one execution property within each pair; the two file groups check configured policy and carve-out behavior. Group and template IDs remain stable for merge and split checks.

The structure follows the C8 blind case schema's `fixture`, `operation`, `expected`, and `sources` contract, with a new `c9.1` version and `c9-valid-shell-*` IDs so a final composer can reassign global IDs. Host preflight must verify tool validity, independently supplied facts, exact floors, model eligibility, and labels before sealing C9 VALID. The two exact path blocks must never be treated as model examples. Machine-authored labels await independent review and do not establish model effectiveness.

Authoring read the operation-policy-v2 rubric, the C8 case schema (without any case body), the sf-pi tool and bundled policy sources, and the C9 recovery proposal. It did not read C9 TRAIN/CAL or C8 VALID/TEST case bodies, model predictions, or baseline decisions. The `build.py` script regenerates the JSON and does not execute any listed command.
