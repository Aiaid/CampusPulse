/* Isolated synthetic LAN HTTPS diagnostic. No production protocol or capture. */
#include <errno.h>
#include <inttypes.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/time.h>
#include "freertos/FreeRTOS.h"
#include "freertos/event_groups.h"
#include "freertos/task.h"
#include "cJSON.h"
#include "cp_settings.h"
#include "esp_eap_client.h"
#include "esp_event.h"
#include "esp_heap_caps.h"
#include "esp_http_client.h"
#include "esp_log.h"
#include "esp_netif.h"
#include "esp_partition.h"
#include "esp_timer.h"
#include "esp_system.h"
#include "esp_wifi.h"
#include "lwip/inet.h"
#include "lwip/sockets.h"
#include "mbedtls/sha256.h"
#include "mbedtls/x509.h"
#include "nvs_flash.h"
#include "lan_config.h"
#include "ble_load.h"

#define SAMPLES CP_LAN_SAMPLES
#define DEADLINE_US 12000000LL
#define RESPONSE_CAP 512
#define CONNECTED_IO_MS 1000
#define RETRY_DELAY_MS 20
#define HTTP_BUFFER_BYTES 1024
#define HEAP_CAPS (MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT)
static EventGroupHandle_t wifi_events;
static unsigned wifi_attempts;
static char payload[8192];

typedef struct {
    int64_t start, connected, headers, first_data, total;
    unsigned connects, header_events;
    size_t used;
    bool overflow;
    bool connection_open;
    char response[RESPONSE_CAP];
    size_t free_start, free_end, free_min, largest_start, largest_end;
    size_t largest_sampled_min;
    int status, tls_error, tls_flags, result;
    bool valid;
    lan_ble_counts_t ble_start,ble_end;
} request_t;

static bool sampling;
static size_t sampled_largest_min;
static bool sampler_stop;
static void sample_heap(void)
{
    size_t largest = heap_caps_get_largest_free_block(HEAP_CAPS);
    size_t old = __atomic_load_n(&sampled_largest_min, __ATOMIC_RELAXED);
    while (largest < old && !__atomic_compare_exchange_n(&sampled_largest_min,
            &old, largest, false, __ATOMIC_RELAXED, __ATOMIC_RELAXED)) {}
}

static void heap_sampler(void *unused)
{
    (void)unused;
    while (!__atomic_load_n(&sampler_stop, __ATOMIC_ACQUIRE)) {
        if (__atomic_load_n(&sampling, __ATOMIC_ACQUIRE)) sample_heap();
        vTaskDelay(pdMS_TO_TICKS(2));
    }
    vTaskDelete(NULL);
}

static esp_err_t http_event(esp_http_client_event_t *event)
{
    request_t *r = event->user_data;
    int64_t now = esp_timer_get_time() - r->start;
    sample_heap();
    switch (event->event_id) {
    case HTTP_EVENT_ON_CONNECTED:
        ++r->connects;
        r->connection_open=true;
        if (r->connected < 0) r->connected = now;
        esp_http_client_set_timeout_ms(event->client,CONNECTED_IO_MS);
        break;
    case HTTP_EVENT_DISCONNECTED:
        r->connection_open=false;
        break;
    case HTTP_EVENT_HEADERS_SENT:
        ++r->header_events;
        if (r->headers < 0) r->headers = now;
        break;
    case HTTP_EVENT_ON_DATA:
        if (r->first_data < 0) r->first_data = now;
        if (event->data_len < 0 || (size_t)event->data_len > sizeof(r->response)-1-r->used) {
            r->overflow = true;
        } else if (!r->overflow) {
            memcpy(r->response+r->used, event->data, event->data_len);
            r->used += event->data_len;
            r->response[r->used] = 0;
        }
        break;
    default: break;
    }
    return ESP_OK;
}

