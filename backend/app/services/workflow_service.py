from __future__ import annotations

import asyncio
import csv
import io
import uuid
from typing import Any

from langgraph.types import Command

from backend.app.models.schemas import DecisionResponse
from src.agent import (
    build_graph,
    create_initial_state,
    extract_interrupt_options,
    extract_interrupt_question,
)
from src.config import settings


class DecisionNotFoundError(Exception):
    pass


class InvalidDecisionTransitionError(Exception):
    pass


class WorkflowService:
    def __init__(self, checkpointer: Any):
        self._graph = build_graph(checkpointer=checkpointer)
        self._lock = asyncio.Lock()
        self._known_decisions: set[str] = set()
        self._in_progress: set[str] = set()
        self._errors: dict[str, str] = {}

    def create_decision_id(self) -> str:
        return f"decision-{uuid.uuid4().hex}"

    async def start_decision(
        self,
        decision_id: str,
        estimated_kwh: float,
        threshold: int | None,
        zone: str | None,
        demo_scenario: str | None = None,
    ) -> None:
        selected_threshold = threshold if threshold is not None else settings.carbon_threshold
        selected_zone = (zone or settings.grid_zone).strip() or settings.grid_zone
        initial_state = create_initial_state(
            zone=selected_zone,
            threshold=selected_threshold,
            estimated_kwh=estimated_kwh,
            demo_scenario=demo_scenario,
        )

        self._known_decisions.add(decision_id)
        self._errors.pop(decision_id, None)
        await self._run_to_boundary(decision_id, initial_state)

    async def run_local_decision(
        self, decision_id: str, manager_id: str, override_reason: str | None = None
    ) -> DecisionResponse:
        return await self._resume_manager_decision(decision_id, "run_local", manager_id, override_reason)

    async def route_decision(
        self, decision_id: str, manager_id: str, override_reason: str | None = None
    ) -> DecisionResponse:
        return await self._resume_manager_decision(decision_id, "route", manager_id, override_reason)

    async def postpone_decision(
        self, decision_id: str, manager_id: str, override_reason: str | None = None
    ) -> DecisionResponse:
        return await self._resume_manager_decision(decision_id, "postpone", manager_id, override_reason)

    def processing_response(self, decision_id: str, primary_zone: str) -> DecisionResponse:
        return DecisionResponse(
            decision_id=decision_id,
            status="processing",
            primary_zone=primary_zone,
            accounting_method="location-based",
            forecast_recommendation=None,
            forecast_available=False,
        )

    async def get_decision(self, decision_id: str) -> DecisionResponse:
        snapshot = await self._snapshot(decision_id)
        values = dict(getattr(snapshot, "values", {}) or {})

        is_empty = not values and not getattr(snapshot, "tasks", ()) and not getattr(snapshot, "next", ())
        has_error = decision_id in self._errors
        is_known = decision_id in self._known_decisions
        is_running = decision_id in self._in_progress

        if is_empty and not is_known and not has_error and not is_running:
            raise DecisionNotFoundError(f"Decision '{decision_id}' was not found.")

        question = extract_interrupt_question(snapshot)
        options = extract_interrupt_options(snapshot)
        job_status = values.get("job_status")

        status = "processing"
        if has_error:
            status = "error"
        elif question:
            status = "awaiting_approval"
        elif job_status == "completed":
            status = "completed"
        elif job_status == "postponed":
            status = "postponed"

        state_errors = values.get("errors") or []
        error_message = self._errors.get(decision_id)
        if not error_message and state_errors:
            error_message = "; ".join(str(item) for item in state_errors if item)

        routing_top3 = self._candidate_list(values.get("routing_top3") or [])
        timeline = values.get("timeline") or []

        return DecisionResponse(
            decision_id=decision_id,
            status=status,
            primary_zone=str(values.get("primary_zone") or values.get("zone") or settings.grid_zone),
            primary_intensity=values.get("primary_intensity"),
            selected_execution_zone=values.get("selected_execution_zone"),
            selected_execution_intensity=values.get("selected_execution_intensity"),
            execution_mode=values.get("execution_mode"),
            policy_action=values.get("policy_action"),
            policy_reason=values.get("policy_reason"),
            estimated_kgco2_local=values.get("estimated_kgco2_local"),
            estimated_kgco2_routed=values.get("estimated_kgco2_routed"),
            estimated_kgco2_saved_by_routing=values.get("estimated_kgco2_saved_by_routing"),
            accounting_method=values.get("accounting_method", "location-based"),
            manager_options=[item for item in options if item in {"run_local", "route", "postpone"}],
            manager_prompt=question,
            manager_id=values.get("manager_id"),
            override_reason=values.get("override_reason"),
            forecast_recommendation=values.get("forecast_recommendation"),
            audit_mode=values.get("audit_mode") or ("pending" if status in {"processing", "awaiting_approval"} else None),
            audit_report=values.get("audit_report"),
            routing_top3=routing_top3,
            timeline=timeline,
            forecast_available=bool(values.get("forecast_available", False)),
            error=error_message,
        )

    async def get_audit_csv(self, decision_id: str) -> str:
        decision = await self.get_decision(decision_id)
        values = dict(getattr(await self._snapshot(decision_id), "values", {}) or {})

        columns = [
            "decision_id",
            "status",
            "primary_zone",
            "primary_intensity",
            "selected_execution_zone",
            "selected_execution_intensity",
            "execution_mode",
            "threshold",
            "estimated_kwh",
            "estimated_kgco2_local",
            "estimated_kgco2_routed",
            "estimated_kgco2_saved_by_routing",
            "accounting_method",
            "policy_action",
            "policy_reason",
            "manager_decision",
            "manager_id",
            "override_reason",
            "forecast_recommendation",
            "audit_mode",
            "audit_report",
            "created_at_utc",
            "completed_at_utc",
        ]

        row = {
            "decision_id": decision.decision_id,
            "status": decision.status,
            "primary_zone": decision.primary_zone,
            "primary_intensity": decision.primary_intensity,
            "selected_execution_zone": decision.selected_execution_zone,
            "selected_execution_intensity": decision.selected_execution_intensity,
            "execution_mode": decision.execution_mode,
            "threshold": values.get("threshold"),
            "estimated_kwh": values.get("estimated_kwh"),
            "estimated_kgco2_local": decision.estimated_kgco2_local,
            "estimated_kgco2_routed": decision.estimated_kgco2_routed,
            "estimated_kgco2_saved_by_routing": decision.estimated_kgco2_saved_by_routing,
            "accounting_method": decision.accounting_method,
            "policy_action": decision.policy_action,
            "policy_reason": decision.policy_reason,
            "manager_decision": values.get("manager_decision"),
            "manager_id": values.get("manager_id"),
            "override_reason": values.get("override_reason"),
            "forecast_recommendation": values.get("forecast_recommendation"),
            "audit_mode": decision.audit_mode,
            "audit_report": decision.audit_report,
            "created_at_utc": values.get("created_at_utc"),
            "completed_at_utc": values.get("completed_at_utc"),
        }

        buffer = io.StringIO()
        writer = csv.DictWriter(buffer, fieldnames=columns)
        writer.writeheader()
        writer.writerow(row)
        return buffer.getvalue()

    async def _run_to_boundary(self, decision_id: str, payload: Any) -> None:
        config = {"configurable": {"thread_id": decision_id}}
        self._in_progress.add(decision_id)
        self._errors.pop(decision_id, None)

        try:
            async with self._lock:
                await asyncio.to_thread(self._run_stream_sync, payload, config)
        except Exception as exc:
            self._errors[decision_id] = str(exc)
        finally:
            self._in_progress.discard(decision_id)

    async def _snapshot(self, decision_id: str) -> Any:
        config = {"configurable": {"thread_id": decision_id}}
        async with self._lock:
            return await asyncio.to_thread(self._graph.get_state, config)

    def _run_stream_sync(self, payload: Any, config: dict[str, Any]) -> None:
        for _ in self._graph.stream(payload, config):
            pass

    async def _assert_pending_option(self, decision_id: str, option: str) -> None:
        await self._assert_exists(decision_id)
        snapshot = await self._snapshot(decision_id)
        question = extract_interrupt_question(snapshot)
        options = extract_interrupt_options(snapshot)
        if not question:
            raise InvalidDecisionTransitionError("No pending manager approval for this decision.")
        if option not in options:
            raise InvalidDecisionTransitionError(
                f"Action '{option}' is not available for this decision. Allowed actions: {options}."
            )

    async def _resume_manager_decision(
        self,
        decision_id: str,
        action: str,
        manager_id: str,
        override_reason: str | None = None,
    ) -> DecisionResponse:
        await self._assert_pending_option(decision_id, action)
        clean_manager_id = self._clean_text(manager_id)
        if not clean_manager_id:
            raise InvalidDecisionTransitionError("manager_id is required for manager actions.")

        snapshot = await self._snapshot(decision_id)
        values = dict(getattr(snapshot, "values", {}) or {})
        recommended_action = self._recommended_action(values)
        clean_override_reason = self._clean_text(override_reason)

        if recommended_action and action != recommended_action and not clean_override_reason:
            raise InvalidDecisionTransitionError(
                "override_reason is required when manager action overrides policy recommendation."
            )

        await self._run_to_boundary(
            decision_id,
            Command(
                resume={
                    "decision": action,
                    "manager_id": clean_manager_id,
                    "override_reason": clean_override_reason,
                }
            ),
        )
        return await self.get_decision(decision_id)

    async def _assert_exists(self, decision_id: str) -> None:
        try:
            await self.get_decision(decision_id)
        except DecisionNotFoundError as exc:
            raise DecisionNotFoundError(str(exc)) from exc

    @staticmethod
    def _candidate_list(points: list[dict[str, Any]]) -> list[dict[str, Any]]:
        return [
            {
                "zone": str(item.get("zone")),
                "carbonIntensity": None if item.get("carbonIntensity") is None else int(item.get("carbonIntensity")),
                "datetime": item.get("datetime"),
                "ok": bool(item.get("ok")),
                "error": item.get("error"),
            }
            for item in points
        ]

    @staticmethod
    def _recommended_action(values: dict[str, Any]) -> str | None:
        if values.get("policy_action") == "route_to_clean_region":
            return "route"
        return None

    @staticmethod
    def _clean_text(value: str | None) -> str | None:
        if value is None:
            return None
        text = str(value).strip()
        return text or None
