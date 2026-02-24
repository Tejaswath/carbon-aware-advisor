import os
from dataclasses import dataclass

from dotenv import load_dotenv


load_dotenv()


def _get_int(name: str, default: int) -> int:
    value = os.getenv(name)
    if value is None:
        return default
    try:
        return int(value)
    except ValueError:
        return default


def _get_float(name: str, default: float) -> float:
    value = os.getenv(name)
    if value is None:
        return default
    try:
        parsed = float(value)
    except ValueError:
        return default
    if parsed <= 0:
        return default
    return parsed


def _get_csv_list(name: str, default: str, *, strip_trailing_slash: bool = False) -> list[str]:
    raw_value = os.getenv(name, default)
    values = [value.strip() for value in raw_value.split(",")]
    if strip_trailing_slash:
        values = [value.rstrip("/") for value in values]
    return [value for value in values if value]


def _get_mode(name: str, default: str, allowed: set[str]) -> str:
    value = (os.getenv(name, default) or "").strip().lower()
    if value in allowed:
        return value
    return default


def _get_bool(name: str, default: bool) -> bool:
    value = os.getenv(name)
    if value is None:
        return default
    normalized = value.strip().lower()
    if normalized in {"1", "true", "yes", "on"}:
        return True
    if normalized in {"0", "false", "no", "off"}:
        return False
    return default


def _normalize_database_url(name: str) -> str:
    value = (os.getenv(name, "") or "").strip()
    if value.startswith("postgres://"):
        return value.replace("postgres://", "postgresql://", 1)
    return value


@dataclass
class Settings:
    electricitymaps_key: str
    openai_api_key: str
    electricitymaps_base_url: str
    cors_origins: list[str]
    grid_zone: str
    carbon_threshold: int
    forecast_window_hours: int
    request_timeout_seconds: int
    cache_ttl_seconds: int
    retry_max_attempts: int
    routing_candidate_zones: list[str]
    max_routing_candidates: int
    candidate_fetch_mode: str
    parallel_fetch_workers: int
    enable_postpone_forecast_recommendation: bool
    openai_model: str
    llm_audit_timeout_seconds: float
    database_url: str
    langgraph_db_path: str


settings = Settings(
    electricitymaps_key=os.getenv("ELECTRICITYMAPS_KEY", ""),
    openai_api_key=os.getenv("OPENAI_API_KEY", ""),
    electricitymaps_base_url=os.getenv("ELECTRICITYMAPS_BASE_URL", "https://api.electricitymaps.com").rstrip("/"),
    cors_origins=_get_csv_list("CORS_ORIGINS", "http://localhost:3000", strip_trailing_slash=True),
    grid_zone=os.getenv("GRID_ZONE", "SE-SE3"),
    carbon_threshold=_get_int("CARBON_THRESHOLD", 40),
    forecast_window_hours=_get_int("FORECAST_WINDOW_HOURS", 24),
    request_timeout_seconds=_get_int("REQUEST_TIMEOUT_SECONDS", 10),
    cache_ttl_seconds=_get_int("CACHE_TTL_SECONDS", 300),
    retry_max_attempts=_get_int("RETRY_MAX_ATTEMPTS", 3),
    routing_candidate_zones=_get_csv_list(
        "ROUTING_CANDIDATE_ZONES",
        "SE-SE3,SE-SE1,SE-SE2,SE-SE4,NO-NO1,FI",
    ),
    max_routing_candidates=_get_int("MAX_ROUTING_CANDIDATES", 6),
    candidate_fetch_mode=_get_mode("CANDIDATE_FETCH_MODE", "sequential", {"sequential", "parallel"}),
    parallel_fetch_workers=_get_int("PARALLEL_FETCH_WORKERS", 3),
    enable_postpone_forecast_recommendation=_get_bool("ENABLE_POSTPONE_FORECAST_RECOMMENDATION", False),
    openai_model=os.getenv("OPENAI_MODEL", "gpt-4o-mini"),
    llm_audit_timeout_seconds=_get_float("LLM_AUDIT_TIMEOUT_SECONDS", 5.0),
    database_url=_normalize_database_url("DATABASE_URL"),
    langgraph_db_path=os.getenv("LANGGRAPH_DB_PATH", "./langgraph_checkpoints.db"),
)
