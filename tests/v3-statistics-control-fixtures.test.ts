import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

it('generates deterministic credential-free control receipts from exact server request bytes', () => {
  const script = fileURLToPath(new URL('../scripts/generate-v3-statistics-control-fixtures.mjs', import.meta.url));
  const run = () => execFileSync(process.execPath, [script], { encoding: 'utf8' });
  const first = run(); expect(run()).toBe(first);
  const fixtures = JSON.parse(first) as Record<string, unknown> & { schema: string };
  expect(fixtures.schema).toBe('v3-statistics-control-fixtures/1');
  for (const kind of ['applied', 'failed', 'lease']) {
    const f = fixtures[kind] as { requestBytes: string; request: Record<string, unknown>; receipt: Record<string, unknown>; body_sha256: string };
    expect(JSON.parse(f.requestBytes)).toEqual(f.request);
    expect(createHash('sha256').update(Buffer.from(f.requestBytes, 'utf8')).digest('hex')).toBe(f.body_sha256);
    expect(f.receipt).toMatchObject({ body_sha256: f.body_sha256, durability: 'committed', node_id: 'synthetic-stats-notregister' });
    expect(f.requestBytes.endsWith('\n')).toBe(false);
    expect(f.receipt.received_at ?? f.receipt.server_time).toBe('2026-10-30T00:00:00.000Z');
    expect(first).not.toMatch(/Bearer|Authorization|Cookie|credential|token_sha256|password_hash/);
  }
  expect((fixtures.failed as { receipt: Record<string, unknown> }).receipt.lease_until_ms).toBeUndefined();
});
