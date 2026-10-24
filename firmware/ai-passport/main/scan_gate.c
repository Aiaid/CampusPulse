// main/scan_gate.c —— 见 scan_gate.h。纯逻辑，零依赖。
#include "scan_gate.h"

#include <string.h>

void scan_gate_reset(scan_gate_t *g, uint32_t now_ms)
{
    memset(g, 0, sizeof(*g));
    g->last_trigger_ms = now_ms;
}

uint16_t scan_gate_mean(const scan_gate_t *g)
{
    if (g->fill == 0) return 0;
    uint32_t sum = 0;
    for (uint8_t i = 0; i < g->fill; i++) sum += g->hist[i];
    return (uint16_t)(sum / g->fill);
}

bool scan_gate_feed(scan_gate_t *g, uint16_t count, uint32_t now_ms)
{
    // 1. 写环形缓冲
    g->hist[g->head] = count;
    g->head = (uint8_t)((g->head + 1) % GATE_WINDOW);
    if (g->fill < GATE_WINDOW) g->fill++;

    // 2. 窗口没攒满就不判——早期数据太少，任何结论都是噪声
    if (g->fill < GATE_WINDOW) return false;

    // 3. 算窗口内最小/最大，用极差代表"环境在动"
    uint16_t lo = g->hist[0], hi = g->hist[0];
    uint32_t sum = 0;
    for (uint8_t i = 0; i < GATE_WINDOW; i++) {
        uint16_t v = g->hist[i];
        if (v < lo) lo = v;
        if (v > hi) hi = v;
        sum += v;
    }
    uint16_t mean = (uint16_t)(sum / GATE_WINDOW);

    bool active = (uint16_t)(hi - lo) >= GATE_ACTIVITY_DELTA &&
                  count >= (uint16_t)(mean + GATE_RISE_COUNT);

    if (!active) {
        g->hits = 0;
        return false;
    }

    if (g->hits < GATE_CONFIRM) g->hits++;
    if (g->hits < GATE_CONFIRM) return false;

    // 4. 冷却
    if (g->triggered_once &&
        (uint32_t)(now_ms - g->last_trigger_ms) < GATE_COOLDOWN_MS) {
        return false;
    }

    g->last_trigger_ms = now_ms;
    g->triggered_once = true;
    g->hits = 0;
    return true;
}
