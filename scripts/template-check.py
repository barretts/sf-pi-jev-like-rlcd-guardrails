"""Independent Jinja reference check after `npm run smoke` (requires jinja2)."""
import json
from pathlib import Path
from jinja2.sandbox import ImmutableSandboxedEnvironment
proof = json.loads((Path(__file__).resolve().parent.parent / '.build/template-proof.json').read_text())
env = ImmutableSandboxedEnvironment(trim_blocks=True, lstrip_blocks=True)
def fail(message):
    raise ValueError(message)
env.globals['raise_exception'] = fail
template = env.from_string(proof['template'])
for branch, compiled in zip(proof['branches'], proof['compiled']):
    expected = template.render(messages=branch['messages'], bos_token='<bos>', eos_token='<eos>', add_generation_prompt=True, enable_thinking=False) + branch['answer_prefix']
    assert expected == compiled['rendered'], branch['branch_id']
print(f"Gemma Jinja reference: {len(proof['branches'])} exact rendered prompts match, including BOS")
