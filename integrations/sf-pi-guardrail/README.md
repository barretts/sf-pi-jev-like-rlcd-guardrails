# SF Guardrail semantic risk integration

These local patches let the existing SF Guardrail tool-call hook obtain semantic
risk judgments from Simple Jev. The hook owns enforcement, approval, session
grants and audit records. Exact policy constraints remain in code. The extension
uses no Jev implementation imports: it discovers one versioned provider through
`sf-guardrail:risk-providers`.

## Candidate 9 training host (not qualified)

The [Candidate 9 baseline-bound patch](./candidate9-sf-pi-from-4f901db9.patch)
reconstructs the committed sf-pi host for the fresh C9 corpus and future
model-free baseline replay. It adds a bundled confirmation rule for dynamic
shell `eval` on the rules-fallback route. Operator overrides and the existing
`tool_call` approval and audit owner remain authoritative. The replacement C9
VALID source is sealed, but no C9 model fit or effectiveness score is claimed
by this host patch. Keep enforcement at its default `off` mode.

| Artifact                 | Pinned identity                                                    |
| ------------------------ | ------------------------------------------------------------------ |
| SF Pi baseline commit    | `4f901db9c3f5076ea0305dea33ad6e8856e467da`                         |
| C9 host commit           | `4f7fae07f7c04a7ca9f4fdbabc4594a20a8f1d2a`                         |
| C9 host tree             | `4bdbee05cbd490ff3d0f99db43a5133b08a90186`                         |
| Risk baseline SHA-256    | `4c4f874ef4f19988e7a7db84055ebf28c6d25813723acf2c807934e2c8f15421` |
| Effective policy SHA-256 | `e02e9c0914c1b1395adb0b341d6149b54b0b514c2b86cceab44994b5f6425347` |
| Patch SHA-256            | `cf5a24e73a0b8b88575e096b6325e3f50e75829522c189d50578eaf2ed7119b8` |
| Patch size               | 467,622 bytes                                                      |

The binary diff from the exact baseline passed `git apply --cached --check`
and reproduced the committed C9 host tree in a disposable index. The check
left sf-pi working files and its real index unchanged. This patch records
local integration source; it does not install the host or qualify a model.

## Candidate 8 qualification-capable host

The [Candidate 8 baseline-bound patch](./candidate8-sf-pi-from-4f901db9.patch)
reconstructs the committed sf-pi host used for Candidate 8's frozen TRAIN-CAL
cutoff and prospective VALID comparison. The host contains a fail-closed
qualification path that requires a passing held-out receipt. **The patch is
not model qualification.** The [C8 VALID report](../../reports/guardrail-risk-2026-09-21/candidate-8-final.md)
rejected the model on safety, benign-interruption, call-completion, and
deadline gates. TEST was not opened. Keep `SF_GUARDRAIL_JEV_MODE` at its
default `off` outside an isolated shadow replay. The C8 verifier's independent
TEST baseline seal is intentionally absent after failed VALID, so it cannot
qualify this candidate; its inert stub sketch is not an enforcement receipt.

| Artifact                 | Pinned identity                                                    |
| ------------------------ | ------------------------------------------------------------------ |
| SF Pi baseline commit    | `4f901db9c3f5076ea0305dea33ad6e8856e467da`                         |
| C8 final host commit     | `bdbf6292f383a8b2e12cd236aafb2be9c335f463`                         |
| Final host tree          | `50589ffa257f26b9178b21337107bda65d2b3c98`                         |
| Risk baseline SHA-256    | `1e5e8167f25ce8fb440d7bf8054be44a27d67c0fa71272a5558b01204c24bd0e` |
| Effective policy SHA-256 | `06aa441885847cce10b5432120b535657b780726b83327cbfd170b1b455bef22` |
| Patch SHA-256            | `89625f16d10b9a29034d04c1334874a7c2c89a2b64defc872f1d9d6596a5919c` |
| Patch size               | 468,257 bytes                                                      |

The patch is the binary, full-index diff from the baseline to the final host.
It passed `git diff --check` and `git apply --cached --check`; applying it in a
disposable index reproduced the final host tree exactly, without changing the
sf-pi checkout's working files or index. It includes sf-pi ADR 0118
(`docs/adr/0118-sf-guardrail-supports-an-optional-local-jev-risk-provider.md`)
and the update to ADR 0052: a qualified local model may supply semantic risk
judgments, while exact user policy and the `tool_call` approval and audit path
remain authoritative. The patch has not been pushed or installed in the user's
active Pi environment.

