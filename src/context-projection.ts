/** Exact source excerpts selected for the current task, rather than a codec. */
export const CONTEXT_PROJECTION_PREAMBLE =
  "Task-relevant excerpts; omitted passages may contain facts. " +
  "Retrieve original text by source reference when needed.\n";

export interface ToolContextSource {
  /** Caller-owned retrieval identifier, never a format claim from tool text. */
  reference: string;
  text: string;
}

export interface ToolContextPlanOptions {
  task: string;
  sources: ReadonlyArray<ToolContextSource>;
  targetReduction?: number;
  /** Bytes of task, instructions, history, schemas, and other unchanged context. */
  protectedBytes?: number;
  /** Additional ceiling for the complete rendered projection, including headers. */
  maxProjectionBytes?: number;
}

export interface ToolContextLineRange {
  /** Inclusive, one-based source line numbers. */
  startLine: number;
  endLine: number;
}

export interface ToolContextProjectedSource {
  reference: string;
  originalBytes: number;
  renderedBytes: number;
  originalLineCount: number;
  renderedText: string;
  selectedLineRanges: ToolContextLineRange[];
  omittedLineRanges: ToolContextLineRange[];
}

export type ToolContextSkipReason =
  | "empty-task"
  | "short-input"
  | "protected-floor"
  | "insufficient-budget"
  | "no-relevant-passages";

export interface ToolContextPlan {
  applied: boolean;
  strategy: "identity" | "excerpts";
  reason: "target-reached" | "target-unreachable" | "target-already-reached";
  skipReason: ToolContextSkipReason | null;
  targetReached: boolean;
  targetReduction: number;
  protectedBytes: number;
  originalSourceBytes: number;
  /** UTF-8 bytes of preamble plus every source's renderedText. */
  projectionBytes: number;
  originalTotalBytes: number;
  projectedTotalBytes: number;
  reduction: number;
  /** Maximum projection bytes after accounting for the protected floor. */
  budgetBytes: number;
  /** Fixed caller annotation; contains no task, source text, or source references. */
  preamble: string;
  /** Convenience concatenation; callers may instead distribute renderedText. */
  modelVisibleText: string;
  sources: ToolContextProjectedSource[];
}

const MAX_SOURCE_BYTES = 16 * 1024 * 1024;
const MAX_SOURCES = 128;
const MAX_LINES = 250_000;
const MAX_TASK_BYTES = 64 * 1024;
const MAX_TERMS = 128;
const MAX_SYMBOLS = 64;
const MAX_CANDIDATES = 4096;
const MIN_SOURCE_BYTES = 1024;
const WORDS = /[\p{L}\p{N}_$][\p{L}\p{N}_$./:-]*/gu;
const STOP_WORDS = new Set(
  (
    "a an and are as at be been by can could did do does for from had has have " +
    "how i if in into is it its me of on or our please show tell than that the " +
    "their them then there these they this those to was were what when where " +
    "which who why will with would you your"
  ).split(" "),
);

interface SourceState {
  reference: string;
  text: string;
  originalBytes: number;
  starts: number[];
  ends: number[];
  bytePrefix: number[];
  scores: number[];
  ranges: ToolContextLineRange[];
  renderedBytes: number;
  header: string;
}

