from datetime import datetime, timezone
from typing import Any, Optional

from langgraph.graph import END, START, StateGraph
from langgraph.types import Command, interrupt
from typing_extensions import TypedDict

try:
    from langgraph.checkpoint.memory import MemorySaver
except ImportError:
    from langgraph.checkpoint.memory import InMemorySaver as MemorySaver

from src.auditor import generate_audit_report
from src.config import settings
from src.models import DemoScenario
from src.policy import evaluate_policy
from src.sensor import get_carbon_intensity_forecast, get_carbon_intensity_latest, get_latest_for_zones


def _now_utc_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _timeline_event(stage: str, message: str, data: Optional[dict[str, Any]] = None) -> dict[str, Any]:
    return {
        "ts": _now_utc_iso(),
        "stage": stage,
        "message": message,
        "data": data or {},
    }


def _clean_optional_text(value: Any) -> Optional[str]:
    if value is None:
        return None
    text = str(value).strip()
    return text or None


def _parse_manager_resume(payload: Any) -> tuple[str, Optional[str], Optional[str]]:
    if isinstance(payload, dict):
        decision = str(payload.get("decision", "")).strip().lower()
        manager_id = _clean_optional_text(payload.get("manager_id"))
        override_reason = _clean_optional_text(payload.get("override_reason"))
        return decision, manager_id, override_reason

    decision = str(payload).strip().lower()
    return decision, None, None


def _postpone_forecast_recommendation(zone: str, threshold: int) -> tuple[bool, Optional[str], dict[str, Any]]:
    forecast = get_carbon_intensity_forecast(zone)
    if not forecast["ok"]:
        return False, None, {"zone": zone, "error": forecast.get("error")}

    points = forecast.get("points") or []
    if not points:
        return True, None, {"zone": zone, "reason": "no_points"}

    below_threshold = [point for point in points if int(point["carbonIntensity"]) <= int(threshold)]
    if below_threshold:
        first_clean = below_threshold[0]
        recommendation = (
            f"Grid expected below threshold (~{int(first_clean['carbonIntensity'])} gCO2eq/kWh) at "
            f"{first_clean['datetime']}."
        )
        return True, recommendation, {"zone": zone, "threshold": threshold, "recommended_point": first_clean}

    best_point = forecast.get("best_point")
    if best_point is None:
        return True, None, {"zone": zone, "threshold": threshold, "reason": "no_best_point"}

    recommendation = (
        f"No hour below threshold in the next forecast window; lowest expected intensity is "
        f"{int(best_point['carbonIntensity'])} gCO2eq/kWh at {best_point['datetime']}."
    )
    return True, recommendation, {"zone": zone, "threshold": threshold, "recommended_point": best_point}


class AgentState(TypedDict):
    zone: str
    threshold: int
    estimated_kwh: float
    demo_scenario: Optional[DemoScenario]
    created_at_utc: str
    completed_at_utc: Optional[str]
    primary_zone: str
    primary_intensity: Optional[int]
    primary_timestamp: Optional[str]
    routing_candidates: list[dict[str, Any]]
    routing_top3: list[dict[str, Any]]
    recommended_route_zone: Optional[str]
    recommended_route_intensity: Optional[int]
    selected_execution_zone: Optional[str]
    selected_execution_intensity: Optional[int]
    policy_label: Optional[str]
    policy_action: Optional[str]
    policy_reason: Optional[str]
    manager_decision: Optional[str]
    manager_id: Optional[str]
    override_reason: Optional[str]
    forecast_recommendation: Optional[str]
    forecast_available: bool
    job_status: str
    execution_mode: Optional[str]
    estimated_kgco2_local: Optional[float]
    estimated_kgco2_routed: Optional[float]
    estimated_kgco2_saved_by_routing: Optional[float]
    accounting_method: str
    audit_report: Optional[str]
    audit_mode: Optional[str]
    timeline: list[dict[str, Any]]
    errors: list[str]


