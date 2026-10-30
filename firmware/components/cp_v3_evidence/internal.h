#pragma once
#include "cp_v3_evidence.h"
typedef struct { char *out; size_t cap, used; bool ok; } cp_v3_writer_t;
void cp_v3_write(cp_v3_writer_t *, const char *, ...);
void cp_v3_hex(const uint8_t *, size_t, char *);
bool cp_v3_scope_valid(const cp_v3_scope_t *);
bool cp_v3_time_valid(cp_v3_time_t);
bool cp_v3_uuid(const char *);
void cp_v3_evidence_json(cp_v3_writer_t *, const cp_v3_window_t *, unsigned);
