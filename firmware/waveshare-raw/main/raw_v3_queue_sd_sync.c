#include "raw_v3_queue_sd_sync.h"
#include <stddef.h>
#include "ff.h"
#include "diskio.h"
#include "diskio_sdmmc.h"
#include "sdmmc_cmd.h"

bool raw_v3_queue_sd_sync(void *mounted_card) {
    sdmmc_card_t *card=mounted_card;
    if(!card) return false;
    BYTE drive=ff_diskio_get_pdrv_card(card);
    if(drive==0xff||drive>=FF_VOLUMES||sdmmc_get_status(card)!=ESP_OK) return false;
    return disk_ioctl(drive,CTRL_SYNC,NULL)==RES_OK;
}
