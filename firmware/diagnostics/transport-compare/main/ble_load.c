/* Optional real passive radio + shared pure aggregation load, RAM only. */
#include "ble_load.h"
#include <inttypes.h>
#include <stdio.h>
#include <string.h>
#include "sdkconfig.h"
#include "compare_config.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "esp_timer.h"

#if CONFIG_CP_LAN_BLE_LOAD
#include "cp_collect.h"
#include "freertos/event_groups.h"
#include "freertos/queue.h"
#include "host/ble_gap.h"
#include "host/ble_hs.h"
#include "host/util/util.h"
#include "nimble/nimble_port.h"

#define QUEUE_LENGTH 64
#define READY BIT0
#define FAILED BIT1
#define WORKER_DONE BIT2
#define HOST_DONE BIT3
#define STOP_DONE BIT4
#define WINDOW_MS 10000u
static portMUX_TYPE mux = portMUX_INITIALIZER_UNLOCKED;
static lan_ble_counts_t counts;
static StaticQueue_t queue_control;
static uint8_t queue_storage[QUEUE_LENGTH * sizeof(cp_report_t)];
static QueueHandle_t queue;
static EventGroupHandle_t events;
static cp_collect_t window;
static bool accepting, stopping, initialized, worker_started, host_started, stop_attempted, init_failed;
static bool sync_inflight, start_ok;
static int stop_result;

static void stop_stage(unsigned stage, int result)
{
    printf("LAN_STOP_STAGE stage=%u result=%d\n",stage,result);
    fflush(stdout);
}

static uint64_t mono_ms(void) { return (uint64_t)esp_timer_get_time() / 1000; }
static void wipe(void *p, size_t n) { volatile uint8_t *b = p; while (n--) *b++ = 0; }

void lan_ble_snapshot(lan_ble_counts_t *out)
{
    portENTER_CRITICAL(&mux);
    *out = counts;
    portEXIT_CRITICAL(&mux);
}

static int discovery(struct ble_gap_event *event, void *arg)
{
    (void)arg;
    if (event->type == BLE_GAP_EVENT_DISC_COMPLETE) {
        portENTER_CRITICAL(&mux);
        counts.scan_active = false;
        if (!stopping) ++counts.scan_errors;
        accepting = false;
        portEXIT_CRITICAL(&mux);
        return 0;
    }
    if (event->type != BLE_GAP_EVENT_DISC) return 0;
    const struct ble_gap_disc_desc *d = &event->disc;
    cp_report_t report = {.mono_ms=mono_ms(), .rssi=d->rssi,
        .report_type=d->event_type, .raw=CP_RAW_OFF};
    for (unsigned i=0; i<6; ++i) report.address[i]=d->addr.val[5-i];
    report.address_type=d->addr.type<=3?d->addr.type:4;
    report.payload_length=d->length_data>31?31:d->length_data;
    if (report.payload_length) memcpy(report.payload,d->data,report.payload_length);
    /* Admission and stop use one lock: no callback can append after sealing.
     * Queue send never blocks. No allocation, parsing, TLS, storage or logs. */
    portENTER_CRITICAL(&mux);
    if (accepting) {
        report.mono_ms=mono_ms();
        report.report_seq=++counts.received;
        if (xQueueSend(queue,&report,0)==pdTRUE) {
            ++counts.enqueued;
            unsigned depth=uxQueueMessagesWaiting(queue);
            if (depth>counts.queue_highwater) counts.queue_highwater=depth;
        } else ++counts.queue_drops;
    }
    portEXIT_CRITICAL(&mux);
    wipe(&report,sizeof(report));
    return 0;
}

static void radio_reset(int reason)
{
    (void)reason;
    portENTER_CRITICAL(&mux);
    ++counts.resets;
    counts.scan_active=false;
    accepting=false;
    portEXIT_CRITICAL(&mux);
    xEventGroupSetBits(events,FAILED);
}

static void radio_sync(void)
{
    portENTER_CRITICAL(&mux);
    if (stopping) { portEXIT_CRITICAL(&mux); return; }
    sync_inflight=true;
    portEXIT_CRITICAL(&mux);
    uint8_t own_address=0;
    int rc=ble_hs_util_ensure_addr(0);
    if (!rc) rc=ble_hs_id_infer_auto(0,&own_address);
    struct ble_gap_disc_params params={.passive=1,.itvl=160,.window=CFG_bleWindowMs*8/5,
        .filter_duplicates=0}; /* 100 ms interval, configured 20 or 50 ms window. */
    if (!rc) rc=ble_gap_disc(own_address,BLE_HS_FOREVER,&params,discovery,NULL);
    portENTER_CRITICAL(&mux);
    sync_inflight=false;
    if (rc) ++counts.scan_errors;
    else { counts.scan_active=true; accepting=!stopping; }
    portEXIT_CRITICAL(&mux);
    xEventGroupSetBits(events,rc?FAILED:READY);
}

