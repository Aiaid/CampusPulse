#include "cp_settings.h"
#include "nvs.h"
#include "nvs_flash.h"
#include <string.h>
static const char *slots[2] = {"settings_a", "settings_b"};
esp_err_t cp_settings_init(void) { return nvs_flash_init(); }
esp_err_t cp_settings_load(cp_settings_t *out)
{
    if (!out) return ESP_ERR_INVALID_ARG;
    memset(out, 0, sizeof(*out));
    nvs_handle_t h;
    esp_err_t e=nvs_open("cp_settings", NVS_READONLY, &h);
    if (e==ESP_ERR_NVS_NOT_FOUND) return ESP_ERR_NOT_FOUND;
    if (e!=ESP_OK) return e;
    uint8_t slot=0;
    e=nvs_get_u8(h,"active",&slot);
    if (e==ESP_OK && slot>1) e=ESP_ERR_INVALID_STATE;
    size_t size=sizeof(*out);
    if (e==ESP_OK) e=nvs_get_blob(h,slots[slot],out,&size);
    nvs_close(h);
    if (e==ESP_OK && (size!=sizeof(*out) || !cp_settings_validate(out))) e=ESP_ERR_INVALID_STATE;
    if (e!=ESP_OK) cp_settings_clear_sensitive(out);
    return e==ESP_ERR_NVS_NOT_FOUND ? ESP_ERR_NOT_FOUND : e;
}
esp_err_t cp_settings_save(const cp_settings_t *settings)
{
    if (!cp_settings_validate(settings)) return ESP_ERR_INVALID_ARG;
    nvs_handle_t h;
    esp_err_t e=nvs_open("cp_settings", NVS_READWRITE, &h);
    if (e!=ESP_OK) return e;
    uint8_t active=0;
    e=nvs_get_u8(h,"active",&active);
    if (e==ESP_ERR_NVS_NOT_FOUND) { active=1; e=ESP_OK; }
    if (e==ESP_OK && active>1) e=ESP_ERR_INVALID_STATE;
    uint8_t next=active ^ 1u;
    if (e==ESP_OK) e=nvs_set_blob(h,slots[next],settings,sizeof(*settings));
    if (e==ESP_OK) e=nvs_commit(h);
    if (e==ESP_OK) e=nvs_set_u8(h,"active",next);
    if (e==ESP_OK) e=nvs_commit(h);
    nvs_close(h);
    return e;
}

#include "esp_random.h"
#include "bootloader_random.h"
esp_err_t cp_settings_setup_proof(char out[33])
{
    if (!out) return ESP_ERR_INVALID_ARG;
    memset(out,0,33);
    nvs_handle_t h;
    esp_err_t e=nvs_open("cp_settings",NVS_READWRITE,&h);
    if (e!=ESP_OK) return e;
    size_t size=33;
    e=nvs_get_str(h,"setup_proof",out,&size);
    if (e==ESP_ERR_NVS_NOT_FOUND) {
        unsigned char random[16];
        bootloader_random_enable();
        esp_fill_random(random,sizeof(random));
        bootloader_random_disable();
        static const char hex[]="0123456789abcdef";
        for (unsigned i=0;i<16;++i) { out[2*i]=hex[random[i]>>4]; out[2*i+1]=hex[random[i]&15]; }
        out[32]=0;
        e=nvs_set_str(h,"setup_proof",out);
        if (e==ESP_OK) e=nvs_commit(h);
        volatile unsigned char *p=random;
        for (unsigned i=0;i<sizeof(random);++i) p[i]=0;
    } else if (e==ESP_OK) {
        if (size!=33 || out[32]!=0) e=ESP_ERR_INVALID_STATE;
        for (unsigned i=0;e==ESP_OK && i<32;++i)
            if (!((out[i]>='0'&&out[i]<='9')||(out[i]>='a'&&out[i]<='f'))) e=ESP_ERR_INVALID_STATE;
    }
    nvs_close(h);
    if (e!=ESP_OK) memset(out,0,33);
    return e;
}
