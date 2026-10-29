import { useEffect, useRef, useState } from 'react';
import { createFieldReader, FIELD_REFRESH_MS, FIELD_HISTORY_REFRESH_MS } from './field-data';
import { advanceLiveFieldRead } from './last-observation';
import { createVisiblePoller } from './visible-polling';

const empty = { data: null, loading: false, error: '', scope: '' };

// One public read session powers the shared axis, detail cards and record form.
// History has its own cadence; changing its range does not reread live data.
// Cursor ownership stays with the parent so a refresh cannot move a scrubbed time.
export function useFieldSession(placeId, enabled, minutes) {
  const [live, setLive] = useState(empty);
  const [history, setHistory] = useState(empty);
  const [now, setNow] = useState(Date.now);
  const lastLive = useRef(null);
  const livePoll = useRef(null), historyPoll = useRef(null);
  const liveScope = enabled ? placeId || '' : '';
  const historyScope = `${liveScope}:${minutes}`;

  useEffect(() => {
    if (!enabled || !placeId) return;
    if (lastLive.current?.placeId !== placeId) lastLive.current = null;
    const reader = createFieldReader(next => {
      const { cache, read } = advanceLiveFieldRead(next, lastLive.current, placeId, Date.now());
      lastLive.current = cache;
      setLive({ ...read, scope: liveScope });
    });
    const poll = createVisiblePoller(({ forceRefresh }) => reader.read({ placeId, mode: 'live', forceRefresh }), FIELD_REFRESH_MS);
    livePoll.current = poll;
    return () => { poll.stop(); reader.cancel(); if (livePoll.current === poll) livePoll.current = null; };
  }, [placeId, enabled, liveScope]);

  useEffect(() => {
    if (!enabled || !placeId) return;
    const reader = createFieldReader(next => setHistory(previous => ({ ...next,
      data: next.loading && previous.scope === historyScope ? previous.data : next.data,
      scope: historyScope,
    })));
    const poll = createVisiblePoller(({ forceRefresh }) => reader.read({ placeId, mode: 'replay', minutes, forceRefresh }), FIELD_HISTORY_REFRESH_MS);
    historyPoll.current = poll;
    return () => { poll.stop(); reader.cancel(); if (historyPoll.current === poll) historyPoll.current = null; };
  }, [placeId, enabled, minutes, historyScope]);

  useEffect(() => {
    if (!enabled || !placeId) return;
    const tick = () => { if (document.visibilityState !== 'hidden') setNow(Date.now()); };
    tick();
    const clock = setInterval(tick, 1000);
    document.addEventListener('visibilitychange', tick);
    return () => { clearInterval(clock); document.removeEventListener('visibilitychange', tick); };
  }, [placeId, enabled]);

  const current = (state, scope) => enabled && state.scope === scope ? state : { ...empty, loading: enabled && !!placeId };
  return { live: current(live, liveScope), history: current(history, historyScope), now,
    refresh: ({ afterPending = false } = {}) => {
      setNow(Date.now());
      livePoll.current?.refresh({ afterPending, forceRefresh: true });
      historyPoll.current?.refresh({ afterPending, forceRefresh: true });
    },
  };
}
