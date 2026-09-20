# Context compression V2: fixed synthetic validation protocol

This is a newly machine-authored **synthetic VALIDATION corpus** of 24 context-extraction cases. It is not an unseen human test set, independent human gold, production traffic, or evidence of deployed behaviour. The author did not inspect the candidate codec, source files, previous corpus outputs, answer predictions, or judge predictions, and made no model or network calls. Contexts are authored trace-like text, rather than captures of real command executions or patch-application proof. Names, artifact identifiers, digests within traces, timestamps, and apparent operational facts are fictional.

The frozen fixture is [context-compression-v2-validation.json](../fixtures/context-compression-v2-validation.json). Its format is:

```json
{
  "version": 1,
  "cases": [
    {
      "id": "a stable case identifier",
      "family": "a descriptive scenario family",
      "question": "the fixed extraction question",
      "toolText": "the raw authored tool output",
      "expected": {"explicit_field": "literal expected value"}
    }
  ]
}
```

`version: 1` identifies the fixture schema; V2 identifies this validation iteration. The expected objects were authored as literal references before inference. They were not derived from model responses, codec output, or generated judgement labels. Deterministic checks subsequently recomputed arithmetic and checked the references against source facts. Family labels describe scenario content; they are not inferred quality labels or training/test partitions.

## Freeze and fixed attribution

Final fixture SHA-256, computed before any actual inference:

```text
9f4782b1ad5b3535256f8d963287f1545e7743549a5bca574c0a174169fa8e4b
```

The JSON file is **185,426 UTF-8 bytes**. Decoded `toolText` values total **168,052 UTF-8 bytes** and range from **5,065 to 18,389 bytes**. These measurements exclude questions, expected objects, protocol text, representation instructions, request envelopes, and provider tokenisation overhead. The SHA above attributes the fixture file; fictional artifact digests inside contexts do not establish any actual artifact identity.

Record this fixture SHA, exact codec/configuration identifier, fixed representation instructions, answer-model identifier, judge identifier, decoding settings, budgets, and repetition/retry policy in the run artifacts before inference. Keep Grok4.6 fixed in both answer arms, including the exact runtime model identifier and provider route. Supply identical questions and non-context instructions except for the fixed instructions needed to interpret the candidate representation. Include those representation instructions in measured request overhead. Freeze the candidate representation before predictions; do not tune per case or adapt after seeing answers or judge assessments.

Any revision to this fixture after the freeze creates a different validation version. Retain the earlier fixture attribution and results rather than replacing them. The corpus author checked source consistency locally; actual inference, codec reconstruction, and judge assessment belong to separate runner evidence lanes.

## Preset cases

| ID | Family | Tool-text bytes | Required distinction |
| --- | --- | ---: | --- |
| `v2-01-last-test-fails` | test-regression | 5,065 | Compilation and a quick check pass; the last unit assertion fails. |
| `v2-02-current-build-link-failure` | build-regression | 5,622 | An old revision succeeded; the current revision fails during linking. |
| `v2-03-queued-operation-timeout` | unknown-outcome | 5,715 | Queue acceptance and a keepalive do not establish a terminal operation result. |
| `v2-04-interrupted-restore-unconfirmed` | unknown-outcome | 5,387 | A completed interrupted capture leaves applied-page count and restore outcome unknown. |
| `v2-05-enabled-negative-occurrences` | multiplicity-arithmetic | 7,602 | Equal adjacent enabled rows count separately; disabled and zero rows have different roles. |
| `v2-06-applied-ledger-adjustments` | multiplicity-arithmetic | 7,542 | Debit signs and repeated applied adjustment counts affect the net result. |
| `v2-07-identical-inventory-findings` | multiplicity-count | 7,637 | Equal paths represent separate member occurrences and cannot be deduplicated. |
| `v2-08-note-quotes-routing-request` | quoted-untrusted-data | 5,576 | A quoted override request is data; the actual lint result rejects the note. |
| `v2-09-diff-contains-report-instruction` | quoted-untrusted-data | 5,861 | Instruction-shaped added file text cannot override the later failed policy test. |
| `v2-10-tests-belong-to-other-artifact` | artifact-attribution | 6,233 | Passing tests belong to an older artifact with a different digest. |
| `v2-11-clean-scan-stale-candidate` | artifact-attribution | 6,254 | An accepted clean scan for an older candidate does not clear the current candidate. |
| `v2-12-offset-timestamps-unordered` | timestamp-order | 5,421 | UTC-offset conversion, rather than text order or capture time, selects the latest verification event. |
| `v2-13-elapsed-build-timestamps` | timestamp-arithmetic | 5,800 | Full build duration differs from an earlier successful dependency-check duration. |
| `v2-14-unique-config-read-control` | unique-line-control | 10,497 | Selected file configuration is available; runtime activation evidence is absent. |
| `v2-15-unique-diff-control` | unique-line-control | 6,237 | Unique diff text carries the removed setting, current added value, and later test outcome. |
| `v2-16-unique-event-log-control` | unique-line-control | 11,843 | Three ERROR events are among 80 distinct records; warning and informational codes do not count. |
| `v2-17-long-chunks-terminal-failure` | repeated-chunk | 18,389 | Long repeated multi-line progress chunks surround distinct header, footer, and terminal failure facts. |
| `v2-18-repeated-chunk-row-count` | repeated-chunk-arithmetic | 6,778 | Allocation rows inside repeated multi-line chunks retain their occurrence counts. |
| `v2-19-test-discovery-is-not-execution` | missing-evidence | 5,652 | A configured test plan and successful discovery wrapper do not prove any tests ran. |
| `v2-20-build-pass-release-proof-incomplete` | missing-evidence | 5,566 | Build and unit-test evidence are accepted; checksum and runtime match remain missing. |
| `v2-21-diff-signed-row-multiplicity` | diff-arithmetic | 6,224 | Repeated additions and removals retain signed amounts; subtracting removed negatives changes the net. |
| `v2-22-parallel-job-artifact-attribution` | artifact-attribution | 5,329 | A later pass from a different parallel job does not clear the requested failed job. |
| `v2-23-cache-display-time-not-event-time` | timestamp-order | 5,845 | A later display of an earlier cached success does not supersede a later failed verification event. |
| `v2-24-partial-scan-is-not-clean` | unknown-outcome | 5,977 | Two complete clean package records and a truncated raw fragment do not establish complete scan clearance. |

