#pragma once
#include "cp_settings.h"
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

bool cp_provision_uuid_v4(const char *value);
/* Derive only the USB session nonce; no wireless PIN/password/SRP material. */
bool cp_provision_session_nonce(const char *proof,const uint8_t *context,size_t length,char nonce[33]);
/* Hash explicit length-prefixed fields, never C struct padding. */
bool cp_provision_settings_digest(const cp_settings_t *settings, uint8_t out[32]);
bool cp_provision_digest_equal(const uint8_t a[32], const uint8_t b[32]);

/* Bind credential mode and the selected RAM-settings generation as well as all
 * resolved candidate fields; no magic placeholder or device credential export. */
bool cp_provision_candidate_digest(const cp_settings_t *settings,bool reuse_saved,
    uint32_t generation,uint8_t out[32]);
