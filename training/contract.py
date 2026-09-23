#!/usr/bin/env python3
"""Frozen C11 FIT input, original Gemma lineage, and symmetric objective contract."""
from __future__ import annotations
import hashlib
from datetime import datetime
import importlib.metadata
import json
import math
import platform
import sys
from pathlib import Path
from typing import Any

BASE_MODEL = "google/gemma-3-1b-it"


BASE_REVISION = "dcc83ea841ab6100d6b47a070329e1ba4cf78752"


MLX_VERSION = "0.32.2"


MLX_LM_REVISION = "9d1e356e7cc6549e7d1697adabe2ea01ff8e062c"


MAX_PROMPT_TOKENS = 2048


LORA = {
    "rank": 16,
    "scale": 2.0,
    "dropout": 0.0,
    "keys": ["self_attn.q_proj", "self_attn.v_proj"],
}


ACCUMULATION = 8


LEARNING_RATE = 1e-4


SEED = 42


FREE_CACHE_LIMIT_BYTES = 256 * 1024 * 1024


LOSS = {"ce_weight": 1.0, "anchor_weight": 1.0, "anchor_margin": 2.0, "pair_weight": 0.5, "pair_margin": 4.0}


SOURCE_SAMPLER = {"pair_fraction": 0.5, "row_label_order": ["allow", "confirm"], "family_policy": "round_robin_within_label_or_pair", "item_policy": "shuffled_round_robin", "seed": SEED}


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2, allow_nan=False) + "\n")


def dependencies() -> dict[str, str]:
    if sys.version_info[:2] != (3, 13):
        raise ValueError("C11 training requires Python 3.13")
    versions = {
        name: importlib.metadata.version(name)
        for name in ["mlx", "mlx-lm", "transformers", "huggingface-hub"]
    }
    if versions["mlx"] != MLX_VERSION:
        raise ValueError(f"C11 training requires mlx=={MLX_VERSION}")
    if versions["transformers"] != "5.11.0":
        raise ValueError("C11 training requires transformers==5.11.0")
    distribution = importlib.metadata.distribution("mlx-lm")
    direct_url = distribution.read_text("direct_url.json")
    if not direct_url:
        raise ValueError("Install MLX-LM from the pinned Git commit in requirements.txt")
    source = json.loads(direct_url)
    if source.get("vcs_info", {}).get("commit_id") != MLX_LM_REVISION:
        raise ValueError(f"C11 training requires MLX-LM commit {MLX_LM_REVISION}")
    return {"python": platform.python_version(), **versions, "mlx_lm_revision": MLX_LM_REVISION}


def provenance() -> dict[str, Any]:
    return {
        "base_model": BASE_MODEL,
        "base_revision": BASE_REVISION,
        "lineage": "Google Gemma 3",
        "dependencies": dependencies(),
    }


def verify_local_base(path: Path) -> None:
    """Accept the pinned HF snapshot or a checksum-verified staged equivalent."""
    path = path.resolve()
    if path.parent.name == "snapshots" and path.name == BASE_REVISION:
        repository = path.parent.parent.name
        if repository != "models--google--gemma-3-1b-it":
            raise ValueError("The snapshot repository is not the approved Google Gemma base")
        return
    manifest_path = path / "base-manifest.json"
    if not manifest_path.is_file():
        raise ValueError("A local base requires the pinned HF snapshot or a verified base-manifest.json")
    manifest = json.loads(manifest_path.read_text())
    if manifest.get("base_model") != BASE_MODEL or manifest.get("base_revision") != BASE_REVISION:
        raise ValueError("Local base lineage/revision is not the approved Google Gemma checkpoint")
    files = manifest.get("files")
    if not isinstance(files, dict) or not files or "config.json" not in files or "tokenizer.json" not in files:
        raise ValueError("Local base manifest must cover configuration, tokenizer, and every safetensor")
    for name, checksum in files.items():
        file = (path / name).resolve()
        if not file.is_relative_to(path) or not file.is_file() or sha256(file) != checksum:
            raise ValueError(f"Local base file failed verification: {name}")
    weight_names = {str(file.relative_to(path)) for file in path.glob("*.safetensors")}
    if not weight_names or not weight_names.issubset(files):
        raise ValueError("Local base manifest does not cover every model safetensor")