def create_initial_state(
    zone: str,
    threshold: int,
    estimated_kwh: float,
    demo_scenario: Optional[DemoScenario] = None,
) -> AgentState:
    created_at = _now_utc_iso()
    return {
        "zone": zone,
        "threshold": int(threshold),
        "estimated_kwh": float(estimated_kwh),
        "demo_scenario": demo_scenario,
        "created_at_utc": created_at,
        "completed_at_utc": None,
        "primary_zone": zone,
        "primary_intensity": None,
        "primary_timestamp": None,
        "routing_candidates": [],
        "routing_top3": [],
        "recommended_route_zone": None,
        "recommended_route_intensity": None,
        "selected_execution_zone": None,
        "selected_execution_intensity": None,
        "policy_label": None,
        "policy_action": None,
        "policy_reason": None,
        "manager_decision": None,
        "manager_id": None,
        "override_reason": None,
        "forecast_recommendation": None,
        "forecast_available": False,
        "job_status": "pending",
        "execution_mode": None,
        "estimated_kgco2_local": None,
        "estimated_kgco2_routed": None,
        "estimated_kgco2_saved_by_routing": None,
        "accounting_method": "location-based",
        "audit_report": None,
        "audit_mode": None,
        "timeline": [
            _timeline_event(
                "decision.started",
                "Decision initialized.",
                {
                    "zone": zone,
                    "threshold": int(threshold),
                    "estimated_kwh": float(estimated_kwh),
                    "demo_scenario": demo_scenario,
                },
            )
        ],
        "errors": [],
    }


def _normalize_candidate_zones_for_demo(primary_zone: str) -> list[str]:
    raw_zones = [primary_zone, *settings.routing_candidate_zones]
    deduped: list[str] = []
    seen: set[str] = set()

    for zone in raw_zones:
        normalized = zone.strip()
        if not normalized or normalized in seen:
            continue
        deduped.append(normalized)
        seen.add(normalized)

    if settings.max_routing_candidates > 0:
        deduped = deduped[: settings.max_routing_candidates]
    return deduped or [primary_zone]


def _build_demo_candidates(state: AgentState) -> list[dict[str, Any]]:
    scenario = state.get("demo_scenario")
    threshold = int(state["threshold"])
    primary_zone = state["primary_zone"]
    zones = _normalize_candidate_zones_for_demo(primary_zone)

    if scenario == "routeable_dirty" and all(zone == primary_zone for zone in zones):
        fallback_zone = "SE-SE1" if primary_zone != "SE-SE1" else "SE-SE2"
        zones.append(fallback_zone)

    route_target = next((zone for zone in zones if zone != primary_zone), None)
    ts = _now_utc_iso()

    candidates: list[dict[str, Any]] = []
    for index, zone in enumerate(zones):
        if scenario == "clean_local":
            intensity = max(1, threshold - 15) if zone == primary_zone else threshold + 10 + index
        elif scenario == "routeable_dirty":
            if zone == primary_zone:
                intensity = threshold + 35
            elif zone == route_target:
                intensity = max(1, threshold - 15)
            else:
                intensity = threshold + 12 + index
        else:  # non_routeable_dirty
            intensity = threshold + 20 + index

        candidates.append(
            {
                "zone": zone,
                "ok": True,
                "carbonIntensity": int(intensity),
                "datetime": ts,
                "error": None,
            }
        )

    return candidates


def check_primary_latest(state: AgentState) -> dict[str, Any]:
    if state.get("demo_scenario"):
        demo_candidates = _build_demo_candidates(state)
        primary = next((item for item in demo_candidates if item["zone"] == state["zone"]), None)
        if primary is None or primary["carbonIntensity"] is None:
            raise RuntimeError("Demo scenario failed to produce primary intensity")

        timeline = state["timeline"] + [
            _timeline_event(
                "sensor.primary",
                "Loaded synthetic primary carbon intensity for demo scenario.",
                {
                    "zone": state["zone"],
                    "intensity": int(primary["carbonIntensity"]),
                    "timestamp": primary["datetime"],
                    "source": "demo",
                    "demo_scenario": state["demo_scenario"],
                },
            )
        ]
        return {
            "primary_zone": state["zone"],
            "primary_intensity": int(primary["carbonIntensity"]),
            "primary_timestamp": primary["datetime"],
            "routing_candidates": demo_candidates,
            "timeline": timeline,
        }

    result = get_carbon_intensity_latest(state["zone"])
    if not result["ok"] or result["intensity"] is None:
        raise RuntimeError(result["error"] or "Unable to fetch latest carbon intensity")

    timeline = state["timeline"] + [
        _timeline_event(
            "sensor.primary",
            "Fetched latest carbon intensity for primary zone.",
            {
                "zone": state["zone"],
                "intensity": int(result["intensity"]),
                "timestamp": result["timestamp"],
                "source": "live",
            },
        )
    ]
    return {
        "primary_zone": state["zone"],
        "primary_intensity": int(result["intensity"]),
        "primary_timestamp": result["timestamp"],
        "timeline": timeline,
    }


