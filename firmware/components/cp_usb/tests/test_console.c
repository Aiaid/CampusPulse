#include <assert.h>
#include <setjmp.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "../usb_console.c"
static bool installed,vfs_driver,connected=true,fail_task;
static esp_err_t install_result;
static unsigned installs,uninstalls,writes,waits,begins,logs,reads,read_limit;
static uint8_t input[CP_USB_FRAME_MAX],last_write[CP_USB_FRAME_MAX];
static size_t input_size,input_pos,last_size;
static int64_t clock_us;
static void(*task_entry)(void*);static void *task_context;
static jmp_buf stop;
static bool queue_begin(void *context){assert(context==&begins);++begins;return true;}
int64_t esp_timer_get_time(void){return clock_us;}
esp_err_t usb_serial_jtag_driver_install(usb_serial_jtag_driver_config_t *config)
{assert(!installed&&config->tx_buffer_size>=CP_USB_FRAME_MAX&&config->rx_buffer_size>=CP_USB_FRAME_MAX);++installs;if(install_result==ESP_OK)installed=true;return install_result;}
esp_err_t usb_serial_jtag_driver_uninstall(void){assert(installed&&!vfs_driver);installed=false;++uninstalls;return ESP_OK;}
bool usb_serial_jtag_is_driver_installed(void){return installed;}
bool usb_serial_jtag_is_connected(void){return connected;}
void usb_serial_jtag_vfs_use_driver(void){assert(installed);vfs_driver=true;}
void usb_serial_jtag_vfs_use_nonblocking(void){vfs_driver=false;}
int usb_serial_jtag_read_bytes(void *out,uint32_t capacity,TickType_t wait)
{
    assert(installed&&vfs_driver&&capacity==128&&wait==100);
    if(reads++==read_limit)longjmp(stop,1);
    clock_us+=100000;
    size_t n=input_size-input_pos;if(n>17)n=17;
    if(n){memcpy(out,input+input_pos,n);input_pos+=n;}
    return (int)n;
}
int usb_serial_jtag_write_bytes(const void *bytes,size_t length,TickType_t wait)
{assert(installed&&vfs_driver&&wait==100&&length<=CP_USB_FRAME_MAX);++writes;memcpy(last_write,bytes,length);last_size=length;return (int)length;}
esp_err_t usb_serial_jtag_wait_tx_done(TickType_t wait){assert(wait==100);++waits;return ESP_OK;}
int xTaskCreate(void(*entry)(void*),const char*name,unsigned stack,void*ctx,unsigned priority,TaskHandle_t*out)
{assert(installed&&vfs_driver&&!strcmp(name,"cp_usb")&&stack==6144&&priority==3);if(fail_task)return 0;task_entry=entry;task_context=ctx;*out=&task_entry;return pdPASS;}
unsigned uxTaskGetStackHighWaterMark(TaskHandle_t handle){assert(!handle);return 4096;}
void cp_test_log(const char *tag,const char *format,unsigned value)
{assert(!strcmp(tag,"cp_usb")&&strstr(format,"stack")&&value==4096);++logs;}
esp_err_t cp_provision_usb_exchange(const uint8_t *request,size_t request_length,uint8_t **reply,size_t *length)
{
    assert(request_length&&request_length<=CP_USB_JSON_MAX&&request);
    const char*json="{\"v\":1,\"ok\":true,\"state\":\"testing\"}";
    *length=strlen(json);*reply=malloc(*length);assert(*reply);memcpy(*reply,json,*length);return ESP_OK;
}
static void run(unsigned rounds)
{assert(task_entry);reads=0;read_limit=rounds;if(!setjmp(stop))task_entry(task_context);}
static void load(const char *body)
{input_pos=0;assert(cp_usb_frame_encode("12345678-1234-4234-8234-123456789abc",(const uint8_t*)body,strlen(body),input,sizeof input,&input_size));}
static void clear_task_fixture(void)
{s_task=NULL;task_entry=NULL;installed=vfs_driver=false;s_begin=NULL;s_context=NULL;cp_usb_frame_clear(&s_parser);input_size=input_pos=0;}
int main(void)
{
    assert(cp_usb_start(NULL,NULL)==ESP_ERR_INVALID_ARG&&!installs);
    installed=true;assert(cp_usb_start(queue_begin,&begins)==ESP_ERR_INVALID_STATE);installed=false;
    install_result=ESP_ERR_NO_MEM;assert(cp_usb_start(queue_begin,&begins)==ESP_ERR_NO_MEM&&!installed&&!task_entry);
    install_result=ESP_OK;fail_task=true;assert(cp_usb_start(queue_begin,&begins)==ESP_ERR_NO_MEM&&!installed&&!vfs_driver&&uninstalls==1);
    fail_task=false;assert(cp_usb_start(queue_begin,&begins)==ESP_OK&&installed&&vfs_driver&&!begins);
    unsigned previous=installs;assert(cp_usb_start(queue_begin,&begins)==ESP_OK&&installs==previous);
    run(101);assert(!begins&&!writes&&logs==1); /* cable/console alone is not begin */
    load("{\"v\":1,\"op\":\"begin\"}");run(8);assert(begins==1&&writes==1&&waits==1);
    assert(last_write[0]==0x1e&&last_write[last_size-1]=='\n');
    last_write[last_size]=0;assert(strstr((char*)last_write,"starting"));
    load("{\"v\":1,\"op\":\"configure\",\"password\":\"synthetic-password\"}");run(12);
    last_write[last_size]=0;assert(writes==2&&waits==2&&!strstr((char*)last_write,"password")&&strstr((char*)last_write,"testing"));
    load("{\"v\":1,\"op\":\"configure\",\"password\":\"must-be-cleared\"}");input_size-=3;run(30);
    for(size_t i=0;i<sizeof s_parser.json;++i)assert(s_parser.json[i]==0);assert(writes==2);
    load("{\"v\":1,\"op\":\"status\"}");run(8);assert(writes==3&&begins==1);
    clear_task_fixture();puts("actual USB console: no auto begin, bounded whole-frame writes, timeout wipe, driver/task cleanup and stack sample passed");
}
