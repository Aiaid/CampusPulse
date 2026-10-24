# /// script
# requires-python = ">=3.11"
# dependencies = ["pillow==13.0.0", "fonttools==4.67.0"]
# ///
"""Generate OFL firmware fonts; no proprietary glyph data is used.

uv run firmware/tools/generate-fonts.py --font /path/NotoSansCJKsc-Bold.otf
The font input is pinned by SHA-256. --check compares without repository writes.
An optional --preview writes an untracked BMP contact sheet with no metadata.
"""
from __future__ import annotations
import argparse
import hashlib
import json
import math
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont, features, __version__ as pillow_version
from fontTools.ttLib import TTFont
import fontTools

ROOT = Path(__file__).resolve().parents[1]
FONT_HASH = "b5f0d1a190a7f9b43c310a8850630af12553df32c4c050543f9059732d9b4c0a"
COMMIT = "523d033d6cb47f4a80c58a35753646f5c3608a78"
SOURCE_URL = f"https://raw.githubusercontent.com/notofonts/noto-cjk/{COMMIT}/Sans/OTF/SimplifiedChinese/NotoSansCJKsc-Bold.otf"
LICENSE_URL = f"https://raw.githubusercontent.com/notofonts/noto-cjk/{COMMIT}/LICENSE"
THRESHOLD = 112
SMALL_SIZE, CELL, DIGIT_SIZE, DIGIT_H = 17, 20, 60, 60
HEADER = """// SPDX-License-Identifier: OFL-1.1
// Copyright (c) 2014-2021 Adobe (http://www.adobe.com/).
// CampusPulse Raster: generated from Noto Sans CJK SC Bold 2.004.
// See firmware/fonts/{OFL.txt,COPYRIGHT.txt,manifest.json}.
// Regenerate with uv run firmware/tools/generate-fonts.py; do not hand-edit.
"""

def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()

def repertoire() -> list[int]:
    return [int(line.removeprefix("U+"), 16) for line in (ROOT / "fonts/codepoints.txt").read_text().splitlines() if line.startswith("U+")]

def raster(font: ImageFont.FreeTypeFont, char: str) -> tuple[Image.Image, tuple[int,int,int,int] | None]:
    image = Image.new("L", (160, 160), 0)
    ImageDraw.Draw(image).text((40, 100), char, font=font, anchor="ls", fill=255)
    image = image.point(lambda v: 255 if v >= THRESHOLD else 0, mode="1")
    box = image.getbbox()
    return image, box

