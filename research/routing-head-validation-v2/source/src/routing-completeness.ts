import { Script } from "node:vm";
import type { RoutingPreviousExchange } from "./routing-guards.js";

export interface RoutingCompletenessInput {
  prompt: string;
  previousExchange?: string | RoutingPreviousExchange;
  toolResults?: { toolCallId: string; text: string; isError?: boolean }[];
}

export interface RoutingCompleteness {
  verified: boolean;
  reason: string;
  evidenceKind?: "prompt-literal" | "previous-exchange" | "tool-result";
}

export const ROUTING_COMPLETENESS_LIMITS = Object.freeze({
  promptCharacters: 65536,
  previousExchangeCharacters: 65536,
  toolResults: 32,
  toolIdCharacters: 256,
  toolTextCharacters: 65536,
  aggregateCharacters: 262144,
});

const routeInstruction =
  /\b(?:ignore|override|bypass|disregard)\b.{0,100}\b(?:instructions?|rules?|router|routing|classifier)\b|\b(?:choose|select|route|classify|return|output|use)\b.{0,50}\b(?:fast|strong|uncertain)\b|\b(?:router|routing|classifier)\s+(?:instructions?|rules?|decision)\s*:/i;
const missingFacts =
  /\b(?:i|we)\s+(?:did\s+not|didn['’]?t|have\s+not|haven['’]?t)\s+(?:attach(?:ed)?|provid(?:e|ed)|includ(?:e|ed)|upload(?:ed)?|share(?:d)?)\b|\b(?:missing|absent|unavailable|unattached)\s+(?:required\s+|essential\s+)?(?:input|facts?|choices|options|document|file|context|result|data)\b|\b(?:input|facts?|choices|options|document|file|context|result|data)\s+(?:is|are)\s+(?:missing|absent|unavailable|not\s+(?:provided|included|attached))\b/i;
const incompleteSource =
  /\[(?:[^\]]*\s)?(?:truncated|omitted)(?:\s[^\]]*)?\]|\b(?:output|content|source|data)\s+(?:was\s+)?(?:truncated|omitted)\b/i;

function unknown(reason: string): RoutingCompleteness {
  return { verified: false, reason };
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function wellFormedUtf16(text: string): boolean {
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(++index);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
    } else if (code >= 0xdc00 && code <= 0xdfff) return false;
  }
  return true;
}

