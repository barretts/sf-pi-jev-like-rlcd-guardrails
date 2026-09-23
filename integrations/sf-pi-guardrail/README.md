# sf-pi-jev-guardrails integration with SF Pi

[current-sf-pi.patch](./current-sf-pi.patch) preserves the SF Pi host used by the
C11 experiment. It adds versioned local risk-provider discovery, comparison
records and provider lifecycle handling. SF Guardrail's `tool_call` hook keeps
ownership of exact policy, protected paths, confirmation, session approvals
and audit.

C11 remains **unqualified**. Leave `SF_GUARDRAIL_JEV_MODE` unset or `off` for the
existing Guardrail behavior. `shadow` records local-model judgments alongside
those outcomes. The retained `sf-pi-jev-guardrails` provider never advertises qualification, so
it cannot be admitted for enforcement.

## Pinned host source

| Field                   | Identity                                                           |
| ----------------------- | ------------------------------------------------------------------ |
| SF Pi baseline          | `4f901db9c3f5076ea0305dea33ad6e8856e467da`                         |
| Original host commit    | `a4ba5fe5f86bc0cb01ab85c037bb05114a26ff8a`                         |
| Reconstructed host tree | `bf363cb549c69f8566be79243b57118de933228a`                         |
| Patch SHA-256           | `3d156d653566f10335f269aa1e9381e75e633516b69365a10bb97043bb6e9c0d` |
| Patch size              | 486,849 bytes                                                      |

The current patch derives from the recorded C10 host with the project branding
updated in its documentation. Applying it to the exact baseline in a disposable
Git index reproduces the tree above. This records source identity and integration;
it does not install the host, qualify the model or establish live acceptance.

## Prepare a separate host

Start in the `sf-pi-jev-guardrails` repository. Substitute real, unused local paths for the
placeholders below. Use a fresh SF Pi worktree so the existing checkout keeps
its current state.

```sh
guardrails_root="$PWD"
git -C /path/to/sf-pi worktree add --detach /path/to/fresh-sf-pi-guardrails-host \
  4f901db9c3f5076ea0305dea33ad6e8856e467da
git -C /path/to/fresh-sf-pi-guardrails-host apply --check \
  "$guardrails_root/integrations/sf-pi-guardrail/current-sf-pi.patch"
git -C /path/to/fresh-sf-pi-guardrails-host apply --index \
  "$guardrails_root/integrations/sf-pi-guardrail/current-sf-pi.patch"
git -C /path/to/fresh-sf-pi-guardrails-host write-tree
```

The last command must print `bf363cb549c69f8566be79243b57118de933228a`.
An arbitrary newer SF Pi checkout may have different source and patch context;
the recorded reconstruction uses the exact baseline.

In the `sf-pi-jev-guardrails` checkout, run `git lfs install` and `git lfs pull`
to download the bundled artifacts, then build with `npm ci` and `npm run build`.
Install the prepared SF Pi host and this checkout in the intended Pi profile:

```sh
pi install /path/to/fresh-sf-pi-guardrails-host
pi install "$guardrails_root"
SF_GUARDRAIL_JEV_MODE=shadow pi
```

Inside Pi, use `/reload`, `/jev-risk status`, `/jev-risk warmup`,
`/sf-guardrail risk` and `/sf-guardrail audit`. Start a fresh session after
changing the host mode. The provider loads its model explicitly on warmup or
when the host starts shadow scoring; status and provider discovery use cached
state.

The default bundle is `models/Jev-C11-Step256-Model-2026-09-23/` inside the
installed checkout. It contains the byte-preserved Desktop folder, including
the model and supplied Apple-silicon macOS 26+ scorer. The npm source tarball
excludes this bundle; tarball consumers must set `JEV_GUARDRAIL_BUNDLE` to a
separate complete copy before starting Pi. That variable also selects a moved
bundle. See the repository [setup](../../README.md) for Git LFS instructions,
artifact pins and retained training inputs. The bundle's standalone demo scores
proposed operations as data without executing them.

## Current limits

The step-256 diagnostic recorded five unsafe automatic allows and six benign
interruptions. Its reported accuracy came from consumed diagnostic VALID; no
independently vetted held-out TEST score exists. Missing, duplicated, changed,
malformed or late providers retain the host's visible fallback behavior. Exact
blocks and approval requirements remain authoritative in shadow mode.

[Blog background](../../docs/blog-background.md) preserves the experiment's
chronology and links historical artifacts through ordinary Git history.
