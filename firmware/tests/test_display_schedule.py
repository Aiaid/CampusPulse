"""Run the production pure display admission helper under native sanitizers."""
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]


class DisplayScheduleTests(unittest.TestCase):
    def test_normal_rate_and_urgent_control_admission(self):
        with tempfile.TemporaryDirectory(prefix='cp-display-admission-') as directory:
            binary = Path(directory) / 'display-admission'
            command = [os.environ.get('CC', 'cc'), '-std=c11', '-Wall', '-Wextra', '-Werror',
                       '-pedantic', '-fsanitize=address,undefined', '-fno-omit-frame-pointer',
                       '-I', str(ROOT / 'components/cp_board'),
                       '-I', str(ROOT / 'components/cp_core/include'),
                       '-I', str(ROOT / 'ai-passport-radar/main'),
                       str(ROOT / 'tests/test_display_schedule.c'), '-o', str(binary)]
            built = subprocess.run(command, text=True, capture_output=True)
            self.assertEqual(built.returncode, 0, built.stderr)
            checked = subprocess.run([str(binary)], text=True, capture_output=True)
            self.assertEqual(checked.returncode, 0, checked.stdout + checked.stderr)


if __name__ == '__main__':
    unittest.main()
