import {
  InvalidRequest,
  validateRequest,
  INPUT_LIMIT_BYTES,
  INPUT_DEPTH_LIMIT,
  type Request,
} from "./core.js";
// A small JSON reader keeps lexical object order separately from JS enumeration.
// JSON.parse still owns scalar syntax/escaping; duplicate object keys are rejected.
class OrderedObject {
  constructor(public pairs: [string, unknown][]) {}
}
export function parseHttpRequest(source: string): Request {
  if (Buffer.byteLength(source) > INPUT_LIMIT_BYTES)
    throw new InvalidRequest("Request exceeds input byte limit");
  let i = 0;
  const ws = () => {
    while (/[ \t\r\n]/.test(source[i] ?? "") && i < source.length) i++;
  };
  const string = () => {
    const start = i++;
    while (i < source.length) {
      if (source[i] === "\\") {
        i += 2;
        continue;
      }
      if (source[i++] === '"')
        return JSON.parse(source.slice(start, i)) as string;
    }
    throw new InvalidRequest("Unterminated JSON string");
  };
  const read = (depth = 0): unknown => {
    if (depth > INPUT_DEPTH_LIMIT)
      throw new InvalidRequest("Request exceeds nesting depth limit");
    ws();
    const c = source[i];
    if (c === '"') return string();
    if (c === "{") {
      i++;
      ws();
      const pairs: [string, unknown][] = [];
      const keys = new Set<string>();
      if (source[i] === "}") {
        i++;
        return new OrderedObject(pairs);
      }
      while (true) {
        ws();
        if (source[i] !== '"') throw new InvalidRequest("Expected JSON key");
        const key = string();
        if (keys.has(key)) throw new InvalidRequest("Duplicate JSON key");
        keys.add(key);
        ws();
        if (source[i++] !== ":") throw new InvalidRequest("Expected colon");
        pairs.push([key, read(depth + 1)]);
        ws();
        const sep = source[i++];
        if (sep === "}") break;
        if (sep !== ",") throw new InvalidRequest("Expected comma");
      }
      return new OrderedObject(pairs);
    }
    if (c === "[") {
      i++;
      ws();
      const a: unknown[] = [];
      if (source[i] === "]") {
        i++;
        return a;
      }
      while (true) {
        a.push(read(depth + 1));
        ws();
        const sep = source[i++];
        if (sep === "]") break;
        if (sep !== ",") throw new InvalidRequest("Expected comma");
      }
      return a;
    }
    const start = i;
    while (i < source.length && !/[\s,}\]]/.test(source[i])) i++;
    if (start === i) throw new InvalidRequest("Invalid JSON");
    return JSON.parse(source.slice(start, i));
  };
  const plain = (v: unknown): any =>
    v instanceof OrderedObject
      ? Object.fromEntries(v.pairs.map(([k, x]) => [k, plain(x)]))
      : Array.isArray(v)
        ? v.map(plain)
        : v;
  try {
    const parsed = read();
    ws();
    if (i !== source.length || !(parsed instanceof OrderedObject))
      throw new InvalidRequest("Expected one JSON object");
    const r = plain(parsed);
    const questions = parsed.pairs.find(([k]) => k === "questions")?.[1];
    if (!(questions instanceof OrderedObject))
      throw new InvalidRequest("Expected questions object", "questions");
    r.questions = questions.pairs.map(([id, q]) => {
      if (!(q instanceof OrderedObject))
        throw new InvalidRequest("Expected question");
      const result = plain(q);
      if (Object.hasOwn(result, "id"))
        throw new InvalidRequest(
          "Unknown question field",
          "questions." + id + ".id",
        );
      if (result.type === "choice") {
        const c = q.pairs.find(([k]) => k === "criteria")?.[1];
        if (!(c instanceof OrderedObject))
          throw new InvalidRequest("Expected choice criteria object");
        result.criteria = c.pairs.map(([id, d]) => ({
          id,
          description: plain(d),
        }));
      }
      return { ...result, id };
    });
    return validateRequest(r);
  } catch (e) {
    if (e instanceof InvalidRequest) throw e;
    throw new InvalidRequest("Invalid JSON");
  }
}
