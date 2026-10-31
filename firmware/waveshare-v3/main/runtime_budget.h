#pragma once
#include "cp_v3_budget.h"
/* Caller already owns the storage mutex; no locking or inverse callback here. */
typedef struct {
    cp_v3_budget_store_t provider;
    bool (*charge_storage)(void *,uint64_t);
    void *charge_context;
} edge_budget_bridge_t;
static inline cp_v3_budget_load_t edge_budget_load(void *context,void *out,size_t cap,size_t *length) {
    edge_budget_bridge_t *b=context;return b->provider.load(b->provider.context,out,cap,length);
}
static inline bool edge_budget_store(void *context,const void *record,size_t length) {
    edge_budget_bridge_t *b=context;
    return b->charge_storage(b->charge_context,b->provider.logical_write_bytes)&&b->provider.store(b->provider.context,record,length);
}
static inline cp_v3_budget_store_t edge_budget_provider(edge_budget_bridge_t *bridge) {
    return (cp_v3_budget_store_t){bridge,edge_budget_load,edge_budget_store,bridge->provider.logical_write_bytes};
}
