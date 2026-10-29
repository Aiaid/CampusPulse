import { afterEach, describe, expect, it, vi } from 'vitest';
import { createVisiblePoller } from '../../src/campus/visible-polling.js';

function surface(hidden = false) {
  const page = new EventTarget();
  page.visibilityState = hidden ? 'hidden' : 'visible';
  const host = new EventTarget();
  host.setTimeout = setTimeout;
  host.clearTimeout = clearTimeout;
  return { page, host, visibility(hidden) {
    page.visibilityState = hidden ? 'hidden' : 'visible';
    page.dispatchEvent(new Event('visibilitychange'));
  }, focus() { host.dispatchEvent(new Event('focus')); } };
}
const flush = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };
afterEach(() => vi.useRealTimers());

describe('visible public polling', () => {
  it('cancels a queued initial read on immediate cleanup', async () => {
    vi.useFakeTimers();
    const ui = surface(), read = vi.fn();
    const poll = createVisiblePoller(read, 30_000, ui);
    poll.stop();
    await flush();
    expect(read).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('makes no background requests, resumes once for visibility plus focus, and supports manual refresh', async () => {
    vi.useFakeTimers();
    const ui = surface(), read = vi.fn().mockResolvedValue(undefined);
    const poll = createVisiblePoller(read, 30_000, ui);
    await flush();
    expect(read).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(read).toHaveBeenCalledTimes(2);
    ui.visibility(true);
    await vi.advanceTimersByTimeAsync(600_000);
    expect(read).toHaveBeenCalledTimes(2);
    ui.focus();
    expect(read).toHaveBeenCalledTimes(2);
    ui.visibility(false); ui.focus();
    await flush();
    expect(read).toHaveBeenCalledTimes(3);
    await poll.refresh();
    expect(read).toHaveBeenCalledTimes(4);
    poll.stop();
    await vi.advanceTimersByTimeAsync(60_000);
    ui.focus(); ui.visibility(false);
    await flush();
    expect(read).toHaveBeenCalledTimes(4);
  });

  it('does not start hidden, and refreshes after even a brief hidden interval', async () => {
    vi.useFakeTimers();
    const ui = surface(true), read = vi.fn().mockResolvedValue(undefined);
    const poll = createVisiblePoller(read, 30_000, ui);
    await vi.advanceTimersByTimeAsync(100);
    expect(read).not.toHaveBeenCalled();
    ui.visibility(false); await flush();
    ui.visibility(true);
    await vi.advanceTimersByTimeAsync(100);
    ui.visibility(false); ui.focus(); await flush();
    expect(read).toHaveBeenCalledTimes(2);
    poll.stop();
  });

  it('coalesces slow reads and schedules only after completion, including rejection', async () => {
    vi.useFakeTimers();
    const ui = surface();
    let resolve;
    const read = vi.fn().mockImplementationOnce(() => new Promise(done => { resolve = done; })).mockRejectedValueOnce(new Error('offline')).mockResolvedValue(undefined);
    const poll = createVisiblePoller(read, 30_000, ui);
    await flush();
    await vi.advanceTimersByTimeAsync(120_000);
    ui.focus(); ui.visibility(true); ui.visibility(false);
    poll.refresh();
    expect(read).toHaveBeenCalledTimes(1);
    resolve(); await flush();
    await vi.advanceTimersByTimeAsync(29_999);
    expect(read).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(read).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(read).toHaveBeenCalledTimes(3);
    poll.stop();
  });

  it('reads once after a write that raced an in-flight read without overlapping it', async () => {
    vi.useFakeTimers();
    const ui = surface();
    let resolve;
    const read = vi.fn().mockImplementationOnce(() => new Promise(done => { resolve = done; })).mockResolvedValue(undefined);
    const poll = createVisiblePoller(read, 30_000, ui);
    await flush();
    poll.refresh({ afterPending: true, forceRefresh: true });
    poll.refresh({ afterPending: true });
    expect(read).toHaveBeenCalledTimes(1);
    resolve();
    await flush(); await flush();
    expect(read).toHaveBeenCalledTimes(2);
    expect(read.mock.calls.map(([options]) => options.forceRefresh)).toEqual([false, true]);
    poll.stop();
  });

  it('retains a forced refresh through a hidden page until the next visible read', async () => {
    vi.useFakeTimers();
    const ui = surface(true), read = vi.fn().mockResolvedValue(undefined);
    const poll = createVisiblePoller(read, 30_000, ui);
    poll.refresh({ afterPending: true, forceRefresh: true });
    await flush();
    expect(read).not.toHaveBeenCalled();
    ui.visibility(false); ui.focus();
    await flush();
    expect(read.mock.calls.map(([options]) => options.forceRefresh)).toEqual([true]);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(read.mock.calls.map(([options]) => options.forceRefresh)).toEqual([true, false]);
    poll.stop();
  });
});
