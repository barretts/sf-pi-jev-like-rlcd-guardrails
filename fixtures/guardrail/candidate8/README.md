# Candidate 8 TRAIN recovery corpus

Candidate 7's real 256-update model had zero unsafe automatic allows on its
65-case VALID set but confirmed 24 safe requests, versus two benign
interruptions from the existing engine. C8 is a prospective new candidate.
The C7 VALID diagnostics identify weak operation families; none of the C7
VALID requests or labels enters this training source. C7 VALID cannot select
a C8 model or its cutoff. No C8 model has been fit or scored by this handoff.

The frozen source commit is
7d6b05b43b630cd9a897ea05f98065c125188ea2. Its authored
train-recovery.json has 48 rows in 18 complete matched groups, with 24 allow
and 24 confirm labels. Six shell groups have both bash and herdr_pane
variants. Other groups cover verified Salesforce sandbox versus production
effects, Apex test versus anonymous execution, AgentScript read versus publish,
Data 360 GET versus live POST, bounded SOQL versus disclosure, Slack Canvas
lookup versus access changes, and observed browser navigation versus commit.
Each group keeps its related variants together. The source uses the
operation-policy-v2 rubric and independently supplied synthetic facts;
human label review remains pending.

The source SHA-256 is
b2c72317259633c3362f13553a7ec39dffe144199b9641426e8e3a06af892141.
The fit-only pairs.json SHA-256 is
5d966c78f0b2ea2193a99a8f007cbd84327594c66d4e9bb62f42f8440a233b04.
It contains 31 explicit pairs: 18 new C8 contrasts and 13 individually
selected inherited TRAIN contrasts. Pair IDs are stable; each member is used
once, shares a group, and has the opposite policy label. No same-group
cross-product is inferred. The split-plan.json SHA-256 is
050a5bc0901905ca02e38246bea2f1cf8cfa3aae91bd9efc305e97f5851eaec6.

The C8 source screen found zero exact tool/input overlap with the 227 admitted
C7 TRAIN rows or the already-scored 65 C7 VALID rows, and zero exact command
strings copied from C7 VALID. It read the prior C7 TEST manifest only as
opaque split metadata; it did not read the TEST body. These exact checks do
not establish semantic independence. C7 VALID results informed the broad
C8 recovery topics, so an independently authored C8 VALID set is required
for selection.

After this source was frozen, an aggregate-only screen checked the independent
C8 VALID-only commit 44b4fd1ab595d13e9b576dc5930985a1aa4a15e2. Its
96 cases in 48 groups had zero exact tool/input, command, case ID, or group
ID overlap with the 227 inherited C7 TRAIN rows plus all 48 authored C8
rows. The screen emitted only counts and hashes, never case bodies, and read
no C8 TEST file. Its receipt is
reports/guardrail-risk-2026-09-21/candidate-8-evidence/train/valid-overlap.json.
This checks the current VALID source seal; verify the final manifest hash
again after the scorer/host pin before a model score. Exact overlap alone
does not establish semantic independence or effectiveness.

The model-free replay on sf-pi host
bc7862b078997d2c60aa908979b5cbf59f83db80, runtime SHA-256
6ec845e7365d2948ecf502326bcabbb7b042b7d300437516db3b299fd390078e,
prepared 46 of 48 rows in all 17 intended model-training groups. Its
projected TRAIN JSONL SHA-256 is
2c5d43e7aca4a265192adbd2fbd14e857bdad79da9f879650dc6ec112e8bc73c.
The remaining matched group exercises unknown-org reads and writes. Both
requests correctly trigger the existing engine's unverified-org fallback,
so they are retained as host controls and excluded from fit and calibration.
The replay made zero model calls and executed no operation. On the 46
prepared authored rows, the existing engine allowed all 23 safe requests
and 13 of 23 risky requests; this is a TRAIN-only baseline diagnostic,
not model effectiveness or a C8 VALID score.

The TRAIN-internal split was fixed before any C8 fit. Whole groups are
disjoint:

| Partition             | Inherited rows/groups | New rows/groups | Total rows/groups | Allow / confirm |
| --------------------- | --------------------: | --------------: | ----------------: | --------------: |
| Fit                   |              190 / 64 |         36 / 13 |          226 / 77 |        147 / 79 |
| Calibration           |               37 / 13 |          10 / 4 |           47 / 17 |         24 / 23 |
| Host fallback control |                     0 |           2 / 1 |             2 / 1 |           1 / 1 |

