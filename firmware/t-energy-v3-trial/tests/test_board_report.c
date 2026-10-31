#include "board_report.h"
#include <assert.h>
#include <stdio.h>
#include <string.h>
int main(void) {
    te_v3_report_t s; cp_v3_stats_report_t r;
    memset(&s,0xa5,sizeof s); te_v3_report_init(&s,17,1234567);
    assert(s.seq==17 && s.mono_us==1234567 && s.rssi==127 && s.tx_power==127 && s.sid==255);
    s.kind=1;s.event_type=4;s.props=0x1b;s.data_status=2;s.sid=6;
    s.primary_phy=1;s.secondary_phy=3;s.address_type=3;s.direct_address_type=2;
    for(unsigned i=0;i<6;i++){s.address[i]=i;s.direct_address[i]=5-i;}
    s.periodic_interval=321;s.rssi=-83;s.tx_power=-12;s.length=CP_V3_STATS_PAYLOAD_MAX;
    s.payload[0]=0x11;s.payload[s.length-1]=0x77;
    assert(te_v3_report_view(&s,&r));
    assert(r.seq==17 && r.mono_us==1234567 && r.kind==1 && r.event_type==4 && r.props==0x1b && r.data_status==2);
    assert(r.sid==6 && r.primary_phy==1 && r.secondary_phy==3 && r.periodic_interval==321);
    assert(r.address_type==3 && r.direct_address_type==2 && !memcmp(r.address,s.address,6) && !memcmp(r.direct_address,s.direct_address,6));
    assert(r.rssi==-83 && r.tx_power==-12 && r.length==CP_V3_STATS_PAYLOAD_MAX && r.payload==s.payload && r.payload[r.length-1]==0x77);
    s.event_type=0; s.props=0x08;assert(te_v3_report_is_scan_response(&s));
    s.event_type=4; s.props=0;assert(!te_v3_report_is_scan_response(&s));
    te_v3_report_init(&s,18,7654321);s.event_type=4;s.length=0;
    assert(te_v3_report_is_scan_response(&s));
    s.event_type=0;assert(!te_v3_report_is_scan_response(&s));
    assert(te_v3_report_view(&s,&r) && r.kind==0 && r.rssi==127 && r.sid==255 && r.length==0);
    s.length=CP_V3_STATS_PAYLOAD_MAX+1; assert(!te_v3_report_view(&s,&r));
    s.length=0;s.kind=2;assert(!te_v3_report_view(&s,&r));
    assert(!te_v3_report_is_scan_response(&s));
    s.kind=0;s.seq=0;assert(!te_v3_report_view(&s,&r));
    assert(!te_v3_report_view(NULL,&r) && !te_v3_report_view(&s,NULL));
    uint32_t losses=UINT32_MAX-2;
    assert(te_v3_count_loss(&losses) && losses==UINT32_MAX-1);
    assert(!te_v3_count_loss(&losses) && losses==UINT32_MAX);
    assert(!te_v3_count_loss(&losses) && losses==UINT32_MAX);
    assert(!te_v3_count_loss(NULL));
    puts("board report mapping tests passed");
}
