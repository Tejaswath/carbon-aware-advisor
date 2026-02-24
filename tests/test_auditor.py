from src import auditor


def test_auditor_fallback_without_key(monkeypatch):
    payload = {
        "primary_zone": "SE-SE3",
        "primary_intensity": 50,
        "selected_execution_zone": "NO-NO1",
        "selected_execution_intensity": 18,
        "execution_mode": "routed",
        "threshold": 40,
        "policy_action": "route_to_clean_region",
        "policy_reason": "dirty",
        "job_status": "postponed",
        "estimated_kgco2_local": 25,
        "estimated_kgco2_routed": 9,
        "estimated_kgco2_saved_by_routing": 16,
    }

    result = auditor.generate_audit_report(payload, openai_api_key="")
    assert result["report_mode"] == "template"
    assert "Audit:" in result["report_text"]
    assert "location-based method" in result["report_text"]


def test_auditor_llm_path(monkeypatch):
    payload = {
        "primary_zone": "SE-SE3",
        "primary_intensity": 50,
        "selected_execution_zone": "NO-NO1",
        "selected_execution_intensity": 18,
        "execution_mode": "routed",
        "threshold": 40,
        "policy_action": "route_to_clean_region",
        "policy_reason": "dirty",
        "job_status": "completed",
        "estimated_kgco2_local": 25,
        "estimated_kgco2_routed": 9,
        "estimated_kgco2_saved_by_routing": 16,
    }

    monkeypatch.setattr(auditor, "_llm_report", lambda p, m, k, t: "LLM generated report")

    result = auditor.generate_audit_report(payload, openai_api_key="dummy-key")
    assert result["report_mode"] == "llm"
    assert result["report_text"] == "LLM generated report"


def test_auditor_falls_back_on_llm_exception(monkeypatch):
    payload = {
        "primary_zone": "SE-SE3",
        "primary_intensity": 50,
        "selected_execution_zone": "NO-NO1",
        "selected_execution_intensity": 18,
        "execution_mode": "routed",
        "threshold": 40,
        "policy_action": "route_to_clean_region",
        "policy_reason": "dirty",
        "job_status": "completed",
        "estimated_kgco2_local": 25,
        "estimated_kgco2_routed": 9,
        "estimated_kgco2_saved_by_routing": 16,
    }

    def _raise(*_args, **_kwargs):
        raise TimeoutError("simulated timeout")

    monkeypatch.setattr(auditor, "_llm_report", _raise)

    result = auditor.generate_audit_report(payload, openai_api_key="dummy-key")
    assert result["report_mode"] == "template"
    assert "Audit:" in result["report_text"]
