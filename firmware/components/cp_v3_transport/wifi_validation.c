#include "cp_v3_transport.h"
#include "mbedtls/oid.h"
#include "mbedtls/x509_crt.h"
#include <string.h>

/* Pure preflight only. Peer chain/name/time authentication remains mandatory
 * in verified PEAP after the physical USB clock has been installed. Explicit
 * unverified PEAP is not represented as successful peer authentication. */
static int base64_digit(unsigned char c) {
    if (c >= 'A' && c <= 'Z') return c-'A';
    if (c >= 'a' && c <= 'z') return c-'a'+26;
    if (c >= '0' && c <= '9') return c-'0'+52;
    if (c == '+') return 62;
    if (c == '/') return 63;
    return -1;
}

bool cp_v3_ca_validate(const char *pem) {
    if (!pem) return false;
    size_t n = strnlen(pem, CP_V3_EAP_CA_MAX + 1u);
    static const char begin[] = "-----BEGIN CERTIFICATE-----";
    static const char end[] = "-----END CERTIFICATE-----";
    if (!n || n > CP_V3_EAP_CA_MAX || strncmp(pem,begin,sizeof begin-1)) return false;
    const char *p = pem + sizeof begin-1;
    if (*p == '\r') ++p;
    if (*p++ != '\n') return false;
    bool body = false, final_line = false;
    size_t encoded = 0, padding = 0;
    while (strncmp(p,end,sizeof end-1)) {
        if (final_line) return false;
        size_t width = 0, pads = 0;
        int last = 0;
        while (*p && *p != '\r' && *p != '\n') {
            unsigned char c = (unsigned char)*p++;
            if (++width > 64) return false;
            if (c == '=') { if (++pads > 2) return false; }
            else { last = base64_digit(c); if (pads || last < 0) return false; }
        }
        if (!width || width % 4) return false;
        if ((pads == 2 && (last & 15)) || (pads == 1 && (last & 3))) return false;
        encoded += width; padding += pads;
        body = true; final_line = width < 64 || pads;
        if (*p == '\r') ++p;
        if (*p++ != '\n') return false;
    }
    p += sizeof end-1;
    if (*p == '\r') { ++p; if (*p != '\n') return false; }
    if (*p == '\n') ++p;
    if (!body || *p) return false;
    /* mbedTLS PEM parsing alone is permissive about surrounding text and
     * partial chains. The exact envelope above forbids both. */
    mbedtls_x509_crt cert;
    mbedtls_x509_crt_init(&cert);
    bool ok = mbedtls_x509_crt_parse(&cert,(const unsigned char *)pem,n+1) == 0 &&
              cert.MBEDTLS_PRIVATE(ca_istrue) != 0 && !cert.next &&
              (!(cert.MBEDTLS_PRIVATE(ext_types) & MBEDTLS_X509_EXT_KEY_USAGE) ||
               (cert.MBEDTLS_PRIVATE(key_usage) & MBEDTLS_X509_KU_KEY_CERT_SIGN)) &&
              cert.raw.len == encoded/4u*3u-padding;
    mbedtls_x509_crt_free(&cert);
    return ok;
}

bool cp_v3_eap_domain_validate(const char *domain)
{
    if (!domain) return false;
    size_t n = strnlen(domain, CP_V3_EAP_DOMAIN_MAX + 1u);
    if (!n || n > CP_V3_EAP_DOMAIN_MAX) return false;
    size_t label = 0;
    bool non_numeric = false;
    for (size_t i = 0; i < n; ++i) {
        unsigned char c = (unsigned char)domain[i];
        if (c == '.') {
            if (!label || domain[i-1] == '-') return false;
            label = 0;
            continue;
        }
        bool alpha = (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z');
        if (!alpha && !(c >= '0' && c <= '9') && c != '-') return false;
        if (!label && c == '-') return false;
        if (++label > 63u) return false;
        if (alpha || c == '-') non_numeric = true;
    }
    return label && domain[n-1] != '-' && non_numeric;
}

bool cp_v3_eap_validate(const char *ca, const char *domain)
{
    return cp_v3_eap_domain_validate(domain) && cp_v3_ca_validate(ca);
}

bool cp_v3_wifi_validate_mode(const cp_settings_t *settings, const char *ca,
    const char *domain, cp_v3_eap_verification_t mode)
{
    if (!cp_settings_validate(settings) ||
        (mode != CP_V3_EAP_VERIFY_CA && mode != CP_V3_EAP_VERIFY_NONE)) return false;
    if (settings->wifi_security == CP_WIFI_ENTERPRISE_PEAP) {
        if (mode == CP_V3_EAP_VERIFY_NONE)
            return (!ca || !*ca) && (!domain || !*domain);
        return cp_v3_eap_validate(ca, domain);
    }
    /* Cross-mode field presence is additionally checked by each USB parser. */
    return mode == CP_V3_EAP_VERIFY_CA && (!ca || !*ca) && (!domain || !*domain);
}

bool cp_v3_wifi_validate(const cp_settings_t *settings, const char *ca, const char *domain)
{
    return cp_v3_wifi_validate_mode(settings, ca, domain, CP_V3_EAP_VERIFY_CA);
}
