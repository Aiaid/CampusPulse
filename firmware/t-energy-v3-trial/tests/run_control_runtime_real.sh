#!/usr/bin/env bash
set -euo pipefail
T="$(cd -- "$(dirname -- "$0")" && pwd)"
P="$(cd -- "$T/.." && pwd)"
F="$(cd -- "$P/.." && pwd)"
O="$(mktemp -d "${TMPDIR:-/tmp}/te-control-runtime.XXXXXX")"
trap 'rm -rf -- "$O"' EXIT
read -r -a CRYPTO <<< "$(pkg-config --cflags --libs openssl)"
sed "s/^int main(/int inherited_board_queue_test_main(/" "$T/test_board_small_queue.c" > "$O/queue_support.h"

I=(-I "$O" -I "$T" -I "$P/main" -I "$P/flash_queue/nvs_store/tests" -I "$P/flash_queue/nvs_store" -I "$F/components/cp_v3_control" )
for component in cp_v3_capture cp_v3_control cp_v3_evidence cp_v3_queue cp_v3_budget cp_v3_transport cp_settings cp_v3_stats cp_v3_temporal cp_v3_small_results; do I+=(-I "$F/components/$component/include"); done
"${CC:-cc}" -std=c11 -Wall -Wextra -Werror -fsanitize=address,undefined "${I[@]}" \
 "$T/test_control_runtime_real.c" "$T/control_capability_fixture.c" "$P/main/board_runtime_adapters.c" \
 "$P/main/board_handoff.c" "$P/main/board_small_queue.c" "$P/main/board_capabilities.c" \
 "$P/flash_queue/nvs_store/nvs_store.c" "$F/components/cp_v3_control/control.c" \
 "$F/components/cp_v3_control/small.c" "$F/components/cp_v3_control/json.c" \
 "$F/components/cp_v3_queue/queue.c" "$F/components/cp_v3_budget/budget.c" \
 "$F/components/cp_v3_evidence/evidence.c" "$F/components/cp_v3_evidence/wire.c" \
 "$F/components/cp_v3_stats/stats.c" "$F/components/cp_v3_temporal/temporal.c" \
 "$F/components/cp_v3_small_results/wire.c" "${CRYPTO[@]}" -o "$O/test"
"$O/test"
TEST_BAD_LEASE=1 "$O/test"
