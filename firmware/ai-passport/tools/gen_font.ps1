# gen_font.ps1 —— 把界面用到的字渲染成 1bpp 位图 C 数组。
#
# 生成两套字体：
#   font_zh.c/h    $CELL x $CELL 全字符集（ASCII 可打印字符 + 界面中文 + ▲▼），粗体
#   font_digit.c/h 60px 高大数字（0-9 和 '-'，变宽）
#
# 为什么粗体：这块屏像素稀，常规体的细笔画在 1bpp 阈值化后会丢（"少笔画"），
# 粗体笔画占 2~3 像素，低分辨率下扎实得多。字号也不要再小——实测 16px 已经勉强。
#
# 字符表集中在本文件顶部——界面要加新文案时，先把新字加进 $ZH_CHARS 再重跑，
# 从源头杜绝"屏幕上缺字变成方框"。
#
# 用法：powershell -File gen_font.ps1   （在本文件所在目录执行，输出也在这里）
# 依赖：仅 Windows 自带 GDI+（System.Drawing）和系统字体，离线可用。

param([string]$OutDir = $PSScriptRoot)

Add-Type -AssemblyName System.Drawing

# ---------------------------------------------------------------------------
# 参数
# ---------------------------------------------------------------------------

$CELL   = 20                                  # 正文字腔（像素）
$EM     = 19                                  # 渲染字号（略小于字腔，留白）
$STYLE  = [System.Drawing.FontStyle]::Bold    # 粗体，防细笔画丢失

# ---------------------------------------------------------------------------
# 字符表
# ---------------------------------------------------------------------------

# 界面用到的中文与符号（去重即可，顺序无所谓，输出时会按码点排序）。
# 当前覆盖的文案：雷达 / 手机 / 电动车 / 采样 / 全部清零 / 再按一次确认清零 /
# 重新观察 / 等待 / 扫描停止 / 选择 / 切换 / 长按 / 关机 / 取消 / 确认 / ▲ ▼ /
# 手机采样已关闭（状态小字）/ 附近人数（主标签）
$ZH_CHARS = "雷达手机电动车采样全部清零再按一次确认重新观察等待扫描停止误选择切换长按关取消▲▼已闭附近人数"

$ZH_FONT  = "Microsoft YaHei"   # 中文字体；ASCII 也用它，风格统一
$DIGIT_FONT = "Bahnschrift"     # 数字字体（半粗衬线感弱、适合读数）

# ---------------------------------------------------------------------------
# 渲染工具
# ---------------------------------------------------------------------------

function New-Renderer([string]$fontName, [float]$emSize, [System.Drawing.FontStyle]$style) {
    try {
        $font = New-Object System.Drawing.Font($fontName, $emSize, $style,
                                               [System.Drawing.GraphicsUnit]::Pixel)
    } catch {
        $fallback = if ($style -eq [System.Drawing.FontStyle]::Bold) { "Consolas" } else { "SimSun" }
        Write-Warning "字体 $fontName 不可用，回退到 $fallback"
        $font = New-Object System.Drawing.Font($fallback, $emSize, $style,
                                               [System.Drawing.GraphicsUnit]::Pixel)
    }
    $bmp  = New-Object System.Drawing.Bitmap(128, 128)
    $g    = [System.Drawing.Graphics]::FromImage($bmp)
    $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAlias
    return @{ Font = $font; Bmp = $bmp; G = $g }
}

# 渲染单个字符到位图（黑字白底），返回 dark-pixel 的包围盒。
function Render-Glyph($r, [string]$ch) {
    $r.G.Clear([System.Drawing.Color]::White)
    $r.G.DrawString($ch, $r.Font, [System.Drawing.Brushes]::Black, 8, 8)
    $minX = 128; $minY = 128; $maxX = -1; $maxY = -1
    for ($y = 0; $y -lt 128; $y++) {
        for ($x = 0; $x -lt 128; $x++) {
            if ($r.Bmp.GetPixel($x, $y).R -lt 128) {
                if ($x -lt $minX) { $minX = $x }
                if ($x -gt $maxX) { $maxX = $x }
                if ($y -lt $minY) { $minY = $y }
                if ($y -gt $maxY) { $maxY = $y }
            }
        }
    }
    if ($maxX -lt 0) { return $null }   # 空白字形（如空格）
    return @{ MinX = $minX; MinY = $minY; W = ($maxX - $minX + 1); H = ($maxY - $minY + 1) }
}

