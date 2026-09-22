#!/usr/bin/env python3
"""Aggregate request-only collision screen; never prints case content or labels."""

import argparse
from collections import Counter
import hashlib
import json
import re
import shlex
import sys
from pathlib import Path
from urllib.parse import urlsplit


def canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def sha(value):
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def normalized_observations(raw, tool_input):
    if not isinstance(raw, dict):
        return {}
    if "org" in raw or "browserRef" in raw or "browserPage" in raw:
        return raw
    result = {}
    orgs = raw.get("orgs")
    if isinstance(orgs, list) and orgs and isinstance(orgs[0], dict):
        org = dict(orgs[0])
        alias = tool_input.get("target_org")
        if alias is None and isinstance(tool_input.get("command"), str):
            try:
                alias = flag_value(shlex.split(tool_input["command"].splitlines()[0]), "--target-org")
            except ValueError:
                pass
        if alias is not None:
            org["alias"] = alias
        result["org"] = org
    for key in ("browserRef", "browserPage"):
        if isinstance(raw.get(key), dict):
            result[key] = raw[key]
    return result


def request(row):
    if "operation" in row:
        return row.get("fixture", {}), row["operation"]
    state = row.get("request", {}).get("state", row) if isinstance(row.get("request"), dict) else row
    if not isinstance(state, dict):
        raise ValueError("unsupported request state")
    tool = state.get("toolName", state.get("tool"))
    tool_input = state.get("input", {})
    if not isinstance(tool_input, dict):
        raise ValueError("unsupported tool input")
    raw_facts = state.get("facts", row.get("facts", row.get("fixturePreconditions", [])))
    raw_obs = row.get("observations", state.get("observations", raw_facts))
    fixture = {"facts": raw_facts}
    observations = normalized_observations(raw_obs, tool_input)
    if observations:
        fixture["observations"] = observations
    if "policyBehaviors" in row:
        fixture["policyBehaviors"] = row["policyBehaviors"]
    if "cwd" in row:
        fixture["cwd"] = row["cwd"]
    return fixture, {"tool": tool, "input": tool_input}


def normalized_operation(operation):
    tool = operation.get("tool")
    raw = operation.get("input", {})
    value = json.loads(canonical(raw))
    if isinstance(value.get("command"), str):
        value["command"] = re.sub(r"\s+", " ", value["command"].strip())
    if isinstance(value.get("path"), str):
        value["path"] = re.sub(r"/+", "/", value["path"].strip())
    return {"tool": tool, "input": value}


def flag_value(words, flag):
    try:
        return words[words.index(flag) + 1]
    except (ValueError, IndexError):
        return None


def query_object(query):
    found = re.search(r"\bFROM\s+([A-Za-z_][A-Za-z_0-9]*)", query, re.IGNORECASE)
    return found.group(1).lower() if found else None


def normalized_query(query):
    text = re.sub(r"\s+", " ", query.strip()).lower()
    return re.sub(r"'(?:''|[^'])*'", "'?'", text)


def query_scope(query, inp):
    text = normalized_query(query)
    limit = re.search(r"\blimit\s+(\d+)", text)
    return {
        "object": query_object(query),
        "shape": text,
        "has_where": bool(re.search(r"\bwhere\b", text)),
        "limit": limit.group(1) if limit else None,
        "deleted_rows": bool(re.search(r"\ball\s+rows\b", text)) or inp.get("include_deleted") is True or inp.get("action") == "query.queryAll",
        "allow_unbounded": inp.get("allow_unbounded") is True,
    }


def normalized_rest_path(raw):
    text = str(raw or "").strip()
    parsed = urlsplit(text)
    path = parsed.path or text.split("?", 1)[0]
    return re.sub(r"/+", "/", path).rstrip("/") or "/"