def resolve_model(model: str, *, fetch: bool, cache_dir: str | None = None) -> Path:
    local = Path(model).expanduser()
    if local.exists():
        resolved = local.resolve()
        verify_local_base(resolved)
        return resolved
    if fetch:
        raise ValueError("Base acquisition is separate from training; use the existing pinned local snapshot")
    if model != BASE_MODEL:
        raise ValueError("Only the pinned Google Gemma 3 1B checkpoint is permitted for C11 training")
    from huggingface_hub import snapshot_download

    path = Path(
        snapshot_download(
            repo_id=BASE_MODEL,
            revision=BASE_REVISION,
            cache_dir=cache_dir,
            local_files_only=not fetch,
            allow_patterns=["*.json", "*.safetensors", "tokenizer.model", "*.jinja", "*.txt"],
        )
    ).resolve()
    verify_local_base(path)
    return path


def read_rows(path: Path, split: str | None = None, content: bytes | None = None) -> list[dict[str, Any]]:
    rows = []
    ids = set()
    versions = set()
    for line_number, line in enumerate((content.decode("utf-8") if content is not None else path.read_text()).splitlines(), 1):
        if not line.strip():
            continue
        row = json.loads(line)
        prefix = f"{path.name}:{line_number}"
        if not isinstance(row, dict) or not isinstance(row.get("id"), str) or not row["id"]:
            raise ValueError(f"{prefix}: a nonempty row ID is required")
        if row["id"] in ids:
            raise ValueError(f"{prefix}: duplicate row ID")
        ids.add(row["id"])
        row["group"] = row.get("group", row.get("group_id"))
        if not isinstance(row.get("group"), str) or not row["group"]:
            raise ValueError(f"{prefix}: a context/source group is required")
        if row.get("split") != "train" or split not in (None, "train"):
            raise ValueError(f"{prefix}: only TRAIN-only FIT rows are permitted")
        prompt = row.get("prompt")
        tokens = row.get("prompt_token_ids")
        allowed = row.get("allowed_token_ids")
        targets = row.get("target_probabilities")
        if not isinstance(prompt, str) or not prompt:
            raise ValueError(f"{prefix}: a rendered prompt is required")
        if not isinstance(tokens, list) or not 1 <= len(tokens) <= MAX_PROMPT_TOKENS:
            raise ValueError(f"{prefix}: prompt must have 1..{MAX_PROMPT_TOKENS} tokens; truncation is forbidden")
        if not isinstance(allowed, list) or not 2 <= len(allowed) <= 50 or len(set(allowed)) != len(allowed):
            raise ValueError(f"{prefix}: distinct answer token IDs are required")
        for token in tokens + allowed:
            if type(token) is not int or not 0 <= token < 262144:
                raise ValueError(f"{prefix}: invalid Gemma token ID")
        if not isinstance(targets, list) or len(targets) != len(allowed):
            raise ValueError(f"{prefix}: target distribution must match allowed tokens")
        if any(type(value) not in {int, float} or not math.isfinite(value) or value < 0 for value in targets):
            raise ValueError(f"{prefix}: targets must be finite nonnegative probabilities")
        if not math.isclose(sum(targets), 1.0, abs_tol=1e-6):
            raise ValueError(f"{prefix}: target probabilities must sum to one")
        version = row.get("template_version", "v2")
        if version not in {"v1", "v2"}:
            raise ValueError(f"{prefix}: invalid template version")
        row["template_version"] = version
        versions.add(version)
        rows.append(row)
    if not rows:
        raise ValueError(f"No {split or 'prepared'} rows in {path}")
    if len(versions) != 1:
        raise ValueError("One training/evaluation input must use one template version")
    return rows


