/* In-memory synthetic stdin and discarded output: no serial/device IO. Compile
 * the actual production wait loop, including line framing and cleanup. */
#include "trial_bootstrap.h"
#include "cp_v3_saved_credentials.h"
#include <stdarg.h>
#include <assert.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

static const char json[] = "{\"node_id\":\"cp_001122334455\",\"boot_id\":\"boot-test\",\"origin\":\"https://trial.invalid\",\"uplink_transport\":\"https\",\"device_token\":\"synthetic-token-at-least-thirty-two-bytes\",\"ssid\":\"test-net\",\"password\":\"test-pass\",\"utc_ms\":1800000000000,\"uncertainty_ms\":10,\"max_windows\":1,\"security\":\"personal\",\"anchor_mono_ms\":1000}";
static const char *input;
static size_t offset, input_length;
static unsigned errors, accepted, delays;
static int64_t now=1100000;
int64_t esp_timer_get_time(void) { return now; }
void vTaskDelay(unsigned ticks) { now+=(int64_t)ticks*1000; ++delays; }
ssize_t bootstrap_test_read(int fd, void *data, size_t n) {
    assert(fd == STDIN_FILENO && n == 1);
    if (offset == input_length) return 0;
    *(unsigned char *)data = (unsigned char)input[offset++]; return 1;
}
int bootstrap_test_puts(const char *text) {
    /* Production messages may contain neither credentials nor the CA. */
    assert(!strstr(text,"test-pass") && !strstr(text,"synthetic-token-at-least-thirty-two-bytes") && !strstr(text,"CERTIFICATE"));
    if (!strcmp(text,"V3 ERR BOOTSTRAP")) ++errors;
    if (!strcmp(text,"V3 START ACCEPTED")) ++accepted;
    return 0;
}
void cp_v3_saved_credentials_load(const char *node,cp_v3_saved_credentials_t *saved){
    assert(!strcmp(node,"cp_001122334455"));cp_v3_saved_credentials_clear(saved);
    saved->credential_state=CP_V3_SAVED_READY;saved->mqtt_state=CP_V3_SAVED_MISSING;
    strcpy(saved->settings.device_token,"must-never-be-printed-saved-token");
}
int bootstrap_test_printf(const char *format, ...) {
    char output[1024];va_list args;va_start(args,format);int n=vsnprintf(output,sizeof output,format,args);va_end(args);
    assert(n>0&&n<(int)sizeof output&&!strstr(output,"must-never-be-printed")&&!strstr(output,"test-pass"));
    assert(strstr(output,"\"credential_state\":\"ready\"")&&strstr(output,"\"mqtt_state\":\"missing\""));return n;
}
int bootstrap_test_fflush(FILE *file) { (void)file; return 0; }
static bool cancelled(void) { return offset == input_length; }
static bool after_grace(void) { return delays>=10; }
static bool zero(const void *data, size_t size) {
    const unsigned char *p = data;
    while (size--) if (*p++) return false;
    return true;
}
static void run(const char *bytes, bool ok, unsigned expected_errors) {
    input = bytes; offset = 0; input_length = strlen(bytes); errors = accepted = delays = 0;
    trial_bootstrap_t out; memset(&out,0xa5,sizeof out);
    esp_err_t result = trial_bootstrap_wait("cp_001122334455","boot-test",&out,cancelled);
    assert(errors == expected_errors && !delays);
    if (ok) {
        assert(result == ESP_OK && accepted == 1);
        assert(!strcmp(out.settings.password,"test-pass"));
    } else {
        assert(result == ESP_ERR_INVALID_STATE && !accepted);
        assert(zero(&out,sizeof out));
    }
    trial_bootstrap_clear(&out); assert(zero(&out,sizeof out));
}
int main(void) {
    size_t length = strlen(json)+32;
    char *line = malloc(length); assert(line);
    snprintf(line,length,"V3START %s\n",json); run(line,true,0);
    snprintf(line,length,"V3START %s\r\n",json); run(line,true,0);
    snprintf(line,length,"V3START %s\r\r\n",json); run(line,false,1);
    snprintf(line,length,"V3START %s\r \n",json); run(line,false,1);
    snprintf(line,length,"V3START %s\r",json); run(line,false,0);
    snprintf(line,length,"V3START %s\n",json);
    char *password = strstr(line,"test-pass"); assert(password); password[4] = '\r'; run(line,false,1);
    snprintf(line,length,"V3START %s\n",json);
    line[3] = '\r'; run(line,false,1);
    /* A malformed record is drained completely before accepting the next. */
    char *recovery = malloc(length*2); assert(recovery);
    snprintf(recovery,length*2,"V3START %s\rX\nV3START %s\n",json,json); run(recovery,true,1); free(recovery);
    size_t maximum = TRIAL_BOOTSTRAP_LINE_MAX;
    char *boundary = calloc(maximum+3,1); assert(boundary);
    memcpy(boundary,"V3START ",8); memcpy(boundary+8,json,strlen(json));
    memset(boundary+8+strlen(json),' ',maximum-8-strlen(json)); boundary[maximum] = '\n'; run(boundary,true,0);
    boundary[maximum] = ' '; boundary[maximum+1] = '\n'; run(boundary,false,1);
    /* A cancelled partial line cannot contaminate the next invocation. */
    run("V3START {\"password\":\"test-pass",false,0);
    snprintf(line,length,"V3START %s\n",json); run(line,true,0);
    free(line); free(boundary);
    trial_bootstrap_t out;input="";offset=input_length=0;delays=0;
    assert(trial_bootstrap_wait_for("cp_001122334455","boot-test",&out,NULL,2)==ESP_ERR_TIMEOUT);assert(zero(&out,sizeof out));
    const char *setup[]={"HELLO 0123456789abcdef0123456789abcdef\n","SETUP\n"};
    for(unsigned i=0;i<2;i++){input=setup[i];offset=0;input_length=strlen(input);delays=0;
        assert(trial_bootstrap_wait_for("cp_001122334455","boot-test",&out,after_grace,2)==ESP_ERR_INVALID_STATE&&delays>=10);assert(zero(&out,sizeof out));}
    fputs("trial bootstrap UART framing tests passed (memory IO only)\n",stdout);
    return 0;
}
