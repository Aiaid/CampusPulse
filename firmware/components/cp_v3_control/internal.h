#pragma once
#include "cp_v3_control.h"
#define V3_NONE UINT16_MAX
#define V3_SAFE UINT64_C(9007199254740991)
#define V3_BYTES_MAX UINT64_C(1099511627776)
enum { V3_OBJECT, V3_ARRAY, V3_STRING, V3_NUMBER, V3_TRUE, V3_FALSE, V3_NULL };
bool v3_parse(cp_v3_control_workspace_t *, const void *, size_t);
int v3_field(cp_v3_control_workspace_t *, int, const char *);
bool v3_fields(cp_v3_control_workspace_t *, int, const char *);
bool v3_equal(cp_v3_control_workspace_t *, int, const char *);
bool v3_string(cp_v3_control_workspace_t *, int, char *, size_t);
bool v3_uint(cp_v3_control_workspace_t *, int, uint64_t, uint64_t, uint64_t *);
bool v3_is(cp_v3_control_workspace_t *, int, unsigned);
bool v3_array_exact(cp_v3_control_workspace_t *, int, const char *);
bool v3_id(const char *);
bool v3_uuid(const char *);
bool v3_hash_string(const char *);
bool v3_date(const char *, uint64_t *);
bool v3_canonical(cp_v3_control_workspace_t *, int, char *, size_t, size_t *);
bool v3_digest(cp_v3_control_t *, int, char[65]);
bool v3_small_caps(cp_v3_control_t *);
bool v3_small_policy(cp_v3_control_t *,int,cp_v3_trial_policy_t *);
bool v3_body_hash(cp_v3_sha256_fn,void *,const void *,size_t,char[65]);
bool v3_fields_optional(cp_v3_control_workspace_t *,int,const char *,const char *);
cp_v3_control_result_t v3_small_ack_receipt(cp_v3_control_t *,const void *,size_t,cp_v3_time_t);
/* Strict UTC deadline mapped to monotonic time with the transport/board's
 * conservative 500ppm future uncertainty growth. Never extends authority. */
uint64_t v3_deadline_mono(cp_v3_time_t, uint64_t utc_deadline);
