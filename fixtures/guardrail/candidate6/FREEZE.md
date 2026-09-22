# Candidate 6 pre-TEST freeze

This is a **model-free commitment gate**, not a qualification receipt. It may
run only after a real Candidate 6 model passes the sealed prospective VALID
comparison. The current 128-step report is ineligible: it records 23 benign
interruptions against one from the baseline. Training, an export, a fake
provider, or a saved `candidateSelectionEligible: true` flag alone cannot
produce a freeze.

The current sf-pi host at commit `dd97a1a` also cannot expose preview-session
mode to the provider. The gate explicitly rejects that host even if a later
same-data VALID run appears to pass. Before any freeze can be created, the host
must be repaired, its new commit and runtime digest pinned here, and a
separately reviewed host-fact attestation committed in sf-pi with its exact
SHA-256 pinned in this gate. A report flag or command-line switch cannot make
the old host eligible.

The gate reads the complete VALID report and independently recalculates its
metrics and selection gates. It checks the sealed VALID labels, selected GGUF,
native scoring binary, RFDT plan and artifact registry, seven loaded Jev
distribution modules, evaluator and summary source, scoring protocol,
decision cutoff, qualification criteria, and the committed sf-pi risk runtime.
It records the SHA-256 of the **entire real VALID report**.
The evaluator must record the imported summary helper's SHA-256; the freeze
checks both execution-source files against that report and their committed Git
blobs, and rejects uncommitted changes.

It does **not** name, open, hash, parse, or score the held-out TEST case file.
The freeze includes only the independently sealed TEST data and manifest hashes,
schema hash, and case count already committed in the source merge. The first
future TEST reader must check the freeze's committed Git bytes and current
model/host/source identities, then hash TEST bytes against that commitment
**before parsing** or making a model call.

After a candidate has a passing real VALID report, create a uniquely named
freeze file in the tracked directory:

```sh
node scripts/guardrail-candidate6-freeze.mjs \
  --valid-report .build/guardrail/candidate-6-valid-eval-PASS/report.json \
  --sf-pi /private/tmp/sf-pi-guardrail-candidate5-20260922 \
  --output fixtures/guardrail/candidate6/freezes/c6-selected-candidate.json
```

The command writes a new file exclusively; it will not replace an existing
freeze. Review that file, then commit it **before** any held-out TEST reader is
run. A self-hash or file timestamp is insufficient to prove this order. Check
the commit and recheck the live identities without opening TEST:

```sh
node scripts/guardrail-candidate6-freeze.mjs \
  --verify-ready fixtures/guardrail/candidate6/freezes/c6-selected-candidate.json \
  --sf-pi /private/tmp/sf-pi-guardrail-candidate5-20260922
```

`assertCandidate6FreezeReadyForTest` is the entry point a future TEST runner
must call **as its first operation**, before it can access TEST data. It checks
the exact freeze bytes in Git `HEAD`, the full VALID report, model, native
binary, evaluator code, protocol, criteria, and sf-pi runtime again. Changed,
missing, or uncommitted evidence fails closed. The freeze retains
`qualification: false` and does not enable model enforcement.

The current training preflight hashes TEST as an opaque byte stream before
freeze; it does not parse TEST requests or labels. Therefore this new gate
establishes no-TEST-access for **its own code path** and a commit prerequisite
for a future TEST reader. It cannot retroactively claim that no process has
ever read TEST bytes. The general `GuardrailFreeze` version 2 format requires
TEST gold labels and cannot serve this pre-TEST boundary. A future qualification
receipt must link this committed metadata-only freeze to its held-out result
and the provider's verification path; no such result exists yet.
