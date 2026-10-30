#pragma once
/* Public lifecycle only. Independent of credentials, storage, UI and v3 mode. */
typedef enum {
    RAW_SETUP_IDLE, RAW_SETUP_ENTERING, RAW_SETUP_READY, RAW_SETUP_AWAIT_REPLY,
    RAW_SETUP_TESTING, RAW_SETUP_SAVING, RAW_SETUP_SAVED, RAW_SETUP_FAILED,
    RAW_SETUP_FAULT, RAW_SETUP_CANCELLING
} raw_setup_state_t;
