# CampusPulse

[简体中文](README.zh_CN.md) · [Try the prototype](https://pulse.anend.net) · [Documentation](docs/README.md)

CampusPulse is a campus observation map we are building for Central China Normal
University (CCNU). It started with the idea of a Bluetooth activity heatmap;
CCNU's existing GIS, e-bike parking problems and elevator waits led us to add
on-device e-bike identification, Bluetooth event analysis at elevator lobbies
and a shared live/history timeline.

## Earlier Bluetooth map projects

Other universities have explored Bluetooth-based campus maps. The University of
Notre Dame's [N-Distance](https://wireless.nd.edu/research/collaborative-intelligent-radio-systems-for-congested-wireless-environments/)
uses participants' phone locations and Bluetooth sightings to map when and where
interactions occur on campus. Participants install an app and carry a beacon.

The hackathon project [CrowdMap](https://devpost.com/software/crowdmap-2tqdch)
takes a hardware approach closer to ours: an ESP32 scans nearby Bluetooth
advertisements and sends statistics to a web heatmap showing changes over time.

These projects offer a starting point: observe activity around a place through
Bluetooth signals, then put those observations on a map.

## What we changed for CCNU

CCNU already has an [official campus GIS](https://gis.ccnu.edu.cn/), with a base
map of buildings, roads and places. We use that map and attach observation
points and records to locations people already know.

E-bike parking is another reason for the project. A university
[report on its Nanhu campus safety inspection](https://www.ccnu.edu.cn/info/1073/37372.htm)
explicitly raised parking difficulties and disorderly parking, and called for
expanding parking spaces. Alongside activity changes, we want to record how many
bikes were seen at a parking point, when the observation was made, and how it
changes during the day.

The device now identifies e-bikes automatically from Bluetooth advertisements.
Its rules use vehicle-brand names and known vehicle-module manufacturer IDs,
exclude known phone, accessory and office-device signatures, and check sustained
presence. Identified vehicles and uncertain devices are counted separately; see
the [on-device rules](firmware/ai-passport-radar/main/veh_rules.c).

Automatic identification is the main source for parking observations. Manual
entry remains available for supplementary records and cross-checks, rather than
requiring someone to identify each vehicle. The count refers to vehicles matched
by the rules, not every nearby Bluetooth device.

Elevator waiting time is another problem we want to address. We use Bluetooth
observations at the lobby to detect when a group of previously stable signals
disappears together, producing candidate boarding events for reviewing changes
in elevator-lobby activity. The rules already produce these candidates; deriving
actual wait durations still needs field calibration. The time taken to confirm
an event is not the time someone spent waiting.

We also added one time axis for live observations and historical review. Once
field data is uploaded, we can look back at changes at the same place and see
both the recorded intervals and the gaps.

![CampusPulse simulation overview with campus map and place details](docs/images/simulation-desktop.png)

*Simulation screenshot. The base map comes from CCNU GIS; people, vehicles and
lighting are illustrative.*

## Using the map

Choose a place and follow its latest observations. Drag the horizontal time axis
or click a record marker to pause at an exact historical time. Select
**返回实时** (Return to live) to follow the latest data again.

<table>
<tr>
<td width="72%"><img src="docs/images/live-timeline-desktop.png" alt="Desktop observation view with source cards and a continuous timeline" /></td>
<td width="28%"><img src="docs/images/replay-mobile.png" alt="Phone observation view paused at a historical time" /></td>
</tr>
<tr>
<td>Live observations and the shared timeline on desktop.</td>
<td>Historical review on a phone.</td>
</tr>
</table>

*These two interface screenshots use test data. The place is labelled “样例”
(sample); these are not field recordings.*

[How these screenshots are captured](docs/notes/readme-screenshots.md).

## Explore the prototype

- [**现场观察 · Observations**](https://pulse.anend.net/?mode=field): follow live data, drag back through retained history, then return to live.
- [**模拟演示 · Simulation**](https://pulse.anend.net/?mode=demo): explore teaching-day, weekend and rainy-day scenarios with synthetic activity and animation.

The deployed prototype may lag the current code. Observations show uploaded
records and leave missing data empty. Simulation is a separate way to try the
interface; its values never fill gaps in field records.

The observation axis starts with the last hour and offers 15-minute, one-hour
and 24-hour ranges. Reads return at most the newest 200 records per stream;
truncation is visible, so a 24-hour range does not promise a complete recording.
Real-data review currently depends on the online API and has no offline file
player or automatic playback. The older `?mode=replay` link opens this same axis
at its newest retained record.

Only observation points with verified map positions are marked; buildings on
the base map do not imply installed sensors. Records for unlocated places remain
available in the data selector.

## Current progress

Passport firmware includes automatic Bluetooth e-bike identification,
provisioning, policy control, BLE aggregation and buffered upload. The web app
provides map exploration, the shared live/history axis, supplementary manual
records and a separate simulation. Cloud services provide device ingestion,
durable receipts and private research storage.

The frontend revision shown in these screenshots currently displays overall BLE
windows; it has not yet connected the device's vehicle classifications to map
details. Device identification and web presentation have separate implementation
boundaries. Automatic elevator-lobby event detection is implemented on the
[elevator development branch](https://github.com/Aiaid/CampusPulse/tree/codex/elevator-cohort-events);
it is not yet merged into the revision shown here and does not yet predict wait
durations in seconds.

Next we need to check collection, network access and upload on site, then see
whether the saved records support a useful replay. Preparation is in the
[field checklist](docs/notes/hackathon-delivery.md); further work is in the
[roadmap](docs/design/ROADMAP.md).

## Run locally

Use **Node.js 24**. From the repository directory:

```sh
npm ci
npm run build
npm run db:migrate
cp .dev.vars.example .dev.vars
```

Edit the ignored `.dev.vars` and replace `OPERATOR_TOKEN` with a random local
credential. Set an independent `ADMIN_TOKEN` if you need administrator setup;
keep credentials out of source and screenshots.

Start the API:

```sh
npm run dev:api
```

In another terminal, start the frontend:

```sh
npm run dev
```

Open [localhost:5173](http://localhost:5173/?mode=field). Vite proxies `/api` to
the Worker on port 8787. A fresh local database has no field recordings; choose
simulation to explore the visual experience. Run `npm test` and `npm run build`
for the automated checks. More setup details are in the [development guide](docs/notes/development.md).

## Stack and documentation

The stack is React 19, Vite, TypeScript/JavaScript and PixiJS/Canvas/CSS, with
Cloudflare Workers Static Assets, a Workers API, D1 and private R2. Firmware uses
ESP-IDF/FreeRTOS. GitHub hosts source and CI; Cloudflare hosts the application.

- [Architecture](docs/notes/architecture.md) and [API documentation](docs/specs/web-api-v0.md)
- [Administrator setup](docs/specs/admin-auth-v1.md) and [firmware chain](docs/notes/firmware-chain.md)
- [CI/CD and deployment](docs/notes/ci-cd.md)
- [Source provenance and reuse boundaries](docs/notes/reuse.md), [contributor rules](AGENTS.md) and [full documentation index](docs/README.md)
