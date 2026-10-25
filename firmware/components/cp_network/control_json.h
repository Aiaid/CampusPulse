#ifndef CP_CONTROL_JSON_H
#define CP_CONTROL_JSON_H
#include "cp_network.h"
#include "cJSON.h"
#include <string.h>

/* Build only complete strict-schema requests. Any allocator failure discards
 * the partial tree, leaving the caller's prior frozen attempt untouched. */
static inline char *cp_control_contact_json(const char *boot, uint64_t sequence,
    uint64_t uptime, const char *capture, const char *applied)
{
    cJSON *o=cJSON_CreateObject();
    if (!o) return NULL;
    bool complete=cJSON_AddStringToObject(o,"protocol",CP_PROTOCOL) &&
        cJSON_AddStringToObject(o,"boot_id",boot) &&
        cJSON_AddNumberToObject(o,"contact_seq",(double)sequence) &&
        cJSON_AddStringToObject(o,"firmware_version",CP_NETWORK_FIRMWARE) &&
        cJSON_AddNumberToObject(o,"uptime_ms",(double)uptime) &&
        cJSON_AddStringToObject(o,"wifi_state","connected") &&
        cJSON_AddStringToObject(o,"capture_state",capture) &&
        (applied && applied[0] ? cJSON_AddStringToObject(o,"applied_config_id",applied) :
                               cJSON_AddNullToObject(o,"applied_config_id"));
    char *body=complete?cJSON_PrintUnformatted(o):NULL;
    cJSON_Delete(o);
    return body;
}
static inline char *cp_control_activation_json(const char *boot, const char *config,
    uint64_t sequence, bool applied, const char *reason)
{
    cJSON *o=cJSON_CreateObject();
    if (!o) return NULL;
    bool complete=cJSON_AddStringToObject(o,"capture_config_id",config) &&
        cJSON_AddStringToObject(o,"boot_id",boot) &&
        cJSON_AddNumberToObject(o,"apply_seq",(double)sequence) &&
        cJSON_AddStringToObject(o,"state",applied?"applied":"failed");
    if (complete && reason && reason[0]) complete=cJSON_AddStringToObject(o,"message",reason)!=NULL;
    char *body=complete?cJSON_PrintUnformatted(o):NULL;
    cJSON_Delete(o);
    return body;
}
typedef struct {
    char config_id[65], reason[65];
    bool applied, queued;
} cp_control_activation_intent_t;
static inline bool cp_control_stage_activation(cp_control_activation_intent_t *intent,
    const char *config, bool applied, const char *reason)
{
    if (!intent || !config || strlen(config)>64 || (reason && strlen(reason)>64)) return false;
    strcpy(intent->config_id,config);
    strcpy(intent->reason,reason?reason:"");
    intent->applied=applied;intent->queued=true;
    return true;
}
static inline bool cp_control_prepare_activation(cp_control_activation_intent_t *intent,
    const char *boot, uint64_t *sequence, char **pending, uint64_t *pending_sequence)
{
    if (!intent->queued) return true;
    if (*sequence>=UINT32_MAX) return false;
    char *candidate=cp_control_activation_json(boot,intent->config_id,*sequence+1,
                                              intent->applied,intent->reason);
    if (!candidate) return false;
    cJSON_free(*pending);*pending=candidate;
    *pending_sequence=++*sequence;
    intent->queued=false;
    return true;
}
#endif
