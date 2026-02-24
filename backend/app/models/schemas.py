from typing import Any, Literal

from pydantic import BaseModel, Field


DecisionStatus = Literal["processing", "awaiting_approval", "completed", "postponed", "error"]


class StartDecisionRequest(BaseModel):
    estimated_kwh: float = Field(..., gt=0)
    threshold: int | None = Field(default=None, ge=1)
    zone: str | None = None
    demo_scenario: Literal["clean_local", "routeable_dirty", "non_routeable_dirty"] | None = None


class ManagerActionRequest(BaseModel):
    manager_id: str = Field(..., min_length=1, max_length=120)
    override_reason: str | None = Field(default=None, max_length=500)


class RoutingCandidateResponse(BaseModel):
    zone: str
    carbonIntensity: int | None = None
    datetime: str | None = None
    ok: bool
    error: str | None = None


class TimelineEventResponse(BaseModel):
    ts: str
    stage: str
    message: str
    data: dict[str, Any] = Field(default_factory=dict)


class DecisionResponse(BaseModel):
    decision_id: str
    status: DecisionStatus
    primary_zone: str
    primary_intensity: int | None = None
    selected_execution_zone: str | None = None
    selected_execution_intensity: int | None = None
    execution_mode: Literal["local", "routed", "postponed"] | None = None
    policy_action: Literal["run_now_local", "route_to_clean_region", "require_manager_decision"] | None = None
    policy_reason: str | None = None
    estimated_kgco2_local: float | None = None
    estimated_kgco2_routed: float | None = None
    estimated_kgco2_saved_by_routing: float | None = None
    accounting_method: Literal["location-based"] = "location-based"
    manager_options: list[Literal["run_local", "route", "postpone"]] = Field(default_factory=list)
    manager_prompt: str | None = None
    manager_id: str | None = None
    override_reason: str | None = None
    forecast_recommendation: str | None = None
    audit_mode: Literal["llm", "template", "pending"] | None = None
    audit_report: str | None = None
    routing_top3: list[RoutingCandidateResponse] = Field(default_factory=list)
    timeline: list[TimelineEventResponse] = Field(default_factory=list)
    forecast_available: bool = False
    error: str | None = None


class HealthResponse(BaseModel):
    status: Literal["ok"]
    storage_mode: Literal["sqlite", "postgres"]
    langgraph_db_path: str | None = None
    sensor_reachable: bool = False
    last_sensor_success_at: str | None = None
