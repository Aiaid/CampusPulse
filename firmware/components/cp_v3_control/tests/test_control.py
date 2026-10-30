"""Pure C control state machine against actual server-generated synthetic policy fixtures."""
import json
import os
from pathlib import Path
import shlex
import subprocess
import tempfile
import unittest

COMPONENT = Path(__file__).resolve().parents[1]
REPO = COMPONENT.parents[2]


class ControlTests(unittest.TestCase):
    def test_full_policy_hash_binding_and_state(self):
        cases = json.loads(subprocess.check_output(['node', str(COMPONENT / 'tests/generate.mjs')], cwd=REPO, text=True))
        with tempfile.TemporaryDirectory(prefix='cp-v3-control-') as directory:
            root = Path(directory)
            executable = root / 'fixture'
            crypto = shlex.split(subprocess.check_output(['pkg-config', '--cflags', '--libs', 'openssl'], text=True))
            subprocess.run([os.environ.get('CC', 'cc'), '-std=c11', '-Wall', '-Wextra', '-Werror',
                '-fsanitize=address,undefined', '-fno-omit-frame-pointer', '-I', str(COMPONENT / 'include'),
                '-I', str(COMPONENT.parent / 'cp_v3_evidence/include'), str(COMPONENT / 'json.c'),
                str(COMPONENT / 'control.c'), str(COMPONENT / 'tests/fixture.c'), *crypto, '-o', str(executable)], check=True)
            for case in cases:
                with self.subTest(case=case['name']):
                    caps = root / 'caps.json'; response = root / 'response.json'
                    caps.write_text(json.dumps(case['caps'], indent=2))
                    response.write_text(json.dumps(case['response'], indent=2))
                    subprocess.run([str(executable), case['expected'], str(caps), str(response),
                        case['cap_hash'], case['policy_hash']], check=True)


if __name__ == '__main__':
    unittest.main()
