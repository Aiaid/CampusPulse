#pragma once
#include "cp_network.h"
typedef void (*cp_ack_release_fn)(void *context);
/* The only general-parser entry used by the transport: release happens before
 * any allocation or arbitrary JSON-number conversion. No callback is required
 * for a canonical match; noncanonical replies fail closed without one. */
static inline bool cp_network_parse_ack_transport(const char *json,size_t length,
    const cp_network_batch_t *expected,cp_network_ack_t *ack,
    cp_ack_release_fn release,void *context,cp_ack_canonical_result_t *kind)
{
    cp_ack_canonical_result_t parsed=cp_network_parse_ack_canonical(json,length,expected,ack);
    if(kind)*kind=parsed;
    if(parsed==CP_ACK_CANONICAL_MATCH)return true;
    if(release)release(context);
    return parsed==CP_ACK_NEEDS_GENERAL&&release&&cp_network_parse_ack(json,length,expected,ack);
}
