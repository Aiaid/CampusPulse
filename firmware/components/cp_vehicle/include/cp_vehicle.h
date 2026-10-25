#pragma once
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

/* Transport schema, not a field-accuracy claim. Never silently reinterpret bits. */
#define CP_VEHICLE_SCHEMA_VERSION "radar-compact-v1"
#define CP_VEHICLE_NAME_MASK_ALL UINT32_C(0x000fffff)
#define CP_VEHICLE_EXCLUSION_MASK_ALL UINT16_C(0x07ff)
#define CP_VEHICLE_ECOSYSTEM_MASK_ALL UINT16_C(0x0003)

/* Same indices as worker/vehicle-rules.ts RADAR_VEHICLE_NAME_PATTERNS. */
enum cp_vehicle_name_bit {
    CP_VEHICLE_NAME_YADEA = 0, CP_VEHICLE_NAME_AIMA, CP_VEHICLE_NAME_TAILG,
    CP_VEHICLE_NAME_LUYUAN, CP_VEHICLE_NAME_ZEEHO, CP_VEHICLE_NAME_BYD,
    CP_VEHICLE_NAME_NINEBOT, CP_VEHICLE_NAME_SEGWAY, CP_VEHICLE_NAME_SOCO,
    CP_VEHICLE_NAME_SUNRA, CP_VEHICLE_NAME_NIU_DASH, CP_VEHICLE_NAME_YD_PREFIX,
    CP_VEHICLE_NAME_TL_PREFIX, CP_VEHICLE_NAME_XIAODAO, CP_VEHICLE_NAME_LIMA,
    CP_VEHICLE_NAME_NIU_PREFIX, CP_VEHICLE_NAME_SMARTBIKE, CP_VEHICLE_NAME_BDB_PKE,
    CP_VEHICLE_NAME_EBIKE_PREFIX, CP_VEHICLE_NAME_ZUB_PREFIX
};
enum cp_vehicle_exclusion_bit {
    CP_VEHICLE_EXCL_PERIPHERAL_NAME = 0, CP_VEHICLE_EXCL_PHONE_NAME,
    CP_VEHICLE_EXCL_OFFICE_COMPANY, CP_VEHICLE_EXCL_PHONE_VENDOR,
    CP_VEHICLE_EXCL_CONSUMER_COMPANY, CP_VEHICLE_EXCL_APPLE_PHONE_SUBTYPE,
    CP_VEHICLE_EXCL_FAST_PAIR, CP_VEHICLE_EXCL_GADGET_SERVICE,
    CP_VEHICLE_EXCL_HID_SERVICE, CP_VEHICLE_EXCL_PHONE_APPEARANCE,
    CP_VEHICLE_EXCL_GADGET_APPEARANCE
};
enum cp_vehicle_ecosystem_bit {
    CP_VEHICLE_ECOSYSTEM_COMPANY_0020 = 0,
    CP_VEHICLE_ECOSYSTEM_COMPANY_1010
};

/* Zero-initialize once per address/window. No raw bytes, names or identifiers.
 * Presence/dwell use the caller's independent time bins, never these masks.
 * The optional wire object is omitted when this feature was not collected.
 * A present all-zero object means enabled but no report was parsed yet. */
typedef struct {
    uint32_t parsed_reports;
    uint32_t malformed_reports;
    uint32_t name_brand_mask;
    uint16_t exclusion_mask;
    uint16_t ecosystem_mask;
} cp_vehicle_evidence_t;

/* Called from the collector worker, independent of raw retention policy.
 * Parses one legacy AD/SCAN_RSP envelope (0..31 bytes) without allocations.
 * Every AD occurrence is checked. A malformed report increments only the
 * malformed counter; none of its partial evidence is accumulated.
 * Returns true when the report was accounted for (valid OR malformed).
 * Returns false only for NULL state or counter exhaustion; state is unchanged.
 * A NULL payload is valid only at length zero; otherwise counted malformed. */
bool cp_vehicle_observe(cp_vehicle_evidence_t *state, const uint8_t *payload, size_t length);
