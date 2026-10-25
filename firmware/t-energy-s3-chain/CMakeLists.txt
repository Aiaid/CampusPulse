# Second build entry: the shared CampusPulse chain on LILYGO T-Energy-S3.
#
# This is not the vendor bring-up project in firmware/t-energy-s3/. That one
# proves pins and peripherals; this one boots the real chain (identity, board
# profile, runtime state machine, bounded queue, provisioning transport) by
# linking components/cp_* against the S3 board profile.
#
# Build from an ASCII-only path. cp_radar and cp_ui_passport reference sources
# by absolute provenance path, which the toolchain mangles on non-ASCII paths.
#
#   idf.py -DIDF_TARGET=esp32s3 -B build build
#
# See docs/design/tenergy-s3-port.md.
cmake_minimum_required(VERSION 3.16)

set(EXTRA_COMPONENT_DIRS "${CMAKE_CURRENT_LIST_DIR}/../components")

# cp_ui_passport is the Passport panel UI: it REQUIRES bsp (the Waveshare
# idf_component.yml bundle) and LVGL, and it draws the setup PIN. A headless S3
# has no panel, so it is excluded rather than stubbed. Nothing on the S3 side
# references it: cp_board selects tenergy_s3.c, which does not link the UI.
set(EXCLUDE_COMPONENTS cp_ui_passport)

include($ENV{IDF_PATH}/tools/cmake/project.cmake)
project(tenergy_s3_chain)
