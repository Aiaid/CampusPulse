"""Synthetic pure runtime boundaries; no device, serial or network operations."""
from pathlib import Path
import os
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[3]
PROJECT = ROOT / 'firmware/waveshare-v3'

class RuntimeLogic(unittest.TestCase):
    def test_clock_retention_and_frozen_aging(self):
        idf = Path(os.environ.get('IDF_PATH', '/Users/anend/Developer/Embedded/ESP/esp-idf-v5.5.3'))
        json_dir = idf / 'components/json/cJSON'
        with tempfile.TemporaryDirectory() as folder:
            binary = Path(folder) / 'runtime'
            upstream = Path(folder) / 'cjson.o'
            # Only vendor cJSON uses sprintf deprecated by the macOS SDK.
            subprocess.run(['cc', '-std=c11', '-Wno-deprecated-declarations',
                            '-fsanitize=address,undefined', '-c', str(json_dir / 'cJSON.c'),
                            '-o', str(upstream)], check=True)
            subprocess.run(['cc', '-std=c11', '-Wall', '-Wextra', '-Werror',
                            '-fsanitize=address,undefined', '-fno-omit-frame-pointer',
                            '-I' + str(PROJECT / 'main'), '-I' + str(json_dir),
                            *['-I' + str(ROOT / 'firmware/components' / name / 'include')
                              for name in ('cp_v3_evidence', 'cp_v3_temporal')],
                            str(PROJECT / 'localtests/runtime_logic_test.c'), str(upstream),
                            '-lm', '-o', str(binary)], check=True)
            subprocess.run([str(binary)], check=True)

if __name__ == '__main__':
    unittest.main()