static esp_http_client_handle_t client_new(request_t *r, const char *ca)
{
    r->connection_open=false;
    const esp_http_client_config_t cfg = {
        .url=CP_LAN_URL, .cert_pem=ca,
        .tls_version=ESP_HTTP_CLIENT_TLS_VER_TLS_1_2,
        .skip_cert_common_name_check=false, .use_global_ca_store=false,
        .crt_bundle_attach=NULL, .auth_type=HTTP_AUTH_TYPE_NONE,
        .disable_auto_redirect=true, .max_authorization_retries=-1,
        .timeout_ms=12000, .is_async=true, .event_handler=http_event, .user_data=r,
        .buffer_size=HTTP_BUFFER_BYTES, .buffer_size_tx=HTTP_BUFFER_BYTES, .keep_alive_enable=true,
        .addr_type=HTTP_ADDR_TYPE_INET,
    };
    return esp_http_client_init(&cfg);
}

static bool validate_response(request_t *r, size_t bytes, const char *hash, bool health)
{
    if (r->result != ESP_OK || r->status != 200 || r->overflow || r->used == 0)
        return false;
    const char *end = NULL;
    cJSON *root = cJSON_ParseWithLengthOpts(r->response, r->used+1, &end, true);
    if (!root || !cJSON_IsObject(root)) { cJSON_Delete(root); return false; }
    const cJSON *ok = cJSON_GetObjectItemCaseSensitive(root,"ok");
    bool valid = cJSON_IsTrue(ok);
    if (health) {
        const cJSON *name = cJSON_GetObjectItemCaseSensitive(root,"benchmark");
        const cJSON *tls = cJSON_GetObjectItemCaseSensitive(root,"tls");
        valid = valid && cJSON_IsString(name) && strcmp(name->valuestring,"lan-https")==0
            && cJSON_IsString(tls) && strcmp(tls->valuestring,"TLSv1.2")==0;
    } else {
        const cJSON *length = cJSON_GetObjectItemCaseSensitive(root,"received");
        const cJSON *digest = cJSON_GetObjectItemCaseSensitive(root,"sha256");
        valid = valid && cJSON_IsNumber(length) && length->valuedouble==(double)bytes
            && cJSON_IsString(digest) && strlen(digest->valuestring)==64
            && strcmp(digest->valuestring,hash)==0;
    }
    cJSON_Delete(root);
    return valid;
}

static bool certificate_rejected(const request_t *r)
{
    /* Pinned ESP-TLS records -mbedtls_ssl_handshake() in its stack error
     * field, so callers normally see the positive 0x2700. Certificate flags
     * are captured separately, only if the SDK still has a peer certificate.
     * Accept either sign of exactly CERT_VERIFY_FAILED, never a generic TLS,
     * connect or timeout error. Strictly require failure before HTTP begins. */
    bool verify_code=r->tls_error==MBEDTLS_ERR_X509_CERT_VERIFY_FAILED
        || r->tls_error==-MBEDTLS_ERR_X509_CERT_VERIFY_FAILED;
    bool untrusted=(r->tls_flags&MBEDTLS_X509_BADCERT_NOT_TRUSTED)!=0;
    return r->result!=ESP_OK && r->header_events==0 && r->connects==0
        && (verify_code || untrusted);
}

static bool validator_selfcheck(void)
{
    static const char digest[]="0000000000000000000000000000000000000000000000000000000000000000";
    request_t r={.status=200,.result=ESP_OK};
    snprintf(r.response,sizeof(r.response),"{\"ok\":true,\"received\":1024,\"sha256\":\"%s\"}",digest);
    r.used=strlen(r.response);
    if (!validate_response(&r,1024,digest,false)) return false;
    if (validate_response(&r,8192,digest,false)) return false;
    r.response[r.used-3]='1';
    if (validate_response(&r,1024,digest,false)) return false;
    r.response[r.used-3]='0';
    r.status=500;
    if (validate_response(&r,1024,digest,false)) return false;
    r.status=200; r.overflow=true;
    if (validate_response(&r,1024,digest,false)) return false;
    memset(&r,0,sizeof(r));
    r.result=ESP_FAIL;
    if (certificate_rejected(&r)) return false;
    r.tls_error=MBEDTLS_ERR_X509_CERT_VERIFY_FAILED;
    if (!certificate_rejected(&r)) return false;
    r.tls_error=-MBEDTLS_ERR_X509_CERT_VERIFY_FAILED;
    if (!certificate_rejected(&r)) return false;
    r.header_events=1;
    if (certificate_rejected(&r)) return false;
    r.header_events=0; r.connects=1;
    if (certificate_rejected(&r)) return false;
    r.connects=0; r.tls_error=0; r.tls_flags=MBEDTLS_X509_BADCERT_NOT_TRUSTED;
    return certificate_rejected(&r);
}

