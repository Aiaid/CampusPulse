#!/bin/sh
set -eu
project=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
lvgl="$project/../ai-passport-radar/managed_components/lvgl__lvgl"
output=${1:-/private/tmp/campuspulse-four-ui-preview}
build=$(mktemp -d "${TMPDIR:-/tmp}/campuspulse-ui.XXXXXX")
trap 'rm -rf "$build"' EXIT
mkdir -p "$output" "$build/source"
cat > "$build/source/CMakeLists.txt" <<'CMAKE'
cmake_minimum_required(VERSION 3.16)
project(raw_ui_preview C)
set(CONFIG_LV_BUILD_DEMOS OFF CACHE BOOL "" FORCE)
set(CONFIG_LV_BUILD_EXAMPLES OFF CACHE BOOL "" FORCE)
set(LV_BUILD_CONF_PATH "$ENV{RAW_PROJECT}/tests/lv_conf.h" CACHE PATH "" FORCE)
add_subdirectory("$ENV{RAW_LVGL}" lvgl)
add_executable(preview "$ENV{RAW_PROJECT}/tests/preview_ui.c" "$ENV{RAW_PROJECT}/main/raw_ui.c" "$ENV{RAW_PROJECT}/main/raw_fonts.c")
target_include_directories(preview PRIVATE "$ENV{RAW_PROJECT}/main")
target_compile_options(preview PRIVATE -Wall -Wextra -Werror)
target_link_libraries(preview PRIVATE lvgl m)
CMAKE
RAW_PROJECT="$project" RAW_LVGL="$lvgl" cmake -S "$build/source" -B "$build/build" >/dev/null
cmake --build "$build/build" --parallel 4 >/dev/null
"$build/build/preview" "$output"
if command -v magick >/dev/null 2>&1; then
    for frame in "$output"/*.pgm; do magick "$frame" -strip "${frame%.pgm}.png"; done
fi
printf 'Software LVGL preview only; no physical ePaper refresh was tested.\nFrames: %s\n' "$output"
