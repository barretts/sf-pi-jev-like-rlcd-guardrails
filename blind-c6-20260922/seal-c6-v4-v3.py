#!/usr/bin/env python3
"""One-time, model-free seal of the independently authored blind C6 splits.

The script prints aggregate validation only. It never prints a case, request,
expected decision, case ID, or held-out label count.
"""

from collections import Counter
import hashlib
import importlib.util
import json
from pathlib import Path
import re
import shutil

import jsonschema


ROOT = Path(__file__).resolve().parent
WORKTREE = ROOT.parent
SUPERSEDED = ROOT / "superseded"
TRAIN = WORKTREE / ".build/guardrail/candidate-6-dev-corrections-v4-20260922/merged-train-validation.jsonl"
SUPPLEMENT = WORKTREE / "fixtures/guardrail/candidate6/train-supplement.json"
AUGMENTATION = WORKTREE / "fixtures/guardrail/candidate6/train-augmentation.json"
BROWSER_TRAIN = WORKTREE / "fixtures/guardrail/candidate6/browser-train-proposal.json"
VALID_RECEIPT = Path("/private/tmp/c6-valid-v4-full-model-free-replay.receipt.json")
TEST_RECEIPT = Path("/private/tmp/c6-test-v3-browser-aggregate-replay-20260922-final.json")
EXPECTED_SHA = {
    TRAIN: "cb50f35f9d0eedf7c366b5093d216839b26c1c7a7103902b81a368addd8a5f09",
    SUPPLEMENT: "f6bcd88d9dc546db1f7f7236db55ad5559c82fce3643f18af2d316a9419a2443",
    AUGMENTATION: "c8538642a18468d5e4607bd650a5dbd8c728791f142ed6496e74434ec7e92409",
    BROWSER_TRAIN: "0066675417d3e6ffeb16af14f9e2571b23eb435f4b52a947ab5cc2c33b681a8d",
    ROOT / "c6-valid-v4.draft.json": "b172cc2c07188c206209e4be1a770fc0cb7484539b770ea0d021d14c30f5dd87",
    ROOT / "c6-test-v3.draft.json": "82cfe17e0fa4bb4ce397f60e0d8479fe9ad0d1aa7aa71807b39b69113ad359c9",
    ROOT / "c6-case-v2.schema.json": "e204e21d086bf4a4bebee0c7c14440ea83ed9509228ec3cab03ba3d55202c376",
    ROOT / "c6-valid-v3.json": "da14b83047094971dfe5083a5ea2fd437c01a44600ce9d9a196cb6dd62287905",
    ROOT / "c6-test-v2.json": "7a0fa5fca18fbcffb5824011884359ceccfa139a42480499b2197a26bb3fc9d1",
}
HOST_SHA = "7d8c068bf02725b1f5ad7d77349a4144390ab0f1a6e531bc28f89af8270154c4"
HOST_COMMIT = "dd97a1a9165a89cdb7ff5b2d0c84d2bbf3843277"
JEV_PROTOCOL = "d67044fb1a5d2a519f12e8b7561ce8e7ed743f42753f726812b0bd99ea6ab530"


def file_sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()).hexdigest()


def write_json(path, value):
    path.write_text(json.dumps(value, indent=2, sort_keys=True, ensure_ascii=False) + "\n")


def collision_counts(left, right):
    _, a = left
    _, b = right
    return {key: sum(a[key][h] * b[key][h] for h in a[key].keys() & b[key].keys())
            for key in ("exact", "canonical", "groups", "templates", "same_effect")}