static bool request_run(esp_http_client_handle_t client, request_t *r, size_t bytes,
                        const char *hash, bool health)
{
    /* No previous perform remains in progress. Clear body before switching GET
     * or payload length; esp_http_client retains the caller's body pointer. */
    bool connection_open=r->connection_open;
    memset(r,0,sizeof(*r));
    r->connection_open=connection_open;
    r->connected=r->headers=r->first_data=-1;
    r->largest_sampled_min=SIZE_MAX;
    char url[128];
    snprintf(url,sizeof(url),"%s/%s",CP_LAN_URL,health?"health":"benchmark");
    esp_err_t err = esp_http_client_set_post_field(client,NULL,0);
    /* IDF clears the body before deleting Content-Type; a fresh handle has no
     * such header, so NOT_FOUND here still means body reset succeeded. */
    if (err==ESP_ERR_NOT_FOUND) err=ESP_OK;
    if (err==ESP_OK) err=esp_http_client_set_url(client,url);
    if (err==ESP_OK) err=esp_http_client_set_method(client,health?HTTP_METHOD_GET:HTTP_METHOD_POST);
    if (err==ESP_OK && !health) err=esp_http_client_set_header(client,"Content-Type","application/octet-stream");
    if (err==ESP_OK && !health) err=esp_http_client_set_post_field(client,payload,(int)bytes);
    r->free_start=heap_caps_get_free_size(HEAP_CAPS);
    r->largest_start=heap_caps_get_largest_free_block(HEAP_CAPS);
    bool monitoring=heap_caps_monitor_local_minimum_free_size_start()==ESP_OK;
    r->start=esp_timer_get_time();
    lan_ble_snapshot(&r->ble_start);
    __atomic_store_n(&sampled_largest_min,SIZE_MAX,__ATOMIC_RELEASE);
    __atomic_store_n(&sampling,true,__ATOMIC_RELEASE);
    sample_heap();
    if (err==ESP_OK) {
        do {
            int64_t remaining=DEADLINE_US-(esp_timer_get_time()-r->start);
            if (remaining<=0) { err=ESP_ERR_TIMEOUT; break; }
            /* Keep the production 12s connect / 1s connected I/O baseline.
             * Preserve connection state across reuse: no new connected event
             * occurs for a healthy handle's second request. */
            int slice_ms=r->connection_open?CONNECTED_IO_MS:12000;
            int remaining_ms=(int)(remaining/1000);
            if (remaining_ms<1) remaining_ms=1;
            if (slice_ms>remaining_ms) slice_ms=remaining_ms;
            esp_http_client_set_timeout_ms(client,slice_ms);
            errno=0;
            err=esp_http_client_perform(client);
            sample_heap();
            if (err==ESP_ERR_HTTP_EAGAIN) vTaskDelay(pdMS_TO_TICKS(RETRY_DELAY_MS));
        } while (err==ESP_ERR_HTTP_EAGAIN);
    }
    r->total=esp_timer_get_time()-r->start;
    lan_ble_snapshot(&r->ble_end);
    __atomic_store_n(&sampling,false,__ATOMIC_RELEASE);
    r->largest_sampled_min=__atomic_load_n(&sampled_largest_min,__ATOMIC_RELAXED);
    r->free_min=monitoring?heap_caps_get_minimum_free_size(HEAP_CAPS):0;
    if (monitoring) heap_caps_monitor_local_minimum_free_size_stop();
    r->free_end=heap_caps_get_free_size(HEAP_CAPS);
    r->largest_end=heap_caps_get_largest_free_block(HEAP_CAPS);
    r->result=err;
    r->status=esp_http_client_get_status_code(client);
    esp_http_client_get_and_clear_last_tls_error(client,&r->tls_error,&r->tls_flags);
    r->valid=validate_response(r,bytes,hash,health)
        && esp_http_client_is_complete_data_received(client) && r->total<=DEADLINE_US;
    if (!r->valid) esp_http_client_close(client);
    return r->valid;
}

