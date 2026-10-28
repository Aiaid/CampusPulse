/* Read-only saved-network bootstrap reused from the LAN diagnostic. */
#include <string.h>
#include "freertos/FreeRTOS.h"
#include "freertos/event_groups.h"
#include "cp_settings.h"
#include "esp_eap_client.h"
#include "esp_event.h"
#include "esp_netif.h"
#include "esp_partition.h"
#include "esp_wifi.h"
#include "nvs_flash.h"
static EventGroupHandle_t wifi_events;
static unsigned wifi_attempts;
static void wifi_event(void *arg, esp_event_base_t base, int32_t id, void *data)
{
    (void)arg; (void)data;
    if (base==IP_EVENT && id==IP_EVENT_STA_GOT_IP) xEventGroupSetBits(wifi_events,1);
    if (base==WIFI_EVENT && id==WIFI_EVENT_STA_DISCONNECTED) {
        xEventGroupClearBits(wifi_events,1);
        if (++wifi_attempts<8) esp_wifi_connect();
        else xEventGroupSetBits(wifi_events,2);
    }
}

esp_err_t mqtt_wifi_start_saved(uint32_t timeout_ms)
{
    cp_settings_t settings;
    /* A READONLY handle alone is insufficient: ordinary NVS initialization may
     * recover pages first. NVSPartition keeps this descriptor pointer, so its
     * lifetime must cover the app. Pinned IDF partition write/write_raw/erase
     * reject readonly descriptors before issuing any flash operation. Any init
     * or settings-load failure aborts; never retry the store writable. */
    static esp_partition_t readonly_nvs;
    const esp_partition_t *partition=esp_partition_find_first(
        ESP_PARTITION_TYPE_DATA,ESP_PARTITION_SUBTYPE_DATA_NVS,"nvs");
    esp_err_t err=ESP_ERR_NOT_FOUND;
    if (partition) {
        readonly_nvs=*partition;
        readonly_nvs.readonly=true;
        err=nvs_flash_init_partition_ptr(&readonly_nvs);
    }
    if (err==ESP_OK) err=cp_settings_load(&settings);
    else memset(&settings,0,sizeof(settings));
    if (err!=ESP_OK) { cp_settings_clear_sensitive(&settings); return err; }
    wifi_events=xEventGroupCreate();
    if (!wifi_events) { cp_settings_clear_sensitive(&settings); return ESP_ERR_NO_MEM; }
    err=esp_netif_init();
    if (err==ESP_OK) err=esp_event_loop_create_default();
    if (err==ESP_OK && !esp_netif_create_default_wifi_sta()) err=ESP_ERR_NO_MEM;
    wifi_init_config_t init=WIFI_INIT_CONFIG_DEFAULT();
    init.nvs_enable=0;
    if (err==ESP_OK) err=esp_wifi_init(&init);
    if (err==ESP_OK) err=esp_wifi_set_storage(WIFI_STORAGE_RAM);
    if (err==ESP_OK) err=esp_event_handler_register(WIFI_EVENT,ESP_EVENT_ANY_ID,wifi_event,NULL);
    if (err==ESP_OK) err=esp_event_handler_register(IP_EVENT,IP_EVENT_STA_GOT_IP,wifi_event,NULL);
    wifi_config_t wifi={0};
    memcpy(wifi.sta.ssid,settings.ssid,strlen(settings.ssid));
    memcpy(wifi.sta.password,settings.password,strlen(settings.password));
    wifi.sta.threshold.authmode=settings.wifi_security==CP_WIFI_OPEN?WIFI_AUTH_OPEN:
        settings.wifi_security==CP_WIFI_ENTERPRISE_PEAP?WIFI_AUTH_WPA2_ENTERPRISE:WIFI_AUTH_WPA2_PSK;
    wifi.sta.pmf_cfg.capable=true;
    if (err==ESP_OK) err=esp_wifi_set_mode(WIFI_MODE_STA);
    if (err==ESP_OK) err=esp_wifi_set_config(WIFI_IF_STA,&wifi);
    memset(&wifi,0,sizeof(wifi));
    if (err==ESP_OK && settings.wifi_security==CP_WIFI_ENTERPRISE_PEAP) {
        /* Honor the saved PEAP mode; its existing RADIUS policy is independent
         * from strict certificate/date/hostname verification on diagnostic MQTT. */
        esp_eap_client_clear_ca_cert();
        err=esp_eap_client_use_default_cert_bundle(false);
        if (err==ESP_OK) err=esp_eap_client_set_disable_time_check(true);
        if (err==ESP_OK) err=esp_eap_client_set_eap_methods(ESP_EAP_TYPE_PEAP);
        if (err==ESP_OK) err=esp_eap_client_set_identity((unsigned char *)settings.eap_identity,strlen(settings.eap_identity));
        if (err==ESP_OK) err=esp_eap_client_set_username((unsigned char *)settings.eap_username,strlen(settings.eap_username));
        if (err==ESP_OK) err=esp_eap_client_set_password((unsigned char *)settings.eap_password,strlen(settings.eap_password));
        if (err==ESP_OK) err=esp_wifi_sta_enterprise_enable();
    }
    cp_settings_clear_sensitive(&settings);
    if (err==ESP_OK) err=esp_wifi_start();
    if (err==ESP_OK) err=esp_wifi_set_ps(WIFI_PS_NONE);
    if (err==ESP_OK) err=esp_wifi_connect();
    if (err!=ESP_OK) return err;
    EventBits_t bits=xEventGroupWaitBits(wifi_events,3,pdFALSE,pdFALSE,pdMS_TO_TICKS(timeout_ms));
    return bits&1?ESP_OK:ESP_ERR_TIMEOUT;
}
