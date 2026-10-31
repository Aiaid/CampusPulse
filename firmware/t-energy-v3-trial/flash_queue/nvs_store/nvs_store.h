#pragma once
#include "cp_v3_queue.h"
/* Adapter deliberately limits the shared NVS footprint. Not a reserved quota. */
#define TE_NVS_RECORD_MAX 2048u
#define TE_NVS_MAX_LIVE 3u
#define TE_NVS_FREE_ENTRY_FLOOR 128u
typedef struct { uint16_t uncertain; uint8_t compare[TE_NVS_RECORD_MAX]; cp_v3_sha256_fn hash; void *hash_context; } te_nvs_store_t;
/* NVS must already be initialized by the owner. Never formats, initializes,
 * creates namespace or writes; owner must serialize queue and other NVS writes. */
bool te_nvs_store_expire(void *,unsigned,const void *,size_t,const cp_v3_queue_tombstone_t *);
bool te_nvs_store_prepare(te_nvs_store_t *,cp_v3_queue_store_t *);
/* Bind after prepare and before open; required for tombstone transitions. */
bool te_nvs_store_set_hash(te_nvs_store_t *,cp_v3_sha256_fn,void *);
