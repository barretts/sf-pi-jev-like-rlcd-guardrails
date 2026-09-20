# Bounded publication review

The publication packet is internally consistent and preserves the unsuccessful reduction result. No publication correctness issue was found within the authorized packet. All 12 scheduled workflows completed, but whole physical prompt consumption fell from 141,186 to 120,175 tokens, a reduction of **14.8818%**. The 50% objective remains false and the harness exit code remains **1**.

This review read only the safe files and archive in this folder. It did not inspect raw provider requests, captured system instructions, answers, private configuration, credentials, external corpora, SF source, or model execution. Archived source member bytes were read only for hashing.

## Integrity and attribution

- The protocol, result projection, and archive hashes match `publication-manifest.json`; the archive byte count also matches.
- The protocol hash is bound consistently in the result projection, source manifest, and run claim.
- All 25 archive members are unique, regular files with safe relative paths. No absolute paths, parent traversal, symbolic links, or hard links were present.
- Every archive member matches its source-manifest byte count and SHA-256. All 25 protocol source pins match those archived members.
- The SF inventory records 23 factory entries and one additional catalog entry. Every completed workflow reports 23 controlled factories.

## Complete accounting

The protocol schedule, result schedule, and workflow identifiers cover the same 12 scheduled workflows. All 12 are completed, with zero unrun workflows and zero workflow errors. Every workflow retains affirmative canonical-original verification, wire-projection verification, and cleanup; runtime cleanup is recorded as completed.

| Physical request class | Requests | Prompt tokens |
| ---------------------- | -------: | ------------: |
| Raw tasks              |       12 |       141,186 |
| Compressed tasks       |       15 |       116,949 |
| Summarizer requests    |        8 |         3,226 |
| Entire compressed path |       23 |       120,175 |

All 35 physical rows retain valid, known primary prompt, completion, and total token counters, with total tokens equal to prompt plus completion tokens. The eight summarizer requests retain three completed and five incomplete statuses. Their 3,226 input tokens and 7,680 output tokens remain included in physical accounting; incomplete summarization was not erased by the completed workflow status.

The whole physical prompt reduction independently recomputes as `1 - 120175 / 141186 = 0.1488178714603431`. The separately reported task-only reduction of 17.1667% is not substituted for this objective. Cached prompt usage is unknown in six physical rows; those null values remain unknown and the packet makes no measured billing claim.

## Negative result and privacy

The measurement and publication manifest retain `reductionObjectiveMet: false`; the summary retains `measuredAtLeast50Percent: false`. Workflow execution completion remains a separate fact from objective attainment. Answer quality is deferred, latency is not an acceptance gate, and production improvement is not qualified by this packet.

The result projection contains bounded identifiers, scalars, hashes, counts, statuses, and proof metadata. The inspected structure contains no nonempty captured messages, provider contexts, system instructions, request or response bodies, answers, tool arguments, source text, or free-form errors. Canonical and wire proof entries expose hashes and sizes rather than original identifiers or content. Protocol case records likewise contain only identifiers, hashes, bytes, and line counts.

These are publication consistency checks against the safe projections, not a replay of private raw execution or a semantic answer-quality evaluation. ROOT's separate scan for exact credential bytes remains outside this review. No additional acceptance or production gate is imposed by this review.
