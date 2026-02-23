import uuid
from datetime import datetime
from typing import Any

import gradio as gr
from langgraph.types import Command

from src.agent import build_graph, create_initial_state, extract_interrupt_question
from src.config import settings


graph = build_graph()


def _new_session() -> dict[str, Any]:
    return {"thread_id": f"session-{uuid.uuid4().hex}", "awaiting_approval": False}


def _ensure_session(session: Any) -> dict[str, Any]:
    if isinstance(session, dict) and session.get("thread_id"):
        return session
    return _new_session()


def _parse_local_time(ts: str | None) -> str:
    if not ts:
        return "Unavailable"
    try:
        parsed = datetime.fromisoformat(ts.replace("Z", "+00:00"))
        return parsed.astimezone().strftime("%Y-%m-%d %H:%M %Z")
    except ValueError:
        return ts


def _top_cleanest_rows(points: list[dict[str, Any]], n: int = 3) -> list[list[Any]]:
    filtered = [p for p in points if p.get("datetime") and p.get("carbonIntensity") is not None]
    filtered.sort(key=lambda p: p["carbonIntensity"])
    rows: list[list[Any]] = []
    for p in filtered[:n]:
        rows.append([_parse_local_time(p["datetime"]), int(p["carbonIntensity"])])
    return rows


def _run_until_pause(payload: Any, session: dict[str, Any]) -> tuple[dict[str, Any], str | None, dict[str, Any]]:
    config = {"configurable": {"thread_id": session["thread_id"]}}
    for _ in graph.stream(payload, config):
        pass

    state = graph.get_state(config)
    values = dict(getattr(state, "values", {}) or {})
    question = extract_interrupt_question(state)
    session["awaiting_approval"] = bool(question)
    return values, question, session


def _render(values: dict[str, Any], question: str | None = None, error: str | None = None):
    if error:
        return (
            f"### Error\n{error}",
            "Current intensity: unavailable",
            "Best run window: unavailable",
            "Policy action: unavailable",
            "Estimated now: unavailable\n\nEstimated best: unavailable\n\nEstimated saved if postponed: unavailable",
            "Job status: error",
            "Audit mode: template\n\nAudit report unavailable due to upstream error.",
            [],
        )

    current_intensity = values.get("current_intensity")
    best_intensity = values.get("best_forecast_intensity")
    best_dt = values.get("best_forecast_datetime")
    threshold = values.get("threshold", settings.carbon_threshold)
    estimated_kwh = values.get("estimated_kwh")

    now_kg = values.get("estimated_kgco2_now")
    best_kg = values.get("estimated_kgco2_best")
    saved_kg = values.get("estimated_kgco2_saved_if_postponed")

    if now_kg is None and current_intensity is not None and estimated_kwh is not None:
        now_kg = round((float(current_intensity) * float(estimated_kwh)) / 1000.0, 4)
    if (
        best_kg is None
        and best_intensity is not None
        and estimated_kwh is not None
        and current_intensity is not None
    ):
        best_kg = round((float(best_intensity) * float(estimated_kwh)) / 1000.0, 4)
    if saved_kg is None and now_kg is not None and best_kg is not None:
        saved_kg = round(max(0.0, float(now_kg) - float(best_kg)), 4)

    forecast_rows = _top_cleanest_rows(values.get("forecast_points", []), n=3)
    recommendation = "Unavailable"
    if best_intensity is not None and best_dt:
        recommendation = f"{_parse_local_time(best_dt)} ({best_intensity} gCO2eq/kWh)"

    action = values.get("policy_action", "pending")
    reason = values.get("policy_reason", "Policy not yet evaluated.")
    status = values.get("job_status", "pending")
    audit_mode = values.get("audit_mode", "pending")
    audit_report = values.get("audit_report", "Audit report pending.")

    header = "### Decision Result"
    if question:
        header = f"### Manager Approval Required\n{question}"
        status = "awaiting_approval"

    return (
        header,
        f"Current intensity: {current_intensity} gCO2eq/kWh | Threshold: {threshold} gCO2eq/kWh",
        f"Best next run window: {recommendation}",
        f"Policy action: {action}\n\nReason: {reason}",
        (
            f"Estimated now: {now_kg} kgCO2\n\n"
            f"Estimated best: {best_kg} kgCO2\n\n"
            f"Estimated saved if postponed: {saved_kg} kgCO2"
        ),
        f"Job status: {status}",
        f"Audit mode: {audit_mode}\n\n{audit_report}",
        forecast_rows,
    )


def evaluate_and_decide(estimated_kwh: float, threshold_override: int, session: Any):
    session_obj = _ensure_session(session)
    if session_obj.get("awaiting_approval"):
        rendered = _render({}, error="Approval is pending. Approve or postpone, or click reset.")
        return (
            session_obj,
            *rendered,
            gr.update(visible=True),
            gr.update(visible=True),
        )

    # Each new evaluation uses a fresh thread to avoid cross-run state bleed.
    session_obj["thread_id"] = f"session-{uuid.uuid4().hex}"
    threshold = int(threshold_override) if threshold_override else settings.carbon_threshold

    try:
        initial = create_initial_state(settings.grid_zone, threshold, estimated_kwh)
        values, question, session_obj = _run_until_pause(initial, session_obj)
        rendered = _render(values, question=question)
        show_approval = bool(question)
        return (
            session_obj,
            *rendered,
            gr.update(visible=show_approval),
            gr.update(visible=show_approval),
        )
    except Exception as exc:
        session_obj["awaiting_approval"] = False
        rendered = _render({}, error=str(exc))
        return (
            session_obj,
            *rendered,
            gr.update(visible=False),
            gr.update(visible=False),
        )