def main():
    for path, expected in EXPECTED_SHA.items():
        assert file_sha(path) == expected, f"source hash changed: {path.name}"
    assert file_sha(ROOT / "c6-test-v3.draft.manifest.json") == "93796dbcb9b8d9b597a29e7078602af670055605ba62e73283c91816d248d72c"
    schema = json.loads((ROOT / "c6-case-v2.schema.json").read_text())
    splits = {}
    for split, old_name, draft_name, final_name, old_count, total_count in (
        ("valid", "c6-valid-v3.json", "c6-valid-v4.draft.json", "c6-valid-v4.json", 54, 62),
        ("test", "c6-test-v2.json", "c6-test-v3.draft.json", "c6-test-v3.json", 47, 55),
    ):
        old = json.loads((ROOT / old_name).read_text())
        draft = json.loads((ROOT / draft_name).read_text())
        assert draft["split"] == split and len(draft["cases"]) == total_count
        assert draft["cases"][:old_count] == old["cases"]
        assert len({row["id"] for row in draft["cases"]}) == total_count
        assert len({row["template_id"] for row in draft["cases"]}) == total_count
        jsonschema.validate(draft, schema)
        for row in draft["cases"][-8:]:
            obs = row["fixture"].get("observations", {})
            ref, page = obs.get("browserRef", {}), obs.get("browserPage", {})
            if "snapshot" in page:
                snapshot_sha = hashlib.sha256(page["snapshot"].encode()).hexdigest()
                assert snapshot_sha == ref.get("snapshotSha256") == page.get("snapshotSha256")
                assert ref.get("line") in page["snapshot"].splitlines()
                assert str(row["operation"]["input"]["ref"]) in ref["line"]
        splits[split] = (old, draft, old_name, draft_name, final_name)

    assert file_sha(VALID_RECEIPT) == "b3aeb39b730ac8091b01e4f0bca9c19a4b57bd08b5d6dbbecc517adb8015cd5e"
    assert file_sha(TEST_RECEIPT) == "53e4f713b0ae252c32901f18f3ad237253616c38ff35b8eb1f3bd8e429722654"
    receipts = {"valid": json.loads(VALID_RECEIPT.read_text()), "test": json.loads(TEST_RECEIPT.read_text())}
    for split, receipt in receipts.items():
        assert receipt["sf_head"] == HOST_COMMIT and receipt["sf_runtime_sha256"] == HOST_SHA
        assert receipt["model_calls"] == receipt["external_operations_executed"] == 0
        assert receipt["appended_case_count"] == 8
        if split == "test":
            assert receipt["gate_counts"] == {"prepared": 8, "floor": 0, "fallback": 0, "ineligible": 0}
        else:
            assert receipt["valid_case_count"] == 62
            assert receipt["gate_counts"] == {"prepared": 37, "floor": 14, "fallback": 3, "ineligible": 8}
    assert receipts["valid"]["jev_protocol_sha256"] == JEV_PROTOCOL
    assert receipts["valid"]["valid_draft_sha256"] == EXPECTED_SHA[ROOT / "c6-valid-v4.draft.json"]
    assert receipts["test"]["test_v3_draft_sha256"] == EXPECTED_SHA[ROOT / "c6-test-v3.draft.json"]
    assert receipts["test"]["test_manifest_sha256"] == file_sha(ROOT / "c6-test-v3.draft.manifest.json")

    spec = importlib.util.spec_from_file_location("screen_c6", ROOT / "screen-c6.py")
    screen = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(screen)
    pool = screen.load(TRAIN, "train")
    for item in (SUPPLEMENT, AUGMENTATION, BROWSER_TRAIN):
        pool = screen.merge_counts(pool, screen.load(item))
    assert pool[0] == 186
    valid_fp = screen.load(ROOT / "c6-valid-v4.draft.json")
    test_fp = screen.load(ROOT / "c6-test-v3.draft.json")
    screens = {
        "train_valid": collision_counts(pool, valid_fp),
        "train_test": collision_counts(pool, test_fp),
        "valid_test": collision_counts(valid_fp, test_fp),
    }
    assert all(not any(counts.values()) for counts in screens.values())

    lineage_pattern = r"(?i)qwen|tongyi|deepseek|kimi|moonshot|baichuan|yi-large|glm-4|chatglm|minimax|internlm|chinese[- ]lineage"
    assert all(re.search(lineage_pattern, (ROOT / item[3]).read_text()) is None for item in splits.values())
    assert not any((ROOT / item[4]).exists() for item in splits.values())
    assert not any((SUPERSEDED / item[2]).exists() for item in splits.values())

    old_map = json.loads((ROOT / "canonical-family-map.json").read_text())
    family_map = {key: dict(old_map["case_families"][key]) for key in ("valid", "test")}
    new_family = {"apex": "apex", "data360": "data360", "slack_canvas": "canvas", "slack-canvas": "canvas", "browser": "browser", "browser-commit": "browser"}
    final_hash = {}
    manifests = {}
    for split, (old, draft, old_name, draft_name, final_name) in splits.items():
        for row in draft["cases"][len(old["cases"]):]:
            family_map[split][row["id"]] = new_family[row["family"]]
        assert set(family_map[split]) == {row["id"] for row in draft["cases"]}
        final_path = ROOT / final_name
        shutil.copyfile(ROOT / draft_name, final_path)
        assert file_sha(final_path) == file_sha(ROOT / draft_name)
        final_hash[split] = file_sha(final_path)
        rows = draft["cases"]
        fingerprints = {
            "exact": sorted(screen.sha(screen.canonical({"fixture": row["fixture"], "operation": row["operation"]})) for row in rows),
            "canonical": sorted(screen.sha(screen.canonical(screen.normalized_operation(row["operation"]))) for row in rows),
            "group": sorted(screen.sha(row["group_id"]) for row in rows),
            "template": sorted(screen.sha(row["template_id"]) for row in rows),
            "same_effect_heuristic": sorted(screen.sha(screen.same_effect(row["fixture"], row["operation"])) for row in rows),
            "template_request": sorted(screen.sha(screen.canonical({"template_id": row["template_id"], "fixture": row["fixture"], "operation": row["operation"]})) for row in rows),
        }
        manifest = {
            "manifest_version": "c6.4",
            "split": split,
            "sealed": True,
            "data_file": final_name,
            "data_sha256": final_hash[split],
            "schema_file": "c6-case-v2.schema.json",
            "schema_sha256": file_sha(ROOT / "c6-case-v2.schema.json"),
            "case_count": len(rows),
            "added_case_count": len(rows) - len(old["cases"]),
            "family_counts": dict(sorted(Counter(row["family"] for row in rows).items())),
            "group_count": len({row["group_id"] for row in rows}),
            "group_size_histogram": dict(sorted(Counter(Counter(row["group_id"] for row in rows).values()).items())),
            "template_count": len({row["template_id"] for row in rows}),
            "request_fingerprints": fingerprints,
            "fingerprint_spec": "SHA256 of UTF-8 sorted-key compact JSON for exact/canonical/same-effect/template-request; SHA256 of UTF-8 group/template text for those identifiers. Same-effect is a heuristic, not semantic proof.",
            "supersedes": old_name,
            "supersedes_sha256": file_sha(ROOT / old_name),
            "draft_sha256": file_sha(ROOT / draft_name),
            "draft_manifest_sha256": file_sha(ROOT / draft_name.replace(".json", ".manifest.json")),
            "host_commit": HOST_COMMIT,
            "host_runtime_sha256": HOST_SHA,
            "jev_protocol_sha256": JEV_PROTOCOL,
            "model_free_replay_receipt_sha256": file_sha(VALID_RECEIPT if split == "valid" else TEST_RECEIPT),
            "model_free_replay_scope": "full_split" if split == "valid" else "appended_cases_only",
            "cross_split_screen": {"train_pool_count": 186, "all_exact_canonical_group_template_same_effect_cross_pairs_zero": True, "screen_sha256": file_sha(ROOT / "screen-c6.py")},
            "qualification": False,
        }
        if split == "valid":
            manifest["decision_counts"] = dict(sorted(Counter(row["expected"]["decision"] for row in rows).items()))
        else:
            manifest["decision_counts_sealed"] = True
        manifests[split] = manifest
        write_json(ROOT / final_name.replace(".json", ".manifest.json"), manifest)

    mapping = {"mapping_version": "c6-canonical.4", "inputs_sha256": final_hash, "case_families": family_map}
    prepared = {family: {"safe": counts["prepared_safe"], "risky": counts["prepared_risky"]}
                for family, counts in receipts["valid"]["canonical_family_safe_risky_counts"].items()}
    prepared_both = {family: counts["safe"] > 0 and counts["risky"] > 0 for family, counts in prepared.items()}
    assert sum(sum(value.values()) for value in prepared.values()) == 37
    assert sum(prepared_both.values()) == 9 and not prepared_both["files"]
    authored = {}
    for split, (_, draft, _, _, _) in splits.items():
        counts = {family: {"safe": 0, "risky": 0} for family in set(family_map[split].values())}
        for row in draft["cases"]:
            category = "safe" if row["expected"]["decision"] == "allow" else "risky"
            counts[family_map[split][row["id"]]][category] += 1
        assert len(counts) == 10 and all(item["safe"] and item["risky"] for item in counts.values())
        authored[split] = counts
    coverage = {
        "check_version": "c6-canonical-coverage.4",
        "inputs_sha256": final_hash,
        "mapping_sha256": digest(mapping),
        "authored_has_both_safe_and_risky": {split: {family: True for family in sorted(counts)} for split, counts in authored.items()},
        "valid_authored_safe_risky_counts": authored["valid"],
        "test_decision_counts_sealed": True,
        "valid_prepared": {
            "basis": "full 62-case model-free VALID v4 replay under the final frozen sf-pi host and Jev request protocol",
            "prepared_case_count": 37,
            "policy_floor_count": 14,
            "ineligible_count": 8,
            "fallback_count": 3,
            "prepared_safe_risky_counts": prepared,
            "prepared_has_both": prepared_both,
            "all_non_file_families_prepared_with_both": all(value for family, value in prepared_both.items() if family != "files"),
            "all_ten_families_prepared_with_both": False,
            "full_split_receipt_sha256": file_sha(VALID_RECEIPT),
            "fallback_proof_limit": "One harmless quoted-shell request containing sf fails Jev org-fact validation; the other fallbacks have incomplete browser source facts or unverified org identity.",
        },
        "test_prepared": {
            "appended_case_count": 8,
            "appended_prepared_count": 8,
            "full_split_prepared_coverage_claimed": False,
            "appended_receipt_sha256": file_sha(TEST_RECEIPT),
        },
    }
    lineage = {
        "check_version": "c6-lineage.4",
        "files_sha256": {item[4]: final_hash[split] for split, item in splits.items()},
        "pattern_sha256": hashlib.sha256(lineage_pattern.encode()).hexdigest(),
        "match_count": 0,
        "status": "pass",
        "scope": "named-lineage string screen only; model checkpoint provenance remains a separate qualification gate",
    }

    for name in ("canonical-family-map.json", "canonical-coverage-check.json", "lineage-check.json"):
        old_path = ROOT / name
        assert not (SUPERSEDED / name.replace(".json", "-v3.json")).exists()
        shutil.move(old_path, SUPERSEDED / name.replace(".json", "-v3.json"))
    write_json(ROOT / "canonical-family-map.json", mapping)
    coverage["mapping_sha256"] = file_sha(ROOT / "canonical-family-map.json")
    write_json(ROOT / "canonical-coverage-check.json", coverage)
    write_json(ROOT / "lineage-check.json", lineage)
    for split, (_, _, old_name, draft_name, _) in splits.items():
        shutil.move(ROOT / old_name, SUPERSEDED / old_name)
        shutil.move(ROOT / old_name.replace(".json", ".manifest.json"), SUPERSEDED / old_name.replace(".json", ".manifest.json"))
    screen_receipt = {
        "receipt_version": "c6-blind-screen.4",
        "train_source_sha256": {"corrected_158": file_sha(TRAIN), "supplement_18": file_sha(SUPPLEMENT),
                                "augmentation_6": file_sha(AUGMENTATION), "browser_4": file_sha(BROWSER_TRAIN)},
        "split_sha256": final_hash,
        "split_count": {"valid": 62, "test": 55},
        "train_count": 186,
        "collision_cross_pairs": screens,
        "screen_sha256": file_sha(ROOT / "screen-c6.py"),
        "proof_limit": "Exact/canonical/group/template hashes and same-effect heuristic; zero hits do not prove semantic independence.",
    }
    write_json(ROOT / "c6-v4-v3-screen-receipt.json", screen_receipt)
    print(json.dumps({"sealed": True, "valid_cases": 62, "test_cases": 55, "train_pool_cases": 186,
                      "collision_cross_pairs": screens, "valid_prepared": 37,
                      "valid_non_file_paired_prepared_families": 9,
                      "test_appended_prepared": 8, "named_lineage_matches": 0}, sort_keys=True))


if __name__ == "__main__":
    main()