static void host_task(void *arg)
{
    (void)arg;
    nimble_port_run();
    xEventGroupSetBits(events,HOST_DONE);
    vTaskDelete(NULL);
}

static void close_window(void)
{
    portENTER_CRITICAL(&mux);
    ++counts.windows;
    portEXIT_CRITICAL(&mux);
    wipe(&window,sizeof(window));
}

static void worker_task(void *arg)
{
    (void)arg;
    cp_report_t report={0};
    for (;;) {
        bool got=xQueueReceive(queue,&report,pdMS_TO_TICKS(50))==pdTRUE;
        if (got) {
            while (report.mono_ms>=window.start_ms+WINDOW_MS) {
                uint64_t next=window.start_ms+WINDOW_MS;
                uint32_t seq=window.window_seq+1;
                close_window();
                cp_collect_begin(&window,next,WINDOW_MS,1000,seq,64,false);
            }
            uint32_t before=window.summary_drops;
            bool ok=cp_collect_observe(&window,&report);
            portENTER_CRITICAL(&mux);
            ++counts.processed;
            if (!ok) ++counts.aggregate_drops;
            counts.address_overflow+=window.summary_drops-before;
            portEXIT_CRITICAL(&mux);
            wipe(&report,sizeof(report));
        }
        portENTER_CRITICAL(&mux);
        bool stop=stopping;
        portEXIT_CRITICAL(&mux);
        if (stop && uxQueueMessagesWaiting(queue)==0) break;
        /* Never advance past queued timestamps. Empty-window ticks ensure RAM
         * address summaries expire even when there are no new radio reports. */
        if (!got && !stop) {
            /* Admission timestamps share this lock with an empty-queue tick;
             * a pre-boundary report cannot arrive after its window is wiped. */
            portENTER_CRITICAL(&mux);
            uint64_t now=mono_ms();
            if (uxQueueMessagesWaiting(queue)==0)
                wipe(queue_storage,sizeof(queue_storage));
            while (uxQueueMessagesWaiting(queue)==0 && now>=window.start_ms+WINDOW_MS) {
                uint64_t next=window.start_ms+WINDOW_MS;
                uint32_t seq=window.window_seq+1;
                ++counts.windows;
                wipe(&window,sizeof(window));
                cp_collect_begin(&window,next,WINDOW_MS,1000,seq,64,false);
            }
            portEXIT_CRITICAL(&mux);
        }
    }
    close_window(); /* Includes the final partial window; contents discarded. */
    wipe(&report,sizeof(report));
    xEventGroupSetBits(events,WORKER_DONE);
    vTaskDelete(NULL);
}

/* This temporary diagnostic stops scanning, retaining the SDK runtime. The
 * first hardware trial reset during full SDK teardown; its precise reset site
 * was not captured. Never treat a task-priority timeout as containment of an
 * interrupt-masked SDK/controller operation. No host stop/deinit is attempted. */
static void stop_task(void *arg)
{
    (void)arg;
    stop_stage(3,0); /* cancellation helper entered */
    if (host_started) {
        /* A startup sync may have passed its stop check before ingress sealed.
         * Let it finish before cancelling so it cannot restart after the ACK. */
        for (;;) {
            portENTER_CRITICAL(&mux);
            bool syncing=sync_inflight;
            portEXIT_CRITICAL(&mux);
            if (!syncing) break;
            vTaskDelay(pdMS_TO_TICKS(10));
        }
        stop_stage(4,0); /* before synchronous scan-disable HCI command */
        int cancel=ble_gap_disc_cancel();
        bool active=ble_gap_disc_active()!=0;
        stop_stage(5,cancel); /* command returned, then verify inactive state */
        if ((cancel && cancel!=BLE_HS_EALREADY) || active) {
            portENTER_CRITICAL(&mux); ++counts.scan_errors; portEXIT_CRITICAL(&mux);
            stop_result=ESP_FAIL;
        } else {
            portENTER_CRITICAL(&mux); counts.scan_active=false; portEXIT_CRITICAL(&mux);
        }
    } else {
        stop_result=ESP_ERR_INVALID_STATE;
    }
    stop_stage(6,stop_result); /* host stop and deinit deliberately skipped */
    xEventGroupSetBits(events,STOP_DONE);
    vTaskDelete(NULL);
}

