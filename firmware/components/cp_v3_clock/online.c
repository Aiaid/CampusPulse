#include "cp_v3_clock_online.h"
#include "cp_settings.h"
#include "sdkconfig.h"
#include "esp_crt_bundle.h"
#include "esp_http_client.h"
#include "esp_log.h"
#include "esp_random.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "mbedtls/ecdsa.h"
#include "mbedtls/pk.h"
#include "mbedtls/sha256.h"
#include <stdio.h>
#include <string.h>
#include <strings.h>

#if !CONFIG_MBEDTLS_HAVE_TIME || !CONFIG_MBEDTLS_HAVE_TIME_DATE || !CONFIG_MBEDTLS_CERTIFICATE_BUNDLE
#error "online signed clock requires full certificate chain, hostname and date checks"
#endif

typedef struct {
    uint64_t began, deadline, sent;
    bool (*cancelled)(void);
    bool bad, finished, headers_sent;
    size_t bytes;
    char body[CP_V3_CLOCK_RESPONSE_MAX + 1];
} online_probe_t;

static uint64_t mono(void) { return (uint64_t)esp_timer_get_time() / 1000u; }
static void wipe(void *p, size_t n) { volatile uint8_t *b=p; while(n--) *b++=0; }
static bool cancelled(const online_probe_t *p) { return p->cancelled && p->cancelled(); }
static bool within(const online_probe_t *p, uint64_t now) {
    return now >= p->began && now <= p->deadline;
}
static bool key_valid(const char *key) {
    if (!key) return false;
    size_t n=0;
    for (; n<33 && key[n]; ++n) {
        char c=key[n];
        if (!((c>='a'&&c<='z')||(c>='A'&&c<='Z')||(c>='0'&&c<='9')||c=='_'||c=='-')) return false;
    }
    return n>0 && n<=32;
}
static esp_err_t event(esp_http_client_event_t *e) {
    online_probe_t *p=e->user_data;
    if (!p) return ESP_FAIL;
    uint64_t now=mono();
    if (cancelled(p) || !within(p,now)) p->bad=true;
    if (e->event_id==HTTP_EVENT_HEADERS_SENT) {
        /* SDK dispatches immediately before the nonce body write. Refuse any
         * retransmission instead of accepting a repeated challenge exchange. */
        if (p->headers_sent) p->bad=true;
        else { p->headers_sent=true; p->sent=now; }
    } else if (e->event_id==HTTP_EVENT_ON_HEADER) {
        if (e->header_key && !strcasecmp(e->header_key,"Content-Encoding") &&
            (!e->header_value || strcasecmp(e->header_value,"identity"))) p->bad=true;
    } else if (e->event_id==HTTP_EVENT_ON_DATA) {
        if (!p->headers_sent || e->data_len<0 ||
            (size_t)e->data_len>CP_V3_CLOCK_RESPONSE_MAX-p->bytes ||
            (e->data_len && !e->data)) p->bad=true;
        else if (!p->bad) {
            if (e->data_len) memcpy(p->body+p->bytes,e->data,(size_t)e->data_len);
            p->bytes+=(size_t)e->data_len;
        }
    } else if (e->event_id==HTTP_EVENT_ON_FINISH) p->finished=true;
    else if (e->event_id==HTTP_EVENT_REDIRECT) p->bad=true;
    return p->bad ? ESP_FAIL : ESP_OK;
}
static bool signature_verify(void *ctx, const uint8_t spki[91],
    const uint8_t sig[64], const void *data, size_t bytes) {
    (void)ctx;
    mbedtls_pk_context key; mbedtls_pk_init(&key);
    mbedtls_mpi r,s; mbedtls_mpi_init(&r); mbedtls_mpi_init(&s);
    uint8_t digest[32];
    bool okay=mbedtls_pk_parse_public_key(&key,spki,91)==0 &&
        mbedtls_pk_can_do(&key,MBEDTLS_PK_ECDSA) && mbedtls_sha256(data,bytes,digest,0)==0;
    if (okay) {
        mbedtls_ecp_keypair *ec=mbedtls_pk_ec(key);
        okay=ec->MBEDTLS_PRIVATE(grp).id==MBEDTLS_ECP_DP_SECP256R1 &&
            mbedtls_ecp_check_pubkey(&ec->MBEDTLS_PRIVATE(grp),&ec->MBEDTLS_PRIVATE(Q))==0 &&
            mbedtls_mpi_read_binary(&r,sig,32)==0 && mbedtls_mpi_read_binary(&s,sig+32,32)==0 &&
            mbedtls_ecdsa_verify(&ec->MBEDTLS_PRIVATE(grp),digest,sizeof digest,&ec->MBEDTLS_PRIVATE(Q),&r,&s)==0;
    }
    mbedtls_mpi_free(&r); mbedtls_mpi_free(&s); mbedtls_pk_free(&key);
    wipe(digest,sizeof digest); return okay;
}
esp_err_t cp_v3_clock_probe_online(const uint8_t spki[91], const char *key_id,
    uint32_t epoch, bool (*cancel_fn)(void), cp_v3_time_t *out) {
    if (!out) return ESP_ERR_INVALID_ARG;
    memset(out,0,sizeof *out);
    if (!spki || !key_valid(key_id) || !epoch) return ESP_ERR_INVALID_ARG;
    online_probe_t p={.began=mono(),.cancelled=cancel_fn};
    if (cancelled(&p)) return ESP_ERR_INVALID_STATE;
    if (p.began>UINT64_MAX-CP_V3_CLOCK_RTT_MAX_MS) return ESP_ERR_INVALID_STATE;
    p.deadline=p.began+CP_V3_CLOCK_RTT_MAX_MS;
    uint8_t random[32]; char nonce[65], request[80];
    esp_fill_random(random,sizeof random);
    static const char hex[]="0123456789abcdef";
    for (size_t i=0;i<sizeof random;i++) { nonce[i*2]=hex[random[i]>>4]; nonce[i*2+1]=hex[random[i]&15]; }
    nonce[64]=0; wipe(random,sizeof random);
    int length=snprintf(request,sizeof request,"{\"nonce\":\"%s\"}",nonce);
    esp_log_level_set("HTTP_CLIENT",ESP_LOG_NONE);
    esp_log_level_set("esp-tls",ESP_LOG_NONE);
    esp_log_level_set("esp-tls-mbedtls",ESP_LOG_NONE);
    esp_log_level_set("mbedtls",ESP_LOG_NONE);
    esp_http_client_config_t config={
        .url=CP_API_ORIGIN "/api/v3/clock",.method=HTTP_METHOD_POST,
        .timeout_ms=1000,.is_async=true,.disable_auto_redirect=true,
        .auth_type=HTTP_AUTH_TYPE_NONE,.max_authorization_retries=-1,
        .transport_type=HTTP_TRANSPORT_OVER_SSL,
        .event_handler=event,.user_data=&p,.crt_bundle_attach=esp_crt_bundle_attach,
        .skip_cert_common_name_check=false,.buffer_size=1024,.buffer_size_tx=512,
    };
    esp_http_client_handle_t http=esp_http_client_init(&config);
    esp_err_t result=ESP_ERR_NO_MEM;
    if (http) {
        result=esp_http_client_set_header(http,"Content-Type","application/json");
        if (result==ESP_OK) result=esp_http_client_set_header(http,"Accept","application/json");
        if (result==ESP_OK) result=esp_http_client_set_header(http,"Cache-Control","no-store");
        if (result==ESP_OK) result=esp_http_client_set_post_field(http,request,length);
        while (result==ESP_OK || result==ESP_ERR_HTTP_EAGAIN) {
            if (cancelled(&p)) { result=ESP_ERR_INVALID_STATE; break; }
            if (!within(&p,mono())) { result=ESP_ERR_TIMEOUT; break; }
            result=esp_http_client_perform(http);
            if (result!=ESP_ERR_HTTP_EAGAIN || p.bad) break;
            vTaskDelay(pdMS_TO_TICKS(10) ? pdMS_TO_TICKS(10) : 1);
        }
        uint64_t ended=mono();
        if (cancelled(&p)) result=ESP_ERR_INVALID_STATE;
        else if (!within(&p,ended)) result=ESP_ERR_TIMEOUT;
        else if (result==ESP_OK && (p.bad || !p.finished || !p.headers_sent ||
            esp_http_client_get_status_code(http)!=200 || !esp_http_client_is_complete_data_received(http) ||
            !cp_v3_clock_verify(p.body,p.bytes,spki,key_id,nonce,p.sent,ended,epoch,signature_verify,NULL,out)))
            result=ESP_ERR_INVALID_RESPONSE;
        /* IDF 5.5.3 cleanup always closes/frees a valid handle synchronously.
         * No callback can retain the stack response buffer after this call. */
        esp_err_t cleanup=esp_http_client_cleanup(http);
        if (cleanup!=ESP_OK) result=cleanup;
        if (cancelled(&p)) result=ESP_ERR_INVALID_STATE;
    }
    if (result!=ESP_OK) memset(out,0,sizeof *out);
    wipe(nonce,sizeof nonce); wipe(request,sizeof request); wipe(&p,sizeof p);
    return result;
}
