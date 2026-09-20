#!/usr/bin/env node
// Software UI test: launch an isolated headless browser, never attach to user tabs.
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";

const { values } = parseArgs({
  options: {
    url: { type: "string", default: "http://127.0.0.1:8500" },
    output: { type: "string", default: ".build/browser-proof" },
    classify: { type: "boolean", default: false },
    "require-report": { type: "boolean", default: false },
    "executable-path": { type: "string" },
  },
});
const address = new URL(values.url);
assert.equal(address.protocol, "http:");
assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(address.hostname));
const output = resolve(values.output);
await mkdir(output, { recursive: true });
let playwright;
try {
  playwright = await import("playwright-core");
} catch {
  // Optional local test installation, excluded from publication.
  playwright = await import(
    pathToFileURL(
      resolve(".build/browser-test/node_modules/playwright-core/index.mjs"),
    ).href
  );
}
const browser = await playwright.chromium.launch({
  headless: true,
  ...(values["executable-path"]
    ? { executablePath: values["executable-path"] }
    : { channel: "chrome" }),
});
const context = await browser.newContext({
  viewport: { width: 1280, height: 900 },
  colorScheme: "light",
});
const page = await context.newPage();
const errors = [],
  externalRequests = [],
  posts = [],
  checks = [];
page.on("pageerror", (error) => errors.push(error.message));
page.on("request", (request) => {
  if (new URL(request.url()).origin !== address.origin)
    externalRequests.push(request.url());
  if (request.method() === "POST") posts.push(request.url());
});
const proof = {
  schema_version: 1,
  kind: "isolated_headless_browser_ui",
  created_at: new Date().toISOString(),
  browser: browser.version(),
  origin: address.origin,
  inference_requested: values.classify,
  checks,
  errors,
  externalRequests,
  posts,
};
try {
  await page.goto(address.origin + "/", { waitUntil: "networkidle" });
  await page.waitForFunction(() =>
    document.getElementById("status").textContent.startsWith("Ready. Model:"),
  );
  assert.equal(await page.title(), "Jev local playground");
  assert.equal(await page.locator("#request").isVisible(), true);
  const initial = JSON.parse(await page.locator("#request").inputValue());
  assert.equal(initial.options.template_version, "v2");
  assert.deepEqual(
    Object.values(initial.questions).map((question) => question.type),
    ["choice", "score", "noul"],
  );
  checks.push(
    "Playground and editable all-three request rendered; new request defaults to v2.",
  );
  await page.screenshot({
    path: resolve(output, "playground.png"),
    fullPage: true,
  });

  await page
    .getByRole("button", { name: "Truth example", exact: true })
    .click();
  assert.deepEqual(
    Object.values(
      JSON.parse(await page.locator("#request").inputValue()).questions,
    ).map((question) => question.type),
    ["noul"],
  );
  await page.getByRole("button", { name: "All three", exact: true }).click();
  checks.push("Example buttons edit the visible request field.");

  if (values.classify) {
    const literalId = "refund <script>window.jevXss=1</script>";
    const actualRequest = {
      ...initial,
      state:
        "The customer says: I was charged twice for my subscription. Please refund the duplicate charge.",
      questions: {
        route: initial.questions.choice,
        support: initial.questions.score,
        [literalId]: initial.questions.noul,
      },
    };
    await page.locator("#request").fill(JSON.stringify(actualRequest, null, 2));
    const nativeResponse = page.waitForResponse(
      (response) =>
        response.url() === address.origin + "/v1/classifier" &&
        response.request().method() === "POST",
      { timeout: 450_000 },
    );
    await page.getByRole("button", { name: "Classify", exact: true }).click();
    const response = await nativeResponse;
    const actual = await response.json();
    assert.equal(response.status(), 200, JSON.stringify(actual));
    await page.waitForFunction(() =>
      document
        .getElementById("status")
        .textContent.startsWith("Classification complete."),
    );
    const visible = JSON.parse(await page.locator("#response").textContent());
    assert.deepEqual(visible, actual);
    assert.deepEqual(
      Object.values(actual.answers).map((answer) => answer.type),
      ["choice", "score", "noul"],
    );
    assert.equal(actual.metadata.template_version, "v2");
    assert.equal(actual.usage.output_tokens, 0);
    assert.ok(actual.usage.input_tokens > 0);
    assert.equal(await page.locator("#response script").count(), 0);
    assert.equal(await page.evaluate(() => window.jevXss), undefined);
    proof.classification = { request: actualRequest, response: actual };
    checks.push(
      "Edited request submitted to actual local classifier; all-three response and usage rendered exactly.",
    );
    checks.push(
      "User-supplied script markup in response ID remains literal text.",
    );
    await page.screenshot({
      path: resolve(output, "classification.png"),
      fullPage: true,
    });

    const postsBeforeMalformed = posts.length;
    await page.locator("#request").fill("{");
    await page.getByRole("button", { name: "Classify", exact: true }).click();
    await page.waitForFunction(
      () => document.getElementById("status").getAttribute("role") === "alert",
    );
    assert.match(
      await page.locator("#status").textContent(),
      /could not be completed/,
    );
    assert.equal(posts.length, postsBeforeMalformed);
    checks.push(
      "Malformed editable JSON reports a visible client error without a model request.",
    );

    await page.locator("#request").fill(
      JSON.stringify({
        ...initial,
        model: "unapproved-browser-test-model-id",
      }),
    );
    const rejected = page.waitForResponse(
      (response) =>
        response.url() === address.origin + "/v1/classifier" &&
        response.request().method() === "POST",
    );
    await page.getByRole("button", { name: "Classify", exact: true }).click();
    const failure = await rejected;
    assert.equal(failure.status(), 422);
    await page.waitForFunction(() =>
      document.getElementById("status").textContent.includes("HTTP 422"),
    );
    assert.equal(
      JSON.parse(await page.locator("#response").textContent()).error.type,
      "invalid_request_error",
    );
    checks.push("Actual API rejection renders status and structured error.");
    await page.screenshot({
      path: resolve(output, "error.png"),
      fullPage: true,
    });
  }

  const postsBeforeInspector = posts.length;
  await page.goto(address.origin + "/inspector", { waitUntil: "networkidle" });
  assert.equal(await page.title(), "Jev local reports");
  assert.match(await page.locator("body").textContent(), /read only/);
  assert.deepEqual(await page.getByRole("button").allTextContents(), [
    "Refresh reports",
    "Open selected report",
  ]);
  await page
    .getByRole("button", { name: "Refresh reports", exact: true })
    .click();
  await page.waitForFunction(() =>
    /saved reports|No saved reports/.test(
      document.getElementById("status").textContent,
    ),
  );
  const options = await page.locator("#reports option").count();
  const reportValues = await page
    .locator("#reports option")
    .evaluateAll((options) => options.map((option) => option.value));
  if (values["require-report"])
    assert.ok(
      reportValues.some((value) => /^(routing|evaluation)\//.test(value)),
      "An actual saved advisory report must be present for this proof",
    );
  proof.inspected_reports = [];
  for (const selected of reportValues.slice(0, 10)) {
    await page.locator("#reports").selectOption(selected);
    const saved = page.waitForResponse(
      (response) =>
        response.url() === address.origin + "/api/inspector/" + selected,
    );
    await page
      .getByRole("button", { name: "Open selected report", exact: true })
      .click();
    assert.equal((await saved).status(), 200);
    await page.waitForFunction(
      () =>
        document.getElementById("status").textContent ===
        "Saved report loaded.",
    );
    const visible = JSON.parse(await page.locator("#response").textContent());
    const [kind, id] = selected.split("/");
    assert.equal(visible.kind, kind);
    assert.equal(visible.id, id);
    assert.ok(!("prompt" in visible));
    assert.ok(!("filepath" in visible));
    proof.inspected_reports.push({ selected, report: visible });
  }
  const scopeRejections = await page.evaluate(async () => {
    const paths = [
      "/api/inspector/routing/..%2FREADME",
      "/api/inspector/arbitrary/README",
      "/api/inspector/evaluation/unowned-missing-report",
    ];
    return await Promise.all(
      paths.map(async (path) => ({ path, status: (await fetch(path)).status })),
    );
  });
  assert.ok(scopeRejections.every((result) => result.status === 404));
  proof.scope_rejections = scopeRejections;
  assert.equal(posts.length, postsBeforeInspector);
  checks.push(
    "Inspector rendered saved summaries, rejected unowned paths, and exposed read-only actions without POSTs.",
  );
  proof.inspector_reports = options;
  await page.screenshot({
    path: resolve(output, "inspector.png"),
    fullPage: true,
  });

  await page.goto(address.origin + "/docs/", { waitUntil: "networkidle" });
  await page.waitForFunction(() =>
    document.getElementById("spec").textContent.includes('"openapi"'),
  );
  const schema = JSON.parse(await page.locator("#spec").textContent());
  assert.ok(schema.paths["/v1/classifier"]);
  checks.push("Local API documentation rendered without CDN requests.");
  assert.deepEqual(errors, []);
  assert.deepEqual(externalRequests, []);
  proof.passed = true;
  await writeFile(
    resolve(output, "proof.json"),
    JSON.stringify(proof, null, 2) + "\n",
  );
  console.log(JSON.stringify(proof, null, 2));
} finally {
  await context.close();
  await browser.close();
}
