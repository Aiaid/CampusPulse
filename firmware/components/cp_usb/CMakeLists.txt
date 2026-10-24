idf_component_register(SRCS "framing.c" "controller.c" "usb_console.c" INCLUDE_DIRS "include"
    REQUIRES cp_provision esp_common
    PRIV_REQUIRES esp_driver_usb_serial_jtag esp_timer json)
