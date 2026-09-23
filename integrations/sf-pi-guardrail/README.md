# SF Guardrail integration

[current-sf-pi.patch](./current-sf-pi.patch) preserves the SF Pi host used by the
C11 experiment. It adds versioned local risk-provider discovery, comparison
records and provider lifecycle handling. SF Guardrail's `tool_call` hook keeps
ownership of exact policy, protected paths, confirmation, session approvals
and audit.

C11 remains **unqualified**. Leave `SF_GUARDRAIL_JEV_MODE` unset or `off` for the
existing Guardrail behavior. `shadow` records local-model judgments alongside
those outcomes. The retained Jev provider never advertises qualification, so
it cannot be admitted for enforcement.

## Pinned host source

| Field                   | Identity                                                           |
| ----------------------- | ------------------------------------------------------------------ |
| SF Pi baseline          | `4f901db9c3f5076ea0305dea33ad6e8856e467da`                         |
| Recorded host commit    | `a4ba5fe5f86bc0cb01ab85c037bb05114a26ff8a`                         |
| Reconstructed host tree | `2a4ba2e4dfe3ec93e0fef43ed39ae8f87190faff`                         |
| Patch SHA-256           | `73a30f72dbb2f1b0e32149745e831978c2da150d4d040068706b842516e92208` |
| Patch size              | 486,815 bytes                                                      |

The current patch is the byte-identical former C10 baseline patch, renamed to
an enduring entry point. Applying it to the exact baseline in a disposable Git
index reproduces the tree above. This records source identity and integration;
it does not install the host, qualify the model or establish live acceptance.

## Prepare a separate host

Start in the Jev repository. Substitute real, unused local paths for the
placeholders below. Use a fresh SF Pi worktree so the existing checkout keeps
its current state.

```sh
jev_root="$PWD"
git -C /path/to/sf-pi worktree add --detach /path/to/fresh-sf-pi-jev \
  4f901db9c3f5076ea0305dea33ad6e8856e467da
git -C /path/to/fresh-sf-pi-jev apply --check \
  "$jev_root/integrations/sf-pi-guardrail/current-sf-pi.patch"
git -C /path/to/fresh-sf-pi-jev apply --index \
  "$jev_root/integrations/sf-pi-guardrail/current-sf-pi.patch"
git -C /path/to/fresh-sf-pi-jev write-tree
```

The last command must print `2a4ba2e4dfe3ec93e0fef43ed39ae8f87190faff`.
An arbitrary newer SF Pi checkout may have different source and patch context;
the recorded reconstruction uses the exact baseline.

Build Jev with `npm ci` and `npm run build`, then install the prepared SF Pi
host and the Jev package in the intended Pi profile:

```sh
pi install /path/to/fresh-sf-pi-jev
pi install "$jev_root"
SF_GUARDRAIL_JEV_MODE=shadow pi
```

Inside Pi, use `/reload`, `/jev-risk status`, `/jev-risk warmup`,
`/sf-guardrail risk` and `/sf-guardrail audit`. Start a fresh session after
changing the host mode. The provider loads its model explicitly on warmup or
when the host starts shadow scoring; status and provider discovery use cached
state.

The default bundle is `~/Desktop/Jev-C11-Step256-Model-2026-09-23`. Set
`JEV_GUARDRAIL_BUNDLE` before starting Pi if it has moved. See the repository
[setup](../../README.md) for artifact pins and retained training inputs.
The Desktop demo scores proposed operations as data without executing them.

## Current limits

The step-256 diagnostic recorded five unsafe automatic allows and six benign
interruptions. Its reported accuracy came from consumed diagnostic VALID; no
independently vetted held-out TEST score exists. Missing, duplicated, changed,
malformed or late providers retain the host's visible fallback behavior. Exact
blocks and approval requirements remain authoritative in shadow mode.

[Blog background](../../docs/blog-background.md) preserves the experiment's
chronology and links historical artifacts through ordinary Git history.
