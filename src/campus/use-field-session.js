import { useEffect, useRef, useState } from 'react';
import { createFieldReader, FIELD_REFRESH_MS } from './field-data';
import { advanceLiveFieldRead } from './last-observation';

const empty = { data: null, loading: false, error: '', scope: '' };

// One public read session powers both the shared axis and the detail cards.
// Cursor ownership stays with the parent so a refresh cannot move a scrubbed time.
export function useFieldSession(placeId, enabled, minutes) {
  const [live, setLive] = useState(empty);
  const [history, setHistory] = useState(empty);
  const [revision, setRevision] = useState(0);
  const [now, setNow] = useState(Date.now);
  const lastLive = useRef(null);
  const scope = `${enabled ? placeId || '' : ''}:${minutes}`;

  useEffect(() => {
    if (!enabled || !placeId) return;
    if (lastLive.current?.placeId !== placeId) lastLive.current = null;
    const publish = setter => next => setter(previous => ({ ...next,
      data: next.loading && previous.scope === scope ? previous.data : next.data,
      scope,
    }));
    const summaryReader = createFieldReader(next => {
      const { cache, read } = advanceLiveFieldRead(next, lastLive.current, placeId, Date.now());
      lastLive.current = cache;
      setLive({ ...read, scope });
    });
    const historyReader = createFieldReader(publish(setHistory));
    summaryReader.read({ placeId, mode: 'live' });
    historyReader.read({ placeId, mode: 'replay', minutes });
    return () => { summaryReader.cancel(); historyReader.cancel(); };
  }, [placeId, enabled, minutes, revision, scope]);

  useEffect(() => {
    if (!enabled || !placeId) return;
    const refresh = () => { setNow(Date.now()); setRevision(value => value + 1); };
    const visible = () => { if (document.visibilityState === 'visible') refresh(); };
    const timer = setInterval(refresh, FIELD_REFRESH_MS);
    const clock = setInterval(() => setNow(Date.now()), 1000);
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', visible);
    return () => { clearInterval(timer); clearInterval(clock); window.removeEventListener('focus', refresh); document.removeEventListener('visibilitychange', visible); };
  }, [placeId, enabled]);

  const current = state => state.scope === scope ? state : { ...empty, loading: enabled && !!placeId };
  return { live: current(live), history: current(history), now,
    refresh: () => { setNow(Date.now()); setRevision(value => value + 1); },
  };
}
