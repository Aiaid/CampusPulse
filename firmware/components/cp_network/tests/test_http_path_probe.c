#include "http_path_probe.h"
#include <assert.h>
#include <stdio.h>
#include <string.h>

static void test_colo(void)
{
    cp_http_path_probe_t p={0};
    cp_http_path_header(&p,"CF-Ray","abcdef0123456789-HKG");
    assert(p.colo_known && !strcmp(p.colo,"HKG"));
    cp_http_path_header(&p,"cf-ray","0123456789abcdef-HKG");
    assert(p.colo_known && !strcmp(p.colo,"HKG"));
    cp_http_path_header(&p,"cf-ray","0123456789abcdef-NRT");
    assert(!p.colo_known);
    cp_http_path_header(&p,"cf-ray","0123456789abcdef-HKG");
    assert(!p.colo_known); /* A conflicting duplicate stays unknown. */
    const char *bad[]={"","a","-HKG","123-HKG","12345678-H","12345678-HK",
        "12345678-hkg","12345678-HKG-extra","12345678-HKG\n",
        "zzzzzzzz-HKG","0123456789abcdef0123456789abcdef01-HKG"};
    for(size_t i=0;i<sizeof bad/sizeof bad[0];++i) {
        p=(cp_http_path_probe_t){0};
        cp_http_path_header(&p,"cf-ray",bad[i]);
        assert(!p.colo_known && !p.colo[0]);
    }
    const char *keys[]={"","c","cf-ra","cf-ray-extra","other"};
    for(size_t i=0;i<sizeof keys/sizeof keys[0];++i) {
        p=(cp_http_path_probe_t){0};
        cp_http_path_header(&p,keys[i],"abcdef0123456789-HKG");
        assert(!p.colo_known);
    }
    cp_http_path_header(&p,NULL,"abcdef0123456789-HKG");
    cp_http_path_header(&p,"cf-ray",NULL);
    assert(!p.colo_known);
}

static void test_sampling(void)
{
    cp_http_path_probe_t p={0};
    assert(!cp_http_path_early_due(&p,true));
    for(unsigned i=0;i<CP_HTTP_PATH_EARLY_PROBES;++i) {
        assert(cp_http_path_early_due(&p,false));
        cp_http_path_observe(&p,false,false,false,20u*(i+1),3);
    }
    assert(!cp_http_path_early_due(&p,false) && !p.ready_known);
    cp_http_path_observe(&p,true,true,true,300,0);
    assert(p.end_known && p.end_write_ready && !p.ready_known);
    assert(p.early_probes==CP_HTTP_PATH_EARLY_PROBES);

    p=(cp_http_path_probe_t){0};
    cp_http_path_observe(&p,false,true,false,20,12);
    cp_http_path_observe(&p,false,true,true,1250,1210);
    assert(p.ready_known && p.ready_upper_ms==1250 && p.ready_gap_ms==1230);
    assert(p.max_perform_ms==1210 && !cp_http_path_early_due(&p,false));
    cp_http_path_observe(&p,true,false,true,2000,0);
    assert(!p.end_known && !p.end_write_ready && p.ready_upper_ms==1250);
    assert(cp_http_path_u32((uint64_t)UINT32_MAX+1)==UINT32_MAX);
}

int main(void)
{
    test_colo();test_sampling();
    puts("HTTP path probe: bounded samples and colo privacy parser passed");
    return 0;
}
