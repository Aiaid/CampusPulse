#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../.." && pwd)"
CP_TEST_BIN="$(mktemp "${TMPDIR:-/tmp}/campuspulse-provision-guard.XXXXXX")"
trap 'rm -f "$CP_TEST_BIN"' EXIT
# Host adapter calls OpenSSL standard crypto; production builds use IDF mbedTLS.
read -r -a CP_CRYPTO_FLAGS <<< "$(pkg-config --cflags --libs openssl)"
"${CC:-cc}" -std=c11 -D_POSIX_C_SOURCE=200809L -Wall -Wextra -Werror \
  -I"${ROOT}/tests/provisioning/host" -I"${ROOT}/firmware/tests/app" \
  -I"${ROOT}/firmware/components/cp_settings/include" \
  -I"${ROOT}/firmware/components/cp_provision" \
  "${ROOT}/tests/provisioning/host/test_guard.c" \
  "${ROOT}/firmware/components/cp_provision/cp_provision_guard.c" \
  "${CP_CRYPTO_FLAGS[@]}" -o "${CP_TEST_BIN}"
"${CP_TEST_BIN}"
