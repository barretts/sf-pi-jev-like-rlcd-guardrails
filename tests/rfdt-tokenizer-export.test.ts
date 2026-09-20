import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const workerPath = fileURLToPath(new URL("../rfdt/worker.py", import.meta.url));
const setup = String.raw`
import copy, importlib.util, json, tempfile
from pathlib import Path
import sys
spec = importlib.util.spec_from_file_location("rfdt_worker", sys.argv[1])
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)
temporary = tempfile.TemporaryDirectory(prefix="rfdt-tokenizer-fixture-")
root = Path(temporary.name)
source, output = root / "source", root / "export"
source.mkdir()
output.mkdir()
placeholder = "<image_soft_token>"
vocab = {"<pad>": 0, "<bos>": 1, "A": 2, "B": 3}
kept = {"id": 1, "content": "<bos>", "special": True, "normalized": False}
tokenizer = {
    "model": {"type": "BPE", "vocab": vocab, "merges": []},
    "added_tokens": [kept, {"id": 4, "content": placeholder, "special": True}],
    "post_processor": {"special_tokens": {"<bos>": {"id": "<bos>", "ids": [1], "tokens": ["<bos>"]}}},
}
config = {
    "add_bos_token": True,
    "add_eos_token": False,
    "mask_token": None,
    "bos_token": "<bos>",
    "added_tokens_decoder": {"1": {"content": "<bos>", "special": True, "normalized": False}, "4": {"content": placeholder, "special": True}},
    "image_token": placeholder,
    "image_token_id": 4,
    "extra_special_tokens": {"kept_token": "A", "image_token": placeholder},
    "model_specific_special_tokens": {"kept_token": "B", "image_token": placeholder},
    "additional_special_tokens": ["B", placeholder],
    "chat_template": "original {{ messages }}",
}
added = {"A": 2, placeholder: 4}
special = {"bos_token": "<bos>", "image_token": placeholder, "additional_special_tokens": ["B", placeholder]}
def save_source():
    for name, document in [("tokenizer.json", tokenizer), ("tokenizer_config.json", config), ("added_tokens.json", added), ("special_tokens_map.json", special), ("config.json", {"vocab_size": 4})]:
        (source / name).write_text(json.dumps(document))
    (source / "tokenizer.model").write_bytes(b"original binary tokenizer fixture")
save_source()
(output / "tokenizer.json").write_text("serializer replaced the source")
(output / "chat_template.jinja").write_text("serializer-only template")
(output / "config.json").write_text(json.dumps({"vocab_size": 4}))
(output / "unrelated.bin").write_bytes(b"leave this file alone")
def rejected():
    before = (output / "tokenizer.json").read_bytes()
    try:
        worker.project_text_tokenizer(source, output, 4)
    except ValueError:
        assert (output / "tokenizer.json").read_bytes() == before
    else:
        raise AssertionError("Expected projection to fail closed")
`;

function runPython(body: string) {
  const result = spawnSync("python3", ["-c", setup + "\n" + body, workerPath], {
    encoding: "utf8",
    timeout: 20_000,
  });
  expect(result.error, result.stderr).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
}

