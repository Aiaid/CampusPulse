# GitHub Actions and Cloudflare delivery

The workflow is [.github/workflows/ci.yml](../../.github/workflows/ci.yml).
The frontend uses Workers Static Assets, the API uses the same Worker, and
observations use D1. GitHub hosts source and runs checks, not the application.

## Checks

Pull requests and pushes to `main` run Node 24 dependency installation, SQLite
API tests, TypeScript/Vite build, a local D1 migration and browser smoke against
the actual local Worker. The browser checks submit and cancel a manual record.
They require no CF account or production credentials.
Vitest is restricted to `tests/**/*.test.{ts,js}`, so ignored historical reference
projects cannot enter the application test suite. Vitest 4.1.12 replaces the
unmaintained 3.x test toolchain; the release audit reports zero vulnerabilities.

CI deliberately simulates unavailable GIS tiles and verifies the failure UI, so
the school's external server cannot make an otherwise correct PR fail. Local
`npm run test:browser` additionally checks actual official image rendering;
`SMOKE_GIS=offline npm run test:browser` reproduces CI's independent check.
No school-map screenshot or image artifact is published by the workflow.

## Production setup

Set these repository Actions variables:

| Name | Value |
| --- | --- |
| `CLOUDFLARE_ACCOUNT_ID` | Target Cloudflare account ID |
| `CLOUDFLARE_D1_DATABASE_ID` | UUID from `wrangler d1 create campuspulse` |
| `CLOUDFLARE_R2_RAW_BUCKET` | Private raw archive bucket; required for ingestion deployment |
| `CLOUDFLARE_DEPLOYMENT_URL` | Published HTTPS origin, currently `https://campuspulse.anend.workers.dev` |

Use repository-level variables for the two IDs because deployment job selection
evaluates them before entering the `production` environment. Set
`CLOUDFLARE_API_TOKEN` as a repository or `production` environment **secret**, with
Workers Scripts Edit and D1 Edit on the intended account. If Cloudflare requires
additional access to the account's workers.dev subdomain, grant only the relevant
account read permission. No DNS/zone write permission is required by this workflow.
The R2 archive is bound through the Worker; creation and privacy checks use the
separate authorized operator session. The pipeline refuses to deploy ingestion
without the bucket variable and verifies `raw_storage: configured` afterward.

If either ID variable is absent, deployment is skipped while checks still run.
With both IDs present, successful checks on `main` enable a serialized production
deployment. A missing API token fails with a configuration error.
Pull requests do not receive production secrets or deploy. Workflow permissions
are read-only for GitHub contents.

The deployment helper validates IDs and writes a generated Wrangler configuration
under ignored `.wrangler/deploy/`; the committed config retains its local placeholder.
The job applies D1 migrations before publishing the Worker API and frontend together.
After deployment, `scripts/deployment-smoke.mjs` verifies that the public HTML
matches the current build, its referenced assets load, the API is healthy and
D1 returns seeded places. This read-only check uses no operator credential and
does not create synthetic production observations.
Keep future migrations compatible with the previously deployed Worker; a failed
deployment does not roll back an already-applied schema migration.

Set the runtime operator credential once with Wrangler against the same account:

```sh
npx wrangler secret put OPERATOR_TOKEN
```

This is a runtime Worker secret, separate from the deployment API token. The
pipeline never embeds it in assets, logs or Git. Until configured, manual writes
fail closed. Existing Worker secrets are preserved by deployment.

GitHub environment protection rules can be added on `production` if desired;
this workflow does not create approval requirements itself.

## Main branch policy

The owner's `Aiaid` account may push its own work directly to `main`; an owner
PR is not required. Both repository rulesets list only this user as an
always-allowed bypass actor. Other collaborators must use a PR, obtain an
approval from code owner `@Aiaid` (the whole repository is covered by
`.github/CODEOWNERS`), and pass the `check` status from the GitHub Actions app.
New commits dismiss old approvals, and required checks use the latest `main`.

The owner exception applies to repository push/merge gates. The deployment
workflow still runs `check` after an owner's main push and deploys only when it
succeeds; the owner exception does not skip tests inside the delivery pipeline.
This reflects the owner's explicit clarification on 2026-10-23 that their own
changes need not go through a PR.

## Initial connection status (historical)

Before this machine's setup on 2026-10-23, the earlier managed runtime reported no CF secret bindings or
outbound Cloudflare identity. `wrangler whoami` reports unauthenticated, and plugin
discovery returned no Cloudflare integration. The GitHub connection rejects Actions
secret/variable listing with HTTP 403; that does not prove the remote repository has
no secrets. No token was read or printed. Remote resource creation and production
deployment had not been performed. The setup below supersedes that status.

Local verification: actionlint v1.7.7 passed; the generated deployment config
passed Wrangler dry-run with synthetic IDs (no resource creation or uploads);
the CI-style offline-GIS browser smoke passed.

## First hosted run

