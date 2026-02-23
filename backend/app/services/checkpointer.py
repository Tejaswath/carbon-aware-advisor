from pathlib import Path
import inspect
from typing import Any, Awaitable, Callable


class CheckpointerInitError(RuntimeError):
    pass


CloseFn = Callable[[], Awaitable[None]]


def _to_sqlite_conn_string(path: Path) -> str:
    path = path.resolve()
    # SqliteSaver.from_conn_string expects a filesystem path, not a sqlite:/// URI.
    return path.as_posix()


async def create_sqlite_checkpointer(db_path: str) -> tuple[Any, CloseFn]:
    path = Path(db_path).expanduser()
    conn_string = _to_sqlite_conn_string(path)

    try:
        from langgraph.checkpoint.sqlite.aio import AsyncSqliteSaver
    except ImportError as exc:
        raise CheckpointerInitError(
            "LangGraph async SQLite checkpointer is unavailable. "
            "Install 'langgraph-checkpoint-sqlite' and 'aiosqlite'."
        ) from exc

    saver_or_cm = AsyncSqliteSaver.from_conn_string(conn_string)
    saver_cm = None
    if hasattr(saver_or_cm, "__aenter__") and hasattr(saver_or_cm, "__aexit__"):
        saver_cm = saver_or_cm
        saver = await saver_cm.__aenter__()
    else:
        saver = saver_or_cm

    setup_fn = getattr(saver, "setup", None)
    if callable(setup_fn):
        maybe_awaitable = setup_fn()
        if inspect.isawaitable(maybe_awaitable):
            await maybe_awaitable

    async def _close() -> None:
        if saver_cm is not None:
            await saver_cm.__aexit__(None, None, None)
            return
        close_fn = getattr(saver, "close", None)
        if callable(close_fn):
            maybe_awaitable = close_fn()
            if inspect.isawaitable(maybe_awaitable):
                await maybe_awaitable

    return saver, _close


async def create_postgres_checkpointer(database_url: str) -> tuple[Any, CloseFn]:
    if not database_url:
        raise CheckpointerInitError("DATABASE_URL is required for Postgres checkpointer initialization.")

    try:
        from langgraph.checkpoint.postgres.aio import AsyncPostgresSaver
    except ImportError as exc:
        raise CheckpointerInitError(
            "LangGraph Postgres checkpointer is unavailable. "
            "Install 'langgraph-checkpoint-postgres'."
        ) from exc

    try:
        from psycopg.rows import dict_row
        from psycopg_pool import AsyncConnectionPool
    except ImportError as exc:
        raise CheckpointerInitError(
            "Async Postgres dependencies are missing. Install 'psycopg[binary]' and 'psycopg-pool'."
        ) from exc

    pool: Any = None
    saver_cm: Any = None

    try:
        pool = AsyncConnectionPool(
            conninfo=database_url,
            kwargs={"autocommit": True, "row_factory": dict_row},
            open=False,
        )
        await pool.open()

        saver_or_cm = AsyncPostgresSaver(pool)
        if hasattr(saver_or_cm, "__aenter__") and hasattr(saver_or_cm, "__aexit__"):
            saver_cm = saver_or_cm
            saver = await saver_cm.__aenter__()
        else:
            saver = saver_or_cm

        setup_fn = getattr(saver, "setup", None)
        if callable(setup_fn):
            maybe_awaitable = setup_fn()
            if inspect.isawaitable(maybe_awaitable):
                await maybe_awaitable
    except Exception as exc:
        if saver_cm is not None:
            try:
                await saver_cm.__aexit__(None, None, None)
            except Exception:
                pass
        if pool is not None:
            close_pool = getattr(pool, "close", None)
            if callable(close_pool):
                try:
                    maybe_awaitable = close_pool()
                    if inspect.isawaitable(maybe_awaitable):
                        await maybe_awaitable
                except Exception:
                    pass
        raise CheckpointerInitError(f"Failed to initialize Async Postgres checkpointer: {exc}") from exc

    async def _close() -> None:
        if saver_cm is not None:
            try:
                await saver_cm.__aexit__(None, None, None)
            except Exception:
                pass
        if pool is not None:
            close_pool = getattr(pool, "close", None)
            if callable(close_pool):
                maybe_awaitable = close_pool()
                if inspect.isawaitable(maybe_awaitable):
                    await maybe_awaitable

    return saver, _close


async def create_checkpointer(database_url: str, sqlite_db_path: str) -> tuple[Any, CloseFn]:
    if database_url:
        return await create_postgres_checkpointer(database_url)
    return await create_sqlite_checkpointer(sqlite_db_path)
