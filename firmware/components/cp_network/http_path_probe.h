#ifndef CP_HTTP_PATH_PROBE_H
#define CP_HTTP_PATH_PROBE_H
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

enum { CP_HTTP_PATH_EARLY_PROBES = 4 };
typedef struct {
    uint64_t cpu_start_us, cpu_connected_us, cpu_end_us;
    uint32_t last_probe_ms, ready_upper_ms, ready_gap_ms, max_perform_ms;
    uint32_t probe_wall_us;
    uint8_t early_probes, poll_calls;
    bool ready_known, end_known, end_write_ready;
    bool cpu_start_known, cpu_connected_known, cpu_end_known;
    bool colo_known;
    char colo[4];
} cp_http_path_probe_t;
_Static_assert(sizeof(cp_http_path_probe_t) <= 72, "Bounded HTTP path probe state");

static inline uint32_t cp_http_path_u32(uint64_t value)
{
    return value > UINT32_MAX ? UINT32_MAX : (uint32_t)value;
}

/* No new-connection claim for a retained handle: it may silently reconnect.
 * At most four existing perform() iterations are sampled, then one end sample.
 * The caller neither adds a delay nor changes the transport's retry policy. */
static inline bool cp_http_path_early_due(const cp_http_path_probe_t *p, bool cached)
{
    return !cached && !p->ready_known && p->early_probes < CP_HTTP_PATH_EARLY_PROBES;
}

static inline void cp_http_path_observe(cp_http_path_probe_t *p, bool final,
    bool socket_known, bool write_ready, uint32_t elapsed_ms, uint32_t perform_ms)
{
    if (final) {
        p->end_known = socket_known;
        p->end_write_ready = socket_known && write_ready;
        return;
    }
    ++p->early_probes;
    if (perform_ms > p->max_perform_ms) p->max_perform_ms = perform_ms;
    if (socket_known && write_ready && !p->ready_known) {
        p->ready_known = true;
        p->ready_upper_ms = elapsed_ms;
        p->ready_gap_ms = elapsed_ms >= p->last_probe_ms ? elapsed_ms - p->last_probe_ms : 0;
    }
    p->last_probe_ms = elapsed_ms;
}

/* Parse a bounded CF-Ray value, copy only its three-letter uppercase colo.
 * No ray/request identifier is retained. Reject malformed/trailing data and
 * conflicting duplicate headers rather than emitting an arbitrary string. */
static inline void cp_http_path_header(cp_http_path_probe_t *p, const char *key,
    const char *value)
{
    static const char expected[] = "cf-ray";
    if (!key || !value) return;
    for (size_t i = 0; i < sizeof expected; ++i) {
        unsigned char c = (unsigned char)key[i];
        if (c >= 'A' && c <= 'Z') c = (unsigned char)(c + ('a' - 'A'));
        if (c != (unsigned char)expected[i]) return;
    }
    size_t n = 0;
    while (n < 32 && ((value[n] >= '0' && value[n] <= '9') ||
           (value[n] >= 'a' && value[n] <= 'f') ||
           (value[n] >= 'A' && value[n] <= 'F'))) ++n;
    if (n < 8 || n == 32 || value[n] != '-') return;
    ++n;
    for (size_t i = 0; i < 3; ++i)
        if (value[n + i] < 'A' || value[n + i] > 'Z') return;
    if (value[n + 3]) return;
    /* A conflict is not resolved by retaining a later valid value. */
    if (p->colo[0] && (p->colo[0] != value[n] || p->colo[1] != value[n + 1] ||
                      p->colo[2] != value[n + 2])) {
        p->colo_known = false;
        return;
    }
    if (!p->colo[0]) {
        for (size_t i = 0; i < 3; ++i) p->colo[i] = value[n + i];
        p->colo[3] = 0;
        p->colo_known = true;
    }
}
#endif
