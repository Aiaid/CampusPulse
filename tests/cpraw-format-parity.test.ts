import { expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CprawValidator } from '../worker/cpraw-format';
import { concatCpraw, cprawFrame, cprawHeader, cprawReport } from './helpers/cpraw-fixtures';

it('matches the firmware Python decoder on the same synthetic byte fixtures', () => {
  const anchor = new Uint8Array(21); anchor[20] = 2;
  const valid = concatCpraw(cprawHeader(), cprawReport(), cprawReport(1650, true),
    cprawFrame(2, new Uint8Array(56)), cprawFrame(3, new Uint8Array(16)), cprawFrame(4, anchor));
  const damaged = valid.slice(); damaged[damaged.length - 1] ^= 1;
  const hidden = new Uint8Array(8); new DataView(hidden.buffer).setUint32(0, 1728, true);
  const fixtures = [valid, new Uint8Array(), cprawHeader().slice(0, 31), damaged,
    valid.slice(0, -1), concatCpraw(cprawHeader(), hidden, cprawReport()),
    concatCpraw(cprawHeader(), cprawFrame(99, new Uint8Array(12)))];
  const directory = mkdtempSync(join(tmpdir(), 'cpraw-parity-'));
  try {
    const paths = fixtures.map((bytes, index) => {
      const path = join(directory, `${index}.bin`); writeFileSync(path, bytes, { mode: 0o600 }); return path;
    });
    const script = `import importlib.util,json,pathlib,sys
spec=importlib.util.spec_from_file_location('cpraw_decoder',sys.argv[1])
module=importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
results=[]
for path in sys.argv[2:]:
 try:
  decoded=module.decode(pathlib.Path(path).read_bytes())
  results.append({'status':'interrupted_tail' if decoded['truncated_offset'] is not None else 'valid','valid_bytes':decoded['valid_bytes'],'reports':decoded['reports'],'truncated_offset':decoded['truncated_offset']})
 except module.FormatError:
  results.append({'status':'invalid'})
print(json.dumps(results))`;
    const output = execFileSync('uv', ['run', '--no-project', 'python', '-c', script,
      new URL('../firmware/waveshare-raw/tools/decode.py', import.meta.url).pathname, ...paths],
    { encoding: 'utf8', env: { ...process.env, UV_CACHE_DIR: join(directory, 'uv-cache'), UV_PYTHON_DOWNLOADS: 'never' } });
    const expected = JSON.parse(output) as { status: string; valid_bytes?: number; reports?: number; truncated_offset?: number | null }[];
    fixtures.forEach((bytes, index) => {
      const parser = new CprawValidator();
      for (let offset = 0; offset < bytes.length; offset += 37) parser.write(bytes.subarray(offset, offset + 37));
      expect(parser.finish()).toMatchObject(expected[index]);
    });
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