static void print_request(const char *mode, unsigned sample, size_t bytes, const request_t *r)
{
    printf("LAN_REQ mode=%s sample=%u bytes=%u ok=%u err=%d status=%d connects=%u "
           "connect_us=%"PRId64" headers_us=%"PRId64" first_body_us=%"PRId64" total_us=%"PRId64
           " response_bytes=%u overflow=%u tls_error=%d tls_flags=%d "
           "free_start=%u free_min=%u free_end=%u largest_start=%u largest_sampled_min=%u largest_end=%u\n",
           mode,sample,(unsigned)bytes,r->valid,r->result,r->status,r->connects,
           r->connected,r->headers,r->first_data,r->total,(unsigned)r->used,r->overflow,
           r->tls_error,r->tls_flags,(unsigned)r->free_start,(unsigned)r->free_min,
           (unsigned)r->free_end,(unsigned)r->largest_start,
           (unsigned)r->largest_sampled_min,
           (unsigned)r->largest_end);
    lan_ble_print_between("request",mode,sample,&r->ble_start,&r->ble_end);
}

static int compare_i64(const void *a,const void *b)
{
    int64_t x=*(const int64_t *)a,y=*(const int64_t *)b;
    return (x>y)-(x<y);
}

static void benchmark(bool reuse, size_t bytes, const char *hash, request_t *r)
{
    esp_http_client_handle_t client=NULL;
    int64_t totals[SAMPLES], connects[SAMPLES];
    unsigned success=0,connect_samples=0,connection_events=0,zero_connect_success=0;
    lan_ble_counts_t phase_start;
    lan_ble_snapshot(&phase_start);
    int64_t previous_start=0;
    for (unsigned i=0;i<SAMPLES;++i) {
        if (!client) {
            client=client_new(r,lan_ca_pem);
            if (!client) { printf("LAN_ALLOC mode=%s sample=%u ok=0\n",reuse?"reuse":"new",i); continue; }
            if (reuse) {
                bool healthy=request_run(client,r,0,NULL,true);
                print_request("reuse_health",i,0,r);
                if (!healthy) { esp_http_client_cleanup(client); client=NULL; continue; }
            }
        }
        /* Relative to the previous actual POST start: no catch-up bursts after
         * a slow request. BLE continues throughout each idle reuse interval. */
        if (CP_LAN_PERIOD_MS && previous_start) {
            int64_t remaining=previous_start+(int64_t)CP_LAN_PERIOD_MS*1000-esp_timer_get_time();
            if (remaining>0) vTaskDelay(pdMS_TO_TICKS((remaining+999)/1000));
        }
        previous_start=esp_timer_get_time();
        bool valid=request_run(client,r,bytes,hash,false);
        print_request(reuse?"reuse":"new",i,bytes,r);
        connection_events+=r->connects;
        if (valid) {
            totals[success++]=r->total;
            if (r->connects==0) ++zero_connect_success;
            if (r->connected>=0) connects[connect_samples++]=r->connected;
        }
        if (!reuse || !valid) { esp_http_client_cleanup(client); client=NULL; }
        if (!CP_LAN_PERIOD_MS) vTaskDelay(pdMS_TO_TICKS(30));
    }
    if (client) {
        /* Verify complete healthy state before ending this payload group. */
        request_run(client,r,0,NULL,true);
        print_request("reuse_health_end",0,0,r);
        esp_http_client_cleanup(client);
    }
    lan_ble_counts_t phase_end;
    lan_ble_snapshot(&phase_end);
    qsort(totals,success,sizeof(totals[0]),compare_i64);
    qsort(connects,connect_samples,sizeof(connects[0]),compare_i64);
    printf("LAN_SUMMARY mode=%s bytes=%u samples=%u success=%u failed=%u connects=%u "
           "zero_connect_success=%u total_p50_us=%"PRId64" total_p95_us=%"PRId64
           " connect_samples=%u connect_p50_us=%"PRId64"\n",
           reuse?"reuse":"new",(unsigned)bytes,SAMPLES,success,SAMPLES-success,
           connection_events,zero_connect_success,success?totals[(success-1)/2]:-1,
           success?totals[(95*success+99)/100-1]:-1,connect_samples,
           connect_samples?connects[(connect_samples-1)/2]:-1);
    lan_ble_print_between("phase",reuse?"reuse":"new",(unsigned)bytes,&phase_start,&phase_end);
}

