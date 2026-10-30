#!/usr/bin/env bash
# Build and validate separate images only. Never open a device or merge images.
set -euo pipefail
if [[ $# -ne 0 ]]; then
    echo "Usage: $0 (activate ESP-IDF 5.5.3 first)" >&2
    exit 2
fi
CP_PROJECT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
CP_CMAKE_ARGS=(-D IDF_TARGET=esp32s3)
if [[ ${CP_TENERGY_VERSION+x} ]]; then
    if [[ ! "$CP_TENERGY_VERSION" =~ ^[A-Za-z0-9._-]{1,31}$ ]]; then
        echo "CP_TENERGY_VERSION must contain 1-31 ASCII letters, digits, dots, underscores or hyphens." >&2
        exit 2
    fi
    CP_CMAKE_ARGS+=(-D "PROJECT_VER=${CP_TENERGY_VERSION}")
fi
: "${IDF_PATH:?Set IDF_PATH to ESP-IDF 5.5.3}"
: "${IDF_PYTHON_ENV_PATH:?Set IDF_PYTHON_ENV_PATH to its installed Python environment}"
export UV_CACHE_DIR="${UV_CACHE_DIR:-/tmp/campuspulse-uv-cache}"
CP_PYTHON="${IDF_PYTHON_ENV_PATH}/bin/python"
CP_IDF_VERSION="$(uv run --no-project --python "${CP_PYTHON}" "${IDF_PATH}/tools/idf.py" --version)"
if [[ "${CP_IDF_VERSION}" != "ESP-IDF v5.5.3" ]]; then
    echo "ESP-IDF v5.5.3 required; activate the matching tools environment." >&2
    exit 1
fi
if ! command -v xtensa-esp32s3-elf-gcc >/dev/null; then
    echo "ESP32-S3 Xtensa compiler missing from PATH; install/activate IDF 5.5.3 esp32s3 tools." >&2
    exit 1
fi
CP_BUILD="$(mktemp -d "${TMPDIR:-/tmp}/campuspulse-tenergy-s3-build.XXXXXX")"
echo "Fresh external build directory: ${CP_BUILD}"
cd "${CP_PROJECT}"
export ESP_IDF_VERSION=5.5.3
uv run --no-project --python "${CP_PYTHON}" "${IDF_PATH}/tools/idf.py" \
    -B "${CP_BUILD}" "${CP_CMAKE_ARGS[@]}" \
    -D "SDKCONFIG=${CP_BUILD}/sdkconfig" \
    -D "SDKCONFIG_DEFAULTS=${CP_PROJECT}/sdkconfig.defaults" build
uv run --no-project --python "${CP_PYTHON}" \
    "${CP_PROJECT}/verify_images.py" "${CP_BUILD}" \
    > "${CP_BUILD}/verified-images.json"
cat "${CP_BUILD}/verified-images.json"
echo "Build and S3 image checks passed. No device operation performed."
