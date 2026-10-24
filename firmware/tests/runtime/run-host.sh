#!/usr/bin/env bash
set -euo pipefail
CP_FW="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
CP_TEST_DIR="$(mktemp -d "${TMPDIR:-/tmp}/cp-runtime-test.XXXXXX")"
trap 'rm -rf "$CP_TEST_DIR"' EXIT
clang -std=c11 -Wall -Wextra -Werror -g -fsanitize=address,undefined -fno-omit-frame-pointer \
  -I"$CP_FW/tests/runtime" -I"$CP_FW/components/cp_runtime/include" \
  -I"$CP_FW/components/cp_core/include" -I"$CP_FW/components/cp_settings/include" \
  -I"$CP_FW/components/cp_network/include" -I"$CP_FW/components/cp_pipeline/include" \
  -I"$CP_FW/components/cp_provision/include" \
  "$CP_FW/tests/test_runtime.c" "$CP_FW/components/cp_core/cp_core.c" \
  "$CP_FW/components/cp_settings/settings_validate.c" -o "$CP_TEST_DIR/test-runtime"
for CP_CASE in enrolled_boot unassigned_boot candidate_commit candidate_failure_ap candidate_save_failure \
  network_stop_failure pipeline_stop_failure fresh_policy_age same_policy_lease_renewal expired_policy_once explicit_unassigned \
  unsupported_policy transient_lease_expiry actual_capture_contact resume_previous; do
  "$CP_TEST_DIR/test-runtime" "$CP_CASE"
done
