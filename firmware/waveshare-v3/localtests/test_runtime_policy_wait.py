"""Virtual-time policy wait; no device, serial, cloud or real sleeps."""
from pathlib import Path
import subprocess
import tempfile
import unittest

PROJECT = Path(__file__).resolve().parents[1]
ROOT = PROJECT.parents[1]


class PolicyWait(unittest.TestCase):
    def test_capability_bounded_wait_and_post_request_time(self):
        with tempfile.TemporaryDirectory() as directory:
            executable = Path(directory) / 'policy_wait'
            subprocess.run(['cc', '-std=c11', '-Wall', '-Wextra', '-Werror',
                            '-fsanitize=address,undefined', '-fno-omit-frame-pointer',
                            '-I' + str(PROJECT / 'main'),
                            '-I' + str(ROOT / 'firmware/components/cp_v3_evidence/include'),
                            str(PROJECT / 'localtests/runtime_policy_wait_test.c'),
                            '-o', str(executable)], check=True)
            subprocess.run([str(executable)], check=True)


if __name__ == '__main__':
    unittest.main()
