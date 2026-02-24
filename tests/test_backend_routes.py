from fastapi import FastAPI
from fastapi.testclient import TestClient

from backend.app.api.routes import router
from backend.app.models.schemas import DecisionResponse


class StubWorkflowService:
    def __init__(self):
        self.last_start_payload = None
        self.last_action_payload = None

    def create_decision_id(self) -> str:
        return "decision-test"

    async def start_decision(self, decision_id, estimated_kwh, threshold, zone, demo_scenario=None) -> None:
        self.last_start_payload = {
            "decision_id": decision_id,
            "estimated_kwh": estimated_kwh,
            "threshold": threshold,
            "zone": zone,
            "demo_scenario": demo_scenario,
        }
        return None

    def processing_response(self, decision_id: str, primary_zone: str) -> DecisionResponse:
        return DecisionResponse(
            decision_id=decision_id,
            status="processing",
            primary_zone=primary_zone,
        )

    def _base_response(self) -> DecisionResponse:
        return DecisionResponse(
            decision_id="decision-test",
            status="completed",
            primary_zone="SE-SE3",
            primary_intensity=62,
            selected_execution_zone="NO-NO1",
            selected_execution_intensity=18,
            execution_mode="routed",
            policy_action="route_to_clean_region",
            policy_reason="route",
            estimated_kgco2_local=6.2,
            estimated_kgco2_routed=1.8,
            estimated_kgco2_saved_by_routing=4.4,
            manager_options=[],
            manager_prompt=None,
            manager_id="manager@example.com",
            override_reason=None,
            audit_mode="template",
            audit_report="ok",
            routing_top3=[{"zone": "NO-NO1", "carbonIntensity": 18, "datetime": "2026-02-20T01:00:00Z", "ok": True, "error": None}],
            timeline=[],
            forecast_available=False,
        )

    async def get_decision(self, decision_id: str) -> DecisionResponse:
        return self._base_response()

    async def run_local_decision(
        self, decision_id: str, manager_id: str, override_reason: str | None = None
    ) -> DecisionResponse:
        self.last_action_payload = {"decision_id": decision_id, "action": "run_local", "manager_id": manager_id, "override_reason": override_reason}
        response = self._base_response()
        response.execution_mode = "local"
        response.selected_execution_zone = "SE-SE3"
        return response

    async def route_decision(
        self, decision_id: str, manager_id: str, override_reason: str | None = None
    ) -> DecisionResponse:
        self.last_action_payload = {"decision_id": decision_id, "action": "route", "manager_id": manager_id, "override_reason": override_reason}
        return self._base_response()

    async def postpone_decision(
        self, decision_id: str, manager_id: str, override_reason: str | None = None
    ) -> DecisionResponse:
        self.last_action_payload = {"decision_id": decision_id, "action": "postpone", "manager_id": manager_id, "override_reason": override_reason}
        response = self._base_response()
        response.status = "postponed"
        response.execution_mode = "postponed"
        return response

    async def get_audit_csv(self, decision_id: str) -> str:
        return "decision_id,status\ndecision-test,completed\n"


def _build_client() -> TestClient:
    app = FastAPI()
    app.include_router(router)
    app.state.workflow_service = StubWorkflowService()
    return TestClient(app)


def test_new_action_endpoints_available():
    client = _build_client()
    payload = {"manager_id": "manager@example.com", "override_reason": "Compliance exception"}
    assert client.post("/api/v1/decisions/decision-test/run-local", json=payload).status_code == 200
    assert client.post("/api/v1/decisions/decision-test/route", json=payload).status_code == 200
    assert client.post("/api/v1/decisions/decision-test/postpone", json=payload).status_code == 200


def test_action_endpoints_require_manager_id():
    client = _build_client()
    assert client.post("/api/v1/decisions/decision-test/run-local", json={}).status_code == 422


def test_approve_endpoint_removed():
    client = _build_client()
    assert client.post("/api/v1/decisions/decision-test/approve").status_code == 404


def test_audit_csv_endpoint():
    client = _build_client()
    response = client.get("/api/v1/decisions/decision-test/audit.csv")
    assert response.status_code == 200
    assert "text/csv" in response.headers["content-type"]
    assert "decision_id,status" in response.text


def test_start_endpoint_accepts_demo_scenario():
    client = _build_client()
    response = client.post(
        "/api/v1/decisions/start",
        json={
            "estimated_kwh": 550,
            "threshold": 40,
            "zone": "SE-SE3",
            "demo_scenario": "routeable_dirty",
        },
    )
    assert response.status_code == 200
    assert response.json()["status"] == "processing"
    assert client.app.state.workflow_service.last_start_payload["demo_scenario"] == "routeable_dirty"


def test_action_endpoint_forwards_manager_identity_and_override_reason():
    client = _build_client()
    response = client.post(
        "/api/v1/decisions/decision-test/run-local",
        json={"manager_id": "alice@nordea.se", "override_reason": "Data residency lock"},
    )
    assert response.status_code == 200
    assert client.app.state.workflow_service.last_action_payload == {
        "decision_id": "decision-test",
        "action": "run_local",
        "manager_id": "alice@nordea.se",
        "override_reason": "Data residency lock",
    }


def test_health_endpoint_reports_sqlite_mode_with_path():
    client = _build_client()
    client.app.state.storage_mode = "sqlite"
    client.app.state.langgraph_db_path = "./langgraph_checkpoints.db"

    response = client.get("/api/v1/health")
    assert response.status_code == 200
    payload = response.json()
    assert payload["status"] == "ok"
    assert payload["storage_mode"] == "sqlite"
    assert payload["langgraph_db_path"] == "./langgraph_checkpoints.db"
    assert "sensor_reachable" in payload
    assert "last_sensor_success_at" in payload


def test_health_endpoint_reports_postgres_mode_without_path():
    client = _build_client()
    client.app.state.storage_mode = "postgres"
    client.app.state.langgraph_db_path = "./langgraph_checkpoints.db"

    response = client.get("/api/v1/health")
    assert response.status_code == 200
    payload = response.json()
    assert payload["status"] == "ok"
    assert payload["storage_mode"] == "postgres"
    assert payload["langgraph_db_path"] is None
    assert "sensor_reachable" in payload
    assert "last_sensor_success_at" in payload
