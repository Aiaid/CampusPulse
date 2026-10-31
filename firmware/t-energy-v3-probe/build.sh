#!/usr/bin/env bash
set -euo pipefail
[[ $# -eq 0 ]] || { echo 'No arguments accepted' >&2; exit 2; }
: "${IDF_PATH:?Activate ESP-IDF 5.5.3}"
: "${IDF_PYTHON_ENV_PATH:?Activate ESP-IDF 5.5.3}"
CP_PROJECT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
CP_PYTHON="${IDF_PYTHON_ENV_PATH}/bin/python"
export UV_CACHE_DIR="${UV_CACHE_DIR:-/tmp/campuspulse-uv-cache}"
[[ "$(uv run --no-project --python "$CP_PYTHON" "$IDF_PATH/tools/idf.py" --version)" == 'ESP-IDF v5.5.3' ]]
CP_BUILD="$(mktemp -d "${TMPDIR:-/tmp}/campuspulse-v3-probe.XXXXXX")"
echo "Build directory: $CP_BUILD"
cd "$CP_PROJECT"
uv run --no-project --python "$CP_PYTHON" "$IDF_PATH/tools/idf.py" -B "$CP_BUILD" -D IDF_TARGET=esp32s3 -D "SDKCONFIG=$CP_BUILD/sdkconfig" -D "SDKCONFIG_DEFAULTS=$CP_PROJECT/sdkconfig.defaults" build
uv run --no-project --python "$CP_PYTHON" "$CP_PROJECT/verify.py" "$CP_BUILD"
