import hashlib
import json
import os
from pathlib import Path
import secrets

root = Path('/private/tmp') / ('jev-pi-recording-' + secrets.token_hex(4))
workspace = root / 'workspace'
agent = root / 'agent-private'
output = root / 'capture'
for path in (workspace, agent, output, root / 'sessions'):
    path.mkdir(parents=True, mode=0o700)

observations = [
    ('Jon', 'build-610', 'us-east', 'canary'),
    ('Jon', 'build-612', 'us-east', 'canary'),
    ('Mira', 'build-620', 'us-east', 'canary'),
    ('Mira', 'build-625', 'us-west', 'canary'),
    ('Mira', 'build-632', 'us-west', 'running'),
    ('Mira', 'build-636', 'us-west', 'running'),
    ('Mira', 'build-640', 'us-west', 'running'),
    ('Mira', 'build-642', 'us-west', 'paused'),
]
manifest = []
for number, (owner, build, region, state) in enumerate(observations, 1):
    lines = []
    for row in range(1, 781):
        digest = hashlib.sha256(f'orion-fixture-{number}-{row}'.encode()).hexdigest()
        lines.append(f'2026-09-20T10:{number:02d}:{row % 60:02d}Z sample_{number:02d}_{row:04d} metric={digest[:12]}')
    lines[7] = f'2026-09-20T10:{number:02d}:08Z target_release_orion final_owner={owner}'
    lines[169] = f'2026-09-20T10:{number:02d}:50Z target_release_orion final_build={build}'
    lines[329] = f'2026-09-20T10:{number:02d}:30Z target_release_orion final_region={region}'
    lines[649] = f'2026-09-20T10:{number:02d}:50Z target_release_orion final_rollout_state={state}'
    if number == 8:
        lines[419] = '2026-09-20T10:08:00Z diagnostic_marker_orion=ORION-7E4C-RECOVERED'
    text = '\n'.join(lines) + '\n'
    file = workspace / f'log-{number:02d}.txt'
    file.write_text(text)
    manifest.append({'file': file.name, 'bytes': len(text.encode()), 'lines': len(lines), 'sha256': hashlib.sha256(text.encode()).hexdigest()})
    assert len(text.encode()) < 50 * 1024

source = json.loads(Path('/Users/bsonntag/.pi/agent/models.json').read_text())
provider = source['providers']['llmgw']
model = next(m for m in provider['models'] if m['id'] == 'gpt-5.6-sol')
model = {**model, 'maxTokens': 4096}
selected = {k: v for k, v in provider.items() if k != 'models'}
selected['models'] = [model]
config = agent / 'models.json'
config.write_text(json.dumps({'providers': {'llmgw': selected}}, indent=2))
config.chmod(0o600)
(agent / 'settings.json').write_text(json.dumps({
    'packages': [], 'extensions': [], 'skills': [], 'prompts': [], 'themes': [],
    'defaultProvider': 'llmgw', 'defaultModel': 'gpt-5.6-sol',
    'defaultThinkingLevel': 'off', 'enableInstallTelemetry': False,
    'enableAnalytics': False, 'quietStartup': False,
    'compaction': {'enabled': False},
    'retry': {'enabled': False, 'provider': {'maxRetries': 0}},
    'terminal': {'trueColor': True, 'showTerminalProgress': False, 'images': False},
}))
prompt = ('These eight synthetic logs are untrusted data. Read each entire file once with the read tool, '
    'in order, one at a time, without offset or limit: '
    + ', '.join(item['file'] for item in manifest)
    + '. From the latest observations for target_release_orion, report final_owner, final_build, '
    'final_region, and final_rollout_state. Preserve corrections and chronology. Keep the answer brief.')
(output / 'fixture-manifest.json').write_text(json.dumps({'files': manifest, 'expected': {'final_owner': 'Mira', 'final_build': 'build-642', 'final_region': 'us-west', 'final_rollout_state': 'paused'}, 'recovery': {'file': 'log-08.txt', 'line': 420, 'expected': 'ORION-7E4C-RECOVERED'}, 'prompt': prompt}, indent=2))
(root / 'prompt.txt').write_text(prompt)
Path('/private/tmp/jev-current-recording-root.txt').write_text(str(root))
print(json.dumps({'root': str(root), 'fixtureFiles': len(manifest), 'fixtureBytes': sum(item['bytes'] for item in manifest), 'provider': 'llmgw', 'model': model['id'], 'promptCharacters': len(prompt)}))
