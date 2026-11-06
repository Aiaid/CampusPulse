# Live device map rendering

Status: source implementation and local verification on 2026-11-06. Publication
is established separately by the associated commit and CI/deployment run. The
local virtual device remains isolated from production.

The user requested that every live person/vehicle sprite depend on uploaded
observations, with no demo defaults at places without data. Live and ordinary
field-history drawing now have a separate actor builder. Only the source place's
exact registered routes are eligible; an unknown place is never reassigned to
the nearest named scene. Demo curves, scenario/time defaults, parking occupancy
and density multipliers do not enter this builder.

Fresh, verified V3 sensor windows can produce a bounded activity illustration;
eligible device-derived electric-bike candidates can independently produce
vehicle sprites. Positive unclassified BLE activity cannot create vehicles.
Zero, missing, retained, expired, time-unverified, failed-read or incomplete/lossy
inputs produce no current actors. Bounded clock uncertainty up to five seconds
is admitted consistently with the public backend; overflow/saturation is not.
Manual parking/wait records and historical references remain available in cards,
without becoming device-derived moving/parked sprites. A manual card does not
suppress independent valid uploaded candidates.

Counts are capped drawing budgets derived from each observation, shared across
that place's paths. BLE keys are not converted into calibrated people counts;
positions, headings, motion and lighting remain illustrations. Car candidates
are not silently depicted as electric bikes. With no registered geometry for a
place, its card can show the observation while no map actors are drawn.

The independent authored demo retains its existing artwork, routes and behavior.
This local change does not establish a commit, deployment or hardware result.

Verification: all 490 frontend tests in 42 files and the production build passed.
The expanded `field-illustration-browser-smoke.mjs` passed exact-place people-only
rendering, zero/default-vehicle exclusion, missing/expired/unverified/lossy/
retained/read-failure inputs, unknown places without nearest reassignment,
independent uploaded vehicle candidates alongside manual cards, density refresh,
historical gaps, demo animation and 390px sizing. Browser fixtures use isolated
synthetic API records and block external map requests. An actual in-app-browser
check of the local virtual device separately showed both overview/detail canvases
with two bounded activity figures at `library`, zero riding/parked figures, and
zero figures in a selected historical gap; official GIS loaded in that preview.

## Local busy-scene check

The running isolated virtual device was switched from quiet to busy. Normal live
cards changed from 2 to 12 BLE-visible keys; both map canvases changed from two
to three bounded activity figures at library, with no riding or parked defaults.
This is a schematic drawing budget, not a calibrated count of people.

See [local virtual-device setup](v3-device-simulator.md).

## Selected release validation

The selected Git tree was exported to a temporary directory without a worktree;
other sessions' uncommitted presentation, administration and firmware edits were
excluded. That snapshot passed all 1,380 tests in 103 files and the production
build. Map and simulator browser checks also passed on that selected snapshot;
the earlier 490-frontend-test result above belongs to the full local workspace.
This source release does not connect the local virtual device to production or
upload its synthetic records there.
