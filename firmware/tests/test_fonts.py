"""Repertoire, storage/layout and executable API checks for the OFL glyphs."""
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
MAIN = ROOT / "ai-passport-radar/main"

def numbers(name, kind):
    text = (MAIN / name).read_text()
    body = re.search(rf"\b{kind}\[[^]]*\]\s*=\s*\{{(.*?)\}};", text, re.S).group(1)
    return [int(x, 0) for x in re.findall(r"0x[0-9a-fA-F]+|\b\d+\b", body)]

class OpenFontTests(unittest.TestCase):
    def test_open_license_and_generated_fingerprints(self):
        m = json.loads((ROOT / 'fonts/manifest.json').read_text())
        self.assertEqual(m['license'], 'OFL-1.1')
        self.assertIn('Adobe', m['copyright'])
        self.assertIn('SIL OPEN FONT LICENSE Version 1.1', (ROOT / 'fonts/OFL.txt').read_text())
        self.assertEqual(m['source']['font_sha256'], 'b5f0d1a190a7f9b43c310a8850630af12553df32c4c050543f9059732d9b4c0a')
        for file, expected in m['outputs'].items():
            self.assertEqual(hashlib.sha256((ROOT.parent / file).read_bytes()).hexdigest(), expected)
        self.assertEqual(hashlib.sha256((ROOT / 'fonts/codepoints.txt').read_bytes()).hexdigest(),m['text']['coverage_sha256'])

    def test_complete_original_repertoire_and_glyph_bounds(self):
        expected = [int(line[2:],16) for line in (ROOT/'fonts/codepoints.txt').read_text().splitlines() if line.startswith('U+')]
        cps = numbers('font_zh.c', 'font_zh_cps')
        data = numbers('font_zh.c', 'font_zh_data')
        advances = numbers('font_zh.c', 'font_zh_adv')
        self.assertEqual(cps, expected)
        self.assertEqual(len(cps),141)
        self.assertEqual(cps[:95],list(range(0x20,0x7f)))
        self.assertEqual(len(set(cps)),141)
        self.assertEqual(len(data),141*20*3)
        self.assertTrue(all(0 < a <= 20 for a in advances))
        for i,cp in enumerate(cps):
            glyph=data[i*60:(i+1)*60]
            self.assertEqual(any(glyph), cp != 32)
            self.assertTrue(all((glyph[y*3+2]&0x0f)==0 for y in range(20)))
            if cp != 32:
                occupied=[x for y in range(20) for x in range(20) if glyph[y*3+x//8]&(0x80>>(x%8))]
                self.assertLess(max(occupied),advances[i])

    def test_digit_offsets_and_three_digit_column(self):
        widths=numbers('font_digit.c','font_digit_w')
        offsets=numbers('font_digit.c','font_digit_off')
        data=numbers('font_digit.c','font_digit_data')
        self.assertEqual(len(widths),11)
        expected=0
        for width,offset in zip(widths,offsets):
            self.assertEqual(offset,expected)
            size=60*((width+7)//8)
            self.assertTrue(any(data[offset:offset+size]))
            expected+=size
        self.assertEqual(len(data),expected)
        self.assertLessEqual(max(widths[:10])*3+8,112)

    def test_compiled_lookup_api_and_unsupported_characters(self):
        source=r'''
#include "font_zh.h"
#include "font_digit.h"
#include <assert.h>
int main(void) {
    for (unsigned i=0;i<FONT_ZH_COUNT;i++) {
        uint8_t advance=0;
        assert(font_zh_glyph(font_zh_cps[i],&advance)==font_zh_data+i*FONT_ZH_GLYPH_BYTES);
        assert(advance==font_zh_adv[i] && advance<=FONT_ZH_CELL);
        assert(font_zh_glyph(font_zh_cps[i],0));
    }
    uint8_t width=99; const uint8_t *bitmap=0;
    assert(!font_zh_glyph(0x1f600,&width) && width==99);
    for (unsigned i=0;i<FONT_DIGIT_COUNT;i++) {
        assert(font_digit_glyph(font_digit_chars[i],&bitmap,&width));
        assert(bitmap==font_digit_data+font_digit_off[i] && width==font_digit_w[i]);
    }
    assert(!font_digit_glyph('\0',&bitmap,&width));
    assert(!font_digit_glyph('X',&bitmap,&width));
    assert(!font_digit_glyph('0',0,&width));
    assert(!font_digit_glyph('0',&bitmap,0));
    return 0;
}
'''
        with tempfile.TemporaryDirectory(prefix='cp-font-api-') as directory:
            p=Path(directory);(p/'font-test.c').write_text(source)
            subprocess.run([os.environ.get('CC','cc'),'-std=c11','-Wall','-Wextra','-Werror','-fsanitize=address,undefined','-I',str(MAIN),str(p/'font-test.c'),str(MAIN/'font_zh.c'),str(MAIN/'font_digit.c'),'-o',str(p/'font-test')],check=True,capture_output=True)
            subprocess.run([str(p/'font-test')],check=True,capture_output=True)

if __name__ == '__main__':
    unittest.main()
