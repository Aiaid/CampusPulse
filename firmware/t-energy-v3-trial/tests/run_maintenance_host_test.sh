#!/usr/bin/env bash
set -euo pipefail
TE_TEST_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
TE_PROJECT="$(cd -- "$TE_TEST_DIR/.." && pwd)"
TE_TEST_OUT="$(mktemp -d "${TMPDIR:-/tmp}/te-maintenance-host.XXXXXX")"
trap 'rm -rf -- "$TE_TEST_OUT"' EXIT
"${CC:-cc}" -std=c11 -Wall -Wextra -Werror -fsanitize=address,undefined \
  -I "$TE_TEST_DIR/maintenance_mock" -I "$TE_PROJECT/main" \
  "$TE_PROJECT/main/legacy_scanstats_maintenance.c" \
  "$TE_TEST_DIR/test_legacy_scanstats_maintenance.c" -o "$TE_TEST_OUT/test"
"$TE_TEST_OUT/test"
