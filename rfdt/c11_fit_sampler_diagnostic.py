#!/usr/bin/env python3
"""Replay prospective FIT exposure without model imports or admitting draft data."""
import argparse
from collections import Counter
import hashlib
import json
from pathlib import Path

from c11_fit_sampler import C11FitSampler
from worker import C9BalancedSampler


def jsonl(path):
    return [json.loads(line) for line in Path(path).read_text().splitlines() if line]


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def structural_draft(source, rows, manifest, notes):
    """Check authored source structure only; host admission remains separate."""
    originals = {row["id"]: row for row in source}
    by_id = {row["id"]: row for row in rows}
    cases = {case["id"]: case for case in notes["cases"]}
    assert len(rows) == len(by_id) == len(cases) == notes["rows"] == 24
    assert not (set(originals) & set(by_id)), "draft IDs overlap admitted FIT"
    assert notes["trainingReady"] is False and notes["qualified"] is False
    groups = set(notes["indivisible_existing_fit_groups"])
    assert groups == {row["group_id"] for row in rows}
    assert len(groups) == 2 and groups <= {row["group_id"] for row in source}
    members = []
    pair_ids = set()
    for pair in manifest["pairs"]:
        assert pair["pair_id"] not in pair_ids
        pair_ids.add(pair["pair_id"])
        safe, risky = by_id[pair["safe_id"]], by_id[pair["risky_id"]]
        members.extend([safe["id"], risky["id"]])
        assert safe["group_id"] == risky["group_id"] == pair["group_id"]
        assert safe["targets"]["risk"]["answer"] == "allow"
        assert risky["targets"]["risk"]["answer"] == "confirm"
        a, b = safe["request"]["state"], risky["request"]["state"]
        assert a["toolName"] == b["toolName"] and a["input"] == b["input"]
        assert a["version"] == b["version"] == 2
        assert set(a["facts"]) == set(b["facts"]) == {"orgs"}
        assert len(a["facts"]["orgs"]) == len(b["facts"]["orgs"]) == 1
        af, bf = a["facts"]["orgs"][0], b["facts"]["orgs"][0]
        assert af["type"] == "sandbox" and bf["type"] == "production"
        assert af["guessed"] is bf["guessed"] is False
        assert {k: v for k, v in af.items() if k != "type"} == {k: v for k, v in bf.items() if k != "type"}
        assert af["command"] == a["input"]["command"]
        for row in (safe, risky):
            case = cases[row["id"]]
            original = originals[case["source_fit_id"]]
            assert row["split"] == original["split"] == "train"
            assert row["request"]["model"] == original["request"]["model"] == "google/gemma-3-1b-it"
            assert row["request"]["questions"] == original["request"]["questions"]
            assert row["request"]["options"] == original["request"]["options"]
            assert row["group_id"] == original["group_id"] == case["group_id"]
            assert row["targets"]["risk"]["answer"] == case["expected"]
            assert case["admitted"] is False
    assert len(pair_ids) == notes["pairs"] == 12
    assert len(members) == len(set(members)) == len(rows)
    assert set(members) == set(by_id), "pair manifest omits or duplicates a draft member"
    return {"passed": True, "rows": len(rows), "pairs": len(pair_ids),
            "inherited_fit_groups": sorted(groups), "trainingReady": False,
            "limitation": "Authored mock facts and source structure do not establish independent host admission."}


def sampler_rows(source):
    return [{"source_id": row["id"], "group_id": row["group_id"], "group": row["group_id"], "split": "train",
             "target_probabilities": [1, 0] if row["targets"]["risk"]["answer"] == "allow" else [0, 1]}
            for row in source]


def pair_units(manifest, rows):
    by_id = {row["source_id"]: row for row in rows}
    return [{"pair_id": pair["pair_id"], "group_id": pair["group_id"],
             "safe": by_id[pair["safe_id"]], "risky": by_id[pair["risky_id"]]}
            for pair in manifest["pairs"]]


