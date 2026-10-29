// Poll only while the page can be seen. Schedule from completion rather than
// setInterval so a slow endpoint never accumulates or aborts overlapping reads.
export function createVisiblePoller(read, intervalMs, { page = document, host = window } = {}) {
  let timer = null;
  let pending = null;
  let followup = false;
  let followupForce = false;
  let forceOnResume = false;
  let stopped = false;
  let lastStarted = -Infinity;
  let needsResume = page.visibilityState === 'hidden';
  const visible = () => page.visibilityState !== 'hidden';
  const clear = () => { if (timer !== null) host.clearTimeout(timer); timer = null; };
  const schedule = () => {
    clear();
    if (!stopped && visible()) timer = host.setTimeout(refresh, intervalMs);
  };
  const completed = () => {
    pending = null;
    if (followup) {
      const forceRefresh = followupForce;
      followup = false; followupForce = false;
      refresh({ forceRefresh });
    } else schedule();
  };
  function refresh({ afterPending = false, forceRefresh = false } = {}) {
    if (stopped) return pending;
    if (!visible()) { forceOnResume ||= forceRefresh; return pending; }
    forceRefresh ||= forceOnResume;
    forceOnResume = false;
    // A successful write can race an older read. Queue one subsequent read
    // for that case; ordinary focus/timer events only join the current one.
    if (pending) {
      followup ||= afterPending || forceRefresh;
      followupForce ||= forceRefresh;
      return pending;
    }
    clear();
    lastStarted = Date.now();
    pending = Promise.resolve().then(() => { if (!stopped) return read({ forceRefresh }); }).then(
      completed,
      completed,
    );
    return pending;
  }
  // Browsers commonly dispatch visibilitychange and focus for one return.
  // Coalesce that pair without suppressing an explicit manual refresh.
  const wake = () => { if (visible() && Date.now() - lastStarted >= 1000) refresh(); };
  const visibility = () => {
    if (visible()) {
      if (needsResume) { needsResume = false; refresh(); } else wake();
      if (!pending) schedule();
    } else { needsResume = true; clear(); }
  };
  page.addEventListener('visibilitychange', visibility);
  host.addEventListener('focus', wake);
  refresh();
  return {
    refresh,
    stop() { stopped = true; clear(); page.removeEventListener('visibilitychange', visibility); host.removeEventListener('focus', wake); },
  };
}
