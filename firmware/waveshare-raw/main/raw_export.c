#include "raw_export.h"

#include <dirent.h>
#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>
#include "raw_board.h"
#include "raw_format.h"

#define EXPORT_DIRECTORY "/sdcard/cpraw"
#define EXPORT_FILES_MAX 128u
#define EXPORT_NAME_LENGTH (32u + 1u + 8u + 4u)
/* A segment can cross the rotation threshold by one report and stop/stats
 * frames. Reject anomalous lengths before any narrowing conversion or seek. */
#define EXPORT_SIZE_MAX (16u * 1024u * 1024u + 2u * RAW_FRAME_MAX)

typedef struct {
    char path[sizeof(EXPORT_DIRECTORY) + 1u + EXPORT_NAME_LENGTH];
    uint32_t size;
} export_file_t;

static export_file_t s_files[EXPORT_FILES_MAX];
static size_t s_count;
static bool s_truncated, s_ready, s_mount_attempted;

static bool valid_name(const char *name) {
    if (strlen(name) != EXPORT_NAME_LENGTH) return false;
    for (size_t i = 0; i < 32; ++i) {
        char c = name[i];
        if (!((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') ||
              (c >= 'A' && c <= 'F'))) return false;
    }
    if (name[32] != '-') return false;
    for (size_t i = 33; i < 41; ++i)
        if (name[i] < '0' || name[i] > '9') return false;
    return strcmp(name + 41, ".bin") == 0;
}

static bool valid_size(const struct stat *st) {
    return S_ISREG(st->st_mode) && st->st_size >= 0 &&
           (uint64_t)st->st_size <= EXPORT_SIZE_MAX;
}

static int compare_files(const void *left, const void *right) {
    return strcmp(((const export_file_t *)left)->path,
                  ((const export_file_t *)right)->path);
}

esp_err_t raw_export_close(void) {
    s_ready = false;
    s_count = 0;
    s_truncated = false;
    memset(s_files, 0, sizeof(s_files));
    if (!s_mount_attempted) return ESP_OK;
    esp_err_t err = raw_storage_unmount();
    if (err == ESP_OK) s_mount_attempted = false;
    return err;
}

esp_err_t raw_export_prepare(void) {
    if (s_mount_attempted || s_ready) return ESP_ERR_INVALID_STATE;
    /* Mount can partially succeed before its directory check fails. Always
     * attempt unmount on failure, and permit close to retry an unmount error. */
    s_mount_attempted = true;
    esp_err_t result = raw_storage_mount();
    if (result != ESP_OK) { (void)raw_export_close(); return result; }
    DIR *directory = opendir(EXPORT_DIRECTORY);
    if (!directory) { (void)raw_export_close(); return ESP_FAIL; }
    for (;;) {
        errno = 0;
        struct dirent *entry = readdir(directory);
        if (!entry) { if (errno) result = ESP_FAIL; break; }
        if (!valid_name(entry->d_name)) continue;
        export_file_t file = {0};
        int written = snprintf(file.path, sizeof(file.path), "%s/%s",
                               EXPORT_DIRECTORY, entry->d_name);
        if (written < 0 || (size_t)written >= sizeof(file.path)) {
            result = ESP_FAIL; break;
        }
        struct stat st;
        if (stat(file.path, &st) != 0) { result = ESP_FAIL; break; }
        if (!S_ISREG(st.st_mode)) continue;
        if (!valid_size(&st)) { result = ESP_FAIL; break; }
        file.size = (uint32_t)st.st_size;
        if (s_count == EXPORT_FILES_MAX) { s_truncated = true; continue; }
        s_files[s_count++] = file;
    }
    if (closedir(directory) != 0) result = ESP_FAIL;
    if (result != ESP_OK) { (void)raw_export_close(); return result; }
    qsort(s_files, s_count, sizeof(s_files[0]), compare_files);
    s_ready = true;
    return ESP_OK;
}

size_t raw_export_count(void) { return s_ready ? s_count : 0; }
bool raw_export_truncated(void) { return s_ready && s_truncated; }

esp_err_t raw_export_find(const char *path, unsigned *index) {
    if (!path || !index) return ESP_ERR_INVALID_ARG;
    if (!s_ready) return ESP_ERR_INVALID_STATE;
    for (unsigned i = 0; i < s_count; i++) {
        if (!strcmp(path, s_files[i].path)) { *index = i; return ESP_OK; }
    }
    return ESP_FAIL;
}

esp_err_t raw_export_size(unsigned index, uint32_t *size) {
    if (!size) return ESP_ERR_INVALID_ARG;
    *size = 0;
    if (!s_ready) return ESP_ERR_INVALID_STATE;
    if (index >= s_count) return ESP_ERR_INVALID_ARG;
    struct stat st;
    if (stat(s_files[index].path, &st) != 0 || !valid_size(&st) ||
        (uint64_t)st.st_size != s_files[index].size) return ESP_FAIL;
    *size = s_files[index].size;
    return ESP_OK;
}

esp_err_t raw_export_read(unsigned index, uint32_t offset, uint8_t *data,
                          size_t cap, size_t *length) {
    if (!length) return ESP_ERR_INVALID_ARG;
    *length = 0;
    if (cap > 512 || (!data && cap)) return ESP_ERR_INVALID_ARG;
    if (!s_ready) return ESP_ERR_INVALID_STATE;
    if (index >= s_count || offset > s_files[index].size)
        return ESP_ERR_INVALID_ARG;
    FILE *file = fopen(s_files[index].path, "rb");
    if (!file) return ESP_FAIL;
    struct stat st;
    esp_err_t result = ESP_FAIL;
    if (fstat(fileno(file), &st) == 0 && valid_size(&st) &&
        (uint64_t)st.st_size == s_files[index].size &&
        fseek(file, (long)offset, SEEK_SET) == 0) {
        size_t count = cap ? fread(data, 1, cap, file) : 0;
        if (!ferror(file)) { *length = count; result = ESP_OK; }
    }
    if (fclose(file) != 0) result = ESP_FAIL;
    if (result != ESP_OK) *length = 0;
    return result;
}

uint32_t raw_export_crc32(const void *data, size_t length) {
    const uint8_t *bytes = data;
    uint32_t crc = UINT32_MAX;
    for (size_t i = 0; i < length; ++i) {
        crc ^= bytes[i];
        for (unsigned bit = 0; bit < 8; ++bit)
            crc = (crc >> 1) ^ (0xedb88320u & (0u - (crc & 1u)));
    }
    return ~crc;
}
