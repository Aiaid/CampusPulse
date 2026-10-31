#include "board_runtime.h"

static te_runtime_step_result_t halt(te_runtime_t *r, const te_runtime_ops_t *o) {
    r->failed_phase = r->phase;
    r->phase = TE_RT_HALTED;
    /* Set busy before invoking external code; re-entry cannot advance state. */
    r->pause_confirmed = o->pause(o->context);
    r->active = false;
    r->busy = false;
    return TE_RT_STOPPED;
}

te_runtime_step_result_t te_runtime_step(te_runtime_t *r, const te_runtime_ops_t *o) {
    if (!r || !o || !o->perform || !o->pause || r->busy) return TE_RT_INVALID;
    if (r->phase == TE_RT_HALTED) return TE_RT_STOPPED;
    if (r->phase < TE_RT_CONNECT || r->phase > TE_RT_SEND) { r->busy = true; return halt(r, o); }
    r->busy = true;
    te_runtime_result_t result = o->perform(o->context, r->phase);
    if (result != TE_RT_OK && result != TE_RT_EMPTY) return halt(r, o);
    if (result == TE_RT_EMPTY && r->phase != TE_RT_RECOVER && r->phase != TE_RT_PEEK)
        return halt(r, o);
    switch (r->phase) {
    case TE_RT_CONNECT: r->phase = TE_RT_REGISTER; break;
    case TE_RT_REGISTER: r->phase = TE_RT_VALIDATE; break;
    case TE_RT_VALIDATE: r->phase = TE_RT_RECOVER; break;
    case TE_RT_RECOVER:
        if (result == TE_RT_EMPTY) r->phase = TE_RT_ACK_FREEZE;
        break;
    case TE_RT_ACK_FREEZE: r->phase = TE_RT_ACK_STORE; break;
    case TE_RT_ACK_STORE: r->phase = TE_RT_ACK_SEND; break;
    case TE_RT_ACK_SEND: r->phase = TE_RT_LEASE; break;
    case TE_RT_LEASE: r->phase = TE_RT_START; break;
    case TE_RT_START:
        r->active = true; r->phase = TE_RT_MONITOR; r->after_monitor = TE_RT_PEEK; break;
    case TE_RT_MONITOR:
        if (!r->active || r->after_monitor < TE_RT_PEEK || r->after_monitor > TE_RT_SEND)
            return halt(r, o);
        r->phase = r->after_monitor; break;
    case TE_RT_PEEK:
        r->after_monitor = result == TE_RT_EMPTY ? TE_RT_PEEK : TE_RT_FREEZE;
        r->phase = TE_RT_MONITOR; break;
    case TE_RT_FREEZE: r->phase = TE_RT_MONITOR; r->after_monitor = TE_RT_STORE; break;
    case TE_RT_STORE: r->phase = TE_RT_MONITOR; r->after_monitor = TE_RT_RELEASE; break;
    case TE_RT_RELEASE: r->phase = TE_RT_MONITOR; r->after_monitor = TE_RT_SEND; break;
    case TE_RT_SEND: r->phase = TE_RT_MONITOR; r->after_monitor = TE_RT_PEEK; break;
    default: return halt(r, o);
    }
    r->busy = false;
    return result == TE_RT_EMPTY && r->phase == TE_RT_MONITOR ? TE_RT_IDLE : TE_RT_PROGRESS;
}
