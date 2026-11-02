#pragma once
#include "cp_settings.h"
#include <stddef.h>

#define CP_V3_STARTUP_MAX_BYTES 1280u
#define CP_V3_STARTUP_TIME_KEY_ID_SIZE 33u
#define CP_V3_STARTUP_TIME_SPKI_CAPACITY 128u
#define CP_V3_STARTUP_TIME_SPKI_BYTES 91u
#define CP_V3_STARTUP_NVS_FREE_ENTRY_FLOOR 128u
/* Conservative logical metadata charge for both commits, not physical wear. */
#define CP_V3_STARTUP_LOGICAL_WRITE_BYTES 8192u
#define CP_V3_STARTUP_RECONFIGURE_LOGICAL_WRITE_BYTES 16384u

typedef struct {
    cp_settings_t settings;
    char time_key_id[CP_V3_STARTUP_TIME_KEY_ID_SIZE];
    uint8_t time_public_spki[CP_V3_STARTUP_TIME_SPKI_CAPACITY];
    uint16_t time_public_spki_len;
    bool auto_start;
} cp_v3_startup_profile_t;

/* Portable structural/production-profile validation. expected_node may be NULL
 * for encode/save; callers restoring identity must pass the hardware node ID.
 * PEAP cannot auto-start without an independently trusted pre-network clock;
 * auto_start=true rejects it. Explicit USB may retain a false PEAP profile.
 * Cryptographic public-point validation is additionally required by NVS load/save.
 * Neither settings migration nor a legacy profile is consulted. */
bool cp_v3_startup_validate(const cp_v3_startup_profile_t *, const char *expected_node);
bool cp_v3_startup_encode(const cp_v3_startup_profile_t *, void *, size_t, size_t *);
bool cp_v3_startup_decode(const void *, size_t, const char *expected_node, cp_v3_startup_profile_t *);
void cp_v3_startup_clear(cp_v3_startup_profile_t *);

/* No erasure, recovery, migration or implicit write. Ordinary application NVS;
 * this makes no encryption-at-rest/secure-boot/physical-tamper claim. */
esp_err_t cp_v3_startup_init(void);
/* Errors clear out. ABSENT alone returns NOT_FOUND. A missing/bad selector in a
 * nonempty store, missing selected blob, invalid key or identity is an error.
 * Inactive blobs are never promoted. Caller serializes all accesses. */
esp_err_t cp_v3_startup_load(const char *expected_node, cp_v3_startup_profile_t *out);
/* Only after this production candidate's real network, authenticated cloud and
 * configuration ACK succeeded, and after charging LOGICAL_WRITE_BYTES to the
 * owning storage budget. This is an explicit caller decision, not validation.
 * Write/readback inactive blob, then commit/readback selector. An uncertain
 * selector commit can leave old OR verified new active; fail closed this boot,
 * never roll back, and restore only the selected complete blob next boot.
 * No UTC seed, boot/batch identity, capture or test window limit is persisted. */
esp_err_t cp_v3_startup_save(const cp_v3_startup_profile_t *);
/* Explicit trusted-USB recovery only, after the same real network/cloud ACK
 * admission and charging RECONFIGURE_LOGICAL_WRITE_BYTES. Autonomous boot must
 * never call this. Healthy selected profiles use ordinary save. A corrupt or
 * orphaned dedicated store is replaced only with this freshly approved input,
 * never an unselected old blob. No namespace is erased. At most the candidate
 * or selector key is individually removed if its stored NVS type is wrong.
 * All save uncertainty/fail-closed rules still apply. */
esp_err_t cp_v3_startup_reconfigure(const cp_v3_startup_profile_t *);