def read_guardrail_pairs(path: Path, rows: list[dict[str, Any]], content: bytes | None = None) -> list[dict[str, Any]]:
    """Admit only explicit, disjoint pairs from the prepared TRAIN branch."""
    manifest = json.loads(content if content is not None else path.read_bytes())
    if not isinstance(manifest, dict) or set(manifest) != {"version", "pairs"} or type(manifest["version"]) is not int or manifest["version"] != 1 or not isinstance(manifest["pairs"], list) or not manifest["pairs"]:
        raise ValueError("Invalid guardrail TRAIN pair manifest")
    by_source = {}
    for row in rows:
        source = row.get("source_id")
        if not isinstance(source, str) or not source or source in by_source:
            raise ValueError("Guardrail pair training requires unique prepared source IDs")
        if row.get("split") != "train" or row.get("question_id") != "risk" or row.get("question_type") != "choice" or row.get("answer_labels") != ["allow", "confirm"] or row.get("target_probabilities") not in ([1, 0], [0, 1]) or len(row["allowed_token_ids"]) != 2:
            raise ValueError("Guardrail pair training requires exact allow/confirm TRAIN targets")
        by_source[source] = row
    pair_ids = set()
    used_sources = set()
    pairs = []
    for pair in manifest["pairs"]:
        if not isinstance(pair, dict) or set(pair) != {"pair_id", "group_id", "safe_id", "risky_id"} or any(not isinstance(value, str) or not value or len(value) > 256 for value in pair.values()):
            raise ValueError("Invalid guardrail pair record")
        pair_id, group, safe_id, risky_id = (pair[key] for key in ("pair_id", "group_id", "safe_id", "risky_id"))
        if pair_id in pair_ids or safe_id == risky_id or safe_id in used_sources or risky_id in used_sources:
            raise ValueError("Duplicate guardrail pair ID or reused TRAIN source")
        safe, risky = by_source.get(safe_id), by_source.get(risky_id)
        if safe is None or risky is None or safe["group"] != group or risky["group"] != group:
            raise ValueError("Guardrail pair must name two TRAIN rows from its own group")
        if safe["target_probabilities"] != [1, 0] or risky["target_probabilities"] != [0, 1]:
            raise ValueError("Guardrail pair requires safe then risky targets")
        if safe.get("prompt_token_ids") == risky.get("prompt_token_ids"):
            raise ValueError("Opposite guardrail targets cannot share one rendered prompt")
        pair_ids.add(pair_id)
        used_sources.update((safe_id, risky_id))
        pairs.append({"pair_id": pair_id, "group_id": group, "safe": safe, "risky": risky})
    return pairs


def read_guardrail_families(path: Path, rows: list[dict[str, Any]], content: bytes | None = None) -> dict[str, str]:
    """Bind every prepared FIT source to its reviewed family and target."""
    manifest = json.loads(content if content is not None else path.read_bytes())
    if not isinstance(manifest, dict) or set(manifest) != {"version", "purpose", "rows"} or type(manifest["version"]) is not int or manifest["version"] != 1 or manifest["purpose"] != "candidate9_fit_families" or not isinstance(manifest["rows"], list) or len(manifest["rows"]) != len(rows):
        raise ValueError("Invalid Frozen FIT family manifest")
    by_source = {row.get("source_id"): row for row in rows}
    if len(by_source) != len(rows) or None in by_source:
        raise ValueError("Frozen FIT requires unique prepared source IDs")
    families = {}
    for item in manifest["rows"]:
        if not isinstance(item, dict) or set(item) != {"id", "group_id", "family", "expected"}:
            raise ValueError("Invalid Frozen FIT family record")
        source, group, family, expected = (item[key] for key in ("id", "group_id", "family", "expected"))
        row = by_source.get(source)
        if not isinstance(source, str) or source in families or row is None or not isinstance(group, str) or group != row["group"] or not isinstance(family, str) or not family or len(family) > 128 or expected not in {"allow", "confirm"} or row["target_probabilities"] != ([1, 0] if expected == "allow" else [0, 1]):
            raise ValueError("Frozen FIT family, group, or target differs from prepared TRAIN")
        families[source] = family
    if set(families) != set(by_source):
        raise ValueError("Frozen FIT family manifest omitted prepared source IDs")
    return families


