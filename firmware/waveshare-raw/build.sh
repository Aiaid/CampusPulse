#!/usr/bin/env bash
# Build separate images in a fresh directory. This script never opens a device.
set -euo pipefail
if [[ $# -ne 0 ]]; then
    echo "Usage: $0 (activate ESP-IDF 5.5.3 first)" >&2
    exit 2
fi
: "${IDF_PATH:?Activate ESP-IDF 5.5.3}"
: "${IDF_PYTHON_ENV_PATH:?Activate the installed ESP-IDF Python environment}"
RAW_PROJECT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
RAW_PYTHON="${IDF_PYTHON_ENV_PATH}/bin/python"
export UV_CACHE_DIR="${UV_CACHE_DIR:-/tmp/campuspulse-raw-uv}"
RAW_SDK_VERSION="$(uv run --no-project --python "$RAW_PYTHON" "$IDF_PATH/tools/idf.py" --version)"
if [[ "$RAW_SDK_VERSION" != "ESP-IDF v5.5.3" ]]; then
    echo "ESP-IDF v5.5.3 required" >&2
    exit 1
fi
RAW_BUILD="$(mktemp -d "${TMPDIR:-/tmp}/campuspulse-waveshare-raw.XXXXXX")"
RAW_VERSION="${RAW_VERSION:-0.1.5-battery}"
if [[ ! "$RAW_VERSION" =~ ^[A-Za-z0-9._-]{1,31}$ ]]; then
    echo "RAW_VERSION must contain 1-31 ASCII version characters" >&2
    exit 2
fi
RAW_ARGS=(-D IDF_TARGET=esp32s3 -D "PROJECT_VER=${RAW_VERSION}"
    -D "SDKCONFIG=${RAW_BUILD}/sdkconfig"
    -D "SDKCONFIG_DEFAULTS=${RAW_PROJECT}/sdkconfig.defaults")
if [[ -n ${RAW_LVGL_PATH:-} ]]; then
    RAW_ARGS+=(-D "RAW_LVGL_PATH=${RAW_LVGL_PATH}")
elif [[ ${IDF_COMPONENT_MANAGER:-1} == 0 ]]; then
    echo "Enable the IDF component manager or set RAW_LVGL_PATH to LVGL 9.5.0" >&2
    exit 1
fi
echo "Build directory: ${RAW_BUILD}"
uv run --no-project --python "$RAW_PYTHON" "$IDF_PATH/tools/idf.py" \
    -C "$RAW_PROJECT" -B "$RAW_BUILD" "${RAW_ARGS[@]}" build
uv run --no-project --python "$RAW_PYTHON" "$RAW_PROJECT/tools/verify_images.py" "$RAW_BUILD" \
    > "$RAW_BUILD/verified-images.json"
cat "$RAW_BUILD/verified-images.json"
echo "Build and image checks passed; no device operation performed."