def submit_decision(decision: str, session: Any):
    session_obj = _ensure_session(session)
    if not session_obj.get("awaiting_approval"):
        rendered = _render({}, error="No pending approval request. Click 'Evaluate and decide' first.")
        return session_obj, *rendered, gr.update(visible=False), gr.update(visible=False)

    try:
        values, question, session_obj = _run_until_pause(Command(resume=decision), session_obj)
        rendered = _render(values, question=question)
        show_approval = bool(question)
        return (
            session_obj,
            *rendered,
            gr.update(visible=show_approval),
            gr.update(visible=show_approval),
        )
    except Exception as exc:
        session_obj["awaiting_approval"] = False
        rendered = _render({}, error=str(exc))
        return session_obj, *rendered, gr.update(visible=False), gr.update(visible=False)


def reset_session():
    session_obj = _new_session()
    rendered = _render(
        {
            "current_intensity": None,
            "best_forecast_intensity": None,
            "best_forecast_datetime": None,
            "policy_action": "pending",
            "policy_reason": "Click 'Evaluate and decide' to begin.",
            "job_status": "pending",
            "audit_mode": "pending",
            "audit_report": "Audit report pending.",
            "forecast_points": [],
            "threshold": settings.carbon_threshold,
            "estimated_kwh": None,
            "estimated_kgco2_now": None,
            "estimated_kgco2_best": None,
            "estimated_kgco2_saved_if_postponed": None,
        }
    )
    return session_obj, *rendered, gr.update(visible=False), gr.update(visible=False)


custom_css = """
:root {
  --bg1: #f3f8f4;
  --bg2: #dfeee5;
  --card: #ffffff;
  --accent: #155e3a;
  --text: #1f2937;
}
body {
  background: radial-gradient(circle at top right, var(--bg2), var(--bg1));
  color: var(--text);
  font-family: "IBM Plex Sans", "Helvetica Neue", sans-serif;
}
#app-shell {
  max-width: 1000px;
  margin: 0 auto;
}
.panel {
  background: var(--card) !important;
  color: #111827 !important;
  border: 1px solid #d0e2d6;
  border-radius: 14px;
}
.panel * {
  color: #111827 !important;
}
"""


with gr.Blocks(css=custom_css, title="Carbon-Aware Compute Advisor") as demo:
    gr.Markdown("## Carbon-Aware Compute Advisor", elem_id="app-shell")
    gr.Markdown(
        "Evaluate whether a heavy compute job should run now based on live Swedish grid carbon intensity and forecast recommendations."
    )

    session_state = gr.State(_new_session())

    with gr.Row():
        estimated_kwh = gr.Slider(
            minimum=10,
            maximum=5000,
            value=500,
            step=10,
            label="Estimated Job Energy (kWh)",
            info="Required for quantifying emissions impact.",
        )
        threshold_override = gr.Number(
            value=settings.carbon_threshold,
            precision=0,
            label="Carbon Threshold (gCO2eq/kWh)",
        )

    with gr.Row():
        evaluate_btn = gr.Button("Evaluate and decide", variant="primary")
        approve_btn = gr.Button("Approve run now", visible=False)
        postpone_btn = gr.Button("Postpone to cleaner window", visible=False)
        reset_btn = gr.Button("Reset session")

    decision_alert = gr.Markdown()
    current_card = gr.Markdown(elem_classes=["panel"])
    best_card = gr.Markdown(elem_classes=["panel"])
    policy_card = gr.Markdown(elem_classes=["panel"])
    co2_card = gr.Markdown(elem_classes=["panel"])
    job_card = gr.Markdown(elem_classes=["panel"])
    audit_card = gr.Markdown(elem_classes=["panel"])

    forecast_table = gr.Dataframe(
        headers=["Datetime (Local)", "Carbon Intensity (gCO2eq/kWh)"],
        value=[],
        row_count=(3, "dynamic"),
        col_count=(2, "fixed"),
        label="Top 3 Cleanest Forecast Hours",
    )

    outputs = [
        session_state,
        decision_alert,
        current_card,
        best_card,
        policy_card,
        co2_card,
        job_card,
        audit_card,
        forecast_table,
        approve_btn,
        postpone_btn,
    ]

    evaluate_btn.click(
        fn=evaluate_and_decide,
        inputs=[estimated_kwh, threshold_override, session_state],
        outputs=outputs,
    )

    approve_btn.click(
        fn=lambda session: submit_decision("Y", session),
        inputs=[session_state],
        outputs=outputs,
    )

    postpone_btn.click(
        fn=lambda session: submit_decision("N", session),
        inputs=[session_state],
        outputs=outputs,
    )

    reset_btn.click(fn=reset_session, inputs=None, outputs=outputs)


if __name__ == "__main__":
    demo.launch()
