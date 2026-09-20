#!/usr/bin/env python3
"""Create a small, sanitized evidence snapshot for the presentation.

This reads committed summaries and scalar measurements only. It never reads
credentials, captured provider prompts, private logs, weights, or model answers.
"""

import hashlib
import json
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
EVIDENCE_COMMIT = "b5d796c0e7bee0532e2f6c07989fada2393d6342"

SOURCES = [
    ("S01", "Package and controls", "README.md"),
    ("S02", "Implementation evidence", "VERIFICATION.md"),
    ("S03", "Developer experiments", "EXPERIMENTS.md"),
    ("S04", "Prior-thread review", "research/PRIOR_THREAD_REVIEW.md"),
    ("S05", "Context and routing progress", "research/CONTEXT_ROUTING_PROGRESS.md"),
    ("S06", "Fixed-Grok pilot", "research/context-compression-pilot.md"),
    ("S07", "Full SF repetition comparison", "research/context-workflow-sf-validation-root-1/result-projection.json"),
    ("S08", "Repetition overhead diagnostic", "research/context-workflow-sf-validation-root-1/request-overhead-diagnostic.json"),
    ("S09", "Exact-excerpt implementation", "src/context-projection.ts"),
    ("S10", "First excerpt protocol", "research/context-reduction-smoke-root-1/protocol.json"),
    ("S11", "First excerpt measurements", "research/context-reduction-smoke-root-1/measurement.json"),
    ("S12", "Excerpt source validation", "research/context-reduction-smoke-root-1/local-validation.json"),
    ("S13", "Caveman protocol", "research/context-reduction-caveman-smoke-root-1/protocol.json"),
    ("S14", "Caveman measurements", "research/context-reduction-caveman-smoke-root-1/measurement.json"),
    ("S15", "Answer-effectiveness results", "research/context-effectiveness-root-1/RESULTS.md"),
    ("S16", "Answer-effectiveness measurements", "research/context-effectiveness-root-1/measurement.json"),
    ("S17", "Answer-effectiveness records", "research/context-effectiveness-root-1/result-projection.json"),
    ("S18", "Independent evaluation audit", "research/context-effectiveness-root-1/independent-audit.json"),
    ("S19", "Discordant workflows", "research/context-effectiveness-root-1/discordant-workflows.json"),
    ("S20", "Frozen synthetic fixture", "fixtures/context-effectiveness/v1.json"),
    ("S21", "Projection API review", "research/context-projection-api-review.md"),
    ("S22", "Projection source review", "research/context-projection-source-review.md"),
    ("S23", "Reviewed model registry", "src/models.ts"),
    ("S24", "Answer-effectiveness protocol", "research/context-effectiveness-root-1/protocol.json"),
    ("S25", "Independent CPU gold check", "research/context-effectiveness-root-1/gold-check.json"),
    ("S26", "EmbeddingGemma proposal", "research/google-embeddinggemma-runtime-feasibility.md"),
]


def load(path):
    return json.loads((ROOT / path).read_text())


def sha(path):
    return hashlib.sha256((ROOT / path).read_bytes()).hexdigest()


def usage(value):
    if "totals" in value:
        value = value["totals"]
    return {key: value[key] for key in ["promptTokens", "completionTokens", "totalTokens"]}


def reduction(raw, candidate):
    return 1 - candidate / raw