static void wifi_event(void *arg, esp_event_base_t base, int32_t id, void *data)
{
    (void)arg; (void)data;
    if (base==IP_EVENT && id==IP_EVENT_STA_GOT_IP) xEventGroupSetBits(wifi_events,1);
    if (base==WIFI_EVENT && id==WIFI_EVENT_STA_DISCONNECTED) {
        xEventGroupClearBits(wifi_events,1);
        if (++wifi_attempts<8) esp_wifi_connect();
        else xEventGroupSetBits(wifi_events,2);
    }
}

static esp_err_t wifi_start_saved(void)
{
    cp_settings_t settings;
    /* A READONLY handle alone is insufficient: ordinary NVS initialization may
     * recover pages first. NVSPartition keeps this descriptor pointer, so its
     * lifetime must cover the app. Pinned IDF partition write/write_raw/erase
     * reject readonly descriptors before issuing any flash operation. Any init
     * or settings-load failure aborts; never retry the store writable. */
    static esp_partition_t readonly_nvs;
    const esp_partition_t *partition=esp_partition_find_first(
        ESP_PARTITION_TYPE_DATA,ESP_PARTITION_SUBTYPE_DATA_NVS,"nvs");
    esp_err_t err=ESP_ERR_NOT_FOUND;
    if (partition) {
        readonly_nvs=*partition;
        readonly_nvs.readonly=true;
        err=nvs_flash_init_partition_ptr(&readonly_nvs);
    }
    if (err==ESP_OK) err=cp_settings_load(&settings);
    else memset(&settings,0,sizeof(settings));
    if (err!=ESP_OK) { cp_settings_clear_sensitive(&settings); return err; }
    wifi_events=xEventGroupCreate();
    if (!wifi_events) { cp_settings_clear_sensitive(&settings); return ESP_ERR_NO_MEM; }
    err=esp_netif_init();
    if (err==ESP_OK) err=esp_event_loop_create_default();
    if (err==ESP_OK && !esp_netif_create_default_wifi_sta()) err=ESP_ERR_NO_MEM;
    wifi_init_config_t init=WIFI_INIT_CONFIG_DEFAULT();
    init.nvs_enable=0;
    if (err==ESP_OK) err=esp_wifi_init(&init);
    if (err==ESP_OK) err=esp_wifi_set_storage(WIFI_STORAGE_RAM);
    if (err==ESP_OK) err=esp_event_handler_register(WIFI_EVENT,ESP_EVENT_ANY_ID,wifi_event,NULL);
    if (err==ESP_OK) err=esp_event_handler_register(IP_EVENT,IP_EVENT_STA_GOT_IP,wifi_event,NULL);
    wifi_config_t wifi={0};
    memcpy(wifi.sta.ssid,settings.ssid,strlen(settings.ssid));
    memcpy(wifi.sta.password,settings.password,strlen(settings.password));
    wifi.sta.threshold.authmode=settings.wifi_security==CP_WIFI_OPEN?WIFI_AUTH_OPEN:
        settings.wifi_security==CP_WIFI_ENTERPRISE_PEAP?WIFI_AUTH_WPA2_ENTERPRISE:WIFI_AUTH_WPA2_PSK;
    wifi.sta.pmf_cfg.capable=true;
    if (err==ESP_OK) err=esp_wifi_set_mode(WIFI_MODE_STA);
    if (err==ESP_OK) err=esp_wifi_set_config(WIFI_IF_STA,&wifi);
    memset(&wifi,0,sizeof(wifi));
    if (err==ESP_OK && settings.wifi_security==CP_WIFI_ENTERPRISE_PEAP) {
        /* Honor the saved PEAP mode; its existing RADIUS policy is independent
         * from strict certificate/date/IP-SAN verification on diagnostic HTTPS. */
        esp_eap_client_clear_ca_cert();
        err=esp_eap_client_use_default_cert_bundle(false);
        if (err==ESP_OK) err=esp_eap_client_set_disable_time_check(true);
        if (err==ESP_OK) err=esp_eap_client_set_eap_methods(ESP_EAP_TYPE_PEAP);
        if (err==ESP_OK) err=esp_eap_client_set_identity((unsigned char *)settings.eap_identity,strlen(settings.eap_identity));
        if (err==ESP_OK) err=esp_eap_client_set_username((unsigned char *)settings.eap_username,strlen(settings.eap_username));
        if (err==ESP_OK) err=esp_eap_client_set_password((unsigned char *)settings.eap_password,strlen(settings.eap_password));
        if (err==ESP_OK) err=esp_wifi_sta_enterprise_enable();
    }
    cp_settings_clear_sensitive(&settings);
    if (err==ESP_OK) err=esp_wifi_start();
    if (err==ESP_OK) err=esp_wifi_set_ps(WIFI_PS_NONE);
    if (err==ESP_OK) err=esp_wifi_connect();
    if (err!=ESP_OK) return err;
    EventBits_t bits=xEventGroupWaitBits(wifi_events,3,pdFALSE,pdFALSE,pdMS_TO_TICKS(60000));
    return bits&1?ESP_OK:ESP_ERR_TIMEOUT;
}

