import json
import math
from pathlib import Path

root = Path(__file__).resolve().parent
capture = root / 'capture'
driver = json.loads((capture / 'driver-events.json').read_text())
events = [json.loads(line) for line in (capture / 'events.jsonl').read_text().splitlines()]
result = json.loads((capture / 'capture-result.json').read_text())

def cue(kind, label=None):
    return next(row['time'] for row in driver if row['kind'] == kind and (label is None or row.get('label') == label))

first_applied = next(row['time'] for row in driver if row['kind'] == 'ui_status' and 'applied excerpts' in row['status'])
first_retrieval = next(row['time'] for row in events if row['type'] == 'tool_execution_start' and row['toolName'] == 'jev_context_read')
first_answer = cue('first_answer_settled')
recovery_answer = cue('recovery_answer_settled')
recover_turn = cue('input', 'recover_original_line')
followup_retrieval = next(row['time'] for row in events if row['type'] == 'tool_execution_start' and row['toolName'] == 'jev_context_read' and row['time'] > recover_turn)

points = [
    (0, 'This is a real Pi terminal recording with sf-pi and Jev. The eight log files are generated test data.'),
    (cue('dismiss_startup_splash'), 'All 23 sf-pi extensions have loaded. The startup catalog has 43 registered tools; the normal active tools remain available.'),
    (cue('input', 'enable_excerpts'), 'Enable exact excerpts with /jev-context excerpts. Jev now shows its status above the prompt. The target is 50% fewer serialized request bytes.'),
    (cue('input', 'read_synthetic_logs'), 'Pi is asked to read eight full logs, in order, and report the latest owner, build, region, and rollout state.'),
    (next(row['time'] for row in driver if row['kind'] == 'ui_status' and 'checked | kept originals' in row['status']), 'Early checks keep the originals: the first has no completed tool text; the next two cannot reach 50% because instructions and tool schemas remain protected.'),
    (first_applied, 'Jev starts applying exact excerpts. The first applied request is 57.1% smaller in bytes; later reductions vary. Full originals remain retained.'),
    (first_applied + 7, 'Later requests also pass the 50% byte check. Only completed tool text is reduced; instructions and tool definitions remain protected.'),
    (first_retrieval, 'Pi asks jev_context_read for omitted detail. It retrieves the last log in four pages before giving its answer.'),
    (first_answer, 'The final answer matches the fixture: Mira, build-642, us-west, paused. This answer used excerpts plus retrieval of original text.'),
    (cue('input', 'show_activity_log'), '/jev-context log shows every check and application, the request byte reduction, tool-text sizes, and clearly labeled token estimates.'),
    (recover_turn, 'Now test one specific retained line. Pi is asked to retrieve line 420 of log-08.txt with jev_context_read, without reading the filesystem.'),
    (followup_retrieval, 'The tool retrieves the original line using its host-issued reference. The returned source hash matches the original file.'),
    (recovery_answer, 'Recovered exactly: ORION-7E4C-RECOVERED. Keeping original text makes omitted details available after compression.'),
    (cue('input', 'final_activity_log'), 'The activity log records both turns. All 15 gateway responses returned HTTP 200; all tool calls succeeded in this bounded test.'),
    (cue('input', 'graceful_exit'), 'Pi exits normally. This demonstrates visible checks, validated request byte reduction, and original-text retrieval. Token, cost, and production quality gains need separate measurement.'),
]
points.sort(key=lambda item: item[0])
captions = [{'start': start, 'end': points[i + 1][0] if i + 1 < len(points) else math.ceil((result['seconds'] + 2) * 12) / 12, 'text': text} for i, (start, text) in enumerate(points)]
(capture / 'captions.json').write_text(json.dumps(captions, indent=2))
print(json.dumps({'captions': len(captions), 'lastCaptionEnds': captions[-1]['end'], 'captureExitCode': result['exitCode']}))
