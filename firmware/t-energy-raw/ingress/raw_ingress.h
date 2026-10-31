#pragma once
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#define TE_RAW_PAYLOAD_MAX 1650u
/* Numeric fields and address bytes are SDK values, not interpreted. Populate
 * only fields provided by the SDK; zero is not an unknown-value marker. */
typedef struct {
    uint64_t seq, mono_us;
    uint16_t length, periodic_interval;
    uint8_t addr[6], addr_type, kind, event_type, props, data_status, sid;
    uint8_t primary_phy, secondary_phy, direct_addr_type, direct_addr[6];
    int8_t rssi, tx_power;
    uint8_t payload[TE_RAW_PAYLOAD_MAX];
} te_raw_report_t;
typedef struct {
    te_raw_report_t *slots;
    uint32_t capacity, head, tail;
    uint32_t received, enqueued, dropped_full, dropped_oversize, dropped_invalid;
    uint64_t next_seq; /* producer only */
} te_raw_ingress_t;
typedef struct { uint32_t received, enqueued, dropped_full, dropped_oversize, dropped_invalid; } te_raw_ingress_stats_t;
typedef enum { TE_RAW_OK, TE_RAW_EMPTY, TE_RAW_FULL, TE_RAW_OVERSIZE, TE_RAW_INVALID } te_raw_result_t;
/* Power-of-two capacity. Single callback producer and single worker consumer; initialize before either
 * starts and destroy only after both stop. Caller owns PSRAM slots throughout. */
bool te_raw_ingress_init(te_raw_ingress_t *, te_raw_report_t *slots, uint32_t capacity);
/* Copies metadata and payload before returning; input bytes need only live for
 * this call. meta.length is ignored; length is authoritative. seq assigned to
 * each attempted report, including drops. No allocation, blocking or retry. */
te_raw_result_t te_raw_ingress_push(te_raw_ingress_t *, const te_raw_report_t *meta, const uint8_t *data, size_t length);
/* Atomically copies one report to worker-owned output and releases its slot.
 * Only the first output.length payload bytes are valid; output must not alias any slot. */
te_raw_result_t te_raw_ingress_pop(te_raw_ingress_t *, te_raw_report_t *out);
/* Each counter is a modulo-2^32 atomic snapshot; fields can be sampled at
 * different instants. No resets while callbacks or worker are active. */
void te_raw_ingress_stats(const te_raw_ingress_t *, te_raw_ingress_stats_t *);
