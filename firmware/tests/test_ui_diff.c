/* Host-only framebuffer pair: every sequential partial update must equal a
 * fresh full render. Also emulate pending DMA across separate dirty rectangles.
 * No framebuffer or test counter is compiled into device firmware. */
#include <assert.h>
#include <stdio.h>
#include <string.h>
#include "ui_mini.h"
#include "page_status.h"

static uint16_t frames[2][UI_H][UI_W];
static unsigned target, stripes, bytes_sent;
static const uint16_t *pending;
static uint16_t pending_copy[UI_W*4];
static size_t pending_bytes;
static cp_status_view_t shown;

static void check_pending(void)
{
    if (pending) assert(!memcmp(pending,pending_copy,pending_bytes));
}
esp_err_t esp_lcd_panel_draw_bitmap(esp_lcd_panel_handle_t panel,
                                   int x0,int y0,int x1,int y1,const void *data)
{
    check_pending();
    assert(panel==(void *)1 && x0==0 && x1==UI_W && y0>=0 && y1<=UI_H);
    assert(y1>y0 && y1-y0<=4);
    const uint16_t *p=data;
    for (int y=y0;y<y1;y++) for (int x=x0;x<x1;x++) frames[target][y][x]=*p++;
    stripes++;
    bytes_sent+=(unsigned)(x1-x0)*(unsigned)(y1-y0)*2;
    pending=data;
    pending_bytes=(size_t)(x1-x0)*(size_t)(y1-y0)*2;
    memcpy(pending_copy,data,pending_bytes);
    return ESP_OK;
}
static unsigned transition(const cp_status_view_t *next,int expected_stripes,const char *label)
{
    target=1;
    status_page_render(next);
    target=0;stripes=bytes_sent=0;
    status_page_render_diff(next,&shown);
    check_pending();
    assert(!memcmp(frames[0],frames[1],sizeof frames[0]));
    if (expected_stripes>=0) assert(stripes==(unsigned)expected_stripes);
    else assert(stripes<80);
    assert(bytes_sent==stripes*UI_W*4*2);
    if (label) printf("%-22s stripes=%u bytes=%u\n",label,stripes,bytes_sent);
    shown=*next;
    return stripes;
}
static void test_sequential_projections(void)
{
    cp_status_view_t v={0};
    target=0;stripes=bytes_sent=0;
    status_page_render_diff(&v,NULL);
    assert(stripes==80 && bytes_sent==153600);
    shown=v;
    transition(&v,0,"identical");
    v.debug.domain.reports_seen=123;v.debug.upload.attempt_elapsed_ms=500;
    v.battery_percent=88;strcpy(v.board,"hidden");strcpy(v.node_id,"hidden-node");
    transition(&v,0,"unrendered fields");
    v.setup_softap=v.setup_usb=true;transition(&v,0,"hidden setup mode flags");
    v.setup_softap=v.setup_usb=false;transition(&v,0,NULL);
    v.debug.wifi_connected=v.debug.wifi_rssi_known=v.debug.wifi_phy_known=true;
    v.debug.wifi_mbps_known=true;v.debug.wifi_mbps=72;v.debug.wifi_rssi_dbm=-61;
    strcpy(v.debug.wifi_ssid,"Synthetic Long Debug AP");strcpy(v.debug.wifi_phy,"11n/20");
    v.debug.heap_known=v.debug.queue_known=true;
    v.debug.heap_internal_free=102400;v.debug.heap_internal_total=1024000;
    v.debug.heap_internal_largest=22000;v.debug.heap_boot_min_8bit=16000;
    v.debug.queue_pending=2;v.debug.queue_capacity=341;
    v.debug.upload.known=v.debug.upload.goodput_known=true;
    v.debug.upload.result=CP_DEBUG_UPLOAD_ACKED;v.debug.upload.goodput_bytes_per_sec=18944;
    v.debug.upload.last_age_ms=12000;v.debug.upload.last_http_status=200;
    strcpy(v.authentication,"AUTHENTICATED");strcpy(v.collection,"collecting");
    transition(&v,-1,"unknown to known");
    strcpy(v.authentication,"A");transition(&v,6,"shrinking Auth row");
    strcpy(v.debug.wifi_ssid,"A");transition(&v,6,"shrinking SSID row");
    v.debug.storage_drops=1;transition(&v,5,"color-only loss warning");
    v.debug.storage_drops=2;transition(&v,0,"same loss warning color");
    v.debug.heap_internal_free++;transition(&v,0,"same KiB/bar pixel");
    v.debug.upload.last_age_ms=12999;transition(&v,0,"same rounded age");
    v.debug.upload.last_age_ms=13000;transition(&v,5,"upload age row");
    v.debug.upload.goodput_bytes_per_sec++;transition(&v,0,"same rounded goodput");
    v.debug.queue_pending=3;transition(&v,6,"queue text same bar");
    v.debug.wifi_connected=false;transition(&v,-1,"offline projections");
    v.debug.upload.in_flight=true;transition(&v,-1,"sending state");
    v.debug.upload.in_flight=false;v.debug.upload.result=CP_DEBUG_UPLOAD_BAD_ACK;
    v.debug.upload.last_http_status=422;v.debug.upload.last_error=-7;
    transition(&v,-1,"upload error");
    v.debug.upload.known=false;transition(&v,-1,"upload unavailable");
    v.debug.heap_known=false;v.debug.queue_capacity=0;
    transition(&v,-1,"unknown bar tracks");
    v.debug.wifi_connected=true;
    memset(v.debug.wifi_ssid,'W',32);v.debug.wifi_ssid[32]=0;
    transition(&v,-1,NULL);
    v.debug.wifi_ssid[31]='A';transition(&v,0,"same clipped SSID");
    v.debug.wifi_ssid[0]=(char)0xff;v.debug.wifi_ssid[1]='A';v.debug.wifi_ssid[2]=0;
    transition(&v,6,"ASCII sanitization");
    v.debug.wifi_ssid[0]=(char)0x80;transition(&v,0,"same sanitized SSID");
    v.page=CP_DEVICE_PAGE_ACTIVITY;transition(&v,80,"page transition");
    cp_debug_domain_t *d=&v.debug.domain;
    d->known=d->window_partial=true;d->bin_count=16;d->bin_ms=1000;d->window_ms=16000;
    d->window_seq=19;d->reports_seen=100;d->reports_aggregated=98;d->addresses=12;
    d->bin_reports[0]=20;d->bin_reports[1]=10;
    transition(&v,-1,"activity known");
    d->bin_reports[1]=11;transition(&v,9,"chart pixel change");
    for (unsigned i=0;i<16;i++) d->bin_reports[i]*=2;
    transition(&v,5,"same normalized chart");
    d->bin_reports[0]=1000;d->bin_reports[1]=50;transition(&v,-1,NULL);
    d->bin_reports[1]=51;transition(&v,0,"same rounded chart");
    d->known=false;transition(&v,-1,"chart becomes unknown");
    v.page=CP_DEVICE_PAGE_VEHICLE;transition(&v,80,NULL);
    d->known=true;d->vehicle_candidates=3;d->vehicle_parsed_reports=100;
    transition(&v,-1,NULL);
    d->vehicle_candidates=1;transition(&v,5,"candidate count row");
    d->reports_seen++;transition(&v,0,"e-bike hidden field");
    v.page=CP_DEVICE_PAGE_ELEVATOR;transition(&v,80,NULL);
    d->rssi_samples=12;d->rssi_min=-90;d->rssi_mean=-65;d->rssi_max=-42;
    transition(&v,-1,"RSSI slice rows");
    v.debug.clock_trusted=v.debug.clock_estimated=true;
    v.debug.clock_epoch=2;v.debug.clock_uncertainty_ms=350;
    transition(&v,-1,"clock input rows");
    v.debug.reports_total++;transition(&v,0,"elevator hidden field");
    v.setup_active=v.setup_usb=true;strcpy(v.setup_state,"waiting for candidate");
    transition(&v,80,"USB setup transition");
    v.setup_softap=true;transition(&v,0,"USB hidden AP flag");
    v.page=CP_DEVICE_PAGE_DEBUG;transition(&v,0,"setup hidden page");
    v.setup_softap=false;transition(&v,0,NULL);
    strcpy(v.setup_proof,"12345678");strcpy(v.setup_password,"example12345");
    transition(&v,0,"USB hidden secrets");
    strcpy(v.setup_state,"OK");transition(&v,5,"shrinking setup state");
    v.setup_usb=false;v.setup_softap=true;strcpy(v.setup_name,"Synthetic Setup AP");
    transition(&v,80,"SoftAP transition");
    v.setup_proof[0]='9';transition(&v,5,"setup PIN value");
    strcpy(v.setup_password,"P");transition(&v,5,"shrinking AP password");
    strcpy(v.setup_state,"invisible in SoftAP");transition(&v,0,"SoftAP hidden state");
    v.setup_softap=false;transition(&v,80,"BLE setup transition");
    strcpy(v.setup_state,"waiting");transition(&v,5,"BLE setup state");
    v.setup_active=false;transition(&v,80,"leave setup");
    status_page_render_diff(NULL,&v);
}
static void test_mixed_sequence(void)
{
    cp_status_view_t v=shown;
    uint32_t random=0x184092a1;
    for (unsigned i=0;i<240;i++) {
        random^=random<<13;random^=random>>17;random^=random<<5;
        switch (random%35) {
        case 0: v.page=(cp_device_page_t)((unsigned)v.page+1u);if(v.page>=CP_DEVICE_PAGE_COUNT)v.page=CP_DEVICE_PAGE_DEBUG;break;
        case 1:v.setup_active=!v.setup_active;break;
        case 2:v.setup_usb=!v.setup_usb;break;
        case 3:v.setup_softap=!v.setup_softap;break;
        case 4:snprintf(v.setup_state,sizeof v.setup_state,"S%lu",(unsigned long)random);break;
        case 5:snprintf(v.setup_name,sizeof v.setup_name,"AP%lu",(unsigned long)random);break;
        case 6:snprintf(v.setup_proof,sizeof v.setup_proof,"%lu",(unsigned long)random);break;
        case 7:snprintf(v.setup_password,sizeof v.setup_password,"P%lu",(unsigned long)random);break;
        case 8:v.debug.wifi_connected=!v.debug.wifi_connected;break;
        case 9:v.debug.wifi_rssi_dbm=(int8_t)random;break;
        case 10:v.debug.heap_known=!v.debug.heap_known;break;
        case 11:v.debug.heap_internal_free=random;break;
        case 12:v.debug.heap_internal_total=random;break;
        case 13:v.debug.heap_internal_largest=random;break;
        case 14:v.debug.heap_boot_min_8bit=random;break;
        case 15:v.debug.queue_known=!v.debug.queue_known;break;
        case 16:v.debug.queue_pending=random;break;
        case 17:v.debug.queue_capacity=random;break;
        case 18:v.debug.upload.known=!v.debug.upload.known;break;
        case 19:v.debug.upload.in_flight=!v.debug.upload.in_flight;break;
        case 20:v.debug.upload.result=(cp_debug_upload_result_t)(random%7);break;
        case 21:v.debug.upload.last_age_ms=random;break;
        case 22:v.debug.upload.goodput_bytes_per_sec=random;break;
        case 23:v.debug.raw_drops=random;break;
        case 24:v.debug.domain.known=!v.debug.domain.known;break;
        case 25:v.debug.domain.bin_reports[random%16]=random;break;
        case 26:v.debug.domain.bin_count=(uint8_t)random;break;
        case 27:v.debug.domain.age_ms=random;break;
        case 28:v.debug.domain.vehicle_candidates=random;break;
        case 29:v.debug.domain.rssi_mean=(int16_t)random;break;
        case 30:v.debug.clock_trusted=!v.debug.clock_trusted;break;
        case 31:v.debug.clock_uncertainty_ms=random;break;
        case 32:v.debug.upload.last_error=(int32_t)random;break;
        case 33:snprintf(v.authentication,sizeof v.authentication,"A%lu",(unsigned long)random);break;
        case 34:snprintf(v.collection,sizeof v.collection,"C%lu",(unsigned long)random);break;
        }
        unsigned old_mode=!shown.setup_active?0:shown.setup_usb?1:shown.setup_softap?2:3;
        unsigned new_mode=!v.setup_active?0:v.setup_usb?1:v.setup_softap?2:3;
        transition(&v,old_mode!=new_mode || (!v.setup_active && shown.page!=v.page) ? 80 : -1,NULL);
    }
}
int main(void)
{
    assert(ui_init((void *)1)==ESP_OK);
    test_sequential_projections();
    test_mixed_sequence();
    puts("Dirty/full sequential pixel identity, DMA ownership and 240 mixed transitions: PASS");
    return 0;
}