esp_err_t lan_ble_start(void)
{
    events=xEventGroupCreate();
    if (!events) return ESP_ERR_NO_MEM;
    queue=xQueueCreateStatic(QUEUE_LENGTH,sizeof(cp_report_t),queue_storage,&queue_control);
    if (!queue || !cp_collect_begin(&window,mono_ms(),WINDOW_MS,1000,1,64,false))
        return ESP_FAIL;
    if (xTaskCreate(worker_task,"lan_collect",6144,NULL,4,NULL)!=pdPASS) return ESP_ERR_NO_MEM;
    worker_started=true;
    esp_err_t err=nimble_port_init();
    if (err!=ESP_OK) { init_failed=true; return err; } /* No partial-init retry/deinit. */
    initialized=true;
    ble_hs_cfg.sync_cb=radio_sync;
    ble_hs_cfg.reset_cb=radio_reset;
    if (xTaskCreate(host_task,"lan_nimble",CONFIG_BT_NIMBLE_HOST_TASK_STACK_SIZE,
            NULL,configMAX_PRIORITIES-4,NULL)!=pdPASS)
        return ESP_ERR_NO_MEM;
    host_started=true;
    EventBits_t bits=xEventGroupWaitBits(events,READY|FAILED,pdFALSE,pdFALSE,pdMS_TO_TICKS(10000));
    start_ok=(bits&READY) && !(bits&FAILED);
    return start_ok?ESP_OK:ESP_FAIL;
}

bool lan_ble_runtime_retained(void) { return initialized || init_failed; }

esp_err_t lan_ble_stop(void)
{
    if (stop_attempted) return ESP_ERR_INVALID_STATE;
    stop_attempted=true;
    stop_stage(1,0); /* before ingress seal */
    portENTER_CRITICAL(&mux);
    stopping=true;
    accepting=false;
    portEXIT_CRITICAL(&mux);
    if (!events) return ESP_OK;
    stop_stage(2,0); /* ingress sealed; start supervised cancellation */
    esp_err_t result=ESP_OK;
    if (initialized) {
        /* Lower than the waiting app supervisor so a blocking SDK busy loop
         * cannot starve its external timeout on this single-core target. */
        if (xTaskCreate(stop_task,"lan_ble_stop",3072,NULL,tskIDLE_PRIORITY,NULL)!=pdPASS)
            result=ESP_ERR_NO_MEM;
        else {
            EventBits_t bits=xEventGroupWaitBits(events,STOP_DONE,pdFALSE,pdTRUE,pdMS_TO_TICKS(5000));
            if (!(bits&STOP_DONE)) result=ESP_ERR_TIMEOUT;
            else if (stop_result) result=ESP_FAIL;
        }
    }
    stop_stage(7,0); /* before bounded collector drain/completion wait */
    if (worker_started && !(xEventGroupWaitBits(events,WORKER_DONE,pdFALSE,pdTRUE,
            pdMS_TO_TICKS(3000))&WORKER_DONE)) return ESP_ERR_TIMEOUT;
    stop_stage(8,0); /* worker acknowledged clearing its observations */
    /* No callback can enqueue and the worker acknowledged clearing its state. */
    wipe(queue_storage,sizeof(queue_storage));
    wipe(&window,sizeof(window));
    stop_stage(9,0); /* application observation buffers cleared */
    if (init_failed || (initialized && !start_ok)) result=ESP_FAIL;
    return result;
}
#else
void lan_ble_snapshot(lan_ble_counts_t *out) { memset(out,0,sizeof(*out)); }
esp_err_t lan_ble_start(void) { return ESP_OK; }
esp_err_t lan_ble_stop(void) { return ESP_OK; }
bool lan_ble_runtime_retained(void) { return false; }
#endif

void lan_ble_print(const char *scope,const char *mode,unsigned sample,const lan_ble_counts_t *before)
{
    lan_ble_counts_t now;
    lan_ble_snapshot(&now);
    lan_ble_print_between(scope,mode,sample,before,&now);
}

void lan_ble_print_between(const char *scope,const char *mode,unsigned sample,
                          const lan_ble_counts_t *before,const lan_ble_counts_t *after)
{
    lan_ble_counts_t now=*after,zero={0};
    if (!before) before=&zero;
    printf("LAN_BLE scope=%s mode=%s sample=%u received=%"PRIu32" enqueued=%"PRIu32
        " processed=%"PRIu32" queue_drops=%"PRIu32" aggregate_drops=%"PRIu32
        " address_overflow=%"PRIu32" windows=%"PRIu32" queue_highwater=%"PRIu32
        " scan_active=%u scan_errors=%"PRIu32" resets=%"PRIu32"\n",scope,mode,sample,
        now.received-before->received,now.enqueued-before->enqueued,now.processed-before->processed,
        now.queue_drops-before->queue_drops,now.aggregate_drops-before->aggregate_drops,
        now.address_overflow-before->address_overflow,now.windows-before->windows,
        now.queue_highwater,now.scan_active,now.scan_errors-before->scan_errors,now.resets-before->resets);
}
