# Carbon-Aware Compute Advisor

Carbon-Aware Compute Advisor is an interview-focused GreenOps orchestration app.

It evaluates a compute workload against real-time grid carbon intensity and decides whether to:
- run locally now,
- route to a cleaner zone, or
- pause for manager approval.

The system is designed to demonstrate production-style workflow orchestration: policy evaluation, human-in-the-loop controls, resumable execution, and auditable artifacts.

## Table of Contents
- [1) What This Application Is](#1-what-this-application-is)
- [2) What It Demonstrates](#2-what-it-demonstrates)
- [3) End-to-End User Flow](#3-end-to-end-user-flow)
- [4) Architecture](#4-architecture)
- [5) Backend Workflow Design](#5-backend-workflow-design)
- [6) Frontend and Auth](#6-frontend-and-auth)
- [7) Data and Persistence](#7-data-and-persistence)
- [8) API Contract](#8-api-contract)
- [9) Environment Variables](#9-environment-variables)
- [10) Local Development](#10-local-development)
- [11) Deployment Topology](#11-deployment-topology)
- [12) Verification and Testing](#12-verification-and-testing)
- [13) Performance and Latency Controls](#13-performance-and-latency-controls)
- [14) Known Constraints](#14-known-constraints)
- [15) Roadmap (Deferred)](#15-roadmap-deferred)
- [16) Interview Brief (2-3 Minutes)](#16-interview-brief-2-3-minutes)
- [17) Repository Map](#17-repository-map)

## 1) What This Application Is
This project is a decision-control surface for carbon-aware compute operations.

Given:
- estimated job energy (`kWh`),
- a carbon threshold (`gCO2eq/kWh`),
- and a primary grid zone,

the system evaluates current intensity and candidate zones, then produces a governed action:
- `run_now_local`
- `route_to_clean_region`
- `require_manager_decision`

For dirty-grid cases, the workflow pauses and requires explicit manager action:
- `run_local`
- `route`
- `postpone`

The final output includes:
- policy reasoning,
- emissions estimates,
- decision timeline,
- and CSV export for audit review.

## 2) What It Demonstrates
This app is intentionally built to show engineering depth beyond a static dashboard:

1. Workflow orchestration with interrupt/resume (LangGraph).
2. Async API service with persistent checkpoints (SQLite or Postgres).
3. Human governance controls with override justification rules.
4. Federated login gate on frontend (Google, optional GitHub).
5. Structured operational outputs (timeline + CSV).

## 3) End-to-End User Flow
1. User signs in at `/login` (Google by default, GitHub optional if env vars are set).
2. User configures energy, threshold, and primary zone.
3. User runs either:
   - `Evaluate and decide (Live)` (real Electricity Maps signal), or
   - one deterministic demo scenario.
4. Backend starts a decision thread and executes the graph.
5. If approval is required, UI shows decision briefing + action buttons.
6. Manager action resumes the same checkpointed thread.
7. Final state renders metrics, policy summary, audit report, tradeoff table, candidate zones, and replay timeline.
8. User can download `audit.csv`.

## 4) Architecture

```mermaid
flowchart LR
  U[Next.js Frontend on Vercel] --> A[FastAPI Backend on Azure App Service]
  A --> W[WorkflowService]
  W --> G[LangGraph State Graph]
  G --> S[Sensor Layer Electricity Maps]
  G --> P[Policy Engine]
  G --> R[Audit Generator LLM or Template]
  G --> C[Checkpoint Store Async SQLite or Async Postgres]
  A --> H[/api/v1/health]
  A --> X[/decisions/* and audit.csv]
```

Runtime topology in production:
- Frontend: Vercel (`/login`, `/`, `/api/auth/*`)
- Backend: Azure App Service (container)
- Database: Azure PostgreSQL Flexible Server (checkpoint persistence)
- Registry/CI-CD: Azure Container Registry + GitHub Actions

## 5) Backend Workflow Design

### 5.1 Core backend components
- `src/agent.py`
  - graph definition, stage transitions, interrupt points.
- `backend/app/services/workflow_service.py`
  - decision lifecycle orchestration, thread resume, CSV export.
- `src/sensor.py`
  - latest intensity fetch, retries, cache, candidate fanout, health telemetry.
- `src/policy.py`
  - deterministic routing-first rule evaluation.
- `src/auditor.py`
  - LLM audit generation with timeout and template fallback.
- `backend/app/services/checkpointer.py`
  - initializes `AsyncSqliteSaver` or `AsyncPostgresSaver`.

### 5.2 Concurrency model
- API handlers are async.
- LangGraph execution is currently run via sync graph calls wrapped in `asyncio.to_thread(...)`.
- A single service-level `asyncio.Lock()` serializes graph state operations.

This is intentionally conservative for correctness and deterministic behavior in demo scope.

### 5.3 Manager governance rules
- `manager_id` is required on manager actions.
- `override_reason` is required when manager overrides a route recommendation in routeable dirty cases.
- Workflow status transitions are guarded to prevent invalid actions.

### 5.4 Health semantics
`GET /api/v1/health` includes:
- `status`
- `storage_mode` (`sqlite` or `postgres`)
- `langgraph_db_path` (only populated in sqlite mode)
- `sensor_reachable`
- `last_sensor_success_at`

## 6) Frontend and Auth

### 6.1 Stack and route model
- Next.js App Router (`frontend/app/*`)
- Protected dashboard route: `/`
- Login route: `/login`
- Auth.js endpoints: `/api/auth/*`

### 6.2 Auth strategy
- Auth.js JWT session strategy (no Prisma adapter tables in current phase).
- Providers:
  - Google (enabled when `GOOGLE_CLIENT_ID` + `GOOGLE_CLIENT_SECRET` exist)
  - GitHub (enabled when `GITHUB_CLIENT_ID` + `GITHUB_CLIENT_SECRET` exist)
- Middleware gate redirects unauthenticated users to `/login`.

### 6.3 Governance identity binding
- Approver email shown in dashboard is sourced from authenticated session.
- On manager actions, frontend submits `manager_id = session.user.email`.
- Local context fields (`Approver Name`, `Organization`) are browser-local and never sent to backend APIs.

### 6.4 Theme behavior
- Dark/light preference is pre-hydrated with a blocking script in `frontend/app/layout.tsx`.
- This prevents first-paint theme flicker.
- User preference is persisted in localStorage key `carbon_advisor.theme`.

## 7) Data and Persistence

### 7.1 Stored in backend decision state
- Decision status and policy outputs
- Emissions estimates
- Candidate zone evaluations
- Manager action details (`manager_id`, `override_reason`)
- Timeline events
- Audit text and mode (`llm` or `template`)

### 7.2 Stored only in browser localStorage
- UI preference and helper context:
  - `carbon_advisor.theme`
  - `carbon_advisor.primary_zone`
  - `carbon_advisor.approver_name`
  - `carbon_advisor.approver_org`
  - `carbon_advisor.intro_seen`

## 8) API Contract
Base URL (local): `http://localhost:8000/api/v1`

### 8.1 Start decision
`POST /decisions/start`

Request example:
```json
{
  "estimated_kwh": 500,
  "threshold": 40,
  "zone": "SE-SE3",
  "demo_scenario": "routeable_dirty"
}
```

`demo_scenario` values:
- `clean_local`
- `routeable_dirty`
- `non_routeable_dirty`

### 8.2 Poll decision
`GET /decisions/{decision_id}`

Returns status and full decision payload including:
- policy action/reason
- emissions values
- approval prompt/options
- timeline
- audit text
- candidate zones

### 8.3 Manager actions
- `POST /decisions/{decision_id}/run-local`
- `POST /decisions/{decision_id}/route`
- `POST /decisions/{decision_id}/postpone`

Request body:
```json
{
  "manager_id": "approver@example.com",
  "override_reason": "Only required when overriding route recommendation"
}
```

### 8.4 CSV export
`GET /decisions/{decision_id}/audit.csv`

Returns a decision-level audit row with core governance and emissions fields.

### 8.5 Health
`GET /health` (under `/api/v1` prefix => `/api/v1/health`)

## 9) Environment Variables
Use:
- `/Users/tejaswath/projects/carbon_advisor/.env.example`
- `/Users/tejaswath/projects/carbon_advisor/frontend/.env.example`

### 9.1 Backend (`.env`)
Required:
- `ELECTRICITYMAPS_KEY`

Optional and common:
- `OPENAI_API_KEY`
- `OPENAI_MODEL` (default `gpt-4o-mini`)
- `DATABASE_URL` (when set, postgres mode)
- `LANGGRAPH_DB_PATH` (sqlite fallback path)
- `CORS_ORIGINS`

Runtime controls:
- `REQUEST_TIMEOUT_SECONDS`
- `RETRY_MAX_ATTEMPTS`
- `CACHE_TTL_SECONDS`
- `ROUTING_CANDIDATE_ZONES`
- `MAX_ROUTING_CANDIDATES`
- `CANDIDATE_FETCH_MODE`
- `PARALLEL_FETCH_WORKERS`
- `ENABLE_POSTPONE_FORECAST_RECOMMENDATION`
- `LLM_AUDIT_TIMEOUT_SECONDS`

### 9.2 Frontend (`frontend/.env.local`)
Required for app:
- `NEXT_PUBLIC_API_BASE_URL`
- `NEXT_PUBLIC_PRIMARY_ZONES`
- `NEXTAUTH_URL`
- `NEXTAUTH_SECRET`
- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`

Optional:
- `GITHUB_CLIENT_ID`
- `GITHUB_CLIENT_SECRET`

### 9.3 OAuth redirect requirements
Google OAuth:
- Origins:
  - `http://localhost:3000`
  - `https://carbon-aware-advisor.vercel.app`
- Redirect URIs:
  - `http://localhost:3000/api/auth/callback/google`
  - `https://carbon-aware-advisor.vercel.app/api/auth/callback/google`

GitHub OAuth:
- Authorization callback URIs:
  - `http://localhost:3000/api/auth/callback/github`
  - `https://carbon-aware-advisor.vercel.app/api/auth/callback/github`

## 10) Local Development

### 10.1 Backend
```bash
cd /Users/tejaswath/projects/carbon_advisor
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
uvicorn backend.app.main:app --reload --port 8000
```

### 10.2 Optional local Postgres
```bash
cd /Users/tejaswath/projects/carbon_advisor
docker compose up -d db
```

Set `DATABASE_URL` in `.env` for postgres mode:
```env
DATABASE_URL=postgresql://admin:password@localhost:5432/carbon_db
```

### 10.3 Frontend
```bash
cd /Users/tejaswath/projects/carbon_advisor/frontend
cp .env.example .env.local
npm install
npm run dev
```

Open:
- `http://localhost:3000`

## 11) Deployment Topology
Detailed deployment runbook:
- `/Users/tejaswath/projects/carbon_advisor/deploy/azure_vercel_phase2.md`

Production setup:
1. Backend container deploy to Azure App Service.
2. Postgres on Azure Flexible Server.
3. Frontend deploy on Vercel (`frontend` root directory).
4. Set backend `CORS_ORIGINS` to exact Vercel URL (no trailing slash).

## 12) Verification and Testing

### 12.1 Automated
```bash
cd /Users/tejaswath/projects/carbon_advisor/frontend && npm run build
cd /Users/tejaswath/projects/carbon_advisor && PYTHONPATH=. .venv/bin/pytest -q
```

### 12.2 Production smoke
```bash
bash /Users/tejaswath/projects/carbon_advisor/scripts/smoke_prod.sh \
  "https://<frontend>.vercel.app" \
  "https://<backend>.azurewebsites.net/api/v1"
```

### 12.3 Manual high-signal checks
1. Signed-out `/` redirects to `/login`.
2. Google sign-in returns to `/` (no login loop).
3. Demo clean path completes local.
4. Demo route path reaches approval and supports route/run-local override.
5. Demo approval path supports postpone.
6. CSV download succeeds.
7. `/api/v1/health` returns `storage_mode:"postgres"` in cloud.

## 13) Performance and Latency Controls

### 13.1 Why latency can spike
- Multiple external grid calls for candidate zones.
- Retry/backoff during transient failures.
- LLM response variance.
- Cloud cold starts.

### 13.2 Controls already in place
- `LLM_AUDIT_TIMEOUT_SECONDS` hard timeout.
- Template fallback when LLM fails or times out.
- Candidate count and fetch mode tuning.

Recommended cloud profile:
- `CANDIDATE_FETCH_MODE=parallel`
- `MAX_ROUTING_CANDIDATES=4`
- `REQUEST_TIMEOUT_SECONDS=6`
- `RETRY_MAX_ATTEMPTS=2`
- `LLM_AUDIT_TIMEOUT_SECONDS=5`

### 13.3 Typical response profile
- Demo scenarios: ~1-3s
- Live warm requests: ~4-8s
- Live cold/slow upstream: can exceed 10s

## 14) Known Constraints
1. Routing logic currently uses location-based accounting only.
2. Intensity estimates are point-in-time snapshots.
3. Global lock in workflow service limits high-throughput concurrency.
4. Frontend uses polling; SSE/WebSocket is deferred.
5. Auth is identity gate only; role-based authorization is deferred.

## 15) Roadmap (Deferred)
1. Per-decision lock model to improve concurrency.
2. SSE/WebSocket updates instead of polling.
3. Explicit circuit-breaker states in sensor layer.
4. Market-based Scope 2 extension.
5. Enterprise SSO and role-based access model.

Additional architecture detail:
- `/Users/tejaswath/projects/carbon_advisor/ARCHITECTURE.md`

## 16) Interview Brief (2-3 Minutes)
Use this sequence for presentation:

1. **Problem**
   - "Cloud workloads can run at very different carbon intensity depending on region and time. I built a control plane that makes this decision explicit and auditable."

2. **How it works**
   - "The frontend sends workload parameters to FastAPI. A LangGraph workflow evaluates current intensity plus candidate zones, then either executes, routes, or interrupts for manager approval."

3. **Governance**
   - "Manager actions resume the exact same workflow thread from checkpoints. I capture manager identity and override reason, then export a CSV audit artifact."

4. **Reliability and deployment**
   - "It runs on Azure App Service with Postgres checkpoints and Vercel frontend. Health includes storage mode plus sensor reachability."

5. **Scale narrative**
   - "Today it uses a conservative lock and polling. Next evolution is per-decision locking and SSE; those paths are documented in `ARCHITECTURE.md`."

## 17) Repository Map
- `/Users/tejaswath/projects/carbon_advisor/backend/app/main.py` - FastAPI app + startup/lifespan.
- `/Users/tejaswath/projects/carbon_advisor/backend/app/api/routes.py` - API endpoints.
- `/Users/tejaswath/projects/carbon_advisor/backend/app/services/workflow_service.py` - workflow orchestration/service layer.
- `/Users/tejaswath/projects/carbon_advisor/backend/app/services/checkpointer.py` - sqlite/postgres checkpointer init.
- `/Users/tejaswath/projects/carbon_advisor/src/agent.py` - LangGraph construction and nodes.
- `/Users/tejaswath/projects/carbon_advisor/src/sensor.py` - Electricity Maps integration and caching.
- `/Users/tejaswath/projects/carbon_advisor/src/policy.py` - routing policy rules.
- `/Users/tejaswath/projects/carbon_advisor/src/auditor.py` - LLM/template audit generation.
- `/Users/tejaswath/projects/carbon_advisor/frontend/app/page.tsx` - main dashboard UI.
- `/Users/tejaswath/projects/carbon_advisor/frontend/app/login/page.tsx` - auth/login UI.
- `/Users/tejaswath/projects/carbon_advisor/frontend/lib/auth.ts` - Auth.js provider configuration.
- `/Users/tejaswath/projects/carbon_advisor/frontend/middleware.ts` - route protection.
- `/Users/tejaswath/projects/carbon_advisor/ARCHITECTURE.md` - production scaling narrative.
