#include "raw_clock.h"

#include <stdbool.h>
#include <stddef.h>
#include "driver/i2c_master.h"

/* Wiring/register facts verified against Waveshare commit
 * aaf395c1bbd86f7c5b7a2f9f0401241ff5c44956, V2 02_I2C_PCF85063 and schematic.
 * Independent implementation; no SensorLib implementation is copied. */
#define RTC_ADDRESS 0x51
#define RTC_TIMEOUT_MS 100
#define RTC_CTRL1 0x00
#define RTC_SECONDS 0x04
#define RTC_STOP 0x20
#define RTC_12H 0x02
#define RTC_EXT_TEST 0x80
#define RTC_OS 0x80
#define EPOCH_2000 UINT64_C(946684800)
#define EPOCH_2100 UINT64_C(4102444800)

static i2c_master_bus_handle_t rtc_bus;
static i2c_master_dev_handle_t rtc_device;

static bool leap_year(unsigned year)
{
    return year % 4 == 0 && (year % 100 != 0 || year % 400 == 0);
}

static unsigned month_days(unsigned year, unsigned month)
{
    static const unsigned days[] = {31, 28, 31, 30, 31, 30,
                                    31, 31, 30, 31, 30, 31};
    if (month < 1 || month > 12) return 0;
    return days[month - 1] + (month == 2 && leap_year(year));
}

static bool decode_bcd(uint8_t value, unsigned maximum, unsigned *out)
{
    unsigned low = value & 15U;
    unsigned high = value >> 4;
    if (low > 9 || high > 9 || high * 10 + low > maximum) return false;
    *out = high * 10 + low;
    return true;
}

static uint8_t encode_bcd(unsigned value)
{
    return (uint8_t)((value / 10) * 16 + value % 10);
}

static esp_err_t decode_calendar(uint8_t control, const uint8_t data[7],
                                 uint64_t *epoch)
{
    unsigned second, minute, hour, day, month, year;
    /* Reject reserved bits too: a plausible masked value is not enough to
     * establish a valid clock. OS is a sticky oscillator-integrity flag. */
    if (control & (RTC_STOP | RTC_12H | RTC_EXT_TEST)) return ESP_ERR_INVALID_STATE;
    if ((data[0] & RTC_OS) || (data[1] & 0x80) || (data[2] & 0xc0) ||
        (data[3] & 0xc0) || data[4] > 6 || (data[5] & 0xe0))
        return ESP_ERR_INVALID_STATE;
    if (!decode_bcd(data[0], 59, &second) ||
        !decode_bcd(data[1], 59, &minute) ||
        !decode_bcd(data[2], 23, &hour) ||
        !decode_bcd(data[3], 31, &day) ||
        !decode_bcd(data[5], 12, &month) ||
        !decode_bcd(data[6], 99, &year)) return ESP_ERR_INVALID_STATE;
    year += 2000;
    if (!month || !day || day > month_days(year, month)) return ESP_ERR_INVALID_STATE;
    uint64_t days = 0;
    for (unsigned y = 2000; y < year; ++y) days += leap_year(y) ? 366 : 365;
    for (unsigned m = 1; m < month; ++m) days += month_days(year, m);
    days += day - 1;
    /* Weekday numbering is application-assignable on this chip. Check its
     * 0..6 range, without rejecting an otherwise valid calendar convention. */
    *epoch = EPOCH_2000 + days * 86400 + hour * 3600 + minute * 60 + second;
    return ESP_OK;
}

static esp_err_t encode_calendar(uint64_t epoch, uint8_t data[7])
{
    if (epoch < EPOCH_2000 || epoch >= EPOCH_2100) return ESP_ERR_INVALID_ARG;
    uint64_t relative = epoch - EPOCH_2000;
    unsigned days = (unsigned)(relative / 86400);
    unsigned seconds = (unsigned)(relative % 86400);
    unsigned weekday = (days + 6) % 7; /* 2000-01-01 was Saturday, Sunday=0. */
    unsigned year = 2000;
    while (days >= (leap_year(year) ? 366U : 365U)) {
        days -= leap_year(year) ? 366U : 365U;
        ++year;
    }
    unsigned month = 1;
    while (days >= month_days(year, month)) {
        days -= month_days(year, month);
        ++month;
    }
    data[0] = encode_bcd(seconds % 60); /* Trusted set clears OS. */
    data[1] = encode_bcd(seconds / 60 % 60);
    data[2] = encode_bcd(seconds / 3600);
    data[3] = encode_bcd(days + 1);
    data[4] = (uint8_t)weekday;
    data[5] = encode_bcd(month);
    data[6] = encode_bcd(year - 2000);
    return ESP_OK;
}