interface Candidate {
  sourceIndex: number;
  startLine: number;
  endLine: number;
  rank: number;
}

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Tool context projection: ${message}`);
}

function safeInteger(value: unknown, label: string): number {
  check(
    typeof value === "number" && Number.isSafeInteger(value) && value >= 0,
    `${label} must be a nonnegative safe integer`,
  );
  return value;
}

function ownRecord(
  value: unknown,
  allowed: readonly string[],
  required: readonly string[],
  label: string,
): Record<string, unknown> {
  check(
    value !== null &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      (Object.getPrototypeOf(value) === Object.prototype ||
        Object.getPrototypeOf(value) === null) &&
      Object.getOwnPropertySymbols(value).length === 0,
    `${label} must be a plain record`,
  );
  const fields = Object.getOwnPropertyDescriptors(value);
  check(
    Object.keys(fields).every(
      (key) => allowed.includes(key) && Object.hasOwn(fields[key], "value"),
    ) &&
      required.every(
        (key) =>
          Object.hasOwn(fields, key) && Object.hasOwn(fields[key], "value"),
      ),
    `${label} has missing, unexpected, or accessor fields`,
  );
  const normalized: Record<string, unknown> = Object.create(null);
  for (const key of Object.keys(fields)) normalized[key] = fields[key].value;
  return normalized;
}

function validText(value: unknown, maxBytes: number, label: string): string {
  check(typeof value === "string", `${label} must be text`);
  check(value.length <= maxBytes, `${label} exceeds byte limit`);
  // UTF-8 replacement of lone surrogates would break exact passage accounting.
  for (const character of value) {
    const unit = character.charCodeAt(0);
    check(
      character.length === 2 || unit < 0xd800 || unit > 0xdfff,
      `${label} must contain valid Unicode`,
    );
  }
  check(
    Buffer.byteLength(value, "utf8") <= maxBytes,
    `${label} exceeds byte limit`,
  );
  return value;
}

function canonicalWord(word: string): string {
  return word.replace(/[.:/-]+$/u, "");
}

function wordParts(word: string): string[] {
  return (
    word
      .replace(/([\p{Ll}\p{N}])([\p{Lu}])/gu, "$1 $2")
      .match(/[\p{L}\p{N}]+/gu) ?? []
  );
}

function taskVocabulary(task: string) {
  const terms = new Set<string>();
  const symbols = new Set<string>();
  const addTerm = (term: string) => {
    const folded = term.toLowerCase();
    if (terms.size < MAX_TERMS && folded.length >= 2 && !STOP_WORDS.has(folded))
      terms.add(folded);
  };
  for (const match of task.matchAll(WORDS)) {
    const word = canonicalWord(match[0]);
    addTerm(word);
    for (const part of wordParts(word)) addTerm(part);
    if (
      symbols.size < MAX_SYMBOLS &&
      (/[_.:/-]/u.test(word) || /[\p{Ll}\p{N}][\p{Lu}]/u.test(word))
    )
      symbols.add(word);
  }
  // Backtick/quote names get an exact, case-sensitive symbol preference too.
  for (const match of task.matchAll(/[`"']([^`"'\r\n]{1,256})[`"']/gu)) {
    if (symbols.size >= MAX_SYMBOLS) break;
    const word = canonicalWord(match[1]);
    if (/^[\p{L}\p{N}_$][\p{L}\p{N}_$./:-]*$/u.test(word)) {
      symbols.add(word);
      addTerm(word);
    }
  }
  return { terms, symbols };
}

function lineScore(
  text: string,
  vocabulary: ReturnType<typeof taskVocabulary>,
): number {
  const hits = new Set<string>();
  const symbolHits = new Set<string>();
  for (const match of text.matchAll(WORDS)) {
    const word = canonicalWord(match[0]);
    if (vocabulary.symbols.has(word)) symbolHits.add(word);
    const folded = word.toLowerCase();
    if (vocabulary.terms.has(folded)) hits.add(folded);
    for (const part of wordParts(word)) {
      const foldedPart = part.toLowerCase();
      if (vocabulary.terms.has(foldedPart)) hits.add(foldedPart);
    }
  }
  return hits.size * 3 + symbolHits.size * 12;
}

function omissionHeader(startLine: number, endLine: number): string {
  return `[omitted lines ${startLine}-${endLine}]\n`;
}

function passageHeader(
  source: SourceState,
  range: ToolContextLineRange,
): string {
  const tail = source.text[source.ends[range.endLine - 1] - 1];
  const noTerminator = tail !== "\n" && tail !== "\r";
  return `[lines ${range.startLine}-${range.endLine}${noTerminator ? "; no final newline" : ""}]\n`;
}

function omittedRanges(
  lineCount: number,
  selected: readonly ToolContextLineRange[],
): ToolContextLineRange[] {
  const omitted: ToolContextLineRange[] = [];
  let nextLine = 1;
  for (const range of selected) {
    if (range.startLine > nextLine)
      omitted.push({ startLine: nextLine, endLine: range.startLine - 1 });
    nextLine = range.endLine + 1;
  }
  if (nextLine <= lineCount)
    omitted.push({ startLine: nextLine, endLine: lineCount });
  return omitted;
}