static void tcp_probes(void)
{
    unsigned a,b,c,d,port;
    if (sscanf(CP_LAN_URL,"https://%u.%u.%u.%u:%u",&a,&b,&c,&d,&port)!=5
        || a>255 || b>255 || c>255 || d>255 || port==0 || port>65535) return;
    char ip[16]; snprintf(ip,sizeof(ip),"%u.%u.%u.%u",a,b,c,d);
    struct sockaddr_in target={.sin_family=AF_INET,.sin_port=htons(port)};
    if (inet_pton(AF_INET,ip,&target.sin_addr)!=1) return;
    for (unsigned i=0;i<5;++i) {
        int fd=socket(AF_INET,SOCK_STREAM,IPPROTO_IP),err=0;
        int64_t start=esp_timer_get_time();
        if (fd<0) err=errno;
        else {
            int nonblocking=1;
            if (ioctl(fd,FIONBIO,&nonblocking)<0) err=errno;
            if (!err && connect(fd,(struct sockaddr *)&target,sizeof(target))<0) {
                if (errno!=EINPROGRESS) err=errno;
                else {
                    fd_set writes; FD_ZERO(&writes); FD_SET(fd,&writes);
                    struct timeval timeout={.tv_sec=3};
                    int ready=select(fd+1,NULL,&writes,NULL,&timeout);
                    if (ready<=0) err=ready==0?ETIMEDOUT:errno;
                    else { socklen_t len=sizeof(err); if (getsockopt(fd,SOL_SOCKET,SO_ERROR,&err,&len)<0) err=errno; }
                }
            }
            close(fd);
        }
        printf("LAN_TCP sample=%u ok=%u err=%d total_us=%"PRId64"\n",i,err==0,err,esp_timer_get_time()-start);
        vTaskDelay(pdMS_TO_TICKS(50));
    }
}

static void idle(void)
{
    __atomic_store_n(&sampler_stop,true,__ATOMIC_RELEASE);
    esp_err_t stopped=lan_ble_stop();
    lan_ble_print("final","all",0,NULL);
    printf("LAN_STOP ok=%u err=%d runtime_retained=%u full_deinit=0 scanner_stopped=%u worker_stopped=%u application_buffers_cleared=%u\n",
           stopped==ESP_OK,stopped,lan_ble_runtime_retained(),stopped==ESP_OK,
           stopped==ESP_OK,stopped==ESP_OK);
    if (stopped==ESP_OK) printf("LAN_DONE idle=1 auto_restart=0 runtime_retained=%u full_deinit=0\n",
                               lan_ble_runtime_retained());
    else printf("LAN_STOP_FAILED idle=1 ownership_retained=1 auto_restart=0\n");
    for (;;) vTaskDelay(pdMS_TO_TICKS(1000));
}

