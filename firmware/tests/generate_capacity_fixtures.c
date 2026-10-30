#include "cJSON.h"
#include "cp_codec.h"
#include "capacity_fixture.h"
#include <stdio.h>
static unsigned ids, batch_count, summary_count, max_body, max_count;
static const char *output_directory;
static unsigned body_limit, item_limit;
static void uuid(char out[37]) {snprintf(out,37,"33333333-3333-4333-8333-%012u",++ids);}
static bool sink(void *context,const char *body,size_t length,const char *stream,unsigned count,bool control) {
    (void)context;(void)control;
    assert(length==strlen(body) && length<=body_limit && count<=item_limit && count<=128);
    char path[1024];int n=snprintf(path,sizeof path,"%s/batch-%03u.json",output_directory,++batch_count);
    assert(n>0 && (size_t)n<sizeof path);FILE *file=fopen(path,"wb");assert(file);
    assert(fwrite(body,1,length,file)==length && fclose(file)==0);
    if(!strcmp(stream,"address_summaries"))summary_count+=count;
    if(length>max_body)max_body=(unsigned)length;
    if(count>max_count)max_count=count;
    return true;
}
int main(int argc,char **argv) {
    assert(argc==6 && CP_COLLECT_ADDRESSES==512);
    output_directory=argv[1];body_limit=(unsigned)strtoul(argv[2],NULL,10);item_limit=(unsigned)strtoul(argv[3],NULL,10);
    assert((body_limit==4096||body_limit==8192) && (item_limit==16||item_limit==64||item_limit==128));
    unsigned window_ms=(unsigned)strtoul(argv[4],NULL,10),bin_ms=(unsigned)strtoul(argv[5],NULL,10);
    cp_collect_compact_t w=capacity_fixture_for(window_ms,bin_ms);
    size_t core_size=CP_COLLECT_ADDRESSES*sizeof *w.addresses,bin_size=CP_COLLECT_ADDRESSES*w.bin_count*sizeof *w.bins;
    void *original_cores=malloc(core_size),*original_bins=malloc(bin_size);assert(original_cores&&original_bins);
    memcpy(original_cores,w.addresses,core_size);memcpy(original_bins,w.bins,bin_size);
    cp_collect_state_t original_state=w.state;
    uint32_t seq=0;cp_codec_t c={.node_id="cp_020000000001",.boot_id="11111111-1111-4111-8111-111111111111",
        .placement_id="fixture-placement-v2",.config_id="fixture-capacity-512",.dataset="controlled_test",
        .firmware_version="campuspulse-s3-capacity-fixture",.max_items=item_limit,.max_body_bytes=body_limit,
        .uncertainty_ms=UINT32_MAX,.summary_sequence=&seq,.uuid=uuid,.sink=sink};
    cp_codec_window_view_t view=cp_codec_window_from_compact(&w);
    assert(cp_codec_encode_window_view(&c,&view,window_ms));
    assert(c.windows_committed==1&&c.summaries_committed==512&&summary_count==512&&seq==512);
    assert(!c.failed_items&&!c.failed_batches&&!c.summaries_dropped);
    assert(!memcmp(original_cores,w.addresses,core_size)&&!memcmp(original_bins,w.bins,bin_size));
    assert(!memcmp(&original_state,&w.state,sizeof original_state));
    printf("512 codec: body=%u items=%u window=%u bin=%u: %u batches, max emitted body %u bytes / %u items; immutable input preserved\n",
           body_limit,item_limit,window_ms,bin_ms,batch_count,max_body,max_count);
    free(original_bins);free(original_cores);free(w.bins);free(w.addresses);return 0;
}
