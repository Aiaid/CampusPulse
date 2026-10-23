# BSP 裁剪版（CampusPulse passport-terminal）：只保留本固件用到的
# 显示 / 按键 / 电池 / I2C。音频（ES8311）与 LVGL 接入层未使用，
# 按 CampusPulse AGENTS.md「不初始化用不到的音频」要求未纳入编译。
# 引脚映射、版权与许可证保留自 ai-passport 原文件。
idf_component_register(
    SRCS "src/bsp_i2c.c"
         "src/bsp_display.c"
         "src/bsp_button.c"
         "src/bsp_battery.c"
    INCLUDE_DIRS "include"
    REQUIRES driver esp_driver_i2c esp_lcd button esp_adc
    PRIV_REQUIRES esp_timer
)
