# Phase 2 Deployment Runbook (Azure Backend + Postgres, Vercel Frontend)

This runbook executes the production path for the Carbon-Aware Compute Advisor.

## 1) Prerequisites

- Azure subscription: `Azure for Students` (active)
- GitHub account + empty repository
- Vercel account
- Local project committed on branch `main`

Recommended initial choices:

- Region: `Sweden Central`
- Fallback region: `West Europe` if SKU/offer/capacity blocks provisioning
- Frontend host: Vercel
- Backend host: Azure App Service (Linux container)

## 2) Required values before rollout

Set these once and reuse across stages:

- `GITHUB_REPO_URL`: `https://github.com/<user-or-org>/<repo>.git`
- `RESOURCE_PREFIX`: short lowercase identifier (example: `caa-teja`)
- `AZURE_REGION`: `swedencentral` (fallback `westeurope`)
- `DB_NAME`: `carbon_db`
- `ELECTRICITYMAPS_KEY`: required
- `OPENAI_API_KEY`: optional

Derived names (example with `RESOURCE_PREFIX=caa-teja`):

- Resource Group: `rg-caa-teja`
- PostgreSQL server: `pg-caa-teja`
- ACR: `acrcaateja`
- App Service plan: `asp-caa-teja`
- Web app: `app-caa-teja`

## 3) Stage A — Push source to GitHub

From project root:

```bash
git remote add origin <GITHUB_REPO_URL>
git push -u origin main
```

If remote already exists:

```bash
git remote -v
git push -u origin main
```

## 4) Stage B — Azure resources (Portal)

Create resources in this order:

1. Resource Group (`rg-...`) in `Sweden Central`
2. PostgreSQL Flexible Server (`pg-...`)
3. Database `carbon_db`
4. ACR (`acr...`)
5. App Service Plan (`asp-...`, Linux)
6. Web App for Containers (`app-...`)

PostgreSQL settings:

- Small burstable SKU (student-friendly)
- Public access for initial rollout
- Allow Azure services
- Temporarily allow your IP for diagnostics

ACR **gotcha**:

- ACR -> Access keys -> enable `Admin user`
- Capture:
  - login server (`<acr>.azurecr.io`)
  - username/password

Build connection string:

```text
postgresql://<db_user>:<db_password>@<db_host>:5432/carbon_db?sslmode=require
```

## 5) Stage C — Backend deployment (Azure App Service)

In App Service -> Deployment Center:

- Source: GitHub
- Branch: `main`
- Build/deploy from repo and Dockerfile

Set App Settings:

- `DATABASE_URL=<postgresql://...sslmode=require>`
- `ELECTRICITYMAPS_KEY=<value>`
- `OPENAI_API_KEY=<optional>`
- `CORS_ORIGINS=https://placeholder.vercel.app` (update after frontend deploy)
- `PYTHONPATH=.`
- `WEBSITES_PORT=8000`

Validation:

- Log stream contains postgres mode startup line.
- Health endpoint:
  - `https://<app>.azurewebsites.net/api/v1/health`
  - Expect: `storage_mode = "postgres"`

Cold-start note:

- First hit on student tier can take up to ~3 minutes.

GitHub sync gotcha:

- Deployment Center may create/update workflow files in GitHub.
- Run `git pull` locally after connecting Deployment Center.

## 6) Stage D — Frontend deployment (Vercel)

In Vercel:

1. Import repository
2. Root directory: `frontend`
3. Environment variables:
   - `NEXT_PUBLIC_API_BASE_URL=https://<azure-app>.azurewebsites.net/api/v1`
   - `NEXT_PUBLIC_PRIMARY_ZONES=SE-SE1,SE-SE2,SE-SE3,SE-SE4`
4. Deploy and capture Vercel URL

Then update Azure App Service:

- `CORS_ORIGINS=https://<vercel-app>.vercel.app` (no trailing slash)
- Restart/redeploy backend

## 7) Stage E — Production smoke tests

Use the included script:

```bash
bash scripts/smoke_prod.sh \
  "https://<vercel-app>.vercel.app" \
  "https://<azure-app>.azurewebsites.net/api/v1"
```

Manual UI checks:

1. Force Clean Path -> local completion
2. Force Route Path -> route approval -> routed completion
3. Force Approval Path -> postpone completion
4. Audit CSV download
5. Live evaluate path completes
6. Browser network tab has no CORS errors

## 8) Region fallback

If Sweden Central fails with SKU/offer/capacity errors:

1. Delete partial resources in Sweden Central RG.
2. Recreate the full stack in `West Europe`.
3. Keep Vercel unchanged.

## 9) Definition of done

- Backend live on Azure App Service
- Frontend live on Vercel
- `/api/v1/health` returns `status=ok`, `storage_mode=postgres`, `langgraph_db_path=null`
- End-to-end forced paths and live path work