function measureRendered(
  source: SourceState,
  ranges: readonly ToolContextLineRange[],
): number {
  if (!source.starts.length) return 0;
  let bytes = Buffer.byteLength(source.header, "utf8");
  let nextLine = 1;
  for (const range of ranges) {
    if (range.startLine > nextLine)
      bytes += omissionHeader(nextLine, range.startLine - 1).length;
    bytes += passageHeader(source, range).length;
    bytes +=
      source.bytePrefix[range.endLine] - source.bytePrefix[range.startLine - 1];
    const tail = source.text[source.ends[range.endLine - 1] - 1];
    // A structural separator follows an unterminated passage; its header says so.
    if (tail !== "\n" && tail !== "\r") bytes++;
    nextLine = range.endLine + 1;
  }
  if (nextLine <= source.starts.length)
    bytes += omissionHeader(nextLine, source.starts.length).length;
  return bytes;
}

function mergeRange(
  ranges: readonly ToolContextLineRange[],
  added: ToolContextLineRange,
): ToolContextLineRange[] {
  const merged: ToolContextLineRange[] = [];
  let current = { startLine: added.startLine, endLine: added.endLine };
  let inserted = false;
  for (const range of ranges) {
    if (range.endLine + 1 < current.startLine) merged.push(range);
    else if (current.endLine + 1 < range.startLine) {
      if (!inserted) {
        merged.push(current);
        inserted = true;
      }
      merged.push(range);
    } else {
      current = {
        startLine: Math.min(current.startLine, range.startLine),
        endLine: Math.max(current.endLine, range.endLine),
      };
    }
  }
  if (!inserted) merged.push(current);
  return merged;
}

function renderSource(source: SourceState): ToolContextProjectedSource {
  const parts: string[] = source.starts.length ? [source.header] : [];
  let nextLine = 1;
  for (const range of source.ranges) {
    if (range.startLine > nextLine)
      parts.push(omissionHeader(nextLine, range.startLine - 1));
    parts.push(passageHeader(source, range));
    const passage = source.text.slice(
      source.starts[range.startLine - 1],
      source.ends[range.endLine - 1],
    );
    parts.push(passage);
    if (!passage.endsWith("\n") && !passage.endsWith("\r")) parts.push("\n");
    nextLine = range.endLine + 1;
  }
  if (nextLine <= source.starts.length)
    parts.push(omissionHeader(nextLine, source.starts.length));
  const renderedText = parts.join("");
  return {
    reference: source.reference,
    originalBytes: source.originalBytes,
    renderedBytes: Buffer.byteLength(renderedText, "utf8"),
    originalLineCount: source.starts.length,
    renderedText,
    selectedLineRanges: source.ranges.map((range) => ({ ...range })),
    omittedLineRanges: omittedRanges(source.starts.length, source.ranges),
  };
}

/**
 * Deterministic task-aware excerpt selection, with no model calls or rewriting.
 * Lexical task terms and exact named symbols rank three-line windows (one line
 * of adjacent context each side). Selected ranges are merged and rendered in
 * original source order. Every omitted line belongs to a visible omission span.
 *
 * This is intentionally a projection: omitted facts are not model-visible. The
 * caller retains originals and supplies retrieval by reference. UTF-8 admission
 * includes every header/omission/preamble byte plus the supplied protected floor;
 * it is not a tokenizer or an assertion about answer effectiveness.
 *
 * Bounds: 128 sources, 16 MiB aggregate source text, 250,000 aggregate lines,
 * 64 KiB task text, 128 lexical terms, 64 exact symbols and 4,096 ranked windows.
 */