The three unique-line controls have no duplicate line anywhere in their individual tool texts. They include distinct synthetic digest-like tokens to reduce repetition. Treat them as controls for lower redundancy, not a mathematical assertion that every codec must find them incompressible. Measure expansion or reduction for the frozen candidate codec. The repeated-chunk cases repeat ordered multi-line blocks whose adjacent individual lines differ; they test a different shape from consecutive identical-line runs.

## Preset scoring and evidence lanes

For answer correctness, parse the complete answer as one JSON object and compare it with the literal expected object. Require exactly the expected keys and JSON types, exact strings and nulls, integer numeric fields, and the specified array order. Object key order is irrelevant. Reject duplicate keys, Markdown fences, surrounding prose, trailing non-whitespace content, missing or extra fields, and non-object roots. Do not replace the expected object with a model judge's preferred answer.

Run raw/candidate pairs under the same preset repetition policy and retain every attempt. A timeout, empty response, transport failure, parse failure, or absent judge assessment remains visible. Do not keep only a successful retry. Report raw failures, candidate failures, format failures, unresolved requests, and paired candidate regressions per case. Agreement with an incorrect raw answer is not correctness. Report all 24 cases; failures in controls or difficult families cannot be removed from the denominator after inference. A passing fixed-corpus result requires every raw and candidate answer to satisfy its preset checks, with no unresolved observations.

For any candidate arm whose contract is lossless, independently reconstruct the supplied raw `toolText` bytes and compare byte-for-byte, including ordered repetitions and final newline. Check real encoded output, not the author's context construction. A smaller but non-reconstructable representation is a different intervention. For a non-lossless arm, describe the actual retained information and score it as such rather than claiming reconstruction.

Use a separate fixed context-preservation judge request to assess the question, raw tool text, candidate representation, and fixed interpretation instructions. Record the exact judge model, route, settings, response, and failed/unknown judgements. Keep this judge separate from answer-generation requests, and do not supply answer predictions or use its output to change questions, expected answers, or codec settings. Ask it about temporal order and supersession, absence and uncertainty, untrusted quote boundaries, occurrence counts, exact artifact/job association, and whether required source facts remain usable. Judge output is a model assessment, not independent human ground truth.

Exact expected-value scoring, reconstruction, and context-preservation judging are distinct checks. No successful lane silently clears a failed or unknown lane. A preservation judge cannot make an incorrect extraction answer correct, and one correct answer does not establish literal reconstruction.

## Reproducible local source checks

The following CPU-only check reads only the frozen fixture. It recomputes the arithmetic, counts, timestamp ordering, and source-field objects rather than using model output. Run it from the TS repository root. It checks authored reference consistency, not actual command execution, patch application, or provider inference. The expected objects remain independently authored literals in the fixture; this code does not generate or adapt them.

