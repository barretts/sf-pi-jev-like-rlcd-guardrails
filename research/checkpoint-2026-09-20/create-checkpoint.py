#!/usr/bin/env python3
"""Preserve local research bytes without modifying their original locations."""

import argparse
import gzip
import hashlib
import io
import json
import pathlib
import tarfile


SOURCE_SUFFIXES = {
    ".cpp", ".h", ".hpp", ".c", ".mjs", ".js", ".ts", ".py", ".md",
    ".in", ".patch", ".freeze", ".jinja", ".sh", ".toml", ".yaml", ".yml",
}
EVIDENCE_SUFFIXES = {".json", ".jsonl", ".log", ".txt", ".sha256"}
MAX_PART_BYTES = 64 * 1024 * 1024


def digest(data):
    return hashlib.sha256(data).hexdigest()


def archive_part(destination, paths, repo):
    entries = []
    with destination.open("xb") as output:
        with gzip.GzipFile(filename="", mode="wb", fileobj=output, mtime=0) as compressed:
            with tarfile.open(fileobj=compressed, mode="w|", format=tarfile.PAX_FORMAT) as archive:
                for path in paths:
                    data = path.read_bytes()
                    relative = path.relative_to(repo).as_posix()
                    info = tarfile.TarInfo(relative)
                    info.size = len(data)
                    info.mode = 0o755 if path.stat().st_mode & 0o111 else 0o644
                    info.mtime = 0
                    archive.addfile(info, io.BytesIO(data))
                    entries.append({"path": relative, "bytes": len(data), "sha256": digest(data)})
    data = destination.read_bytes()
    if len(data) >= 90 * 1024 * 1024:
        raise ValueError("Checkpoint part exceeds its Git delivery bound")
    return {
        "archive": destination.name,
        "bytes": len(data),
        "sha256": digest(data),
        "files": entries,
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--repo", type=pathlib.Path, required=True)
    parser.add_argument("--output", type=pathlib.Path, required=True)
    args = parser.parse_args()
    repo = args.repo.resolve()
    output = args.output.resolve()
    source = repo / ".build/improvement-experiments"
    groups = {"source": [], "evidence": [], "adapters": []}
    excluded = []
    for path in sorted(source.rglob("*")):
        if path.is_symlink():
            excluded.append({"path": path.relative_to(repo).as_posix(), "reason": "symlink"})
            continue
        if not path.is_file():
            continue
        relative = path.relative_to(repo).as_posix()
        size = path.stat().st_size
        if "fused" in path.relative_to(source).parts:
            reason = "generated fused-model directory; identities remain in run reports"
        elif path.name == "adapters.safetensors" and path.parent.name == "adapter" and size < 16 * 1024 * 1024:
            groups["adapters"].append(path)
            continue
        elif path.suffix in SOURCE_SUFFIXES:
            groups["source"].append(path)
            continue
        elif path.suffix in EVIDENCE_SUFFIXES:
            groups["evidence"].append(path)
            continue
        else:
            reason = "compiled binary, full model artifact, tokenizer binary, bytecode, or runtime lock"
        excluded.append({"path": relative, "bytes": size, "reason": reason})

    output.mkdir(parents=True, exist_ok=True)
    manifest = {"schema_version": 1, "source_directory": ".build/improvement-experiments", "archives": [], "excluded": excluded}
    for name, paths in groups.items():
        parts = []
        current = []
        current_size = 0
        for path in paths:
            size = path.stat().st_size
            if current and current_size + size > MAX_PART_BYTES:
                parts.append(current)
                current = []
                current_size = 0
            current.append(path)
            current_size += size
        if current:
            parts.append(current)
        for index, part in enumerate(parts, 1):
            destination = output / f"{name}-{index:02d}.tar.gz"
            manifest["archives"].append(archive_part(destination, part, repo))

    manifest_path = output / "manifest.json"
    with manifest_path.open("x") as target:
        json.dump(manifest, target, indent=2)
        target.write("\n")
    print(json.dumps({"archives": len(manifest["archives"]), "included_files": sum(len(a["files"]) for a in manifest["archives"]), "archive_bytes": sum(a["bytes"] for a in manifest["archives"]), "excluded_files": len(excluded)}))


if __name__ == "__main__":
    main()
