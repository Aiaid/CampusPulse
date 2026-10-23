# GitHub Actions and Cloudflare delivery

The workflow is [.github/workflows/ci.yml](../../.github/workflows/ci.yml).
The frontend uses Workers Static Assets, the API uses the same Worker, and
observations use D1. GitHub hosts source and runs checks, not the application.

## Checks

Pull requests and pushes to `main` run Node 24 dependency installation, SQLite
API tests, TypeScript/Vite build, a local D1 migration and browser smoke against
the actual local Worker. The browser checks submit and cancel a manual record.
They require no CF account or production credentials.

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

Use repository-level variables for the two IDs because deployment job selection
evaluates them before entering the `production` environment. Set
`CLOUDFLARE_API_TOKEN` as a repository or `production` environment **secret**, with
Workers Scripts Edit and D1 Edit on the intended account. If Cloudflare requires
additional access to the account's workers.dev subdomain, grant only the relevant
account read permission. No DNS/zone write permission is required by this workflow.

If either ID variable is absent, deployment is skipped while checks still run.
With both IDs present, successful checks on `main` enable a serialized production
deployment. A missing API token fails with a configuration error.
Pull requests do not receive production secrets or deploy. Workflow permissions
are read-only for GitHub contents.

The deployment helper validates IDs and writes a generated Wrangler configuration
under ignored `.wrangler/deploy/`; the committed config retains its local placeholder.
The job applies D1 migrations before publishing the Worker API and frontend together.
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

## Current connection status

Checked 2026-10-23: this session's managed runtime reports no CF secret bindings or
outbound Cloudflare identity. `wrangler whoami` reports unauthenticated, and plugin
discovery returned no Cloudflare integration. The GitHub connection rejects Actions
secret/variable listing with HTTP 403; that does not prove the remote repository has
no secrets. No token was read or printed. Remote resource creation and production
deployment have not been performed.

Local verification: actionlint v1.7.7 passed; the generated deployment config
passed Wrangler dry-run with synthetic IDs (no resource creation or uploads);
the CI-style offline-GIS browser smoke passed.

## First hosted run

[Run 39905700037](https://github.com/Aiaid/CampusPulse/actions/runs/39905700037)
on commit `6c5292c` passed all checks, including browser submission/cancellation and
local D1 migration, in 59 seconds. The deployment job was skipped because target
Cloudflare variables are not configured. This verifies CI, not a cloud deployment.
