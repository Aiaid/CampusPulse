# Online virtual-device live preview

Status: deployed and bounded online receipt/map acceptance, 2026-11-06.
The user explicitly requested two online virtual devices with vehicle data at
different places. No physical device identity, credential, queue or deployment is
reused or changed.

## Data path and scope

Each virtual device uses its own normally enrolled MQTT identity and namespace:
native verified MQTT/TLS → production EMQX → CPV3 gateway → normal Worker/D1 →
normal live summary/history and map. Replies must match the exact RPC topic and
the full committed receipt before a frozen statistics batch is reclaimed.
Broker PUBACK alone does not acknowledge application custody.

The global production producer remains `cp-v3-small/1`. The separate
`DEVICE_V3_SIMULATOR_NODE_IDS` variable defaults to an empty array and permits
only exact `sim-live-` node IDs for `synthetic-statistics/1`, fixed-point field
observation, raw off, native MQTT/TLS and bounded statistics/status streams.
Malformed lists, other nodes/producers and incompatible policies fail closed.
Registration and synthetic provenance remain visible in administration.

The canonical `cp-v3-vehicle-candidates/1` ruleset is shared with the separately
reviewed firmware contract. Online fixtures contain authored aggregate counts,
not a fresh BLE classification or hardware/RF acceptance. No per-address or raw
data is generated. Phone/generic-other categories remain zero; unknown counts
are retained and `estimated_total` stays null.

## Preview configuration

| Virtual profile | Independent place | Visible keys | Bike candidates | Car candidates |
| --- | --- | ---: | ---: | ---: |
| First | 佑铭体育馆 (`gym`) | 12 | 3 | 2 |
| Second | 田家炳楼 (`tianjiabing`) | 24 | 6 | 3 |

The existing library receiver is left untouched even while its summary has no
fresh data. The two new placements have bounded end times. Normal administration
must register each placement and publish a current-boot field policy; the runner
waits for that assignment when no private administrator cookie is provided.

Private JSON must be an owned 0600 regular file and explicitly confirm the pinned
production origin. Keep enrollment material outside Git/logs/chat. Use:

```sh
node scripts/v3-online-simulator.mjs --config /absolute/private/config.json
```

The runner defaults to busy, supports explicit `vehicleData: true` and
`vehicleCounts: { "bikes": 3, "cars": 2 }`, and runs for at most 20 minutes.
There is no HTTP upload fallback, TLS-verification exception, automatic reboot
or unbounded policy renewal. Shutdown writes a private audit snapshot retaining
pending frozen bytes; this is not automatic durable restart recovery. Records
are retained rather than deleted, and source freshness controls current actors.

## Map behavior

The overview reads normal summaries for at most 32 verified places with four
concurrent reads and a 30-second visible-page cadence. Each place is independently
normalized and source-bound; failures clear only its own current actors. The
selected detail reuses its existing session. Historical replay does not mix in
other places' current live observations.

Car candidates use original code-native Canvas car geometry, distinct from
electric-bike sprites. Both retain existing direction, lighting and occlusion.
Global drawing budgets remain bounded and schematic: candidates/visible keys
are not calibrated counts of actual people, vehicles or trajectories. No default
actors appear where uploaded evidence is absent or ineligible.

## Verification

Scoped work covered native MQTT framing/correlation/timeouts, private configuration,
both vehicle profiles at 1/30/60-second cadence, named-node policy isolation,
authoritative vehicle projection including zero-ID windows, independent places,
car drawing, missing data, replay and mobile sizing. Exact selected-release and
production outcomes must be distinguished from the full shared working copy.

The exact selected source tree passed all 1,485 tests in 108 files, TypeScript/Vite
build, the expanded browser scene checks (including isolated car pixels and two
places), and Wrangler dry-run. Only selected source and reviewed vehicle-contract
files were exported; parallel firmware, control/transition/schema and unrelated
presentation edits were excluded.

Production Worker version `f37b2a61-30e8-4826-81b0-341b6b97ee2d` was deployed
from that source with the two exact simulator IDs enabled. Both devices completed
real native MQTT/TLS capability registration, a normal administrator-published
field assignment and applied ACK. Exact durable receipts reclaimed statistics
and status batches: at least three pairs for the gym and one pair for
tianjiabing at the recorded check, with zero reported upload/ACK/retry losses.
These are bounded observations, not a sustained reliability claim.

Independent production summary reads returned fresh 12/24 visible keys and
3/2 versus 6/3 bike/car candidates. The actual online browser showed both places
in the overview: eight bounded activity figures, four riding-bike figures and
four car figures; the selected gym detail had three/two/two. These are capped
schematic drawing budgets, not literal candidate or population totals. The local
loopback simulator remains a separate environment.
