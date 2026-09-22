#!/usr/bin/env python3
"""Read-only, hash-pinned cross-split request overlap audit.

The output contains counts and case IDs only. It never prints operations,
fixtures, labels, prompts, or model results. Near-replay matches are candidates
for an independent human audit, not proof that two operations have equal effects.
"""

from __future__ import annotations

import argparse
from collections import defaultdict
from dataclasses import dataclass
from difflib import SequenceMatcher
import hashlib
import importlib.util
import json
from pathlib import Path
import re
import shlex
import subprocess
import sys
from urllib.parse import urlsplit


ROOT = Path(__file__).resolve().parents[1]
SCREEN_PATH = ROOT / "blind-c6-20260922" / "screen-c6.py"
MODULE_SPEC = importlib.util.spec_from_file_location("guardrail_existing_screen", SCREEN_PATH)
if MODULE_SPEC is None or MODULE_SPEC.loader is None:
    raise RuntimeError("existing request screen unavailable")
SCREEN = importlib.util.module_from_spec(MODULE_SPEC)
MODULE_SPEC.loader.exec_module(SCREEN)
HEX64 = re.compile(r"^[0-9a-f]{64}$")


@dataclass(frozen=True)
class Source:
    name: str
    path: Path
    sha256: str
    splits: frozenset[str] | None


@dataclass(frozen=True)
class Case:
    source: str
    id: str
    group: str | None
    template: str | None
    original_operation_hash: str
    normalized_operation_hash: str
    effect_hash: str
    family: str
    semantic_text: str


def parse_source(raw: str) -> Source:
    label, separator, path_hash = raw.partition("=")
    if not separator or not label or not path_hash:
        raise ValueError("source syntax must be NAME[:SPLIT,...]=PATH@SHA256")
    name, split_separator, split_names = label.partition(":")
    if not re.fullmatch(r"[A-Za-z0-9._-]+", name):
        raise ValueError("invalid source name")
    splits = frozenset(split_names.split(",")) if split_separator else None
    if splits is not None and (not splits or "" in splits):
        raise ValueError("invalid split selector")
    path_text, at, digest = path_hash.rpartition("@")
    if not at or not HEX64.fullmatch(digest):
        raise ValueError("source requires lowercase SHA-256 pin")
    return Source(name, Path(path_text), digest, splits)


def shell_words(command: str) -> list[str]:
    try:
        return shlex.split(command.splitlines()[0]) if command else []
    except ValueError:
        return command.splitlines()[0].split() if command else []


def case_family(tool: str, tool_input: dict) -> str:
    if tool in ("bash", "herdr_pane"):
        command = tool_input.get("command", "")
        words = shell_words(command)
        if not words:
            return "shell-empty"
        if words[0] in ("curl", "wget"):
            url = next((word for word in words if word.startswith(("https://", "http://"))), "")
            parsed = urlsplit(url)
            if parsed.hostname == "slack.com" and parsed.path.startswith("/api/canvases"):
                return "slack-canvas"
            if "/ssot/" in parsed.path:
                return "data360-rest"
            return "shell-http"
        if words[0] == "sf":
            if words[1:3] == ["data", "query"]:
                return "salesforce-soql"
            if words[1:3] == ["apex", "run"]:
                return "salesforce-apex"
            if words[1:4] == ["api", "request", "rest"] and "/ssot/" in command:
                return "data360-rest"
            return "shell-sf:" + ":".join(words[1:3])
        return "shell:" + words[0]
    if tool == "sf_soql":
        return "salesforce-soql"
    if tool == "sf_apex":
        return "salesforce-apex"
    if tool == "data360_api":
        return "data360-rest"
    if tool == "slack_canvas":
        return "slack-canvas"
    return tool


