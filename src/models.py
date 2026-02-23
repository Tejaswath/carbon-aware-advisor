from typing import Literal, Optional, TypedDict


DemoScenario = Literal["clean_local", "routeable_dirty", "non_routeable_dirty"]


class SensorLatestResult(TypedDict):
    ok: bool
    zone: str
    intensity: Optional[int]
    timestamp: Optional[str]
    error: Optional[str]


class ForecastPoint(TypedDict):
    datetime: str
    carbonIntensity: int


class ForecastResult(TypedDict):
    ok: bool
    zone: str
    points: list[ForecastPoint]
    best_point: Optional[ForecastPoint]
    error: Optional[str]


class CandidateIntensity(TypedDict):
    zone: str
    ok: bool
    carbonIntensity: Optional[int]
    datetime: Optional[str]
    error: Optional[str]


class TimelineEvent(TypedDict):
    ts: str
    stage: str
    message: str
    data: dict


class PolicyDecision(TypedDict):
    label: Literal["clean", "dirty"]
    action: Literal["run_now_local", "route_to_clean_region", "require_manager_decision"]
    reason: str
