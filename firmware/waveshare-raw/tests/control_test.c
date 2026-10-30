#include "raw_control.h"
#include <assert.h>
#include <stddef.h>
#include <stdint.h>
#include <string.h>

static raw_command_t line(raw_control_t *p, const char *s) {
    raw_command_t result = RAW_COMMAND_NONE;
    for (; *s; ++s) {
        raw_command_t cmd = raw_control_command(p, (uint8_t)*s);
        if (cmd != RAW_COMMAND_NONE) { assert(result == RAW_COMMAND_NONE); result = cmd; }
    }
    return result;
}
int main(void) {
    raw_control_t p;
    raw_control_init(&p);
    assert(line(&p, "ST") == RAW_COMMAND_NONE);
    assert(line(&p, "OP\r\n") == RAW_COMMAND_STOP);
    assert(line(&p, "PAGE\n") == RAW_COMMAND_PAGE);
    assert(line(&p, "FILES\r\n") == RAW_COMMAND_FILES);
    assert(line(&p, "CLOSE\n") == RAW_COMMAND_CLOSE);
    assert(line(&p, "REA") == RAW_COMMAND_NONE);
    assert(line(&p, "D 4294967295 ") == RAW_COMMAND_NONE);
    assert(line(&p, "4294967295\r\n") == RAW_COMMAND_READ);
    assert(p.file_index == UINT32_MAX && p.file_offset == UINT32_MAX && !p.utc_epoch);
    assert(line(&p, "TIME 18446744073709551615\n") == RAW_COMMAND_TIME);
    assert(p.utc_epoch == UINT64_MAX && !p.file_index && !p.file_offset);
    assert(line(&p, "READ 0 0\n") == RAW_COMMAND_READ);
    assert(!p.file_index && !p.file_offset && !p.utc_epoch);
    assert(line(&p, "TIME 0\n") == RAW_COMMAND_TIME && !p.utc_epoch);
    const char *bad[] = {"READ 4294967296 0\n", "READ 0 4294967296\n", "TIME 18446744073709551616\n",
        "READ -1 0\n", "READ 1 -1\n", "TIME -1\n", "READ +1 0\n", "TIME +1\n",
        "READ  1 0\n", "READ 1  0\n", "READ 1 0 \n", "READ 1 0x\n", "READ 1\n",
        "READ 1 \n", "READ  0\n", "TIME \n", "TIME 1 0\n", " TIME 1\n", "FILES \n", "CLOSEX\n"};
    for (size_t i = 0; i < sizeof(bad) / sizeof(bad[0]); ++i) {
        assert(line(&p, bad[i]) == RAW_COMMAND_NONE);
        assert(!p.file_index && !p.file_offset && !p.utc_epoch);
    }
    assert(line(&p, "12345678901234567890123456789012345678901234567890123456789012345STOP\n") == RAW_COMMAND_NONE);
    assert(line(&p, "FILES\n") == RAW_COMMAND_FILES);
    assert(line(&p, "\r\n\n\rstop\nSTOP \n STOP\nSTOPX\n") == RAW_COMMAND_NONE);
    assert(line(&p, "ST") == RAW_COMMAND_NONE);
    raw_control_init(&p);
    assert(line(&p, "OP\n") == RAW_COMMAND_NONE);
    assert(!raw_control_feed(NULL, '\n'));
    raw_control_init(NULL);
    for (const char *s = "STOP\n"; *s; s++) {
        bool found = raw_control_feed(&p, (uint8_t)*s);
        assert(found == (*s == '\n'));
    }
    return 0;
}
