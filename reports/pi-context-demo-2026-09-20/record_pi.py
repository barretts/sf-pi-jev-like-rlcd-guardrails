import codecs
import fcntl
import importlib.util
import json
import os
from pathlib import Path
import pty
import re
import selectors
import struct
import subprocess
import sys
import termios
import time

ROOT = Path(__file__).resolve().parent
OUTPUT = ROOT / 'capture'
JOURNAL = OUTPUT / 'events.jsonl'
spec = importlib.util.spec_from_file_location('renderer', '/private/tmp/jev-video-renderer/render_video.py')
renderer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(renderer)
replay = renderer.TerminalReplay(112, 42)

start_unix = time.time()
start = time.monotonic()
env = dict(os.environ)
env.update({
    'TERM': 'xterm-256color', 'COLORTERM': 'truecolor',
    'PI_CODING_AGENT_DIR': str(ROOT / 'agent-private'),
    'PI_TELEMETRY': '0', 'PI_OFFLINE': '1',
    'JEV_DEMO_WORKSPACE': str(ROOT / 'workspace'),
    'JEV_DEMO_JOURNAL': str(JOURNAL), 'JEV_DEMO_START': str(start_unix),
    'JEV_MODEL_FILE': '/Users/bsonntag/code/simple-jev-ts/models/gemma-3-1b-it-f16.gguf',
    'JEV_MODEL_ID': 'google/gemma-3-1b-it', 'JEV_DEVICE': 'metal',
})
command = [
    '/Users/bsonntag/code/simple-jev-ts/node_modules/.bin/pi',
    '--no-extensions', '-e', '/Users/bsonntag/code/sf-pi-jev-manager',
    '-e', '/Users/bsonntag/code/simple-jev-ts/dist/extension.js',
    '-e', '/private/tmp/jev-video-observer/observer.mjs',
    '--no-context-files', '--no-skills', '--no-prompt-templates', '--no-themes',
    '--session-dir', str(ROOT / 'sessions'), '--approve',
    '--model', 'llmgw/gpt-5.6-sol', '--thinking', 'off',
]
master, slave = pty.openpty()
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 42, 112, 0, 0))
process = subprocess.Popen(command, cwd=ROOT / 'workspace', env=env,
    stdin=slave, stdout=slave, stderr=slave, start_new_session=True)
os.close(slave)
os.set_blocking(master, False)
selector = selectors.DefaultSelector()
selector.register(master, selectors.EVENT_READ)
decoder = codecs.getincrementaldecoder('utf-8')('replace')
cast = (OUTPUT / 'recording.cast').open('w')
cast.write(json.dumps({'version': 2, 'width': 112, 'height': 42,
    'timestamp': int(start_unix), 'env': {'TERM': 'xterm-256color'},
    'title': 'Real Pi + sf-pi + Jev context activity'}) + '\n')
cast.flush()
cues = []
previous_screen = ''
protocol_tail = ''
seen_statuses = set()

def progress(kind, **details):
    event = {'time': round(time.monotonic() - start, 3), 'kind': kind, **details}
    cues.append(event)
    print(json.dumps(event), flush=True)
    (OUTPUT / 'driver-events.json').write_text(json.dumps(cues, indent=2))

def read_events():
    if not JOURNAL.exists():
        return []
    return [json.loads(line) for line in JOURNAL.read_text().splitlines() if line.strip()]

def pump(duration=0.2):
    global previous_screen, protocol_tail
    deadline = time.monotonic() + duration
    while time.monotonic() < deadline:
        control = ROOT / 'control.json'
        if control.exists():
            instruction = json.loads(control.read_text())
            control.unlink()
            progress('manual_input', label=instruction.get('label', 'capture_control'))
            os.write(master, instruction['text'].encode())
        for _, _ in selector.select(min(0.1, max(0, deadline - time.monotonic()))):
            try:
                raw = os.read(master, 65536)
            except (BlockingIOError, OSError):
                return
            if not raw:
                return
            text = decoder.decode(raw)
            if not text:
                continue
            elapsed = time.monotonic() - start
            cast.write(json.dumps([round(elapsed, 6), 'o', text], ensure_ascii=False) + '\n')
            cast.flush()
            replay.feed(text)
            screen = '\n'.join(replay.screen.display)
            if screen != previous_screen:
                for label in ('Jev context: off', 'Jev context: excerpts | waiting',
                              'Jev context: checked | kept originals', 'Jev context: applied excerpts',
                              'Jev context: provider error'):
                    if label in screen and label not in seen_statuses:
                        summary = next((line.strip() for line in replay.screen.display if label in line), label)
                        progress('ui_status', status=summary)
                        seen_statuses.add(label)
                previous_screen = screen
            protocol = protocol_tail + text
            for query in re.findall(r'\x1b\[(?:\??6n|c|>c|\?u|\?996n)', protocol):
                if query.endswith('6n') and '996' not in query:
                    answer = f'\x1b[{replay.screen.cursor.y + 1};{replay.screen.cursor.x + 1}R'
                elif query == '\x1b[c':
                    answer = '\x1b[?1;2c'
                elif query == '\x1b[>c':
                    answer = '\x1b[>0;0;0c'
                else:
                    continue
                os.write(master, answer.encode())
            # Keep only an incomplete escape sequence so complete queries are not repeated.
            last_escape = protocol.rfind('\x1b')
            suffix = protocol[last_escape:] if last_escape >= 0 else ''
            protocol_tail = suffix if suffix and not re.search(r'[A-Za-z~]$', suffix) and len(suffix) < 20 else ''

