# CampusPulse open raster fonts

On 2026-10-25 the inherited Microsoft YaHei/Bahnschrift-derived bitmap arrays
were replaced completely. The current `font_zh.c/.h` and `font_digit.c/.h` are
**CampusPulse Raster Text** and **CampusPulse Raster Digits**, modified subsets
of Noto Sans CJK SC Bold 2.004 under SIL Open Font License 1.1.

[OFL.txt](OFL.txt) reproduces the exact pinned upstream license;
[COPYRIGHT.txt](COPYRIGHT.txt) retains the source font's embedded Adobe copyright
and identifies the modified fonts. Font software remains OFL-1.1; the surrounding
application's MIT notice does not override this license. No upstream reserved
font name is used as the modified font's primary name. These notices must accompany
source or binary redistribution containing the embedded glyphs.

## Source and reproducibility

The source is the official
[Noto CJK Sans2.004 release](https://github.com/notofonts/noto-cjk/releases/tag/Sans2.004),
pinned to commit `523d033d6cb47f4a80c58a35753646f5c3608a78`. Its
[font file](https://raw.githubusercontent.com/notofonts/noto-cjk/523d033d6cb47f4a80c58a35753646f5c3608a78/Sans/OTF/SimplifiedChinese/NotoSansCJKsc-Bold.otf)
is 17,002,248 bytes with SHA-256
`b5f0d1a190a7f9b43c310a8850630af12553df32c4c050543f9059732d9b4c0a`.
The [license from the same revision](https://raw.githubusercontent.com/notofonts/noto-cjk/523d033d6cb47f4a80c58a35753646f5c3608a78/LICENSE)
and the actual OTF name IDs 0/13/14 were checked together. The source font binary
is downloaded separately; it is not bundled in the repository or firmware.

```sh
curl --fail --location \
  https://raw.githubusercontent.com/notofonts/noto-cjk/523d033d6cb47f4a80c58a35753646f5c3608a78/Sans/OTF/SimplifiedChinese/NotoSansCJKsc-Bold.otf \
  -o /tmp/NotoSansCJKsc-Bold.otf
uv run firmware/tools/generate-fonts.py --font /tmp/NotoSansCJKsc-Bold.otf
uv run firmware/tools/generate-fonts.py --font /tmp/NotoSansCJKsc-Bold.otf --check
```

The generator pins Pillow 13.0.0 and fontTools 4.67.0 with inline uv metadata,
checks the source SHA-256 and license metadata, and records the FreeType version
and all generated output hashes in [manifest.json](manifest.json). Regeneration
was checked byte-for-byte with FreeType 2.14.3; a different rendering engine
version must be reviewed rather than silently updating the manifest.

`codepoints.txt` preserves the exact original 141-character repertoire: 95
printable ASCII characters, two triangles and 44 Chinese characters. All are
present in the source font cmap. Text retains the 20×20, three-bytes-per-row,
MSB-first API; a common 17-pixel bold raster size fits every ascender/descender
without clipping. Advances remain positive and no wider than the cell. Digits
retain the 60-row variable-width API, `0123456789-`, and a four-pixel inter-digit
gap. The widest three-digit value is 107 pixels, within the Radar's 112-pixel
column. These are layout bounds, not a claim of identical historical typography.

## Verification and publication boundary

`firmware/tests/test_fonts.py` checks exact coverage, generated fingerprints,
nonempty glyphs, padding bits, advance/offset/body bounds and the three-digit
layout. It compiles and executes the actual lookup functions under ASan/UBSan,
including missing characters, null outputs and the NUL digit case. It is included
in `firmware/tools/check-passport.sh` and therefore the chain test helper.

A generated contact sheet was inspected locally; its final preview copy was
metadata-stripped and checked with ExifTool. Previews remain in `/tmp`, and no
raster preview asset is added for publication. The committed font data consists
only of fixed packed glyph bytes, codepoint/metric tables and documented notices.
The old proprietary glyph arrays are not retained in the current sources. Older
import/stage-A commits and build artifacts are historical and must not be merged
or published to reintroduce those arrays. The font replacement changes the
firmware fingerprint and requires new images before any flash or release.