def main():
    sources = [
        {
            "id": sid,
            "title": title,
            "path": path,
            "sha256": sha(path),
            "url": f"https://github.com/barretts/simple-jev-ts/blob/{EVIDENCE_COMMIT}/{path}",
        }
        for sid, title, path in SOURCES
    ]
    repetition_result = load(SOURCES[6][2])
    repetition = repetition_result["summary"]
    rep_raw, rep_comp = [repetition["arms"][arm] for arm in ["baseline", "compact"]]
    rep_metrics = {
        "scheduled": repetition["scheduledSessions"],
        "rawAccepted": rep_raw["acceptedAnswers"],
        "compressedAccepted": rep_comp["acceptedAnswers"],
        "raw": usage(rep_raw["usage"]),
        "compressed": usage(rep_comp["usage"]),
        "elapsedRatio": rep_comp["workflowElapsedSumMs"] / rep_raw["workflowElapsedSumMs"],
        "errors": rep_raw["errors"] + rep_comp["errors"],
    }
    rep_metrics["promptReductionFraction"] = reduction(
        rep_metrics["raw"]["promptTokens"], rep_metrics["compressed"]["promptTokens"]
    )
    rep_metrics["totalReductionFraction"] = reduction(
        rep_metrics["raw"]["totalTokens"], rep_metrics["compressed"]["totalTokens"]
    )
    ordinal_totals = {}
    for arm in ["baseline", "compact"]:
        totals = {}
        for run in repetition_result["runs"]:
            if run["arm"] == arm:
                for request in run["providerRequests"]:
                    ordinal = str(request["index"])
                    totals[ordinal] = totals.get(ordinal, 0) + request["usage"]["promptTokens"]
        ordinal_totals[arm] = totals
    rep_metrics["promptTokensByRequestIndex"] = ordinal_totals
    rep_metrics["requestOrdinalPromptDeltas"] = {
        ordinal: ordinal_totals["compact"].get(ordinal, 0) - ordinal_totals["baseline"].get(ordinal, 0)
        for ordinal in ["0", "1", "2"]
    }
    assert sum(rep_metrics["requestOrdinalPromptDeltas"].values()) == -1653

    excerpt = load(SOURCES[10][2])
    caveman = load(SOURCES[13][2])
    qa = load(SOURCES[16][2])
    qa_measurement = load(SOURCES[15][2])
    qa_summary = qa["summary"]
    quality = qa["effectiveness"]
    qa_metrics = {
        "scheduled": qa_summary["scheduled"],
        "observed": qa_summary["observed"],
        "unrun": qa_summary["unrun"],
        "errors": qa_summary["errors"],
        "raw": usage(qa_summary["arms"]["raw"]["allPhysical"]),
        "compressed": usage(qa_summary["arms"]["compressed"]["allPhysical"]),
        "qualityArms": quality["arms"],
        "allPairs": quality["allPairs"],
        "appliedPairs": quality["appliedPairs"],
        "judges": quality["judges"],
        "measurements": qa_measurement,
        "productionQualified": quality["productionQualified"],
    }
    qa_metrics["promptReductionFraction"] = reduction(
        qa_metrics["raw"]["promptTokens"], qa_metrics["compressed"]["promptTokens"]
    )
    assert rep_metrics["scheduled"] == 192
    assert rep_metrics["raw"]["promptTokens"] == 554728
    assert rep_metrics["compressed"]["promptTokens"] == 553075
    assert excerpt["rawPromptTokens"] == 140766
    assert excerpt["compressedPromptTokens"] == 53955
    assert caveman["rawPromptTokens"] == 141186
    assert caveman["compressedPromptTokens"] == 120175
    assert qa_metrics["scheduled"] == qa_metrics["observed"] == 192
    assert qa_metrics["unrun"] == 0
    assert qa_metrics["raw"]["promptTokens"] == 1593640
    assert qa_metrics["compressed"]["promptTokens"] == 625273
    assert qa_metrics["qualityArms"]["raw"]["accepted"] == 84
    assert qa_metrics["qualityArms"]["compressed"]["accepted"] == 86
    assert qa_metrics["allPairs"]["regressions"] == 1
    assert qa_metrics["productionQualified"] is False
    assert qa_measurement["comparison"]["cliExitCode"] == 1

    # These older model results are documented summaries, not new inference.
    verification = (ROOT / "VERIFICATION.md").read_text()
    experiments = (ROOT / "EXPERIMENTS.md").read_text()
    for fragment in ["0.1139341655", "683 input tokens", "154,268 ms", "17/20 correct"]:
        assert fragment in verification, fragment
    for fragment in ["152/156", "146/156", "6.7002100954", "0.0845734478", "48/56"]:
        assert fragment in experiments, fragment

    snapshot = {
        "reportDate": "2026-09-20",
        "evidenceCommit": EVIDENCE_COMMIT,
        "repo": "barretts/simple-jev-ts",
        "branch": "feat/developer-improvement",
        "sources": sources,
        "metrics": {
            "repetition": rep_metrics,
            "excerptSmoke": excerpt,
            "caveman": caveman,
            "effectiveness": qa_metrics,
        },
        "scope": {
            "allContextWorkloadsSynthetic": True,
            "newProviderRequestsForReport": 0,
            "newModelTrainingForReport": False,
            "billingMeasured": False,
            "naturalDeveloperTaskBenefitQualified": False,
            "blindLegalCleanRoom": False,
        },
    }
    (HERE / "evidence.json").write_text(json.dumps(snapshot, indent=2) + "\n")
    print(f"Saved sanitized measurements and {len(sources)} source pins.")


if __name__ == "__main__":
    main()
