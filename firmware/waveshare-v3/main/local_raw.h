#pragma once
#include "cp_v3_stats.h"
#include "cp_v3_temporal.h"
#include "esp_err.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#define LOCAL_RAW_SLOTS 64u
#define LOCAL_RAW_TASK_STACK 8192u
typedef struct local_raw local_raw_t;
typedef struct {
    uint64_t max_segment_bytes, max_total_bytes, min_free_bytes;
    uint32_t sync_ms; /*100..60000; segment >=2048; limits <=2^40. */
} local_raw_config_t;
typedef enum {
    LOCAL_RAW_DISABLED, LOCAL_RAW_RECORDING, LOCAL_RAW_STOPPING,
    LOCAL_RAW_STOPPED, LOCAL_RAW_QUOTA, LOCAL_RAW_LOW_SPACE,
    LOCAL_RAW_STORAGE_ERROR, LOCAL_RAW_INVALID_REPORT, LOCAL_RAW_DIRECTORY_ERROR,
    LOCAL_RAW_BUDGET
} local_raw_reason_t;
typedef struct {
    bool active, writer_running, safe_to_unmount, io_failed_latched;
    local_raw_reason_t reason;
    /* Backend status a[6], boot-monotonic: enqueued,written,synced,drops,
     * storage/encoding errors,space/quota/budget stops. Never addresses or filenames. */
    uint64_t counters[6];
    uint64_t received, invalid_reports, managed_bytes, clock_anchors;
    uint32_t free_slots, capacity;
    size_t memory_bytes, psram_bytes;
    esp_err_t last_error;
} local_raw_status_t;
typedef bool (*local_raw_clock_fn)(void *, uint64_t mono_ms, cp_v3_temporal_time_t *);
typedef bool (*local_raw_media_sync_fn)(void *);
typedef bool (*local_raw_budget_fn)(void *, uint64_t logical_bytes);
#define LOCAL_RAW_ERR_BUDGET ((esp_err_t)0x7402)

/* Allocation + idle task only: no mount/mkdir/file/card access. The root owns
 * mount/unmount and shares this exact mutex with its small durable queue.
 * media_sync, when supplied, runs under that mutex after fflush/fsync/close. */
esp_err_t local_raw_prepare(SemaphoreHandle_t tf_mutex,
    local_raw_media_sync_fn media_sync, void *media_context, local_raw_t **out);
size_t local_raw_memory_bytes(void); /* state,pool,8KiB stack,TCB; heap overhead extra. */
size_t local_raw_psram_bytes(void);
/* Only while stopped. Callback is pure/nonblocking and shares capture's time
 * provider. Source1/2 are CPRAW RTC enums; rtc_verified must only be true after
 * actual valid RTC/readback verification. Source2 requires raw_clock_set/readback.
 * Host/network UTC alone must pass false. Unknown/invalid time writes no anchor.
 * CPRAW whole-second UTC adds1000ms quantization to supplied uncertainty. */
esp_err_t local_raw_set_clock(local_raw_t *, local_raw_clock_fn, void *,
    uint8_t source, bool rtc_verified);
/* Only stopped; no I/O. Called under the shared TF mutex BEFORE every logical
 * write authorization. NULL leaves accounting to the caller (no budget claim).
 * Open/probe prepay close/remove overhead so denial cannot prevent safe cleanup.
 * Credit is never refunded, including cancelled/failed writes and unused close.
 */
esp_err_t local_raw_set_budget(local_raw_t *, local_raw_budget_fn, void *);
/* Root calls only after real policy ACK and mounted storage. Copies actual
 * boot/session; exclusive files in /sdcard/cpraw-v3, preserves old /cpraw. */
esp_err_t local_raw_start(local_raw_t *, const local_raw_config_t *,
    const char boot_id[37], const uint8_t session[16]);
/* Pre-ACK, inactive only. Validate mounted managed directory/CRC/quota/free
 * reserve and an exclusively owned temporary write+fsync+media-sync+remove.
 * Never admits reports or modifies/deletes an existing file. Ordinary policy/
 * metadata rejection stays safely inactive; uncertain temporary I/O is latched.
 * This is current preflight evidence, not a reservation or future guarantee. */
esp_err_t local_raw_probe(local_raw_t *, const local_raw_config_t *,
    local_raw_status_t *optional_status);
/* Collector-worker hook: no allocation, disk access, blocking, filtering or
 * per-address cap. Copy all representable SDK metadata/payload, preserving seq.
 * A false result never tells the statistics/uplink owner to stop. */
bool local_raw_hook(void *context, const cp_v3_stats_report_t *);
/* Disable intake, wait for in-flight copies, drain/sync/close. Timeout keeps
 * writer ownership and safe=false; caller must retry before unmount/PWR. */
esp_err_t local_raw_stop(local_raw_t *, uint32_t timeout_ms);
void local_raw_snapshot(local_raw_t *, local_raw_status_t *);
typedef struct {
    uint64_t files, reports, bytes, anchors;
} local_raw_verify_summary_t;
/* Read-only stopped-file CRC inspection under lifecycle+shared TF locks.
 * Rejects intake/writer/in-flight hooks/open file. Scans existing managed
 * directory only: no mkdir/probe/write/delete/charge/TTL or status reset.
 * Missing directory: ESP_ERR_NOT_FOUND; malformed/truncated CPRAW: INVALID_RESPONSE.
 * Summary contains aggregates across all managed files/boots, never paths/IDs;
 * it is zeroed on any failure. CRC validity is not power-loss/radio completeness. */
esp_err_t local_raw_verify_closed(local_raw_t *, local_raw_verify_summary_t *);
/* Stops and joins the idle task; only then frees owned memory. On failure the
 * handle remains owned/live and must not be discarded. */
esp_err_t local_raw_release(local_raw_t *, uint32_t timeout_ms);
