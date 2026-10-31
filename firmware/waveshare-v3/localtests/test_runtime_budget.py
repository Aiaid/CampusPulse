"""Synthetic persistent budget and exclusive queue-lifecycle integration."""
from pathlib import Path
import shlex
import subprocess
import tempfile
import unittest
ROOT = Path(__file__).resolve().parents[3]
class BudgetIntegration(unittest.TestCase):
    def test_persistent_dual_budget_and_prepaid_cleanup(self):
        crypto = shlex.split(subprocess.check_output(['pkg-config', '--cflags', '--libs', 'openssl'], text=True))
        with tempfile.TemporaryDirectory() as directory:
            binary = Path(directory) / 'budget'
            subprocess.run(['cc', '-std=c11', '-Wall', '-Wextra', '-Werror', '-fsanitize=address,undefined',
                            '-fno-omit-frame-pointer', '-I' + str(ROOT / 'firmware/waveshare-v3/main'),
                            *['-I' + str(ROOT / 'firmware/components' / p / 'include') for p in ('cp_v3_budget', 'cp_v3_queue', 'cp_v3_evidence')],
                            str(ROOT / 'firmware/waveshare-v3/localtests/runtime_budget_test.c'),
                            str(ROOT / 'firmware/components/cp_v3_budget/budget.c'),
                            str(ROOT / 'firmware/components/cp_v3_queue/queue.c'),
                            str(ROOT / 'firmware/components/cp_v3_evidence/wire.c'), *crypto, '-o', str(binary)], check=True)
            subprocess.run([str(binary)], check=True)
if __name__ == '__main__': unittest.main()