function Get-Ink($r, [int]$x, [int]$y) {
    return ($r.Bmp.GetPixel($x, $y).R -lt 128)
}

# ---------------------------------------------------------------------------
# $CELL x $CELL 全字符集（定宽字腔）
# ---------------------------------------------------------------------------

$ROWB = [math]::Ceiling($CELL / 8)            # 每行字节数
$ascii = -join ((32..126) | ForEach-Object { [char]$_ })
$allZh = ($ascii + $ZH_CHARS).ToCharArray() | Sort-Object { [int]$_ } -Unique

# 先用一组代表字测公共竖直包围盒，保证所有字符基线一致（不逐字垂直居中，
# 否则 p/g 这类带下伸部的字母会和 e/a 对不齐）。
$r16 = New-Renderer $ZH_FONT $EM $STYLE
$probe = "Ag集▲"          # 上伸（A）、下伸（g）、满幅中文（集）、符号（▲）
$top = 128; $bottom = -1
foreach ($ch in $probe.ToCharArray()) {
    $bb = Render-Glyph $r16 ([string]$ch)
    if ($bb) {
        if ($bb.MinY -lt $top) { $top = $bb.MinY }
        if (($bb.MinY + $bb.H - 1) -gt $bottom) { $bottom = $bb.MinY + $bb.H - 1 }
    }
}
# 公共盒垂直居中到字腔里后的源 Y 起点
$boxH = $bottom - $top + 1
$srcY0 = $top - [math]::Floor(($CELL - $boxH) / 2)

$zhData = New-Object System.Collections.Generic.List[byte]
$zhCps  = New-Object System.Collections.Generic.List[uint32]
$zhAdv  = New-Object System.Collections.Generic.List[byte]
foreach ($ch in $allZh) {
    $bb = Render-Glyph $r16 ([string]$ch)
    if ($bb -and $bb.W -gt $CELL) { Write-Warning "字形超宽会被裁: $ch ($($bb.W)px > $CELL)" }
    $bytes = New-Object System.Collections.Generic.List[byte]
    # 横向按各自包围盒居中（定宽字腔、比例字体）；竖向用公共盒保证基线一致。
    $leftPad = 0
    if ($bb) { $leftPad = [math]::Max(0, [math]::Floor(($CELL - $bb.W) / 2)) }
    for ($row = 0; $row -lt $CELL; $row++) {
        for ($byteCol = 0; $byteCol -lt $ROWB; $byteCol++) {
            $b = 0
            for ($bit = 0; $bit -lt 8; $bit++) {
                $x = $byteCol * 8 + $bit
                if ($x -ge $CELL) { continue }
                $ink = $false
                if ($bb) {
                    $sx = $bb.MinX + ($x - $leftPad)
                    $sy = $row + $srcY0
                    if (($x - $leftPad) -ge 0 -and ($x - $leftPad) -lt $bb.W -and
                        $sy -ge 0 -and $sy -lt 128) {
                        $ink = Get-Ink $r16 $sx $sy
                    }
                }
                if ($ink) { $b = $b -bor (1 -shl (7 - $bit)) }
            }
            $bytes.Add([byte]$b)
        }
    }
    # 步进宽 = 字腔内有墨的最右列 + 2px 间隙；空格等无墨字形给字腔的 1/3。
    $maxCol = -1
    for ($col = 0; $col -lt $CELL; $col++) {
        for ($row = 0; $row -lt $CELL; $row++) {
            $byteIdx = $row * $ROWB + [math]::Floor($col / 8)
            $bitIdx  = 7 - ($col % 8)
            if ($bytes[$byteIdx] -band (1 -shl $bitIdx)) { if ($col -gt $maxCol) { $maxCol = $col } }
        }
    }
    $adv = if ($maxCol -lt 0) { [math]::Floor($CELL / 3) } else { [math]::Min($CELL, $maxCol + 2) }
    $zhAdv.Add([byte]$adv)
    $zhCps.Add([uint32][int]$ch)
    $zhData.AddRange($bytes)
}