def verify_prompt_parity(tokenizer: Any, rows: list[dict[str, Any]]) -> dict[str, Any]:
    labels_checked = 0
    for row in rows:
        expected = row["prompt_token_ids"]
        actual = tokenizer.encode(row["prompt"], add_special_tokens=False)
        if actual != expected:
            first = next((i for i, pair in enumerate(zip(actual, expected)) if pair[0] != pair[1]), min(len(actual), len(expected)))
            raise ValueError(f"{row['id']}: native/HF prompt token mismatch at position {first}")
        labels = row.get("output_labels")
        if labels is not None and (not isinstance(labels, list) or len(labels) != len(row["allowed_token_ids"])):
            raise ValueError(f"{row['id']}: output labels must match allowed tokens")
        for index, token in enumerate(row["allowed_token_ids"]):
            label = labels[index] if labels is not None else tokenizer.decode([token], clean_up_tokenization_spaces=False, skip_special_tokens=False)
            if not isinstance(label, str) or not label:
                raise ValueError(f"{row['id']}: invalid answer label")
            with_label = tokenizer.encode(row["prompt"] + label, add_special_tokens=False)
            if with_label != expected + [token]:
                raise ValueError(f"{row['id']}: answer label {label!r} is not exactly one token at the prompt boundary")
            labels_checked += 1
    return {
        "rows_checked": len(rows),
        "labels_checked": labels_checked,
        "rendered_prompt_tokens": True,
        "answer_label_boundaries": True,
        "add_special_tokens": False,
        "template_version": rows[0]["template_version"],
    }


def load_tokenizer(model_dir: Path) -> Any:
    from transformers import AutoTokenizer

    return AutoTokenizer.from_pretrained(str(model_dir), local_files_only=True, trust_remote_code=False)


def validate_architecture(config: dict[str, Any]) -> None:
    if config.get("model_type") != "gemma3_text":
        raise ValueError("C11 training requires Google's Gemma 3 text architecture")
    expected = {
        "num_hidden_layers": 26,
        "hidden_size": 1152,
        "intermediate_size": 6912,
        "num_attention_heads": 4,
        "num_key_value_heads": 1,
        "head_dim": 256,
        "vocab_size": 262144,
    }
    if any(config.get(key) != value for key, value in expected.items()):
        raise ValueError("C11 training requires the approved Google Gemma 3 1B architecture")
    if config.get("quantization") or config.get("quantization_config"):
        raise ValueError("C11 training starts from the unquantized Google checkpoint")


def sigmoid(value: float) -> float:
    return 1.0 / (1.0 + math.exp(-value)) if value >= 0 else math.exp(value) / (1.0 + math.exp(value))


def softplus(value: float) -> float:
    return max(value, 0.0) + math.log1p(math.exp(-abs(value)))


def row_loss(margin: float, safe: bool) -> float:
    return softplus(-margin if safe else margin) + softplus(LOSS["anchor_margin"] - margin if safe else LOSS["anchor_margin"] + margin)


def pair_loss(safe_margin: float, risky_margin: float) -> float:
    rows = (row_loss(safe_margin, True) + row_loss(risky_margin, False)) / 2.0
    return rows + LOSS["pair_weight"] * softplus(LOSS["pair_margin"] + risky_margin - safe_margin)


def row_derivative(margin: float, safe: bool) -> float:
    if safe:
        return sigmoid(margin) - 1.0 - sigmoid(LOSS["anchor_margin"] - margin)
    return sigmoid(margin) + sigmoid(LOSS["anchor_margin"] + margin)


def pair_derivatives(safe_margin: float, risky_margin: float) -> tuple[float, float]:
    pair = LOSS["pair_weight"] * sigmoid(LOSS["pair_margin"] + risky_margin - safe_margin)
    return row_derivative(safe_margin, True) / 2.0 - pair, row_derivative(risky_margin, False) / 2.0 + pair


def read_guardrail_plan(path: Path, pair_sha256: str, content: bytes | None = None, family_sha256: str | None = None) -> dict[str, Any]:
    """Validate the unchanged admitted symmetric-objective document, not older arms."""
    plan = json.loads(content if content is not None else path.read_bytes())
    expected_keys = {"version", "purpose", "arm", "objective", "pair_manifest_sha256", "family_manifest_sha256", "loss", "sampler", "steps", "cutoff_status", "validation_rows_passed_to_training", "test_rows_passed_to_training"}
    if (not isinstance(plan, dict) or set(plan) != expected_keys
            or plan.get("version") != 2 or type(plan["version"]) is not int
            or plan.get("purpose") != "candidate9_train_only" or plan.get("arm") != "B"
            or plan.get("objective") != "guardrail_train_balanced_symmetric_v1"
            or plan.get("pair_manifest_sha256") != pair_sha256
            or plan.get("family_manifest_sha256") != family_sha256
            or plan.get("steps") != 256 or type(plan["steps"]) is not int
            or plan.get("cutoff_status") != "unset_requires_c9_train_cal_hard_veto_before_valid"
            or type(plan.get("validation_rows_passed_to_training")) is not int or plan["validation_rows_passed_to_training"] != 0
            or type(plan.get("test_rows_passed_to_training")) is not int or plan["test_rows_passed_to_training"] != 0
            or plan.get("loss") != LOSS or plan.get("sampler") != SOURCE_SAMPLER):
        raise ValueError("Frozen C11 source objective or TRAIN-only boundary changed")
    return plan

