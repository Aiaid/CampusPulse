"""ASan/UBSan diagnostic checks using actual shared control and backend fixtures."""
import json
import os
from pathlib import Path
import shlex
import subprocess
import tempfile

HERE = Path(__file__).resolve().parent
HISTORY = HERE.parent
REPO = HISTORY.parents[2]
CONTROL = REPO / 'firmware/components/cp_v3_control'
crypto = shlex.split(subprocess.check_output(['pkg-config', '--cflags', '--libs', 'openssl'], text=True))
with tempfile.TemporaryDirectory(prefix='te-history-') as directory:
    root = Path(directory)
    executable = root / 'history'
    subprocess.run([os.environ.get('CC', 'cc'), '-std=c11', '-Wall', '-Wextra', '-Werror',
        '-fsanitize=address,undefined', '-fno-omit-frame-pointer', '-I', str(HISTORY), '-I', str(CONTROL),
        '-I', str(CONTROL / 'include'), '-I', str(CONTROL.parent / 'cp_v3_evidence/include'),
        str(HISTORY / 'history_evidence.c'), str(HERE / 'test_history.c'),
        str(CONTROL / 'json.c'), str(CONTROL / 'control.c'), str(CONTROL / 'small.c'),
        *crypto, '-o', str(executable)], check=True)
    case = json.loads(subprocess.check_output(['node', str(HERE / 'generate.mjs')], cwd=REPO, text=True))
    artifacts = [case['caps'], case['envelope']]
    for name in ['applied', 'contiguous', 'gap']:
        artifacts += [case[name]['requestBytes'], case[name]['receipt']]
    artifacts += [case['failedEnvelope'], case['failed']['requestBytes'], case['failed']['receipt']]
    paths = []
    for i, artifact in enumerate(artifacts):
        path = root / f'{i}.json'
        path.write_text(artifact if isinstance(artifact, str) else json.dumps(artifact, separators=(',', ':')))
        paths.append(str(path))
    subprocess.run([str(executable), *paths], check=True)