function normalize(text: string): string {
  return text
    .normalize("NFKC")
    .replace(/[\u200b-\u200d\ufeff]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function question(text: string): string {
  return normalize(text).replace(/^[\s:,.!?]+|[\s:,.!?]+$/g, "");
}

// Parse literals without evaluating JavaScript. The object extension permits
// quoted or identifier keys and single-quoted strings, never calls or variables.
function parseLiteral(text: string): { value: unknown } | undefined {
  let offset = 0;
  function space() {
    while (/\s/.test(text[offset] ?? "") && offset < text.length) offset++;
  }
  function string(): string {
    const quote = text[offset++];
    let result = "";
    while (offset < text.length) {
      const char = text[offset++];
      if (char === quote) {
        if (!wellFormedUtf16(result)) throw new Error("unicode");
        return result;
      }
      if (char < " ") throw new Error("control");
      if (char !== "\\") result += char;
      else {
        const escape = text[offset++];
        const escapes: Record<string, string> = {
          '"': '"',
          "'": "'",
          "\\": "\\",
          "/": "/",
          b: "\b",
          f: "\f",
          n: "\n",
          r: "\r",
          t: "\t",
        };
        if (escape === "u") {
          const hex = text.slice(offset, offset + 4);
          if (!/^[a-f\d]{4}$/i.test(hex)) throw new Error("escape");
          result += String.fromCharCode(parseInt(hex, 16));
          offset += 4;
        } else if (Object.hasOwn(escapes, escape)) result += escapes[escape];
        else throw new Error("escape");
      }
    }
    throw new Error("unterminated");
  }
  function value(depth: number): unknown {
    if (depth > 32) throw new Error("depth");
    space();
    const char = text[offset];
    if (char === '"' || char === "'") return string();
    if (char === "{" || char === "[") {
      offset++;
      const object = char === "{";
      const close = object ? "}" : "]";
      const result: any = object ? Object.create(null) : [];
      space();
      if (text[offset] === close) {
        offset++;
        return result;
      }
      for (;;) {
        space();
        if (object) {
          const quoted = text[offset] === '"' || text[offset] === "'";
          const key = quoted
            ? string()
            : /^[A-Za-z_$][\w$]*/.exec(text.slice(offset))?.[0];
          if (key === undefined || Object.hasOwn(result, key))
            throw new Error("key");
          if (!quoted) offset += key.length;
          space();
          if (text[offset++] !== ":") throw new Error("colon");
          result[key] = value(depth + 1);
        } else result.push(value(depth + 1));
        space();
        if (text[offset] === close) {
          offset++;
          return result;
        }
        if (text[offset++] !== ",") throw new Error("comma");
        space();
        if (text[offset] === close) {
          offset++;
          return result;
        }
      }
    }
    for (const [literal, result] of [
      ["true", true],
      ["false", false],
      ["null", null],
    ] as const) {
      if (text.startsWith(literal, offset)) {
        offset += literal.length;
        return result;
      }
    }
    const number = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(
      text.slice(offset),
    );
    if (!number || !Number.isFinite(Number(number[0])))
      throw new Error("value");
    offset += number[0].length;
    return Number(number[0]);
  }
  try {
    const result = value(0);
    space();
    return offset === text.length ? { value: result } : undefined;
  } catch {
    return undefined;
  }
}

function arithmetic(text: string): boolean {
  const match =
    /^(?:what\s+is|compute|calculate|evaluate)\s+(.+?)(?:[?.]\s*(?:return|answer|respond\s+with)\s+(?:only\s+)?(?:the\s+)?(?:integer|number|result|answer)(?:\s+only)?[.!]?)?[?.!]?$/i.exec(
      normalize(text),
    );
  if (!match) return false;
  const expression = match[1].replace(/[×÷]/g, (char) =>
    char === "×" ? "*" : "/",
  );
  const tokens = expression.match(/(?:\d+(?:\.\d+)?|[()+\-*/%])/g);
  if (!tokens || tokens.join("") !== expression.replace(/\s/g, ""))
    return false;
  let depth = 0;
  let needsOperand = true;
  let numbers = 0;
  let operations = 0;
  for (const token of tokens) {
    if (needsOperand) {
      if (token === "+" || token === "-") continue;
      if (token === "(") {
        depth++;
        continue;
      }
      if (!/^\d/.test(token) || !Number.isFinite(Number(token))) return false;
      numbers++;
      needsOperand = false;
    } else if (token === ")") {
      if (depth-- <= 0) return false;
    } else if (/^[+\-*/%]$/.test(token)) {
      operations++;
      needsOperand = true;
    } else return false;
  }
  return !needsOperand && depth === 0 && numbers >= 2 && operations >= 1;
}

function readLiteral(query: string, value: unknown): boolean {
  const q = question(query);
  if (
    /(?:\b(?:previous|prior|earlier|attached|attachment|screenshot|image|document|choices|options)\b)/i.test(
      q,
    )
  )
    return false;
  if (
    /^(?:please\s+)?(?:format|pretty[- ]?print|summarize|read)\s+(?:(?:this|these|the\s+(?:supplied|included))\s+)?(?:json|object|records|data|array)(?:\s+(?:as|into)\s+json)?$/i.test(
      q,
    )
  )
    return true;
  if (
    /^(?:count|return\s+(?:the\s+)?number\s+of)\s+(?:the\s+)?(?:records|items|elements|keys)(?:\s+in\s+(?:this\s+)?(?:json|object|array|data))?$/i.test(
      q,
    )
  )
    return Array.isArray(value) || record(value);
  if (/^sum\s+(?:these|the\s+supplied)\s+numbers$/i.test(q))
    return (
      Array.isArray(value) &&
      value.length > 0 &&
      value.every((item) => typeof item === "number" && Number.isFinite(item))
    );
  const field =
    /^(?:read\s+(?:this|the\s+supplied)\s+(?:json|object)\s+and\s+)?(?:return|report|extract|give\s+me)\s+(?:the\s+)?(?:value\s+(?:of|for)\s+)?(?:field\s+|property\s+|key\s+)?["'`]?([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)["'`]?(?:\s+(?:field|property|value))?(?:\s+(?:from|in)\s+(?:this\s+)?(?:json|object))?$/i.exec(
      q,
    );
  if (field) {
    let selected = value;
    for (const key of field[1].split(".")) {
      if (!record(selected) || !Object.hasOwn(selected, key)) return false;
      selected = selected[key];
    }
    return true;
  }
  const aggregate =
    /^sum\s+(?:the\s+)?([A-Za-z_$][\w$]*)(?:\s+field)?\s+(?:in|across|for)\s+(?:these|the\s+supplied)\s+(?:records|rows)(?:\s+where\s+([A-Za-z_$][\w$]*)\s+is\s+(true|false))?(?:\s+grouped\s+by\s+([A-Za-z_$][\w$]*))?$/i.exec(
      q,
    );
  if (!aggregate || !Array.isArray(value) || !value.length) return false;
  return value.every(
    (row) =>
      record(row) &&
      Object.hasOwn(row, aggregate[1]) &&
      typeof row[aggregate[1]] === "number" &&
      Number.isFinite(row[aggregate[1]]) &&
      (!aggregate[2] ||
        (Object.hasOwn(row, aggregate[2]) &&
          typeof row[aggregate[2]] === "boolean")) &&
      (!aggregate[4] ||
        (Object.hasOwn(row, aggregate[4]) &&
          ["string", "number", "boolean"].includes(typeof row[aggregate[4]]))),
  );
}

function readCode(query: string, source: string): boolean {
  if (
    !/^(?:what\s+(?:does|will)\s+(?:this|the\s+supplied)\s+(?:javascript\s+)?code\s+(?:print|log)|(?:read\s+(?:this|the\s+supplied)\s+code\s+and\s+)?(?:say|report|return)\s+what\s+(?:it|this\s+code)\s+(?:prints|logs)|explain\s+(?:this|the\s+supplied)\s+code)$/i.test(
      question(query),
    )
  )
    return false;
  if (
    /`|\b(?:function|class|import|export|require|async|await|new|with|while|for|eval|process|globalThis|fetch)\b|=>/.test(
      source,
    )
  )
    return false;
  try {
    new Script(source);
  } catch {
    return false;
  }
  const masked = source.replace(
    /"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\/\*[\s\S]*?\*\/|\/\/[^\n]*/g,
    (part) => " ".repeat(part.length),
  );
  const declarations = new Set(
    [...masked.matchAll(/\b(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=/g)].map(
      (match) => match[1],
    ),
  );
  if (!declarations.size || !/\bconsole\s*\.\s*log\s*\(/.test(masked))
    return false;
  const callsMasked = masked.replace(
    /\bconsole\s*\.\s*log\s*\(/g,
    (call) => `${" ".repeat(call.length - 1)}(`,
  );
  // Console is an ambient object. Only the direct output call above is known;
  // treating it as a value or reading any other member requires runtime facts.
  if (/\bconsole\b/.test(callsMasked)) return false;
  const allowed = new Set([
    "const",
    "let",
    "true",
    "false",
    "null",
    "undefined",
  ]);
  for (const match of callsMasked.matchAll(/[A-Za-z_$][\w$]*/g)) {
    const before = callsMasked.slice(0, match.index).trimEnd().slice(-1);
    const after = callsMasked
      .slice(match.index + match[0].length)
      .trimStart()[0];
    if (
      before === "." ||
      after === ":" ||
      allowed.has(match[0]) ||
      declarations.has(match[0])
    )
      continue;
    return false;
  }
  // Only the standard console output call is admitted; arbitrary methods can
  // depend on runtime state or omitted definitions even with balanced syntax.
  return !/(?:\b[A-Za-z_$][\w$]*\s*\(|\]\s*\(|\)\s*\()/.test(callsMasked);
}

function readText(query: string, source: string): boolean {
  if (!source.trim()) return false;
  return /^(?:summarize\s+(?:this|the\s+supplied)\s+text|turn\s+(?:these|the\s+supplied)\s+notes\s+into\s+bullets|remove\s+duplicate\s+words\s+from\s+(?:this|the\s+supplied)\s+text|count\s+(?:words|characters|lines)\s+in\s+(?:this|the\s+supplied)\s+text|count\s+(?:the\s+)?(?:word|character)\s+["'`]?[A-Za-z]+["'`]?\s+in\s+(?:this|the\s+supplied)\s+text)$/i.test(
    question(query),
  );
}

function suppliedRoutine(prompt: string): boolean {
  if (arithmetic(prompt)) return true;
  const fence = /```(?:json|javascript|js|text|txt)?\s*\n([\s\S]*?)```/.exec(
    prompt,
  );
  if (fence && prompt.match(/```/g)?.length === 2) {
    const query = `${prompt.slice(0, fence.index)} ${prompt.slice(fence.index + fence[0].length)}`;
    const literal = parseLiteral(fence[1].trim());
    return (
      (!!literal && readLiteral(query, literal.value)) ||
      readCode(query, fence[1]) ||
      readText(query, fence[1])
    );
  }
  const colon = prompt.indexOf(":");
  if (colon !== -1) {
    const query = prompt.slice(0, colon);
    const source = prompt
      .slice(colon + 1)
      .trim()
      .replace(/[.!?]$/, "")
      .trim();
    const literal = parseLiteral(source);
    if (literal && readLiteral(query, literal.value)) return true;
    if (readCode(query, source) || readText(query, source)) return true;
  }
  const inline = /`([^`]+)`/.exec(prompt);
  if (inline && prompt.match(/`/g)?.length === 2) {
    return readCode(
      `${prompt.slice(0, inline.index)} ${prompt.slice(inline.index + inline[0].length)}`,
      inline[1],
    );
  }
  return false;
}

function referencedRoutine(
  prompt: string,
  reference: RegExp,
  source: string,
): boolean {
  const scalar = /^[+-]?(?:\d+(?:\.\d+)?|\.\d+)$/.test(source.trim());
  if (scalar && arithmetic(prompt.replace(reference, `(${source.trim()})`)))
    return true;
  const literal = parseLiteral(source.trim());
  const query = prompt.replace(reference, "this JSON");
  return (
    (!!literal && readLiteral(query, literal.value)) ||
    readText(prompt.replace(reference, "this text"), source)
  );
}

// Presentation clauses carry no task facts. Each admitted clause is closed;
// unfamiliar instructions are never discarded to make a routine look complete.
const formattingClauses = [
  "Return exactly one valid JSON object, with no Markdown, explanation, or additional keys",
  "Use the exact requested field names; preserve array order unless the task requests sorting",
  "(?:Return|Output|Emit|Respond with) (?:only )?(?:valid )?JSON(?: only)?",
  "Output format: (?:JSON|plain text)",
  "Return only (?:the )?(?:integer|number|answer|result)",
  "Do not include (?:Markdown|code fences|explanation|explanations|prose)",
];

function stripFormatting(text: string): string {
  let remaining = text.trim();
  // A small fixed number also bounds repeated presentation envelopes.
  for (let count = 0; count < 8; count++) {
    let changed = false;
    for (const clause of formattingClauses) {
      const flexible = clause.replace(/ /g, "\\s+");
      const prefix = new RegExp(
        `^(?:${flexible})(?:[.!](?:\\s+|$)|\\n+|$)`,
        "i",
      );
      const suffix = new RegExp(`(?:^|\\s+)(?:${flexible})[.!]?$`, "i");
      const next = remaining.replace(prefix, "").replace(suffix, "").trim();
      if (next !== remaining) {
        remaining = next;
        changed = true;
        break;
      }
    }
    if (!changed) break;
  }
  return remaining;
}

function onlyFormatting(text: string): boolean {
  return stripFormatting(text) === "";
}

function formatValue(value: unknown): boolean {
  if (typeof value === "string")
    return /^(?:json|json_object|plain_text|plain text|text)$/i.test(value);
  return (
    record(value) &&
    Object.keys(value).length === 1 &&
    value.type === "json_object"
  );
}

function jsonRequest(text: string): { task?: string; declared: boolean } {
  if (!/^[{[]/.test(text)) return { declared: false };
  const literal = parseLiteral(text);
  if (!literal) return { declared: false };
  let envelope: unknown;
  try {
    envelope = JSON.parse(text);
  } catch {
    return { declared: false };
  }
  if (!record(envelope) && !Array.isArray(envelope)) return { declared: false };

  function formatted(
    object: Record<string, unknown>,
    allowed: readonly string[],
  ): boolean {
    if (!Object.keys(object).every((key) => allowed.includes(key)))
      return false;
    return ["output_format", "response_format"].every(
      (key) => !Object.hasOwn(object, key) || formatValue(object[key]),
    );
  }
  if (
    record(envelope) &&
    typeof envelope.content === "string" &&
    Object.hasOwn(envelope, "role")
  ) {
    return {
      declared: true,
      task:
        envelope.role === "user" &&
        formatted(envelope, [
          "role",
          "content",
          "output_format",
          "response_format",
        ])
          ? envelope.content
          : undefined,
    };
  }
  if (
    record(envelope) &&
    (Object.hasOwn(envelope, "request") || Object.hasOwn(envelope, "task"))
  ) {
    const key = Object.hasOwn(envelope, "request") ? "request" : "task";
    return {
      declared: true,
      task:
        typeof envelope[key] === "string" &&
        formatted(envelope, [key, "output_format", "response_format"])
          ? envelope[key]
          : undefined,
    };
  }
  const messages = Array.isArray(envelope) ? envelope : envelope.messages;
  if (!Array.isArray(messages)) return { declared: false };
  if (
    record(envelope) &&
    !formatted(envelope, ["messages", "output_format", "response_format"])
  )
    return { declared: true };
  if (!messages.length || messages.length > 2) return { declared: true };
  let task: string | undefined;
  for (const message of messages) {
    if (
      !record(message) ||
      Object.keys(message).some((key) => !["role", "content"].includes(key)) ||
      typeof message.content !== "string"
    )
      return { declared: true };
    if (message.role === "user" && task === undefined) task = message.content;
    else if (message.role !== "system" || !onlyFormatting(message.content))
      return { declared: true };
  }
  return { declared: true, task };
}

function declaredTask(text: string): { task?: string; declared: boolean } {
  const json = jsonRequest(text);
  if (json.declared) return json;
  const xml = /<(request|task|user_request)>([\s\S]*?)<\/\1>/i.exec(text);
  if (xml) {
    const markers = text.match(/<\/?(?:request|task|user_request)>/gi);
    const outer = `${text.slice(0, xml.index)}\n${text.slice(xml.index + xml[0].length)}`;
    return {
      declared: true,
      task: markers?.length === 2 && onlyFormatting(outer) ? xml[2] : undefined,
    };
  }
  const pairs = [
    ["--- BEGIN REQUEST ---", "--- END REQUEST ---"],
    ["--- REQUEST ---", "--- END REQUEST ---"],
    ["[REQUEST]", "[/REQUEST]"],
    ["<<<REQUEST>>>", "<<<END REQUEST>>>"],
    ["BEGIN REQUEST", "END REQUEST"],
    ["BEGIN TASK", "END TASK"],
  ];
  const upper = text.toUpperCase();
  for (const [open, close] of pairs) {
    const start = upper.indexOf(open);
    if (start === -1) continue;
    const end = upper.indexOf(close, start + open.length);
    const outer = `${text.slice(0, start)}\n${end === -1 ? "" : text.slice(end + close.length)}`;
    const unique =
      upper.indexOf(open, start + open.length) === -1 &&
      end !== -1 &&
      upper.indexOf(close, end + close.length) === -1;
    return {
      declared: true,
      task:
        unique && onlyFormatting(outer)
          ? text.slice(start + open.length, end)
          : undefined,
    };
  }
  const label =
    /^(?:(?:the\s+)?user\s+request(?:\s+is)?|request|task)(?:\s*\(quoted\))?\s*:\s*/i.exec(
      text,
    );
  if (label) {
    const body = text.slice(label[0].length).trim();
    const quote = /^("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')([\s\S]*)$/.exec(body);
    if (quote) {
      const literal = parseLiteral(quote[1]);
      return {
        declared: true,
        task:
          typeof literal?.value === "string" && onlyFormatting(quote[2])
            ? literal.value
            : undefined,
      };
    }
    return { declared: true, task: body };
  }
  return { declared: false };
}

function separateRoutineTask(text: string): string | undefined {
  let task = text;
  for (let depth = 0; depth < 4; depth++) {
    const stripped = stripFormatting(task);
    const wrapper = declaredTask(stripped);
    if (!wrapper.declared) return stripped;
    if (wrapper.task === undefined || !wrapper.task.trim()) return undefined;
    task = wrapper.task;
  }
  return undefined;
}

/**
 * Verifies only a limited routine syntax against observed source. No classifier
 * score, label, or claim that everything is supplied can establish completeness.
 * A positive result is not evidence of model quality or downstream correctness.
 */
export function verifyRoutingCompleteness(
  input: RoutingCompletenessInput,
): RoutingCompleteness {
  if (!record(input) || typeof input.prompt !== "string")
    return unknown("invalid-input");
  const limits = ROUTING_COMPLETENESS_LIMITS;
  if (input.prompt.length > limits.promptCharacters)
    return unknown("source-capacity-exceeded");
  const sourceFields = [input.prompt];
  let aggregateCharacters = input.prompt.length;
  let previous = "";
  if (input.previousExchange !== undefined) {
    if (typeof input.previousExchange === "string") {
      if (input.previousExchange.length > limits.previousExchangeCharacters)
        return unknown("source-capacity-exceeded");
      previous = input.previousExchange;
      sourceFields.push(previous);
      aggregateCharacters += previous.length;
    } else if (
      record(input.previousExchange) &&
      typeof input.previousExchange.user === "string" &&
      typeof input.previousExchange.assistant === "string"
    ) {
      const { user, assistant } = input.previousExchange;
      if (user.length + assistant.length > limits.previousExchangeCharacters)
        return unknown("source-capacity-exceeded");
      previous = input.previousExchange.assistant;
      sourceFields.push(user, assistant);
      aggregateCharacters += user.length + assistant.length;
    } else return unknown("invalid-previous-exchange");
  }
  if (input.toolResults !== undefined && !Array.isArray(input.toolResults))
    return unknown("invalid-tool-results");
  const tools = input.toolResults ?? [];
  if (tools.length > limits.toolResults)
    return unknown("source-capacity-exceeded");
  const ids = new Set<string>();
  for (const tool of tools) {
    if (
      !record(tool) ||
      typeof tool.toolCallId !== "string" ||
      typeof tool.text !== "string" ||
      (tool.isError !== undefined && typeof tool.isError !== "boolean")
    )
      return unknown("invalid-tool-results");
    if (
      tool.toolCallId.length > limits.toolIdCharacters ||
      tool.text.length > limits.toolTextCharacters
    )
      return unknown("source-capacity-exceeded");
    aggregateCharacters += tool.toolCallId.length + tool.text.length;
    if (aggregateCharacters > limits.aggregateCharacters)
      return unknown("source-capacity-exceeded");
    if (!tool.toolCallId.trim() || ids.has(tool.toolCallId))
      return unknown("invalid-tool-results");
    ids.add(tool.toolCallId);
    sourceFields.push(tool.toolCallId, tool.text);
  }
  // Bound every field and the aggregate before normalization, regexp scans,
  // syntax compilation, or recursive literal parsing of any supplied source.
  if (aggregateCharacters > limits.aggregateCharacters)
    return unknown("source-capacity-exceeded");
  if (
    sourceFields.some(
      (text) =>
        !wellFormedUtf16(text) ||
        /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text),
    )
  )
    return unknown("invalid-source-encoding");
  if (!normalize(input.prompt)) return unknown("invalid-input");
  const originalPrompt = input.prompt;
  if (routeInstruction.test(normalize(originalPrompt)))
    return unknown("routing-instruction-in-input");
  if (missingFacts.test(normalize(originalPrompt)))
    return unknown("explicit-missing-facts");
  if (incompleteSource.test(originalPrompt))
    return unknown("incomplete-source");
  const prompt = separateRoutineTask(originalPrompt);
  if (prompt === undefined) return unknown("unverified-request-wrapper");
  // Decoded JSON/quoted task strings receive the same checks as raw source.
  if (
    !wellFormedUtf16(prompt) ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(prompt)
  )
    return unknown("invalid-source-encoding");
  if (routeInstruction.test(normalize(prompt)))
    return unknown("routing-instruction-in-input");
  if (missingFacts.test(normalize(prompt)))
    return unknown("explicit-missing-facts");
  if (incompleteSource.test(prompt)) return unknown("incomplete-source");
  if (suppliedRoutine(prompt))
    return {
      verified: true,
      reason: "self-contained-routine",
      evidenceKind: "prompt-literal",
    };

  const priorReference =
    /\b(?:the\s+)?(?:previous|prior|last)\s+(?:result|answer|output|json|text)\b/gi;
  if (
    priorReference.test(prompt) &&
    previous.trim() &&
    !routeInstruction.test(normalize(previous)) &&
    !incompleteSource.test(previous) &&
    referencedRoutine(prompt, priorReference, previous)
  )
    return {
      verified: true,
      reason: "observed-previous-source",
      evidenceKind: "previous-exchange",
    };
  for (const tool of tools) {
    const escaped = tool.toolCallId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const reference = new RegExp(
      `\\b(?:the\\s+)?tool\\s+result\\s+["'\x60]?${escaped}["'\x60]?(?![\\w-])`,
      "gi",
    );
    if (
      !tool.isError &&
      reference.test(prompt) &&
      !routeInstruction.test(normalize(tool.text)) &&
      !incompleteSource.test(tool.text) &&
      referencedRoutine(prompt, reference, tool.text)
    )
      return {
        verified: true,
        reason: "observed-matching-tool-source",
        evidenceKind: "tool-result",
      };
  }
  if (
    /\b(?:previous|prior|last|earlier|above|attached|attachment|screenshot|image|document|file|choices|options)\b/i.test(
      prompt,
    )
  )
    return unknown("unverified-referenced-source");
  return unknown("unsupported-or-unverified-routine");
}
