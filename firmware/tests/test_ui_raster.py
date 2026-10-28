"""Execute clipped production raster pixel/work regression under sanitizers."""
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
MAIN = ROOT / 'ai-passport-radar/main'


class RasterWorkTests(unittest.TestCase):
    def test_pixel_identity_and_bounded_bitmap_work(self):
        with tempfile.TemporaryDirectory(prefix='cp-ui-raster-work-') as directory:
            binary = Path(directory) / 'raster-test'
            command = [os.environ.get('CC', 'cc'), '-std=c11', '-Wall', '-Wextra', '-Werror',
                       '-fsanitize=address,undefined', '-fno-omit-frame-pointer',
                       '-I', str(ROOT / 'tests/ui'), '-I', str(MAIN),
                       '-I', str(ROOT / 'components/cp_core/include'),
                       str(ROOT / 'tests/test_ui_raster.c'), str(MAIN / 'page_status.c'),
                       str(MAIN / 'font_zh.c'), str(MAIN / 'font_digit.c'), '-o', str(binary)]
            built = subprocess.run(command, text=True, capture_output=True)
            self.assertEqual(built.returncode, 0, built.stderr)
            checked = subprocess.run([str(binary)], text=True, capture_output=True)
            self.assertEqual(checked.returncode, 0, checked.stdout + checked.stderr)


if __name__ == '__main__':
    unittest.main()
