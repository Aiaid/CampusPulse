#include <assert.h>
#include <stdatomic.h>
#include <stdio.h>
#include <stdint.h>
#include <string.h>
#include <errno.h>
#include <unistd.h>
#include <fcntl.h>
#include <sys/stat.h>
static char test_dir[128];
static _Atomic int fault;
static int test_sync(int);
static int test_close(FILE *);
static size_t test_write(const void *,size_t,size_t,FILE *);
static size_t test_read(void *,size_t,size_t,FILE *);
static int test_open(const char *,int,...);
static int test_unlink(const char *);
#define LOCAL_RAW_DIRECTORY test_dir
#define fsync test_sync
#define fclose test_close
#define fwrite test_write
#define fread test_read
#define open test_open
#define unlink test_unlink
#include "../main/local_raw.c"
#undef fsync
#undef fclose
#undef fwrite
#undef fread
#undef open
#undef unlink
#include <stdarg.h>
static uint64_t free_space=UINT64_C(1)<<30;
esp_err_t raw_storage_space(uint64_t *out){*out=free_space;return atomic_load(&fault)==6?ESP_FAIL:ESP_OK;}
static int test_sync(int fd){if(atomic_load(&fault)==1){errno=EIO;return -1;}return fsync(fd);}
static int test_close(FILE *f){int result=fclose(f);if(atomic_load(&fault)==3){errno=EIO;return EOF;}return result;}
static size_t test_write(const void *p,size_t size,size_t n,FILE *f){if(atomic_load(&fault)==2&&n>1){errno=EIO;return fwrite(p,size,n-1,f);}return fwrite(p,size,n,f);}
static size_t test_read(void *p,size_t size,size_t n,FILE *f){if(atomic_load(&fault)==10&&n>1)return fread(p,size,n-1,f);return fread(p,size,n,f);}
static int test_open(const char *path,int flags,...){va_list args;va_start(args,flags);int mode=va_arg(args,int);va_end(args);if(atomic_load(&fault)==7&&strstr(path,"/.probe-")){errno=EACCES;return -1;}return open(path,flags,mode);}
static int test_unlink(const char *path){if(atomic_load(&fault)==8){errno=EIO;return -1;}return unlink(path);}
static bool media_sync(void *ctx){(void)ctx;return atomic_load(&fault)!=5;}
static bool clock_at(void *ctx,uint64_t mono,cp_v3_temporal_time_t *out){(void)ctx;*out=(cp_v3_temporal_time_t){.mono_ms=mono,.utc_ms=1704067200123ULL,.clock_epoch=1,.uncertainty_ms=123,.utc_known=true};return true;}
static local_raw_config_t config={.max_segment_bytes=2048,.max_total_bytes=65536,.min_free_bytes=1048576,.sync_ms=100};
static const char boot[]="12345678-1234-4123-8123-123456789abc";
static uint8_t session[16]={1,2,3,4};
static StaticSemaphore_t tf_memory;
typedef struct {uint64_t remaining,charged;unsigned calls,denied;} budget_fixture_t;
static bool budget_charge(void *context,uint64_t bytes){budget_fixture_t *b=context;assert(bytes&&xSemaphoreTake(&tf_memory,0)==pdFALSE);b->calls++;if(bytes>b->remaining){b->denied++;return false;}b->remaining-=bytes;b->charged+=bytes;return true;}
static cp_v3_stats_report_t report(uint64_t seq){cp_v3_stats_report_t r={.seq=seq,.mono_us=123456789+seq,.rssi=-61,.tx_power=127,.sid=255,.primary_phy=1};r.address[0]=0x12;r.address[5]=0x34;return r;}
static void release(local_raw_t *s){/* Fault tests inspect latch first; reset only test-owned state to join/free. */
    atomic_store(&fault,0);portENTER_CRITICAL(&s->mux);s->status.last_error=ESP_OK;s->status.io_failed_latched=false;portEXIT_CRITICAL(&s->mux);
    assert(local_raw_release(s,2000)==ESP_OK);
}
static unsigned files(void){DIR *d=opendir(test_dir);assert(d);unsigned n=0;struct dirent *e;while((e=readdir(d)))if(strcmp(e->d_name,".")&&strcmp(e->d_name,".."))n++;closedir(d);return n;}
int main(int argc,char **argv){
    assert(argc==3&&strlen(argv[1])<sizeof test_dir);strcpy(test_dir,argv[1]);
    SemaphoreHandle_t tf=xSemaphoreCreateMutexStatic(&tf_memory);local_raw_t *s=NULL;
    if(!strcmp(argv[2],"quota")||!strcmp(argv[2],"invalid_file")||!strcmp(argv[2],"probe_existing")||!strcmp(argv[2],"budget_existing")){
        assert(!mkdir(test_dir,0700));char path[192];snprintf(path,sizeof path,"%s/existing.bin",test_dir);FILE *f=fopen(path,"wb");assert(f);
        if(!strcmp(argv[2],"invalid_file")){assert(fwrite("bad",1,3,f)==3);}
        else {uint8_t bytes[RAW_FRAME_MAX];assert(fwrite(bytes,1,raw_encode_header(bytes,sizeof bytes,session),f)==32);if(strcmp(argv[2],"probe_existing")&&strcmp(argv[2],"budget_existing")){raw_report_t r={.seq=1,.length=1650};size_t n=raw_encode_report(bytes,sizeof bytes,&r);assert(n==1705&&fwrite(bytes,1,n,f)==n);r.seq=2;r.length=256;n=raw_encode_report(bytes,sizeof bytes,&r);assert(n==311&&fwrite(bytes,1,n,f)==n);}}
        assert(!fclose(f));
    }
    struct stat before;bool existed=!stat(test_dir,&before);
    assert(local_raw_prepare(tf,media_sync,NULL,&s)==ESP_OK&&s);
    assert((!stat(test_dir,&before))==existed); /*prepare never touches disk. */
    assert(local_raw_psram_bytes()==64*sizeof(raw_report_t)&&local_raw_memory_bytes()>local_raw_psram_bytes()+8192);
    assert(local_raw_set_clock(s,clock_at,NULL,RAW_CLOCK_HOST_CALIBRATED_RTC,false)==ESP_OK);
    local_raw_status_t status;local_raw_snapshot(s,&status);assert(status.safe_to_unmount&&!status.active&&status.free_slots==64);
    if(!strncmp(argv[2],"verify_",7)){
        budget_fixture_t b={.remaining=100000};local_raw_verify_summary_t summary={1,2,3,4};
        assert(local_raw_set_budget(s,budget_charge,&b)==ESP_OK);
        assert(local_raw_verify_closed(s,&summary)==ESP_ERR_NOT_FOUND&&!summary.files&&!summary.reports&&!summary.bytes&&!summary.anchors&&!b.calls);
        assert(stat(test_dir,&before)!=0&&errno==ENOENT);config.sync_ms=60000;
        assert(local_raw_start(s,&config,boot,session)==ESP_OK);unsigned charged=b.calls;
        summary=(local_raw_verify_summary_t){1,2,3,4};assert(local_raw_verify_closed(s,&summary)==ESP_ERR_INVALID_STATE&&!summary.files&&!summary.reports&&!summary.bytes&&!summary.anchors&&b.calls==charged);
        cp_v3_stats_report_t r=report(1);assert(local_raw_hook(s,&r));assert(local_raw_stop(s,3000)==ESP_OK);b.remaining=0;
        DIR *dir=opendir(test_dir);assert(dir);struct dirent *e;
        char path[sizeof(test_dir)+sizeof(e->d_name)+1]={0};
        while((e=readdir(dir)))if(strcmp(e->d_name,".")&&strcmp(e->d_name,"..")){
            int length=snprintf(path,sizeof path,"%s/%s",test_dir,e->d_name);
            assert(length>=0&&(size_t)length<sizeof path);
            break;
        }
        assert(!closedir(dir)&&path[0]);
        if(!strcmp(argv[2],"verify_crc")){FILE *f=fopen(path,"r+b");assert(f&&!fseek(f,40,SEEK_SET));int c=fgetc(f);assert(c!=EOF&&!fseek(f,40,SEEK_SET)&&fputc(c^1,f)!=EOF&&!fclose(f));}
        uint8_t original[2048],after[2048];FILE *f=fopen(path,"rb");assert(f);size_t bytes=fread(original,1,sizeof original,f);assert(bytes&&!fclose(f));
        charged=b.calls;local_raw_status_t previous;local_raw_snapshot(s,&previous);
        if(!strcmp(argv[2],"verify_short"))atomic_store(&fault,10);
        esp_err_t verified=local_raw_verify_closed(s,&summary);
        if(!strcmp(argv[2],"verify_crc")||!strcmp(argv[2],"verify_short"))assert(verified==ESP_ERR_INVALID_RESPONSE&&!summary.files&&!summary.reports&&!summary.bytes&&!summary.anchors);
        else assert(verified==ESP_OK&&summary.files==1&&summary.reports==1&&summary.bytes==bytes&&!summary.anchors);
        atomic_store(&fault,0);assert(b.calls==charged&&files()==1);local_raw_snapshot(s,&status);assert(!memcmp(&status,&previous,sizeof status));
        f=fopen(path,"rb");assert(f);size_t n=fread(after,1,sizeof after,f);assert(!fclose(f)&&n==bytes&&!memcmp(original,after,n));
        if(!strcmp(argv[2],"verify_short"))assert(local_raw_verify_closed(s,&summary)==ESP_OK&&summary.reports==1&&b.calls==charged);
        release(s);return 0;
    }
    if(!strncmp(argv[2],"budget_",7)){
        budget_fixture_t b={0};config.sync_ms=60000;
        if(!strcmp(argv[2],"budget_probe_cleanup"))b.remaining=DIRECTORY_METADATA+PROBE_TRANSACTION;
        else if(!strcmp(argv[2],"budget_stop"))b.remaining=DIRECTORY_METADATA+OPEN_METADATA+CLOSE_METADATA+RAW_HEADER_SIZE+TAIL_RESERVE;
        else if(!strcmp(argv[2],"budget_mid")||!strcmp(argv[2],"budget_sync"))b.remaining=DIRECTORY_METADATA+OPEN_METADATA+CLOSE_METADATA+RAW_HEADER_SIZE+TAIL_RESERVE+55;
        if(!strcmp(argv[2],"budget_sync"))config.sync_ms=100;
        assert(local_raw_set_budget(s,budget_charge,&b)==ESP_OK);
        if(!strcmp(argv[2],"budget_probe")){
            assert(local_raw_probe(s,&config,&status)==LOCAL_RAW_ERR_BUDGET&&status.reason==LOCAL_RAW_BUDGET&&status.safe_to_unmount&&!status.io_failed_latched);
            assert(stat(test_dir,&before)!=0&&errno==ENOENT&&!b.charged&&b.denied==1);
            assert(local_raw_start(s,&config,boot,session)==LOCAL_RAW_ERR_BUDGET);local_raw_snapshot(s,&status);assert(status.counters[5]==2&&status.safe_to_unmount&&!status.counters[4]);
        }else if(!strcmp(argv[2],"budget_probe_cleanup")){
            assert(local_raw_probe(s,&config,&status)==ESP_OK&&status.safe_to_unmount&&files()==0&&!b.remaining);
            assert(local_raw_start(s,&config,boot,session)==LOCAL_RAW_ERR_BUDGET);local_raw_snapshot(s,&status);assert(status.reason==LOCAL_RAW_BUDGET&&status.safe_to_unmount&&files()==0&&b.denied==1);
        }else if(!strcmp(argv[2],"budget_existing")){
            assert(local_raw_probe(s,&config,&status)==LOCAL_RAW_ERR_BUDGET&&status.managed_bytes==32&&files()==1&&b.calls==1&&!b.charged);
            assert(local_raw_start(s,&config,boot,session)==LOCAL_RAW_ERR_BUDGET&&files()==1&&b.calls==2);
        }else{
            assert(local_raw_start(s,&config,boot,session)==ESP_OK);
            assert(local_raw_set_budget(s,budget_charge,&b)==ESP_ERR_INVALID_STATE);
            if(!strcmp(argv[2],"budget_mid")){cp_v3_stats_report_t r=report(1);assert(local_raw_hook(s,&r));r.seq=2;assert(local_raw_hook(s,&r));assert(local_raw_stop(s,3000)==LOCAL_RAW_ERR_BUDGET);local_raw_snapshot(s,&status);assert(status.counters[0]==2&&status.counters[1]==1&&status.counters[2]==1&&status.counters[3]==1&&status.counters[5]==1&&!status.counters[4]&&b.calls==4&&b.denied==1);}
            else if(!strcmp(argv[2],"budget_sync")){cp_v3_stats_report_t r=report(1);assert(local_raw_hook(s,&r));for(unsigned i=0;i<200;i++){local_raw_snapshot(s,&status);if(!status.writer_running)break;vTaskDelay(10);}assert(local_raw_stop(s,3000)==LOCAL_RAW_ERR_BUDGET);local_raw_snapshot(s,&status);assert(status.counters[0]==1&&status.counters[1]==1&&status.counters[2]==1&&!status.counters[3]&&status.counters[5]==1&&!status.counters[4]&&b.calls==4&&b.denied==1);}
            else {assert(local_raw_stop(s,3000)==ESP_OK);local_raw_snapshot(s,&status);assert(b.calls==2&&!b.remaining&&!b.denied);}
            assert(status.safe_to_unmount&&!status.io_failed_latched&&!status.active);
        }
        release(s);return 0;
    }
    if(!strncmp(argv[2],"probe_",6)){
        bool existing=!strcmp(argv[2],"probe_existing");
        int mode=!strcmp(argv[2],"probe_partial")?2:!strcmp(argv[2],"probe_fsync")?1:!strcmp(argv[2],"probe_close")?3:
            !strcmp(argv[2],"probe_media")?5:!strcmp(argv[2],"probe_metadata")?6:!strcmp(argv[2],"probe_writable")?7:!strcmp(argv[2],"probe_unlink")?8:0;
        atomic_store(&fault,mode);
        esp_err_t result=local_raw_probe(s,&config,&status);
        assert(!status.active&&!status.writer_running&&status.free_slots==64&&!status.counters[0]&&!status.counters[1]&&!status.counters[2]);
        if(mode){
            assert(result!=ESP_OK&&status.counters[4]==1);
            if(mode==6||mode==7){assert(status.safe_to_unmount&&!status.io_failed_latched);atomic_store(&fault,0);assert(local_raw_probe(s,&config,&status)==ESP_OK&&status.safe_to_unmount&&status.counters[4]==1);}
            else {assert(status.io_failed_latched&&!status.safe_to_unmount);assert(local_raw_probe(s,&config,NULL)==ESP_ERR_INVALID_STATE);}
        }else{
            assert(result==ESP_OK&&status.safe_to_unmount&&!status.io_failed_latched&&status.managed_bytes==(existing?32u:0u));
            assert(local_raw_probe(s,&config,NULL)==ESP_OK);assert(files()==(existing?1u:0u));
            config.sync_ms=99;assert(local_raw_probe(s,&config,&status)==ESP_ERR_INVALID_ARG&&status.safe_to_unmount);config.sync_ms=100;
        }
        release(s);return 0;
    }
    if(!strcmp(argv[2],"quota")){config.max_total_bytes=2048;assert(local_raw_probe(s,&config,&status)==RAW_STORAGE_ERR_FULL&&status.counters[5]==1&&status.safe_to_unmount);assert(local_raw_start(s,&config,boot,session)==RAW_STORAGE_ERR_FULL);local_raw_snapshot(s,&status);assert(status.reason==LOCAL_RAW_QUOTA&&status.counters[5]==2&&status.managed_bytes==2048&&files()==1&&status.safe_to_unmount);release(s);return 0;}
    if(!strcmp(argv[2],"invalid_file")){assert(local_raw_probe(s,&config,&status)==ESP_ERR_INVALID_RESPONSE&&status.counters[4]==1&&status.safe_to_unmount&&!status.io_failed_latched);assert(local_raw_start(s,&config,boot,session)==ESP_ERR_INVALID_RESPONSE);local_raw_snapshot(s,&status);assert(status.reason==LOCAL_RAW_DIRECTORY_ERROR&&status.counters[4]==2&&files()==1&&status.safe_to_unmount);release(s);return 0;}
    if(!strcmp(argv[2],"space")){free_space=config.min_free_bytes+65535;assert(local_raw_probe(s,&config,&status)==RAW_STORAGE_ERR_FULL&&status.counters[5]==1&&status.safe_to_unmount);assert(local_raw_start(s,&config,boot,session)==RAW_STORAGE_ERR_FULL);local_raw_snapshot(s,&status);assert(status.reason==LOCAL_RAW_LOW_SPACE&&status.counters[5]==2&&!status.io_failed_latched&&files()==0);release(s);return 0;}
    assert(local_raw_probe(s,&config,NULL)==ESP_OK);
    assert(local_raw_start(s,&config,boot,session)==ESP_OK);
    assert(local_raw_probe(s,&config,NULL)==ESP_ERR_INVALID_STATE);
    assert(local_raw_set_clock(s,clock_at,NULL,RAW_CLOCK_HOST_CALIBRATED_RTC,true)==ESP_ERR_INVALID_STATE);
    if(!strcmp(argv[2],"normal")){
        uint8_t legacy[3]={2,1,6},extended[1650];for(unsigned i=0;i<sizeof extended;i++)extended[i]=(uint8_t)(i*11u);
        cp_v3_stats_report_t r=report(111);r.payload=legacy;r.length=3;assert(local_raw_hook(s,&r));memset(legacy,0xee,sizeof legacy);
        r=report(333);r.kind=1;r.payload=extended;r.length=sizeof extended;r.props=0x85;r.data_status=2;r.sid=15;r.primary_phy=3;r.secondary_phy=2;r.periodic_interval=765;r.direct_address_type=1;r.direct_address[0]=0xab;r.direct_address[5]=0xcd;r.rssi=-128;r.tx_power=9;assert(local_raw_hook(s,&r));
        r.seq=444;assert(local_raw_hook(s,&r));memset(extended,0xee,sizeof extended);
        assert(local_raw_stop(s,3000)==ESP_OK);local_raw_snapshot(s,&status);
        assert(status.safe_to_unmount&&!status.active&&status.counters[0]==3&&status.counters[1]==3&&status.counters[2]==3&&status.counters[3]==0&&status.free_slots==64&&status.clock_anchors==0&&files()==2);
        assert(local_raw_set_clock(s,clock_at,NULL,RAW_CLOCK_HOST_CALIBRATED_RTC,true)==ESP_OK);
        assert(local_raw_start(s,&config,boot,session)==ESP_OK);r=report(555);assert(local_raw_hook(s,&r));assert(local_raw_stop(s,3000)==ESP_OK);local_raw_snapshot(s,&status);
        assert(status.counters[0]==4&&status.counters[1]==4&&status.counters[2]==4&&status.clock_anchors==1&&files()==3&&status.safe_to_unmount);
        local_raw_verify_summary_t summary;assert(local_raw_verify_closed(s,&summary)==ESP_OK&&summary.files==3&&summary.reports==4&&summary.anchors==1&&summary.bytes==status.managed_bytes);
    } else if(!strcmp(argv[2],"overflow")){
        xSemaphoreTake(tf,portMAX_DELAY);cp_v3_stats_report_t r=report(1);
        for(unsigned i=0;i<64;i++){r.seq=i+1;assert(local_raw_hook(s,&r));}
        assert(!local_raw_hook(s,&r));assert(local_raw_stop(s,5)==ESP_ERR_TIMEOUT);local_raw_snapshot(s,&status);assert(!status.safe_to_unmount&&status.writer_running&&status.counters[0]==64&&status.counters[3]==1);
        xSemaphoreGive(tf);assert(local_raw_stop(s,3000)==ESP_OK);local_raw_snapshot(s,&status);assert(status.counters[1]==64&&status.counters[2]==64&&status.safe_to_unmount&&status.free_slots==64);
    } else if(!strcmp(argv[2],"invalid_report")){
        cp_v3_stats_report_t r=report(1);r.rssi=200;assert(!local_raw_hook(s,&r));assert(local_raw_stop(s,3000)==ESP_ERR_INVALID_ARG);local_raw_snapshot(s,&status);assert(status.invalid_reports==1&&status.counters[4]==1&&status.counters[0]==0&&status.safe_to_unmount&&!status.io_failed_latched);
    } else {
        int mode=!strcmp(argv[2],"fsync")?1:!strcmp(argv[2],"partial")?2:!strcmp(argv[2],"close")?3:!strcmp(argv[2],"media")?5:6;atomic_store(&fault,mode);
        cp_v3_stats_report_t r=report(1);assert(local_raw_hook(s,&r));assert(local_raw_stop(s,3000)!=ESP_OK);local_raw_snapshot(s,&status);
        assert(status.io_failed_latched&&!status.safe_to_unmount&&!status.active&&status.counters[4]==1&&status.counters[2]<=status.counters[1]&&status.counters[1]<=status.counters[0]);
        assert(local_raw_start(s,&config,boot,session)==ESP_ERR_INVALID_STATE);
    }
    release(s);vSemaphoreDelete(tf);puts("local raw case passed");return 0;
}
