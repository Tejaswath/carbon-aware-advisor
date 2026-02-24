from langgraph.types import Command

from src import agent


def test_clean_flow_runs_locally_without_hitl(monkeypatch):
    monkeypatch.setattr(
        agent,
        "get_carbon_intensity_latest",
        lambda zone: {"ok": True, "zone": zone, "intensity": 20, "timestamp": "2026-02-20T01:00:00Z", "error": None},
    )
    monkeypatch.setattr(
        agent,
        "get_latest_for_zones",
        lambda zones=None: [
            {"zone": "SE-SE3", "ok": True, "carbonIntensity": 20, "datetime": "2026-02-20T01:00:00Z", "error": None},
            {"zone": "NO-NO1", "ok": True, "carbonIntensity": 18, "datetime": "2026-02-20T01:00:00Z", "error": None},
        ],
    )
    monkeypatch.setattr(agent, "generate_audit_report", lambda payload: {"report_text": "ok", "report_mode": "template"})

    graph = agent.build_graph()
    config = {"configurable": {"thread_id": "clean-flow"}}
    for _ in graph.stream(agent.create_initial_state("SE-SE3", 40, 100.0), config):
        pass

    state = graph.get_state(config).values
    assert state["job_status"] == "completed"
    assert state["execution_mode"] == "local"
    assert state["audit_report"] == "ok"
    assert any(item["stage"] == "policy.result" for item in state["timeline"])


def test_dirty_routeable_flow_can_route(monkeypatch):
    monkeypatch.setattr(
        agent,
        "get_carbon_intensity_latest",
        lambda zone: {"ok": True, "zone": zone, "intensity": 62, "timestamp": "2026-02-20T01:00:00Z", "error": None},
    )
    monkeypatch.setattr(
        agent,
        "get_latest_for_zones",
        lambda zones=None: [
            {"zone": "SE-SE3", "ok": True, "carbonIntensity": 62, "datetime": "2026-02-20T01:00:00Z", "error": None},
            {"zone": "NO-NO1", "ok": True, "carbonIntensity": 18, "datetime": "2026-02-20T01:00:00Z", "error": None},
        ],
    )
    monkeypatch.setattr(agent, "generate_audit_report", lambda payload: {"report_text": "ok", "report_mode": "template"})

    graph = agent.build_graph()
    config = {"configurable": {"thread_id": "route-flow"}}
    for _ in graph.stream(agent.create_initial_state("SE-SE3", 40, 100.0), config):
        pass

    interrupted = graph.get_state(config)
    interrupted_state = interrupted.values
    assert agent.extract_interrupt_question(interrupted) is not None
    assert agent.extract_interrupt_options(interrupted) == ["run_local", "route", "postpone"]
    assert interrupted_state["estimated_kgco2_local"] is not None
    assert interrupted_state["estimated_kgco2_routed"] is not None

    for _ in graph.stream(Command(resume="route"), config):
        pass

    state = graph.get_state(config).values
    assert state["job_status"] == "completed"
    assert state["execution_mode"] == "routed"
    assert state["selected_execution_zone"] == "NO-NO1"
    assert state["manager_decision"] == "route"


def test_dirty_routeable_flow_can_run_local(monkeypatch):
    monkeypatch.setattr(
        agent,
        "get_carbon_intensity_latest",
        lambda zone: {"ok": True, "zone": zone, "intensity": 62, "timestamp": "2026-02-20T01:00:00Z", "error": None},
    )
    monkeypatch.setattr(
        agent,
        "get_latest_for_zones",
        lambda zones=None: [
            {"zone": "SE-SE3", "ok": True, "carbonIntensity": 62, "datetime": "2026-02-20T01:00:00Z", "error": None},
            {"zone": "NO-NO1", "ok": True, "carbonIntensity": 18, "datetime": "2026-02-20T01:00:00Z", "error": None},
        ],
    )
    monkeypatch.setattr(agent, "generate_audit_report", lambda payload: {"report_text": "ok", "report_mode": "template"})

    graph = agent.build_graph()
    config = {"configurable": {"thread_id": "run-local-flow"}}
    for _ in graph.stream(agent.create_initial_state("SE-SE3", 40, 100.0), config):
        pass

    for _ in graph.stream(Command(resume="run_local"), config):
        pass

    state = graph.get_state(config).values
    assert state["job_status"] == "completed"
    assert state["execution_mode"] == "local"
    assert state["selected_execution_zone"] == "SE-SE3"
    assert state["manager_decision"] == "run_local"


