#!/usr/bin/env bash
set -euo pipefail
: "${IDF_PATH:?Activate ESP-IDF 5.5.3}"
: "${IDF_PYTHON_ENV_PATH:?Activate the IDF Python environment}"
TRIAL_PROJECT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
TRIAL_BUILD="$(mktemp -d "${TMPDIR:-/tmp}/campuspulse-tenergy-v3.XXXXXX")"
export UV_CACHE_DIR="${UV_CACHE_DIR:-/tmp/campuspulse-v3-uv}"
VERSION="$(uv run --no-project --python "${IDF_PYTHON_ENV_PATH}/bin/python" "$IDF_PATH/tools/idf.py" --version)"
[[ "$VERSION" == 'ESP-IDF v5.5.3' ]] || { echo 'ESP-IDF 5.5.3 required' >&2; exit 1; }
uv run --no-project --python "${IDF_PYTHON_ENV_PATH}/bin/python" "$IDF_PATH/tools/idf.py" \
  -C "$TRIAL_PROJECT" -B "$TRIAL_BUILD" -D IDF_TARGET=esp32s3 -D PROJECT_VER=0.3.2-te-native-mqtt \
  -D "SDKCONFIG=${TRIAL_BUILD}/sdkconfig" -D "SDKCONFIG_DEFAULTS=${TRIAL_PROJECT}/sdkconfig.defaults" build
uv run --no-project --python "${IDF_PYTHON_ENV_PATH}/bin/python" \
  "$TRIAL_PROJECT/verify_images.py" "$TRIAL_BUILD"
echo "Trial build: ${TRIAL_BUILD}; no device operation performed."
