/* ABI guard only: this does not link, start or consume the shared collector. */
#include "board_handoff.h"
#include "cp_v3_capture.h"
_Static_assert(sizeof(cp_v3_capture_window_t)<=TE_HANDOFF_SNAPSHOT_MAX,"window exceeds handoff staging");
_Static_assert(sizeof(cp_v3_capture_event_t)<=TE_HANDOFF_SNAPSHOT_MAX,"event exceeds handoff staging");
