import { afterEach, expect, it, vi } from 'vitest';
import { createFieldReader, FIELD_READ_TIMEOUT_MS } from '../../src/campus/field-data.js';

afterEach(() => vi.useRealTimers());

it('bypasses shared public cache only for explicitly forced reads', async () => {
  const fetcher = vi.fn(async () => ({ ok: false, status: 503 }));
  const reader = createFieldReader(() => {}, fetcher);
  await reader.read({ placeId: 'library', mode: 'live' });
  await reader.read({ placeId: 'library', mode: 'live', forceRefresh: true });
  expect(fetcher.mock.calls[0][1]).toEqual({ signal: expect.any(AbortSignal) });
  expect(fetcher.mock.calls[1][1]).toEqual({ signal: expect.any(AbortSignal), headers: { 'Cache-Control': 'no-cache' } });
});

it('bounds stalled public reads, aborts their transport and allows a retry', async () => {
  vi.useFakeTimers();
  const states = [], signals = [];
  const fetcher = vi.fn((path, init) => {
    signals.push(init.signal);
    return signals.length === 1 ? new Promise(() => {}) : Promise.resolve({ ok: false, status: 503 });
  });
  const reader = createFieldReader(state => states.push(state), fetcher);
  const pending = reader.read({ placeId: 'library', mode: 'live' });
  await vi.advanceTimersByTimeAsync(FIELD_READ_TIMEOUT_MS);
  await pending;
  expect(signals[0].aborted).toBe(true);
  expect(states.at(-1)).toEqual({ loading: false, data: null, error: '现场读取超时，请刷新重试' });
  await reader.read({ placeId: 'library', mode: 'live' });
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(states.at(-1).error).toContain('503');
  expect(vi.getTimerCount()).toBe(0);
});

it('never publishes a timeout after cancelling the owning scope', async () => {
  vi.useFakeTimers();
  const states = [];
  const reader = createFieldReader(state => states.push(state), () => new Promise(() => {}));
  const pending = reader.read({ placeId: 'library', mode: 'live' });
  reader.cancel();
  await vi.advanceTimersByTimeAsync(FIELD_READ_TIMEOUT_MS);
  await pending;
  expect(states).toEqual([{ loading: true, data: null, error: '' }]);
});