# ---------------------------------------------------------------------------
# 60px 大数字（变宽，公共顶线）
# ---------------------------------------------------------------------------

$digitChars = "0123456789-"
$rD = New-Renderer $DIGIT_FONT 68 ([System.Drawing.FontStyle]::Bold)
$digitData = New-Object System.Collections.Generic.List[byte]
$digitOff  = New-Object System.Collections.Generic.List[uint16]
$digitW    = New-Object System.Collections.Generic.List[byte]

# 公共竖直盒：用全部数字一起测，顶线对齐（数字无下伸部，按顶部对齐即可）。
$dTop = 128; $dBottom = -1
foreach ($ch in $digitChars.ToCharArray()) {
    $bb = Render-Glyph $rD ([string]$ch)
    if ($bb) {
        if ($bb.MinY -lt $dTop) { $dTop = $bb.MinY }
        if (($bb.MinY + $bb.H - 1) -gt $dBottom) { $dBottom = $bb.MinY + $bb.H - 1 }
    }
}
$digitSrcY0 = $dTop   # 从公共顶线起取 60 行

foreach ($ch in $digitChars.ToCharArray()) {
    $bb = Render-Glyph $rD ([string]$ch)
    if (-not $bb) { throw "数字字形渲染失败: $ch" }
    $w = $bb.W
    $rowBytes = [math]::Ceiling($w / 8)
    $digitOff.Add([uint16]$digitData.Count)
    $digitW.Add([byte]$w)
    for ($row = 0; $row -lt 60; $row++) {
        for ($bc = 0; $bc -lt $rowBytes; $bc++) {
            $b = 0
            for ($bit = 0; $bit -lt 8; $bit++) {
                $x = $bc * 8 + $bit
                if ($x -lt $w) {
                    if (Get-Ink $rD ($bb.MinX + $x) ($digitSrcY0 + $row)) {
                        $b = $b -bor (1 -shl (7 - $bit))
                    }
                }
            }
            $digitData.Add([byte]$b)
        }
    }
}

# ---------------------------------------------------------------------------
# 输出 C 文件
# ---------------------------------------------------------------------------

function Emit-Bytes($list, [int]$perLine) {
    $sb = New-Object System.Text.StringBuilder
    for ($i = 0; $i -lt $list.Count; $i++) {
        if (($i % $perLine) -eq 0) { [void]$sb.Append("`n    ") }
        [void]$sb.Append(("0x{0:X2}," -f $list[$i]))
    }
    return $sb.ToString()
}

$zhHeader = @"
// font_zh.h —— ${CELL}x${CELL} 1bpp 点阵字（ASCII + 界面中文子集，粗体）。由 gen_font.ps1 生成，勿手改。
#pragma once
#include <stdint.h>

#define FONT_ZH_CELL $CELL
#define FONT_ZH_ROW_BYTES ((FONT_ZH_CELL + 7) / 8)
#define FONT_ZH_GLYPH_BYTES (FONT_ZH_CELL * FONT_ZH_ROW_BYTES)
#define FONT_ZH_COUNT $($zhCps.Count)

extern const uint8_t  font_zh_data[FONT_ZH_COUNT * FONT_ZH_GLYPH_BYTES];
extern const uint32_t font_zh_cps[FONT_ZH_COUNT];   // 升序码点表，二分查找
extern const uint8_t  font_zh_adv[FONT_ZH_COUNT];   // 步进宽（字腔右留白会被吃掉）