The admission receipt is under
.build/guardrail/candidate-8-admission-v5/receipt.json, with a committed copy
in reports/guardrail-risk-2026-09-21/candidate-8-evidence/train/admission.json.
It checks pinned
source/screen/host bytes, Google Gemma base and prompt protocol, complete
fit/calibration group disjointness, unique model-visible inputs, and every
fit-only pair. Its fit.jsonl SHA-256 is
17f6672fffe913aacdbf44394119bc0b14fbab5db4cc87fccf21c66da449cdc5;
calibration.jsonl SHA-256 is
7371877d67874e8d55c418b678d9d808207bb4e645d1868d4e44ad8d5d57144f.
The calibration records carry a separate split marker and must never be
passed to an RFDT fit. These build files are local, rebuildable receipts,
not committed model weights.

A model-free replay of all 47 calibration requests through the pinned
bc7862b Safety Kernel, using the original requests and reconstructed
independent org/browser facts, returned 42 allows, five confirmations, no
blocks, and no unknown decisions. All 24 safe calibration rows were allowed;
five of 23 risky rows were confirmed by the existing rules. The per-case
input hashes, actions, and routes are in
reports/guardrail-risk-2026-09-21/candidate-8-evidence/train/cal-baseline-bc7862b.json.
Its receipt SHA-256 is
1687f120545c9670bca7efd6ee08da9b2ad4332be8761cf0e237f10f98232c5e.
This is a TRAIN-internal baseline, not a model score. The host runtime
identity changed when the v2 scoring bridge was added. The same 47 requests
were replayed on final bridge commit
d86cdcfcfa02e419a4255291d16e56c48a5f2ade, runtime SHA-256
927c25ebee99f59ea349bcd6d5da06c9a999255e4e99d7658ee0f113da96e4f2.
The v2 receipt is
reports/guardrail-risk-2026-09-21/candidate-8-evidence/train/cal-baseline-cutoff-v2.json,
SHA-256
59e99e7bfbc810a7b86e14a9d09cd11ec12edf3d7c1ed278d0ee5bdf4e3fc93f.
All 47 input hashes, actions, and routes matched the earlier replay, with
zero unknown facts. Cutoff selection must pin this later baseline identity.

The committed source-screen and host-preflight receipts plus the
projected-train.jsonl copy permit a portable admission replay without
the author's original build directory. Pass their exact receipt hashes
as screen-sha256 and host-sha256 to
scripts/guardrail-candidate8-train-admission.mjs, supply the committed
projected-train.jsonl through projected-train, and use a fresh C8
admission output directory. The override is restricted to that committed
projection path and must match the host receipt's projected data hash.

The proposed two fixed schedules are 256 and 512 optimizer updates
from the original reviewed Google Gemma 3 1B checkpoint, revision
dcc83ea841ab6100d6b47a070329e1ba4cf78752. Both use only the
226-row fit partition and the same 31 explicit pairs. The proposed
group-balanced paired-margin objective uses pair margin 2.0, absolute
anchor 1.0, cross-entropy weight 0.25, and anchor weight 0.5. The
TRAIN-only structural check against the optional worker accepted all 31
pairs, covering 62 paired rows and 164 singletons across 77 groups.
This check did not tokenize or optimize the real 1B model.

The proposed model-specific threshold is based only on the reserved
47-row TRAIN calibration set. For the selected allow-versus-confirm
next-token logit difference d, set theta to the larger of zero and
the largest risky-calibration d plus 0.25; use sigmoid(theta) as the
allow-score cutoff. Reject an arm before VALID if this causes more
calibration benign interruptions than the measured existing-engine
calibration baseline, or if any model call or code-owned floor fails.
The objective plan, model IDs, scorer protocol version, cutoff rule,
and gates must be pinned before either fit or any independent C8 VALID
score. This proposal cannot be run under C7's unchanged 0.99 cutoff
without a new versioned scoring protocol. A failed calibration or VALID
gate leaves the existing engine active. This corpus does not change the
default general classifier.
Qwen and Chinese-lineage models, derivatives, teachers, and fallbacks
remain excluded.

During source research, an overly broad search returned a few legacy v2
TEST command lines from an older addendum. Those commands/templates were
excluded from C8 authoring. The sealed C7 TEST body was not read, and no
C8 TEST body has been opened. The C8 blind author remains separate from
this TRAIN source. Exact overlap checks and agent-authored labels require
human review before any production claim.