void app_main(void)
{
    /* Vendor Wi-Fi logs may contain network identities; only numeric/content-
     * free diagnostic printf records are emitted after app startup. */
    esp_log_level_set("*",ESP_LOG_NONE);
    printf("LAN_BOOT schema=3 reset_reason=%u synthetic=1 tls12=1 ca_verify=1 name_verify=1 date_verify=1 ble=%u ui=0 deadline_ms=12000 deadline_cooperative=1 io_connected_ms=%u retry_delay_ms=%u http_buffer_bytes=%u samples=%u period_ms=%u\n",
           (unsigned)esp_reset_reason(),(unsigned)LAN_BLE_ENABLED,CONNECTED_IO_MS,RETRY_DELAY_MS,HTTP_BUFFER_BYTES,SAMPLES,(unsigned)CP_LAN_PERIOD_MS);
    bool validator_ok=validator_selfcheck();
    printf("LAN_VALIDATOR ok=%u length_hash_status_oversize=1\n",validator_ok);
    if (!validator_ok) idle();
    struct timeval now={.tv_sec=CP_LAN_UNIX_TIME,.tv_usec=0};
    if (settimeofday(&now,NULL)!=0) { printf("LAN_CLOCK ok=0\n"); idle(); }
    esp_err_t err=wifi_start_saved();
    printf("LAN_WIFI saved_only=1 ram_storage=1 ok=%u err=%d\n",err==ESP_OK,err);
    if (err!=ESP_OK) idle();
    err=lan_ble_start();
    printf("LAN_BLE_START enabled=%u ok=%u err=%d passive=1 interval_ms=100 window_ms=50 filter_duplicates=0 queue_capacity=64 window_ms_aggregate=10000 bin_ms=1000 max_addresses=64 raw=0\n",(unsigned)LAN_BLE_ENABLED,err==ESP_OK,err);
    if (err!=ESP_OK) idle();
#if CONFIG_CP_LAN_BLE_LOAD
    /* At least five seconds of real scan/aggregation before any TLS work. */
    vTaskDelay(pdMS_TO_TICKS(5000));
    lan_ble_print("warmup","all",0,NULL);
#endif
    /* Static lifetime prevents sampler use-after-return while switching phases. */
    static request_t r;
    r.largest_sampled_min=SIZE_MAX;
    if (xTaskCreate(heap_sampler,"lan_heap",2048,NULL,2,NULL)!=pdPASS) {
        printf("LAN_SAMPLER ok=0\n"); idle();
    }
    tcp_probes();
    esp_http_client_handle_t client=client_new(&r,lan_ca_pem);
    if (!client) { printf("LAN_HEALTH ok=0 alloc=0\n"); idle(); }
    bool healthy=request_run(client,&r,0,NULL,true);
    print_request("health",0,0,&r);
    esp_http_client_cleanup(client);
    if (!healthy) idle();
#if CP_LAN_HAS_BAD_CA
    client=client_new(&r,lan_bad_ca_pem);
    if (!client) { printf("LAN_NEGATIVE ok=0 alloc=0\n"); idle(); }
    request_run(client,&r,0,NULL,true);
    bool rejected=certificate_rejected(&r);
    print_request("wrong_ca",0,0,&r);
    printf("LAN_NEGATIVE ok=%u headers_sent=%u connects=%u tls_code=%d verify_flags=%d\n",
           rejected,r.header_events,r.connects,r.tls_error,r.tls_flags);
    esp_http_client_cleanup(client);
    if (!rejected) idle();
#else
    printf("LAN_NEGATIVE skipped=1\n");
#endif
    for (size_t i=0;i<sizeof(payload);++i) payload[i]=(char)('A'+(i*17+11)%26);
    const size_t sizes[]={1024,8192};
    for (unsigned size=0;size<2;++size) {
        unsigned char digest[32]; char hash[65];
        if (mbedtls_sha256((unsigned char *)payload,sizes[size],digest,0)!=0) idle();
        static const char hex[]="0123456789abcdef";
        for (unsigned i=0;i<32;++i) { hash[2*i]=hex[digest[i]>>4]; hash[2*i+1]=hex[digest[i]&15]; }
        hash[64]=0;
        benchmark(false,sizes[size],hash,&r);
        benchmark(true,sizes[size],hash,&r);
    }
    idle();
}
