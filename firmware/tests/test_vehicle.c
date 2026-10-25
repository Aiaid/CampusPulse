#include "cp_vehicle.h"
#include <assert.h>
#include <limits.h>
#include <stdio.h>
#include <string.h>
int main(void) {
    assert(sizeof(cp_vehicle_evidence_t) == 16);
    cp_vehicle_evidence_t e = {0};
    const uint8_t yadea[] = {6,9,'Y','A','D','E','A'};
    assert(cp_vehicle_observe(&e, yadea, sizeof yadea));
    assert(e.parsed_reports == 1 && e.name_brand_mask == (1u << CP_VEHICLE_NAME_YADEA));
    const uint8_t malformed[] = {6,9,'B','Y','D'};
    assert(cp_vehicle_observe(&e, malformed, sizeof malformed));
    assert(e.malformed_reports == 1 && e.parsed_reports == 1);
    assert(e.name_brand_mask == (1u << CP_VEHICLE_NAME_YADEA));
    const uint8_t partial[] = {4,9,'B','Y','D',4,0xff,0x20};
    assert(cp_vehicle_observe(&e, partial, sizeof partial));
    assert(e.malformed_reports == 2 && e.name_brand_mask == (1u << CP_VEHICLE_NAME_YADEA));
    const uint8_t exclusions[] = {3,3,0x12,0x18,3,0xff,0x65,0x00,3,0xff,0x20,0x00};
    assert(cp_vehicle_observe(&e, exclusions, sizeof exclusions));
    assert(e.exclusion_mask == ((1u << CP_VEHICLE_EXCL_HID_SERVICE) | (1u << CP_VEHICLE_EXCL_OFFICE_COMPANY)));
    assert(e.ecosystem_mask == (1u << CP_VEHICLE_ECOSYSTEM_COMPANY_0020));
    cp_vehicle_evidence_t before = e;
    assert(!cp_vehicle_observe(NULL, yadea, sizeof yadea));
    e.parsed_reports = UINT32_MAX;
    before = e;
    assert(!cp_vehicle_observe(&e, yadea, sizeof yadea));
    assert(!memcmp(&before, &e, sizeof e));
    e.malformed_reports = UINT32_MAX;
    before = e;
    assert(!cp_vehicle_observe(&e, NULL, 1));
    assert(!memcmp(&before, &e, sizeof e));
    e = (cp_vehicle_evidence_t){0};
    assert(cp_vehicle_observe(&e, NULL, 0) && e.parsed_reports == 1);
    assert(cp_vehicle_observe(&e, NULL, 31) && e.malformed_reports == 1);
    assert(cp_vehicle_observe(&e, yadea, 32) && e.malformed_reports == 2);
    puts("vehicle compact host checks passed (16-byte state, synthetic inputs)");
    return 0;
}
