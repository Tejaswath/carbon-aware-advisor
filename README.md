# Carbon-Aware Compute Advisor

Real-time GreenOps orchestration demo for flexible compute workloads.

This project decides whether a workload should:
- run locally now,
- be routed to a cleaner region now, or
- be postponed,

using Electricity Maps carbon-intensity data, explicit policy rules, human approval gates, and auditable outputs.

## Table of Contents
- [1. Project Snapshot](#1-project-snapshot)
- [2. What This Project Demonstrates](#2-what-this-project-demonstrates)
- [3. Current Feature Set (Implemented and Active)](#3-current-feature-set-implemented-and-active)
- [4. UX Behavior and What Inputs Mean](#4-ux-behavior-and-what-inputs-mean)
- [5. End-to-End Decision Lifecycle](#5-end-to-end-decision-lifecycle)
- [6. System Architecture](#6-system-architecture)
- [6.1 Production Scaling Narrative](#61-production-scaling-narrative)
- [7. Policy Logic](#7-policy-logic)
- [7.1 Data Sovereignty Considerations](#71-data-sovereignty-considerations)
- [8. LangGraph Interrupt/Resume Design](#8-langgraph-interruptresume-design)
- [9. API Reference (Routing-First Contract)](#9-api-reference-routing-first-contract)
- [10. Environment Variables](#10-environment-variables)
- [11. Local Development and Runbook](#11-local-development-and-runbook)
- [11.4 Azure + Vercel Deployment Runbook](#114-azure--vercel-deployment-runbook)
- [12. Testing](#12-testing)
- [13. Demo Playbook (Interview-Ready)](#13-demo-playbook-interview-ready)
- [14. Operational Notes](#14-operational-notes)
- [15. Implemented but Not Yet Integrated (Future Work)](#15-implemented-but-not-yet-integrated-future-work)
- [16. Known Constraints](#16-known-constraints)

## 1. Project Snapshot
- **Primary stack**: Python + FastAPI + LangGraph + Next.js.
- **Decision style**: Routing-first (forecast-independent).
- **Primary data signal used in active flow**: `GET /v3/carbon-intensity/latest`.
- **Human governance**: Mandatory manager actions in dirty-grid cases.
- **Auditability**: Decision replay timeline + downloadable CSV audit.
- **Scope intent**: non-commercial academic/resume-quality system design demo.

## 2. What This Project Demonstrates
Most carbon-aware demos stop at dashboards. This one demonstrates production-style control flow:
- deterministic policy evaluation,
- human override and governance,
- resumable workflow state,
- reliability guardrails (retry/backoff/cache/candidate cap),
- clear audit artifacts for compliance-minded environments.

This maps well to enterprise contexts where energy/carbon decisions must be explainable, reviewable, and reversible.

## 3. Current Feature Set (Implemented and Active)

### 3.1 Routing-first workload decisioning
- Evaluates the primary zone and candidate zones using latest carbon intensity.
- Chooses between:
  - `run_now_local`
  - `route_to_clean_region`
  - `require_manager_decision`

### 3.2 Spatial candidate evaluation with guardrails
- Candidate list sourced from `ROUTING_CANDIDATE_ZONES`.
- Hard cap with `MAX_ROUTING_CANDIDATES`.
- Sequential fetching by default for quota safety.
- Optional parallel mode exists (`CANDIDATE_FETCH_MODE=parallel`).
- Per-candidate soft failure handling (including `429`) without hard-crashing the whole decision.

### 3.3 Human-in-the-loop manager controls
When the workflow requires approval, manager actions are explicit:
- `run_local`
- `route`
- `postpone`

Governance inputs captured on each manager action:
- `manager_id` (required)
- `override_reason` (required when overriding recommended `route` action in routeable dirty cases)

### 3.4 Emissions metrics
Computed and returned for each decision:
- `estimated_kgco2_local`
- `estimated_kgco2_routed`
- `estimated_kgco2_saved_by_routing`
- `accounting_method` (currently `location-based`)

### 3.5 Audit and replay
- Generated operational audit text (`llm` or `template` fallback).
- Frontend cleans common markdown artifacts from LLM audit output for readable rendering.
- Decision replay timeline with stage-by-stage events.
- CSV export endpoint for decision-level audit records.
- Audit artifacts include `manager_id` and `override_reason` when applicable.
- Optional postpone-time forecast guidance is captured when feature flag is enabled.

### 3.6 Frontend controls for demonstration reliability
- Live evaluation button (`Evaluate and decide (Live)`).
- Deterministic scenario buttons:
  - `Demo: Grid Clean`
  - `Demo: Route Available`
  - `Demo: Needs Approval`

### 3.7 Primary-zone UX improvements
- Dropdown-based zone selection.
- Human-friendly zone labels.
- Optional geolocation-assisted zone suggestion.
- Browser-local persistence of last selected primary zone.
- Threshold policy presets (`Strict`, `Moderate`, `Relaxed`) with custom override.

### 3.8 Operational tradeoff visualization
- Decision view includes an `Execution Tradeoff Comparison` table.
- Compares `Run Local`, `Route`, and `Postpone` across:
  - estimated carbon (`kgCO2`)
  - estimated latency impact
  - data residency posture (same-country vs cross-border)
  - estimated cost impact

Route row zone resolution is intentionally:
1. use `selected_execution_zone` when it exists and differs from `primary_zone`,
2. else use the first valid non-primary candidate from `routing_top3`,
3. else show `Not available`.

This keeps tradeoff visibility correct across routed, local-clean, and local-override outcomes.

### 3.9 Outcome-aware savings card
- The summary savings card is state-aware:
  - `Routing Savings` (green) when savings are realized (`execution_mode=routed` and savings > 0).
- `Foregone Savings` (amber) when route savings existed but local execution was chosen (`execution_mode=local` and savings > 0).
- Neutral style for zero/unknown savings.

### 3.10 Theme support
- UI supports light and dark themes with a header toggle.
- First visit follows system preference; explicit user choice is persisted in browser localStorage.
- Dark mode uses neutral charcoal surfaces with high-contrast text and green as an accent color (not a background tint).
- Primary CTA, modal overlays, status badges, stepper, and table surfaces are contrast-tuned for both themes.

### 3.11 Decision UX and onboarding upgrades
- Live and demo controls are state-aware:
  - Live action remains primary.
  - Demo scenarios are grouped under a collapsible section.
  - Approval actions render in a dedicated manager decision card.
- Approval state includes a compact `Decision Briefing` block with local vs routed estimates and savings before action buttons.
- Help modal is task-focused and structured as:
  - What this solves
  - How to run a decision
  - How approval works
  - Understanding results
  - Data handling
- Policy and approval copy is human-readable; raw backend enum strings are intentionally hidden in primary UX surfaces.

### 3.12 Federated authentication (frontend gate)
- Frontend uses Auth.js (JWT strategy) with middleware route protection.
- Supported providers:
  - Google
  - GitHub (optional, env-gated)
- Dashboard is protected; unauthenticated users are redirected to `/login`.
- Approver identity for governance actions is derived from authenticated session email (read-only in UI), then submitted as `manager_id`.

## 4. UX Behavior and What Inputs Mean

### Primary Grid Zone
This is **not auto-selected by policy**. It represents the job’s origin/default execution region.

The router then decides whether to:
- keep execution local,
- route to cleaner region,
- or request manager action.

### Carbon Threshold
Policy boundary used to classify grid state as acceptable or not for immediate local execution.

### Estimated Job Energy (kWh)
Used only for emissions math and savings calculations.

### Numeric input normalization
- `Estimated Job Energy` and `Carbon Threshold` are string-backed in the UI to avoid React no-op re-render issues.
- Only digits are accepted while typing.
- On blur, values are normalized to canonical positive integers (minimum `1`), so entries like `01500` become `1500`.

### Force Demo Buttons
These use synthetic intensities in backend workflow state to guarantee a predictable path for demos. They are intentionally deterministic.

### Postpone guidance placement
- Postpone forecast guidance is rendered in the `Execution Tradeoff Comparison` section.
- If no recommendation is available, UI explicitly shows: `No forecast guidance available — check back manually.`

### Approver fields and data handling
- `Approver Email` is the governance field and is stored in backend audit artifacts when manager actions are submitted.
- `Approver Name` and `Organization` are local-only context fields for demo readability and are not sent to backend APIs.

## 5. End-to-End Decision Lifecycle
1. Client starts decision with `{zone, threshold, estimated_kwh, optional demo_scenario}`.
2. Backend creates a decision thread and starts LangGraph.
3. Workflow gets primary intensity (live or synthetic for demo mode).
4. Workflow evaluates candidate zones.
5. Policy chooses action.
6. If manager input is needed, workflow interrupts and waits.
7. Action endpoint resumes same thread with `Command(resume=...)`.
8. Execution mode resolves (`local`, `routed`, `postponed`).
9. Metrics + audit + timeline finalize.
10. UI and CSV endpoint expose final artifacts.

## 6. System Architecture

```mermaid
flowchart LR
  UI["Next.js Dashboard"] --> API["FastAPI /api/v1"]
  API --> WF["WorkflowService"]
  WF --> LG["LangGraph State Graph"]
  LG --> SENSOR["Sensor Layer (Electricity Maps latest)"]
  LG --> POLICY["Policy Engine"]
  LG --> AUDIT["Auditor (LLM or template)"]
  LG --> CP["Checkpoint Store (Async SQLite or Async Postgres)"]
  API --> CSV["Audit CSV Export"]
```

### Key directories
- `src/`
  - `agent.py`: workflow graph and state transitions.
  - `sensor.py`: API fetch/caching/retry/fanout.
  - `policy.py`: decision rule engine.
  - `auditor.py`: report generation and fallback.
  - `config.py`: env parsing.
- `backend/`
  - FastAPI entrypoint, API routes, workflow service, checkpointer init.
- `frontend/`
  - Next.js app UI, typed API client, decision rendering.
- `tests/`
  - Backend, policy, sensor, workflow, and API behavior tests.

## 6.1 Production Scaling Narrative
For interview discussion on scale and reliability tradeoffs, see:

- `/Users/tejaswath/projects/carbon_advisor/ARCHITECTURE.md`

## 7. Policy Logic
Given `current_intensity`, `threshold`, and best candidate (if any):

- If `current_intensity <= threshold`:
  - label: `clean`
  - action: `run_now_local`
- Else if a candidate exists with intensity <= threshold:
  - label: `dirty`
  - action: `route_to_clean_region`
- Else:
  - label: `dirty`
  - action: `require_manager_decision`

In routeable dirty cases, manager still decides final action.

## 7.1 Data Sovereignty Considerations
In production, routing candidates should be dynamically scoped by workload data classification, legal entity, and residency constraints (for example, `Sweden-only` for restricted datasets vs `Nordics-allowed` for internal analytics). This demo uses a static `ROUTING_CANDIDATE_ZONES` list for simplicity, but the intended enterprise pattern is policy-driven candidate filtering before any routing recommendation is computed.

## 8. LangGraph Interrupt/Resume Design

The workflow explicitly pauses at manager decision nodes via `interrupt(...)`.

Resume mapping:
- `POST /run-local` -> `Command(resume={"decision":"run_local","manager_id":"...","override_reason":"..."})`
- `POST /route` -> `Command(resume={"decision":"route","manager_id":"...","override_reason":"..."})`
- `POST /postpone` -> `Command(resume={"decision":"postpone","manager_id":"...","override_reason":"..."})`

This preserves deterministic continuity on the same decision thread, with checkpointed state.

## 9. API Reference (Routing-First Contract)

Base: `http://localhost:8000/api/v1`

### 9.1 Start decision
`POST /decisions/start`

Request:
```json
{
  "estimated_kwh": 550,
  "threshold": 40,
  "zone": "SE-SE3",
  "demo_scenario": "routeable_dirty"
}
```

`demo_scenario` is optional and can be:
- `clean_local`
- `routeable_dirty`
- `non_routeable_dirty`

### 9.2 Poll decision
`GET /decisions/{decision_id}`

Returns:
- status (`processing`, `awaiting_approval`, `completed`, `postponed`, `error`)
- primary/selected zone info
- policy action/reason
- emissions metrics
- accounting method label (`location-based`)
- manager options/prompt (if awaiting approval)
- manager identity fields (`manager_id`, `override_reason`) once action is submitted
- optional postpone forecast guidance (`forecast_available`, `forecast_recommendation`) when enabled
- routing top3
- timeline
- audit text/mode

### 9.3 Manager actions
- `POST /decisions/{decision_id}/run-local`
- `POST /decisions/{decision_id}/route`
- `POST /decisions/{decision_id}/postpone`

Request body for all manager action endpoints:
```json
{
  "manager_id": "manager@example.com",
  "override_reason": "Required only when overriding route recommendation"
}
```

### 9.4 CSV export
`GET /decisions/{decision_id}/audit.csv`

Current CSV columns:
- `decision_id`
- `status`
- `primary_zone`
- `primary_intensity`
- `selected_execution_zone`
- `selected_execution_intensity`
- `execution_mode`
- `threshold`
- `estimated_kwh`
- `estimated_kgco2_local`
- `estimated_kgco2_routed`
- `estimated_kgco2_saved_by_routing`
- `accounting_method`
- `policy_action`
- `policy_reason`
- `manager_decision`
- `manager_id`
- `override_reason`
- `forecast_recommendation`
- `audit_mode`
- `audit_report`
- `created_at_utc`
- `completed_at_utc`

### 9.5 Health
`GET /health`

Example (sqlite mode):
```json
{
  "status": "ok",
  "storage_mode": "sqlite",
  "langgraph_db_path": "./langgraph_checkpoints.db",
  "sensor_reachable": false,
  "last_sensor_success_at": null
}
```

Example (postgres mode):
```json
{
  "status": "ok",
  "storage_mode": "postgres",
  "langgraph_db_path": null,
  "sensor_reachable": true,
  "last_sensor_success_at": "2026-02-23T16:22:24.358257+00:00"
}
```

## 10. Environment Variables
Use `/Users/tejaswath/projects/carbon_advisor/.env.example` and `/Users/tejaswath/projects/carbon_advisor/frontend/.env.example`.

### 10.1 Backend env (`.env`)

Required:
- `ELECTRICITYMAPS_KEY`

Optional but supported:
- `OPENAI_API_KEY`
- `OPENAI_MODEL` (default `gpt-4o-mini`)

Routing/runtime controls:
- `CORS_ORIGINS` (CSV, default `http://localhost:3000`; trailing `/` is stripped during config load to avoid CORS exact-match issues)
- `GRID_ZONE` (default `SE-SE3`)
- `CARBON_THRESHOLD` (default `40`)
- `ROUTING_CANDIDATE_ZONES`
- `MAX_ROUTING_CANDIDATES` (default `6`)
- `CANDIDATE_FETCH_MODE` (`sequential` or `parallel`, default `sequential`)
- `PARALLEL_FETCH_WORKERS` (default `3`)
- `ENABLE_POSTPONE_FORECAST_RECOMMENDATION` (default `false`)
- `REQUEST_TIMEOUT_SECONDS` (default `10`)
- `CACHE_TTL_SECONDS` (default `300`)
- `RETRY_MAX_ATTEMPTS` (default `3`)
- `LLM_AUDIT_TIMEOUT_SECONDS` (default `5`; hard cap for LLM audit generation before template fallback)
- `DATABASE_URL` (optional; when set, backend uses async Postgres checkpointer)
- `LANGGRAPH_DB_PATH` (default `./langgraph_checkpoints.db`; used when `DATABASE_URL` is not set)

Persistence precedence:
1. If `DATABASE_URL` is set, backend uses `AsyncPostgresSaver`.
2. If `DATABASE_URL` is empty, backend uses `AsyncSqliteSaver` on `LANGGRAPH_DB_PATH`.

Database URL normalization:
- `DATABASE_URL` values starting with `postgres://` are normalized to `postgresql://` automatically.

Legacy/unused in active routing flow:
- `FORECAST_WINDOW_HOURS` (see Future Work section)

Recommended Azure tuning profile (reduce long-tail latency):
- `CANDIDATE_FETCH_MODE=parallel`
- `MAX_ROUTING_CANDIDATES=4`
- `REQUEST_TIMEOUT_SECONDS=6`
- `RETRY_MAX_ATTEMPTS=2`
- `LLM_AUDIT_TIMEOUT_SECONDS=5`

### 10.2 Frontend env (`frontend/.env.local`)
- `NEXT_PUBLIC_API_BASE_URL` (default `http://localhost:8000/api/v1`)
- `NEXT_PUBLIC_PRIMARY_ZONES` (CSV for dropdown options)
- `NEXTAUTH_URL` (for local dev: `http://localhost:3000`; in production use deployed frontend URL)
- `NEXTAUTH_SECRET` (random secret for JWT/session encryption)
- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`
- `GITHUB_CLIENT_ID` (optional; required only when enabling GitHub sign-in)
- `GITHUB_CLIENT_SECRET` (optional; required only when enabling GitHub sign-in)

### 10.3 OAuth callback configuration
Google OAuth app:
- Authorized origins:
  - `http://localhost:3000`
  - `https://carbon-aware-advisor.vercel.app`
- Redirect URIs:
  - `http://localhost:3000/api/auth/callback/google`
  - `https://carbon-aware-advisor.vercel.app/api/auth/callback/google`

GitHub OAuth app:
- Homepage URL:
  - `http://localhost:3000` (local app during development)
  - `https://carbon-aware-advisor.vercel.app` (production app)
- Authorization callback URL:
  - `http://localhost:3000/api/auth/callback/github`
  - `https://carbon-aware-advisor.vercel.app/api/auth/callback/github`

## 11. Local Development and Runbook

### 11.1 Backend
```bash
cd /Users/tejaswath/projects/carbon_advisor
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
uvicorn backend.app.main:app --reload --port 8000
```

### 11.1a Optional local Postgres (Docker/OrbStack)
Use this when you want checkpoint persistence on Postgres locally.

```bash
cd /Users/tejaswath/projects/carbon_advisor
docker compose up -d db
```

Set in `.env`:
```env
DATABASE_URL=postgresql://admin:password@localhost:5432/carbon_db
```

Then restart backend and verify startup log:
- `Checkpoint storage initialized in postgres mode (DATABASE_URL configured).`

Optional API verification:
- `curl http://localhost:8000/api/v1/health` should return `"storage_mode":"postgres"` when `DATABASE_URL` is set.
- health payload also includes sensor telemetry (`sensor_reachable`, `last_sensor_success_at`).

### 11.2 Frontend
```bash
cd /Users/tejaswath/projects/carbon_advisor/frontend
cp .env.example .env.local
npm install
npm run dev
```

### 11.3 Open UI
- [http://localhost:3000](http://localhost:3000)
- If not authenticated, frontend redirects to `/login`.
- Sign in with configured provider (Google, and optionally GitHub if env is set).

### 11.4 Azure + Vercel Deployment Runbook

Use the dedicated step-by-step deployment guide:

- `/Users/tejaswath/projects/carbon_advisor/deploy/azure_vercel_phase2.md`

App Service environment template:

- `/Users/tejaswath/projects/carbon_advisor/deploy/appservice_settings.env.example`

Post-deploy smoke check command:

```bash
bash /Users/tejaswath/projects/carbon_advisor/scripts/smoke_prod.sh \
  "https://<your-frontend>.vercel.app" \
  "https://<your-backend>.azurewebsites.net/api/v1"
```

## 12. Testing

Backend/unit tests:
```bash
cd /Users/tejaswath/projects/carbon_advisor
source .venv/bin/activate
PYTHONPATH=. pytest -q
```

Frontend type/build verification:
```bash
cd /Users/tejaswath/projects/carbon_advisor/frontend
npm run build
```

## 13. Demo Playbook (Interview-Ready)

Recommended flow:
1. Run `Demo: Grid Clean` and show automatic local execution.
2. Run `Demo: Route Available` and choose `route`.
3. Run `Demo: Needs Approval` and choose `postpone`.
4. Expand timeline events to explain decision trace.
5. Download CSV and show governance fields (`manager_id`, `override_reason`, action trail).
6. Run one live decision and compare behavior versus deterministic demo mode.

Manual UX validation scenarios:
1. Leading-zero normalization:
   - Enter `01500` in kWh and blur; it should normalize to `1500`.
   - Enter `030` in threshold and blur; it should normalize to `30`.
2. Clean local where candidates exist:
   - Trigger `Demo: Grid Clean`.
   - Confirm `policy_action=run_now_local` and `execution_mode=local`.
   - Confirm `routing_top3` contains valid candidates.
   - Verify the tradeoff table `Route` row still shows a candidate zone and route latency/residency context (carbon may remain `N/A` only when routed kgCO2 is truly unavailable).
3. Routeable dirty with route:
   - Trigger `Demo: Route Available`, then choose `route`.
   - Verify route row and savings card represent realized routing outcome (`Routing Savings`, green).
4. Routeable dirty with local override:
   - Trigger `Demo: Route Available`, then choose `run_local`.
   - Verify route row still reflects available route context and savings card shows `Foregone Savings` (amber) when savings > 0.
5. Non-routeable dirty with postpone:
   - Trigger `Demo: Needs Approval`, then choose `postpone`.
   - Verify postpone status and tradeoff-section forecast guidance/fallback messaging.
6. Live path safety:
   - Trigger `Evaluate and decide (Live)`.
   - Verify no crashes and neutral savings styling for clean local outcomes without positive savings.
7. Dark mode quality:
   - Toggle dark mode from header.
   - Verify primary CTA remains clearly visible in both enabled and disabled states.
   - Verify Help modal readability and backdrop layering (no background bleed-through).
8. Approval briefing and copy:
   - Trigger `Demo: Route Available` until `awaiting_approval`.
   - Confirm `Decision Briefing` shows local/routed/savings values before action buttons.
   - Confirm no raw enum strings (for example `route_to_clean_region`, `run_local`) appear in user-facing prompt text.
9. Audit formatting:
   - Complete any decision with `audit_mode=llm`.
   - Confirm audit text renders without raw markdown markers such as `**...**`.

Acceptance criterion addendum:
1. `Execution Tradeoff Comparison` must render candidate-based route context for all policy branches (`run_now_local`, `route_to_clean_region`, `require_manager_decision`) whenever a valid non-primary candidate exists.

## 14. Operational Notes

- Startup validates write access for checkpoint DB directory (SQLite mode only).
- Docker image hygiene is enforced with root-level `.dockerignore` so local secrets and large dev artifacts are not copied into image layers.
- Legacy Gradio dependency was removed from default runtime requirements; active runtime path is FastAPI + Next.js only.
- Checkpointer storage is async in both modes:
  - SQLite fallback: `AsyncSqliteSaver`
  - Postgres: `AsyncPostgresSaver` + `psycopg_pool.AsyncConnectionPool`
- Startup logs storage mode explicitly:
  - `Checkpoint storage initialized in postgres mode (DATABASE_URL configured).`
  - `Checkpoint storage initialized in sqlite mode (LANGGRAPH_DB_PATH=...)`
- CORS is configured via `CORS_ORIGINS` env var.
- For SQLite mode, mount persistent writable storage and point `LANGGRAPH_DB_PATH` to it.
- For multi-worker/high-throughput deployment, prefer Postgres mode.
- Current frontend status tracking uses polling; a V2 transport can move to SSE/WebSocket push updates to reduce polling overhead and improve responsiveness.
- `/api/v1/health` includes dependency-level sensor telemetry:
  - `sensor_reachable`
  - `last_sensor_success_at`

### 14.1 Async Postgres migration status (current stable state)

What is fully implemented:
- Async checkpointer support for both storage backends:
  - `AsyncSqliteSaver` fallback when `DATABASE_URL` is empty.
  - `AsyncPostgresSaver` with `psycopg_pool.AsyncConnectionPool` when `DATABASE_URL` is set.
- `DATABASE_URL` normalization (`postgres://` -> `postgresql://`).
- CORS origin normalization (trailing `/` stripped).
- Startup mode logging so runtime storage backend is explicit.
- Async FastAPI route handlers and async `WorkflowService` public methods.

What is intentionally hybrid (by design for stability):
- LangGraph execution currently runs through sync graph calls (`stream` / `get_state`) wrapped via `asyncio.to_thread(...)` inside the async service layer.
- Reason: this avoids interrupt-context runtime failures seen with direct async graph execution in current stack (`Called get_config outside of a runnable context`).
- Net result: API layer is async-safe and non-blocking for the event loop, while graph execution is stabilized through thread offload.

What is completed for Phase 1 (infra-first):
- Runtime mode is environment-driven and working in both paths:
  - SQLite when `DATABASE_URL` is empty
  - Postgres when `DATABASE_URL` is set
- Local infra assets are in place and usable:
  - `docker-compose.yml` for local Postgres (`postgres:16-alpine`)
  - `Dockerfile` for backend container build/run
- Startup logging is explicit for runtime backend selection:
  - `Checkpoint storage initialized in sqlite mode (LANGGRAPH_DB_PATH=...)`
  - `Checkpoint storage initialized in postgres mode (DATABASE_URL configured).`

What remains outside Phase 1:
- Managed deployment wiring (Render/Railway Postgres + backend service secrets).
- Optional move from hybrid graph execution (`to_thread` around `stream/get_state`) to fully native async graph execution once interrupt-context behavior is stable in stack versions.

How to confirm current mode quickly:
- `GET /api/v1/health` reports the runtime backend directly:
  - `"storage_mode":"sqlite"` + non-null `langgraph_db_path`
  - `"storage_mode":"postgres"` + `langgraph_db_path: null`
- Start backend and read startup logs:
  - `Checkpoint storage initialized in sqlite mode ...` => `DATABASE_URL` is not set (or empty).
  - `Checkpoint storage initialized in postgres mode ...` => Postgres path is active.
- Use startup logs as a secondary confirmation during deployment debugging.

### 14.2 Phase 1 completion checklist

Phase 1 is considered complete when all checks pass:
1. Backend starts without checkpointer errors.
2. Startup log shows desired mode:
   - sqlite mode when `DATABASE_URL` is empty, or
   - postgres mode when `DATABASE_URL` is set.
3. `GET /api/v1/health` returns `{"status":"ok", ...}`.
   - sqlite mode -> includes sqlite path
   - postgres mode -> returns `storage_mode:"postgres"` and null sqlite path
4. Decision flow works end-to-end (`start` -> `poll` -> manager action where needed).
5. Backend tests pass (`37 passed`) and frontend production build passes.

Common troubleshooting:
- If UI shows `Failed to fetch`, first verify backend is running and reachable at `NEXT_PUBLIC_API_BASE_URL`.
- If start works but polling fails, check backend logs for checkpointer mode and initialization errors.
- Ensure `CORS_ORIGINS` uses origins without trailing slash (normalization now helps, but explicit clean values are still recommended).
- If you see `Called get_config outside of a runnable context`, update to the latest backend revision and restart Uvicorn; manager-interrupt nodes must run through the sync LangGraph execution path (`stream/get_state`) wrapped in `asyncio.to_thread(...)` inside the async service layer.

### 14.3 Latency controls and expectations

Why live requests can feel slow:
- Candidate zone fan-out can require several external API calls.
- Retries/backoff are intentionally enabled for transient dependency failures.
- LLM audit generation can add tail latency when model response time spikes.
- Cloud cold starts (especially lower-cost tiers) can add startup delay.

Safe latency controls implemented:
- `LLM_AUDIT_TIMEOUT_SECONDS` hard-caps LLM audit generation.
- On LLM timeout/error, audit generation falls back to template mode automatically.
- No lock/threading model changes are required for these latency controls.

Typical observed ranges (with tuned Azure profile):
- Demo scenarios: `~1-3s`
- Live decisions (warm app): `~4-8s`
- Live decisions (cold start or upstream slowness): can exceed `10s`

If you see repeated `>10s` live responses:
1. Use the recommended Azure tuning profile in section 10.1.
2. Confirm app is warm (cold starts are common on cost-optimized plans).
3. Check dependency latency in logs (Electricity Maps and OpenAI).

## 15. Implemented but Not Yet Integrated (Future Work)

The following items are already present in code/config scaffolding but are not currently part of the active routing-first user journey, or are not enabled by default:

### 15.1 Forecast retrieval pipeline (implemented, feature-flagged)
- `src/sensor.py` includes `get_carbon_intensity_forecast(...)` with parsing, filtering, caching, retries.
- `src/config.py` includes `FORECAST_WINDOW_HOURS`.
- `src/config.py` includes `ENABLE_POSTPONE_FORECAST_RECOMMENDATION` (default `false`).
- `src/models.py` includes `ForecastPoint` and `ForecastResult`.
- `tests/test_sensor.py` includes forecast tests.

Current status: postpone flow can request forecast guidance when `ENABLE_POSTPONE_FORECAST_RECOMMENDATION=true`; default remains off for entitlement safety and deterministic baseline demos.

### 15.2 Parallel candidate fetch mode (implemented, disabled by default)
- `src/sensor.py` has `_fetch_parallel(...)` and parity tests.
- Config supports `CANDIDATE_FETCH_MODE=parallel` and `PARALLEL_FETCH_WORKERS`.

Current status: default remains `sequential` for quota/rate safety unless env is changed.

### 15.3 Legacy Gradio app path (present but out of parity)
- Legacy Gradio prototype is isolated at `/Users/tejaswath/projects/carbon_advisor/legacy/gradio_app.py`.
- Root `/Users/tejaswath/projects/carbon_advisor/app.py` is now a minimal pointer/stub to avoid reviewer confusion.

Current status: main product path is FastAPI + Next.js, not Gradio.

### 15.4 Data-source expansion not yet integrated
Electricity Maps supports broader signals and endpoints beyond current flow (forecast entitlements, mix/load/price/LMP/data-center optimizers), but these are not integrated into active decision policy.

### 15.5 Advanced geo selection is heuristic-only
- Current geolocation suggestion maps coordinates to Swedish zones via simple bounding heuristics.

Current status: no reverse geocoding provider or zone-resolution endpoint integration yet.

### 15.6 Multi-tenant auth and role model
- Federated login is implemented (Google, optional GitHub) with JWT sessions and route protection.
- Still deferred:
  - role-based authorization (for example approver vs observer roles),
  - organization/tenant boundaries,
  - signed audit attestations and enterprise SSO (SAML/OIDC) integration.

### 15.7 Minimum routing improvement threshold
- Current routing policy routes whenever a candidate satisfies threshold compliance.
- A V2 policy refinement can require a minimum improvement delta (for example, at least 20% lower than local intensity) before recommending routing, to avoid low-value reroutes.

## 16. Known Constraints
- Live behavior depends on token permissions and zone coverage for `latest`.
- Routing recommendation is advisory; manager can override.
- No commercial entitlements handling is embedded; this repo assumes your key has required access.
- Demo scenarios intentionally use synthetic values and should be labeled as demo mode during presentations.