// 找到返回指向 FONT_ZH_GLYPH_BYTES 字节位图的指针并回填步进宽，
// 缺字返回 NULL（调用方画占位框）。
const uint8_t *font_zh_glyph(uint32_t cp, uint8_t *adv);
"@

$zhCSource = @"
// font_zh.c —— 由 gen_font.ps1 生成，勿手改。码点表必须保持升序（生成时排序）。
#include "font_zh.h"

const uint8_t font_zh_data[FONT_ZH_COUNT * FONT_ZH_GLYPH_BYTES] = {$(Emit-Bytes $zhData 16)
};

const uint32_t font_zh_cps[FONT_ZH_COUNT] = {
    $(($zhCps | ForEach-Object { "0x{0:X}" -f $_ }) -join ", ")
};

const uint8_t font_zh_adv[FONT_ZH_COUNT] = {
    $(($zhAdv | ForEach-Object { $_ }) -join ", ")
};

const uint8_t *font_zh_glyph(uint32_t cp, uint8_t *adv)
{
    int lo = 0, hi = FONT_ZH_COUNT - 1;
    while (lo <= hi) {
        int mid = (lo + hi) / 2;
        if (font_zh_cps[mid] == cp) { *adv = font_zh_adv[mid]; return &font_zh_data[mid * FONT_ZH_GLYPH_BYTES]; }
        if (font_zh_cps[mid] < cp) lo = mid + 1; else hi = mid - 1;
    }
    return 0;
}
"@

$digitHeader = @"
// font_digit.h —— 60px 高 1bpp 大数字（0-9 与 '-'，变宽）。由 gen_font.ps1 生成，勿手改。
#pragma once
#include <stdint.h>
#include <stdbool.h>

#define FONT_DIGIT_H 60
#define FONT_DIGIT_COUNT $($digitChars.Length)

extern const uint8_t  font_digit_data[];
extern const uint16_t font_digit_off[FONT_DIGIT_COUNT];
extern const uint8_t  font_digit_w[FONT_DIGIT_COUNT];
extern const char     font_digit_chars[FONT_DIGIT_COUNT + 1];

// 找到返回 true 并填出位图指针与宽度；不支持的字符返回 false。
bool font_digit_glyph(char ch, const uint8_t **bm, uint8_t *w);
"@

$digitCSource = @"
// font_digit.c —— 由 gen_font.ps1 生成，勿手改。
#include "font_digit.h"
#include <string.h>

const uint8_t font_digit_data[] = {$(Emit-Bytes $digitData 16)
};

const uint16_t font_digit_off[FONT_DIGIT_COUNT] = {
    $(($digitOff | ForEach-Object { $_ }) -join ", ")
};

const uint8_t font_digit_w[FONT_DIGIT_COUNT] = {
    $(($digitW | ForEach-Object { $_ }) -join ", ")
};

const char font_digit_chars[FONT_DIGIT_COUNT + 1] = "$digitChars";

bool font_digit_glyph(char ch, const uint8_t **bm, uint8_t *w)
{
    const char *p = strchr(font_digit_chars, ch);
    if (!p) return false;
    int idx = (int)(p - font_digit_chars);
    *bm = &font_digit_data[font_digit_off[idx]];
    *w = font_digit_w[idx];
    return true;
}
"@

Set-Content -Path (Join-Path $OutDir "font_zh.h")    -Value $zhHeader     -Encoding utf8
Set-Content -Path (Join-Path $OutDir "font_zh.c")    -Value $zhCSource    -Encoding utf8
Set-Content -Path (Join-Path $OutDir "font_digit.h") -Value $digitHeader  -Encoding utf8
Set-Content -Path (Join-Path $OutDir "font_digit.c") -Value $digitCSource -Encoding utf8

Write-Output ("font_zh: {0} glyphs, {1} bytes ({2}x{2} cell, bold)" -f $zhCps.Count, $zhData.Count, $CELL)
Write-Output ("font_digit: {0} glyphs, {1} bytes" -f $digitChars.Length, $digitData.Count)
