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
    def test_small_first_window_span_admission(self):
        with tempfile.TemporaryDirectory(prefix='cp-v3-control-window-start-') as directory:
            executable = Path(directory) / 'fixture'
            self.compile(executable, 'window_start_fixture.c')
            subprocess.run([str(executable)], check=True)

    def test_conservative_monotonic_deadlines(self):
        with tempfile.TemporaryDirectory(prefix='cp-v3-control-deadline-') as directory:
            executable = Path(directory) / 'fixture'
            self.compile(executable, 'deadline_fixture.c')
            subprocess.run([str(executable)], check=True)

    def test_exact_backend_control_receipts(self):
        with tempfile.TemporaryDirectory(prefix='cp-v3-control-receipts-') as directory:
            executable = Path(directory) / 'fixture'
            self.compile(executable, 'frozen_fixture.c')
            cases = json.loads((COMPONENT / 'tests/control_receipts.json').read_text())['cases']
            for case in cases:
                with self.subTest(receipt=case['name']):
                    body = Path(directory) / 'request.json'
                    receipt = Path(directory) / 'receipt.json'
                    body.write_text(case['request_bytes'])
                    receipt.write_text(json.dumps(case['receipt']))
                    subprocess.run([str(executable), str(body), str(receipt)], check=True)

    def test_small_policy_leases_and_boundaries(self):
        self.run_cases('generate_small.mjs', 'small_fixture.c')

    def test_full_policy_hash_binding_and_state(self):
        self.run_cases('generate.mjs', 'fixture.c')

    def run_cases(self, generator, fixture):
        cases = json.loads(subprocess.check_output(['node', str(COMPONENT / 'tests' / generator)], cwd=REPO, text=True))
        with tempfile.TemporaryDirectory(prefix='cp-v3-control-') as directory:
            root = Path(directory)
            executable = root / 'fixture'
            self.compile(executable, fixture)
            for case in cases:
                with self.subTest(case=case['name']):
                    caps = root / 'caps.json'; response = root / 'response.json'
                    caps.write_text(json.dumps(case['caps'], indent=2))
                    response.write_text(json.dumps(case['response'], indent=2))
                    args = [str(executable), case['expected'], str(caps), str(response), case['cap_hash'], case['policy_hash']]
                    if generator == 'generate_small.mjs':
                        next_response = root / 'next.json'
                        next_response.write_text(json.dumps(case['next_response']))
                        args.append(str(next_response))
                        third_response = root / 'third.json'
                        third_response.write_text(json.dumps(case['third_response']))
                        args.append(str(third_response))
                    subprocess.run(args, check=True)

    def compile(self, executable, fixture):
        crypto = shlex.split(subprocess.check_output(['pkg-config', '--cflags', '--libs', 'openssl'], text=True))
        subprocess.run([os.environ.get('CC', 'cc'), '-std=c11', '-Wall', '-Wextra', '-Werror',
            '-fsanitize=address,undefined', '-fno-omit-frame-pointer', '-I', str(COMPONENT / 'include'),
            '-I', str(COMPONENT.parent / 'cp_v3_evidence/include'), str(COMPONENT / 'json.c'),
            str(COMPONENT / 'control.c'), str(COMPONENT / 'small.c'), str(COMPONENT / 'tests' / fixture), *crypto, '-o', str(executable)], check=True)


if __name__ == '__main__':
    unittest.main()
