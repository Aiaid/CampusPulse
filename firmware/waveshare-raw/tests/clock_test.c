/* Execute the production C implementation with a register-level I2C fake. */
#include <assert.h>
#include <stdio.h>
#include <string.h>
#include <time.h>
#include "../main/raw_clock.c"

static uint8_t registers[18];
static unsigned calls, fail_call, writes;
static bool corrupt_readback;

static esp_err_t step(void)
{
    return ++calls == fail_call ? ESP_ERR_TIMEOUT : ESP_OK;
}

esp_err_t i2c_new_master_bus(const i2c_master_bus_config_t *cfg, i2c_master_bus_handle_t *out)
{
    assert(cfg->i2c_port == 0 && cfg->sda_io_num == 47 && cfg->scl_io_num == 48);
    assert(cfg->flags.enable_internal_pullup);
    esp_err_t error = step();
    if (!error) *out = (void *)1;
    return error;
}

esp_err_t i2c_master_bus_add_device(i2c_master_bus_handle_t bus, const i2c_device_config_t *cfg,
                                  i2c_master_dev_handle_t *out)
{
    assert(bus && cfg->dev_addr_length == 7 && cfg->device_address == 0x51);
    assert(cfg->scl_speed_hz == 100000);
    esp_err_t error = step();
    if (!error) *out = (void *)2;
    return error;
}

esp_err_t i2c_master_transmit_receive(i2c_master_dev_handle_t device, const uint8_t *reg,
                                     size_t reg_size, uint8_t *out, size_t size, int timeout)
{
    assert(device && reg_size == 1 && timeout == 100);
    assert((*reg == 0 && size == 1) || (*reg == 4 && size == 7));
    esp_err_t error = step();
    if (!error) {
        memcpy(out, registers + *reg, size);
        if (corrupt_readback && writes && *reg == 4) out[0] ^= 1;
    }
    return error;
}

esp_err_t i2c_master_transmit(i2c_master_dev_handle_t device, const uint8_t *data,
                            size_t size, int timeout)
{
    assert(device && timeout == 100);
    assert((data[0] == 0 && size == 2) || (data[0] == 4 && size == 8));
    esp_err_t error = step();
    if (!error) {
        if (data[0] == 4) assert(registers[0] & RTC_STOP);
        memcpy(registers + data[0], data + 1, size - 1);
        ++writes;
    }
    return error;
}

static void reset(void)
{
    memset(registers, 0, sizeof(registers));
    rtc_bus = NULL;
    rtc_device = NULL;
    calls = writes = fail_call = 0;
    corrupt_readback = false;
    assert(encode_calendar(EPOCH_2000, registers + 4) == ESP_OK);
}

static void test_calendar(void)
{
    unsigned decoded = 999;
    for (unsigned value = 0; value < 256; ++value) {
        bool expected = (value & 15) <= 9 && (value >> 4) <= 9 &&
                        (value >> 4) * 10 + (value & 15) <= 59;
        assert(decode_bcd((uint8_t)value, 59, &decoded) == expected);
        if (expected) assert(decoded == (value >> 4) * 10 + (value & 15));
    }
    for (unsigned value = 0; value <= 99; ++value) {
        assert(decode_bcd(encode_bcd(value), 99, &decoded));
        assert(decoded == value);
    }
    assert(leap_year(2000) && leap_year(2024) && !leap_year(2100));
    assert(month_days(2024, 2) == 29 && month_days(2023, 2) == 28);
    assert(month_days(2024, 0) == 0 && month_days(2024, 13) == 0);
    /* Compare every supported day with the host C library, including leap
     * days, month/year rollovers, and representative second/hour boundaries. */
    const unsigned offsets[] = {0, 59, 60, 3599, 3600, 43200, 86399};
    for (uint64_t day = EPOCH_2000; day < EPOCH_2100; day += 86400) {
        for (unsigned i = 0; i < sizeof(offsets) / sizeof(offsets[0]); ++i) {
            uint64_t epoch = day + offsets[i], recovered = 0;
            uint8_t data[7];
            assert(encode_calendar(epoch, data) == ESP_OK);
            time_t timestamp = (time_t)epoch;
            struct tm *date = gmtime(&timestamp);
            assert(date);
            assert(data[0] == encode_bcd((unsigned)date->tm_sec));
            assert(data[1] == encode_bcd((unsigned)date->tm_min));
            assert(data[2] == encode_bcd((unsigned)date->tm_hour));
            assert(data[3] == encode_bcd((unsigned)date->tm_mday));
            assert(data[4] == date->tm_wday);
            assert(data[5] == encode_bcd((unsigned)date->tm_mon + 1));
            assert(data[6] == encode_bcd((unsigned)date->tm_year - 100));
            assert(decode_calendar(0, data, &recovered) == ESP_OK && recovered == epoch);
        }
    }
    uint8_t data[7];
    assert(encode_calendar(EPOCH_2000 - 1, data) == ESP_ERR_INVALID_ARG);
    assert(encode_calendar(EPOCH_2100, data) == ESP_ERR_INVALID_ARG);
    assert(encode_calendar(UINT64_MAX, data) == ESP_ERR_INVALID_ARG);
    /* All invalid BCDs, flags, field ranges and impossible dates rejected. */
    const uint8_t bad[][2] = {
        {0, 0x80}, {0, 0x60}, {0, 0x1a}, {1, 0x80}, {1, 0x60}, {1, 0x5a},
        {2, 0x40}, {2, 0x24}, {2, 0x1a}, {3, 0x40}, {3, 0x00}, {3, 0x32},
        {3, 0x1a}, {4, 0x07}, {4, 0x80}, {5, 0x00}, {5, 0x13}, {5, 0x20},
        {5, 0x0a}, {6, 0xfa}, {6, 0xa0},
    };
    for (unsigned i = 0; i < sizeof(bad) / sizeof(bad[0]); ++i) {
        uint64_t sentinel = 123;
        assert(encode_calendar(EPOCH_2000, data) == ESP_OK);
        data[bad[i][0]] = bad[i][1];
        assert(decode_calendar(0, data, &sentinel) == ESP_ERR_INVALID_STATE);
        assert(sentinel == 123);
    }
    assert(encode_calendar(EPOCH_2000, data) == ESP_OK);
    uint64_t out;
    assert(decode_calendar(RTC_STOP, data, &out) == ESP_ERR_INVALID_STATE);
    assert(decode_calendar(RTC_12H, data, &out) == ESP_ERR_INVALID_STATE);
    assert(decode_calendar(RTC_EXT_TEST, data, &out) == ESP_ERR_INVALID_STATE);
    data[5] = 0x02; data[3] = 0x29; data[6] = 0x23;
    assert(decode_calendar(0, data, &out) == ESP_ERR_INVALID_STATE);
    data[6] = 0x24;
    assert(decode_calendar(0, data, &out) == ESP_OK);
    data[5] = 0x04; data[3] = 0x31;
    assert(decode_calendar(0, data, &out) == ESP_ERR_INVALID_STATE);
}

