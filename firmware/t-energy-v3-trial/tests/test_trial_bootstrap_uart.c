/* In-memory synthetic stdin and discarded output: no serial/device IO. Compile
 * the actual production wait loop, including line framing and cleanup. */
#include "trial_bootstrap.h"
#include <assert.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

static const char json[] = "{\"node_id\":\"te-test\",\"boot_id\":\"boot-test\",\"origin\":\"https://trial.invalid\",\"uplink_transport\":\"https\",\"device_token\":\"synthetic-token\",\"ssid\":\"test-net\",\"password\":\"test-pass\",\"utc_ms\":1800000000000,\"uncertainty_ms\":10,\"max_windows\":1,\"security\":\"personal\",\"anchor_mono_ms\":1000}";
static const char *input;
static size_t offset, input_length;
static unsigned errors, accepted, delays;
int64_t esp_timer_get_time(void) { return 1100000; }
void vTaskDelay(unsigned ticks) { (void)ticks; ++delays; }
ssize_t bootstrap_test_read(int fd, void *data, size_t n) {
    assert(fd == STDIN_FILENO && n == 1);
    if (offset == input_length) return 0;
    *(unsigned char *)data = (unsigned char)input[offset++]; return 1;
}
int bootstrap_test_puts(const char *text) {
    /* Production messages may contain neither credentials nor the CA. */
    assert(!strstr(text,"test-pass") && !strstr(text,"synthetic-token") && !strstr(text,"CERTIFICATE"));
    if (!strcmp(text,"V3 ERR BOOTSTRAP")) ++errors;
    if (!strcmp(text,"V3 START ACCEPTED")) ++accepted;
    return 0;
}
int bootstrap_test_printf(const char *format, ...) { (void)format; return 0; }
int bootstrap_test_fflush(FILE *file) { (void)file; return 0; }
static bool cancelled(void) { return offset == input_length; }
static bool zero(const void *data, size_t size) {
    const unsigned char *p = data;
    while (size--) if (*p++) return false;
    return true;
}
static void run(const char *bytes, bool ok, unsigned expected_errors) {
    input = bytes; offset = 0; input_length = strlen(bytes); errors = accepted = delays = 0;
    trial_bootstrap_t out; memset(&out,0xa5,sizeof out);
    esp_err_t result = trial_bootstrap_wait("te-test","boot-test",&out,cancelled);
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
    fputs("trial bootstrap UART framing tests passed (memory IO only)\n",stdout);
    return 0;
}
