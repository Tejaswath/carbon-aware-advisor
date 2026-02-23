from pathlib import Path
from contextlib import asynccontextmanager
import inspect
import logging

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from backend.app.api.routes import router
from backend.app.services.checkpointer import CheckpointerInitError, create_checkpointer
from backend.app.services.workflow_service import WorkflowService
from src.config import settings

logger = logging.getLogger("uvicorn.error")


def _ensure_db_path_writable(db_path: str) -> Path:
    path = Path(db_path).expanduser()
    parent = path.parent

    if not parent.exists():
        raise RuntimeError(
            f"LANGGRAPH_DB_PATH parent directory does not exist: {parent}. "
            "Attach and mount a persistent volume (example: /data)."
        )

    if not parent.is_dir():
        raise RuntimeError(f"LANGGRAPH_DB_PATH parent is not a directory: {parent}")

    if not parent.stat().st_mode:
        raise RuntimeError(f"Unable to inspect LANGGRAPH_DB_PATH parent directory: {parent}")

    test_file = parent / ".write_test"
    try:
        with open(test_file, "w", encoding="utf-8") as f:
            f.write("ok")
        test_file.unlink(missing_ok=True)
    except Exception as exc:
        raise RuntimeError(
            f"LANGGRAPH_DB_PATH parent is not writable: {parent}. "
            "Ensure your persistent volume is mounted with write access."
        ) from exc

    return path

@asynccontextmanager
async def lifespan(app: FastAPI):
    storage_mode = "postgres" if settings.database_url else "sqlite"
    sqlite_db_path: str | None = settings.langgraph_db_path
    if not settings.database_url:
        sqlite_db_path = str(_ensure_db_path_writable(settings.langgraph_db_path))
    else:
        sqlite_db_path = None

    try:
        checkpointer, close_fn = await create_checkpointer(
            database_url=settings.database_url,
            sqlite_db_path=sqlite_db_path or settings.langgraph_db_path,
        )
    except CheckpointerInitError as exc:
        raise RuntimeError(str(exc)) from exc

    app.state.checkpointer = checkpointer
    app.state.checkpointer_close = close_fn
    app.state.workflow_service = WorkflowService(checkpointer=checkpointer)
    app.state.storage_mode = storage_mode
    app.state.langgraph_db_path = sqlite_db_path
    if storage_mode == "postgres":
        logger.info("Checkpoint storage initialized in postgres mode (DATABASE_URL configured).")
    else:
        logger.info("Checkpoint storage initialized in sqlite mode (LANGGRAPH_DB_PATH=%s).", sqlite_db_path)
    try:
        yield
    finally:
        close_fn = getattr(app.state, "checkpointer_close", None)
        if callable(close_fn):
            maybe_awaitable = close_fn()
            if inspect.isawaitable(maybe_awaitable):
                await maybe_awaitable


app = FastAPI(title="Carbon Advisor API", version="1.0.0", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
app.include_router(router)
