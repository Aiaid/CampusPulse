#!/usr/bin/env bash
set -euo pipefail
CP_FW="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
CP_BUILD="$(mktemp -d "${TMPDIR:-/tmp}/cp-domain-debug.XXXXXX")"
trap 'rm -rf -- "$CP_BUILD"' EXIT
"${CC:-clang}" -std=c11 -Wall -Wextra -Werror -pedantic \
  -fsanitize=address,undefined -fno-omit-frame-pointer \
  -I"$CP_FW/tests/runtime" -I"$CP_FW/components/cp_core/include" \
  -I"$CP_FW/components/cp_settings/include" -I"$CP_FW/components/cp_network/include" \
  -I"$CP_FW/components/cp_pipeline/include" -I"$CP_FW/components/cp_collect/include" \
  -I"$CP_FW/components/cp_vehicle/include" \
  "$CP_FW/tests/test_domain_debug.c" "$CP_FW/components/cp_pipeline/domain_debug.c" \
  "$CP_FW/components/cp_collect/cp_collect.c" "$CP_FW/components/cp_vehicle/cp_vehicle.c" \
  -o "$CP_BUILD/test-domain-debug"
"$CP_BUILD/test-domain-debug"
