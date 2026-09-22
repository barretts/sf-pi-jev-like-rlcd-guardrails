# Candidate 7 TRAIN handoff

This is a new research-training lane for the reviewed **Google Gemma 3 1B**
base. It does not change the default Jev classifier, qualify a guardrail model,
or enable sf-pi enforcement. Qwen and Chinese-lineage models, derivatives,
teachers, and fallbacks are outside this campaign.

[`train-contrasts.json`](./train-contrasts.json) has 52 TRAIN requests in 18
matched operation groups: 26 `allow` and 26 `confirm`. The 8 shell groups include
both direct `bash` and `herdr_pane` variants. The other groups cover Salesforce
package and org operations, Apex, Data 360, SOQL, Slack Canvas, and fresh
browser-link intent. Each row carries mocked preconditions, source evidence,
and an operation-policy-v2 rationale. These are agent-reviewed rubric
interpretations; `humanLabelReviewed` remains false. No requested operation was
executed.

Candidate 6's completed VALID diagnostics motivated the families, especially
destructive local effects versus read/rehearsal effects and safe Salesforce
reads. The new requests use different operation templates and targets rather
than copied VALID examples. The executable
[`train-screen.mjs`](../../../scripts/guardrail-candidate7-train-screen.mjs)
confirms zero **exact** tool/input collisions with the 175 admitted Candidate 6
TRAIN rows and the already-open 62-case Candidate 6 VALID set. That screen
does not prove semantic independence or generalization. It does not read
Candidate 6 or Candidate 7 held-out TEST bytes or labels. A fresh, independently
authored Candidate 7 VALID split is needed for candidate selection.

The [model-free host preflight](../../../scripts/guardrail-candidate7-host-preflight.mjs)
prepares each source request through sf-pi with mocked, independently resolved
facts. On the pinned `dd97a1a9` development host, all **52/52** requests were
eligible, not code-floored, preserved exactly, and model-prepared in **18/18**
complete groups. The existing engine allowed all 26 safe requests, confirmed
three risky requests, and allowed 23 risky requests. This is a _TRAIN source
diagnostic_, not a model score or a new baseline qualification claim. The
preflight made zero model calls and executed no tool or external operation. The
host is provisional for Candidate 7; repeat it against the final committed
preview-session host before using a fit for selection.

The [admission composer](../../../scripts/guardrail-candidate7-train-admission.mjs)
checks the screen, host replay, all whole groups, protocol, source bytes, and
compatibility with Candidate 6's 175 admitted TRAIN rows. The current combined
research file has **227 TRAIN rows in 77 groups** and zero RFDT validation or
test rows. Its receipt records `humanLabelReviewed: false` and
`qualification: false`. If the final host changes the model input or scoring
protocol, reproject and review the old TRAIN rows; the composer rejects mixing
different request versions or prompts.

[`guardrail-candidate7-train.mjs`](../../../scripts/guardrail-candidate7-train.mjs)
has `preflight`, `prepare`, `train`, and `export` phases. It accepts a pinned
admission receipt, the unchanged sf-pi commit/runtime, and a fresh
`candidate-7-rfdt-*` run directory. `prepare` starts from the original Google
checkpoint and records an explicit step count in an immutable run plan. It
pins the committed Jev HEAD, runner, RFDT worker, relevant distribution files,
dependency locks, and native binary bytes; `train` and `export` recheck them.
The runner never reads a held-out TEST file or manifest. RFDT's own generated
`validation.jsonl` and `test.jsonl` must both be empty.

A one-step **prepare-only** smoke on the provisional host completed with all
227 TRAIN rows and empty RFDT validation/test files. Metal initialization is
unavailable in the task sandbox; the successful smoke used the normal host
permission. It did not run an optimizer update or export weights. Once the
final host and source receipts are pinned, prepare two separate, fixed runs
from the original Google base (128 and 256 updates are the intended initial
schedules). Train and export each separately. Compare them on the fresh C7
VALID split only, then freeze one candidate before opening held-out TEST.
No outcome from the old C6 VALID set is a Candidate 7 selection score.

Current provisional receipts are under `.build/guardrail/`:

- `candidate-7-train-source-screen-v4/receipt.json`
- `candidate-7-host-preflight-dd97-v5/receipt.json`
- `candidate-7-train-admission-dd97-v3/receipt.json`
- `candidate-7-rfdt-dd97-1step-smoke-v3/` (prepare-only)

These build receipts are local and rebuildable. The source generator and
admission scripts are committed so a final-host replay can issue new pinned
receipts without importing any model score or held-out case.