export function planToolContext(
  options: ToolContextPlanOptions,
): ToolContextPlan {
  const input = ownRecord(
    options,
    [
      "task",
      "sources",
      "targetReduction",
      "protectedBytes",
      "maxProjectionBytes",
    ],
    ["task", "sources"],
    "options",
  );
  const task = validText(input.task, MAX_TASK_BYTES, "task");
  const targetReduction = input.targetReduction ?? 0.5;
  check(
    typeof targetReduction === "number" &&
      Number.isFinite(targetReduction) &&
      targetReduction >= 0 &&
      targetReduction <= 1,
    "targetReduction must be between 0 and 1",
  );
  const protectedBytes = safeInteger(
    input.protectedBytes ?? 0,
    "protectedBytes",
  );
  const maxProjectionBytes = safeInteger(
    input.maxProjectionBytes ?? MAX_SOURCE_BYTES,
    "maxProjectionBytes",
  );
  check(Array.isArray(input.sources), "sources must be an array");
  const sourceInputs = input.sources;
  check(sourceInputs.length <= MAX_SOURCES, "source count exceeds limit");
  const sourceFields = Object.getOwnPropertyDescriptors(sourceInputs);
  check(
    Object.getOwnPropertySymbols(sourceInputs).length === 0 &&
      Object.keys(sourceFields).every(
        (key) =>
          key === "length" ||
          (/^(0|[1-9][0-9]*)$/u.test(key) &&
            Number(key) < sourceInputs.length &&
            Object.hasOwn(sourceFields[key], "value")),
      ),
    "sources has unexpected or accessor fields",
  );
  const vocabulary = taskVocabulary(task);
  const states: SourceState[] = [];
  const references = new Set<string>();
  const candidates: Candidate[] = [];
  let originalSourceBytes = 0;
  let totalLines = 0;
  for (let sourceIndex = 0; sourceIndex < sourceInputs.length; sourceIndex++) {
    check(
      Object.hasOwn(sourceFields, sourceIndex),
      "sources must not have missing entries",
    );
    const source = ownRecord(
      sourceFields[sourceIndex].value,
      ["reference", "text"],
      ["reference", "text"],
      "source",
    );
    check(
      typeof source.reference === "string" &&
        /^[A-Za-z0-9_.:/-]{1,256}$/u.test(source.reference),
      "reference must be a bounded ASCII retrieval identifier",
    );
    check(
      !references.has(source.reference),
      "source references must be unique",
    );
    references.add(source.reference);
    const text = validText(
      source.text,
      MAX_SOURCE_BYTES - originalSourceBytes,
      "source text",
    );
    const originalBytes = Buffer.byteLength(text, "utf8");
    originalSourceBytes += originalBytes;
    const state: SourceState = {
      reference: source.reference,
      text,
      originalBytes,
      starts: [],
      ends: [],
      bytePrefix: [0],
      scores: [],
      ranges: [],
      renderedBytes: 0,
      header: `Source ${source.reference}:\n`,
    };
    const addLine = (start: number, end: number) => {
      check(++totalLines <= MAX_LINES, "source line count exceeds limit");
      const line = text.slice(start, end);
      state.starts.push(start);
      state.ends.push(end);
      state.bytePrefix.push(
        state.bytePrefix.at(-1)! + Buffer.byteLength(line, "utf8"),
      );
      state.scores.push(lineScore(line, vocabulary));
    };
    let start = 0;
    for (let index = 0; index < text.length; index++) {
      if (text[index] !== "\n" && text[index] !== "\r") continue;
      if (text[index] === "\r" && text[index + 1] === "\n") index++;
      addLine(start, index + 1);
      start = index + 1;
    }
    if (start < text.length) addLine(start, text.length);
    for (let index = 0; index < state.scores.length; index++) {
      if (!state.scores[index]) continue;
      const startLine = Math.max(1, index);
      const endLine = Math.min(state.starts.length, index + 2);
      const bytes = state.bytePrefix[endLine] - state.bytePrefix[startLine - 1];
      const score =
        state.scores[index] +
        (state.scores[index - 1] ?? 0) * 0.25 +
        (state.scores[index + 1] ?? 0) * 0.25;
      candidates.push({
        sourceIndex,
        startLine,
        endLine,
        rank: score / Math.sqrt(bytes + 80),
      });
    }
    state.renderedBytes = measureRendered(state, []);
    states.push(state);
  }
  const originalTotalBytes = protectedBytes + originalSourceBytes;
  check(
    Number.isSafeInteger(originalTotalBytes),
    "total original bytes overflow",
  );
  const totalBudget = Math.floor((1 - targetReduction) * originalTotalBytes);
  const budgetBytes = Math.max(
    0,
    Math.min(maxProjectionBytes, totalBudget - protectedBytes),
  );
  const identity = (
    skipReason: ToolContextSkipReason | null,
  ): ToolContextPlan => {
    const sources = states.map((source) => ({
      reference: source.reference,
      originalBytes: source.originalBytes,
      renderedBytes: source.originalBytes,
      originalLineCount: source.starts.length,
      renderedText: source.text,
      selectedLineRanges: source.starts.length
        ? [{ startLine: 1, endLine: source.starts.length }]
        : [],
      omittedLineRanges: [],
    }));
    return {
      applied: false,
      strategy: "identity",
      reason:
        targetReduction === 0 ? "target-already-reached" : "target-unreachable",
      skipReason,
      targetReached: targetReduction === 0,
      targetReduction,
      protectedBytes,
      originalSourceBytes,
      projectionBytes: originalSourceBytes,
      originalTotalBytes,
      projectedTotalBytes: originalTotalBytes,
      reduction: 0,
      budgetBytes,
      preamble: "",
      modelVisibleText: sources.map((source) => source.renderedText).join(""),
      sources,
    };
  };
  if (targetReduction === 0) return identity(null);
  if (!task.trim()) return identity("empty-task");
  if (originalSourceBytes < MIN_SOURCE_BYTES) return identity("short-input");
  if (protectedBytes >= totalBudget) return identity("protected-floor");
  if (!candidates.length) return identity("no-relevant-passages");
  let projectionBytes =
    Buffer.byteLength(CONTEXT_PROJECTION_PREAMBLE, "utf8") +
    states.reduce((bytes, source) => bytes + source.renderedBytes, 0);
  if (projectionBytes >= budgetBytes) return identity("insufficient-budget");
  candidates.sort(
    (left, right) =>
      right.rank - left.rank ||
      left.sourceIndex - right.sourceIndex ||
      left.startLine - right.startLine ||
      left.endLine - right.endLine,
  );
  const ranked = candidates.slice(0, MAX_CANDIDATES);
  // Usually aim for 85% tool-payload reduction; the whole-context ceiling wins
  // whenever the protected floor requires a still more aggressive projection.
  const aggressiveBudget = Math.min(
    budgetBytes,
    Math.max(projectionBytes + 256, Math.floor(originalSourceBytes * 0.15)),
  );
  let selected = false;
  const select = (candidate: Candidate, ceiling: number) => {
    const source = states[candidate.sourceIndex];
    const ranges = mergeRange(source.ranges, candidate);
    const renderedBytes = measureRendered(source, ranges);
    const nextBytes = projectionBytes - source.renderedBytes + renderedBytes;
    if (nextBytes > ceiling) return false;
    source.ranges = ranges;
    source.renderedBytes = renderedBytes;
    projectionBytes = nextBytes;
    selected = true;
    return true;
  };
  for (const candidate of ranked) select(candidate, aggressiveBudget);
  // Do not declare the target impossible merely because the aggressive aim is
  // stricter than the requested reduction. A useful larger passage may still fit.
  if (!selected)
    for (const candidate of ranked) if (select(candidate, budgetBytes)) break;
  if (!selected) return identity("insufficient-budget");
  const sources = states.map(renderSource);
  const modelVisibleText =
    CONTEXT_PROJECTION_PREAMBLE +
    sources.map((source) => source.renderedText).join("");
  projectionBytes = Buffer.byteLength(modelVisibleText, "utf8");
  const projectedTotalBytes = protectedBytes + projectionBytes;
  if (projectionBytes > budgetBytes || projectedTotalBytes > totalBudget)
    return identity("insufficient-budget");
  return {
    applied: true,
    strategy: "excerpts",
    reason: "target-reached",
    skipReason: null,
    targetReached: true,
    targetReduction,
    protectedBytes,
    originalSourceBytes,
    projectionBytes,
    originalTotalBytes,
    projectedTotalBytes,
    reduction: 1 - projectedTotalBytes / originalTotalBytes,
    budgetBytes,
    preamble: CONTEXT_PROJECTION_PREAMBLE,
    modelVisibleText,
    sources,
  };
}