static esp_err_t read_registers(uint8_t start, uint8_t *data, size_t length)
{
    return i2c_master_transmit_receive(rtc_device, &start, 1, data, length,
                                       RTC_TIMEOUT_MS);
}

static esp_err_t write_control(uint8_t control)
{
    const uint8_t data[] = {RTC_CTRL1, control};
    return i2c_master_transmit(rtc_device, data, sizeof(data), RTC_TIMEOUT_MS);
}

esp_err_t raw_clock_get(uint64_t *utc_epoch)
{
    uint8_t control, seconds;
    return raw_clock_probe(utc_epoch, &control, &seconds);
}

esp_err_t raw_clock_probe(uint64_t *utc_epoch, uint8_t *control_out, uint8_t *seconds_out)
{
    if (!utc_epoch || !control_out || !seconds_out) return ESP_ERR_INVALID_ARG;
    *control_out = *seconds_out = 0;
    if (!rtc_device) return ESP_ERR_INVALID_STATE;
    uint8_t control, data[7];
    esp_err_t error = read_registers(RTC_CTRL1, &control, 1);
    if (error != ESP_OK) return error;
    /* One continuous seconds..years transfer prevents rollover mixtures. */
    error = read_registers(RTC_SECONDS, data, sizeof(data));
    if (error != ESP_OK) return error;
    *control_out = control; *seconds_out = data[0];
    return decode_calendar(control, data, utc_epoch);
}

esp_err_t raw_clock_init(void)
{
    esp_err_t error;
    if (!rtc_bus) {
        const i2c_master_bus_config_t config = {
            .i2c_port = I2C_NUM_0,
            .sda_io_num = 47,
            .scl_io_num = 48,
            .clk_source = I2C_CLK_SRC_DEFAULT,
            .glitch_ignore_cnt = 7,
            .flags.enable_internal_pullup = true,
        };
        error = i2c_new_master_bus(&config, &rtc_bus);
        if (error != ESP_OK) return error;
    }
    if (!rtc_device) {
        const i2c_device_config_t config = {
            .dev_addr_length = I2C_ADDR_BIT_LEN_7,
            .device_address = RTC_ADDRESS,
            .scl_speed_hz = 100000,
        };
        error = i2c_master_bus_add_device(rtc_bus, &config, &rtc_device);
        if (error != ESP_OK) return error;
    }
    uint64_t ignored;
    return raw_clock_get(&ignored);
}

esp_err_t raw_clock_set(uint64_t utc_epoch)
{
    uint8_t data[8] = {RTC_SECONDS};
    esp_err_t error = encode_calendar(utc_epoch, data + 1);
    if (error != ESP_OK) return error;
    if (!rtc_device) return ESP_ERR_INVALID_STATE;
    uint8_t control;
    error = read_registers(RTC_CTRL1, &control, 1);
    if (error != ESP_OK) return error;
    /* Preserve capacitor selection and correction-interrupt policy, clear
     * test/12h modes. Freeze, write the entire calendar, then start. On any
     * transfer failure return the original error; never claim calibration. */
    control &= 0x05;
    error = write_control(control | RTC_STOP);
    if (error != ESP_OK) return error;
    error = i2c_master_transmit(rtc_device, data, sizeof(data), RTC_TIMEOUT_MS);
    if (error != ESP_OK) return error;
    error = write_control(control);
    if (error != ESP_OK) return error;
    uint64_t verified;
    error = raw_clock_get(&verified);
    if (error != ESP_OK) return error;
    return verified == utc_epoch || verified == utc_epoch + 1 ?
        ESP_OK : ESP_ERR_INVALID_STATE;
}
