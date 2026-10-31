#!/bin/sh
set -eu
project=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
lvgl="$project/../ai-passport-radar/managed_components/lvgl__lvgl"
output=${1:-/private/tmp/campuspulse-v3-ui-preview}
case "$output" in /private/tmp/*) ;; *) printf 'Use an output directory under /private/tmp.\n' >&2; exit 2;; esac
build=$(mktemp -d "${TMPDIR:-/tmp}/campuspulse-v3-ui.XXXXXX")
trap 'rm -rf "$build"' EXIT
mkdir -p "$output" "$build/source"
cat > "$build/source/CMakeLists.txt" <<'CMAKE'
cmake_minimum_required(VERSION 3.16)
project(edge_ui_preview C)
set(CONFIG_LV_BUILD_DEMOS OFF CACHE BOOL "" FORCE)
set(CONFIG_LV_BUILD_EXAMPLES OFF CACHE BOOL "" FORCE)
set(LV_BUILD_CONF_PATH "$ENV{EDGE_PROJECT}/localtests/ui_lv_conf.h" CACHE PATH "" FORCE)
add_subdirectory("$ENV{EDGE_LVGL}" lvgl)
add_executable(preview "$ENV{EDGE_PROJECT}/localtests/preview_ui.c" "$ENV{EDGE_PROJECT}/main/edge_ui.c" "$ENV{EDGE_PROJECT}/main/edge_fonts.c")
target_include_directories(preview PRIVATE "$ENV{EDGE_PROJECT}/main" "$ENV{EDGE_PROJECT}/../waveshare-raw/main")
target_compile_options(preview PRIVATE -Wall -Wextra -Werror)
target_link_libraries(preview PRIVATE lvgl m)
CMAKE
EDGE_PROJECT="$project" EDGE_LVGL="$lvgl" cmake -S "$build/source" -B "$build/build" >/dev/null
cmake --build "$build/build" --parallel 4 >/dev/null
"$build/build/preview" "$output"
if command -v magick >/dev/null 2>&1; then
    for frame in "$output"/*.pgm; do magick "$frame" -strip "${frame%.pgm}.png"; done
fi
printf 'Software LVGL preview only; no physical ePaper refresh tested.\nFrames: %s\n' "$output"