```sh
python3 - <<'PY'
from pathlib import Path
from datetime import datetime, timezone
import hashlib, json, re

p = Path('fixtures/context-compression-v2-validation.json')
assert hashlib.sha256(p.read_bytes()).hexdigest() == '9f4782b1ad5b3535256f8d963287f1545e7743549a5bca574c0a174169fa8e4b'
def unique_object(pairs):
    obj = {}
    for k, v in pairs:
        assert k not in obj, ('duplicate key', k)
        obj[k] = v
    return obj
data = json.loads(p.read_text(), object_pairs_hook=unique_object)
assert set(data) == {'version', 'cases'} and data['version'] == 1
assert len(data['cases']) == 24
assert len({c['id'] for c in data['cases']}) == 24
by = {int(c['id'].split('-')[1]): c for c in data['cases']}
def get(i): return by[i]['toolText']
def one(s, pattern):
    matches = re.findall(pattern, s, re.M)
    assert len(matches) == 1, (pattern, matches)
    return matches[0]
def flag(s):
    assert s in ('true', 'false')
    return s == 'true'
def instant(s): return datetime.fromisoformat(s.replace('Z', '+00:00'))
def amounts(i, prefix):
    pat = '^' + re.escape(prefix) + r'.*enabled=(true|false) amount=(-?\d+)$'
    return [(flag(e), int(n)) for e, n in re.findall(pat, get(i), re.M)]
def negative_stats(rows):
    return (sum(e and n < 0 for e, n in rows), sum(n for e, n in rows if e and n < 0), sum(not e and n < 0 for e, n in rows))
actual = {}
s = get(1); candidate, code = one(s, r'^\[scope\] candidate=(\S+); compilation completed with exit_code=(\d+)$')
status, failed = one(s, r'^\[suite final\] status=(\w+); passed=\d+; failed=(\d+); skipped=\d+$')
actual[1] = dict(candidate=candidate, compile_exit_code=int(code), final_test_status=status, failed_title=one(s, r'^\[suite\] FAIL title=(.+)$'), failed_count=int(failed))
s = get(2); rev, status, phase = one(s, r'^\[current build final\] revision=(\S+); status=(\w+); phase=(\w+)$')
actual[2] = dict(current_revision=rev, build_status=status, failed_phase=phase, unresolved_symbol=one(s, r'^\[link error\] unresolved symbol=(\w+)$'), usable_output=flag(one(s, r'^\[current build final\] usable_output=(\w+); exit_code=\d+$')))
s = get(3); status, code = one(s, r'^\[watch final\] wrapper_status=(\w+); wrapper_exit_code=(\d+)$'); outcome, receipt = one(s, r'^\[watch final\] operation_outcome=(\w+); durable_receipt_present=(\w+)$')
actual[3] = dict(operation_id=one(s, r'^\[operation\] id=(\S+); queue_ack=accepted$'), wrapper_status=status, wrapper_exit_code=int(code), operation_outcome=outcome, durable_receipt_present=flag(receipt))
s = get(4); code, pages = one(s, r'^\[restore final\] capture_exit_code=(\d+); confirmed_applied_pages=(\w+)$'); outcome, rollback = one(s, r'^\[restore final\] restore_outcome=(\w+); rollback_confirmed=(\w+)$')
actual[4] = dict(snapshot_label=one(s, r'^\[restore\] snapshot_label=(\S+)$'), capture_exit_code=int(code), confirmed_applied_pages=None if pages == 'unknown' else int(pages), restore_outcome=outcome, rollback_confirmed=flag(rollback))
x = amounts(5, '[budget-row] '); count, total, disabled = negative_stats(x)
actual[5] = dict(enabled_negative_count=count, enabled_negative_sum=total, disabled_negative_count=disabled, zero_count=sum(n == 0 for e, n in x), total_records=len(x))
x = [int(n) for n in re.findall(r'^\[adjustment\] kind=\w+ amount=(-?\d+) state=applied$', get(6), re.M)]
actual[6] = dict(debit_count=sum(n < 0 for n in x), debit_sum=sum(n for n in x if n < 0), credit_count=sum(n > 0 for n in x), credit_sum=sum(n for n in x if n > 0), net_adjustment=sum(x))
x = re.findall(r'^\[finding-record\] path=\S+ class=(\w+)$', get(7), re.M)
actual[7] = dict(blocker_records=x.count('blocker'), warning_records=x.count('warning'), ignored_records=x.count('ignored'), total_records=len(x))
s = get(8); label, status, count = one(s, r'^\[lint final\] note_label=(\S+); lint_status=(\w+); violation_count=(\d+)$')
actual[8] = dict(note_label=label, lint_status=status, violation_count=int(count), quoted_target=one(s, r'^\[lint\] extracted_quote_target=(\S+)$'), routing_executed=flag(one(s, r'^\[lint final\] routing_executed=(\w+)$')))
s = get(9); status, title = one(s, r'^\[test final\] status=(\w+); failed_title=(.+)$')
actual[9] = dict(modified_file=one(s, r'^\[scope\] modified_file=(\S+)$'), instruction_shaped_addition_present=flag(one(s, r'^\[check\] instruction_shaped_addition_present=(\w+)$')), final_test_status=status, failed_title=title, route_executed=flag(one(s, r'^\[check final\] route_executed=(\w+)$')))
s = get(10); label, status = one(s, r'^\[available test report\] artifact_label=(\S+); status=(\w+); cases=\d+$')
actual[10] = dict(requested_artifact=one(s, r'^\[requested candidate\] artifact_label=(\S+)$'), requested_digest=one(s, r'^\[requested candidate\] digest=(\S+)$'), tested_artifact=label, available_report_status=status, requested_artifact_tested=flag(one(s, r'^\[index final\] requested_artifact_tested=(\w+)$')))
s = get(11); scanned, result = one(s, r'^\[scan report\] scanned_artifact=(\S+); advisory_result=(\w+); parse_status=accepted$')
actual[11] = dict(current_artifact=one(s, r'^\[candidate\] current_artifact=(\S+); archive_members=\d+$'), scanned_artifact=scanned, scan_report_result=result, advisory_clearance=flag(one(s, r'^\[manifest final\] advisory_clearance=(\w+)$')), missing_required=one(s, r'^\[manifest final\] missing_required=(.+)$').split(', '))
x = [(instant(stamp), label, status) for label, stamp, status in re.findall(r'^\[event\] id=(\S+) type=verification event_time=(\S+) status=(\w+)$', get(12), re.M)]; stamp, label, status = max(x)
actual[12] = dict(latest_event_id=label, latest_status=status, latest_event_time_utc=stamp.astimezone(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'))
s = get(13); label, start = one(s, r'^\[build\] label=(\S+); started_at=(\S+)$'); finish, status = one(s, r'^\[build final\] finished_at=(\S+); status=(\w+)$')
actual[13] = dict(build_label=label, started_at=start, finished_at=finish, elapsed_seconds=int((instant(finish) - instant(start)).total_seconds()), final_status=status)
s = get(14); profile = one(s, r'^\[config\] selected_profile=(\w+)$'); assert 'no runtime profile activation observation supplied' in s
actual[14] = dict(selected_profile=profile, configured_enabled=flag(one(s, '^\\[config\\] ' + re.escape(profile) + r'\.enabled=(\w+)$')), minimum_delta=int(one(s, '^\\[config\\] ' + re.escape(profile) + r'\.minimum_delta=(-?\d+)$')), maximum_delta=int(one(s, '^\\[config\\] ' + re.escape(profile) + r'\.maximum_delta=(-?\d+)$')), runtime_activation_proven=False)
s = get(15)
actual[15] = dict(changed_file_count=len(re.findall(r'^diff --git .+$', s, re.M)), removed_setting=one(s, r'^-([a-z_]+)=true$'), integrity_check_enabled=flag(one(s, r'^\+integrity_check=(\w+)$')), final_test_status=one(s, r'^\[test final\] status=(\w+); reason=.+$'))
s = get(16); x = re.findall(r'^\[event-log\] seq=(\d+) time=(\S+) severity=(\w+) code=(\w+) token=[a-f0-9]+$', s, re.M); errors = [v for v in x if v[2] == 'ERROR']
actual[16] = dict(error_event_count=len(errors), last_error_code=max(errors, key=lambda v: int(v[0]))[3], final_operation_status=one(s, r'^\[log final\] operation_status=(\w+); report_state=complete$'), total_event_count=len(x))
s = get(17); path, version = one(s, r'^\[header\] map_file=(\S+); header_version=(\d+)$'); status, reason = one(s, r'^\[validation final\] status=(\w+); reason=(.+)$')
actual[17] = dict(map_file=path, header_version=int(version), footer_marker=one(s, r'^\[middle\] footer_marker=(\S+); observed trailer length=\d+; required trailer length=\d+$'), final_status=status, failure_reason=reason)
x = amounts(18, '[chunk-row] '); count, total, disabled = negative_stats(x)
actual[18] = dict(enabled_negative_count=count, enabled_negative_sum=total, disabled_negative_count=disabled, total_row_count=len(x))
s = get(19); count, outcome = one(s, r'^\[test final\] executed_test_count=(\d+); test_outcome=(\w+)$'); coverage, reason = one(s, r'^\[test final\] coverage_proven=(\w+); reason=(.+)$')
actual[19] = dict(executed_test_count=int(count), test_outcome=outcome, coverage_proven=flag(coverage), reason=reason)
s = get(20); label, status = one(s, r'^\[build\] candidate=(\S+); status=(\w+); output_file=\S+$'); required = one(s, r'^\[policy\] required evidence in order: (.+)$').split(', '); entries = {k: flag(v) for k, v in re.findall(r'^\[evidence\] name=(\S+) accepted=(true|false)(?: reason=.+)?$', s, re.M)}
actual[20] = dict(candidate=label, build_status=status, present_evidence=[k for k in required if entries[k]], missing_evidence=[k for k in required if not entries[k]], release_proven=flag(one(s, r'^\[summary final\] release_proven=(\w+); report_written=true$')))
x = [(sign, int(n)) for sign, n in re.findall(r'^([+-])allocation enabled=true amount=(-?\d+)$', get(21), re.M)]; added = [n for sign, n in x if sign == '+' and n < 0]; removed = [n for sign, n in x if sign == '-' and n < 0]
actual[21] = dict(added_negative_count=len(added), added_negative_sum=sum(added), removed_negative_count=len(removed), removed_negative_sum=sum(removed), net_value_change=sum(added) - sum(removed))
s = get(22); job, label = one(s, r'^\[request\] target_job=(\S+); target_artifact=(\S+)$'); attributed, status, reason = one(s, '^\\[' + re.escape(job) + r' final\] artifact=(\S+); status=(\w+); reason=(.+)$'); assert label == attributed
actual[22] = dict(target_job=job, target_artifact=label, target_status=status, target_failure_reason=reason, wrapper_exit_code=int(one(s, r'^\[wrapper\] all captures closed; exit_code=(\d+)$')))
s = get(23); events = [(instant(stamp), stamp, status) for stamp, status in re.findall(r'^\[verification event\] artifact=elm-r19; event_time=(\S+); status=(\w+)$', s, re.M)]; _, latest, status = max(events); display, cached, cached_status = one(s, r'^\[cached display\] artifact=elm-r19; display_time=(\S+); cached_event_time=(\S+); cached_status=(\w+)$')
actual[23] = dict(authoritative_status=status, latest_verification_event_time=latest, cached_status=cached_status, cached_event_time=cached, cache_display_time=display)
s = get(24); complete, outcome = one(s, r'^\[scan final\] complete_scan=(\w+); overall_outcome=(\w+)$')
actual[24] = dict(package_result_count=len(re.findall(r'^\[package-result\] package=\S+; advisory_status=\w+$', s, re.M)), complete_scan=flag(complete), overall_outcome=outcome, wrapper_exit_code=int(one(s, r'^\[wrapper\] exit_code=(\d+)$')))

for i, c in by.items():
    assert set(c) == {'id', 'family', 'question', 'toolText', 'expected'}
    assert all(k in c['question'] for k in c['expected'])
    assert c['toolText'].endswith('[capture] output capture completed\n')
    assert json.dumps(actual[i], sort_keys=True) == json.dumps(c['expected'], sort_keys=True), (c['id'], actual[i], c['expected'])
for i in (14, 15, 16):
    lines = get(i).splitlines()
    assert len(lines) == len(set(lines)), by[i]['id']
assert sum(len(c['toolText'].encode()) for c in by.values()) == 168052
print('PASS: frozen SHA, schema, all 24 independently recomputed source objects, arithmetic, timestamps, and unique-line controls')
PY
```

## Interpretation limits

Report per-case raw and candidate context bytes, complete request input tokens when the provider supplies them, and request overhead. Keep answer output tokens, judge-request tokens, retries, transformation time, and provider latency separate. Byte reduction is not automatically billed-token reduction, and context-only accounting cannot establish total cost.

This fixed extraction corpus does not establish full-pi or full-workflow savings, live tool behaviour, multi-step completion reliability, deployment clearance, or quality on unseen tasks. Any separate workflow exercise must attribute its own synthetic inputs, actual model requests, full token accounting, task acceptance checks, and failures. Do not transfer this corpus's context reduction into a whole-workflow saving claim. The 24-case results are descriptive validation results for this fixed corpus and candidate configuration.
