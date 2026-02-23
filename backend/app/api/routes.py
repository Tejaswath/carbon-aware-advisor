from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Request
from fastapi.responses import Response

from backend.app.models.schemas import (
    DecisionResponse,
    HealthResponse,
    ManagerActionRequest,
    StartDecisionRequest,
)
from backend.app.services.workflow_service import (
    DecisionNotFoundError,
    InvalidDecisionTransitionError,
    WorkflowService,
)
from src.config import settings


router = APIRouter(prefix="/api/v1", tags=["decisions"])


def get_workflow_service(request: Request) -> WorkflowService:
    service = getattr(request.app.state, "workflow_service", None)
    if service is None:
        raise HTTPException(status_code=503, detail="Workflow service is not ready")
    return service


@router.post("/decisions/start", response_model=DecisionResponse)
async def start_decision(
    payload: StartDecisionRequest,
    background_tasks: BackgroundTasks,
    service: WorkflowService = Depends(get_workflow_service),
) -> DecisionResponse:
    decision_id = service.create_decision_id()
    selected_zone = (payload.zone or settings.grid_zone).strip() or settings.grid_zone
    background_tasks.add_task(
        service.start_decision,
        decision_id,
        payload.estimated_kwh,
        payload.threshold,
        selected_zone,
        payload.demo_scenario,
    )
    return service.processing_response(decision_id, primary_zone=selected_zone)


@router.get("/decisions/{decision_id}", response_model=DecisionResponse)
async def get_decision(decision_id: str, service: WorkflowService = Depends(get_workflow_service)) -> DecisionResponse:
    try:
        return await service.get_decision(decision_id)
    except DecisionNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@router.post("/decisions/{decision_id}/run-local", response_model=DecisionResponse)
async def run_local_decision(
    decision_id: str,
    payload: ManagerActionRequest,
    service: WorkflowService = Depends(get_workflow_service),
) -> DecisionResponse:
    try:
        return await service.run_local_decision(
            decision_id,
            manager_id=payload.manager_id,
            override_reason=payload.override_reason,
        )
    except DecisionNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except InvalidDecisionTransitionError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc


@router.post("/decisions/{decision_id}/route", response_model=DecisionResponse)
async def route_decision(
    decision_id: str,
    payload: ManagerActionRequest,
    service: WorkflowService = Depends(get_workflow_service),
) -> DecisionResponse:
    try:
        return await service.route_decision(
            decision_id,
            manager_id=payload.manager_id,
            override_reason=payload.override_reason,
        )
    except DecisionNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except InvalidDecisionTransitionError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc


@router.post("/decisions/{decision_id}/postpone", response_model=DecisionResponse)
async def postpone_decision(
    decision_id: str,
    payload: ManagerActionRequest,
    service: WorkflowService = Depends(get_workflow_service),
) -> DecisionResponse:
    try:
        return await service.postpone_decision(
            decision_id,
            manager_id=payload.manager_id,
            override_reason=payload.override_reason,
        )
    except DecisionNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except InvalidDecisionTransitionError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc


@router.get("/decisions/{decision_id}/audit.csv")
async def decision_audit_csv(decision_id: str, service: WorkflowService = Depends(get_workflow_service)) -> Response:
    try:
        csv_data = await service.get_audit_csv(decision_id)
    except DecisionNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc

    return Response(
        content=csv_data,
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": f'attachment; filename="{decision_id}_audit.csv"'},
    )


@router.get("/health", response_model=HealthResponse)
async def health(request: Request) -> HealthResponse:
    storage_mode = getattr(request.app.state, "storage_mode", "postgres" if settings.database_url else "sqlite")
    langgraph_db_path = getattr(request.app.state, "langgraph_db_path", settings.langgraph_db_path)
    if storage_mode == "postgres":
        langgraph_db_path = None
    return HealthResponse(status="ok", storage_mode=storage_mode, langgraph_db_path=langgraph_db_path)
