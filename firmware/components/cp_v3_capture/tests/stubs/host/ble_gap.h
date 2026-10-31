#pragma once
#include <stdint.h>
#define BLE_GAP_EVENT_DISC 1
#define BLE_GAP_EVENT_EXT_DISC 2
#define BLE_GAP_EVENT_DISC_COMPLETE 3
#define BLE_OWN_ADDR_PUBLIC 0
#define BLE_HCI_LE_PHY_1M 1
typedef struct {uint8_t type,val[6];} ble_addr_t;
struct ble_gap_disc_desc {uint8_t event_type;ble_addr_t addr,direct_addr;int8_t rssi;const uint8_t *data;uint16_t length_data;};
struct ble_gap_ext_disc_desc {uint8_t legacy_event_type,props,data_status;ble_addr_t addr,direct_addr;int8_t rssi,tx_power;uint8_t sid,prim_phy,sec_phy;uint16_t periodic_adv_itvl;const uint8_t *data;uint16_t length_data;};
struct ble_gap_event {int type;struct ble_gap_disc_desc disc;struct ble_gap_ext_disc_desc ext_disc;};
struct ble_gap_ext_disc_params {uint16_t itvl,window;uint8_t passive;};
int ble_gap_ext_disc(uint8_t,uint16_t,uint16_t,uint8_t,uint8_t,uint8_t,const struct ble_gap_ext_disc_params *,const struct ble_gap_ext_disc_params *,int (*)(struct ble_gap_event *,void *),void *);
int ble_gap_disc_cancel(void);
int ble_gap_disc_active(void);