def semantic_text(operation: dict, family: str) -> str:
    inp = operation["input"]
    tool = operation["tool"]
    shell = tool in ("bash", "herdr_pane")
    command = inp.get("command", "") if shell else ""
    words = shell_words(command) if shell else []
    if family == "salesforce-soql":
        query = SCREEN.flag_value(words, "--query") if shell else inp.get("query", "")
        target_org = SCREEN.flag_value(words, "--target-org") if shell else inp.get("target_org")
        return SCREEN.canonical({
            "query": SCREEN.normalized_query(query or ""),
            "target_org": target_org,
            "all_rows": "--all-rows" in words if shell else inp.get("include_deleted") is True,
        })
    if family == "data360-rest":
        params = inp.get("params", {}) if isinstance(inp.get("params"), dict) else {}
        if shell and words and words[0] in ("curl", "wget"):
            method = SCREEN.flag_value(words, "-X") or SCREEN.flag_value(words, "--request") or "GET"
            url = next((word for word in words if word.startswith(("https://", "http://"))), "")
        elif shell:
            method = SCREEN.flag_value(words, "--method") or "GET"
            url = SCREEN.flag_value(words, "--url") or ""
        else:
            method = params.get("method", inp.get("method", "GET"))
            url = params.get("path", inp.get("path", ""))
        return SCREEN.canonical({"method": str(method).upper(), "path": SCREEN.normalized_rest_path(url)})
    if family == "slack-canvas":
        if shell:
            url = next((word for word in words if word.startswith(("https://", "http://"))), "")
            action = urlsplit(url).path.removeprefix("/api/")
        else:
            action = inp.get("operation", inp.get("action", ""))
        return SCREEN.canonical({"action": action, "canvas_id": inp.get("canvas_id")})
    if family == "salesforce-apex":
        if shell:
            body = "\n".join(command.splitlines()[1:])
            if body.strip():
                return re.sub(r"\s+", " ", body.strip()).lower()
            return SCREEN.shell_effect(command)
        body = inp.get("code", inp.get("apex", inp.get("body", "")))
        return SCREEN.canonical({
            "action": inp.get("action", inp.get("operation")),
            "target_org": inp.get("target_org"),
            "body": re.sub(r"\s+", " ", str(body).strip()).lower(),
        })
    if family.startswith("shell"):
        if family == "shell-http":
            return SCREEN.shell_http_effect(words, command)
        if family.startswith("shell-sf:"):
            return SCREEN.shell_effect(command)
        return re.sub(r"\s+", " ", command.strip()).lower()
    return SCREEN.canonical(SCREEN.normalized_operation(operation)).lower()


def load_source(source: Source) -> list[Case]:
    raw = source.path.read_bytes()
    if hashlib.sha256(raw).hexdigest() != source.sha256:
        raise ValueError("source hash mismatch")
    rows = SCREEN.parse_rows(raw.decode("utf-8"))
    cases = []
    for row in rows:
        if source.splits is not None and row.get("split") not in source.splits:
            continue
        case_id = row.get("id")
        if not isinstance(case_id, str) or not case_id:
            raise ValueError("case ID missing")
        fixture, operation = SCREEN.request(row)
        tool = operation.get("tool") if isinstance(operation, dict) else None
        inp = operation.get("input") if isinstance(operation, dict) else None
        if not isinstance(tool, str) or not tool or not isinstance(inp, dict):
            raise ValueError("case has no original tool operation")
        group = row.get("group_id", row.get("group", row.get("groupId")))
        template = row.get("template_id", row.get("template", row.get("templateId")))
        family = case_family(tool, inp)
        cases.append(Case(
            source=source.name,
            id=case_id,
            group=str(group) if group is not None else None,
            template=str(template) if template is not None else None,
            original_operation_hash=SCREEN.sha(SCREEN.canonical(operation)),
            normalized_operation_hash=SCREEN.sha(SCREEN.canonical(SCREEN.normalized_operation(operation))),
            effect_hash=SCREEN.sha(SCREEN.same_effect(fixture, operation)),
            family=family,
            semantic_text=semantic_text(operation, family),
        ))
    if not cases:
        raise ValueError("selected source contains no cases")
    return cases


def similarity(a: Case, b: Case) -> tuple[float, float]:
    if a.family != b.family:
        return 0.0, 0.0
    char_ratio = SequenceMatcher(None, a.semantic_text, b.semantic_text, autojunk=False).ratio()
    tokens_a = set(re.findall(r"[A-Za-z_][A-Za-z_0-9.:-]*|\d+", a.semantic_text))
    tokens_b = set(re.findall(r"[A-Za-z_][A-Za-z_0-9.:-]*|\d+", b.semantic_text))
    token_ratio = len(tokens_a & tokens_b) / len(tokens_a | tokens_b) if tokens_a | tokens_b else 1.0
    return char_ratio, token_ratio


def audit(left: list[Case], right: list[Case]) -> dict:
    matches = defaultdict(list)
    for a in left:
        for b in right:
            kinds = []
            if a.id == b.id:
                kinds.append("id")
            if a.group is not None and a.group == b.group:
                kinds.append("group")
            if a.template is not None and a.template == b.template:
                kinds.append("template")
            if a.original_operation_hash == b.original_operation_hash:
                kinds.append("exact_original_operation")
            if a.normalized_operation_hash == b.normalized_operation_hash:
                kinds.append("normalized_operation")
            if a.effect_hash == b.effect_hash:
                kinds.append("effect_signature")
            char_ratio, token_ratio = similarity(a, b)
            if char_ratio >= 0.88 or (char_ratio >= 0.80 and token_ratio >= 0.68):
                kinds.append("near_replay_candidate")
            for kind in kinds:
                entry = {"left": [a.source, a.id], "right": [b.source, b.id]}
                if kind == "near_replay_candidate":
                    entry["char_similarity"] = round(char_ratio, 3)
                    entry["token_overlap"] = round(token_ratio, 3)
                matches[kind].append(entry)
    keys = (
        "id", "group", "template", "exact_original_operation", "normalized_operation",
        "effect_signature", "near_replay_candidate",
    )
    return {
        "left_count": len(left),
        "right_count": len(right),
        "missing_metadata": {
            "left_group": sum(item.group is None for item in left),
            "left_template": sum(item.template is None for item in left),
            "right_group": sum(item.group is None for item in right),
            "right_template": sum(item.template is None for item in right),
        },
        "collisions": {key: {"pair_count": len(matches[key]), "pairs": matches[key]} for key in keys},
    }


