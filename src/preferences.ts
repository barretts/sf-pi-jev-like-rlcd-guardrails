import { getAgentDir } from "@earendil-works/pi-coding-agent";
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";

export type Preferences = {
  enabled: boolean;
  routing: boolean;
  evaluation: boolean;
  templateVersion: "v1" | "v2";
};

export type SettingsScope = "global" | "project";

export const DEFAULT_PREFERENCES: Readonly<Preferences> = Object.freeze({
  enabled: true,
  routing: false,
  evaluation: false,
  templateVersion: "v2",
});

export type PreferenceReadResult = {
  values: Preferences;
  sources: Record<keyof Preferences, "default" | SettingsScope>;
  scopes: Record<SettingsScope, Partial<Preferences>>;
  paths: Record<SettingsScope, string>;
};

const keys = Object.keys(DEFAULT_PREFERENCES) as (keyof Preferences)[];

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validValue(key: keyof Preferences, value: unknown): boolean {
  return key === "templateVersion"
    ? value === "v1" || value === "v2"
    : typeof value === "boolean";
}

function readSettings(path: string, strict: boolean): Record<string, unknown> {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    if (!strict) return {};
    throw new Error(`Cannot read settings: ${path}`, { cause: error });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    if (!strict) return {};
    throw new Error(`Settings contain invalid JSON: ${path}`, { cause: error });
  }
  if (!isObject(parsed)) {
    if (!strict) return {};
    throw new Error(`Settings must be a JSON object: ${path}`);
  }
  return parsed;
}

function settingsPaths(
  cwd: string,
  agentDir: string,
): Record<SettingsScope, string> {
  return {
    global: join(agentDir, "settings.json"),
    project: join(cwd, ".pi", "settings.json"),
  };
}

/** Resolve known Jev settings independently, with project values taking priority. */
export function readPreferences(
  cwd: string,
  agentDir: string = getAgentDir(),
): PreferenceReadResult {
  const paths = settingsPaths(cwd, agentDir);
  const values: Preferences = { ...DEFAULT_PREFERENCES };
  const scopes: PreferenceReadResult["scopes"] = { global: {}, project: {} };
  const sources: PreferenceReadResult["sources"] = {
    enabled: "default",
    routing: "default",
    evaluation: "default",
    templateVersion: "default",
  };
  for (const scope of ["global", "project"] as const) {
    const settings = readSettings(paths[scope], false);
    if (!isObject(settings.jev)) continue;
    for (const key of keys) {
      const value = settings.jev[key];
      if (!validValue(key, value)) continue;
      Object.assign(values, { [key]: value });
      Object.assign(scopes[scope], { [key]: value });
      sources[key] = scope;
    }
  }
  return { values, sources, scopes, paths };
}

/** Atomically update one scope without replacing other Pi or Jev settings. */
export function writePreferences(
  cwd: string,
  scope: SettingsScope,
  patch: Partial<Preferences>,
  agentDir: string = getAgentDir(),
): PreferenceReadResult {
  if (scope !== "global" && scope !== "project")
    throw new Error("Settings scope must be global or project");
  if (!isObject(patch)) throw new Error("Jev settings patch must be an object");
  for (const [key, value] of Object.entries(patch)) {
    if (!keys.includes(key as keyof Preferences))
      throw new Error(`Unknown Jev setting: ${key}`);
    if (!validValue(key as keyof Preferences, value))
      throw new Error(`Invalid Jev setting: ${key}`);
  }
  const path = settingsPaths(cwd, agentDir)[scope];
  const settings = readSettings(path, true);
  if (Object.hasOwn(settings, "jev") && !isObject(settings.jev))
    throw new Error(`Jev settings must be an object: ${path}`);
  const previous = isObject(settings.jev) ? settings.jev : {};
  for (const key of keys) {
    if (Object.hasOwn(previous, key) && !validValue(key, previous[key]))
      throw new Error(`Invalid existing Jev setting ${key}: ${path}`);
  }
  const updated = { ...settings, jev: { ...previous, ...patch } };
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporary = join(directory, `.settings-${randomUUID()}.tmp`);
  let descriptor: number | undefined;
  try {
    descriptor = openSync(temporary, "wx", 0o600);
    writeFileSync(descriptor, `${JSON.stringify(updated, null, 2)}\n`, "utf8");
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporary, path);
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor);
    try {
      unlinkSync(temporary);
    } catch {
      // Only this operation's unique temporary file is eligible for cleanup.
    }
    throw error;
  }
  return readPreferences(cwd, agentDir);
}