def test_routeable_flow_captures_manager_identity_and_override_reason(monkeypatch):
    monkeypatch.setattr(
        agent,
        "get_carbon_intensity_latest",
        lambda zone: {"ok": True, "zone": zone, "intensity": 62, "timestamp": "2026-02-20T01:00:00Z", "error": None},
    )
    monkeypatch.setattr(
        agent,
        "get_latest_for_zones",
        lambda zones=None: [
            {"zone": "SE-SE3", "ok": True, "carbonIntensity": 62, "datetime": "2026-02-20T01:00:00Z", "error": None},
            {"zone": "NO-NO1", "ok": True, "carbonIntensity": 18, "datetime": "2026-02-20T01:00:00Z", "error": None},
        ],
    )
    monkeypatch.setattr(agent, "generate_audit_report", lambda payload: {"report_text": "ok", "report_mode": "template"})

    graph = agent.build_graph()
    config = {"configurable": {"thread_id": "manager-meta-flow"}}
    for _ in graph.stream(agent.create_initial_state("SE-SE3", 40, 100.0), config):
        pass

    for _ in graph.stream(
        Command(
            resume={
                "decision": "run_local",
                "manager_id": "manager@example.com",
                "override_reason": "Legal residency requirement",
            }
        ),
        config,
    ):
        pass

    state = graph.get_state(config).values
    assert state["job_status"] == "completed"
    assert state["execution_mode"] == "local"
    assert state["manager_decision"] == "run_local"
    assert state["manager_id"] == "manager@example.com"
    assert state["override_reason"] == "Legal residency requirement"


def test_dirty_no_route_flow_supports_postpone(monkeypatch):
    monkeypatch.setattr(
        agent,
        "get_carbon_intensity_latest",
        lambda zone: {"ok": True, "zone": zone, "intensity": 62, "timestamp": "2026-02-20T01:00:00Z", "error": None},
    )
    monkeypatch.setattr(
        agent,
        "get_latest_for_zones",
        lambda zones=None: [
            {"zone": "SE-SE3", "ok": True, "carbonIntensity": 62, "datetime": "2026-02-20T01:00:00Z", "error": None},
            {"zone": "SE-SE1", "ok": True, "carbonIntensity": 59, "datetime": "2026-02-20T01:00:00Z", "error": None},
        ],
    )
    monkeypatch.setattr(agent, "generate_audit_report", lambda payload: {"report_text": "ok", "report_mode": "template"})

    graph = agent.build_graph()
    config = {"configurable": {"thread_id": "no-route-flow"}}
    for _ in graph.stream(agent.create_initial_state("SE-SE3", 40, 100.0), config):
        pass

    interrupted = graph.get_state(config)
    interrupted_state = interrupted.values
    assert agent.extract_interrupt_options(interrupted) == ["run_local", "postpone"]
    assert interrupted_state["estimated_kgco2_local"] is not None
    assert interrupted_state["estimated_kgco2_routed"] is None

    for _ in graph.stream(Command(resume="postpone"), config):
        pass

    state = graph.get_state(config).values
    assert state["job_status"] == "postponed"
    assert state["execution_mode"] == "postponed"
    assert state["manager_decision"] == "postpone"
    assert any(item["stage"] == "timeline.finalized" for item in state["timeline"])


