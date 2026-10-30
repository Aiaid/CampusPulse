#pragma once
#include <stdbool.h>
/* Pass the mounted sdmmc_card_t* as context. Call only while the owner's TF lock
 * is held, after fsync/f_close or FatFs rename/unlink completed. This checks the
 * owning disk mapping and card status; CTRL_SYNC is a no-op in IDF5.5.3 SDMMC.
 * It does not flush an undocumented card cache or guarantee power-loss safety. */
bool raw_v3_queue_sd_sync(void *mounted_card);