static void test_driver(void)
{
    reset();
    uint64_t epoch = 123;
    assert(raw_clock_get(NULL) == ESP_ERR_INVALID_ARG);
    assert(raw_clock_get(&epoch) == ESP_ERR_INVALID_STATE && epoch == 123);
    assert(raw_clock_set(EPOCH_2000) == ESP_ERR_INVALID_STATE);
    for (unsigned failure = 1; failure <= 4; ++failure) {
        reset(); fail_call = failure;
        assert(raw_clock_init() == ESP_ERR_TIMEOUT && writes == 0);
        fail_call = 0;
        assert(raw_clock_init() == ESP_OK && writes == 0); /* Retry partial init. */
    }
    reset(); registers[4] |= RTC_OS;
    assert(raw_clock_init() == ESP_ERR_INVALID_STATE && writes == 0);
    assert(registers[4] & RTC_OS); /* No boot-time acknowledgement of bad time. */
    registers[0] = RTC_STOP | RTC_12H | RTC_EXT_TEST | 0x05;
    assert(raw_clock_set(UINT64_C(1709164800)) == ESP_OK); /* 2024-02-29 UTC. */
    assert(registers[0] == 0x05 && !(registers[4] & RTC_OS));
    assert(raw_clock_get(&epoch) == ESP_OK && epoch == UINT64_C(1709164800));
    assert(registers[7] == 0x29 && registers[9] == 0x02 && registers[10] == 0x24);
    calls = writes = 0;
    assert(raw_clock_set(EPOCH_2100) == ESP_ERR_INVALID_ARG && calls == 0);
    assert(raw_clock_set(EPOCH_2000 - 1) == ESP_ERR_INVALID_ARG && calls == 0);
    /* Every transfer boundary must retain the transport error; failures
     * after freezing may leave STOP set, which get() must reject. */
    for (unsigned failure = 1; failure <= 6; ++failure) {
        reset(); assert(raw_clock_init() == ESP_OK);
        calls = writes = 0; fail_call = failure;
        assert(raw_clock_set(EPOCH_2000 + 86400) == ESP_ERR_TIMEOUT);
        fail_call = 0;
        if (failure == 3 || failure == 4) {
            assert(registers[0] & RTC_STOP);
            assert(raw_clock_get(&epoch) == ESP_ERR_INVALID_STATE);
        }
    }
    reset(); assert(raw_clock_init() == ESP_OK);
    calls = 0; fail_call = 1; epoch = 123;
    assert(raw_clock_get(&epoch) == ESP_ERR_TIMEOUT && epoch == 123);
    calls = 0; fail_call = 2;
    assert(raw_clock_get(&epoch) == ESP_ERR_TIMEOUT && epoch == 123);
    reset(); assert(raw_clock_init() == ESP_OK);
    corrupt_readback = true;
    /* 59 XOR 1 becomes 58: differs backwards instead of allowed +1. */
    assert(raw_clock_set(EPOCH_2000 + 59) == ESP_ERR_INVALID_STATE);
}

int main(void)
{
    test_calendar();
    test_driver();
    puts("RTC: exhaustive 2000..2099 calendar, register validation and I2C faults passed");
    return 0;
}