def test_postpone_with_feature_flag_includes_forecast_recommendation(monkeypatch):
    monkeypatch.setattr(agent.settings, "enable_postpone_forecast_recommendation", True)
    monkeypatch.setattr(
        agent,
        "get_carbon_intensity_latest",
        lambda zone: {"ok": True, "zone": zone, "intensity": 62, "timestamp": "2026-02-20T01:00:00Z", "error": None},
    )
    monkeypatch.setattr(
        agent,
        "get_latest_for_zones",
        lambda zones=None: [
            {"zone": "SE-SE3", "ok": True, "carbonIntensity": 62, "datetime": "2026-02-20T01:00:00Z", "error": None},
            {"zone": "SE-SE1", "ok": True, "carbonIntensity": 59, "datetime": "2026-02-20T01:00:00Z", "error": None},
        ],
    )
    monkeypatch.setattr(
        agent,
        "get_carbon_intensity_forecast",
        lambda zone: {
            "ok": True,
            "zone": zone,
            "points": [
                {"datetime": "2026-02-20T02:00:00+00:00", "carbonIntensity": 45},
                {"datetime": "2026-02-20T03:00:00+00:00", "carbonIntensity": 35},
            ],
            "best_point": {"datetime": "2026-02-20T03:00:00+00:00", "carbonIntensity": 35},
            "error": None,
        },
    )
    monkeypatch.setattr(agent, "generate_audit_report", lambda payload: {"report_text": "ok", "report_mode": "template"})

    graph = agent.build_graph()
    config = {"configurable": {"thread_id": "forecast-postpone-flow"}}
    for _ in graph.stream(agent.create_initial_state("SE-SE3", 40, 100.0), config):
        pass

    for _ in graph.stream(
        Command(
            resume={
                "decision": "postpone",
                "manager_id": "manager@example.com",
                "override_reason": None,
            }
        ),
        config,
    ):
        pass

    state = graph.get_state(config).values
    assert state["job_status"] == "postponed"
    assert state["forecast_available"] is True
    assert state["forecast_recommendation"] is not None
    assert "below threshold" in state["forecast_recommendation"]
    assert any(item["stage"] == "sensor.forecast" for item in state["timeline"])


def test_demo_routeable_scenario_interrupts_without_live_sensor_calls(monkeypatch):
    def _unexpected_sensor_call(*_args, **_kwargs):
        raise AssertionError("Live sensor should not be called for demo scenario")

    monkeypatch.setattr(agent, "get_carbon_intensity_latest", _unexpected_sensor_call)
    monkeypatch.setattr(agent, "get_latest_for_zones", _unexpected_sensor_call)
    monkeypatch.setattr(agent, "generate_audit_report", lambda payload: {"report_text": "ok", "report_mode": "template"})

    graph = agent.build_graph()
    config = {"configurable": {"thread_id": "demo-routeable-flow"}}
    for _ in graph.stream(agent.create_initial_state("SE-SE3", 40, 100.0, demo_scenario="routeable_dirty"), config):
        pass

    interrupted = graph.get_state(config)
    state = interrupted.values
    assert state["primary_intensity"] > 40
    assert state["recommended_route_zone"] is not None
    assert state["recommended_route_intensity"] is not None
    assert agent.extract_interrupt_options(interrupted) == ["run_local", "route", "postpone"]


def test_demo_non_routeable_scenario_has_no_route_option(monkeypatch):
    def _unexpected_sensor_call(*_args, **_kwargs):
        raise AssertionError("Live sensor should not be called for demo scenario")

    monkeypatch.setattr(agent, "get_carbon_intensity_latest", _unexpected_sensor_call)
    monkeypatch.setattr(agent, "get_latest_for_zones", _unexpected_sensor_call)
    monkeypatch.setattr(agent, "generate_audit_report", lambda payload: {"report_text": "ok", "report_mode": "template"})

    graph = agent.build_graph()
    config = {"configurable": {"thread_id": "demo-no-route-flow"}}
    for _ in graph.stream(agent.create_initial_state("SE-SE3", 40, 100.0, demo_scenario="non_routeable_dirty"), config):
        pass

    interrupted = graph.get_state(config)
    assert agent.extract_interrupt_options(interrupted) == ["run_local", "postpone"]
