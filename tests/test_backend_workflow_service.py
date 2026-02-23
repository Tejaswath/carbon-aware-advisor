import asyncio
from types import SimpleNamespace

import pytest

from backend.app.services.workflow_service import (
    DecisionNotFoundError,
    InvalidDecisionTransitionError,
    WorkflowService,
)


class DummyInterrupt:
    def __init__(self, value):
        self.value = value


class DummyTask:
    def __init__(self, value):
        self.interrupts = [DummyInterrupt(value)]


class DummyGraph:
    def __init__(self, pending_options: list[str] | None = None):
        self.pending_options = pending_options or []
        self.snapshots = {}

    def stream(self, payload, config):
        decision_id = config["configurable"]["thread_id"]
        if isinstance(payload, dict):
            tasks = ()
            if self.pending_options:
                tasks = (DummyTask({"question": "Manager decision needed", "options": self.pending_options}),)
            policy_action = None
            if "route" in self.pending_options:
                policy_action = "route_to_clean_region"
            elif self.pending_options:
                policy_action = "require_manager_decision"
            self.snapshots[decision_id] = SimpleNamespace(
                values={
                    "primary_zone": payload.get("zone", "SE-SE3"),
                    "primary_intensity": 62,
                    "routing_top3": [{"zone": "NO-NO1", "ok": True, "carbonIntensity": 18, "datetime": "2026-02-20T01:00:00Z", "error": None}],
                    "job_status": "pending",
                    "timeline": [],
                    "policy_action": policy_action,
                    "threshold": payload.get("threshold", 40),
                    "estimated_kwh": payload.get("estimated_kwh", 100),
                },
                tasks=tasks,
                next=("human_decision_routeable",) if tasks else ("compute_metrics",),
            )
        else:
            resume_payload = getattr(payload, "resume", None)
            decision = "route"
            manager_id = None
            override_reason = None
            if isinstance(resume_payload, dict):
                decision = str(resume_payload.get("decision", "route"))
                manager_id = resume_payload.get("manager_id")
                override_reason = resume_payload.get("override_reason")
            elif isinstance(resume_payload, str):
                decision = resume_payload

            execution_mode = "routed"
            selected_execution_zone = "NO-NO1"
            selected_execution_intensity = 18
            job_status = "completed"
            if decision == "run_local":
                execution_mode = "local"
                selected_execution_zone = "SE-SE3"
                selected_execution_intensity = 62
            elif decision == "postpone":
                execution_mode = "postponed"
                selected_execution_zone = None
                selected_execution_intensity = None
                job_status = "postponed"

            self.snapshots[decision_id] = SimpleNamespace(
                values={
                    "primary_zone": "SE-SE3",
                    "primary_intensity": 62,
                    "selected_execution_zone": selected_execution_zone,
                    "selected_execution_intensity": selected_execution_intensity,
                    "execution_mode": execution_mode,
                    "policy_action": "route_to_clean_region",
                    "policy_reason": "Route to clean region",
                    "estimated_kgco2_local": 6.2,
                    "estimated_kgco2_routed": 1.8,
                    "estimated_kgco2_saved_by_routing": 4.4,
                    "forecast_available": decision == "postpone",
                    "forecast_recommendation": (
                        "Grid expected below threshold at 2026-02-20T03:00:00+00:00."
                        if decision == "postpone"
                        else None
                    ),
                    "routing_top3": [{"zone": "NO-NO1", "ok": True, "carbonIntensity": 18, "datetime": "2026-02-20T01:00:00Z", "error": None}],
                    "timeline": [],
                    "job_status": job_status,
                    "audit_mode": "template",
                    "audit_report": "ok",
                    "threshold": 40,
                    "estimated_kwh": 100,
                    "manager_decision": decision,
                    "manager_id": manager_id,
                    "override_reason": override_reason,
                    "created_at_utc": "2026-02-20T00:00:00+00:00",
                    "completed_at_utc": "2026-02-20T00:05:00+00:00",
                },
                tasks=(),
                next=(),
            )
        yield {"ok": True}

    async def astream(self, payload, config):
        for item in self.stream(payload, config):
            yield item

    async def aget_state(self, config):
        return self.get_state(config)

    def get_state(self, config):
        decision_id = config["configurable"]["thread_id"]
        return self.snapshots.get(decision_id, SimpleNamespace(values={}, tasks=(), next=()))


def _run(coro):
    return asyncio.run(coro)


def test_get_decision_not_found(monkeypatch):
    monkeypatch.setattr("backend.app.services.workflow_service.build_graph", lambda checkpointer: DummyGraph())
    service = WorkflowService(checkpointer=object())
    with pytest.raises(DecisionNotFoundError):
        _run(service.get_decision("missing"))


