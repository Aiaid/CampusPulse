#include "cp_provision_guard.h"
#include <assert.h>
#include <stdio.h>
#include <string.h>
static void fill(cp_settings_t *s) {
    strcpy(s->mqtt_uri,CP_MQTT_PRODUCTION_URI);strcpy(s->mqtt_username,"fixture_pool");strcpy(s->mqtt_password,"synthetic-mqtt-password");strcpy(s->mqtt_namespace,"fixture_pool");
    s->version = CP_SETTINGS_VERSION; s->wifi_security=CP_WIFI_PERSONAL;
    memset(s->eap_username,0,sizeof s->eap_username);memset(s->eap_identity,0,sizeof s->eap_identity);memset(s->eap_password,0,sizeof s->eap_password);
    strcpy(s->node_id, "cp_001122aabbcc"); strcpy(s->ssid, "test-network");
    strcpy(s->password, "test-password"); strcpy(s->device_token, "cpd_test-fixture-only");
    strcpy(s->api_origin, "https://pulse.anend.net");
}
int main(void) {
    assert(cp_provision_uuid_v4("11111111-2222-4333-8444-555555555555"));
    assert(cp_provision_uuid_v4("aaaaaaaa-bbbb-4ccc-bddd-eeeeeeeeeeee"));
    const char *bad[] = { "11111111-2222-3333-8444-555555555555", "11111111-2222-4333-7444-555555555555", "11111111-2222-4333-c444-555555555555", "111111112222-4333-8444-555555555555", "------------------------------------", "11111111-2222-4A33-8444-555555555555", "11111111-2222-4333-8444-555555555555x", "" };
    for (unsigned i = 0; i < sizeof(bad)/sizeof(bad[0]); i++) assert(!cp_provision_uuid_v4(bad[i]));
    assert(!cp_provision_uuid_v4(NULL));
    uint8_t context[44]; for (unsigned i = 0; i < sizeof(context); i++) context[i] = i;
    char nonce[33],next_nonce[33];
    assert(cp_provision_session_nonce("00112233445566778899aabbccddeeff",context,sizeof context,nonce));
    /* Independent Node/OpenSSL HMAC-SHA256 vector; USB nonce domain unchanged. */
    assert(!strcmp(nonce,"7d46c14f9959eea5b52c7612fd8ef2b6"));
    context[43]++;
    assert(cp_provision_session_nonce("00112233445566778899aabbccddeeff",context,sizeof context,next_nonce));assert(strcmp(nonce,next_nonce));
    context[43]--;
    assert(cp_provision_session_nonce("10112233445566778899aabbccddeeff",context,sizeof context,next_nonce));assert(strcmp(nonce,next_nonce));
    assert(!cp_provision_session_nonce("00112233445566778899aabbccddeeFF",context,sizeof context,next_nonce));
    assert(!cp_provision_session_nonce("00112233445566778899aabbccddeeff",context,15,next_nonce));
    cp_settings_t first, second; memset(&first, 0xa5, sizeof(first)); memset(&second, 0x5a, sizeof(second)); fill(&first); fill(&second);
    uint8_t a[32], b[32]; assert(cp_provision_settings_digest(&first, a)); assert(cp_provision_settings_digest(&second, b)); assert(cp_provision_digest_equal(a,b));
    /* Every persisted candidate field participates; struct padding does not. */
    for (unsigned i = 0; i < 14; i++) {
        fill(&second);
        switch(i) { case 0: second.version++; break; case 1: second.node_id[3]='f'; break; case 2: second.ssid[0]='x'; break; case 3: second.password[0]='x'; break; case 4: second.device_token[4]='x'; break; case 5: second.api_origin[8]='x'; break; case 6: second.wifi_security=CP_WIFI_OPEN; break; case 7: strcpy(second.eap_username,"synthetic-user"); break; case 8: strcpy(second.eap_identity,"synthetic-identity"); break; case 9: strcpy(second.eap_password,"synthetic-password"); break;case 10: second.mqtt_uri[8]='x';break;case 11: second.mqtt_username[0]='x';break;case 12: second.mqtt_password[0]='x';break;case 13: second.mqtt_namespace[0]='x';break; }
        assert(cp_provision_settings_digest(&second,b)); assert(!cp_provision_digest_equal(a,b));
    }
    fill(&first); fill(&second); strcpy(first.ssid,"ab"); strcpy(first.password,"c"); strcpy(second.ssid,"a"); strcpy(second.password,"bc");
    assert(cp_provision_settings_digest(&first,a)); assert(cp_provision_settings_digest(&second,b)); assert(!cp_provision_digest_equal(a,b));
    memset(second.password,'x',sizeof(second.password)); assert(!cp_provision_settings_digest(&second,b));
    /* Identical resolved settings still bind mode and RAM credential generation. */
    fill(&first);assert(cp_provision_candidate_digest(&first,false,1,a));
    assert(cp_provision_candidate_digest(&first,true,1,b));assert(!cp_provision_digest_equal(a,b));
    assert(cp_provision_candidate_digest(&first,true,1,a));assert(cp_provision_candidate_digest(&first,true,2,b));assert(!cp_provision_digest_equal(a,b));
    memset(b,0xa5,sizeof b);assert(!cp_provision_candidate_digest(&first,true,0,b));for(unsigned i=0;i<sizeof b;++i)assert(b[i]==0);
    puts("Provision guard: UUIDv4 rejection, USB nonce HMAC context/key, Wi-Fi/EAP field digest, credential mode/generation and length framing passed."); return 0;
}
