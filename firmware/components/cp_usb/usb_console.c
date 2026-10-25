#include "cp_usb.h"
#include "cp_provision.h"
#include "driver/usb_serial_jtag.h"
#include "driver/usb_serial_jtag_vfs.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "sdkconfig.h"
static TaskHandle_t s_task;
static cp_usb_begin_fn s_begin;
static void *s_context;
static cp_usb_frame_parser_t s_parser;
static uint8_t s_response[CP_USB_JSON_MAX],s_frame[CP_USB_FRAME_MAX];
static void receive(void *unused,const char *id,const uint8_t *json,size_t length)
{
    (void)unused;
    size_t response_length=0,frame_length=0;
    esp_err_t err=cp_usb_control(s_begin,s_context,cp_provision_usb_exchange,json,length,
                                s_response,sizeof(s_response),&response_length);
    if (err==ESP_OK && cp_usb_frame_encode(id,s_response,response_length,s_frame,sizeof(s_frame),&frame_length)) {
        /* One ring-buffer write is atomic with respect to the driver's tx_mux.
         * Console logs also use that driver after the VFS handoff below. */
        if (usb_serial_jtag_write_bytes(s_frame,frame_length,pdMS_TO_TICKS(100))==(int)frame_length)
            (void)usb_serial_jtag_wait_tx_done(pdMS_TO_TICKS(100));
    }
    cp_usb_secure_clear(s_response,sizeof(s_response));cp_usb_secure_clear(s_frame,sizeof(s_frame));
}
static void usb_worker(void *unused)
{
    (void)unused;uint8_t chunk[128];unsigned rounds=0;int64_t last_input=0;
    for (;;) {
        int count=usb_serial_jtag_read_bytes(chunk,sizeof(chunk),pdMS_TO_TICKS(100));
        if (count>0) {
            last_input=esp_timer_get_time();
            cp_usb_frame_feed(&s_parser,chunk,(size_t)count,receive,NULL);
        } else if (!usb_serial_jtag_is_connected() ||
                   (last_input && esp_timer_get_time()-last_input>2000000)) {
            cp_usb_frame_clear(&s_parser);last_input=0;
        }
        cp_usb_secure_clear(chunk,sizeof(chunk));
        if (rounds<100 && ++rounds==100)
            ESP_LOGI("cp_usb","USB worker minimum free stack: %u bytes",(unsigned)uxTaskGetStackHighWaterMark(NULL));
    }
}
esp_err_t cp_usb_start(cp_usb_begin_fn begin,void *context)
{
#if !CONFIG_ESP_CONSOLE_USB_SERIAL_JTAG
    (void)begin;(void)context;return ESP_ERR_NOT_SUPPORTED;
#else
    if (s_task) return ESP_OK;
    if (!begin) return ESP_ERR_INVALID_ARG;
    if (usb_serial_jtag_is_driver_installed()) return ESP_ERR_INVALID_STATE;
    usb_serial_jtag_driver_config_t cfg={.tx_buffer_size=4096,.rx_buffer_size=2048};
    esp_err_t result=usb_serial_jtag_driver_install(&cfg);
    if (result!=ESP_OK) return result;
    usb_serial_jtag_vfs_use_driver();
    s_begin=begin;s_context=context;cp_usb_frame_init(&s_parser);
    if (xTaskCreate(usb_worker,"cp_usb",6144,NULL,3,&s_task)!=pdPASS) {
        s_task=NULL;usb_serial_jtag_vfs_use_nonblocking();usb_serial_jtag_driver_uninstall();
        return ESP_ERR_NO_MEM;
    }
    return ESP_OK;
#endif
}
