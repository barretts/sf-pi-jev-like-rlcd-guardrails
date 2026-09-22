# Candidate 6 research TRAIN admission

The Candidate 6 research merge contains 186 TRAIN rows in 62 operation groups:
158 corrected development rows, 18 separately preflighted supplement rows, and
10 projected rows from five new TRAIN-only matched groups.
[`guardrail-candidate6-train-admission.mjs`](../../../scripts/guardrail-candidate6-train-admission.mjs)
checks the merge bytes and receipt, operation-policy-v2 rubric, and current
sf-pi commit/runtime identity. It records a disposition for every original
TRAIN row and writes a separate, filtered research training file. It reads no
prospective VALID or held-out TEST request bodies or labels.

The case-level audit found **no clear reversed operation-policy label** among
the retained rows under the declared mocked facts. It excludes three complete
operation groups (11 rows):

| Group                                      | Rows | Reason                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ------------------------------------------ | ---: | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `train-shell-typescript-check`             |    3 | `npm run check` executes a project-defined script, but the model state has no cwd, package script, or independently resolved script effect. The checked-out project's current `check` script is not a fact in the model request.                                                                                                                                                                                              |
| `c5-draft-salesforce-pane-query-vs-create` |    6 | Its read contrast uses `/query/?q=`. Salesforce's dedicated [Query reference](https://developer.salesforce.com/docs/platform/api-rest/guide/resources-query.html) shows `/query?q=`, while the [resource list](https://developer.salesforce.com/docs/platform/api-rest/guide/resources-list.html) shows the slash form. The installed CLI preserves the supplied path; its actual endpoint behavior has not been established. |
| `c6-supp-soql-rest-query-vs-queryall`      |    2 | The pair uses `/query/?q=` and `/queryAll/?q=`. The dedicated [QueryAll reference](https://developer.salesforce.com/docs/platform/api-rest/guide/resources-queryall.html) shows `/queryAll?q=`, while the resource list shows the slash form. Its labels have not been reversed; the route premise is withheld.                                                                                                               |

The admitted file therefore has 175 rows in 59 groups. Whole-group exclusion
preserves the authored split unit and the matched contrasts. This is an agent
review of a research TRAIN file, **not** human approval, successful execution
of the requested operations, a qualified model, or permission to open TEST.
The receipt explicitly retains `humanLabelReviewed: false` and
`qualification: false`.

The risk labels describe _attempted operations_ under mocked facts. External
tools were never executed in the admission pass. Synthetic Herdr pane IDs must
represent IDs returned by a prior mocked `herdr_layout.pane_split`; the input
does not create its own pane. The [model-free pane preflight](../../.build/guardrail/candidate-6-herdr-pane-preflight-20260922-final-v3/receipt.json)
checked all 27 Herdr rows against that mocked split-result contract without
running a command. Apex test classes and completed run IDs,
readable AgentScript files and an authoring bundle, a readable Data 360
manifest, existing query/mapping/transform resources, Slack Canvas IDs and
token scopes, and Salesforce objects/records/permissions are fixture
preconditions. They are stated per case in the receipt but are **not verified
live**. The model-free sf-pi host replay only established that requests reached
the risk input with the recorded facts. A future workflow or qualification
claim needs stubbed operation checks and, where relevant, actual resource
acceptance evidence rather than inferring success from these labels.

The five new matched groups are admitted as **operation-intent examples** under
their explicitly mocked facts:

| Group                                   | Safe request                                                                                 | Risky request                                                          | Source boundary                                                                                      |
| --------------------------------------- | -------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `c6-aug-contact-bounded-vs-broad-pii`   | Seven Contact rows with a top-level `LIMIT`                                                  | Up to 2,000 unfiltered Email/Phone rows                                | sf-pi `extensions/sf-soql/lib/runner.ts` and the rubric's explicit broad-disclosure threshold        |
| `c6-aug-quoted-vs-indirect-truncate`    | `printf` prints redirection text                                                             | `sh -c` executes it and truncates the file                             | [POSIX shell redirection](https://pubs.opengroup.org/onlinepubs/9799919799/utilities/V3_chap02.html) |
| `c6-aug-git-dry-run-vs-live-force-push` | `git push --dry-run --no-verify` rehearses without updating refs or invoking a pre-push hook | Live `--force-with-lease` may rewrite a remote branch                  | [Git push documentation](https://git-scm.com/docs/git-push)                                          |
| `c6-browser-train-access-intent`        | Fresh observed View access link expresses inspection intent                                  | Fresh observed Grant write access link expresses a committing intent   | Only the observed ref/page and original request are known before click execution                     |
| `c6-browser-train-retention-intent`     | Fresh observed View retention details link expresses inspection intent                       | Fresh observed Run retention purge link expresses a destructive intent | Only the observed ref/page and original request are known before click execution                     |

The browser labels do **not** prove the page's eventual effect. A link can run
script or change behavior between observation and input. The sf-pi host retains
code-owned browser confirmations and fallback; model output may add a
confirmation but cannot waive an existing confirmation or authorize a live
effect solely from the observed label. The receipt marks these four rows
`browserIntentOnly: true`. The current research TRAIN file still contains no
model-eligible protected-file cases; sf-pi's exact file policy remains in code.
Prospective VALID v4 and TEST v3 remain sealed for their respective
selection and frozen qualification stages. The source merge's aggregate blind
collision screen reported zero listed collisions, but cannot prove semantic
independence.

Generate a fresh receipt and admitted file from this worktree:

```sh
node scripts/guardrail-candidate6-train-admission.mjs \
  --sf-pi /private/tmp/sf-pi-guardrail-candidate5-20260922 \
  --output-dir .build/guardrail/candidate-6-train-admission-NEW
```

The script pins the final 186-row merge, the committed sf-pi runtime, and the
fresh Herdr stub receipt. It refuses changed source hashes, host identity,
unreviewed groups,
duplicate IDs, a changed case count, and an output directory outside
`.build/guardrail`. Its `admittedForResearchTraining` flag authorizes only
training from its pinned `admittedDataset`; it does not certify the model or
alter sf-pi's default-off enforcement mode.
