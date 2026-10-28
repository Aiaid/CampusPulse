#!/usr/bin/env bash
# Build separate images in a fresh directory. Never flash or create merged images.
set -euo pipefail
FIRMWARE_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
CP_DIAGNOSTIC=n
CP_DISPLAY=y
CP_PROFILE=n
while [[ $# -gt 0 ]]; do
    case "$1" in
        --diagnostic) CP_DIAGNOSTIC=y ;;
        --headless) CP_DISPLAY=n ;;
        --profile) CP_PROFILE=y ;;
        *) echo "Usage: $0 [--diagnostic] [--headless] [--profile]" >&2; exit 2 ;;
    esac
    shift
done
: "${IDF_PATH:?Set IDF_PATH to ESP-IDF 5.5.3}"
: "${IDF_PYTHON_ENV_PATH:?Set IDF_PYTHON_ENV_PATH to its installed Python environment}"
export UV_CACHE_DIR="${UV_CACHE_DIR:-/tmp/campuspulse-uv-cache}"
CP_PYTHON="${IDF_PYTHON_ENV_PATH}/bin/python"
CP_IDF_VERSION="$(uv run --no-project --python "${CP_PYTHON}" "${IDF_PATH}/tools/idf.py" --version)"
if [[ "${CP_IDF_VERSION}" != "ESP-IDF v5.5.3" ]]; then
    echo "ESP-IDF v5.5.3 required; activate the matching tools environment." >&2
    exit 1
fi
CP_BUILD="$(mktemp -d "${TMPDIR:-/tmp}/campuspulse-passport-build.XXXXXX")"
echo "Fresh build directory: ${CP_BUILD}"
CP_OVERRIDES="${CP_BUILD}/sdkconfig.override"
cat > "${CP_OVERRIDES}" <<EOF
CONFIG_CP_LEGACY_RADAR_DIAGNOSTICS=${CP_DIAGNOSTIC}
CONFIG_CP_PASSPORT_DISPLAY=${CP_DISPLAY}
CONFIG_CP_PASSPORT_BUTTONS=${CP_DISPLAY}
CONFIG_CP_PERF_PROFILE=${CP_PROFILE}
EOF
if [[ "${CP_PROFILE}" == y ]]; then
    cat >> "${CP_OVERRIDES}" <<'EOF'
CONFIG_FREERTOS_GENERATE_RUN_TIME_STATS=y
CONFIG_FREERTOS_USE_TRACE_FACILITY=y
CONFIG_FREERTOS_RUN_TIME_STATS_USING_ESP_TIMER=y
CONFIG_FREERTOS_RUN_TIME_COUNTER_TYPE_U64=y
EOF
fi
cd "${FIRMWARE_ROOT}/ai-passport-radar"
export ESP_IDF_VERSION=5.5.3
uv run --no-project --python "${CP_PYTHON}" "${IDF_PATH}/tools/idf.py" \
    -B "${CP_BUILD}" -D IDF_TARGET=esp32c3 \
    -D "SDKCONFIG=${CP_BUILD}/sdkconfig" \
    -D "SDKCONFIG_DEFAULTS=${PWD}/sdkconfig.defaults;${CP_OVERRIDES}" build
uv run --no-project --python "${CP_PYTHON}" \
    "${FIRMWARE_ROOT}/tools/verify_images.py" "${CP_BUILD}" \
    > "${CP_BUILD}/verified-images.json"
cat "${CP_BUILD}/verified-images.json"
echo "Build and image checks passed. No device operation performed."
