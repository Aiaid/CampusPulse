#include <assert.h>
#include <setjmp.h>
#include <stdio.h>
#include "../main/raw_power.c"

static unsigned calls, fail_call, configs, cuts, sleeps;
static int pwr = 1, boot = 1, hold_level;
static bool press_during_setup;
static jmp_buf sleep_jump;

static esp_err_t step(void)
{
    return ++calls == fail_call ? ESP_ERR_TIMEOUT : ESP_OK;
}

esp_err_t gpio_set_level(gpio_num_t pin, uint32_t level)
{
    assert(pin == 17 && level <= 1);
    esp_err_t error = step();
    if (!error) {
        hold_level = (int)level;
        if (!level) ++cuts;
    }
    return error;
}

esp_err_t gpio_config(const gpio_config_t *config)
{
    assert(config->pull_up_en == GPIO_PULLUP_ENABLE);
    assert(config->pull_down_en == GPIO_PULLDOWN_DISABLE);
    assert(config->intr_type == GPIO_INTR_DISABLE);
    if (configs++ == 0) {
        assert(hold_level == 1); /* Preload before output-enable. */
        assert(config->pin_bit_mask == (UINT64_C(1) << 17));
        assert(config->mode == GPIO_MODE_OUTPUT);
    } else {
        assert(config->pin_bit_mask == ((UINT64_C(1) << 18) | 1));
        assert(config->mode == GPIO_MODE_INPUT);
    }
    return step();
}

int gpio_get_level(gpio_num_t pin)
{
    assert(pin == 18 || pin == 0);
    return pin == 18 ? pwr : boot;
}

esp_err_t rtc_gpio_pullup_en(gpio_num_t pin)
{
    assert(pin == 18 && hold_level == 1); return step();
}

esp_err_t rtc_gpio_pulldown_dis(gpio_num_t pin)
{
    assert(pin == 18 && hold_level == 1); return step();
}

esp_err_t esp_sleep_pd_config(int domain, int option)
{
    assert(domain == ESP_PD_DOMAIN_RTC_PERIPH && option == ESP_PD_OPTION_ON);
    assert(hold_level == 1); return step();
}

esp_err_t esp_sleep_enable_ext1_wakeup_io(uint64_t mask, int mode)
{
    assert(mask == (UINT64_C(1) << 18) && mode == ESP_EXT1_WAKEUP_ANY_LOW);
    assert(hold_level == 1);
    if (press_during_setup) pwr = 0;
    return step();
}

void esp_deep_sleep_start(void)
{
    assert(hold_level == 0 && cuts == 1);
    ++sleeps;
    longjmp(sleep_jump, 1);
}

static void reset(void)
{
    calls = fail_call = configs = cuts = sleeps = 0;
    pwr = boot = 1; hold_level = -1;
    power_ready = press_during_setup = false;
}

int main(void)
{
    reset();
    assert(raw_power_shutdown() == ESP_ERR_INVALID_STATE && calls == 0);
    for (unsigned failure = 1; failure <= 3; ++failure) {
        reset(); fail_call = failure;
        assert(raw_power_init() == ESP_ERR_TIMEOUT && !power_ready);
        assert(cuts == 0 && sleeps == 0);
        assert(raw_power_shutdown() == ESP_ERR_INVALID_STATE);
    }
    reset(); assert(raw_power_init() == ESP_OK);
    assert(hold_level == 1 && configs == 2);
    assert(!raw_power_pressed() && !raw_boot_pressed());
    pwr = boot = 0;
    assert(raw_power_pressed() && raw_boot_pressed());
    unsigned before = calls;
    assert(raw_power_shutdown() == ESP_ERR_INVALID_STATE && calls == before);
    /* Pull setup, power-domain, wake-source and final latch-write failures. */
    for (unsigned failure = 1; failure <= 5; ++failure) {
        reset(); assert(raw_power_init() == ESP_OK);
        calls = 0; fail_call = failure;
        assert(raw_power_shutdown() == ESP_ERR_TIMEOUT);
        assert(hold_level == 1 && cuts == 0 && sleeps == 0);
    }
    reset(); assert(raw_power_init() == ESP_OK);
    press_during_setup = true;
    assert(raw_power_shutdown() == ESP_ERR_INVALID_STATE);
    assert(hold_level == 1 && cuts == 0 && sleeps == 0);
    reset(); assert(raw_power_init() == ESP_OK);
    if (!setjmp(sleep_jump)) {
        (void)raw_power_shutdown();
        assert(!"shutdown should never return on success");
    }
    assert(hold_level == 0 && cuts == 1 && sleeps == 1);
    puts("Power: latch polarity/order, active-low buttons, wake setup and failure safety passed");
    return 0;
}