def evaluate_candidates(state: AgentState) -> dict[str, Any]:
    if state.get("demo_scenario"):
        candidates = state["routing_candidates"] or _build_demo_candidates(state)
    else:
        candidates = get_latest_for_zones(zones=[state["zone"], *settings.routing_candidate_zones])
        if not any(candidate["zone"] == state["zone"] for candidate in candidates):
            primary_zone = state["primary_zone"]
            candidates = [
                {
                    "zone": primary_zone,
                    "ok": state["primary_intensity"] is not None,
                    "carbonIntensity": state["primary_intensity"],
                    "datetime": state["primary_timestamp"],
                    "error": None if state["primary_intensity"] is not None else "Primary zone latest unavailable",
                }
            ] + candidates

    valid = [
        candidate
        for candidate in candidates
        if candidate["ok"] and candidate["carbonIntensity"] is not None
    ]
    valid.sort(key=lambda item: int(item["carbonIntensity"]))

    top3 = valid[:3]
    recommended = next(
        (
            candidate
            for candidate in valid
            if candidate["zone"] != state["primary_zone"] and int(candidate["carbonIntensity"]) <= state["threshold"]
        ),
        None,
    )

    errors = list(state["errors"])
    if not valid:
        errors.append("No candidate zone intensity data available.")

    timeline = state["timeline"] + [
        _timeline_event(
            "sensor.candidates",
            "Evaluated candidate zones for routing." if not state.get("demo_scenario") else "Generated candidate zones from demo scenario.",
            {
                "evaluated_count": len(candidates),
                "valid_count": len(valid),
                "recommended_zone": None if recommended is None else recommended["zone"],
                "source": "demo" if state.get("demo_scenario") else "live",
                "demo_scenario": state.get("demo_scenario"),
            },
        )
    ]

    return {
        "routing_candidates": candidates,
        "routing_top3": top3,
        "recommended_route_zone": None if recommended is None else recommended["zone"],
        "recommended_route_intensity": None if recommended is None else int(recommended["carbonIntensity"]),
        "selected_execution_zone": None if recommended is None else recommended["zone"],
        "selected_execution_intensity": None if recommended is None else int(recommended["carbonIntensity"]),
        "errors": errors,
        "timeline": timeline,
    }


def apply_policy(state: AgentState) -> dict[str, Any]:
    decision = evaluate_policy(
        current_intensity=int(state["primary_intensity"] or 0),
        threshold=state["threshold"],
        selected_execution_zone=state["recommended_route_zone"],
        selected_execution_intensity=state["recommended_route_intensity"],
    )
    timeline = state["timeline"] + [
        _timeline_event(
            "policy.result",
            "Policy evaluated current and candidate zone conditions.",
            {
                "action": decision["action"],
                "label": decision["label"],
                "reason": decision["reason"],
            },
        )
    ]
    if decision["action"] == "route_to_clean_region":
        timeline.append(
            _timeline_event(
                "manager.prompted",
                "Manager approval required with local/route/postpone options.",
                {"options": ["run_local", "route", "postpone"]},
            )
        )
    elif decision["action"] == "require_manager_decision":
        timeline.append(
            _timeline_event(
                "manager.prompted",
                "Manager approval required with local/postpone options.",
                {"options": ["run_local", "postpone"]},
            )
        )
    precomputed_metrics = compute_metrics(state)
    return {
        "policy_label": decision["label"],
        "policy_action": decision["action"],
        "policy_reason": decision["reason"],
        "timeline": timeline,
        **precomputed_metrics,
    }


def route_after_policy(state: AgentState) -> str:
    if state["policy_action"] == "run_now_local":
        return "execute_local"
    if state["policy_action"] == "route_to_clean_region":
        return "human_decision_routeable"
    return "human_decision_no_route"