## Candidate 7 evaluation host

The [Candidate 7 baseline-bound patch](./candidate7-sf-pi-from-4f901db9.patch)
reconstructs the final local sf-pi host used for C7's frozen validation
comparison. This is integration source provenance, not a model effectiveness
score or permission to enable `enforce`.

| Artifact              | Pinned identity                                                    |
| --------------------- | ------------------------------------------------------------------ |
| SF Pi baseline commit | `4f901db9c3f5076ea0305dea33ad6e8856e467da`                         |
| C7 evaluation commit  | `bc7862b078997d2c60aa908979b5cbf59f83db80`                         |
| Evaluation host tree  | `77baa1b435e07da31675a26ead942d36f0a1bdbe`                         |
| Risk runtime SHA-256  | `6ec845e7365d2948ecf502326bcabbb7b042b7d300437516db3b299fd390078e` |
| Patch SHA-256         | `b1a6e9cbaa436b803fe43b88cc4472f08e1df4261b5ce22001486ca8caeb4bae` |
| Patch size            | 441,504 bytes                                                      |

The patch is `git diff --binary --full-index` from the exact baseline to the
evaluation commit. `git apply --cached --check` and application into a disposable
index reproduced the evaluation tree exactly. That verification wrote no
working files or index changes to the sf-pi checkout. The C7 TRAIN source used
the preceding sf-pi commit `a12f1de85c1919fa2ff94bf9315c522b0ad382da`;
the 52 new TRAIN requests were independently replayed through both hosts and
produced byte-identical model inputs. The 175 inherited C6 TRAIN requests were
not reprojected on the newer host, so that equality claim is limited to the
new supplement.

## Candidate 6 scored host

The [Candidate 6 baseline-bound patch](./candidate6-sf-pi-from-4f901db9.patch)
reproduces the sf-pi source used for both real local-model VALID replays:

| Artifact              | Pinned identity                                                    |
| --------------------- | ------------------------------------------------------------------ |
| SF Pi baseline commit | `4f901db9c3f5076ea0305dea33ad6e8856e467da`                         |
| Scored host commit    | `dd97a1a9165a89cdb7ff5b2d0c84d2bbf3843277`                         |
| Scored host tree      | `2151c6cdda44494ab337046db4a1346381c52a57`                         |
| Risk runtime SHA-256  | `7d8c068bf02725b1f5ad7d77349a4144390ab0f1a6e531bc28f89af8270154c4` |
| Patch SHA-256         | `e80bc982bb45b70d3a746482a74121e1c1b7da36c73ea6e5bbbfd77b92b1efbc` |
| Patch size            | 369,551 bytes                                                      |

The patch was generated from those exact commits with `git diff --binary
--full-index`. `git apply --cached --check` passed against a disposable index
loaded from the baseline; applying the patch to that index produced the scored
host tree above. The sf-pi checkout's working files and index were not changed
by this replay. Candidate 6 was rejected on VALID; this patch is source
provenance, not a qualified model or approval to enable `enforce`. See the
[complete Candidate 6 report](../../reports/guardrail-risk-2026-09-21/candidate-6-final.md)
and tracked per-case receipts.

## Candidate 5 integration

| Artifact                 | Revision                                                                       |
| ------------------------ | ------------------------------------------------------------------------------ |
| SF Pi baseline commit    | `4f901db9c3f5076ea0305dea33ad6e8856e467da`                                     |
| Baseline tree            | `4e08ddb00626e8d47852f604564b10f135082f1a`                                     |
| Local integration commit | `e456e1c9c7c0c9b97ccb08f4084558e5cbcd7a8c`                                     |
| Integration tree         | `027e573cb5b31352a41a1003a6d9798289fe34b6`                                     |
| Patch                    | [candidate5-sf-pi-from-4f901db9.patch](./candidate5-sf-pi-from-4f901db9.patch) |
| Patch SHA-256            | `0dd98422c107e7fc27ad0e93fed615406b2c02c471f5d84ba0462976b82c81cd`             |
| Patch size               | 345,752 bytes                                                                  |

