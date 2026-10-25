import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

describe('dependency-free elevator rule and private-store regressions', () => {
  it.each([
    ['rule episodes and v2 projection', ['tests/elevator-cohort/rules.checks.mjs']],
    ['real SQLite committed streams', ['--experimental-transform-types', 'tests/elevator-cohort-store.checks.mjs']],
  ] as const)('%s', (_name, args) => {
    const result = spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 20000 });
    expect(result.error, result.stderr).toBeUndefined();
    expect(result.status, result.stdout + result.stderr).toBe(0);
  });
});
