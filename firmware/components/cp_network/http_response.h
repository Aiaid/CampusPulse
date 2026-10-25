#ifndef CP_HTTP_RESPONSE_H
#define CP_HTTP_RESPONSE_H
#include "cp_network.h"
#include <string.h>
#include "esp_http_client.h"
typedef struct {
    char *body;
    size_t used;
    uint64_t deadline_ms;
    esp_err_t abort_reason;
    bool read_stopped;
} cp_http_response_t;
/* Separate from transport IO so size, cancellation and continuous-response
 * deadline admission are tested directly. Pinned IDF ignores callback return
 * values, so the response adapter also stops local body reads on rejection. */
static inline esp_err_t cp_http_response_check(cp_http_response_t *r,uint64_t now,bool active)
{
    if (r->abort_reason!=ESP_OK) return r->abort_reason;
    if (!active) r->abort_reason=ESP_ERR_INVALID_STATE;
    else if (now>=r->deadline_ms) r->abort_reason=ESP_ERR_TIMEOUT;
    return r->abort_reason;
}
static inline esp_err_t cp_http_response_append(cp_http_response_t *r,const void *bytes,
    size_t length,uint64_t now,bool active)
{
    if (cp_http_response_check(r,now,active)!=ESP_OK) return r->abort_reason;
    if (r->used>CP_NETWORK_BODY_MAX || length>CP_NETWORK_BODY_MAX-r->used) {
        r->abort_reason=ESP_ERR_INVALID_SIZE;
        return r->abort_reason;
    }
    if (length) memcpy(r->body+r->used,bytes,length);
    r->used+=length;r->body[r->used]=0;
    return ESP_OK;
}
/* HEAD is set only after response headers/data arrive: the request is already
 * sent, so this changes local body processing, not the wire request. Pinned IDF
 * get_data() returns zero for HEAD and headers_complete() skips its body.
 * Unlike close() inside parser callbacks, it cannot invalidate the transport
 * while fetch_headers() is still processing its first header/body buffer. */
static inline esp_err_t cp_http_response_event(esp_http_client_event_t *event,
    uint64_t now,bool active)
{
    cp_http_response_t *r=event->user_data;
    if (!r || event->event_id==HTTP_EVENT_DISCONNECTED || event->event_id==HTTP_EVENT_ERROR)
        return ESP_OK;
    if (event->event_id==HTTP_EVENT_ON_CONNECTED)
        esp_http_client_set_timeout_ms(event->client,1000);
    esp_err_t e=event->event_id==HTTP_EVENT_ON_DATA && event->data_len>0 ?
        cp_http_response_append(r,event->data,(size_t)event->data_len,now,active) :
        cp_http_response_check(r,now,active);
    if (e!=ESP_OK && !r->read_stopped &&
        (event->event_id==HTTP_EVENT_ON_HEADER || event->event_id==HTTP_EVENT_ON_DATA)) {
        if (esp_http_client_set_method(event->client,HTTP_METHOD_HEAD)==ESP_OK)
            r->read_stopped=true;
    }
    return e;
}
#endif
