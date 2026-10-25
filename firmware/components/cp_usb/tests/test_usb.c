#include "cp_usb.h"
#include <assert.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
static const char *ID="12345678-1234-4234-8234-123456789abc";
static unsigned frames,begins,exchanges;
static char received_id[37];static uint8_t received_json[CP_USB_JSON_MAX+1];static size_t received_length;
static bool begin_allowed=true;
static esp_err_t exchange_error;
static const char *exchange_reply="{\"v\":1,\"ok\":true,\"state\":\"testing\"}";
static bool begin(void *context){assert(context==&begins);++begins;return begin_allowed;}
static esp_err_t exchange(const uint8_t *request,size_t length,uint8_t **response,size_t *response_length)
{
    ++exchanges;assert(length<=CP_USB_JSON_MAX);memcpy(received_json,request,length);received_json[length]=0;
    *response=NULL;*response_length=0;
    if(exchange_error!=ESP_OK)return exchange_error;
    *response_length=strlen(exchange_reply);*response=malloc(*response_length);assert(*response);memcpy(*response,exchange_reply,*response_length);return ESP_OK;
}
static void receive(void *ctx,const char *id,const uint8_t *json,size_t length)
{assert(ctx==&frames);++frames;strcpy(received_id,id);memcpy(received_json,json,length);received_json[length]=0;received_length=length;}
static size_t encode(const char *json,uint8_t *frame)
{size_t n=0;assert(cp_usb_frame_encode(ID,(const uint8_t*)json,strlen(json),frame,CP_USB_FRAME_MAX,&n));return n;}
static void assert_clear(const cp_usb_frame_parser_t *p)
{for(size_t i=0;i<sizeof p->json;++i)assert(p->json[i]==0);for(size_t i=0;i<sizeof p->request_id;++i)assert(p->request_id[i]==0);}
static void split_and_noise(void)
{
    uint8_t frame[CP_USB_FRAME_MAX];const char *json="{\"v\":1,\"op\":\"begin\"}";size_t n=encode(json,frame);
    for(size_t split=0;split<=n;++split){cp_usb_frame_parser_t p;cp_usb_frame_init(&p);unsigned before=frames;
        cp_usb_frame_feed(&p,"I (1) cp_app: boot ready\r\n",26,receive,&frames);
        cp_usb_frame_feed(&p,frame,split,receive,&frames);cp_usb_frame_feed(&p,frame+split,n-split,receive,&frames);
        assert(frames==before+1&&!strcmp(received_id,ID)&&!strcmp((char*)received_json,json));assert_clear(&p);
    }
    cp_usb_frame_parser_t p;cp_usb_frame_init(&p);unsigned before=frames;
    for(size_t i=0;i<n;++i)cp_usb_frame_feed(&p,frame+i,1,receive,&frames);
    assert(frames==before+1);
    cp_usb_frame_feed(&p,frame,n,receive,&frames);cp_usb_frame_feed(&p,frame,n,receive,&frames);
    assert(frames==before+3);
    cp_usb_frame_feed(&p,frame,n-3,receive,&frames);cp_usb_frame_feed(&p,frame,n,receive,&frames);
    assert(frames==before+4&&p.malformed_frames==1);assert_clear(&p);
}
static void bounds_and_resync(void)
{
    cp_usb_frame_parser_t p;cp_usb_frame_init(&p);uint8_t frame[CP_USB_FRAME_MAX],max_json[CP_USB_JSON_MAX+1];
    memcpy(max_json,"{\"x\":\"",6);memset(max_json+6,'a',CP_USB_JSON_MAX-8);memcpy(max_json+CP_USB_JSON_MAX-2,"\"}",2);max_json[CP_USB_JSON_MAX]=0;
    size_t n=0;assert(cp_usb_frame_encode(ID,max_json,CP_USB_JSON_MAX,frame,sizeof frame,&n)&&n==CP_USB_FRAME_MAX);
    unsigned before=frames;cp_usb_frame_feed(&p,frame,n,receive,&frames);assert(frames==before+1&&received_length==1024);assert_clear(&p);
    assert(!cp_usb_frame_encode(ID,max_json,1025,frame,sizeof frame,&n)&&!n);
    assert(!cp_usb_frame_encode(ID,max_json,1024,frame,sizeof frame-1,&n)&&!n);
    uint8_t oversized[CP_USB_FRAME_MAX+2];size_t good=encode("{}",frame),header=good-3;
    memcpy(oversized,frame,header);memset(oversized+header,'a',1025);oversized[header+1025]='\n';
    cp_usb_frame_feed(&p,oversized,header+1026,receive,&frames);assert(frames==before+1);assert_clear(&p);
    good=encode("{\"v\":1,\"op\":\"status\"}",frame);cp_usb_frame_feed(&p,frame,good,receive,&frames);assert(frames==before+2);
    frame[sizeof(CP_USB_PREFIX)-1]='A';cp_usb_frame_feed(&p,frame,good,receive,&frames);assert(frames==before+2);
    const uint8_t invalid[]={0xc0,0x80};assert(!cp_usb_utf8_valid(invalid,sizeof invalid));
    const uint8_t surrogate[]={0xed,0xa0,0x80};assert(!cp_usb_utf8_valid(surrogate,sizeof surrogate));
    const uint8_t utf8[]={0xe6,0xa0,0xa1,0xf0,0x9f,0x93,0xb6};assert(cp_usb_utf8_valid(utf8,sizeof utf8));
    assert(!cp_usb_uuid_v4("12345678-1234-1234-8234-123456789abc"));
    assert(!cp_usb_uuid_v4("12345678-1234-4234-7234-123456789abc"));
    cp_usb_frame_feed(&p,CP_USB_PREFIX,sizeof(CP_USB_PREFIX)-1,receive,&frames);cp_usb_frame_clear(&p);assert_clear(&p);
}
static void control(const char *request,char out[CP_USB_JSON_MAX+1])
{size_t n=0;memset(out,0,CP_USB_JSON_MAX+1);assert(cp_usb_control(begin,&begins,exchange,(const uint8_t*)request,strlen(request),(uint8_t*)out,CP_USB_JSON_MAX,&n)==ESP_OK);out[n]=0;}
static void controller(void)
{
    char out[CP_USB_JSON_MAX+1];unsigned previous=begins;
    control("{\"v\":1,\"op\":\"begin\"}",out);assert(begins==previous+1&&!exchanges&&strstr(out,"starting"));
    begin_allowed=false;control("{\"v\":1,\"op\":\"begin\"}",out);assert(strstr(out,"supervisor_busy"));begin_allowed=true;
    previous=begins;
    const char *invalid[]={"{\"v\":1,\"v\":1,\"op\":\"begin\"}","{\"v\":1,\"op\":\"begin\\u0000tail\"}",
        "{\"v\":1,\"op\":\"begin\",\"password\":\"do-not-reflect\"}","{\"v\":2,\"op\":\"begin\"}","[]","{\"v\":1,\"op\":\"erase_flash\"}","{\"v\":1,\"op\":[[[]]]}"};
    for(unsigned i=0;i<sizeof invalid/sizeof invalid[0];++i){control(invalid[i],out);assert(begins==previous&&!exchanges&&strstr(out,"false")&&!strstr(out,"do-not-reflect"));}
    exchange_reply="{\"v\":1,\"ok\":false,\"reason\":\"setup_not_ready\"}";
    control("{\"v\":1,\"op\":\"info\"}",out);assert(exchanges==1&&strstr(out,"setup_not_ready"));
    exchange_reply="{\"v\":1,\"ok\":true,\"state\":\"testing\"}";
    control("{\"v\":1,\"op\":\"status\"}",out);assert(exchanges==2&&strstr(out,"testing"));
    const char *configure="{\"v\":1,\"op\":\"configure\",\"password\":\"synthetic-private-password\",\"device_token\":\"synthetic-private-token\"}";
    exchange_reply="{\"v\":1,\"ok\":true,\"state\":\"received\"}";control(configure,out);
    assert(exchanges==3&&!strcmp((char*)received_json,configure)&&!strstr(out,"private"));
    exchange_error=ESP_ERR_NO_MEM;control("{\"v\":1,\"op\":\"status\"}",out);assert(strstr(out,"service_unavailable"));
}
int main(void){split_and_noise();bounds_and_resync();controller();puts("USB framing/controller: split/noise/resync/bounds/UTF8/explicit begin/error and secret isolation passed");}
