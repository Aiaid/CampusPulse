#ifndef CP_PROTOCOL_INTERNAL_H
#define CP_PROTOCOL_INTERNAL_H
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include "cp_network.h"
bool cp_network_batch_valid(const cp_network_batch_t *batch);
bool cp_network_identity_valid(const char *node, const char *boot);
bool cp_network_control_ack_matches(const char *json, size_t length,
    const char *node, const char *boot, uint64_t sequence,
    const char *config_id, const char *state, const char *reason);
bool cp_network_candidate_id(const char *json,size_t length,const char *node,char out[65]);
bool cp_network_parse_server_time(const char *json,size_t length,uint64_t *utc_ms);
#endif
