# SF Pi Manager integration

This patch adds a general external extension contribution contract to SF Pi
Manager. Jev remains an independently installed Pi extension and imports no SF
Pi implementation modules. The Manager discovers its cached descriptor through
`sf-pi-manager:external-extensions` version 1 and hosts its detail page, scoped
settings, actions, and enablement callback.

The patch is retained in this private repository. The SF Pi source change was
committed locally in an isolated worktree; it has not been pushed to either SF Pi
remote.

| Artifact                       | Exact revision                                                                                                                         |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| SF Pi baseline (`0.284.0`)     | `4f901db9c3f5076ea0305dea33ad6e8856e467da`                                                                                             |
| Local SF Pi integration commit | `f927d52f57185bb5f2d62e8f0cb6997a6656752c`                                                                                             |
| Integration source tree        | `a95fd8662f9d5d39e491601b662c1b181cb55dab`                                                                                             |
| Patch                          | [0001-feat-manager-discover-independent-external-extensions.patch](./0001-feat-manager-discover-independent-external-extensions.patch) |

The patch includes a `base-commit` trailer. Applying it to the exact baseline in
a temporary Git index was verified to reproduce the integration source tree.

## Install a local Manager build

Use a separate checkout so existing SF Pi work stays intact. Set `JEV_REPO` to
the absolute path of this Jev checkout before running these commands:

```bash
JEV_REPO=/absolute/path/to/simple-jev-ts
git clone https://github.com/salesforce/sf-pi.git sf-pi-manager-local
cd sf-pi-manager-local
git switch -c external-manager-integration 4f901db9c3f5076ea0305dea33ad6e8856e467da
git am "$JEV_REPO/integrations/sf-pi-manager/0001-feat-manager-discover-independent-external-extensions.patch"
npm ci
npm run check
npm run lint
env -u NO_COLOR npm test -- --maxWorkers=4
pi install .
```

Install Jev separately using the instructions in the repository README, then
reload Pi. `/jev` opens Jev's Manager detail page when the contract is loaded.
`/sf-pi open jev settings project` opens its project settings. Standalone Pi and
SF Pi without this contract retain Jev's direct commands and `jev_classify` tool.

The patch targets the pinned baseline. Rebase and revalidate it when adopting a
different SF Pi revision; do not assume it applies to future releases unchanged.

## Contract boundaries

Discovery is synchronous and reads cached state. It must not initialize models,
call the network, or start subprocesses. Manager validates bounded descriptor
fields, accepts at most 32 contributions, and rejects duplicate bundled IDs and
the reserved scope IDs `global` and `project`.

External rows own their global/project preferences and lifecycle. They stay out
of SF Pi package filters, bundled enabled counts, and enable-all/disable-all.
Scope changes and completed settings or action panels refresh descriptors and
their settings factories; stale asynchronous factory loads cannot replace the
current scope's factory. A settings panel construction failure leaves Manager
navigation usable.

## Observed verification

Verification ran against the exact integration source tree:

- `npm run generate-catalog` regenerated the catalog and documentation; the
  generated diff is included in the patch.
- `npm run check` passed.
- `npm run lint` passed, including formatting, generated catalog checks, docs
  health, architecture, SPDX, lifecycle checks, and full ESLint.
- Manager tests, runtime surface attestation, and Manager command navigation
  tests passed: 281 tests across 27 files.
- `env -u NO_COLOR npm test -- --maxWorkers=4` passed: 4,301 tests passed and 39
  skipped; 599 files passed and one skipped.
- A focused independent review reproduced and verified the scoped factory,
  stale promise, action panel refresh, and reserved ID regressions.

These checks establish the local Manager contract and patch reproducibility.
They do not establish an installed interactive Pi session or GPU execution.
