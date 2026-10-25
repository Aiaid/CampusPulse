#include "cp_memory_guard.h"
#include <string.h>

static bool elapsed(uint64_t now, uint64_t since, uint64_t duration) {
    return now >= since && now - since >= duration;
}
static bool sustained(bool condition, bool *tracking, uint64_t *since,
                       uint64_t now, uint64_t duration) {
    if (!condition) {
        *tracking = false;
        return false;
    }
    if (!*tracking || now < *since) {
        *tracking = true;
        *since = now;
    }
    return elapsed(now, *since, duration);
}
void cp_memory_guard_pause(cp_memory_guard_t *g, uint64_t now) {
    if (!g->scan_paused)
        g->paused_at = now;
    g->scan_paused = g->raw_paused = true;
    g->restart_ready = g->raw_low = g->scan_low = g->healthy = false;
}
void cp_memory_guard_observe(cp_memory_guard_t *g, uint64_t now, uint32_t free,
                             uint32_t largest, bool busy, bool collecting) {
    if (busy) {
        g->raw_low = g->scan_low = g->healthy = g->restart_ready = false;
        return;
    }
    if (g->scan_paused) {
        bool enough = free >= CP_MEMORY_START_FREE && largest >= CP_MEMORY_START_LARGEST;
        g->restart_ready = sustained(enough && !collecting, &g->healthy, &g->healthy_since,
                                     now, CP_MEMORY_HEALTHY_MS) &&
                           elapsed(now, g->paused_at, CP_MEMORY_COOLDOWN_MS);
        return;
    }
    if (!collecting) {
        g->raw_low = g->scan_low = g->healthy = false;
        return;
    }
    if (sustained(free < CP_MEMORY_STOP_FREE || largest < CP_MEMORY_STOP_LARGEST,
                   &g->scan_low, &g->scan_since, now, CP_MEMORY_STOP_DELAY_MS)) {
        cp_memory_guard_pause(g, now);
        return;
    }
    if (sustained(free < CP_MEMORY_RAW_FREE || largest < CP_MEMORY_RAW_LARGEST,
                   &g->raw_low, &g->raw_since, now, CP_MEMORY_RAW_DELAY_MS))
        g->raw_paused = true;
    if (sustained(free >= CP_MEMORY_RAW_RESUME_FREE && largest >= CP_MEMORY_RAW_RESUME_LARGEST,
                   &g->healthy, &g->healthy_since, now, CP_MEMORY_HEALTHY_MS))
        g->raw_paused = false;
}
bool cp_memory_guard_start_allowed(cp_memory_guard_t *g, uint64_t now, uint32_t free,
                                   uint32_t largest, bool busy) {
    if (g->init_fault || busy)
        return false;
    if (free < CP_MEMORY_START_FREE || largest < CP_MEMORY_START_LARGEST) {
        cp_memory_guard_pause(g, now);
        return false;
    }
    return !g->scan_paused || g->restart_ready;
}
void cp_memory_guard_init_failed(cp_memory_guard_t *g) { g->init_fault = true; }
void cp_memory_guard_started(cp_memory_guard_t *g) {
    /* Never erase the unsafe-init latch through an accidental recovery call. */
    bool fault = g->init_fault;
    memset(g, 0, sizeof *g);
    g->init_fault = fault;
}
