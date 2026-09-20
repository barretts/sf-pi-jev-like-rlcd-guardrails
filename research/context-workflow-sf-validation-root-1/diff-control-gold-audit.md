# Diff-control gold audit: v2-15-unique-diff-control

**Verdict: the intended gold is factually supported, but the exact string contract is ambiguous.** The published reference correctly identifies three shown file sections, the uniquely removed configuration key `skip_integrity_check`, a literal added `integrity_check=true` assignment, and final test status `failed`. However, the question never specifies that `removed_setting` must contain the bare key rather than the removed assignment `skip_integrity_check=true`. Therefore the permitted question/source alone does not justify claiming that only the frozen bare-key string is an acceptable representation of that fact. A separate structural defect also makes the displayed first hunk inconsistent with valid complete unified-diff syntax.

This is a consumed development-case consistency check, not fresh confirmation. The auditing agent originally machine-authored this synthetic fixture. ROOT supplied only the aggregate trigger that exact-answer mismatches were observed in both arms. No actual answers were inspected, and no mismatch was used to choose or revise a reference. The audit does not assert that either specification issue caused any actual campaign mismatch, does not assign model fault, and does not regrade or tune anything.

## Scope and attribution

Only the published entry `v2-15-unique-diff-control` from `fixtures/context-compression-v2-validation.json` was parsed as a record or emitted for review, limited to its `question`, `toolText`, and `expected`. Identifier lookup did not expose other entries for inspection. No actual session/provider/model answers, predictions, request bodies, system context, other model data, source/research files, credentials, network, or GPU were inspected or accessed. No protocol read was needed. The only written file is this audit artifact; targets, fixtures, sources, research, grading, existing results, campaign files, and Git state remain unchanged.

Decoded `toolText` UTF-8 SHA-256: `8d8acf1fa4785d2b266885b897525e2b23ea558b548711130b0630a381b81445`.

Selected-field SHA-256: `e739666b6b50133a56e8af1fd67e7280a8cd8b07c3939f0d699bf8610a0b56de`, using Python `json.dumps(selected, sort_keys=True, separators=(',', ':'), ensure_ascii=False)` encoded as UTF-8 with no added newline. No other entry is included in these hashes.

The exact question is:

> Return exactly one JSON object without Markdown or commentary. Count diff --git file sections and inspect the current added config line. Keys: changed_file_count (integer), removed_setting (string), integrity_check_enabled (boolean), final_test_status (string).

## Independently recovered facts

The marked diff span contains exactly three `diff --git` section openers:

| Section | Old path | New path |
| --- | --- | --- |
| 1 | `config/checks.ini` | `config/checks.ini` |
| 2 | `docs/checks.txt` | `docs/checks.txt` |
| 3 | `tests/checks.spec.txt` | `tests/checks.spec.txt` |

A secondary check counted three paired `--- a/...` and `+++ b/...` headers, with three distinct normalized paths. Thus `changed_file_count=3` is unambiguous for the requested section count. This is a count of shown sections, not proof that an actual filesystem change occurred.

The configuration body was reconstructed in memory into old-side lines (removals plus context) and new-side lines (additions plus context), then parsed as distinct `key=value` assignments:

- Old and new represented sides each contain 34 assignments.
- The net old-key-minus-new-key set is exactly `{skip_integrity_check}`; its removed assignment is `skip_integrity_check=true`.
- The net new-key-minus-old-key set is exactly `{integrity_check}`; its added assignment is `integrity_check=true`.
- `profile=sample` is the one unchanged context assignment.
- All 32 keys `fixture_token_00` through `fixture_token_31` remain present on both sides with changed 64-character hexadecimal values. Their old values are removed and new values added, so they are modified keys rather than net-removed keys.

A separate raw-line check found 33 removed assignments, 33 added assignments, and one context line. It independently verified the first toggle pair and all 32 retained token-key pairs. The bare-key interpretation of `removed_setting` is therefore uniquely `skip_integrity_check`; this is distinct from choosing any line with a minus prefix.

The literal current added toggle is `+integrity_check=true`, so `integrity_check_enabled=true` is supported under the question's instruction to inspect the added config line. The unique marked final test record is `[test final] status=failed; reason=fixture token mismatch`, so `final_test_status="failed"` is supported. A failed fixture-token test does not change the shown toggle assignment.

Choosing the bare-key convention reconstructs the published object exactly:

```json
{
  "changed_file_count": 3,
  "removed_setting": "skip_integrity_check",
  "integrity_check_enabled": true,
  "final_test_status": "failed"
}
```

This equality establishes that the reference values are defensible. It does not establish that the question uniquely mandates the bare-key convention.

## Exact-string specification ambiguity

`removed_setting` is declared only as a string. The question does not say “removed key name,” “omit the value,” or an equivalent bare-key rule. Both the key name `skip_integrity_check` and the complete removed assignment `skip_integrity_check=true` identify the same unique removed setting. The former is the frozen gold; the latter is an ordinary string representation of the fact shown by the diff. A strict exact-string oracle distinguishes them even though the written task does not explicitly choose between those representations.

The question also leaves net removal versus a removed old-value line implicit. Net-key comparison yields one key; literal minus-prefixed configuration lines include 32 retained keys with changed values. Standard net-setting semantics strongly support the intended key, but an explicit net-removal rule would be needed to eliminate that weaker alternative reading. This audit preserves the published reference and does not introduce an alternate oracle or modify existing grades.

## Unified-diff structural defect

Each hunk was independently checked by counting minus-prefixed lines toward the old side, plus-prefixed lines toward the new side, and context lines toward both:

| File | Printed hunk header | Declared old/new | Displayed old/new | Removed | Added | Context |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| `config/checks.ini` | `@@ -1,2 +1,2 @@` | 2/2 | 34/34 | 33 | 33 | 1 |
| `docs/checks.txt` | `@@ -1 +1 @@` | 1/1 | 1/1 | 1 | 1 | 0 |
| `tests/checks.spec.txt` | `@@ -7 +7 @@` | 1/1 | 1/1 | 1 | 1 | 0 |

The configuration header declares `2/2`, but the displayed body before the next file section represents `34/34`: 33 changed assignments plus one context assignment on each side. The first three body lines already exhaust the printed two-line ranges. Another 64 token edit lines follow without another hunk header. The discrepancy is 32 lines per side. The documentation and test-file hunk counts agree with their bodies.

As a secondary standard-library check, `difflib.unified_diff` was applied only to the in-memory reconstructed old/new configuration strings. Its sole hunk header was `@@ -1,34 +1,34 @@`, independently confirming the 34-line represented sides. No generated patch or oracle fixture was written, and no Git command or real patch application was executed.

Consequently, the printed configuration section cannot be treated as a valid complete unified diff or proof of successfully applied/effective host configuration. The requested literal section count, added toggle, and final-status extraction remain readable despite the malformed hunk metadata. If “current” were interpreted as a verified post-application filesystem/runtime state, the permitted synthetic text provides no such proof; the question explicitly asks to inspect the added config line, so the defensible reference is a textual-inspection result.

## Limits of this finding

The frozen reference has no identified wrong numerical count, toggle value, final status, or intended deleted-key fact. The audit identifies a genuine exact-string specification ambiguity and a malformed-hunk source defect. It does not identify which field any actual answer mismatched or whether either finding explains either arm's observations. No model-quality claim, regrading, oracle replacement, fixture edit, target change, or campaign alteration follows from this report.