def self_test() -> None:
    def synthetic(case_id: str, command: str, group: str) -> Case:
        operation = {"tool": "bash", "input": {"command": command}}
        family = case_family("bash", operation["input"])
        return Case("synthetic", case_id, group, case_id, SCREEN.sha(SCREEN.canonical(operation)),
                    SCREEN.sha(SCREEN.canonical(SCREEN.normalized_operation(operation))),
                    SCREEN.sha(SCREEN.same_effect({}, operation)), family, semantic_text(operation, family))
    left = [synthetic("A", "printf '%s\\n' 'rm harmless-a'", "G1")]
    right = [synthetic("B", "printf '%s\\n' 'rm harmless-b'", "G2")]
    result = audit(left, right)
    assert result["collisions"]["exact_original_operation"]["pair_count"] == 0
    assert result["collisions"]["effect_signature"]["pair_count"] == 1
    assert result["collisions"]["near_replay_candidate"]["pair_count"] == 1
    assert result["collisions"]["group"]["pair_count"] == 0
    cli_query = {"tool": "bash", "input": {"command": "sf data query --query 'SELECT Id FROM Account LIMIT 5' --target-org dev"}}
    direct_query = {"tool": "sf_soql", "input": {"query": "SELECT Id FROM Account LIMIT 5", "target_org": "dev"}}
    assert case_family("bash", cli_query["input"]) == case_family("sf_soql", direct_query["input"])
    assert semantic_text(cli_query, "salesforce-soql") == semantic_text(direct_query, "salesforce-soql")
    shell_rest = {"tool": "bash", "input": {"command": "sf api request rest --method DELETE --url /services/data/v66.0/ssot/data-streams/A --target-org dev"}}
    direct_rest = {"tool": "data360_api", "input": {"params": {"method": "DELETE", "path": "/services/data/v66.0/ssot/data-streams/A"}}}
    assert case_family("bash", shell_rest["input"]) == case_family("data360_api", direct_rest["input"])
    assert semantic_text(shell_rest, "data360-rest") == semantic_text(direct_rest, "data360-rest")
    apex_status = {"tool": "sf_apex", "input": {"action": "status", "target_org": "dev"}}
    apex_run = {"tool": "sf_apex", "input": {"action": "anon.run", "target_org": "dev"}}
    assert semantic_text(apex_status, "salesforce-apex") != semantic_text(apex_run, "salesforce-apex")
    try:
        parse_source("x=/tmp/a@" + "A" * 64)
    except ValueError:
        pass
    else:
        raise AssertionError("uppercase hash pin accepted")
    print(json.dumps({"self_test": "passed"}, sort_keys=True))


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--left", action="append", default=[], metavar="NAME[:SPLIT,...]=PATH@SHA256")
    parser.add_argument("--right", action="append", default=[], metavar="NAME[:SPLIT,...]=PATH@SHA256")
    parser.add_argument("--repo", type=Path, default=ROOT)
    parser.add_argument("--expected-head")
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args()
    if args.self_test:
        self_test()
        return
    if not args.left or not args.right:
        raise ValueError("left and right sources are required")
    if args.expected_head:
        actual_head = subprocess.check_output(["git", "-C", str(args.repo), "rev-parse", "HEAD"], text=True).strip()
        if actual_head != args.expected_head:
            raise ValueError("repository HEAD mismatch")
    left_sources = [parse_source(value) for value in args.left]
    right_sources = [parse_source(value) for value in args.right]
    names = [source.name for source in left_sources + right_sources]
    if len(set(names)) != len(names):
        raise ValueError("source names must be unique")
    left = [case for source in left_sources for case in load_source(source)]
    right = [case for source in right_sources for case in load_source(source)]
    result = audit(left, right)
    result["source_pins"] = {source.name: source.sha256 for source in left_sources + right_sources}
    print(json.dumps(result, sort_keys=True))


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(json.dumps({"audit_error": type(exc).__name__}), file=sys.stderr)
        raise SystemExit(1)
