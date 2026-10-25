// Explicit links make each delivery path reproducible without changing the
// administrator's site-wide default or persisting a previous visitor's mode.
export function initialDataMode(search = '', defaultMode = 'field') {
  const params = new URLSearchParams(search);
  const mode = params.get('mode');
  if (['field', 'replay', 'demo'].includes(mode)) return mode;
  if (params.get('place')) return 'field';
  return defaultMode === 'demo' ? 'demo' : 'field';
}
