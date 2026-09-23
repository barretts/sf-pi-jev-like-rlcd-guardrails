import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { installBrowser as installC8Browser } from "../scripts/guardrail-candidate8-host-core.mjs";
import { installBrowser as installC9Browser } from "../scripts/guardrail-c9-test-baseline.mjs";

const snapshot = '- button "Save" [ref=@e7]\n';
const snapshotSha256 = createHash("sha256").update(snapshot).digest("hex");
const page = Object.freeze({
  status: "fresh",
  snapshot,
  snapshotSha256,
  url: "https://org.example.test/lightning/setup/example",
});
const ref = Object.freeze({
  status: "fresh",
  label: "Save",
  role: "button",
  snapshotSha256,
});

function fixture(tool, input, browserRef = ref, browserPage = page) {
  return {
    id: "synthetic-browser-install",
    operation: { tool, input },
    fixture: { observations: { browserRef, browserPage } },
  };
}

function recorder(
  captureSha256 = snapshotSha256,
  lookup = { status: "fresh", ref: { label: "Save", role: "button" } },
) {
  const calls = { capture: 0, lookup: 0, stale: 0 };
  const browser = {
    writeLatestBrowserSnapshotRefs(request) {
      calls.capture++;
      assert.equal(request.sessionId, "synthetic-session");
      assert.equal(request.snapshot, snapshot);
      assert.equal(request.url, page.url);
      return { snapshotSha256: captureSha256 };
    },
    findLatestBrowserSnapshotRefLookup(sessionId, requestedRef) {
      calls.lookup++;
      assert.equal(sessionId, "synthetic-session");
      assert.equal(requestedRef, "@e7");
      return lookup;
    },
    markLatestBrowserSnapshotStale(sessionId, reason) {
      calls.stale++;
      assert.equal(sessionId, "synthetic-session");
      assert.equal(reason, "fixture-stale-ref");
    },
  };
  return { browser, calls };
}

for (const [name, installBrowser] of [
  ["C8 host replay", installC8Browser],
  ["C9 model-free sentinel", installC9Browser],
]) {
  test(`${name} installs a native press page without a click ref lookup`, () => {
    const { browser, calls } = recorder();
    installBrowser(
      fixture("sf_browser_press", { key: "Enter" }),
      "synthetic-session",
      browser,
    );
    assert.deepEqual(calls, { capture: 1, lookup: 0, stale: 0 });

    const stale = recorder();
    installBrowser(
      fixture(
        "sf_browser_press",
        { key: "Enter" },
        { ...ref, status: "stale" },
      ),
      "synthetic-session",
      stale.browser,
    );
    assert.deepEqual(stale.calls, { capture: 1, lookup: 0, stale: 1 });
  });

  test(`${name} still checks click refs and every native press page capture`, () => {
    const click = recorder();
    installBrowser(
      fixture("sf_browser_click", { ref: "@e7" }),
      "synthetic-session",
      click.browser,
    );
    assert.deepEqual(click.calls, { capture: 1, lookup: 1, stale: 0 });

    const changedRef = recorder(snapshotSha256, { status: "stale" });
    assert.throws(
      () =>
        installBrowser(
          fixture("sf_browser_click", { ref: "@e7" }),
          "synthetic-session",
          changedRef.browser,
        ),
      /Browser ref (?:changed|differs)/,
    );
    assert.deepEqual(changedRef.calls, { capture: 1, lookup: 1, stale: 0 });

    for (const invalidPage of [
      { ...page, status: "stale" },
      { ...page, snapshotSha256: "0".repeat(64) },
    ]) {
      const invalid = recorder();
      assert.throws(
        () =>
          installBrowser(
            fixture("sf_browser_press", { key: "Enter" }, ref, invalidPage),
            "synthetic-session",
            invalid.browser,
          ),
        /Invalid independent browser page/,
      );
      assert.deepEqual(invalid.calls, { capture: 0, lookup: 0, stale: 0 });
    }
    const changedCapture = recorder("0".repeat(64));
    assert.throws(
      () =>
        installBrowser(
          fixture("sf_browser_press", { key: "Enter" }),
          "synthetic-session",
          changedCapture.browser,
        ),
      /Browser (?:observation|snapshot digest) changed/,
    );
    assert.deepEqual(changedCapture.calls, { capture: 1, lookup: 0, stale: 0 });
  });
}