def shell_effect(command):
    line = command.strip().splitlines()[0] if command.strip() else ""
    try:
        words = shlex.split(line)
    except ValueError:
        words = line.split()
    if not words:
        return "empty"
    if words[0] == "sf":
        lead = words[:4] if words[1:3] == ["project", "deploy"] or words[1:3] == ["agent", "preview"] else words[:3]
        return canonical({
            "lead": lead,
            "target_org": flag_value(words, "--target-org"),
            "source_dir": flag_value(words, "--source-dir"),
            "job_id": flag_value(words, "--job-id"),
            "sobject": flag_value(words, "--sobject"),
            "record_id": flag_value(words, "--record-id"),
            "query_scope": query_scope(flag_value(words, "--query") or "", {"include_deleted": "--all-rows" in words}),
            "authoring_bundle": flag_value(words, "--authoring-bundle"),
            "api_name": flag_value(words, "--api-name"),
            "session_id": flag_value(words, "--session-id"),
            "flags": [flag for flag in ("--dry-run", "--check-only", "--all-rows", "--use-live-actions", "--simulate-actions") if flag in words],
        })
    if words[0] in ("git", "find", "rm", "curl", "wget", "python3", "bash", "sh", "zsh"):
        lead = words[:3]
    else:
        lead = words[:2]
    suffix = "heredoc" if "<<" in command else "redirect" if ">" in command else "plain"
    target = re.search(r">>?(?:\s*)([^\s;]+)", line)
    return canonical({"lead": lead, "form": suffix, "target": target.group(1) if target else None})


def same_effect(fixture, operation):
    tool = operation.get("tool", "")
    inp = operation.get("input", {})
    observed = fixture.get("observations", {}) if isinstance(fixture, dict) else {}
    if tool in ("bash", "herdr_pane"):
        return canonical({"tool_family": "shell", "effect": shell_effect(inp.get("command", "")), "org_type": observed.get("org", {}).get("type")})
    if tool in ("read", "write", "edit", "grep", "find", "ls"):
        path = inp.get("path", "")
        basename = str(path).rstrip("/").split("/")[-1]
        return canonical({"tool": tool, "basename": basename})
    if tool in ("sf_browser_click", "sf_browser_press"):
        ref = observed.get("browserRef", {})
        page = observed.get("browserPage", {})
        return canonical({"tool": tool, "role": ref.get("role"), "label": ref.get("label"), "status": ref.get("status"), "page": page.get("url"), "key": inp.get("key"), "mutation": inp.get("mutation") is True})
    params = inp.get("params", {}) if isinstance(inp.get("params"), dict) else {}
    return canonical({
        "tool": tool,
        "action": inp.get("action"),
        "operation": inp.get("operation"),
        "target_org": inp.get("target_org"),
        "object": inp.get("object") or query_object(str(inp.get("query", ""))),
        "query_scope": query_scope(str(inp.get("query", "")), inp) if tool == "sf_soql" and inp.get("query") else None,
        "agent_api_name": inp.get("agent_api_name"),
        "canvas_id": inp.get("canvas_id"),
        "channel_id": inp.get("channel_id"),
        "section_id": inp.get("section_id"),
        "output_file": inp.get("output_file"),
        "segment_id": params.get("segmentId"),
        "rest_method": str(params.get("method", "")).upper() if tool == "data360_api" else None,
        "rest_path": normalized_rest_path(params.get("path")) if tool == "data360_api" else None,
        "dry_run": inp.get("dry_run") is True,
        "allow_confirmed": inp.get("allow_confirmed") is True,
    })


def parse_rows(text):
    try:
        data = json.loads(text)
    except json.JSONDecodeError:
        data = [json.loads(line) for line in text.splitlines() if line.strip()]
    if isinstance(data, dict):
        if "request" in data or "operation" in data or "toolName" in data:
            rows = [data]
        else:
            rows = data.get("cases", data.get("rows", data.get("items", data)))
    else:
        rows = data
    if not isinstance(rows, list):
        raise ValueError("unsupported dataset container")
    return rows


