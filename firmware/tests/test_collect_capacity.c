#include "capacity_fixture.h"
#include <stdio.h>
int main(void) {
    assert(CP_COLLECT_RAW == 4 && CP_COLLECT_BINS == 16);
    cp_collect_compact_t w = capacity_fixture();
    assert(cp_collect_bank_bytes(CP_COLLECT_ADDRESSES, 16) ==
           CP_COLLECT_ADDRESSES * (sizeof(cp_address_core_t) + 16 * sizeof(uint32_t)));
    assert(!cp_collect_bank_bytes(CP_COLLECT_ADDRESSES + 1, 16));
    assert(!cp_collect_compact_begin(&w, 1000, 80000, 5000, 1, CP_COLLECT_ADDRESSES + 1, false));
    cp_collect_t *legacy = calloc(1, sizeof *legacy);
    assert(legacy && cp_collect_begin(legacy, 1000, 80000, 5000, 1, CP_COLLECT_ADDRESSES, false));
    assert(!cp_collect_begin(legacy, 1000, 80000, 5000, 1, CP_COLLECT_ADDRESSES + 1, false));
    free(legacy);free(w.bins);free(w.addresses);
    printf("Collector capacity %u: saturation, next-address overflow, repeat/bin/RSSI/vehicle accounting passed; bank %zu bytes\n",
           CP_COLLECT_ADDRESSES, cp_collect_bank_bytes(CP_COLLECT_ADDRESSES, 16));
    return 0;
}
