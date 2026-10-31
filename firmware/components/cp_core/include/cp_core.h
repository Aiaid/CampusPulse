#ifndef CP_CORE_H
#define CP_CORE_H
/* Retained board-description types only. V3 owns policy and lease control. */
#include <stdint.h>
enum {
    CP_CAP_BLE_SCAN = 1u << 0,
    CP_CAP_DISPLAY = 1u << 1,
    CP_CAP_INPUT = 1u << 2,
    CP_CAP_BATTERY = 1u << 3
};

/* Descriptive compiled limits. The board adapter verifies target/revision.
 * No pins, protected partition offsets, or runtime hardware inference live here. */
typedef struct {
    const char *board_id;
    const char *revision;
    const char *target_chip;
    uint32_t capabilities;
    uint32_t max_addresses;
    uint32_t ingress_queue_bytes;
    uint64_t max_collection_lease_ms;
} cp_board_profile_t;


#endif