[Run 39905700037](https://github.com/Aiaid/CampusPulse/actions/runs/39905700037)
on commit `6c5292c` passed all checks, including browser submission/cancellation and
local D1 migration, in 59 seconds. The deployment job was skipped because target
Cloudflare variables were not configured. This verified CI, not a cloud deployment.

## First Cloudflare setup — 2026-10-23

The owner completed Wrangler device authorization. The `campuspulse` D1 database
was created in APAC and `0001_initial.sql` applied successfully. The new
`campuspulse` Worker and Static Assets were published at
[campuspulse.anend.workers.dev](https://campuspulse.anend.workers.dev).
The existing historical service was not replaced. No subscription was upgraded.

The three repository variables above are configured. The owner created the
separate deployment token and stored it as `CLOUDFLARE_API_TOKEN` in the GitHub
`production` environment. The setup requests Workers Scripts Edit, D1 Edit and
Account Settings Read for the target account; no DNS or zone write access is requested.
[Hosted run 39910663742](https://github.com/Aiaid/CampusPulse/actions/runs/39910663742)
on `ba4472b` passed the check job (47 seconds) and production deployment job
(28 seconds), including remote migrations and the published frontend/API/D1 smoke.
This verifies the GitHub-to-Cloudflare delivery path, not device ingestion.

A separate random `OPERATOR_TOKEN` is configured on the Worker. Its local
recovery copy is in ignored `.wrangler/ops/runtime-secrets.json` with mode 0600;
do not publish this file or copy it into GitHub deployment credentials. The
deployment token is not stored in tracked files or shown in logs.

Online checks passed for HTML, built assets, health, D1 place queries, missing
authentication (401), authenticated invalid input (422) and foreign-origin writes
(403). A real Chromium browser also passed official GIS tile rendering, explicit
simulation, WebGL, synthetic manual submission/cancellation and a 390px phone
layout. Synthetic QA records were cancelled, including a final cleanup pass;
they are not hardware observations. BLE ingestion remains unimplemented.

## Cost baseline — checked 2026-10-23

The current small demo can fit within the free allowances; this is a usage
estimate, not confirmation of the account's billing plan or remaining quota.
Allowances are shared with other applications in the same account.

| Component | Free allowance / cost |
| --- | --- |
| Workers Static Assets | Asset storage and static requests are free |
| Workers API | 100,000 requests/day on Free, 10 ms CPU per invocation; Paid starts at $5/month |
| D1 | Free: 5 million rows read/day, 100,000 rows written/day, 5 GB account storage |
| GitHub Actions | This public repository uses free standard hosted Ubuntu runners |
| Future R2 Standard archive | Not created for this release; 10 GB-month, 1 million Class A and 10 million Class B operations/month free |

Workers Paid includes 10 million requests and 30 million CPU ms/month, then
$0.30/million requests and $0.02/million CPU ms. D1 on Paid includes 25 billion
rows read and 50 million rows written/month and 5 GB; excess is $0.001/million
rows read, $1/million rows written and $0.75/GB-month. Queries are billed by rows
scanned, not returned; indexes also contribute writes. Free D1 limits stop
queries when exceeded rather than automatically upgrading the account.
R2 Standard excess storage is $0.015/GB-month and direct egress is free; operations
are separately metered. No R2, AI, custom domain or paid Builds service was added.

Sources: [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/),
[Static Assets](https://developers.cloudflare.com/workers/static-assets/billing-and-limitations/),
[D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/),
[R2 pricing](https://developers.cloudflare.com/r2/pricing/),
[GitHub Actions billing](https://docs.github.com/en/billing/concepts/product-billing/github-actions).

## Ingestion cloud acceptance — 2026-10-23

[Run 39921619389](https://github.com/Aiaid/CampusPulse/actions/runs/39921619389)
published backend-only commit `6f7775a` after all checks passed. It binds private
`campuspulse-raw`, preserves operator/research secrets and configures the 15-minute
cleanup schedule. D1 migration 0002 is applied. Three synthetic demo streams and
private R2 reads passed online; cross-role checks passed and the temporary node
was disabled afterward. This supersedes earlier no-ingestion/no-R2 statements
above; their first-release cost table is historical. No subscription upgrade or
measured usage-cost claim is made here. Exact tests, initial Worker version and
limits are in [backend ingestion acceptance](backend-ingestion.md).

## Administrator account / Passkey release boundary

The additive `0004_admin_auth.sql` revokes earlier administrator sessions and
introduces first-account initialization, password authentication and Passkeys.
Before exposing `/admin`, set a dedicated random `ADMIN_TOKEN` Worker secret. It
allows setup only while no account exists; it remains the private session signing
secret after setup and cannot log in as an account. Do not put it in GitHub public
variables, the tracked Wrangler file or frontend build variables. No production
secret/account is created by local implementation or browser acceptance.

Set `ADMIN_WEBAUTHN_ORIGIN` and `ADMIN_WEBAUTHN_RP_ID` as public deployment
configuration values for the exact intended site. The config generator also
accepts the explicitly trusted `DEPLOYMENT_URL` as an origin fallback; it does not
trust a request Host to select production RP identity. RP ID must match that host.
A new domain needs its own enrollment. Password login is independent of whether
Passkey trust is configured. Verify native scrypt authentication under the actual
Worker plan/CPU budget; local elapsed-time probes do not establish cloud CPU usage
or free-plan readiness. See [auth design and acceptance](../specs/admin-auth-v1.md).

CI creates a disposable bootstrap secret and separate initial/replacement account
credentials in mode600 local state, runs the real Chromium CTAP2 enrollment/login/
reauthentication test against local workerd, then reruns device/config/settings
management using the replacement account. No virtual authenticator private keys
or browser storage state are exported. This is protocol/browser validation, not
physical Touch ID/Face ID/security-key, password-manager sync or production-domain
acceptance. Existing manual-record browser acceptance retains its separate scope.