This binary Git diff captures the version-2 Jev risk input, the optional SF Pi
bridge, policy floors, fallback, corpus exporter, and related hook and workflow
checks. Provider discovery and the provider event remain version 1. SF Pi
supplies independently observed browser-page facts when available, but
`sf_browser_press` and non-exact-floor `sf_browser_click` fall back to the
existing rules. The host cannot establish the live page and focused element for
a key press or guarantee that a cached click reference still names the same
target. Pre-click evidence capture is passive; it does not resize the viewport,
scroll, or dismiss overlays before the separately approved click. Direct
`agent-browser` CLI commands retain their existing confirmation floor.
Unverified Salesforce org facts also fall back to rules. These
safeguards leave candidate 5's browser coverage gate open.
The final bundled rules confirm unresolved-org REST writes and Salesforce data
imports inside supported command wrappers; bounded reads and verified sandbox
writes retain their existing path. Known shell forms that execute Salesforce
text hidden from the org parser also require confirmation, and the Jev policy
floor cannot turn that confirmation into an automatic allow.
The final SF Pi commit clarifies the documented latency and browser-effect
limits without changing the Guardrail runtime source.

The patch was generated from the two pinned commits with `git diff --binary
--full-index`. It passed `git diff --check` and `git apply --index --check`.
Applying it in a fresh detached worktree at the pinned baseline reproduced the
integration tree above exactly. The verification checkout was removed afterward;
the active SF Pi branch and index were not changed. The patch has not been
pushed or installed in the user's active Pi environment.

No candidate 5 model has qualified for enforcement. This patch is
integration source, not evidence of model effectiveness or permission to enable
`enforce`. The existing risk engine remains active while the browser coverage
and all other qualification gates are unresolved.

## Current local C9 setup

Use a clean SF Pi worktree at the committed C9 host for model-free preflight
and hook checks:

```sh
git -C /path/to/sf-pi worktree add --detach /tmp/sf-pi-c9-risk 4f7fae07f7c04a7ca9f4fdbabc4594a20a8f1d2a
git -C /tmp/sf-pi-c9-risk rev-parse 'HEAD^{tree}'
```

The second command must print `4bdbee05cbd490ff3d0f99db43a5133b08a90186`.
The baseline-bound C9 patch and its verified reconstruction hash are recorded
above; the committed host is required by the C9 preflight identity checks.
Keep `SF_GUARDRAIL_JEV_MODE` unset or set it to `off`, its default. The existing
SF Guardrail rules, approval path, and audit remain active.

After a C9 model and TRAIN-CAL cutoff are frozen, install the separately built
Jev extension and this pinned SF Pi host in an isolated Pi environment. Set
`SF_GUARDRAIL_JEV_MODE=shadow` and supply the selected model file, artifact
registry, and cutoff receipt with their recorded hashes. Use `/jev-risk warmup`,
`/jev-risk status`, `/sf-guardrail risk`, and `/sf-guardrail audit` to inspect
model comparisons alongside the rule-owned outcomes. No C9 model or cutoff is
selected at this checkpoint, so there are no C9 artifact paths or hashes to
configure yet. The host and Jev provider still recognize C8-specific held-out
qualification receipts for `enforce`; those receipts cannot qualify C9.
Enforcement needs a separately verified C9 receipt path after prospective
VALID and held-out gates pass. See the [C9 preparation record](../../reports/guardrail-risk-2026-09-21/README.md)
and [baseline-seal protocol](../../docs/guardrail-c9-baseline-seal.md).

## Historical candidate 4 integration

| Artifact                         | Revision                                                                                                                             |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| SF Pi baseline                   | `4f901db9c3f5076ea0305dea33ad6e8856e467da`                                                                                           |
| Local integration commit         | `df22795e1eb0d44cdae3a6269929794858dcb6f6`                                                                                           |
| Integration tree                 | `368241cef98569779904763bc20f0688a9773ca9`                                                                                           |
| Exported baseline bundle SHA-256 | `7668c347e040ae314995c11093e0ee877bd8c2f46c98ed7ac6ccbd6d5d080db0`                                                                   |
| Runtime source identity SHA-256  | `333d737bc6a167c342854242a9a6a9d3a160cc68fa28e7ea9dd1a3d14e2730f6`                                                                   |
| Patch                            | [0001-feat-guardrail-support-an-optional-local-Jev-risk-pr.patch](./0001-feat-guardrail-support-an-optional-local-Jev-risk-pr.patch) |

