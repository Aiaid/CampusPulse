import { useCallback, useEffect, useMemo, useState } from 'react';
import { controlledWindowIndex, createControlledReplayReader } from './controlled-replay-data';

const empty = { id: null, loading: false, data: null, error: '', unauthorized: false };

export function useControlledReplay(id) {
  const [state, setState] = useState(empty);
  const [selection, setSelection] = useState({ id, index: 0 });
  const [playSource, setPlaySource] = useState(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const reader = useMemo(() => createControlledReplayReader(setState), []);
  useEffect(() => {
    if (id !== null) void reader.read(id);
    return () => reader.cancel();
  }, [id, reader, refreshKey]);
  const scoped = id !== null && state.id === id ? state : { ...empty, id, loading: id !== null };
  const count = scoped.data?.windows.length || 0;
  const index = controlledWindowIndex(selection.id === id ? selection.index : 0, count);
  const playing = count > 1 && playSource === id;
  useEffect(() => {
    if (!playing) return;
    const timer = setInterval(() => {
      setSelection(current => {
        const next = controlledWindowIndex(current.id === id ? current.index : 0, count) + 1;
        return { id, index: Math.min(count - 1, next) };
      });
    }, 1000);
    return () => clearInterval(timer);
  }, [playing, count, id]);
  useEffect(() => { if (index >= count - 1) setPlaySource(null); }, [index, count]);
  const seek = useCallback(value => { setPlaySource(null); setSelection({ id, index: controlledWindowIndex(value, count) }); }, [id, count]);
  const togglePlaying = () => {
    if (playing) setPlaySource(null);
    else { if (index >= count - 1) setSelection({ id, index: 0 }); setPlaySource(id); }
  };
  const refresh = () => { setPlaySource(null); setRefreshKey(key => key + 1); };
  return { ...scoped, index, selectedWindow: scoped.data?.windows[index] || null, seek, playing, togglePlaying, refresh };
}
