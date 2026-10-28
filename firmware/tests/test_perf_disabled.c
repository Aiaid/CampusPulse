#include "cp_perf.h"
#include <assert.h>
int main(void) {
    unsigned evaluated = 0;
    CP_PERF_START(no_timer_symbol_needed);
    CP_PERF_END(++evaluated, ++evaluated, no_timer_symbol_needed);
    cp_perf_note(++evaluated, ++evaluated, ++evaluated);
    cp_perf_poll();
    assert(evaluated == 0);
    return 0;
}
