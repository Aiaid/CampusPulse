# Waveshare raw recorder four-page UI: software design QA

Date: 2026-10-29. Scope: the selected four-page design implemented by
`firmware/waveshare-raw/main/raw_ui.c` on a native 200 x 200 LVGL display.
This report covers software rendering only. It does not establish physical-panel
legibility, refresh behavior, connected hardware input, radio completeness,
vehicle inference or elevator prediction.

## Evidence and method

The exact selected references are `/private/tmp/campuspulse-four-diagnostics-v2.png`,
`/private/tmp/campuspulse-four-activity.png`,
`/private/tmp/campuspulse-four-vehicle.png`, and
`/private/tmp/campuspulse-four-elevator.png` (1254 x 1254 each).
Each source was normalized to 200 x 200 and placed immediately to the left of
its corresponding 200 x 200 implementation in one 400 x 200 comparison image:

- `/private/tmp/campuspulse-four-ui-preview/comparison-diagnostics.png`
- `/private/tmp/campuspulse-four-ui-preview/comparison-activity.png`
- `/private/tmp/campuspulse-four-ui-preview/comparison-vehicle.png`
- `/private/tmp/campuspulse-four-ui-preview/comparison-elevator.png`

All four combined inputs were opened and visually compared. This is native
pixel rendering rather than a browser: CSS size and deviceScaleFactor do not
apply. The LVGL L8 output is converted with the same >=128 white threshold as
`raw_display.c`; the saved final PGM and PNG frames are binary black and white.
The screenshots use injected test observations in the recording state, with
Wi-Fi disabled and battery unknown. Test values are examples, not observations
from a physical radio. Some values intentionally differ from the mock to check
independent counters and formatting. GiB/EiB are explicit binary storage units.

`tools/preview_ui.sh /private/tmp/campuspulse-four-ui-preview` compiles the
actual firmware UI and generated fonts against the repository's LVGL 9.5 source.
It renders four normal, four unknown, four large-count, four error, and seven
additional status frames. Every frame checks label bounds, measured text width,
label-to-label overlap, and one complete software flush. Repeated updates cover
the update path without rebuilding the page. The seven statuses explicitly
assert stopping, safe-to-remove, full-card and radio-error translations.
The build enables `-Wall -Wextra -Werror` for the preview executable.

## Comparison history and fixes

1. Initial host render: a P1 bug made newly built dynamic labels become `...`
   because LVGL layout had not yet calculated their widths. Visual inspection
   found the issue despite the initial bounding-box check passing. The fix
   completes layout after building a page, before fitting its dynamic text;
   a regression assertion rejects entire fields reduced to `...`. The later
   normal/large/unknown/error boards show complete values. The initial defective
   frame was inspected during development and was superseded in the output folder.
2. The next side-by-side comparison found a P2 issue on page four: its trend was
   only about 13 pixels high, substantially smaller than the selected design.
   The earlier view is retained in `iteration-2-before-graph-board.png` in the
   preview folder. The fix removes the redundant standalone RSSI unit row,
   moves the three RSSI readings upward, combines the unit into the chart caption,
   and gives the graph a 28-pixel frame and 25-pixel data range. The latest
   `comparison-elevator.png` was reopened and compared after this fix.
3. Final normal, unknown, large-count and error boards were visually inspected
   after the two fixes. All 23 rendered states pass layout checks. Long SSIDs
   elide with `...`; complete IP addresses, compact large counts, safety badges
   and the persistent footer remain visible.

## Required fidelity surfaces

- **Fonts and typography:** native 12/14/16-pixel Noto Sans CJK SC Bold glyphs
  are used for Chinese and ordinary labels; their line heights are 16/17/20.
  A 28-pixel Montserrat font provides numeric emphasis. The mock's heavier large
  numerals are approximated with the available LVGL numeric font; this is minor
  P3 polish. No glyph scaling or screenshot text is used. Normal values and all
  test extremes fit the allocated widths. The 1-bit output was inspected.
- **Spacing and layout rhythm:** the four titles, page fraction, black status
  badge, horizontal dividers and four footer dots preserve the source hierarchy.
  The footer stays within rows 184-199. The diagnostic view uses compact stacked
  labels and simple solid-fill occupancy bars; unknown denominators hide the
  complete bar instead of depicting 0%. The RSSI graph is now large enough to
  read as a distinct region. These are intentional adaptations to 200 pixels.
- **Colors and tokens:** black on white with a white-on-black status badge;
  no color-only state distinctions. Final files contain two pixel values, matching
  the panel conversion rather than relying on grayscale contrast.
- **Image and asset quality:** the source comprises text, dividers and data
  visualizations. These use native LVGL labels, lines and rectangles, with
  actual values supplied by the snapshot. The graph uses exactly ten provided
  bins, leaves unknown gaps unconnected and introduces no invented samples.
  Native-size font subsets avoid blurry scaled raster text.
- **Copy and content:** the diagnostic page distinguishes disabled, disconnected
  and connected Wi-Fi; displays supplied SSID/RSSI/IP and occupancy; and keeps
  unknown battery data as `--`. Page two labels the 60-second receive/write
  counters independently and displays cumulative software drops. Page three
  explicitly remains unanalysed, leaves model/brand/manufacturer fields `--`,
  and uses `synced` for saved raw reports. Page four keeps the estimate disabled,
  uses supplied RSSI values and sample count, and says `UTC未校准`. Stopping is
  not presented as safe, and radio errors are not called storage errors.
  The footer says only `操作键 切页`; it gives BOOT no capture operation.

## Findings and remaining limits

No actionable P0/P1/P2 software-rendering mismatch remains after the fixes.
The reduced chart detail reflects the ten real input bins; the mock's dense
synthetic curve is not fabricated. The source's segmented bars are simplified
for the small panel, while occupancy and unknown-state semantics are preserved.
The exact screen-to-screen navigation on GPIO/USB and one-refresh-per-update
behavior belong to main/display integration and physical acceptance, not this
host renderer. No serial port was opened during this UI task.

Final PNGs and comparison images were stripped during export and inspected with
ExifTool for EXIF/GPS/XMP/IPTC/MakerNotes, embedded comments, author/creator and
software fields. No such embedded fields were reported. Originals were preserved.

Implementation checklist: four pages implemented; 23 states rendered; bounds,
text width and overlap checks passed; source/implementation combined comparisons
opened; P1/P2 fixes rechecked; final PNG metadata checked; physical acceptance
still required.

final result: passed
