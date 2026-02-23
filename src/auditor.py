from typing import Any, Mapping

from src.config import settings


def _template_report(payload: Mapping[str, Any]) -> str:
    return (
        f"Audit: decision status '{payload.get('job_status', 'unknown')}' for primary zone "
        f"{payload.get('primary_zone', 'N/A')} at {payload.get('primary_intensity', 'N/A')} gCO2eq/kWh. "
        f"Selected execution mode: {payload.get('execution_mode', 'N/A')} in zone "
        f"{payload.get('selected_execution_zone', 'N/A')} at {payload.get('selected_execution_intensity', 'N/A')} "
        f"gCO2eq/kWh. Policy action: {payload.get('policy_action', 'N/A')} "
        f"({payload.get('policy_reason', 'N/A')}). Estimated local: {payload.get('estimated_kgco2_local', 'N/A')} "
        f"kgCO2, routed: {payload.get('estimated_kgco2_routed', 'N/A')} kgCO2, savings: "
        f"{payload.get('estimated_kgco2_saved_by_routing', 'N/A')} kgCO2. Manager ID: "
        f"{payload.get('manager_id', 'N/A')}. Override reason: {payload.get('override_reason', 'N/A')}. "
        f"Forecast recommendation: {payload.get('forecast_recommendation', 'N/A')}. "
        "Emissions calculated using location-based method (GHG Protocol). "
        "Market-based accounting (GoOs, PPAs) is not currently modeled."
    )


def _llm_report(payload: Mapping[str, Any], model: str, api_key: str) -> str:
    from langchain_openai import ChatOpenAI

    llm = ChatOpenAI(model=model, temperature=0, api_key=api_key)
    prompt = (
        "You are an ESG audit assistant. Write a concise 2-3 sentence operational audit log. "
        f"Primary Zone: {payload.get('primary_zone')}\n"
        f"Primary Intensity: {payload.get('primary_intensity')} gCO2eq/kWh\n"
        f"Selected Execution Zone: {payload.get('selected_execution_zone')}\n"
        f"Selected Execution Intensity: {payload.get('selected_execution_intensity')} gCO2eq/kWh\n"
        f"Execution Mode: {payload.get('execution_mode')}\n"
        f"Threshold: {payload.get('threshold')} gCO2eq/kWh\n"
        f"Policy Action: {payload.get('policy_action')}\n"
        f"Policy Reason: {payload.get('policy_reason')}\n"
        f"Manager Decision: {payload.get('manager_decision')}\n"
        f"Manager ID: {payload.get('manager_id')}\n"
        f"Override Reason: {payload.get('override_reason')}\n"
        f"Forecast Recommendation: {payload.get('forecast_recommendation')}\n"
        f"Job Status: {payload.get('job_status')}\n"
        f"Estimated kWh: {payload.get('estimated_kwh')}\n"
        f"Estimated kgCO2 local: {payload.get('estimated_kgco2_local')}\n"
        f"Estimated kgCO2 routed: {payload.get('estimated_kgco2_routed')}\n"
        f"Estimated kgCO2 saved by routing: {payload.get('estimated_kgco2_saved_by_routing')}\n"
        f"Accounting Method: {payload.get('accounting_method', 'location-based')}\n"
        "Always include one explicit sentence that this report uses location-based accounting only, "
        "and that market-based accounting is not modeled.\n"
    )
    response = llm.invoke(prompt)
    return str(response.content).strip()


def generate_audit_report(payload: Mapping[str, Any], *, model: str | None = None, openai_api_key: str | None = None) -> dict[str, str]:
    api_key = openai_api_key if openai_api_key is not None else settings.openai_api_key
    selected_model = model or settings.openai_model

    if not api_key:
        return {"report_text": _template_report(payload), "report_mode": "template"}

    try:
        report = _llm_report(payload, selected_model, api_key)
        if not report:
            raise ValueError("Empty LLM report")
        return {"report_text": report, "report_mode": "llm"}
    except Exception:
        return {"report_text": _template_report(payload), "report_mode": "template"}
