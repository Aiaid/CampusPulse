#include "local_raw.h"
#include "raw_board.h"
#include "raw_format.h"
#include "esp_heap_caps.h"
#include "esp_timer.h"
#include "freertos/queue.h"
#include "freertos/task.h"
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <stdio.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

#ifndef LOCAL_RAW_DIRECTORY
#define LOCAL_RAW_DIRECTORY "/sdcard/cpraw-v3"
#endif
#define TAIL_RESERVE 96u /*68-byte statistics +28-byte terminal event. */
#define ALLOCATION_MARGIN 65536u /*Conservative FAT allocation slack. */
#define DIRECTORY_LIMIT 4096u
#define DIRECTORY_METADATA 1024u
#define OPEN_METADATA 1024u
#define CLOSE_METADATA 1024u
#define SYNC_METADATA 1024u
#define PROBE_TRANSACTION (UINT64_C(3072) + RAW_HEADER_SIZE)
#ifdef ESP_PLATFORM
/* ESP-IDF's FAT VFS has no symlinks/lstat. Host validation rejects symlinks. */
#define managed_stat stat
#else
#define managed_stat lstat
#endif
struct local_raw {
    SemaphoreHandle_t tf_mutex, lifecycle, done, exited;
    StaticSemaphore_t lifecycle_memory, done_memory, exited_memory;
    local_raw_media_sync_fn media_sync;
    void *media_context;
    local_raw_budget_fn charge;
    void *budget_context;
    local_raw_clock_fn clock_at;
    void *clock_context;
    uint8_t clock_source;
    bool rtc_verified;
    QueueHandle_t free, ready;
    StaticQueue_t free_memory, ready_memory;
    uint16_t free_items[LOCAL_RAW_SLOTS], ready_items[LOCAL_RAW_SLOTS];
    raw_report_t *pool;
    TaskHandle_t task;
    portMUX_TYPE mux;
    local_raw_status_t status;
    bool accepting, stopping, terminating, space_this_run, error_this_run;
    unsigned hooks;
    local_raw_config_t config;
    uint8_t session[16];
    char boot[37];
    uint32_t segment_number;
    uint32_t probe_sequence;
    uint64_t segment_bytes, total_bytes, last_sync_us;
    FILE *file;
    bool close_prepaid;
    char file_buffer[4096];
};
static uint64_t mono_us(void) { return (uint64_t)esp_timer_get_time(); }
static void increment(uint64_t *value, uint64_t n) { *value = UINT64_MAX - *value < n ? UINT64_MAX : *value + n; }
static esp_err_t io_error(void) { return errno == ENOSPC ? RAW_STORAGE_ERR_FULL : ESP_FAIL; }
size_t local_raw_psram_bytes(void) { return LOCAL_RAW_SLOTS * sizeof(raw_report_t); }
size_t local_raw_memory_bytes(void) { return sizeof(local_raw_t) + local_raw_psram_bytes() + LOCAL_RAW_TASK_STACK + sizeof(StaticTask_t); }
static bool uuid(const char *s) {
    if (!s || strnlen(s, 37) != 36 || s[14] != '4' || !strchr("89ab", s[19])) return false;
    for (unsigned i = 0; i < 36; i++) {
        if (i == 8 || i == 13 || i == 18 || i == 23) { if (s[i] != '-') return false; }
        else if (!((s[i] >= '0' && s[i] <= '9') || (s[i] >= 'a' && s[i] <= 'f'))) return false;
    }
    return true;
}
static void problem(local_raw_t *s, local_raw_reason_t reason, esp_err_t error, bool io) {
    portENTER_CRITICAL(&s->mux);
    bool space = reason == LOCAL_RAW_QUOTA || reason == LOCAL_RAW_LOW_SPACE || reason == LOCAL_RAW_BUDGET;
    if (space && !s->space_this_run) { increment(&s->status.counters[5], 1); s->space_this_run = true; }
    if (!space && !s->error_this_run) { increment(&s->status.counters[4], 1); s->error_this_run = true; }
    if (!s->error_this_run || !space) s->status.reason = reason;
    if (!space || reason == LOCAL_RAW_BUDGET) s->status.last_error = error;
    if (io) { s->status.io_failed_latched = true; s->status.safe_to_unmount = false; }
    s->accepting = false; s->stopping = true; s->status.active = false;
    portEXIT_CRITICAL(&s->mux);
}
static bool charge(local_raw_t *s, uint64_t bytes) {
    if (!s->charge || s->charge(s->budget_context, bytes)) return true;
    problem(s, LOCAL_RAW_BUDGET, LOCAL_RAW_ERR_BUDGET, false); return false;
}
static bool failed(local_raw_t *s) {
    portENTER_CRITICAL(&s->mux); bool result = s->status.io_failed_latched; portEXIT_CRITICAL(&s->mux); return result;
}
static void dropped(local_raw_t *s) {
    portENTER_CRITICAL(&s->mux); increment(&s->status.counters[3], 1); portEXIT_CRITICAL(&s->mux);
}
static bool budget_check(local_raw_t *s, size_t bytes, size_t tail, bool io_latch) {
    if (s->total_bytes > s->config.max_total_bytes || bytes > s->config.max_total_bytes - s->total_bytes ||
        tail > s->config.max_total_bytes - s->total_bytes - bytes) {
        problem(s, LOCAL_RAW_QUOTA, RAW_STORAGE_ERR_FULL, false); return false;
    }
    uint64_t available;
    esp_err_t result = raw_storage_space(&available);
    if (result != ESP_OK) { problem(s, LOCAL_RAW_STORAGE_ERROR, result, io_latch); return false; }
    uint64_t reserve = s->config.min_free_bytes + bytes + tail + ALLOCATION_MARGIN;
    if (available < reserve) { problem(s, LOCAL_RAW_LOW_SPACE, RAW_STORAGE_ERR_FULL, false); return false; }
    return true;
}
static bool budget(local_raw_t *s, size_t bytes, size_t tail) { return budget_check(s, bytes, tail, true); }
static bool write_prepaid(local_raw_t *s, const void *bytes, size_t length) {
    errno = 0;
    size_t written = fwrite(bytes, 1, length, s->file);
    s->segment_bytes += written; s->total_bytes += written;
    portENTER_CRITICAL(&s->mux); s->status.managed_bytes = s->total_bytes; portEXIT_CRITICAL(&s->mux);
    if (written != length) { problem(s, LOCAL_RAW_STORAGE_ERROR, io_error(), true); return false; }
    return true;
}
static bool write_bytes(local_raw_t *s, const void *bytes, size_t length) {
    return charge(s, length) && write_prepaid(s, bytes, length);
}
static bool sync_file(local_raw_t *s, bool prepaid) {
    if (!s->file || failed(s)) return false;
    if (!prepaid && !charge(s, SYNC_METADATA)) return false;
    errno = 0;
    if (fflush(s->file) || fsync(fileno(s->file)) || (s->media_sync && !s->media_sync(s->media_context))) {
        problem(s, LOCAL_RAW_STORAGE_ERROR, io_error(), true); return false;
    }
    portENTER_CRITICAL(&s->mux); s->status.counters[2] = s->status.counters[1]; portEXIT_CRITICAL(&s->mux);
    s->last_sync_us = mono_us(); return true;
}
static bool close_segment(local_raw_t *s, bool terminal) {
    if (!s->file) return !failed(s);
    uint8_t frame[RAW_FRAME_MAX];
    if (!failed(s)) {
        local_raw_status_t status; local_raw_snapshot(s, &status);
        size_t n = raw_encode_stats(frame, sizeof frame, mono_us(), status.received,
            status.counters[0], status.counters[3], status.invalid_reports, status.counters[1], status.counters[2]);
        if (n) (void)write_prepaid(s, frame, n);
        if (terminal && !failed(s)) {
            uint32_t event = status.reason == LOCAL_RAW_QUOTA || status.reason == LOCAL_RAW_LOW_SPACE || status.reason == LOCAL_RAW_BUDGET ? RAW_EVENT_SPACE_STOP :
                status.reason == LOCAL_RAW_INVALID_REPORT ? RAW_EVENT_STORAGE_ERROR : RAW_EVENT_USER_STOP;
            n = raw_encode_event(frame, sizeof frame, mono_us(), event, status.last_error);
            if (n) (void)write_prepaid(s, frame, n);
        }
        if (!failed(s)) (void)sync_file(s, true);
    }
    errno = 0;
    if (fclose(s->file)) problem(s, LOCAL_RAW_STORAGE_ERROR, io_error(), true);
    s->file = NULL;
    s->close_prepaid = false;
    if (s->media_sync && !s->media_sync(s->media_context)) problem(s, LOCAL_RAW_STORAGE_ERROR, ESP_FAIL, true);
    return !failed(s);
}
static size_t clock_frame(local_raw_t *s, uint8_t frame[RAW_FRAME_MAX]) {
    if (!s->rtc_verified || !s->clock_at) return 0;
    uint64_t at = mono_us(); cp_v3_temporal_time_t time = {0};
    if (!s->clock_at(s->clock_context, at / 1000u, &time) || !time.utc_known || !time.clock_epoch || time.mono_ms != at / 1000u ||
        time.utc_ms < UINT64_C(1704067200000) || time.utc_ms > UINT64_C(7258118400000) ||
        time.uncertainty_ms > (UINT32_MAX - 1000000u) / 1000u) return 0;
    return raw_encode_clock(frame, RAW_FRAME_MAX, at, time.utc_ms / 1000u,
        time.uncertainty_ms * 1000u + 1000000u, s->clock_source);
}
static bool open_segment(local_raw_t *s) {
    uint8_t frame[RAW_FRAME_MAX]; size_t anchor = clock_frame(s, frame);
    if (!budget(s, RAW_HEADER_SIZE + anchor, TAIL_RESERVE)) return false;
    /* Initial header sync and eventual footer/close are fully authorized before
     * creation. Never refund unused authorization on rotation/failure/reboot. */
    if (!charge(s, OPEN_METADATA + CLOSE_METADATA + RAW_HEADER_SIZE + anchor + TAIL_RESERVE)) return false;
    s->close_prepaid = true;
    char session[33], path[192];
    for (unsigned i = 0; i < 16; i++) snprintf(session + i * 2, 3, "%02x", s->session[i]);
    int fd = -1;
    for (unsigned tries = 0; tries < DIRECTORY_LIMIT; tries++) {
        if (s->segment_number == UINT32_MAX) break;
        int n = snprintf(path, sizeof path, "%s/%s-%s-%08lu.bin", LOCAL_RAW_DIRECTORY, s->boot, session, (unsigned long)s->segment_number++);
        if (n <= 0 || (size_t)n >= sizeof path) break;
        fd = open(path, O_WRONLY | O_CREAT | O_EXCL, 0600);
        if (fd >= 0) break;
        if (errno != EEXIST) { problem(s, LOCAL_RAW_STORAGE_ERROR, io_error(), true); return false; }
    }
    if (fd < 0) { problem(s, LOCAL_RAW_DIRECTORY_ERROR, ESP_ERR_INVALID_STATE, false); return false; }
    s->file = fdopen(fd, "wb"); s->segment_bytes = 0;
    if (!s->file) { (void)close(fd); problem(s, LOCAL_RAW_STORAGE_ERROR, io_error(), true); return false; }
    portENTER_CRITICAL(&s->mux); s->status.safe_to_unmount = false; portEXIT_CRITICAL(&s->mux);
    if (setvbuf(s->file, s->file_buffer, _IOFBF, sizeof s->file_buffer)) { problem(s, LOCAL_RAW_STORAGE_ERROR, ESP_FAIL, true); return false; }
    uint8_t header[RAW_HEADER_SIZE]; size_t n = raw_encode_header(header, sizeof header, s->session);
    if (!n || !write_prepaid(s, header, n)) return false;
    if (anchor && !write_prepaid(s, frame, anchor)) return false;
    if (anchor) { portENTER_CRITICAL(&s->mux); increment(&s->status.clock_anchors, 1); portEXIT_CRITICAL(&s->mux); }
    return sync_file(s, true);
}
static uint32_t u32(const uint8_t *p) { return (uint32_t)p[0] | (uint32_t)p[1] << 8 | (uint32_t)p[2] << 16 | (uint32_t)p[3] << 24; }
static uint32_t crc(const uint8_t *p, size_t n) {
    uint32_t value = UINT32_MAX;
    while (n--) { value ^= *p++; for (unsigned b = 0; b < 8; b++) value = (value >> 1) ^ (0xedb88320u & (0u - (value & 1u))); }
    return value ^ UINT32_MAX;
}
static bool valid_file(const char *path, uint64_t size, local_raw_verify_summary_t *summary) {
    if (summary) memset(summary, 0, sizeof *summary);
    if (size < RAW_HEADER_SIZE) return false;
    FILE *file = fopen(path, "rb"); if (!file) return false;
    struct stat opened;
    bool ok = !fstat(fileno(file), &opened) && S_ISREG(opened.st_mode) && opened.st_size >= 0 && (uint64_t)opened.st_size == size;
    uint8_t bytes[RAW_FRAME_MAX], expected[RAW_HEADER_SIZE];
    if (ok) ok = fread(bytes, 1, RAW_HEADER_SIZE, file) == RAW_HEADER_SIZE;
    if (ok) ok = raw_encode_header(expected, sizeof expected, bytes + 12) == RAW_HEADER_SIZE && !memcmp(bytes, expected, RAW_HEADER_SIZE);
    uint64_t used = RAW_HEADER_SIZE, reports = 0, anchors = 0;
    while (ok && used < size) {
        if (size - used < 4 || fread(bytes, 1, 4, file) != 4) { ok = false; break; }
        uint32_t n = u32(bytes);
        if (n < 12 || n > RAW_FRAME_MAX || n > size - used || fread(bytes + 4, 1, n - 4, file) != n - 4) { ok = false; break; }
        ok = !bytes[5] && !bytes[6] && !bytes[7] && u32(bytes + n - 4) == crc(bytes, n - 4);
        if (ok) switch (bytes[4]) {
            case 1: ok = n >= 55 && n == 55u + bytes[24] + ((uint32_t)bytes[25] << 8) && bytes[35] <= 1; if (ok) reports++; break;
            case 2: ok = n == 68; break;
            case 3: ok = n == 28; break;
            case 4: ok = n == 33 && (bytes[28] == RAW_CLOCK_RTC || bytes[28] == RAW_CLOCK_HOST_CALIBRATED_RTC); if (ok) anchors++; break;
            default: ok = false;
        }
        used += n;
    }
    if (ok) ok = fgetc(file) == EOF && !ferror(file) && !fstat(fileno(file), &opened) && opened.st_size >= 0 && (uint64_t)opened.st_size == size;
    if (fclose(file)) ok = false;
    if (ok && summary) *summary = (local_raw_verify_summary_t){.files = 1, .reports = reports, .bytes = size, .anchors = anchors};
    return ok;
}
static bool directory(local_raw_t *s) {
    errno = 0;
    struct stat st;
    if (stat(LOCAL_RAW_DIRECTORY, &st)) {
        if (errno != ENOENT) { problem(s, LOCAL_RAW_DIRECTORY_ERROR, io_error(), false); return false; }
        if (!charge(s, DIRECTORY_METADATA)) return false;
        if (mkdir(LOCAL_RAW_DIRECTORY, 0700) || stat(LOCAL_RAW_DIRECTORY, &st)) { problem(s, LOCAL_RAW_DIRECTORY_ERROR, io_error(), false); return false; }
    }
    if (!S_ISDIR(st.st_mode)) { problem(s, LOCAL_RAW_DIRECTORY_ERROR, ESP_FAIL, false); return false; }
    DIR *dir = opendir(LOCAL_RAW_DIRECTORY);
    if (!dir) { problem(s, LOCAL_RAW_DIRECTORY_ERROR, io_error(), false); return false; }
    s->total_bytes = 0; unsigned count = 0; bool ok = true; struct dirent *entry;
    errno = 0;
    while ((entry = readdir(dir))) {
        if (!strcmp(entry->d_name, ".") || !strcmp(entry->d_name, "..")) continue;
        char path[192];
        int n = snprintf(path, sizeof path, "%s/%s", LOCAL_RAW_DIRECTORY, entry->d_name);
        if (++count > DIRECTORY_LIMIT || n <= 0 || (size_t)n >= sizeof path || managed_stat(path, &st) || !S_ISREG(st.st_mode) || st.st_size < 0 ||
            (uint64_t)st.st_size > UINT64_MAX - s->total_bytes) { ok = false; break; }
        s->total_bytes += (uint64_t)st.st_size;
        if (s->total_bytes > s->config.max_total_bytes) { problem(s, LOCAL_RAW_QUOTA, RAW_STORAGE_ERR_FULL, false); ok = false; break; }
        if (!valid_file(path, (uint64_t)st.st_size, NULL)) { ok = false; break; }
        errno = 0;
    }
    int read_error = errno;
    if (closedir(dir)) ok = false;
    portENTER_CRITICAL(&s->mux); s->status.managed_bytes = s->total_bytes; portEXIT_CRITICAL(&s->mux);
    if (!ok || read_error) {
        if (!s->space_this_run) problem(s, LOCAL_RAW_DIRECTORY_ERROR, ESP_ERR_INVALID_RESPONSE, false);
        return false;
    }
    return true;
}
static void writer(void *context) {
    local_raw_t *s = context; uint8_t frame[RAW_FRAME_MAX];
    for (;;) {
        portENTER_CRITICAL(&s->mux); bool running = s->status.writer_running, terminate = s->terminating; portEXIT_CRITICAL(&s->mux);
        if (terminate) break;
        if (!running) { (void)ulTaskNotifyTake(pdTRUE, portMAX_DELAY); continue; }
        uint16_t index;
        if (xQueueReceive(s->ready, &index, pdMS_TO_TICKS(20)) == pdTRUE) {
            bool space;
            portENTER_CRITICAL(&s->mux); space = s->space_this_run; portEXIT_CRITICAL(&s->mux);
            if (failed(s) || space) dropped(s);
            else {
                size_t n = raw_encode_report(frame, sizeof frame, &s->pool[index]);
                if (!n) { problem(s, LOCAL_RAW_INVALID_REPORT, ESP_ERR_INVALID_ARG, false); dropped(s); }
                else {
                    xSemaphoreTake(s->tf_mutex, portMAX_DELAY);
                    bool ok = true;
                    if (s->segment_bytes + n + TAIL_RESERVE > s->config.max_segment_bytes) ok = close_segment(s, false) && open_segment(s);
                    if (ok) ok = budget(s, n, TAIL_RESERVE) && write_bytes(s, frame, n);
                    if (ok) { portENTER_CRITICAL(&s->mux); increment(&s->status.counters[1], 1); portEXIT_CRITICAL(&s->mux); }
                    else dropped(s);
                    xSemaphoreGive(s->tf_mutex);
                }
            }
            memset(&s->pool[index], 0, sizeof s->pool[index]);
            (void)xQueueSend(s->free, &index, 0);
        }
        portENTER_CRITICAL(&s->mux); bool stop = s->stopping && !s->hooks; portEXIT_CRITICAL(&s->mux);
        if (stop && !uxQueueMessagesWaiting(s->ready)) {
            xSemaphoreTake(s->tf_mutex, portMAX_DELAY); (void)close_segment(s, true); xSemaphoreGive(s->tf_mutex);
            portENTER_CRITICAL(&s->mux);
            s->status.writer_running = s->status.active = false;
            if (s->status.reason == LOCAL_RAW_STOPPING || s->status.reason == LOCAL_RAW_RECORDING) s->status.reason = LOCAL_RAW_STOPPED;
            s->status.safe_to_unmount = !s->status.io_failed_latched && !s->file;
            portEXIT_CRITICAL(&s->mux); xSemaphoreGive(s->done);
        } else if (!failed(s) && s->file && mono_us() - s->last_sync_us >= (uint64_t)s->config.sync_ms * 1000u) {
            xSemaphoreTake(s->tf_mutex, portMAX_DELAY); (void)sync_file(s, false); xSemaphoreGive(s->tf_mutex);
        }
    }
    xSemaphoreGive(s->exited); vTaskDelete(NULL);
}
esp_err_t local_raw_prepare(SemaphoreHandle_t mutex, local_raw_media_sync_fn sync, void *context, local_raw_t **out) {
    if (!out || !mutex) return ESP_ERR_INVALID_ARG;
    *out = NULL;
    local_raw_t *s = heap_caps_calloc(1, sizeof *s, MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT);
    if (!s) return ESP_ERR_NO_MEM;
    s->pool = heap_caps_calloc(LOCAL_RAW_SLOTS, sizeof *s->pool, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
    if (!s->pool) { heap_caps_free(s); return ESP_ERR_NO_MEM; }
    s->mux = (portMUX_TYPE)portMUX_INITIALIZER_UNLOCKED;
    s->tf_mutex = mutex; s->media_sync = sync; s->media_context = context;
    s->lifecycle = xSemaphoreCreateMutexStatic(&s->lifecycle_memory);
    s->done = xSemaphoreCreateBinaryStatic(&s->done_memory); s->exited = xSemaphoreCreateBinaryStatic(&s->exited_memory);
    s->free = xQueueCreateStatic(LOCAL_RAW_SLOTS, sizeof(uint16_t), (uint8_t *)s->free_items, &s->free_memory);
    s->ready = xQueueCreateStatic(LOCAL_RAW_SLOTS, sizeof(uint16_t), (uint8_t *)s->ready_items, &s->ready_memory);
    for (uint16_t i = 0; i < LOCAL_RAW_SLOTS; i++) (void)xQueueSend(s->free, &i, 0);
    s->status.reason = LOCAL_RAW_DISABLED; s->status.safe_to_unmount = true;
    if (xTaskCreate(writer, "local_raw", LOCAL_RAW_TASK_STACK, s, 3, &s->task) != pdPASS) { heap_caps_free(s->pool); heap_caps_free(s); return ESP_ERR_NO_MEM; }
    *out = s; return ESP_OK;
}
esp_err_t local_raw_set_clock(local_raw_t *s, local_raw_clock_fn clock, void *context, uint8_t source, bool verified) {
    if (!s || (clock && source != RAW_CLOCK_RTC && source != RAW_CLOCK_HOST_CALIBRATED_RTC)) return ESP_ERR_INVALID_ARG;
    xSemaphoreTake(s->lifecycle, portMAX_DELAY);
    portENTER_CRITICAL(&s->mux); bool busy = s->status.writer_running; portEXIT_CRITICAL(&s->mux);
    if (!busy) { s->clock_at = clock; s->clock_context = context; s->clock_source = source; s->rtc_verified = verified; }
    xSemaphoreGive(s->lifecycle); return busy ? ESP_ERR_INVALID_STATE : ESP_OK;
}
esp_err_t local_raw_set_budget(local_raw_t *s, local_raw_budget_fn callback, void *context) {
    if (!s) return ESP_ERR_INVALID_ARG;
    xSemaphoreTake(s->lifecycle, portMAX_DELAY);
    portENTER_CRITICAL(&s->mux); bool busy = s->status.writer_running; portEXIT_CRITICAL(&s->mux);
    if (!busy) { s->charge = callback; s->budget_context = context; }
    xSemaphoreGive(s->lifecycle); return busy ? ESP_ERR_INVALID_STATE : ESP_OK;
}
static bool config_valid(const local_raw_config_t *config) {
    const uint64_t limit = UINT64_C(1) << 40;
    return config && config->max_segment_bytes >= 2048 && config->max_segment_bytes <= config->max_total_bytes &&
        config->max_total_bytes <= limit && config->min_free_bytes <= limit && config->min_free_bytes && config->sync_ms >= 100 && config->sync_ms <= 60000;
}
esp_err_t local_raw_start(local_raw_t *s, const local_raw_config_t *config, const char boot[37], const uint8_t session[16]) {
    if (!s || !uuid(boot) || !session || !config_valid(config)) return ESP_ERR_INVALID_ARG;
    xSemaphoreTake(s->lifecycle, portMAX_DELAY);
    portENTER_CRITICAL(&s->mux); bool busy = s->status.writer_running || s->hooks || s->status.io_failed_latched; portEXIT_CRITICAL(&s->mux);
    if (busy) { xSemaphoreGive(s->lifecycle); return ESP_ERR_INVALID_STATE; }
    (void)xSemaphoreTake(s->done, 0);
    s->config = *config; memcpy(s->boot, boot, 37); memcpy(s->session, session, 16);
    s->segment_number = 0; s->stopping = s->space_this_run = s->error_this_run = false;
    portENTER_CRITICAL(&s->mux); s->status.last_error = ESP_OK; s->status.reason = LOCAL_RAW_DISABLED; s->status.safe_to_unmount = false; portEXIT_CRITICAL(&s->mux);
    xSemaphoreTake(s->tf_mutex, portMAX_DELAY);
    bool ok = directory(s) && open_segment(s);
    if (!ok) (void)close_segment(s, false);
    xSemaphoreGive(s->tf_mutex);
    portENTER_CRITICAL(&s->mux);
    s->status.writer_running = s->status.active = s->accepting = ok;
    s->status.safe_to_unmount = !ok && !s->file && !s->status.io_failed_latched;
    if (ok) s->status.reason = LOCAL_RAW_RECORDING;
    esp_err_t result = ok ? ESP_OK : s->status.last_error != ESP_OK ? s->status.last_error : RAW_STORAGE_ERR_FULL;
    portEXIT_CRITICAL(&s->mux);
    if (ok) xTaskNotifyGive(s->task);
    xSemaphoreGive(s->lifecycle); return result;
}
esp_err_t local_raw_probe(local_raw_t *s, const local_raw_config_t *config, local_raw_status_t *status) {
    if (!s || !config_valid(config)) {
        if (status) local_raw_snapshot(s, status);
        return ESP_ERR_INVALID_ARG;
    }
    xSemaphoreTake(s->lifecycle, portMAX_DELAY);
    portENTER_CRITICAL(&s->mux);
    bool busy = s->status.writer_running || s->hooks || s->status.io_failed_latched || s->file;
    if (!busy) {
        s->accepting = s->status.active = false; s->stopping = s->space_this_run = s->error_this_run = false;
        s->status.last_error = ESP_OK; s->status.reason = LOCAL_RAW_DISABLED; s->status.safe_to_unmount = false;
    }
    portEXIT_CRITICAL(&s->mux);
    if (busy) {
        xSemaphoreGive(s->lifecycle); if (status) local_raw_snapshot(s, status); return ESP_ERR_INVALID_STATE;
    }
    s->config = *config;
    xSemaphoreTake(s->tf_mutex, portMAX_DELAY);
    /* Establish mounted free-space information before mkdir. No write or open
     * has happened, so this failure cannot leave writer ownership uncertain. */
    uint64_t available;
    esp_err_t result = raw_storage_space(&available);
    if (result != ESP_OK) problem(s, LOCAL_RAW_STORAGE_ERROR, result, false);
    bool ok = result == ESP_OK && directory(s) &&
        budget_check(s, RAW_HEADER_SIZE + 33u + RAW_FRAME_MAX + TAIL_RESERVE, 0, false);
    if (ok) ok = charge(s, PROBE_TRANSACTION);
    char path[192] = {0}; int fd = -1;
    if (ok) {
        for (unsigned tries = 0; tries < DIRECTORY_LIMIT; tries++) {
            if (s->probe_sequence == UINT32_MAX) break;
            int n = snprintf(path, sizeof path, "%s/.probe-%016llx-%08lu.tmp", LOCAL_RAW_DIRECTORY,
                (unsigned long long)mono_us(), (unsigned long)s->probe_sequence++);
            if (n <= 0 || (size_t)n >= sizeof path) break;
            errno = 0; fd = open(path, O_WRONLY | O_CREAT | O_EXCL, 0600);
            if (fd >= 0 || errno != EEXIST) break;
        }
        if (fd < 0) {
            problem(s, errno == ENOSPC ? LOCAL_RAW_LOW_SPACE : LOCAL_RAW_DIRECTORY_ERROR, io_error(), false);
            ok = false;
        }
    }
    if (fd >= 0) {
        /* Only a path created by this exact O_EXCL call is ever removed. */
        FILE *file = fdopen(fd, "wb");
        if (!file) {
            problem(s, LOCAL_RAW_STORAGE_ERROR, ESP_ERR_NO_MEM, false); ok = false;
            if (close(fd)) problem(s, LOCAL_RAW_STORAGE_ERROR, io_error(), true);
        } else {
            uint8_t header[RAW_HEADER_SIZE], probe_session[16] = {0};
            size_t n = raw_encode_header(header, sizeof header, probe_session);
            errno = 0;
            if (n != RAW_HEADER_SIZE || fwrite(header, 1, n, file) != n) {
                problem(s, LOCAL_RAW_STORAGE_ERROR, io_error(), true); ok = false;
            }
            errno = 0;
            if (fflush(file) || fsync(fileno(file)) || (s->media_sync && !s->media_sync(s->media_context))) {
                problem(s, LOCAL_RAW_STORAGE_ERROR, io_error(), true); ok = false;
            }
            errno = 0;
            if (fclose(file)) { problem(s, LOCAL_RAW_STORAGE_ERROR, io_error(), true); ok = false; }
        }
        errno = 0;
        if (unlink(path)) { problem(s, LOCAL_RAW_STORAGE_ERROR, io_error(), true); ok = false; }
        if (s->media_sync && !s->media_sync(s->media_context)) { problem(s, LOCAL_RAW_STORAGE_ERROR, ESP_FAIL, true); ok = false; }
    }
    portENTER_CRITICAL(&s->mux);
    s->status.safe_to_unmount = !s->status.io_failed_latched;
    if (ok) { s->status.reason = LOCAL_RAW_DISABLED; s->status.last_error = ESP_OK; }
    result = ok ? ESP_OK : s->status.last_error != ESP_OK ? s->status.last_error : RAW_STORAGE_ERR_FULL;
    portEXIT_CRITICAL(&s->mux);
    xSemaphoreGive(s->tf_mutex); xSemaphoreGive(s->lifecycle);
    if (status) local_raw_snapshot(s, status);
    return result;
}
bool local_raw_hook(void *context, const cp_v3_stats_report_t *r) {
    local_raw_t *s = context; if (!s || !r) return false;
    portENTER_CRITICAL(&s->mux);
    if (!s->accepting) { portEXIT_CRITICAL(&s->mux); return false; }
    ++s->hooks; increment(&s->status.received, 1); portEXIT_CRITICAL(&s->mux);
    bool valid = r->kind <= 1 && r->length <= RAW_PAYLOAD_MAX && (!r->length || r->payload) &&
        r->rssi >= INT8_MIN && r->rssi <= INT8_MAX && r->tx_power >= INT8_MIN && r->tx_power <= INT8_MAX;
    uint16_t index; bool queued = false;
    if (!valid) {
        portENTER_CRITICAL(&s->mux); increment(&s->status.invalid_reports, 1); portEXIT_CRITICAL(&s->mux);
        problem(s, LOCAL_RAW_INVALID_REPORT, ESP_ERR_INVALID_ARG, false);
    } else if (xQueueReceive(s->free, &index, 0) == pdTRUE) {
        raw_report_t *out = &s->pool[index]; memset(out, 0, sizeof *out);
        out->seq = r->seq; out->mono_us = r->mono_us; out->length = (uint16_t)r->length;
        memcpy(out->addr, r->address, 6); out->addr_type = r->address_type; out->kind = r->kind;
        out->event_type = r->event_type; out->props = r->props; out->data_status = r->data_status; out->sid = r->sid;
        out->primary_phy = r->primary_phy; out->secondary_phy = r->secondary_phy; out->periodic_interval = r->periodic_interval;
        out->direct_addr_type = r->direct_address_type; memcpy(out->direct_addr, r->direct_address, 6);
        out->rssi = (int8_t)r->rssi; out->tx_power = (int8_t)r->tx_power;
        if (r->length) memcpy(out->payload, r->payload, r->length);
        /* Successful publication + accounting are indivisible to writer/status:
         * invariant synced<=written<=enqueued, without decrementing any counter. */
        portENTER_CRITICAL(&s->mux);
        queued = xQueueSend(s->ready, &index, 0) == pdTRUE;
        if (queued) increment(&s->status.counters[0], 1);
        portEXIT_CRITICAL(&s->mux);
        if (!queued) {
            memset(out, 0, sizeof *out); (void)xQueueSend(s->free, &index, 0);
        }
    }
    if (valid && !queued) dropped(s);
    portENTER_CRITICAL(&s->mux); --s->hooks; portEXIT_CRITICAL(&s->mux);
    return queued;
}
esp_err_t local_raw_stop(local_raw_t *s, uint32_t timeout_ms) {
    if (!s) return ESP_ERR_INVALID_ARG;
    xSemaphoreTake(s->lifecycle, portMAX_DELAY);
    portENTER_CRITICAL(&s->mux); s->accepting = s->status.active = false; s->stopping = true;
    bool running = s->status.writer_running;
    if (running && s->status.reason == LOCAL_RAW_RECORDING) s->status.reason = LOCAL_RAW_STOPPING;
    portEXIT_CRITICAL(&s->mux);
    if (running) {
        xTaskNotifyGive(s->task);
        if (xSemaphoreTake(s->done, pdMS_TO_TICKS(timeout_ms)) != pdTRUE) { xSemaphoreGive(s->lifecycle); return ESP_ERR_TIMEOUT; }
    }
    portENTER_CRITICAL(&s->mux); esp_err_t result = s->status.last_error; portEXIT_CRITICAL(&s->mux);
    xSemaphoreGive(s->lifecycle); return result;
}
void local_raw_snapshot(local_raw_t *s, local_raw_status_t *out) {
    if (!out) return;
    memset(out, 0, sizeof *out); if (!s) return;
    portENTER_CRITICAL(&s->mux); *out = s->status; portEXIT_CRITICAL(&s->mux);
    out->free_slots = uxQueueMessagesWaiting(s->free); out->capacity = LOCAL_RAW_SLOTS;
    out->memory_bytes = local_raw_memory_bytes(); out->psram_bytes = local_raw_psram_bytes();
}
esp_err_t local_raw_verify_closed(local_raw_t *s, local_raw_verify_summary_t *summary) {
    if (!summary) return ESP_ERR_INVALID_ARG;
    memset(summary, 0, sizeof *summary);
    if (!s) return ESP_ERR_INVALID_ARG;
    xSemaphoreTake(s->lifecycle, portMAX_DELAY);
    portENTER_CRITICAL(&s->mux);
    bool busy = s->accepting || s->status.active || s->status.writer_running || s->hooks || s->file || s->terminating;
    portEXIT_CRITICAL(&s->mux);
    if (busy) { xSemaphoreGive(s->lifecycle); return ESP_ERR_INVALID_STATE; }
    xSemaphoreTake(s->tf_mutex, portMAX_DELAY);
    errno = 0;
    /* Deliberately independent of directory(): not even an ENOENT race may
     * reach mkdir, budget admission or the mutable start/probe status path. */
    DIR *dir = opendir(LOCAL_RAW_DIRECTORY);
    esp_err_t result = ESP_OK;
    local_raw_verify_summary_t total = {0};
    if (!dir) result = errno == ENOENT ? ESP_ERR_NOT_FOUND : ESP_FAIL;
    else {
        struct dirent *entry; unsigned entries = 0;
        errno = 0;
        while ((entry = readdir(dir))) {
            if (!strcmp(entry->d_name, ".") || !strcmp(entry->d_name, "..")) continue;
            char path[192]; struct stat st;
            int n = snprintf(path, sizeof path, "%s/%s", LOCAL_RAW_DIRECTORY, entry->d_name);
            local_raw_verify_summary_t file;
            if (++entries > DIRECTORY_LIMIT || n <= 0 || (size_t)n >= sizeof path || managed_stat(path, &st) ||
                !S_ISREG(st.st_mode) || st.st_size < 0 || !valid_file(path, (uint64_t)st.st_size, &file) ||
                file.bytes > UINT64_MAX - total.bytes || file.reports > UINT64_MAX - total.reports || file.anchors > UINT64_MAX - total.anchors) {
                result = ESP_ERR_INVALID_RESPONSE; break;
            }
            total.files += file.files; total.reports += file.reports; total.bytes += file.bytes; total.anchors += file.anchors;
            errno = 0;
        }
        if (errno && result == ESP_OK) result = ESP_FAIL;
        if (closedir(dir) && result == ESP_OK) result = ESP_FAIL;
    }
    xSemaphoreGive(s->tf_mutex); xSemaphoreGive(s->lifecycle);
    if (result == ESP_OK) *summary = total;
    return result;
}
esp_err_t local_raw_release(local_raw_t *s, uint32_t timeout_ms) {
    if (!s) return ESP_ERR_INVALID_ARG;
    esp_err_t result = local_raw_stop(s, timeout_ms);
    if (result != ESP_OK) return result;
    xSemaphoreTake(s->lifecycle, portMAX_DELAY);
    portENTER_CRITICAL(&s->mux); s->terminating = true; portEXIT_CRITICAL(&s->mux); xTaskNotifyGive(s->task);
    if (xSemaphoreTake(s->exited, pdMS_TO_TICKS(timeout_ms)) != pdTRUE) { xSemaphoreGive(s->lifecycle); return ESP_ERR_TIMEOUT; }
    xSemaphoreGive(s->lifecycle);
    vQueueDelete(s->free); vQueueDelete(s->ready);
    vSemaphoreDelete(s->done); vSemaphoreDelete(s->exited); vSemaphoreDelete(s->lifecycle);
    memset(s->pool, 0, local_raw_psram_bytes()); heap_caps_free(s->pool); memset(s, 0, sizeof *s); heap_caps_free(s);
    return ESP_OK;
}
