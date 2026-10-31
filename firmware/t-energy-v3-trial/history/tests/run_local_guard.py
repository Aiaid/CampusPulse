"""Bounded local packet diagnostics; actual backend fixture validation + ASan/UBSan."""
import json
import os
from pathlib import Path
import shlex
import subprocess
import tempfile

HERE = Path(__file__).resolve().parent
HISTORY = HERE.parent
REPO = HISTORY.parents[2]
crypto = shlex.split(subprocess.check_output(['pkg-config', '--cflags', '--libs', 'openssl'], text=True))
with tempfile.TemporaryDirectory(prefix='te-local-guard-') as directory:
    root = Path(directory)
    executable = root / 'local-guard'
    subprocess.run([os.environ.get('CC', 'cc'), '-std=c11', '-Wall', '-Wextra', '-Werror',
        '-fsanitize=address,undefined', '-fno-omit-frame-pointer', '-I', str(HISTORY),
        '-I', str(REPO / 'firmware/components/cp_v3_queue/include'),
        '-I', str(REPO / 'firmware/components/cp_v3_evidence/include'),
        str(HISTORY / 'local_guard.c'), str(HERE / 'test_local_guard.c'), *crypto, '-o', str(executable)], check=True)
    fixtures = json.loads(subprocess.check_output(['node', str(HERE / 'generate_local_guard.mjs')], cwd=REPO, text=True))
    paths = []
    for name in ['window30', 'window60', 'status', 'unknown', 'event', 'rawStatus', 'dense', 'maxWidth']:
        path = root / f'{name}.json'
        path.write_text(fixtures[name], encoding='ascii')
        paths.append(str(path))
    subprocess.run([str(executable), *paths], check=True)
