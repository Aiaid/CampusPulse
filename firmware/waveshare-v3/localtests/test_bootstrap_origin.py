"""Exact C bootstrap origin boundaries under sanitizers; entirely synthetic."""
from pathlib import Path
import os
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[3]
PROJECT = ROOT / 'firmware/waveshare-v3'


class BootstrapOrigin(unittest.TestCase):
    def test_exact_bootstrap_parser(self):
        idf = Path(os.environ['IDF_PATH'])
        json_dir = idf / 'components/json/cJSON'
        parser = idf / 'components/http_parser'
        component = ROOT / 'firmware/components/cp_v3_transport'
        with tempfile.TemporaryDirectory() as folder:
            upstream = Path(folder) / 'cjson.o'
            subprocess.run(['cc', '-std=c11', '-Wno-deprecated-declarations',
                            '-fsanitize=address,undefined', '-c', str(json_dir / 'cJSON.c'),
                            '-o', str(upstream)], check=True)
            for continuous in (False, True):
                binary = Path(folder) / ('continuous' if continuous else 'trial')
                subprocess.run(['cc', '-std=c11', '-D_DEFAULT_SOURCE',
                                *(['-DCP_V3_BOOTSTRAP_CONTINUOUS=1'] if continuous else []),
                                '-Wall', '-Wextra', '-Werror', '-Wno-unused-parameter',
                                '-fsanitize=address,undefined', '-fno-omit-frame-pointer',
                                '-I' + str(PROJECT / 'localtests/stubs'), '-I' + str(json_dir),
                                '-I' + str(parser), '-I' + str(component),
                                *['-I' + str(ROOT / 'firmware/components' / name / 'include')
                                  for name in ('cp_settings', 'cp_v3_evidence', 'cp_v3_transport')],
                                str(PROJECT / 'localtests/bootstrap_origin_test.c'),
                                str(ROOT / 'firmware/components/cp_settings/settings_validate.c'),
                                str(component / 'protocol.c'), str(parser / 'http_parser.c'),
                                str(upstream), '-lm', '-o', str(binary)], check=True)
                subprocess.run([str(binary)], check=True)


if __name__ == '__main__':
    unittest.main()