def wait_for(predicate, timeout, label):
    deadline = time.monotonic() + timeout
    next_notice = time.monotonic() + 20
    while time.monotonic() < deadline:
        pump(0.2)
        events = read_events()
        if predicate(events):
            return events
        if process.poll() is not None:
            raise RuntimeError(f'Pi exited {process.returncode} while waiting for {label}')
        if time.monotonic() >= next_notice:
            progress('waiting', label=label, journalEvents=len(events))
            next_notice += 20
    raise TimeoutError(f'Timed out waiting for {label}; Pi remains live pid={process.pid}')

def submit(text, label):
    progress('input', label=label, text=text)
    os.write(master, b'\x15')
    pump(0.3)
    if text.startswith('/'):
        os.write(master, text.encode())
    else:
        os.write(master, ('\x1b[200~' + text + '\x1b[201~').encode())
    pump(1.2)
    os.write(master, b'\r')

try:
    progress('launched', pid=process.pid, dimensions=[112, 42])
    wait_for(lambda events: any(e.get('type') == 'session_start' for e in events), 60, 'interactive startup')
    pump(4)
    if any(e.get('type') == 'ui_prompt_start' for e in read_events()):
        progress('dismiss_startup_splash')
        os.write(master, b'\x1b')
        pump(2)
    progress('startup_visible')
    submit('/jev-context excerpts', 'enable_excerpts')
    wait_for(lambda events: 'Jev context: excerpts | waiting' in '\n'.join(replay.screen.display), 40, 'enabled excerpt indicator')
    pump(4)
    submit((ROOT / 'prompt.txt').read_text(), 'read_synthetic_logs')
    events = wait_for(lambda events: any(e.get('type') == 'agent_settled' for e in events), 360, 'first settled answer')
    progress('first_answer_settled')
    pump(8)
    submit('/jev-context log', 'show_activity_log')
    pump(8)
    # Recovery uses Jev's retained original, and remains an actual model/tool turn.
    settled_before = sum(e.get('type') == 'agent_settled' for e in events)
    submit('Use jev_context_read to retrieve line 420 of the retained original for log-08.txt. '
           'Use its retained reference handle, offset 420, limit 1. Report the diagnostic code from that line. '
           'Do not read the filesystem.', 'recover_original_line')
    wait_for(lambda events: sum(e.get('type') == 'agent_settled' for e in events) > settled_before, 180, 'recovery settled answer')
    progress('recovery_answer_settled')
    pump(8)
    submit('/jev-context log', 'final_activity_log')
    pump(8)
    submit('/quit', 'graceful_exit')
    wait_for(lambda events: any(e.get('type') == 'session_shutdown' for e in events), 30, 'session shutdown')
    for _ in range(30):
        pump(0.2)
        if process.poll() is not None:
            break
    progress('finished', exitCode=process.poll())
    (OUTPUT / 'capture-result.json').write_text(json.dumps({'command': command, 'exitCode': process.poll(),
        'seconds': time.monotonic() - start, 'width': 112, 'height': 42,
        'workspace': str(ROOT / 'workspace'), 'finalScreen': replay.screen.display}, indent=2))
except Exception as error:
    progress('capture_failed', error=str(error), pid=process.pid)
    (OUTPUT / 'failure-screen.txt').write_text('\n'.join(replay.screen.display))
    # Gracefully terminate only this owned demo; preserve the full failed recording.
    if process.poll() is None:
        os.write(master, b'\x1b')
        pump(2)
        submit('/quit', 'failed_demo_exit')
        pump(3)
        if process.poll() is None:
            process.terminate()
    raise
finally:
    cast.close()
    selector.close()
    os.close(master)