describe("RFDT text tokenizer export projection without weights", () => {
  it("removes only the known image placeholder and restores original tokenizer identity", () => {
    runPython(String.raw`
original = {file.name: file.read_bytes() for file in source.iterdir()}
proof = worker.project_text_tokenizer(source, output, 4)
projected = json.loads((output / "tokenizer.json").read_text())
assert projected["model"] == tokenizer["model"]
assert projected["added_tokens"] == [kept]
export_config = json.loads((output / "tokenizer_config.json").read_text())
assert export_config["added_tokens_decoder"] == {"1": config["added_tokens_decoder"]["1"]}
assert export_config["extra_special_tokens"] == {"kept_token": "A"}
assert export_config["model_specific_special_tokens"] == {"kept_token": "B"}
assert export_config["additional_special_tokens"] == ["B"]
assert "image_token" not in export_config and "image_token_id" not in export_config
assert export_config["add_bos_token"] is True and export_config["add_eos_token"] is False
assert export_config["mask_token"] is None and export_config["chat_template"] == config["chat_template"]
assert json.loads((output / "added_tokens.json").read_text()) == {"A": 2}
assert json.loads((output / "special_tokens_map.json").read_text()) == {"bos_token": "<bos>", "additional_special_tokens": ["B"]}
assert (output / "tokenizer.model").read_bytes() == original["tokenizer.model"]
assert not (output / "chat_template.jinja").exists()
assert (output / "unrelated.bin").read_bytes() == b"leave this file alone"
assert {file.name: file.read_bytes() for file in source.iterdir()} == original
assert proof["model_vocab_size"] == 4
assert proof["removed_special_tokens"][0]["id"] == 4
assert proof["removed_special_tokens"][0]["content"] == placeholder
assert proof["source_model_config_sha256"] == worker.sha256(source / "config.json")
assert all(checksum == worker.sha256(output / name) for name, checksum in proof["export_files"].items())
assert proof["source_files"]["tokenizer.model"] == proof["export_files"]["tokenizer.model"]
`);
  });

  it.each([
    [
      "tokenizer added token",
      "tokenizer['added_tokens'].append({'id': 5, 'content': '<unexpected>'})",
    ],
    [
      "configuration decoder",
      "config['added_tokens_decoder']['5'] = {'content': '<unexpected>'}",
    ],
    ["added_tokens sidecar", "added['<unexpected>'] = 5"],
    [
      "postprocessor boundary ID",
      "tokenizer['post_processor']['special_tokens']['<bos>']['ids'] = [4]",
    ],
    [
      "unknown special declaration",
      "config['extra_special_tokens']['unknown_token'] = '<unexpected>'",
    ],
    ["image token ID", "config['image_token_id'] = 5"],
    ["exact token index key", "config['token_index'] = 4"],
  ])("rejects unknown overflow in %s", (_name, mutation) => {
    runPython(mutation + "\nsave_source()\nrejected()");
  });

  it.each(["True", "4.0", "'4'"])(
    "rejects malformed numeric token metadata %s",
    (value) => {
      runPython(
        `config['image_token_id'] = ${value}\nsave_source()\nrejected()`,
      );
    },
  );

  it.each([
    [
      "contradictory placeholder ID",
      "config['extra_special_tokens'] = {'image_token': {'content': placeholder, 'id': 2}}",
    ],
    [
      "ambiguous special map",
      "config['extra_special_tokens'] = {'content': placeholder, 'kept_token': 'A'}",
    ],
    ["conflicting decoder ID", "config['added_tokens_decoder']['1']['id'] = 2"],
    [
      "noncanonical decoder ID",
      "config['added_tokens_decoder']['04'] = config['added_tokens_decoder'].pop('4')",
    ],
    ["trained vocabulary gap", "tokenizer['model']['vocab']['B'] = 4"],
  ])("rejects %s", (_name, mutation) => {
    runPython(mutation + "\nsave_source()\nrejected()");
  });

  it("rejects duplicate raw JSON keys instead of silently replacing vocabulary", () => {
    runPython(String.raw`
(source / "tokenizer.json").write_text('{"model":{"vocab":{"A":0,"A":1}},"added_tokens":[]}')
rejected()
`);
  });

  it("copies an already clean text tokenizer without further derivation", () => {
    runPython(String.raw`
first = worker.project_text_tokenizer(source, output, 4)
next_output = root / "second-export"
second = worker.project_text_tokenizer(output, next_output, 4)
assert second["removed_special_tokens"] == []
assert second["model_vocab_sha256"] == first["model_vocab_sha256"]
assert second["source_files"] == second["export_files"]
`);
  });

  it("binds fusion to the exact prepared file and template with optional explicit data", () => {
    runPython(String.raw`
adapter = root / "run" / "adapter"
adapter.mkdir(parents=True)
rows = [{"id": "first", "group_id": "first", "split": "train", "prompt": "P", "prompt_token_ids": [1], "allowed_token_ids": [2, 3], "target_probabilities": [1, 0], "output_labels": ["A", "B"], "template_version": "v2"}]
data = adapter.parent / "train.jsonl"
data.write_text(json.dumps(rows[0]) + chr(10))
manifest = {"training_data_sha256": worker.sha256(data), "template_version": "v2"}
path, actual = worker.fusion_training_rows(adapter, manifest)
assert path == data and len(actual) == 1
assert worker.fusion_training_rows(adapter, manifest, str(data))[0] == data.resolve()
for invalid in [dict(manifest, training_data_sha256='0' * 64), dict(manifest, template_version='v1')]:
    try:
        worker.fusion_training_rows(adapter, invalid)
    except ValueError:
        pass
    else:
        raise AssertionError("Expected frozen data/template mismatch rejection")
args = worker.parser().parse_args(['fuse', '--adapter', str(adapter), '--output', str(root / 'fused'), '--data', str(data)])
assert args.data == str(data)
args = worker.parser().parse_args(['fuse', '--adapter', str(adapter), '--output', str(root / 'fused')])
assert args.data is None
`);
  });

  it("checks every prompt and answer boundary including the final row", () => {
    runPython(String.raw`
rows = [{"id": name, "prompt": name, "prompt_token_ids": [1], "allowed_token_ids": [2, 3], "output_labels": ['A', 'B'], "template_version": 'v2'} for name in ['first', 'last']]
class Tokenizer:
    def __init__(self):
        self.values = {name + suffix: tokens for name in ['first', 'last'] for suffix, tokens in [('', [1]), ('A', [1, 2]), ('B', [1, 3])]}
    def encode(self, text, add_special_tokens=False):
        assert add_special_tokens is False
        return self.values[text]
tokenizer = Tokenizer()
proof = worker.verify_prompt_parity(tokenizer, rows)
assert proof['rows_checked'] == 2 and proof['labels_checked'] == 4
for text in ['last', 'lastB']:
    tokenizer = Tokenizer()
    tokenizer.values[text] = [99]
    try:
        worker.verify_prompt_parity(tokenizer, rows)
    except ValueError:
        pass
    else:
        raise AssertionError('Expected late-row token/boundary mismatch rejection')
`);
  });
});