def pack(image: Image.Image) -> bytes:
    width, height = image.size
    out = bytearray(height * ((width + 7) // 8))
    for y in range(height):
        for x in range(width):
            if image.getpixel((x,y)):
                out[y * ((width + 7) // 8) + x//8] |= 0x80 >> (x%8)
    return bytes(out)

def array(data: bytes | list[int], fmt: str = "hex") -> str:
    if fmt == "hex":
        values = [f"0x{v:02X}" for v in data]
    elif fmt == "cp":
        values = [f"0x{v:04X}" for v in data]
    else:
        values = [str(v) for v in data]
    return "\n".join("    " + ", ".join(values[i:i+12]) + "," for i in range(0,len(values),12))

def generate(font_path: Path) -> tuple[dict[str, str], dict, list[Image.Image], list[Image.Image]]:
    source = font_path.read_bytes()
    if digest(source) != FONT_HASH:
        raise ValueError("Source font SHA-256 differs from the reviewed official font")
    tt = TTFont(font_path)
    cps = repertoire()
    if cps != sorted(set(cps)) or len(cps) != 141:
        raise ValueError("Expected the original sorted 141-codepoint repertoire")
    missing = set(cps) - set(tt.getBestCmap())
    if missing:
        raise ValueError(f"Source font is missing {len(missing)} required codepoints")
    names = {n.nameID:n.toUnicode() for n in tt['name'].names if n.platformID == 3 and n.langID == 1033}
    if "Open Font License" not in names.get(13, "") or "2.004" not in names.get(5, ""):
        raise ValueError("Source font version/license metadata differs")
    small_font = ImageFont.truetype(str(font_path), SMALL_SIZE, layout_engine=ImageFont.Layout.BASIC)
    rendered = [raster(small_font,chr(cp)) for cp in cps]
    boxes = [box for _,box in rendered if box]
    top, bottom = min(b[1] for b in boxes)-100, max(b[3] for b in boxes)-100
    if bottom-top > CELL:
        raise ValueError("Small font exceeds fixed text cell height")
    baseline = (CELL-(bottom-top))//2-top
    small_images, advances = [], []
    for cp,(image,box) in zip(cps,rendered):
        cell = Image.new('1',(CELL,CELL),0)
        if box:
            crop = image.crop(box)
            y = baseline + box[1]-100
            if y < 0 or y+crop.height>CELL or crop.width>=CELL:
                raise ValueError("Glyph clipping would occur")
            cell.paste(crop,(0,y))
            advance = max(6,math.ceil(small_font.getlength(chr(cp))),crop.width+1)
        else:
            advance = 6
        if advance > CELL:
            raise ValueError("Text advance exceeds renderer cell")
        small_images.append(cell);advances.append(advance)
    digit_font = ImageFont.truetype(str(font_path), DIGIT_SIZE, layout_engine=ImageFont.Layout.BASIC)
    digit_rasters = [raster(digit_font,c) for c in '0123456789-']
    dt = min(b[1] for _,b in digit_rasters)-100
    db = max(b[3] for _,b in digit_rasters)-100
    digit_baseline = (DIGIT_H-(db-dt))//2-dt
    digits, widths, offsets, digit_bytes = [], [], [], bytearray()
    for image,box in digit_rasters:
        crop=image.crop(box); width=crop.width
        if width*3+8>112 or db-dt>DIGIT_H:
            raise ValueError("Three-digit value would overflow the 112-pixel radar column")
        cell=Image.new('1',(width,DIGIT_H),0)
        cell.paste(crop,(0,digit_baseline+box[1]-100))
        offsets.append(len(digit_bytes));widths.append(width);digits.append(cell);digit_bytes.extend(pack(cell))
    zh_bytes=b''.join(pack(im) for im in small_images)
    files={
        'font_zh.h': HEADER+'''#pragma once
#include <stdint.h>
#define FONT_ZH_CELL 20
#define FONT_ZH_ROW_BYTES ((FONT_ZH_CELL + 7) / 8)
#define FONT_ZH_GLYPH_BYTES (FONT_ZH_CELL * FONT_ZH_ROW_BYTES)
#define FONT_ZH_COUNT 141
extern const uint8_t font_zh_data[FONT_ZH_COUNT * FONT_ZH_GLYPH_BYTES];
extern const uint32_t font_zh_cps[FONT_ZH_COUNT];
extern const uint8_t font_zh_adv[FONT_ZH_COUNT];
const uint8_t *font_zh_glyph(uint32_t cp, uint8_t *adv);
''',
        'font_digit.h': HEADER+'''#pragma once
#include <stdint.h>
#include <stdbool.h>
#define FONT_DIGIT_H 60
#define FONT_DIGIT_COUNT 11
extern const uint8_t font_digit_data[];
extern const uint16_t font_digit_off[FONT_DIGIT_COUNT];
extern const uint8_t font_digit_w[FONT_DIGIT_COUNT];
extern const char font_digit_chars[FONT_DIGIT_COUNT + 1];
bool font_digit_glyph(char ch, const uint8_t **bm, uint8_t *w);
''',
        'font_zh.c': HEADER+'#include "font_zh.h"\n\n'+f'const uint8_t font_zh_data[FONT_ZH_COUNT * FONT_ZH_GLYPH_BYTES] = {{\n{array(zh_bytes)}\n}};\n\nconst uint32_t font_zh_cps[FONT_ZH_COUNT] = {{\n{array(cps,"cp")}\n}};\n\nconst uint8_t font_zh_adv[FONT_ZH_COUNT] = {{\n{array(advances,"int")}\n}};\n\n'+'''const uint8_t *font_zh_glyph(uint32_t cp, uint8_t *adv)
{
    int lo = 0, hi = FONT_ZH_COUNT - 1;
    while (lo <= hi) {
        int mid = (lo + hi) / 2;
        if (font_zh_cps[mid] == cp) {
            if (adv) *adv = font_zh_adv[mid];
            return &font_zh_data[mid * FONT_ZH_GLYPH_BYTES];
        }
        if (font_zh_cps[mid] < cp) lo = mid + 1; else hi = mid - 1;
    }
    return 0;
}
''',
        'font_digit.c': HEADER+'#include "font_digit.h"\n#include <string.h>\n\n'+f'const uint8_t font_digit_data[] = {{\n{array(digit_bytes)}\n}};\n\nconst uint16_t font_digit_off[FONT_DIGIT_COUNT] = {{\n{array(offsets,"int")}\n}};\n\nconst uint8_t font_digit_w[FONT_DIGIT_COUNT] = {{\n{array(widths,"int")}\n}};\n\n'+'''const char font_digit_chars[FONT_DIGIT_COUNT + 1] = "0123456789-";
bool font_digit_glyph(char ch, const uint8_t **bm, uint8_t *w)
{
    if (!ch || !bm || !w) return false;
    const char *p = strchr(font_digit_chars, ch);
    if (!p) return false;
    const unsigned i = (unsigned)(p - font_digit_chars);
    *bm = &font_digit_data[font_digit_off[i]];
    *w = font_digit_w[i];
    return true;
}
'''}
    metadata={
      'format_version':1,'derived_font_names':['CampusPulse Raster Text','CampusPulse Raster Digits'],
      'license':'OFL-1.1','copyright':names[0],
      'source':{'family':names[1],'style':names[2],'version':names[5],'repository':'https://github.com/notofonts/noto-cjk','revision':COMMIT,'release':'Sans2.004','font_url':SOURCE_URL,'font_sha256':FONT_HASH,'font_bytes':len(source),'license_url':LICENSE_URL,'license_sha256':digest((ROOT/'fonts/OFL.txt').read_bytes())},
      'generator':{'script':'firmware/tools/generate-fonts.py','pillow':pillow_version,'fonttools':fontTools.__version__,'freetype':features.version('freetype2'),'layout':'BASIC','threshold':THRESHOLD},
      'text':{'codepoints':len(cps),'cell':[20,20],'font_pixel_size':SMALL_SIZE,'baseline':baseline,'bitmap_bytes':len(zh_bytes),'max_advance':max(advances),'coverage_sha256':digest((ROOT/'fonts/codepoints.txt').read_bytes())},
      'digits':{'characters':'0123456789-','height':DIGIT_H,'font_pixel_size':DIGIT_SIZE,'baseline':digit_baseline,'widths':widths,'bitmap_bytes':len(digit_bytes),'max_three_digit_width':3*max(widths[:10])+8},
      'outputs':{f'firmware/ai-passport-radar/main/{k}':digest(v.encode()) for k,v in files.items()}}
    return files,metadata,small_images,digits

def main():
    args=argparse.ArgumentParser();args.add_argument('--font',required=True,type=Path);args.add_argument('--check',action='store_true');args.add_argument('--preview',type=Path);a=args.parse_args()
    files,metadata,small,digits=generate(a.font)
    targets={ROOT/'ai-passport-radar/main'/name:text for name,text in files.items()}
    targets[ROOT/'fonts/manifest.json']=json.dumps(metadata,ensure_ascii=False,indent=2)+'\n'
    for path,text in targets.items():
        if a.check:
            if path.read_text()!=text: raise SystemExit(f'Generated file differs: {path.relative_to(ROOT)}')
        else:path.write_text(text)
    if a.preview:
        sheet=Image.new('RGB',(640,600),'#10252d')
        for i,im in enumerate(small):
            colored=Image.new('RGB',im.size,'#eef9f2');sheet.paste(colored,(12+(i%20)*31,10+(i//20)*29),im)
        x=12
        for im in digits:
            colored=Image.new('RGB',im.size,'#68f2b8');sheet.paste(colored,(x,270),im);x+=im.width+8
        sheet=sheet.resize((1280,1200),Image.Resampling.NEAREST)
        sheet.save(a.preview,format='BMP')
    print(f"Open-font generation {'check' if a.check else 'write'} passed: 141 text glyphs, 11 digits, max three-digit width {metadata['digits']['max_three_digit_width']} px.")
if __name__=='__main__':main()