def load(path, split=None):
    rows = parse_rows(Path(path).read_text())
    if split is not None:
        rows = [row for row in rows if row.get("split") == split]
    output = {"exact": Counter(), "canonical": Counter(), "same_effect": Counter(), "groups": Counter(), "templates": Counter()}
    for row in rows:
        fixture, operation = request(row)
        if not isinstance(fixture, dict) or not isinstance(operation, dict):
            raise ValueError("unsupported request shape")
        output["exact"][sha(canonical({"fixture": fixture, "operation": operation}))] += 1
        output["canonical"][sha(canonical(normalized_operation(operation)))] += 1
        output["same_effect"][sha(same_effect(fixture, operation))] += 1
        group = row.get("group_id", row.get("group", row.get("groupId")))
        template = row.get("template_id", row.get("template", row.get("templateId")))
        if group:
            output["groups"][sha(str(group))] += 1
        if template:
            output["templates"][sha(str(template))] += 1
    return len(rows), output


def merge_counts(left, right):
    count_a, fingerprints_a = left
    count_b, fingerprints_b = right
    merged = {key: fingerprints_a[key] + fingerprints_b[key] for key in fingerprints_a}
    return count_a + count_b, merged


def self_test():
    operation = {"tool": "bash", "input": {"command": "sf project deploy start --source-dir force-app --target-org prod-hub"}}
    c6 = {"fixture": {"facts": [], "observations": {"org": {"alias": "prod-hub", "type": "production", "guessed": False}}}, "operation": operation}
    supplement = {"toolName": "bash", "input": operation["input"], "observations": {"org": {"alias": "prod-hub", "type": "production", "guessed": False}}}
    rfdt = {"request": {"state": {"toolName": "bash", "input": operation["input"], "facts": {"orgs": [{"type": "production", "guessed": False}]}}}}
    for row in (c6, supplement, rfdt):
        fixture, parsed_operation = request(row)
        assert parsed_operation == operation
        assert fixture["observations"]["org"]["type"] == "production"
        assert same_effect(fixture, parsed_operation) == same_effect(c6["fixture"], operation)
    assert len(parse_rows(json.dumps(rfdt) + "\n" + json.dumps(supplement) + "\n")) == 2
    assert len(parse_rows(json.dumps(rfdt))) == 1
    assert query_scope("SELECT Id FROM Contact LIMIT 5", {})["object"] == "contact"
    assert normalized_rest_path("/services/data/v66.0/ssot/segments//A/?x=1") == "/services/data/v66.0/ssot/segments/A"
    print(json.dumps({"self_test": "passed"}, sort_keys=True))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--left")
    parser.add_argument("--left-append", action="append", default=[])
    parser.add_argument("--left-split", choices=["train"])
    parser.add_argument("--right")
    parser.add_argument("--right-manifest")
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args()
    if args.self_test:
        self_test()
        return
    if not args.left or not args.right:
        raise ValueError("both dataset paths are required")
    if args.right_manifest:
        manifest = json.loads(Path(args.right_manifest).read_text())
        actual = hashlib.sha256(Path(args.right).read_bytes()).hexdigest()
        if actual != manifest.get("data_sha256", manifest.get("file_sha256")):
            raise ValueError("sealed right-hand file hash mismatch")
    left_count, left = load(args.left, args.left_split)
    for append_path in args.left_append:
        left_count, left = merge_counts(
            (left_count, left), load(append_path, args.left_split)
        )
    right_count, right = load(args.right)
    counts = {}
    for key in ("exact", "canonical", "groups", "templates", "same_effect"):
        overlap = left[key].keys() & right[key].keys()
        counts[key] = {
            "shared_keys": len(overlap),
            "cross_pairs": sum(left[key][item] * right[key][item] for item in overlap),
        }
    print(json.dumps({"left_count": left_count, "right_count": right_count, "collisions": counts}, sort_keys=True))


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(json.dumps({"screen_error": type(exc).__name__}), file=sys.stderr)
        raise SystemExit(1)