BASE_HASHES = {
    "model.safetensors": "3d4ef8d71c14db7e448a09ebe891cfb6bf32c57a9b44499ae0d1c098e48516b6",
    "config.json": "19cb5d28c97778271ba2b3c3df47bf76bdd6706724777a2318b3522230afe91e",
    "tokenizer.json": "4667f2089529e8e7657cfb6d1c19910ae71ff5f28aa7ab2ff2763330affad795",
}


TRAIN_SHA256 = "8c6d83095fa9a4215e060f54b24c2116deb2c7355377f56d800de8540b0ab8e3"


PAIR_SHA256 = "343ed1062e590fca8938099dc058074bea3f9f74d6118efc9df5b9ead35a4773"


FAMILY_SHA256 = "51062c174bfa28d798ca9eb338441e3d03ed73685b1f4ec707af20c41d8dcf13"


PLAN_SHA256 = "a1fbaaa262fa2d103c8ac9771ba1d9db774e7a90be5336cec3665f6b22dd3da9"



def validate_final_memory(plan, receipt, exit_receipt, memory, launch, journal, guardian, checkpoint_exit):
    if (plan.get("experiment") != "c11" or plan.get("steps") != 1024
            or plan.get("campaign_steps") != 1024 or plan.get("checkpoint_step") != 1024
            or receipt.get("checkpoint_step") != 1024 or memory.get("reason") != "worker_exit"
            or exit_receipt.get("ok") is not True or exit_receipt.get("steps_completed") != 1024
            or type(exit_receipt.get("elapsed_seconds")) not in (int, float)
            or not math.isfinite(exit_receipt["elapsed_seconds"]) or exit_receipt["elapsed_seconds"] <= 0
            or not isinstance(checkpoint_exit, dict) or checkpoint_exit.get("ok") is not True
            or checkpoint_exit.get("steps_completed") != 1024):
        raise ValueError("C11 worker_exit requires the genuine completed final1024 campaign and checkpoint exits")
    completed = checkpoint_exit.get("completed_time_unix")
    if type(completed) not in (int, float) or not math.isfinite(completed):
        raise ValueError("C11 final checkpoint completion time is missing")
    if any(not isinstance(raw, bytes) or not raw.endswith(b"\n") for raw in (journal, guardian)):
        raise ValueError("C11 final memory and guardian journals require complete raw lines")
    rows, guard_rows = ([json.loads(line) for line in raw.splitlines()] for raw in (journal, guardian))
    if len(rows) < 2 or memory.get("samples") != len(rows) or memory.get("sampling_interval_seconds") != 2.0:
        raise ValueError("C11 final memory sample inventory differs")
    root, inputs = Path(launch.get("run_root", "")), Path(launch.get("inputs", ""))
    if not root.is_absolute() or not inputs.is_absolute():
        raise ValueError("C11 launch command roots missing")
    code, run = inputs / "code", root / "run"
    commands = [launch.get(key) for key in ("worker_command", "watchdog_command")]
    if any(not isinstance(command, list) or len(command) < 2
           or any(not isinstance(arg, str) for arg in command) for command in commands):
        raise ValueError("C11 launch commands missing")
    worker_command, monitor_command = commands
    python = worker_command[0]
    if not Path(python).is_absolute() or monitor_command[0] != python:
        raise ValueError("C11 process executable identity changed")
    expected_worker = [python, str(code / "campaign.py"),
        "--campaign", str(code / "recipe.json"), "--campaign-sha256", plan["campaign_sha256"], "--mode", "train",
        "--base", str(inputs / "base"), "--train", str(inputs / "fit/prepared-train.jsonl"),
        "--pairs", str(inputs / "fit/pairs.json"), "--pairs-sha256", PAIR_SHA256,
        "--families", str(inputs / "fit/families.json"), "--families-sha256", FAMILY_SHA256,
        "--plan", str(code / "objective.json"), "--plan-sha256", PLAN_SHA256,
        "--output", str(run), "--steps", "1024", "--budget-bytes", "8000000000",
        "--allocator-cap-bytes", "6500000000"]
    adapter_tag = monitor_command[monitor_command.index("--adapter-tag") + 1] if monitor_command.count("--adapter-tag") == 1 and monitor_command.index("--adapter-tag") + 1 < len(monitor_command) else None
    expected_monitor = [python, str(code / "memory_monitor.py"), "--pid-file", str(root / "worker.pid"),
        "--worker", str(code / "campaign.py"), "--run-dir", str(run), "--output", str(root / "memory.jsonl"),
        "--adapter-tag", adapter_tag, "--baseline-dedicated-bytes", str(launch.get("baseline_dedicated_bytes")),
        "--baseline-shared-bytes", str(launch.get("baseline_shared_bytes")), "--hard-budget-bytes", "8000000000",
        "--stop-dedicated-delta-bytes", "7500000000", "--shared-growth-limit-bytes", "128000000",
        "--stop-total-dedicated-bytes", "16000000000", "--interval-seconds", "2"]
    if worker_command != expected_worker or monitor_command != expected_monitor or not adapter_tag:
        raise ValueError("C11 worker/watchdog command paths or budgets changed")
    for key, value in (("hard_budget_bytes", 8_000_000_000), ("stop_dedicated_delta_bytes", 7_500_000_000),
                       ("shared_growth_limit_bytes", 128_000_000), ("stop_total_dedicated_bytes", 16_000_000_000)):
        if launch.get(key) != value or memory.get(key) != value:
            raise ValueError("C11 final memory stop contract changed")
    if plan.get("budget_bytes") != 8_000_000_000 or plan.get("allocator_cap_bytes") != 6_500_000_000 or launch.get("allocator_cap_bytes") != 6_500_000_000:
        raise ValueError("C11 final allocator budget changed")
    before, after = receipt.get("pre_step_placement"), receipt.get("post_step_placement")
    peak = receipt.get("memory", {}).get("peak_reserved_bytes")
    if (before != {"parameters": 444, "buffers": 5, "gradients": 104}
            or after != {"parameters": 444, "buffers": 5, "gradients": 0, "optimizer_tensors": 208}
            or type(peak) is not int or not 0 < peak <= 6_500_000_000):
        raise ValueError("C11 final CUDA placement or allocator peak changed")
    baseline_dedicated, baseline_shared = (launch.get(key) for key in ("baseline_dedicated_bytes", "baseline_shared_bytes"))
    if any(type(value) is not int or value < 0 for value in (baseline_dedicated, baseline_shared)):
        raise ValueError("C11 final memory baselines missing")
    times, elapsed_times, peaks = [], [], {"peak_total_dedicated_bytes": 0, "peak_dedicated_delta_bytes": 0, "peak_shared_delta_bytes": 0}
    for row in rows:
        if not isinstance(row, dict) or "monitor_error" in row:
            raise ValueError("C11 final journal contains a monitor error")
        stamp, elapsed = row.get("time_unix"), row.get("elapsed_seconds")
        if (any(type(value) not in (int, float) or not math.isfinite(value) for value in (stamp, elapsed))
                or elapsed < 0 or any(type(row.get(key)) is not int or row[key] < 0 for key in (
                    "dedicated_bytes", "shared_bytes", "dedicated_delta_bytes", "shared_delta_bytes"))
                or row["dedicated_delta_bytes"] != max(0, row["dedicated_bytes"] - baseline_dedicated)
                or row["shared_delta_bytes"] != max(0, row["shared_bytes"] - baseline_shared)):
            raise ValueError("C11 final memory counter, clock, or baseline delta changed")
        times.append(stamp); elapsed_times.append(elapsed)
        for key, value in (("peak_total_dedicated_bytes", row["dedicated_bytes"]),
                           ("peak_dedicated_delta_bytes", row["dedicated_delta_bytes"]),
                           ("peak_shared_delta_bytes", row["shared_delta_bytes"])):
            peaks[key] = max(peaks[key], value)
    if (any(a >= b for a, b in zip(times, times[1:])) or any(a >= b for a, b in zip(elapsed_times, elapsed_times[1:]))
            or any(memory.get(key) != value for key, value in peaks.items())
            or not 0 < peaks["peak_total_dedicated_bytes"] < 16_000_000_000
            or peaks["peak_dedicated_delta_bytes"] >= 7_500_000_000 or peaks["peak_shared_delta_bytes"] >= 128_000_000):
        raise ValueError("C11 final journal ordering, recomputed peaks, or memory limits changed")
    if (len(guard_rows) < 3 or any(not isinstance(row, dict) for row in guard_rows)
            or guard_rows[0].get("status") != "watching" or guard_rows[-1].get("status") != "worker_exit"
            or any(row.get("status") != "healthy" for row in guard_rows[1:-1])):
        raise ValueError("C11 guardian requires one watching identity and one successful final worker_exit")
    watching, terminal = guard_rows[0], guard_rows[-1]
    if (any(type(row.get(key)) is not int or row[key] <= 0 for row, key in (
                (memory, "worker_pid"), (watching, "worker_pid"), (watching, "watchdog_pid"), (terminal, "worker_pid")))
            or any(type(launch.get(key)) is not int or launch[key] <= 0 for key in ("worker_pid", "watchdog_pid", "worker_start_ticks", "watchdog_start_ticks"))
            or launch["worker_pid"] == launch["watchdog_pid"] or memory.get("worker_pid") != launch["worker_pid"]
            or watching.get("worker_pid") != launch["worker_pid"] or terminal.get("worker_pid") != launch["worker_pid"]
            or watching.get("watchdog_pid") != launch["watchdog_pid"]
            or watching.get("worker_start_ticks") != launch.get("worker_start_ticks")
            or watching.get("watchdog_start_ticks") != launch.get("watchdog_start_ticks")
            or any(type(watching.get(key)) is not int or watching[key] <= 0 for key in ("worker_start_ticks", "watchdog_start_ticks"))):
        raise ValueError("C11 guardian PID or process birth identity changed")
    guard_times = [row.get("time_unix") for row in guard_rows]
    try:
        started_at = datetime.fromisoformat(launch["started_at"])
        if (not launch["started_at"].endswith("+00:00") or started_at.utcoffset() is None
                or started_at.utcoffset().total_seconds() != 0):
            raise ValueError("Expected frozen producer UTC timestamp")
        started = started_at.timestamp()
    except (KeyError, TypeError, ValueError):
        raise ValueError("C11 launch start time missing") from None
    if (any(type(value) not in (int, float) or not math.isfinite(value) for value in guard_times)
            or any(a >= b for a, b in zip(guard_times, guard_times[1:]))
            or not started <= guard_times[0] <= completed <= guard_times[-1] or times[0] > completed):
        raise ValueError("C11 final checkpoint completion is not covered by guardian identity")
    observed, previous_sample = 0, None
    row_identities = {json.dumps(row, sort_keys=True, separators=(",", ":")) for row in rows}
    for record in guard_rows[1:-1]:
        sample = record.get("sample")
        if sample is None and record["time_unix"] < times[0]:
            continue
        if (not isinstance(sample, dict) or json.dumps(sample, sort_keys=True, separators=(",", ":")) not in row_identities or sample["time_unix"] > record["time_unix"]
                or record["time_unix"] - sample["time_unix"] >= 30
                or (previous_sample is not None and (sample["time_unix"] < previous_sample["time_unix"]
                    or sample["elapsed_seconds"] < previous_sample["elapsed_seconds"]
                    or ((sample["time_unix"] > previous_sample["time_unix"]) != (sample["elapsed_seconds"] > previous_sample["elapsed_seconds"]))))
                or type(record.get("journalAgeSeconds")) not in (int, float)
                or not math.isfinite(record["journalAgeSeconds"]) or not 0 <= record["journalAgeSeconds"] < 30):
            raise ValueError("C11 guardian healthy observation does not match the genuine raw journal")
        previous_sample = sample
        observed += 1
    if not observed:
        raise ValueError("C11 guardian has no genuine sampled healthy observation")
