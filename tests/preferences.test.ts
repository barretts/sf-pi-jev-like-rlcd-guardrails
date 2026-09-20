import { afterEach, describe, expect, it } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  DEFAULT_PREFERENCES,
  readPreferences,
  writePreferences,
} from "../src/preferences.js";

const directories: string[] = [];
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "jev-preferences-"));
  directories.push(root);
  return { root, cwd: join(root, "project"), agentDir: join(root, "agent") };
}
function put(path: string, value: unknown) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value));
}
afterEach(() => {
  for (const path of directories.splice(0)) rmSync(path, { recursive: true });
});

describe("scoped Jev preferences", () => {
  it("uses defaults without creating settings or initializing resources", () => {
    const { root, cwd, agentDir } = fixture();
    const result = readPreferences(cwd, agentDir);
    expect(result.values).toEqual(DEFAULT_PREFERENCES);
    expect(result.scopes).toEqual({ global: {}, project: {} });
    expect(Object.values(result.sources)).toEqual([
      "default",
      "default",
      "default",
      "default",
    ]);
    expect(result.paths).toEqual({
      global: join(agentDir, "settings.json"),
      project: join(cwd, ".pi", "settings.json"),
    });
    expect(readdirSync(root)).toEqual([]);
  });

  it("overrides each key independently and ignores invalid read values", () => {
    const { cwd, agentDir } = fixture();
    const { paths } = readPreferences(cwd, agentDir);
    put(paths.global, {
      jev: { enabled: false, routing: true, templateVersion: "v1" },
    });
    put(paths.project, {
      jev: {
        enabled: true,
        routing: "invalid",
        evaluation: true,
        templateVersion: "v3",
        futureUnknown: false,
      },
    });
    const result = readPreferences(cwd, agentDir);
    expect(result).toMatchObject({
      values: {
        enabled: true,
        routing: true,
        evaluation: true,
        templateVersion: "v1",
      },
      sources: {
        enabled: "project",
        routing: "global",
        evaluation: "project",
        templateVersion: "global",
      },
    });
    expect(result.scopes).toEqual({
      global: { enabled: false, routing: true, templateVersion: "v1" },
      project: { enabled: true, evaluation: true },
    });
  });

  it("atomically preserves unrelated settings and writes with private permissions", () => {
    const { cwd, agentDir } = fixture();
    const { paths } = readPreferences(cwd, agentDir);
    put(paths.global, {
      packages: ["sf-pi"],
      theme: "dark",
      jev: { routing: true, futureSetting: { unchanged: true } },
    });
    writePreferences(cwd, "global", { enabled: false }, agentDir);
    expect(JSON.parse(readFileSync(paths.global, "utf8"))).toEqual({
      packages: ["sf-pi"],
      theme: "dark",
      jev: {
        routing: true,
        futureSetting: { unchanged: true },
        enabled: false,
      },
    });
    expect(statSync(paths.global).mode & 0o777).toBe(0o600);
    expect(readdirSync(agentDir)).toEqual(["settings.json"]);
    const effective = writePreferences(
      cwd,
      "project",
      { templateVersion: "v2" },
      agentDir,
    );
    expect(effective.sources.templateVersion).toBe("project");
    expect(statSync(paths.project).mode & 0o777).toBe(0o600);
  });

  it.each([
    "{bad json",
    "[]",
    '{"jev":null}',
    '{"jev":{"enabled":"yes"}}',
    '{"jev":{"templateVersion":"v3"}}',
  ])("refuses to overwrite malformed existing settings: %s", (contents) => {
    const { cwd, agentDir } = fixture();
    const path = join(agentDir, "settings.json");
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(path, contents);
    expect(() =>
      writePreferences(cwd, "global", { evaluation: true }, agentDir),
    ).toThrow();
    expect(readFileSync(path, "utf8")).toBe(contents);
    expect(readdirSync(agentDir)).toEqual(["settings.json"]);
    expect(readPreferences(cwd, agentDir).values).toEqual(DEFAULT_PREFERENCES);
  });

  it.each([{ enabled: "yes" }, { templateVersion: "v3" }, { unknown: true }])(
    "rejects invalid patches before creating files: %j",
    (patch) => {
      const { root, cwd, agentDir } = fixture();
      expect(() =>
        writePreferences(
          cwd,
          "project",
          patch as Parameters<typeof writePreferences>[2],
          agentDir,
        ),
      ).toThrow();
      expect(readdirSync(root)).toEqual([]);
    },
  );
});
