/** Strict, duplicate-key rejecting JSON parsing shared by device and business APIs. */
export class IngestError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'IngestError';
    this.status = status;
    this.code = code;
  }
}
const malformed = (code: string) => new IngestError(400, code, 'Invalid JSON request body.');

/** Scan JSON grammar before JSON.parse so duplicate decoded keys cannot be silently overwritten. */
export function parseIngestJson(bytes: Uint8Array): unknown {
  let input: string;
  try { input = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { throw malformed('invalid_utf8'); }
  let i = 0;
  const space = () => { while (i < input.length && /[\x20\t\r\n]/.test(input[i])) i++; };
  const string = (): string => {
    const start = i++;
    while (i < input.length) {
      const c = input[i++];
      if (c === '"') {
        try { return JSON.parse(input.slice(start, i)) as string; }
        catch { throw malformed('invalid_json'); }
      }
      if (c === '\\') {
        if (i >= input.length) throw malformed('invalid_json');
        if (input[i] === 'u') i += 5;
        else i++;
      } else if (c.charCodeAt(0) < 0x20) throw malformed('invalid_json');
    }
    throw malformed('invalid_json');
  };
  const value = (depth: number): void => {
    if (depth > 64) throw malformed('invalid_json');
    space();
    const c = input[i];
    if (c === '{') {
      i++; space();
      const seen = new Set<string>();
      if (input[i] === '}') { i++; return; }
      while (true) {
        if (input[i] !== '"') throw malformed('invalid_json');
        const key = string();
        if (seen.has(key)) throw malformed('duplicate_json_key');
        seen.add(key); space();
        if (input[i++] !== ':') throw malformed('invalid_json');
        value(depth + 1); space();
        if (input[i] === '}') { i++; return; }
        if (input[i++] !== ',') throw malformed('invalid_json');
        space();
      }
    }
    if (c === '[') {
      i++; space();
      if (input[i] === ']') { i++; return; }
      while (true) {
        value(depth + 1); space();
        if (input[i] === ']') { i++; return; }
        if (input[i++] !== ',') throw malformed('invalid_json');
      }
    }
    if (c === '"') { string(); return; }
    const token = /^(?:-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)/.exec(input.slice(i));
    if (!token) throw malformed('invalid_json');
    i += token[0].length;
  };
  value(0); space();
  if (i !== input.length) throw malformed('invalid_json');
  try { return JSON.parse(input) as unknown; }
  catch { throw malformed('invalid_json'); }
}

