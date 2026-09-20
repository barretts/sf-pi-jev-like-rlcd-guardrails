#!/usr/bin/env python3
"""Archive changed/new research bytes against the already delivered checkpoint."""
import argparse
import importlib.util
import json
import pathlib

parser = argparse.ArgumentParser()
parser.add_argument("--repo", type=pathlib.Path, required=True)
parser.add_argument("--output", type=pathlib.Path, required=True)
args = parser.parse_args()
repo = args.repo.resolve()
output = args.output.resolve()
base_path = repo / "research/checkpoint-2026-09-20/manifest.json"
spec = importlib.util.spec_from_file_location("checkpoint_helpers", base_path.parent / "create-checkpoint.py")
helpers = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helpers)
base_bytes = base_path.read_bytes()
base = json.loads(base_bytes)
previous = {ref["path"]: ref for archive in base["archives"] for ref in archive["files"]}
groups = {"source": [], "evidence": [], "adapters": []}
excluded = []
seen = set()
unchanged = 0
source = repo / ".build/improvement-experiments"
for path in sorted(source.rglob("*")):
    relative = path.relative_to(repo).as_posix()
    if path.is_symlink():
        excluded.append({"path": relative, "reason": "symlink"})
        continue
    if not path.is_file():
        continue
    size = path.stat().st_size
    if "fused" in path.relative_to(source).parts:
        kind = None
        reason = "generated fused-model directory; identities remain in run reports"
    elif path.name == "adapters.safetensors" and path.parent.name == "adapter" and size < 16 * 1024 * 1024:
        kind = "adapters"
    elif path.suffix in helpers.SOURCE_SUFFIXES:
        kind = "source"
    elif path.suffix in helpers.EVIDENCE_SUFFIXES:
        kind = "evidence"
    else:
        kind = None
        reason = "compiled binary, full model artifact, tokenizer binary, bytecode, or runtime lock"
    if kind is None:
        excluded.append({"path": relative, "bytes": size, "reason": reason})
        continue
    seen.add(relative)
    digest = helpers.digest(path.read_bytes())
    old = previous.get(relative)
    if old and old["bytes"] == size and old["sha256"] == digest:
        unchanged += 1
    else:
        groups[kind].append(path)

output.mkdir(parents=True, exist_ok=True)
manifest = {"schema_version": 1, "kind": "incremental_research_checkpoint", "source_directory": ".build/improvement-experiments",
            "base_manifest": base_path.relative_to(repo).as_posix(), "base_manifest_sha256": helpers.digest(base_bytes),
            "unchanged_files_in_base": unchanged, "archives": [], "excluded": excluded,
            "previously_included_paths_now_absent": sorted(set(previous) - seen)}
for name, paths in groups.items():
    parts = []
    current = []
    current_size = 0
    for path in paths:
        size = path.stat().st_size
        if current and current_size + size > helpers.MAX_PART_BYTES:
            parts.append(current)
            current = []
            current_size = 0
        current.append(path)
        current_size += size
    if current:
        parts.append(current)
    for index, part in enumerate(parts, 1):
        manifest["archives"].append(helpers.archive_part(output / f"{name}-{index:02d}.tar.gz", part, repo))
with (output / "manifest.json").open("x") as stream:
    json.dump(manifest, stream, indent=2)
    stream.write("\n")
print(json.dumps({"archives": len(manifest["archives"]), "changed_or_new_files": sum(len(a["files"]) for a in manifest["archives"]),
                  "archive_bytes": sum(a["bytes"] for a in manifest["archives"]), "unchanged_files_in_base": unchanged,
                  "previously_included_paths_now_absent": len(manifest["previously_included_paths_now_absent"])}))
