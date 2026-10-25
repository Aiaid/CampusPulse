#!/usr/bin/env bash
set -euo pipefail
CP_FW="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
CP_TEST_DIR="$(mktemp -d "${TMPDIR:-/tmp}/cp-memory-test.XXXXXX")"
trap 'rm -rf "$CP_TEST_DIR"' EXIT
clang -std=c11 -Wall -Wextra -Werror -pedantic -g -fsanitize=address,undefined -fno-omit-frame-pointer \
  -I"$CP_FW/components/cp_pipeline/include" "$CP_FW/tests/test_memory_guard.c" \
  "$CP_FW/components/cp_pipeline/memory_guard.c" -o "$CP_TEST_DIR/test-memory"
"$CP_TEST_DIR/test-memory"
