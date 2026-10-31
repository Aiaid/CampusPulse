#!/usr/bin/env bash
set -euo pipefail
: "${IDF_PATH:?Activate ESP-IDF 5.5.3}"
: "${IDF_PYTHON_ENV_PATH:?Activate the IDF Python environment}"
EDGE_PROJECT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
EDGE_BUILD="$(mktemp -d "${TMPDIR:-/tmp}/campuspulse-wave-v3.XXXXXX")"
export UV_CACHE_DIR="${UV_CACHE_DIR:-/tmp/campuspulse-v3-uv}"
EDGE_ARGS=(-D IDF_TARGET=esp32s3 -D PROJECT_VER=0.3.2-original-ui
  -D "SDKCONFIG=${EDGE_BUILD}/sdkconfig"
  -D "SDKCONFIG_DEFAULTS=${EDGE_PROJECT}/sdkconfig.defaults")
if [[ -n ${RAW_LVGL_PATH:-} ]]; then EDGE_ARGS+=(-D "RAW_LVGL_PATH=${RAW_LVGL_PATH}"); fi
uv run --no-project --python "${IDF_PYTHON_ENV_PATH}/bin/python" "$IDF_PATH/tools/idf.py" \
  -C "$EDGE_PROJECT" -B "$EDGE_BUILD" "${EDGE_ARGS[@]}" build
echo "Build: ${EDGE_BUILD}; no device operation performed."
