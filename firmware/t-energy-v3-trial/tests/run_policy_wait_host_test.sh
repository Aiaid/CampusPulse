#!/usr/bin/env bash
set -euo pipefail
TE_POLICY_TEST_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
TE_POLICY_FIRMWARE="$(cd -- "$TE_POLICY_TEST_DIR/../.." && pwd)"
TE_POLICY_OUT="$(mktemp -d "${TMPDIR:-/tmp}/te-policy-wait.XXXXXX")"
trap 'rm -rf -- "$TE_POLICY_OUT"' EXIT
"${CC:-cc}" -std=c11 -Wall -Wextra -Werror -fsanitize=address,undefined \
    -I "$TE_POLICY_TEST_DIR/../main" \
    -I "$TE_POLICY_FIRMWARE/components/cp_v3_control/include" \
    -I "$TE_POLICY_FIRMWARE/components/cp_v3_evidence/include" \
    "$TE_POLICY_TEST_DIR/test_small_runtime_policy_wait.c" -o "$TE_POLICY_OUT/test"
"$TE_POLICY_OUT/test"
