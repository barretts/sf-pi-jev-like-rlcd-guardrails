# Separate Candidate 6 browser TRAIN proposal

[`browser-train-proposal.json`](./browser-train-proposal.json) contains four
machine-authored `sf_browser_click` requests in two matched TRAIN groups. It is
separate from the admitted development pool and any qualification split. The
source JSON SHA-256 is
`0066675417d3e6ffeb16af14f9e2571b23eb435f4b52a947ab5cc2c33b681a8d`.
Regenerate with `node fixtures/guardrail/candidate6/build-browser-train-proposal.mjs`
and check structure with
`node --test fixtures/guardrail/candidate6/browser-train-proposal.test.mjs`.
The fixture records `humanLabelReviewed: false`, `trainingReady: false`, and
`qualification: false`.

Each authored snapshot includes an independently mocked page URL, heading,
role, accessible label, ref line, and full-snapshot SHA-256. A later host
preflight must write each snapshot once for one session, letting sf-pi resolve
both fresh ref and page facts from that same capture. The safe requests inspect
access or retention details. The risky requests state intent to grant write
access broadly or run a customer-record purge in both the original tool reason
and observed link label. The labels require confirmation because those intents
could mutate access or data. **An observed label does not prove the effect of
a live click.** No browser input was dispatched.

The committed sf-pi bridge only uses a model to tighten a baseline `allow` for
a fresh click; exact browser commits remain rule-owned, and missing or changed
evidence falls back to the rules. Jev requires a fresh ref and page from the
same snapshot SHA-256, which the bridge supplies. The source JSON retains its
proposal-time `sfPiHostStatus`; the separate pinned replay receipt below is the
current host evidence. This proposal has **not** been admitted for training.
[`guardrail-candidate6-browser-preflight.mjs`](../../../scripts/guardrail-candidate6-browser-preflight.mjs)
ran a model-free committed-host replay. It
requires explicit pins for the proposal, sf-pi commit, and runtime-source
digest, then writes a model-free, nonqualifying receipt under a fresh
`.build/guardrail/candidate-6-browser-preflight-*` directory. It derives ref
and page facts from one snapshot write per row, checks baseline allow and no
policy floor, and verifies Jev request acceptance without dispatching a click.
The [receipt](../../../.build/guardrail/candidate-6-browser-preflight-20260922-dd97a1a/receipt.json)
pins sf-pi commit `dd97a1a9165a89cdb7ff5b2d0c84d2bbf3843277`, runtime
SHA-256 `7d8c068bf02725b1f5ad7d77349a4144390ab0f1a6e531bc28f89af8270154c4`,
and Jev protocol SHA-256
`d67044fb1a5d2a519f12e8b7561ce8e7ed743f42753f726812b0bd99ea6ab530`.
All four rows were baseline `allow`, model-eligible, and accepted by Jev's
request validator. It made zero model calls and dispatched zero browser inputs.

The request-only aggregate screen returned zero exact, canonical, group,
template, and same-effect collisions against the sealed 54-case VALID v3 and
47-case TEST v2 splits, the separate draft 60-case VALID v4 and 53-case TEST
v3 splits, the existing 176-row TRAIN pool, and the 96 historical diagnostic
VALID rows. The screen emitted no reserved request bodies or labels. These
fingerprints cannot prove semantic independence; repeat screening against
the final sealed revisions and reject a whole matched group if it overlaps.
