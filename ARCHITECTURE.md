# Production Scaling Narrative

This document describes how the current Carbon-Aware Compute Advisor architecture works in production today, where the current limits are, and the planned upgrade path.

## 1) Current Runtime Architecture

## 1.1 Request flow
1. Frontend (Next.js on Vercel) sends `start` and `poll` requests to FastAPI.
2. FastAPI delegates decision execution to `WorkflowService`.
3. `WorkflowService` runs LangGraph with checkpoint persistence.
4. Sensor calls use Electricity Maps latest intensity and candidate lookups.
5. Policy determines local, route, or manager approval.
6. Manager actions resume the same checkpointed thread.
7. Audit report and timeline finalize outputs.

## 1.2 Persistence and deployment
1. Checkpoint persistence supports:
   - Async SQLite fallback for local/dev.
   - Async Postgres (`AsyncPostgresSaver`) for cloud/runtime.
2. Current cloud target:
   - Backend: Azure App Service.
   - DB: Azure PostgreSQL Flexible Server.
   - Frontend: Vercel.

## 1.3 Concurrency model (current)
1. API handlers are async.
2. LangGraph execution is intentionally run through sync graph calls wrapped with `asyncio.to_thread(...)`.
3. A single `asyncio.Lock()` in `WorkflowService` serializes graph access.

Rationale:
- This preserves interrupt/resume context correctness in the current stack.
- It avoids known runnable-context failures observed with direct async graph execution in this project.

## 2) Known Limits in Current Design

1. Global lock limits parallel decision throughput.
2. Polling introduces repeated HTTP load and delayed UX updates.
3. Retry/backoff is request-level only; no explicit circuit-breaker state machine yet.
4. Emissions estimates are location-based and point-in-time.

These are acceptable tradeoffs for interview demo scope and reliability.

## 3) Concurrency Upgrade Path

## 3.1 Global lock -> per-decision lock
Target:
- Replace one global lock with `dict[decision_id, asyncio.Lock]`.

Expected effect:
1. Concurrent decisions can progress independently.
2. Poll/read for one decision is not blocked by unrelated decision execution.

Implementation notes:
1. Create lock lazily per decision ID.
2. Garbage-collect old locks after terminal states.
3. Keep internal safety around shared in-memory maps (`_known_decisions`, `_in_progress`, `_errors`).

## 3.2 Optional worker model
If throughput requirements increase:
1. Keep API stateless.
2. Offload execution to queue workers.
3. Continue using Postgres checkpoints as thread state source of truth.

## 4) Transport Upgrade Path (Polling -> SSE)

Current:
- Frontend polls `GET /decisions/{id}` every 2 seconds.

Target:
- Add Server-Sent Events endpoint streaming stage/status updates.

Benefits:
1. Lower poll overhead.
2. Faster UI updates.
3. Better multi-client observer behavior.

Fallback:
- Keep polling as compatibility mode when SSE is unavailable.

## 5) Reliability Upgrade Path (Circuit Breaker)

Current:
- Sensor layer has retry + exponential backoff + cache.

Target:
- Add circuit-breaker behavior for repeated dependency failures.

Policy:
1. Open breaker after repeated 429/5xx/network failures in time window.
2. Short-circuit calls while open.
3. Half-open probe after cooldown.
4. Close breaker on successful probes.

User impact:
- Health endpoint exposes dependency status.
- UI can render explicit dependency degradation states.

## 6) Carbon Accounting Roadmap

Current:
1. Location-based accounting only.
2. Point-in-time intensity estimate.

Future:
1. Time-windowed intensity integration by job duration.
2. Market-based accounting fields and disclosure.
3. Optional policy threshold for minimum routing improvement delta.

## 7) Observability and Health Semantics

Current health response includes:
1. Service status.
2. Storage mode (`sqlite` or `postgres`).
3. SQLite path (when relevant).
4. Sensor telemetry (`sensor_reachable`, `last_sensor_success_at`).

Next observability steps (deferred):
1. Structured logs with `decision_id` correlation.
2. Metrics counters for success/error/approval paths.
3. Alerting thresholds for dependency failures and workflow errors.

## 8) Why this scope is intentional

This project is optimized for interview-readiness:
1. Demonstrates real orchestration and HITL governance.
2. Uses production-grade persistence and deployment primitives.
3. Documents scaling and reliability evolution clearly.

It does not over-implement enterprise features that are not required to prove system design capability in portfolio review.
