/* Synthetic advertisements only: no captured addresses or device identifiers. */
#include "ad_parse.h"
#include "dev_phone.h"
#include "key_guard.h"
#include "veh_rules.h"

#include <assert.h>
#include <stdio.h>
#include <string.h>

static void test_ad_boundaries(void)
{
    scan_facts_t facts;
    memset(&facts, 0xff, sizeof facts);
    ad_parse(NULL, 0, &facts);
    assert(!facts.has_name && !facts.has_manu && facts.ad_type_mask == 0);

    const uint8_t truncated[] = {2, 1, 6, 8, 9, 'x'};
    ad_parse(truncated, sizeof truncated, &facts);
    assert(facts.ad_type_mask == (1u << 1));
    assert(!facts.has_name);

    const uint8_t zero_end[] = {0, 2, 9, 'x'};
    ad_parse(zero_end, sizeof zero_end, &facts);
    assert(!facts.has_name && facts.ad_type_mask == 0);

    /* Manufacturer company ID is little-endian; payload length excludes ID. */
    const uint8_t manufacturer[] = {4, 0xff, 0x4c, 0, 0x0f};
    ad_parse(manufacturer, sizeof manufacturer, &facts);
    assert(facts.has_manu && facts.manu_id == MANU_APPLE);
    assert(facts.manu_len == 1 && facts.apple_subtype == APPLETYPE_NEARBY_INFO);

    /* Short service data must not borrow bytes from a following AD field. */
    const uint8_t short_service[] = {2, 0x16, 0x2c, 2, 9, 'x'};
    ad_parse(short_service, sizeof short_service, &facts);
    assert(facts.svc16 == 0 && facts.uuid16_mask == 0 && facts.name_len == 1);
}

static void test_ad_and_classifiers(void)
{
    scan_facts_t facts;
    /* GAP Appearance is little-endian on the BLE wire (Generic Phone 0x0040). */
    const uint8_t phone[] = {3, 0x19, 0x40, 0x00};
    ad_parse(phone, sizeof phone, &facts);
    assert(facts.has_appearance && facts.appearance == APPEARANCE_GENERIC_PHONE);
    assert(dev_phone_is_phone(&facts));

    const uint8_t fast_pair[] = {3, 0x16, 0x2c, 0xfe};
    ad_parse(fast_pair, sizeof fast_pair, &facts);
    assert(facts.svc16 == 0xfe2c);
    assert(facts.uuid16_mask & FACTS_UUID16_FASTPAIR);
    assert(dev_phone_is_peripheral(&facts));
    assert(!veh_rules_hard_ok(false, true, true, veh_rules_evidence(&facts), 0));

    /* Brand words do not override a clear accessory name. */
    const uint8_t accessory[] = {11, 9, 'P','i','x','e','l',' ','B','u','d','s'};
    ad_parse(accessory, sizeof accessory, &facts);
    assert(!dev_phone_is_phone(&facts) && dev_phone_is_peripheral(&facts));

    assert(!veh_rules_name_is_vehicle("CodyWatch", 9));
    assert(veh_rules_name_is_vehicle("YD-DEMO", 7));
    assert(!veh_rules_name_is_vehicle("DEMO", 4));
    assert(!veh_rules_hard_ok(true, false, true, EVID_POSITIVE, 0));
    assert(veh_rules_appearance_is_gadget(0x03c7));
    assert(!dev_phone_is_phone(NULL) && !dev_phone_is_peripheral(NULL));
}

static void test_key_wake_guard(void)
{
    key_guard_t guard = {0};
    assert(!key_guard_consume(&guard, false, 0));
    key_guard_arm(&guard, 100, 500);
    key_guard_sync_released(&guard, false);
    assert(key_guard_consume(&guard, false, 200));
    assert(key_guard_consume(&guard, true, 300));
    assert(!key_guard_consume(&guard, false, 301));
    key_guard_arm(&guard, 100, 500);
    key_guard_sync_released(&guard, true);
    assert(!key_guard_consume(&guard, false, 101));
    key_guard_arm(&guard, 100, 500);
    assert(key_guard_consume(&guard, false, 600));
    assert(!key_guard_consume(&guard, false, 601));
}

int main(void)
{
    test_ad_boundaries();
    test_ad_and_classifiers();
    test_key_wake_guard();
    puts("Synthetic parser, classifier and key guard tests: PASS");
    return 0;
}
