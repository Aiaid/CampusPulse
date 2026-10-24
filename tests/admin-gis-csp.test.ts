import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';

// Check the deployed response-header source, rather than a second test-only CSP.
const headersFile = readFileSync(new URL('../public/_headers', import.meta.url), 'utf8');
const rules = new Map(headersFile.trim().split(/\n\s*\n/).map(block => {
  const [path, ...headers] = block.split('\n');
  return [path, new Map(headers.map(line => {
    const colon = line.indexOf(':');
    return [line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim()];
  }))];
}));

describe('admin GIS response security policy', () => {
  test.each(['/admin', '/admin/*'])('%s permits only the official cross-origin GIS images', path => {
    const policy = rules.get(path)?.get('content-security-policy');
    expect(policy).toBeDefined();
    const directives = new Map(policy!.split(';').map(directive => {
      const [name, ...sources] = directive.trim().split(/\s+/);
      return [name, sources];
    }));
    expect(directives.get('img-src')).toEqual(["'self'", 'data:', 'https://gis.ccnu.edu.cn']);
    for (const name of ['default-src', 'script-src', 'font-src', 'connect-src', 'form-action']) {
      expect(directives.get(name), name).toEqual(["'self'"]);
    }
    for (const name of ['base-uri', 'frame-ancestors']) {
      expect(directives.get(name), name).toEqual(["'none'"]);
    }
    expect(rules.get(path)?.get('x-frame-options')).toBe('DENY');
    expect(rules.get(path)?.get('referrer-policy')).toBe('no-referrer');
    expect(rules.get(path)?.get('cache-control')).toBe('no-store');
  });
});