def human_decision_routeable(state: AgentState) -> Command:
    route_zone = state["recommended_route_zone"]
    route_intensity = state["recommended_route_intensity"]
    prompt = (
        f"Primary zone {state['primary_zone']} is dirty ({state['primary_intensity']} gCO2eq/kWh, "
        f"threshold {state['threshold']}). Route candidate: {route_zone} ({route_intensity} gCO2eq/kWh). "
        "Choose: run_local, route, or postpone."
    )
    payload = {
        "question": prompt,
        "options": ["run_local", "route", "postpone"],
        "recommended_action": "route",
    }
    decision, manager_id, override_reason = _parse_manager_resume(interrupt(payload))
    timeline = state["timeline"] + [
        _timeline_event(
            "manager.decision",
            "Manager decision received for routeable case.",
            {"decision": decision, "manager_id": manager_id, "has_override_reason": bool(override_reason)},
        )
    ]
    update = {
        "manager_decision": decision,
        "manager_id": manager_id,
        "override_reason": override_reason,
        "timeline": timeline,
    }

    if decision == "run_local":
        return Command(goto="execute_local", update=update)
    if decision == "route":
        return Command(goto="execute_routed", update=update)
    return Command(goto="postpone", update=update)


def human_decision_no_route(state: AgentState) -> Command:
    prompt = (
        f"Primary zone {state['primary_zone']} is dirty ({state['primary_intensity']} gCO2eq/kWh, "
        f"threshold {state['threshold']}) and no compliant route is available. "
        "Choose: run_local or postpone."
    )
    payload = {"question": prompt, "options": ["run_local", "postpone"], "recommended_action": None}
    decision, manager_id, override_reason = _parse_manager_resume(interrupt(payload))
    timeline = state["timeline"] + [
        _timeline_event(
            "manager.decision",
            "Manager decision received for no-route case.",
            {"decision": decision, "manager_id": manager_id, "has_override_reason": bool(override_reason)},
        )
    ]
    update = {
        "manager_decision": decision,
        "manager_id": manager_id,
        "override_reason": override_reason,
        "timeline": timeline,
    }

    if decision == "run_local":
        return Command(goto="execute_local", update=update)
    return Command(goto="postpone", update=update)


def execute_local(state: AgentState) -> dict[str, Any]:
    timeline = state["timeline"] + [
        _timeline_event(
            "execution.final",
            "Job executed in primary zone.",
            {"execution_mode": "local", "zone": state["primary_zone"]},
        )
    ]
    return {
        "job_status": "completed",
        "execution_mode": "local",
        "selected_execution_zone": state["primary_zone"],
        "selected_execution_intensity": state["primary_intensity"],
        "completed_at_utc": _now_utc_iso(),
        "timeline": timeline,
    }


def execute_routed(state: AgentState) -> dict[str, Any]:
    route_zone = state["recommended_route_zone"]
    route_intensity = state["recommended_route_intensity"]
    if route_zone is None or route_intensity is None:
        timeline = state["timeline"] + [
            _timeline_event(
                "execution.final",
                "Route target unavailable at execution time; executed locally.",
                {"execution_mode": "local", "zone": state["primary_zone"]},
            )
        ]
        return {
            "job_status": "completed",
            "execution_mode": "local",
            "selected_execution_zone": state["primary_zone"],
            "selected_execution_intensity": state["primary_intensity"],
            "completed_at_utc": _now_utc_iso(),
            "timeline": timeline,
        }

    timeline = state["timeline"] + [
        _timeline_event(
            "execution.final",
            "Job executed in routed zone.",
            {"execution_mode": "routed", "zone": route_zone},
        )
    ]
    return {
        "job_status": "completed",
        "execution_mode": "routed",
        "selected_execution_zone": route_zone,
        "selected_execution_intensity": route_intensity,
        "completed_at_utc": _now_utc_iso(),
        "timeline": timeline,
    }


def postpone(state: AgentState) -> dict[str, Any]:
    timeline = list(state["timeline"])
    forecast_available = False
    forecast_recommendation = None

    if settings.enable_postpone_forecast_recommendation and not state.get("demo_scenario"):
        try:
            forecast_available, forecast_recommendation, forecast_data = _postpone_forecast_recommendation(
                state["primary_zone"],
                state["threshold"],
            )
            timeline.append(
                _timeline_event(
                    "sensor.forecast",
                    (
                        "Fetched postpone forecast recommendation."
                        if forecast_available
                        else "Forecast unavailable for postpone recommendation."
                    ),
                    forecast_data,
                )
            )
        except Exception as exc:
            timeline.append(
                _timeline_event(
                    "sensor.forecast",
                    "Forecast lookup failed for postpone recommendation; continuing without recommendation.",
                    {"zone": state["primary_zone"], "error": str(exc)},
                )
            )

    timeline.append(
        _timeline_event(
            "execution.final",
            "Job postponed by manager decision.",
            {"execution_mode": "postponed"},
        )
    )
    return {
        "job_status": "postponed",
        "execution_mode": "postponed",
        "completed_at_utc": _now_utc_iso(),
        "forecast_available": forecast_available,
        "forecast_recommendation": forecast_recommendation,
        "timeline": timeline,
    }


