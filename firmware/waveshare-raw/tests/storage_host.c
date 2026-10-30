/* Exercise production raw_board.c with real host files and injected IO failures. */
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>
#include "esp_vfs_fat.h"

static const char *root;
static int fail_write, fail_flush, fail_sync, fail_close, fault_errno;
static unsigned writes, flushes, syncs, closes, unmounts;
static const char *host_path(const char *path) {
    static char result[2048];
    if (strncmp(path, "/sdcard", 7) != 0) abort();
    if (snprintf(result, sizeof result, "%s%s", root, path + 7) >= (int)sizeof result) abort();
    return result;
}
static int test_open(const char *path, int flags, mode_t mode) { return open(host_path(path), flags, mode); }
static int test_mkdir(const char *path, mode_t mode) { return mkdir(host_path(path), mode); }
static int test_stat(const char *path, struct stat *st) { return stat(host_path(path), st); }
static size_t test_fwrite(const void *p, size_t size, size_t n, FILE *stream) {
    ++writes;
    if (fail_write) {
        fail_write = 0;
        size_t partial = n ? n - 1 : 0;
        size_t actual = fwrite(p, size, partial, stream);
        errno = fault_errno;
        return actual;
    }
    return fwrite(p, size, n, stream);
}
static int test_fflush(FILE *stream) {
    ++flushes;
    if (fail_flush) { fail_flush = 0; errno = fault_errno; return EOF; }
    return fflush(stream);
}
static int test_fsync(int fd) {
    ++syncs;
    if (fail_sync) { fail_sync = 0; errno = fault_errno; return -1; }
    return fsync(fd);
}
static int test_fclose(FILE *stream) {
    ++closes;
    int rc = fclose(stream);
    if (fail_close) { fail_close = 0; errno = fault_errno; return EOF; }
    return rc;
}
#define open test_open
#define mkdir test_mkdir
#define stat(path, st) test_stat(path, st)
#define fwrite test_fwrite
#define fflush test_fflush
#define fsync test_fsync
#define fclose test_fclose
#include "../main/raw_board.c"
#undef open
#undef mkdir
#undef stat
#undef fwrite
#undef fflush
#undef fsync
#undef fclose

esp_err_t esp_vfs_fat_sdmmc_mount(const char *path, const sdmmc_host_t *host,
                                 const sdmmc_slot_config_t *slot,
                                 const esp_vfs_fat_sdmmc_mount_config_t *cfg, sdmmc_card_t **card) {
    static sdmmc_card_t fake;
    (void)path; (void)host; (void)slot;
    if (cfg->format_if_mount_failed) abort();
    *card = &fake; return ESP_OK;
}
esp_err_t esp_vfs_fat_sdcard_unmount(const char *path, sdmmc_card_t *card) {
    (void)path; (void)card; ++unmounts; return ESP_OK;
}
esp_err_t esp_vfs_fat_info(const char *path, uint64_t *total, uint64_t *free_space) {
    (void)path; *total = 100; *free_space = 80; return ESP_OK;
}
#define CHECK(expr) do { if (!(expr)) { fprintf(stderr, "%s:%d: %s\n", __FILE__, __LINE__, #expr); return 1; } } while (0)
static const uint8_t session[16] = {1};

static int setup(void) { CHECK(raw_storage_mount() == ESP_OK); CHECK(raw_storage_open(session) == ESP_OK); return 0; }
static int test_segments(void) {
    CHECK(setup() == 0);
    char first[2048]; snprintf(first, sizeof first, "%s", host_path(raw_storage_path()));
    CHECK(strstr(first, "-00000000.bin"));
    CHECK(raw_storage_write("original", 8) == ESP_OK);
    CHECK(raw_storage_unmount() == ESP_ERR_INVALID_STATE); CHECK(unmounts == 0);
    CHECK(raw_storage_finish() == ESP_OK);
    CHECK(raw_storage_open(session) == ESP_OK);
    CHECK(strstr(raw_storage_path(), "-00000001.bin"));
    CHECK(raw_storage_write("second", 6) == ESP_OK); CHECK(raw_storage_finish() == ESP_OK);
    FILE *file = fopen(first, "rb"); CHECK(file != NULL);
    char content[9] = {0}; CHECK(fread(content, 1, 8, file) == 8); CHECK(fclose(file) == 0);
    CHECK(strcmp(content, "original") == 0);
    CHECK(raw_storage_unmount() == ESP_OK); CHECK(unmounts == 1);
    return 0;
}
static int test_fault(const char *name) {
    CHECK(setup() == 0);
    fault_errno = (!strcmp(name, "full") || !strcmp(name, "flush_full")) ? ENOSPC : EIO;
    char failed_path[2048]; snprintf(failed_path, sizeof failed_path, "%s", host_path(raw_storage_path()));
    esp_err_t expected = fault_errno == ENOSPC ? RAW_STORAGE_ERR_FULL : ESP_FAIL;
    if (!strcmp(name, "write") || !strcmp(name, "full")) {
        fail_write = 1;
        CHECK(raw_storage_write("abc", 3) == expected);
        CHECK(writes == 1);
        CHECK(raw_storage_write("more", 4) == expected); CHECK(writes == 1);
        CHECK(raw_storage_sync() == expected); CHECK(flushes == 0 && syncs == 0);
        CHECK(raw_storage_finish() == expected); CHECK(closes == 1);
    } else if (!strcmp(name, "flush") || !strcmp(name, "flush_full")) {
        CHECK(raw_storage_write("abc", 3) == ESP_OK);
        fail_flush = 1; CHECK(raw_storage_sync() == expected); CHECK(syncs == 0);
        CHECK(raw_storage_sync() == expected); CHECK(flushes == 1);
        CHECK(raw_storage_finish() == expected); CHECK(closes == 1);
    } else if (!strcmp(name, "sync")) {
        CHECK(raw_storage_write("abc", 3) == ESP_OK);
        fail_sync = 1; CHECK(raw_storage_sync() == expected);
        CHECK(raw_storage_sync() == expected); CHECK(syncs == 1);
        CHECK(raw_storage_finish() == expected); CHECK(closes == 1);
    } else if (!strcmp(name, "close")) {
        CHECK(raw_storage_write("abc", 3) == ESP_OK);
        fail_close = 1; CHECK(raw_storage_finish() == expected); CHECK(closes == 1);
    } else return 2;
    CHECK(raw_storage_finish() == expected);
    if (!strcmp(name, "write") || !strcmp(name, "full")) {
        FILE *partial = fopen(failed_path, "rb"); CHECK(partial != NULL);
        char bytes[8] = {0}; CHECK(fread(bytes, 1, sizeof bytes, partial) == 2);
        CHECK(memcmp(bytes, "ab", 2) == 0); CHECK(fclose(partial) == 0);
    }
    /* A new, exclusive segment resets the error and leaves the old file alone. */
    CHECK(raw_storage_open(session) == ESP_OK);
    CHECK(strstr(raw_storage_path(), "-00000001.bin"));
    CHECK(raw_storage_write("ok", 2) == ESP_OK);
    CHECK(raw_storage_finish() == ESP_OK);
    CHECK(raw_storage_unmount() == ESP_OK);
    return 0;
}
int main(int argc, char **argv) {
    if (argc != 3) return 2;
    root = argv[1];
    if (!strcmp(argv[2], "segments")) return test_segments();
    return test_fault(argv[2]);
}
