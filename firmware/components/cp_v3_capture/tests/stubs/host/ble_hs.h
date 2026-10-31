#pragma once
#define BLE_HS_EALREADY 2
struct test_hs_cfg {void (*sync_cb)(void);void (*reset_cb)(int);};
extern struct test_hs_cfg ble_hs_cfg;
