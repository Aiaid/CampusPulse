#pragma once
#include <stdbool.h>
#include <stddef.h>
#define CP_V3_QUEUE_SLOTS 12u
#define CP_V3_QUEUE_SLOT_BYTES 6144u
typedef struct { void *context; int (*load)(void *,unsigned,void *,size_t,size_t *); bool (*store)(void *,unsigned,const void *,size_t); bool (*reclaim)(void *,unsigned,const void *,size_t); } cp_v3_queue_store_t;
