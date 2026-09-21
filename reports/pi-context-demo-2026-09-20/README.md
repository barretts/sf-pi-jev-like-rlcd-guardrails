# Jev context activity in a real Pi session

The video shows real interactive Pi/sf-pi execution on generated log files, with captions below the terminal. Its pixels replay the captured ANSI PTY output with the original timing. The video renders this terminal recording using a fixed font and palette.

Open `index.html` for the video and a synchronized, read-only caption textarea below it, or play `jev-context-pi-demo.mp4` directly. The MP4 also has captions drawn below the terminal, so they remain visible when the video is shared separately. The original `recording.cast` and timed captions are included.

## What happened

- All 23 sf-pi extension factories loaded alongside Jev. The startup catalog contained 43 registered tools and 38 active tools; enabling Jev's retained-text reader made 39 tools available to provider requests. No tool allowlist or denylist was passed.
- `/jev-context excerpts` enabled context reduction and the visible status widget. The first provider check had no completed tool text. The next two kept originals because protected instructions and tool schemas prevented reaching the 50% request byte target.
- Pi read all eight generated logs, in order, without offsets or limits. Every returned read matched its original file's byte length and SHA-256; none was truncated.
- Requests 4 through 15 applied validated exact excerpts, with measured serialized request byte reductions from 57.1% to 78.2%. All 15 gateway responses returned HTTP 200, and every tool call succeeded.
- Before answering the first task, Pi independently retrieved the complete last log through four `jev_context_read` pages. The answer matched the fixture: Mira, build-642, us-west, paused. Its answer used excerpts plus original-text retrieval.
- A second turn recovered exactly line 420 of the retained last log, yielding `ORION-7E4C-RECOVERED`. The original source hash matched the fixture. No filesystem read was used in that turn.
- `/jev-context log` displayed each check, applied request byte reduction, tool-text sizes, and explicitly estimated token counts. `/quit` shut Pi down with exit code zero.

This bounded fixture verifies visible activity, provider request reduction, retained-original recovery, and the expected answers. It does not establish a 50% reduction in whole-workflow billed tokens, latency, cost, or production answer quality. Byte percentages are per request. The original-text recovery calls remain part of the recorded workflow.

## Use it in your own Pi session

From the TypeScript project on the recording machine:

```sh
cd /Users/bsonntag/code/simple-jev-ts

JEV_MODEL_FILE="$PWD/models/gemma-3-1b-it-f16.gguf" \
JEV_MODEL_ID=google/gemma-3-1b-it \
JEV_DEVICE=metal \
./node_modules/.bin/pi \
  --no-extensions \
  -e /Users/bsonntag/code/sf-pi-jev-manager \
  -e "$PWD/dist/extension.js" \
  --model llmgw/gpt-5.6-sol
```

Inside Pi, run `/jev-context excerpts` to enable exact excerpts, then give it a task that reads substantial tool output. The widget above the prompt changes from `checking` to `applied excerpts` or `checked | kept originals`. Run `/jev-context log` for recent entries, `/jev-context status` for cached metrics, and `/jev-context logging off` or `logging on` to hide or show activity without changing compression.

For the generated task, start Pi from this report's `fixtures/` directory instead, using the same absolute extension paths. The exact prompt is in `fixture-manifest.json`. With a fresh session, run `/jev-context excerpts` before submitting it. Model choices and timings may vary; the captured run used the user-attested OpenAI `llmgw/gpt-5.6-sol` registration with thinking off and a 4,096-token output cap. It did not execute Gemma classification or any Qwen or Chinese-lineage model.

The recording used Pi 0.85.1, local sf-pi 0.284.0 with its external Manager integration, and Jev commit `f62685b39f709dc9e9408477a5ef4b5d7df12bb2`. Project context, personal history, skills, and prompt-template discovery were disabled in an isolated demo configuration. Credentials were used only for gateway authentication and are absent from the distributed artifacts. A startup skill-count notice is sf-pi's own diagnostic display; no external skill body was used in the test prompt.

## Replay and evidence

`events.jsonl` contains safe runtime metadata, HTTP statuses, tool-result lengths and hashes, and the two fixture answers. `driver-events.json` contains timed demo inputs and observed UI states. `actual-review.json` and `actual-review.md` record an independent check against the generated fixtures and the included canonical `pi-session.jsonl`. `render-validation.json` records rendering hashes, timing, protocol handling, and ffprobe results.

To render the unchanged capture again, install FFmpeg and the Python packages in `renderer-requirements.txt`, then run:

```sh
python render_video.py \
  --cast recording.cast \
  --captions captions.json \
  --output-dir /private/tmp/jev-context-video-replay
```

`observer.mjs` is the recording-only observer loaded after the real extensions. It adds no tools, commands, messages, session entries, or provider payload changes. The archived `record_pi.py` and `prepare_jev_demo.py` show the capture procedure on this machine; they contain machine-specific paths and write private authentication configuration outside this report. The already captured replay needs no credentials or model requests.

The initial capture attempt was interrupted after the sf-pi startup splash interfered with input. No model request was sent in that attempt. The distributed video is the subsequent complete run, from startup through normal exit, with no cuts or acceleration.