def test_start_and_get_processing(monkeypatch):
    monkeypatch.setattr("backend.app.services.workflow_service.build_graph", lambda checkpointer: DummyGraph())
    service = WorkflowService(checkpointer=object())

    decision_id = service.create_decision_id()
    _run(service.start_decision(decision_id, estimated_kwh=100, threshold=40, zone="SE-SE3"))
    result = _run(service.get_decision(decision_id))

    assert result.decision_id == decision_id
    assert result.status == "processing"
    assert result.primary_zone == "SE-SE3"


def test_run_local_requires_pending_interrupt(monkeypatch):
    monkeypatch.setattr("backend.app.services.workflow_service.build_graph", lambda checkpointer: DummyGraph())
    service = WorkflowService(checkpointer=object())

    decision_id = service.create_decision_id()
    _run(service.start_decision(decision_id, estimated_kwh=100, threshold=40, zone="SE-SE3"))
    with pytest.raises(InvalidDecisionTransitionError):
        _run(service.run_local_decision(decision_id, manager_id="manager@example.com"))


def test_route_when_pending(monkeypatch):
    monkeypatch.setattr(
        "backend.app.services.workflow_service.build_graph",
        lambda checkpointer: DummyGraph(pending_options=["run_local", "route", "postpone"]),
    )
    service = WorkflowService(checkpointer=object())

    decision_id = service.create_decision_id()
    _run(service.start_decision(decision_id, estimated_kwh=100, threshold=40, zone="SE-SE3"))
    result = _run(service.route_decision(decision_id, manager_id="manager@example.com"))

    assert result.status == "completed"
    assert result.execution_mode == "routed"
    assert result.selected_execution_zone == "NO-NO1"
    assert result.manager_id == "manager@example.com"


def test_override_reason_required_when_overriding_route_recommendation(monkeypatch):
    monkeypatch.setattr(
        "backend.app.services.workflow_service.build_graph",
        lambda checkpointer: DummyGraph(pending_options=["run_local", "route", "postpone"]),
    )
    service = WorkflowService(checkpointer=object())

    decision_id = service.create_decision_id()
    _run(service.start_decision(decision_id, estimated_kwh=100, threshold=40, zone="SE-SE3"))

    with pytest.raises(InvalidDecisionTransitionError):
        _run(service.run_local_decision(decision_id, manager_id="manager@example.com"))


def test_non_routeable_manager_action_does_not_require_override_reason(monkeypatch):
    monkeypatch.setattr(
        "backend.app.services.workflow_service.build_graph",
        lambda checkpointer: DummyGraph(pending_options=["run_local", "postpone"]),
    )
    service = WorkflowService(checkpointer=object())

    decision_id = service.create_decision_id()
    _run(service.start_decision(decision_id, estimated_kwh=100, threshold=40, zone="SE-SE3"))
    result = _run(service.run_local_decision(decision_id, manager_id="manager@example.com"))

    assert result.status == "completed"
    assert result.execution_mode == "local"
    assert result.manager_id == "manager@example.com"


def test_get_audit_csv(monkeypatch):
    monkeypatch.setattr("backend.app.services.workflow_service.build_graph", lambda checkpointer: DummyGraph())
    service = WorkflowService(checkpointer=object())

    decision_id = service.create_decision_id()
    _run(service.start_decision(decision_id, estimated_kwh=100, threshold=40, zone="SE-SE3"))
    _run(service._run_to_boundary(decision_id, object()))

    csv_text = _run(service.get_audit_csv(decision_id))
    assert "decision_id,status,primary_zone" in csv_text
    assert "accounting_method" in csv_text
    assert "manager_id" in csv_text
    assert "override_reason" in csv_text
    assert decision_id in csv_text


def test_postpone_response_includes_forecast_recommendation(monkeypatch):
    monkeypatch.setattr(
        "backend.app.services.workflow_service.build_graph",
        lambda checkpointer: DummyGraph(pending_options=["run_local", "route", "postpone"]),
    )
    service = WorkflowService(checkpointer=object())

    decision_id = service.create_decision_id()
    _run(service.start_decision(decision_id, estimated_kwh=100, threshold=40, zone="SE-SE3"))
    result = _run(
        service.postpone_decision(
            decision_id,
            manager_id="manager@example.com",
            override_reason="Maintenance blackout",
        )
    )

    assert result.status == "postponed"
    assert result.execution_mode == "postponed"
    assert result.forecast_available is True
    assert result.forecast_recommendation is not None
