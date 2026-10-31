#include "runtime_registration.h"
#include <assert.h>
#include <stdio.h>
#include <string.h>

typedef struct {
    const void *body;
    char frozen[128];
    size_t bytes;
    unsigned attempts, waits, success_at;
    bool retryable, stop_now, stop_after_attempt, stop_in_wait;
    uint32_t waited_ms;
} fake_t;
static bool stopped(void *ctx) { return ((fake_t *)ctx)->stop_now; }
static bool attempt(void *ctx,const void *body,size_t bytes,unsigned index,bool *retryable) {
    fake_t *f=ctx;
    assert(body==f->body&&bytes==f->bytes&&!memcmp(body,f->frozen,bytes));
    assert(index==f->attempts++);
    *retryable=f->retryable;
    if(f->stop_after_attempt)f->stop_now=true;
    return f->success_at&&f->attempts==f->success_at;
}
static bool wait_ms(void *ctx,uint32_t delay) {
    fake_t *f=ctx;assert(delay==++f->waits*1000);f->waited_ms+=delay;
    if(f->stop_in_wait){f->stop_now=true;return false;}return true;
}
static fake_t make(const char *body) {
    fake_t f={.body=body,.bytes=strlen(body),.retryable=true};
    memcpy(f.frozen,body,f.bytes);return f;
}
static bool run(fake_t *f) {
    edge_registration_io_t io={f,stopped,attempt,wait_ms};
    return edge_registration_exchange(&io,f->body,f->bytes);
}
int main(void) {
    assert(edge_request_timeout_ms(CP_API_ORIGIN)==30000);
    const char *isolated[]={NULL,"","https://192.168.1.2:8799","https://isolated.example",
        CP_API_ORIGIN ":443",CP_API_ORIGIN ":8443",CP_API_ORIGIN "/","https://test.pulse.anend.net"};
    for(size_t i=0;i<sizeof isolated/sizeof *isolated;i++)assert(edge_request_timeout_ms(isolated[i])==15000);
    const int retryable[]={200,201,204,299,408,425,429,500,503,599};
    const int terminal[]={0,199,300,301,307,400,401,403,404,409,422,499,600};
    for(size_t i=0;i<sizeof retryable/sizeof *retryable;i++)assert(edge_parsed_http_retryable(retryable[i]));
    for(size_t i=0;i<sizeof terminal/sizeof *terminal;i++)assert(!edge_parsed_http_retryable(terminal[i]));
    const char body[]="{\"registration_seq\":1,\"uptime_ms\":100,\"capabilities\":{\"synthetic\":true}}";
    fake_t f=make(body);f.success_at=3;
    assert(run(&f)&&f.attempts==3&&f.waits==2&&f.waited_ms==3000);
    assert(!memcmp(body,f.frozen,f.bytes));
    f=make(body);assert(!run(&f)&&f.attempts==3&&f.waits==2);
    f=make(body);f.retryable=false;assert(!run(&f)&&f.attempts==1&&!f.waits);
    /* A complete503/429 with explicit retryable:false must not be promoted by
     * its status to a second registration POST. Terminal4xx wins even when a
     * body claims retryable:true. */
    f=make(body);f.retryable=edge_http_response_retryable(503,false);assert(!run(&f)&&f.attempts==1&&!f.waits);
    f=make(body);f.retryable=edge_http_response_retryable(429,false);assert(!run(&f)&&f.attempts==1&&!f.waits);
    f=make(body);f.retryable=edge_http_response_retryable(409,true);assert(!run(&f)&&f.attempts==1&&!f.waits);
    f=make(body);f.success_at=1;assert(run(&f)&&f.attempts==1&&!f.waits);
    f=make(body);f.stop_now=true;assert(!run(&f)&&!f.attempts&&!f.waits);
    f=make(body);f.stop_after_attempt=true;assert(!run(&f)&&f.attempts==1&&!f.waits);
    f=make(body);f.stop_in_wait=true;assert(!run(&f)&&f.attempts==1&&f.waits==1);
    edge_registration_io_t io={&f,stopped,attempt,wait_ms};
    assert(!edge_registration_exchange(NULL,body,sizeof body));
    assert(!edge_registration_exchange(&io,NULL,sizeof body));
    assert(!edge_registration_exchange(&io,body,0));
    io.wait=NULL;assert(!edge_registration_exchange(&io,body,sizeof body));
    puts("Frozen registration retry bounds, identity preservation and stop/terminal failures passed");
    return 0;
}
