"""Run the actual startup exchange with transient/terminal/stop fake outcomes."""
from pathlib import Path
import subprocess
import tempfile
import unittest

PROJECT = Path(__file__).resolve().parents[1]
ROOT = PROJECT.parents[1]


class RegistrationRetry(unittest.TestCase):
    def test_frozen_identity_bounded_retry_and_stop(self):
        with tempfile.TemporaryDirectory() as directory:
            executable = Path(directory) / 'registration'
            subprocess.run(['cc', '-std=c11', '-Wall', '-Wextra', '-Werror',
                            '-fsanitize=address,undefined', '-fno-omit-frame-pointer',
                            '-I' + str(PROJECT / 'main'),
                            '-I' + str(PROJECT / 'localtests/stubs'),
                            '-I' + str(ROOT / 'firmware/components/cp_settings/include'),
                            str(PROJECT / 'localtests/runtime_registration_test.c'),
                            '-o', str(executable)], check=True)
            subprocess.run([str(executable)], check=True)


if __name__ == '__main__':
    unittest.main()
