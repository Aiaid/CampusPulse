import { describe, expect, it } from 'vitest';
import { IngestError, parseIngestJson } from '../worker/strict-json';

const err = (fn: () => unknown, status = 422) => {
  try { fn(); throw new Error('Expected rejection'); }
  catch (error) {
    expect(error).toBeInstanceOf(IngestError);
    expect((error as IngestError).status).toBe(status);
  }
};

describe('byte-level JSON parsing', () => {
  const parse = (text: string) => parseIngestJson(new TextEncoder().encode(text));
  it('rejects duplicate keys at every depth, including escaped equivalents', () => {
    err(() => parse('{"a":1,"a":2}'), 400);
    err(() => parse('{"items":[{"time":{"mono_ms":1,"mono\\u005fms":2}}]}'), 400);
    err(() => parse('{"a":{},"b":{"x":1,"\\u0078":2}}'), 400);
    expect(parse('{"a":{"x":1},"b":{"x":2}}')).toEqual({ a: { x: 1 }, b: { x: 2 } });
  });
  it('rejects invalid UTF-8, malformed strings, and trailing JSON', () => {
    err(() => parseIngestJson(new Uint8Array([0x7b, 0xff, 0x7d])), 400);
    for (const value of ['{"a":"\\q"}', '{"a":1,}', '{"a":1}[]', '[1,]', '{"a":01}', '{"a":"\n"}']) {
      err(() => parse(value), 400);
    }
  });
});

