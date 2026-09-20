import type { FastifyInstance } from "fastify";
import { readdir, readFile, realpath } from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";
import type { Config } from "./backend.js";

const css = `:root{color-scheme:light dark;font:16px/1.5 system-ui,sans-serif}body{max-width:1050px;margin:2rem auto;padding:0 1rem}header{border-bottom:1px solid #8885;margin-bottom:1.5rem}h1{margin-bottom:.2rem}nav, .actions{display:flex;gap:.75rem;flex-wrap:wrap;margin:1rem 0}button,a{font:inherit}button{padding:.4rem .8rem;cursor:pointer}textarea{box-sizing:border-box;width:100%;min-height:28rem;padding:1rem;font:14px/1.5 ui-monospace,monospace;tab-size:2}pre{white-space:pre-wrap;overflow-wrap:anywhere;padding:1rem;background:#8881;border:1px solid #8884;border-radius:.3rem}section{margin:2rem 0}.muted{color:#888}label{display:block;margin:.6rem 0}button:disabled{cursor:wait;opacity:.6}#status[role=alert]{color:#d44}select{font:inherit;padding:.3rem}`;

export const playgroundHtml = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Jev local playground</title><link rel="stylesheet" href="/assets/jev.css"><script defer src="/assets/playground.js"></script></head>
<body><header><h1>Jev local playground</h1><p>Classify text using the approved local Gemma model.</p><nav><a href="/">Playground</a><a href="/inspector">Local reports</a><a href="/docs/">API documentation</a></nav></header>
<p class="muted">The request stays on this local server. Scores are model judgments and are uncalibrated.</p>
<div class="actions"><button data-example="choice">Choice example</button><button data-example="score">Score example</button><button data-example="noul">Truth example</button><button data-example="all">All three</button></div>
<label for="request">Editable classification request</label><textarea id="request" spellcheck="false" aria-label="Classification request"></textarea>
<div class="actions"><button id="classify">Classify</button></div><p id="status" aria-live="polite">Loading local model identity…</p>
<section><h2>Actual response</h2><pre id="response">No request submitted.</pre></section></body></html>`;

export const playgroundScript = `"use strict";
const request = document.getElementById("request");
const response = document.getElementById("response");
const status = document.getElementById("status");
const button = document.getElementById("classify");
let model;
const questions = {
  choice: {type:"choice",instructions:"Which team should handle this customer message?",criteria:{billing:"Payments, invoices, and refunds",technical:"Technical product problems"}},
  score: {type:"score",instructions:"How strongly does the message support a duplicate charge?",criteria:["Unsupported","Partially supported","Fully supported"]},
  noul: {type:"noul",instructions:"Does the customer explicitly ask for a refund?"}
};
function example(kind) {
  const selected = kind === "all" ? questions : {[kind]: questions[kind]};
  request.value = JSON.stringify({model,state:"I was charged twice for my subscription. Please refund the duplicate charge.",questions:selected,options:{template_version:"v2"}},null,2);
}
document.querySelectorAll("[data-example]").forEach(b => b.addEventListener("click",() => example(b.dataset.example)));
button.addEventListener("click",async () => {
  button.disabled = true;
  status.removeAttribute("role");
  status.textContent = "Classifying with local Gemma…";
  try {
    const body = JSON.parse(request.value);
    body.options = {template_version:"v2",...(body.options || {})};
    const result = await fetch("/v1/classifier",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)});
    const raw = await result.text();
    let output;
    try { output = JSON.stringify(JSON.parse(raw),null,2); } catch { output = raw; }
    response.textContent = output;
    status.textContent = result.ok ? "Classification complete. Usage and resolved identities are in the response." : "Request failed (HTTP " + result.status + "). See the actual error below.";
    if (!result.ok) status.setAttribute("role","alert");
  } catch (error) {
    response.textContent = String(error.message || error);
    status.textContent = "Request could not be completed.";
    status.setAttribute("role","alert");
  } finally { button.disabled = false; }
});
fetch("/api/ui/config").then(r => {if(!r.ok)throw new Error("Local configuration unavailable");return r.json();}).then(config => {model=config.model;example("all");status.textContent="Ready. Model: " + model;}).catch(error => {status.textContent=error.message;status.setAttribute("role","alert");button.disabled=true;});`;

const inspectorHtml = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Jev local reports</title><link rel="stylesheet" href="/assets/jev.css"><script defer src="/assets/inspector.js"></script></head><body><header><h1>Jev local reports</h1><p>Routing, evaluations, and RFDT run summaries from this workspace.</p><nav><a href="/">Playground</a><a href="/inspector">Local reports</a><a href="/docs/">API documentation</a></nav></header><p>Reports are read only. Training and artifact promotion require explicit CLI commands.</p><div class="actions"><button id="refresh">Refresh reports</button><select id="reports" aria-label="Saved report"></select><button id="open">Open selected report</button></div><p id="status" aria-live="polite"></p><pre id="response">No report selected.</pre></body></html>`;
const inspectorScript = `"use strict";const selector=document.getElementById("reports"),status=document.getElementById("status"),response=document.getElementById("response");async function refresh(){try{const r=await fetch("/api/inspector");if(!r.ok)throw new Error("Reports unavailable");const data=await r.json();selector.replaceChildren();for(const record of [...data.reports,...data.runs]){const option=document.createElement("option");option.value=record.kind+"/"+record.id;option.textContent=record.kind+" · "+record.id+(record.createdAt?" · "+record.createdAt:"");selector.append(option);}status.textContent=selector.options.length?selector.options.length+" saved reports.":"No saved reports in this workspace.";}catch(error){status.textContent=error.message;}}document.getElementById("refresh").addEventListener("click",refresh);document.getElementById("open").addEventListener("click",async()=>{if(!selector.value)return;try{const r=await fetch("/api/inspector/"+selector.value);response.textContent=JSON.stringify(await r.json(),null,2);status.textContent=r.ok?"Saved report loaded.":"Report could not be loaded (HTTP "+r.status+").";}catch(error){status.textContent=error.message;}});refresh();`;
const docsHtml = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Jev API documentation</title><link rel="stylesheet" href="/assets/jev.css"><script defer src="/assets/docs.js"></script></head><body><header><h1>Jev API documentation</h1><nav><a href="/">Playground</a><a href="/inspector">Local reports</a><a href="/openapi.json">OpenAPI JSON</a></nav></header><p>POST JSON to <code>/v1/classifier</code>. <code>/v1/systemone</code> is a compatibility alias. Existing API requests default to template v1; send <code>options.template_version</code> to choose v1 or v2.</p><p>The server accepts loopback requests only, does not enable CORS, and rejects cross-origin browser writes. Request bodies are limited to 256 KiB.</p><h2>OpenAPI specification</h2><pre id="spec">Loading local API specification…</pre></body></html>`;
const docsScript = `"use strict";fetch("/openapi.json").then(r=>r.json()).then(spec=>{document.getElementById("spec").textContent=JSON.stringify(spec,null,2);}).catch(error=>{document.getElementById("spec").textContent=error.message;});`;

const idPattern = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/;
const safeFields = [
  "version",
  "id",
  "kind",
  "createdAt",
  "created_at",
  "updatedAt",
  "status",
  "phase",
  "sessionId",
  "userEntryId",
  "finalEntryId",
  "model",
  "modelId",
  "model_id",
  "model_revision",
  "modelRevision",
  "template_version",
  "templateVersion",
  "answers",
  "usage",
  "candidateFamilies",
  "activeTools",
  "metrics",
  "quality",
  "training",
  "artifact",
  "artifact_sha256",
  "sha256",
  "steps",
  "base_model",
  "base_revision",
  "loss",
  "split",
  "splits",
  "counts",
  "seed",
  "run_id",
];

function summary(record: unknown, id: string, kind: string) {
  if (!record || typeof record !== "object" || Array.isArray(record))
    throw new Error("Invalid saved report");
  const value = record as Record<string, unknown>;
  const result: Record<string, unknown> = { id, kind };
  for (const key of safeFields)
    if (Object.hasOwn(value, key)) result[key] = value[key];
  // Paths and raw training/context data are intentionally absent from the inspector.
  delete result.artifact;
  delete result.training;
  if (
    value.metadata &&
    typeof value.metadata === "object" &&
    !Array.isArray(value.metadata)
  ) {
    const metadata = value.metadata as Record<string, unknown>;
    result.metadata = Object.fromEntries(
      [
        "backend",
        "model_revision",
        "template_version",
        "device",
        "native_build",
        "calibration",
        "usage_accounting",
      ]
        .filter((key) => Object.hasOwn(metadata, key))
        .map((key) => [key, metadata[key]]),
    );
    if (metadata.artifact && typeof metadata.artifact === "object") {
      const artifact = metadata.artifact as Record<string, unknown>;
      (result.metadata as Record<string, unknown>).artifact =
        Object.fromEntries(
          [
            "id",
            "model",
            "revision",
            "sha256",
            "size",
            "base_model",
            "base_revision",
            "template_version",
            "training_run",
          ]
            .filter((key) => Object.hasOwn(artifact, key))
            .map((key) => [key, artifact[key]]),
        );
    }
  }
  if (kind === "rfdt") {
    const pick = (input: unknown, keys: string[]) => {
      if (!input || typeof input !== "object" || Array.isArray(input))
        return undefined;
      const data = input as Record<string, unknown>;
      return Object.fromEntries(
        keys
          .filter((key) => Object.hasOwn(data, key))
          .map((key) => [key, data[key]]),
      );
    };
    result.runtime = pick(value.runtime, [
      "python",
      "mlx",
      "mlx_lm_revision",
      "transformers",
      "converter_torch",
    ]);
    result.training = pick(value.training, [
      "steps",
      "initial_loss",
      "final_loss",
      "adapter_changed",
      "training_loss_decreased",
      "reload_verified",
      "reload_max_probability_delta",
      "adapter_sha256",
      "duration_seconds",
      "completed_at",
    ]);
    result.artifact = pick(value.exports, ["id", "sha256", "size"]);
    const prepared = value.prepared as Record<string, unknown> | undefined;
    result.prepared = prepared
      ? pick(prepared, ["sha256", "branches"])
      : undefined;
    const evaluation = value.evaluation as Record<string, unknown> | undefined;
    if (evaluation && typeof evaluation === "object")
      result.evaluation = Object.fromEntries(
        ["validation", "test"]
          .filter((split) => Object.hasOwn(evaluation, split))
          .map((split) => [
            split,
            pick(evaluation[split], [
              "rows",
              "mean_loss",
              "selected_label_accuracy",
              "completed_at",
              "artifact",
            ]),
          ]),
      );
  }
  result.id = id;
  result.kind = kind;
  return result;
}

async function containedRead(root: string, path: string) {
  const actualRoot = await realpath(root);
  const actualParent = await realpath(dirname(root));
  if (actualRoot !== join(actualParent, basename(root)))
    throw new Error("Report store must belong to this workspace");
  const actualFile = await realpath(path);
  if (!actualFile.startsWith(actualRoot + sep))
    throw new Error("Report outside workspace");
  const raw = await readFile(actualFile, "utf8");
  if (Buffer.byteLength(raw) > 1024 * 1024) throw new Error("Report too large");
  return JSON.parse(raw);
}

export async function readInspectorRecord(
  workspace: string,
  kind: string,
  id: string,
) {
  if (!idPattern.test(id) || !["routing", "evaluation", "rfdt"].includes(kind))
    return null;
  const root = resolve(workspace, ".jev");
  const paths =
    kind === "rfdt"
      ? [
          join(root, "rfdt", id, "manifest.json"),
          join(root, "rfdt", id, "run.json"),
        ]
      : [join(root, "reports", id + ".json")];
  for (const path of paths) {
    try {
      const record = await containedRead(root, path);
      if (kind !== "rfdt" && record.kind !== kind) return null;
      return summary(record, id, kind);
    } catch {
      /* Missing or invalid reports are not exposed. */
    }
  }
  return null;
}

export async function listInspectorRecords(workspace: string) {
  const root = resolve(workspace, ".jev");
  const reports: Record<string, unknown>[] = [],
    runs: Record<string, unknown>[] = [];
  try {
    const entries = await readdir(join(root, "reports"), {
      withFileTypes: true,
    });
    for (const file of entries.slice(0, 500)) {
      if (!file.isFile() || !file.name.endsWith(".json")) continue;
      const id = file.name.slice(0, -5);
      for (const kind of ["routing", "evaluation"]) {
        const record = await readInspectorRecord(workspace, kind, id);
        if (record) {
          reports.push(inspectorIndex(record));
          break;
        }
      }
    }
  } catch {
    /* A new workspace has no reports. */
  }
  try {
    const entries = await readdir(join(root, "rfdt"), { withFileTypes: true });
    for (const directory of entries.slice(0, 500)) {
      if (!directory.isDirectory()) continue;
      const record = await readInspectorRecord(
        workspace,
        "rfdt",
        directory.name,
      );
      if (record) runs.push(inspectorIndex(record));
    }
  } catch {
    /* A new workspace has no runs. */
  }
  const newest = (a: Record<string, unknown>, b: Record<string, unknown>) =>
    String(b.createdAt ?? b.created_at ?? b.id).localeCompare(
      String(a.createdAt ?? a.created_at ?? a.id),
    );
  return { reports: reports.sort(newest), runs: runs.sort(newest) };
}

function inspectorIndex(record: Record<string, unknown>) {
  return Object.fromEntries(
    [
      "id",
      "kind",
      "createdAt",
      "created_at",
      "status",
      "model",
      "base_model",
      "template_version",
    ]
      .filter((key) => Object.hasOwn(record, key))
      .map((key) => [key, record[key]]),
  );
}

export function registerWeb(
  app: FastifyInstance,
  config: Config,
  workspace = process.cwd(),
) {
  const asset = (url: string, type: string, body: string) =>
    app.get(url, { schema: { hide: true } }, async (_request, reply) =>
      reply.type(type).send(body),
    );
  asset("/", "text/html; charset=utf-8", playgroundHtml);
  asset("/inspector", "text/html; charset=utf-8", inspectorHtml);
  asset("/docs", "text/html; charset=utf-8", docsHtml);
  asset("/docs/", "text/html; charset=utf-8", docsHtml);
  asset("/redoc", "text/html; charset=utf-8", docsHtml);
  asset("/assets/jev.css", "text/css; charset=utf-8", css);
  asset(
    "/assets/playground.js",
    "text/javascript; charset=utf-8",
    playgroundScript,
  );
  asset(
    "/assets/inspector.js",
    "text/javascript; charset=utf-8",
    inspectorScript,
  );
  asset("/assets/docs.js", "text/javascript; charset=utf-8", docsScript);
  app.get("/api/ui/config", { schema: { hide: true } }, async () => ({
    model: config.modelId,
    template_version: "v2",
    device: config.device,
  }));
  app.get("/api/inspector", { schema: { hide: true } }, async () =>
    listInspectorRecords(workspace),
  );
  app.get<{ Params: { kind: string; id: string } }>(
    "/api/inspector/:kind/:id",
    { schema: { hide: true } },
    async (request, reply) => {
      const record = await readInspectorRecord(
        workspace,
        request.params.kind,
        request.params.id,
      );
      return (
        record ??
        reply.code(404).send({
          error: {
            code: "report_not_found",
            message: "Saved report not found",
          },
        })
      );
    },
  );
}