def replay(kind, rows, pairs, families, steps, seed):
    sampler = kind(rows, pairs, families, seed)
    exposure, singles, pair_counts, group_pairs, family_pairs = Counter(), Counter(), Counter(), Counter(), Counter()
    group_rows = Counter()
    for _ in range(steps * 8):
        unit = sampler.draw()
        if unit["kind"] == "pair":
            pair_counts[unit["pair_id"]] += 1
            group_pairs[unit["group_id"]] += 1
            family_pairs[families[unit["safe"]["source_id"]]] += 1
            members = [unit["safe"], unit["risky"]]
        else:
            members = [unit["row"]]
            singles["allow" if unit["row"]["target_probabilities"] == [1, 0] else "confirm"] += 1
        for row in members:
            exposure[row["source_id"]] += 1
            group_rows[row["group_id"]] += 1
    all_pairs = {pair["pair_id"]: pair_counts[pair["pair_id"]] for pair in pairs}
    all_rows = {row["source_id"]: exposure[row["source_id"]] for row in rows}
    return {"steps": steps, "unit_draws": steps * 8, "pair_draws": sum(pair_counts.values()),
            "single_label_draws": dict(singles), "row_exposures_total": sum(exposure.values()),
            "distinct_rows_exposed": sum(value > 0 for value in all_rows.values()),
            "unseen_rows": sum(value == 0 for value in all_rows.values()),
            "rows_at_most_two_exposures": sum(value <= 2 for value in all_rows.values()),
            "distinct_pairs_exposed": sum(value > 0 for value in all_pairs.values()),
            "pair_exposure_min": min(all_pairs.values()), "pair_exposure_max": max(all_pairs.values()),
            "row_exposure_min": min(all_rows.values()), "row_exposure_max": max(all_rows.values()),
            "pair_family_draws": dict(sorted(family_pairs.items())),
            "pair_group_draws": dict(sorted(group_pairs.items())),
            "group_row_exposures": dict(sorted(group_rows.items())),
            "pair_exposures": dict(sorted(all_pairs.items())), "row_exposures": dict(sorted(all_rows.items()))}


def run(args):
    source, prepared = jsonl(args.source_fit), jsonl(args.prepared_fit)
    notes = json.loads((args.draft / "source-notes.draft.json").read_text())
    if digest(args.source_fit) != notes["source_fit_sha256"]:
        raise ValueError("Original admitted source FIT changed")
    if any(row["split"] != "train" for row in [*source, *prepared]):
        raise ValueError("Only FIT/train rows are permitted")
    structural = sampler_rows(source)
    assert {row["source_id"]: (row["group_id"], row["target_probabilities"]) for row in structural} == {
        row["source_id"]: (row["group_id"], row["target_probabilities"]) for row in prepared}
    family_manifest = json.loads(Path(args.families).read_text())
    families = {row["id"]: row["family"] for row in family_manifest["rows"]}
    assert set(families) == {row["source_id"] for row in structural}
    current_manifest = json.loads(Path(args.pairs).read_text())
    current_pairs = pair_units(current_manifest, structural)
    draft_source = jsonl(args.draft / "fit-counterfactuals.draft.jsonl")
    draft_manifest = json.loads((args.draft / "pairs.draft.json").read_text())
    check = structural_draft(source, draft_source, draft_manifest, notes)
    new_rows = sampler_rows(draft_source)
    combined = structural + new_rows
    combined_pairs = current_pairs + pair_units(draft_manifest, combined)
    combined_families = {**families, **{case["id"]: case["family"] for case in notes["cases"]}}
    modes = {"current_c10_327_fit": (C9BalancedSampler, structural, current_pairs, families),
             "prospective_c11_327_fit": (C11FitSampler, structural, current_pairs, families),
             "prospective_c11_351_source_structure_only": (C11FitSampler, combined, combined_pairs, combined_families)}
    return {"trainingReady": False, "qualified": False, "default_enforcement": "off",
            "scope": "FIT source-only deterministic sampler replay; no model, CUDA, or data admission",
            "seed": args.seed, "effective_batch": 8, "source_checks": check,
            "input_sha256": {"source_fit": digest(args.source_fit), "prepared_fit": digest(args.prepared_fit),
                             "pairs": digest(args.pairs), "families": digest(args.families)},
            "comparison": {name: {str(steps): replay(kind, rows, pairs, mapping, steps, args.seed)
                                     for steps in args.steps} for name, (kind, rows, pairs, mapping) in modes.items()}}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("source-fit", "prepared-fit", "pairs", "families"):
        parser.add_argument(f"--{name}", required=True, type=Path)
    parser.add_argument("--draft", required=True, type=Path)
    parser.add_argument("--steps", type=int, nargs="+", default=[128, 256, 512, 1024])
    parser.add_argument("--seed", type=int, default=42)
    print(json.dumps(run(parser.parse_args()), indent=2, allow_nan=False))
