#include "cp_network_diag.h"
#include <string.h>
static const char *const stages[]={"idle","handoff","wifi_connect","dhcp","clock","dns","tls","cloud_auth","save","ready"};
static const char *const codes[]={"idle","queued","handoff_failed","network_start_failed","wifi_connecting","wifi_not_found","wifi_auth_failed","wifi_connect_failed","wifi_timeout","dhcp_wait","dhcp_timeout","clock_sync","clock_failed","clock_timeout","dns_resolving","dns_failed","dns_timeout","tls_connecting","tls_failed","tls_certificate_failed","tls_timeout","cloud_checking","cloud_auth_failed","http_failed","invalid_cloud_reply","cloud_timeout","network_validated","saving","save_failed","saved","network_stop_failed","validation_timeout","validation_interrupted","resource_exhausted"};
const char *cp_network_diag_stage_name(cp_diag_stage_t stage)
{return (unsigned)stage<CP_DIAG_STAGE_COUNT?stages[stage]:"idle";}
const char *cp_network_diag_code_name(cp_diag_code_t code)
{return (unsigned)code<CP_DIAG_CODE_COUNT?codes[code]:"validation_timeout";}
void cp_network_diag_reset(cp_network_diagnostic_t *d)
{if(d)memset(d,0,sizeof(*d));}
void cp_network_diag_update(cp_network_diagnostic_t *d,cp_diag_stage_t stage,
    cp_diag_code_t code,esp_err_t error,uint32_t elapsed,bool retryable,bool terminal)
{
    if(!d || (unsigned)stage>=CP_DIAG_STAGE_COUNT || (unsigned)code>=CP_DIAG_CODE_COUNT)return;
    d->stage=stage;d->code=code;d->esp_err=error;d->elapsed_ms=elapsed;
    d->retryable=retryable;d->terminal=terminal;
}
cp_diag_code_t cp_network_diag_wifi_reason(unsigned reason)
{
    /* ESP-IDF5.5.3 wifi_err_reason_t numeric wire values; no password verdict. */
    if(reason==201 || reason==210 || reason==211 || reason==212)return CP_DIAG_WIFI_NOT_FOUND;
    if(reason==2 || reason==15 || reason==202 || reason==204)return CP_DIAG_WIFI_AUTH_FAILED;
    return CP_DIAG_WIFI_CONNECT_FAILED;
}
cp_diag_code_t cp_network_diag_timeout_code(const cp_network_diagnostic_t *d)
{
    if(!d)return CP_DIAG_VALIDATION_TIMEOUT;
    switch(d->stage){
    case CP_DIAG_WIFI_CONNECT:
        return d->wifi_reason?cp_network_diag_wifi_reason((unsigned)d->wifi_reason):CP_DIAG_WIFI_TIMEOUT;
    case CP_DIAG_DHCP:return CP_DIAG_DHCP_TIMEOUT;
    case CP_DIAG_CLOCK:return CP_DIAG_CLOCK_TIMEOUT;
    case CP_DIAG_DNS:return CP_DIAG_DNS_TIMEOUT;
    case CP_DIAG_TLS:return CP_DIAG_TLS_TIMEOUT;
    case CP_DIAG_CLOUD_AUTH:return CP_DIAG_CLOUD_TIMEOUT;
    case CP_DIAG_SAVE:return CP_DIAG_SAVE_FAILED;
    default:return CP_DIAG_VALIDATION_TIMEOUT;
    }
}
void cp_network_diag_finish_timeout(cp_network_diagnostic_t *d,uint32_t elapsed)
{
    if(!d || d->terminal)return;
    /* A candidate's total budget is not a replacement for an observed error. */
    if(d->esp_err!=ESP_OK) {
        d->elapsed_ms=elapsed;d->terminal=1;
        return;
    }
    cp_network_diag_update(d,d->stage,cp_network_diag_timeout_code(d),
        ESP_ERR_TIMEOUT,elapsed,true,true);
}
bool cp_network_diag_valid(const cp_network_diagnostic_t *d)
{return d && (unsigned)d->stage<CP_DIAG_STAGE_COUNT && (unsigned)d->code<CP_DIAG_CODE_COUNT && d->http_status>=0 && d->http_status<=599 && d->wifi_reason>=0 && d->wifi_reason<=255 && d->retryable<=1 && d->terminal<=1;}
static bool uuid(const char s[37])
{
    if(!memchr(s,0,37)||strlen(s)!=36||s[14]!='4'||!(s[19]=='8'||s[19]=='9'||s[19]=='a'||s[19]=='b'))return false;
    for(unsigned i=0;i<36;++i){if(i==8||i==13||i==18||i==23){if(s[i]!='-')return false;}else if(!((s[i]>='0'&&s[i]<='9')||(s[i]>='a'&&s[i]<='f')))return false;}
    return true;
}
bool cp_network_attempt_valid(const cp_network_attempt_t *a)
{return a && a->version==1 && a->state>=CP_ATTEMPT_INTERRUPTED && a->state<=CP_ATTEMPT_SAVED && uuid(a->attempt_id)&&uuid(a->boot_id)&&cp_network_diag_valid(&a->diagnostic);}