The patch is one email commit with a `base-commit` trailer for the exact SF Pi
baseline above. Its SHA-256 is
`c03309ed3ab04e9f20891ca97643f9dd7e83fecf9abbef5f6bab930ed86bbc4f`
and its size is 267,881 bytes. It includes the optional Jev provider, the
runtime risk floors, corpus exporter, SDK workflow harness, and the related
documentation. Applying it with `git am` in a fresh detached worktree at the
exact baseline reproduced the integration tree above. The active SF Pi branch
and index were not changed by that verification. This patch has not been pushed
or installed in the user's active Pi environment.

### Historical local replay

Use a fresh SF Pi worktree at the pinned baseline, then apply the retained patch:

```sh
git -C /path/to/sf-pi worktree add --detach /tmp/sf-pi-jev-risk 4f901db9c3f5076ea0305dea33ad6e8856e467da
git -C /tmp/sf-pi-jev-risk am /path/to/simple-jev-ts/integrations/sf-pi-guardrail/0001-feat-guardrail-support-an-optional-local-Jev-risk-pr.patch
git -C /tmp/sf-pi-jev-risk rev-parse 'HEAD^{tree}'
```

The final command should print `368241cef98569779904763bc20f0688a9773ca9`.
Install that local SF Pi package and the separately built Jev extension in an
isolated Pi environment when exercising it. See [GUARDRAIL.md](../../GUARDRAIL.md)
for candidate selection, training and the reproducible bridge evaluation.

## Operation modes

`SF_GUARDRAIL_JEV_MODE` defaults to `off`. `shadow` records comparisons while the
existing engine enforces. `enforce` requires a warmed candidate with a verified
held-out qualification matching this SF runtime, model, prompt protocol and
native binary. Unqualified candidates and operational failures retain the rule
decision. Runtime changes require fresh qualification; do not reuse an old
receipt after changing this patch.

With Jev enabled, the general Jev extension awaits risk-worker warmup during
session startup for exact `shadow` and `enforce` opt-in modes. Default `off`
stays lazy. Startup failures remain recorded in provider status and retain the
existing SF fallback. API embeddings must await `AgentSession.bindExtensions`
before tool execution; creating a session alone does not start extensions.
Cold startup is separate from the 750 ms per-call warm deadline. Qualification
for candidate 5 requires every eligible warm call and warm p95 to finish
strictly below 750 ms, including preparation and queueing. Warm p95 strictly
below 500 ms is the reported ideal, not a qualification gate; the historical
candidate 4 gate required p95 at most 500 ms. A timed-out eligible call fails
qualification even when the measured p95 meets the limit. Headless embeddings
can inspect the returned Jev runtime's `guardrailRisk.status()` after binding;
the slash commands use a UI notification surface with no headless output.

## Verification scope

The candidate 5 patch reproduces the exact integration tree
`027e573cb5b31352a41a1003a6d9798289fe34b6` from the pinned baseline. The
historical candidate 4 patch was replayed with `git am` and reproduced tree
`368241cef98569779904763bc20f0688a9773ca9`. Its qualification baseline was
exported twice with byte-identical output; the SHA-256 is in the historical
table. The corpus, model, scoring protocol, exporter, and native runtime must
match the same frozen qualification receipt before model enforcement.

The SF Pi hook and SDK harness use stub tools to exercise blocks, confirmations,
audit records, fallback, and shadow isolation without performing dangerous
external operations. These checks and the patch replay establish integration
behavior; they do not establish local-model effectiveness. The current model
results, matched-workflow measures, and remaining qualification gates are in the
[evidence report](../../reports/guardrail-risk-2026-09-21/README.md).

Model-derived approval fingerprints bind the complete operation, observed host
facts, cwd, active policy, model, and scoring protocol. An existing baseline
confirmation may retain its session option for the exact repeated operation
when its scope permits it and the org is not production or unknown; a novel
model-only risk receives no session option. The existing hook still owns exact
policy blocks, approval revocation, and audit. `off` remains the default; a
candidate that fails qualification leaves the existing engine active.
