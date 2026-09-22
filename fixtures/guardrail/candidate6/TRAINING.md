# Candidate 6 RFDT research training

`scripts/guardrail-candidate6-train.mjs` is a separate training lane for the
Google Gemma 3 1B base. It does not modify the default classifier, qualify a
guardrail model, select a candidate, or enable sf-pi enforcement. It starts
from the original Google checkpoint, never a Candidate 5 adapter or GGUF, and
accepts only the case-level, source-pinned TRAIN subset admitted by the Candidate 6
label audit. The original 186-row handoff remains intact; a filtered admitted
file may exclude whole operation groups with unresolved labels or source
preconditions. The launcher rejects missing admission, mixed group
dispositions, rewritten rows, changed policy/rubric, changed host source, and
changed active split seals.

The final merge has 186 TRAIN rows, of which the case-level audit admitted
175 rows in 59 complete operation groups and excluded 11 rows in three groups.
The 96 historical diagnostic VALID rows are in a separate file and are never
passed to RFDT. RFDT's internal validation and test files are empty for this
lane. Candidate selection must use only the prospective sealed C6 VALID v4
cases through the real sf-pi bridge. The C6 TEST v3 file is hashed as an opaque
byte stream for its seal and must not be inspected or evaluated until one
candidate's weights, prompt, allow cutoff, and qualification criteria are
frozen. A model's successful training loss, export, or research validation is
not qualification.

The final admission receipt is pinned by SHA-256
`9552d3412dca9f2079d8d7566471889da7a6596c0551e9aab2e172b52c275dfc`.
Earlier v2 receipts are superseded. Use the unchanged sf-pi checkout for this
campaign:

```sh
node scripts/guardrail-candidate6-train.mjs preflight \
  --merge-receipt .build/guardrail/candidate-6-research-merge-20260922-final/receipt.json \
  --admission-receipt .build/guardrail/candidate-6-train-admission-20260922-final-v3/receipt.json \
  --admission-sha256 9552d3412dca9f2079d8d7566471889da7a6596c0551e9aab2e172b52c275dfc \
  --sf-pi /private/tmp/sf-pi-guardrail-candidate5-20260922
```

`preflight` makes no model calls and starts no worker. It verifies the current
sf-pi commit and risk-runtime identity against the merge and admission
receipts. A reviewed host change requires a fresh host replay, merge, and
admission receipt; training must not silently continue from the old host pin.
Use the reviewed original Google checkpoint. Each optimizer setting gets a
fresh `candidate-6-rfdt-*` run under `.build/guardrail`:

```sh
node scripts/guardrail-candidate6-train.mjs prepare \
  --merge-receipt .build/guardrail/candidate-6-research-merge-20260922-final/receipt.json \
  --admission-receipt .build/guardrail/candidate-6-train-admission-20260922-final-v3/receipt.json \
  --admission-sha256 9552d3412dca9f2079d8d7566471889da7a6596c0551e9aab2e172b52c275dfc \
  --sf-pi /private/tmp/sf-pi-guardrail-candidate5-20260922 \
  --checkpoint /Users/bsonntag/code/simple-jev-ts/.build/hf-session-1_s2hbhu/home/hub/models--google--gemma-3-1b-it/snapshots/dcc83ea841ab6100d6b47a070329e1ba4cf78752 \
  --run .build/guardrail/candidate-6-rfdt-8step-smoke \
  --steps 8

node scripts/guardrail-candidate6-train.mjs train \
  --run .build/guardrail/candidate-6-rfdt-8step-smoke

node scripts/guardrail-candidate6-train.mjs export \
  --run .build/guardrail/candidate-6-rfdt-8step-smoke \
  --model-id jev/gemma-3-1b-guardrail-c6-smoke-8
```

The 8-step run is a bounded pipeline smoke, not a quality candidate. For a
64-, 128-, or 256-step research fit, prepare a **new** run from the original
Google checkpoint with its chosen step count; never resume the smoke adapter.
One training operation writes an attempt receipt, including a failure or
cancellation state and the worker progress hash when available. The run plan
pins the admitted bytes, base checkpoint, protocol, criteria, cutoff, host,
and blind split hashes. The export writes a separate local candidate registry.

The label audit and host fixtures are source-contract evidence. They do not
prove the existence or live behavior of Salesforce org records, Data 360
objects, Slack resources, AgentScript deployments, Herdr panes, or browser
effects. Qualification must still show zero unsafe automatic allows, no lost
hard blocks, no additional unnecessary interruptions, complete model execution
on every eligible call, and measured warm latency through the real bridge.
Browser effect binding and full ten-family model-eligible coverage remain open
gates. A failed criterion keeps sf-pi on its existing rule engine.