def compute_metrics(state: AgentState) -> dict[str, Any]:
    intensity_local = state["primary_intensity"]
    kwh = state["estimated_kwh"]
    if intensity_local is None:
        return {
            "estimated_kgco2_local": None,
            "estimated_kgco2_routed": None,
            "estimated_kgco2_saved_by_routing": None,
        }

    local_kg = (float(intensity_local) * float(kwh)) / 1000.0
    routed_intensity = state["recommended_route_intensity"]
    if routed_intensity is None:
        return {
            "estimated_kgco2_local": round(local_kg, 4),
            "estimated_kgco2_routed": None,
            "estimated_kgco2_saved_by_routing": None,
        }

    routed_kg = (float(routed_intensity) * float(kwh)) / 1000.0
    saved = max(0.0, local_kg - routed_kg)
    return {
        "estimated_kgco2_local": round(local_kg, 4),
        "estimated_kgco2_routed": round(routed_kg, 4),
        "estimated_kgco2_saved_by_routing": round(saved, 4),
    }


def generate_audit(state: AgentState) -> dict[str, Any]:
    report = generate_audit_report(state)
    timeline = state["timeline"] + [
        _timeline_event(
            "audit.generated",
            "Audit report generated.",
            {"mode": report["report_mode"]},
        )
    ]
    return {
        "audit_report": report["report_text"],
        "audit_mode": report["report_mode"],
        "timeline": timeline,
    }


def finalize_timeline(state: AgentState) -> dict[str, Any]:
    return {
        "timeline": state["timeline"] + [
            _timeline_event(
                "timeline.finalized",
                "Decision timeline finalized.",
                {"status": state["job_status"]},
            )
        ]
    }


def extract_interrupt_payload(graph_state: Any) -> Optional[Any]:
    tasks = getattr(graph_state, "tasks", None) or []
    for task in tasks:
        interrupts = getattr(task, "interrupts", None) or []
        if interrupts:
            return getattr(interrupts[0], "value", None)
    return None


def extract_interrupt_question(graph_state: Any) -> Optional[str]:
    payload = extract_interrupt_payload(graph_state)
    if isinstance(payload, str):
        return payload
    if isinstance(payload, dict):
        value = payload.get("question")
        if isinstance(value, str):
            return value
    return None


def extract_interrupt_options(graph_state: Any) -> list[str]:
    payload = extract_interrupt_payload(graph_state)
    if isinstance(payload, dict) and isinstance(payload.get("options"), list):
        return [str(item) for item in payload["options"]]
    return []


def build_graph(checkpointer: Any | None = None):
    builder = StateGraph(AgentState)
    builder.add_node("check_primary_latest", check_primary_latest)
    builder.add_node("evaluate_candidates", evaluate_candidates)
    builder.add_node("apply_policy", apply_policy)
    builder.add_node("human_decision_routeable", human_decision_routeable)
    builder.add_node("human_decision_no_route", human_decision_no_route)
    builder.add_node("execute_local", execute_local)
    builder.add_node("execute_routed", execute_routed)
    builder.add_node("postpone", postpone)
    builder.add_node("compute_metrics", compute_metrics)
    builder.add_node("generate_audit", generate_audit)
    builder.add_node("finalize_timeline", finalize_timeline)

    builder.add_edge(START, "check_primary_latest")
    builder.add_edge("check_primary_latest", "evaluate_candidates")
    builder.add_edge("evaluate_candidates", "apply_policy")
    builder.add_conditional_edges("apply_policy", route_after_policy)

    builder.add_edge("execute_local", "compute_metrics")
    builder.add_edge("execute_routed", "compute_metrics")
    builder.add_edge("postpone", "compute_metrics")
    builder.add_edge("compute_metrics", "generate_audit")
    builder.add_edge("generate_audit", "finalize_timeline")
    builder.add_edge("finalize_timeline", END)

    if checkpointer is None:
        checkpointer = MemorySaver()
    return builder.compile(checkpointer=checkpointer)
