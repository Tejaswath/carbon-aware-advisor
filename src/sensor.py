import copy
import logging
import random
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timedelta, timezone
from typing import Any, Optional

import requests

from src.config import settings
from src.models import CandidateIntensity, ForecastPoint, ForecastResult, SensorLatestResult


logger = logging.getLogger(__name__)

_CACHE: dict[tuple[str, str, str, int], tuple[float, dict[str, Any]]] = {}
_LAST_SENSOR_SUCCESS_AT: Optional[str] = None


def clear_cache() -> None:
    global _LAST_SENSOR_SUCCESS_AT
    _CACHE.clear()
    _LAST_SENSOR_SUCCESS_AT = None


def _mark_sensor_success(timestamp: Optional[str] = None) -> None:
    global _LAST_SENSOR_SUCCESS_AT
    if timestamp:
        _LAST_SENSOR_SUCCESS_AT = timestamp
        return
    _LAST_SENSOR_SUCCESS_AT = datetime.now(timezone.utc).isoformat()


def get_sensor_health_snapshot(stale_after_seconds: int = 900) -> dict[str, Any]:
    if not _LAST_SENSOR_SUCCESS_AT:
        return {"sensor_reachable": False, "last_sensor_success_at": None}

    parsed = _parse_dt(_LAST_SENSOR_SUCCESS_AT)
    if parsed is None:
        return {"sensor_reachable": False, "last_sensor_success_at": _LAST_SENSOR_SUCCESS_AT}

    age_seconds = (datetime.now(timezone.utc) - parsed).total_seconds()
    return {
        "sensor_reachable": age_seconds <= stale_after_seconds,
        "last_sensor_success_at": _LAST_SENSOR_SUCCESS_AT,
    }


def _cache_get(key: tuple[str, str, str, int], ttl_seconds: int) -> Optional[dict[str, Any]]:
    entry = _CACHE.get(key)
    if entry is None:
        logger.debug("cache miss: %s", key)
        return None

    cached_at, value = entry
    if (time.time() - cached_at) > ttl_seconds:
        logger.debug("cache expired: %s", key)
        _CACHE.pop(key, None)
        return None

    logger.debug("cache hit: %s", key)
    return copy.deepcopy(value)


def _cache_set(key: tuple[str, str, str, int], value: dict[str, Any]) -> None:
    _CACHE[key] = (time.time(), copy.deepcopy(value))


def _sleep_with_backoff(attempt: int) -> None:
    base = 0.5 * (2 ** (attempt - 1))
    jitter = random.uniform(0, 0.2)
    time.sleep(base + jitter)


def _request_json_with_retry(url: str, headers: dict[str, str], timeout: int, max_attempts: int) -> tuple[Optional[dict[str, Any]], Optional[str]]:
    attempt = 0
    while attempt < max_attempts:
        attempt += 1
        try:
            response = requests.get(url, headers=headers, timeout=timeout)
            status = response.status_code
            if status == 429 or 500 <= status < 600:
                if attempt < max_attempts:
                    _sleep_with_backoff(attempt)
                    continue
            response.raise_for_status()
            return response.json(), None
        except requests.HTTPError as exc:
            status_code = exc.response.status_code if exc.response is not None else None
            if status_code is not None and (status_code == 429 or 500 <= status_code < 600) and attempt < max_attempts:
                _sleep_with_backoff(attempt)
                continue
            return None, f"HTTP error ({status_code}): {exc}"
        except requests.RequestException as exc:
            if attempt < max_attempts:
                _sleep_with_backoff(attempt)
                continue
            return None, f"Request error: {exc}"
        except ValueError as exc:
            return None, f"Invalid JSON response: {exc}"

    return None, "Request failed after retries"


def _parse_dt(value: Optional[str]) -> Optional[datetime]:
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def _extract_forecast_points(payload: Any) -> list[dict[str, Any]]:
    if isinstance(payload, list):
        return payload
    if isinstance(payload, dict) and isinstance(payload.get("forecast"), list):
        return payload["forecast"]
    if isinstance(payload, dict) and isinstance(payload.get("data"), list):
        return payload["data"]
    return []


def get_carbon_intensity_latest(
    zone: str,
    *,
    base_url: Optional[str] = None,
    timeout_seconds: Optional[int] = None,
    max_attempts: Optional[int] = None,
    cache_ttl_seconds: Optional[int] = None,
) -> SensorLatestResult:
    base = (base_url or settings.electricitymaps_base_url).rstrip("/")
    timeout = timeout_seconds or settings.request_timeout_seconds
    attempts = max_attempts or settings.retry_max_attempts
    ttl = cache_ttl_seconds if cache_ttl_seconds is not None else settings.cache_ttl_seconds

    key = (base, "latest", zone, 0)
    cached = _cache_get(key, ttl)
    if cached is not None:
        return cached  # type: ignore[return-value]

    if not settings.electricitymaps_key:
        return {"ok": False, "zone": zone, "intensity": None, "timestamp": None, "error": "Missing ELECTRICITYMAPS_KEY"}

    url = f"{base}/v3/carbon-intensity/latest?zone={zone}"
    headers = {"auth-token": settings.electricitymaps_key}
    payload, error = _request_json_with_retry(url, headers, timeout, attempts)
    if error:
        return {"ok": False, "zone": zone, "intensity": None, "timestamp": None, "error": error}

    _mark_sensor_success(payload.get("datetime") if isinstance(payload, dict) else None)
    intensity = payload.get("carbonIntensity")
    timestamp = payload.get("datetime")
    if intensity is None:
        return {
            "ok": False,
            "zone": zone,
            "intensity": None,
            "timestamp": timestamp,
            "error": "Response missing 'carbonIntensity'",
        }

    result: SensorLatestResult = {
        "ok": True,
        "zone": zone,
        "intensity": int(intensity),
        "timestamp": timestamp,
        "error": None,
    }
    _cache_set(key, result)
    return result


def _normalize_zones(zones: list[str], max_zones: int) -> list[str]:
    deduped: list[str] = []
    seen: set[str] = set()
    for zone in zones:
        normalized = zone.strip()
        if not normalized or normalized in seen:
            continue
        deduped.append(normalized)
        seen.add(normalized)

    if max_zones > 0:
        return deduped[:max_zones]
    return deduped


def _to_candidate(zone: str, result: SensorLatestResult) -> CandidateIntensity:
    if result["ok"] and result["intensity"] is not None:
        return {
            "zone": zone,
            "ok": True,
            "carbonIntensity": int(result["intensity"]),
            "datetime": result["timestamp"],
            "error": None,
        }
    return {
        "zone": zone,
        "ok": False,
        "carbonIntensity": None,
        "datetime": result["timestamp"],
        "error": result["error"] or "Unable to fetch latest carbon intensity",
    }


def _fetch_zone_latest(
    zone: str,
    *,
    base_url: Optional[str],
    timeout_seconds: Optional[int],
    max_attempts: Optional[int],
    cache_ttl_seconds: Optional[int],
) -> CandidateIntensity:
    result = get_carbon_intensity_latest(
        zone,
        base_url=base_url,
        timeout_seconds=timeout_seconds,
        max_attempts=max_attempts,
        cache_ttl_seconds=cache_ttl_seconds,
    )
    return _to_candidate(zone, result)


def _fetch_sequential(
    zones: list[str],
    *,
    base_url: Optional[str],
    timeout_seconds: Optional[int],
    max_attempts: Optional[int],
    cache_ttl_seconds: Optional[int],
) -> list[CandidateIntensity]:
    return [
        _fetch_zone_latest(
            zone,
            base_url=base_url,
            timeout_seconds=timeout_seconds,
            max_attempts=max_attempts,
            cache_ttl_seconds=cache_ttl_seconds,
        )
        for zone in zones
    ]


def _fetch_parallel(
    zones: list[str],
    *,
    base_url: Optional[str],
    timeout_seconds: Optional[int],
    max_attempts: Optional[int],
    cache_ttl_seconds: Optional[int],
    workers: int,
) -> list[CandidateIntensity]:
    if not zones:
        return []

    worker_count = max(1, min(workers, len(zones)))
    results: list[Optional[CandidateIntensity]] = [None] * len(zones)

    with ThreadPoolExecutor(max_workers=worker_count) as executor:
        index_by_future = {
            executor.submit(
                _fetch_zone_latest,
                zone,
                base_url=base_url,
                timeout_seconds=timeout_seconds,
                max_attempts=max_attempts,
                cache_ttl_seconds=cache_ttl_seconds,
            ): index
            for index, zone in enumerate(zones)
        }

        for future in as_completed(index_by_future):
            index = index_by_future[future]
            try:
                results[index] = future.result()
            except Exception as exc:
                zone = zones[index]
                results[index] = {
                    "zone": zone,
                    "ok": False,
                    "carbonIntensity": None,
                    "datetime": None,
                    "error": f"Parallel fetch error: {exc}",
                }

    return [result for result in results if result is not None]


def get_latest_for_zones(
    zones: Optional[list[str]] = None,
    *,
    base_url: Optional[str] = None,
    timeout_seconds: Optional[int] = None,
    max_attempts: Optional[int] = None,
    cache_ttl_seconds: Optional[int] = None,
    max_zones: Optional[int] = None,
    fetch_mode: Optional[str] = None,
    parallel_workers: Optional[int] = None,
) -> list[CandidateIntensity]:
    candidate_zones = zones if zones is not None else settings.routing_candidate_zones
    capped_max = max_zones if max_zones is not None else settings.max_routing_candidates
    selected_mode = (fetch_mode or settings.candidate_fetch_mode).strip().lower()
    workers = parallel_workers if parallel_workers is not None else settings.parallel_fetch_workers

    normalized = _normalize_zones(candidate_zones, capped_max)
    if not normalized:
        return []

    if selected_mode == "parallel":
        return _fetch_parallel(
            normalized,
            base_url=base_url,
            timeout_seconds=timeout_seconds,
            max_attempts=max_attempts,
            cache_ttl_seconds=cache_ttl_seconds,
            workers=workers,
        )

    return _fetch_sequential(
        normalized,
        base_url=base_url,
        timeout_seconds=timeout_seconds,
        max_attempts=max_attempts,
        cache_ttl_seconds=cache_ttl_seconds,
    )


def get_carbon_intensity_forecast(
    zone: str,
    *,
    window_hours: Optional[int] = None,
    base_url: Optional[str] = None,
    timeout_seconds: Optional[int] = None,
    max_attempts: Optional[int] = None,
    cache_ttl_seconds: Optional[int] = None,
) -> ForecastResult:
    base = (base_url or settings.electricitymaps_base_url).rstrip("/")
    timeout = timeout_seconds or settings.request_timeout_seconds
    attempts = max_attempts or settings.retry_max_attempts
    ttl = cache_ttl_seconds if cache_ttl_seconds is not None else settings.cache_ttl_seconds
    hours = window_hours or settings.forecast_window_hours

    key = (base, "forecast", zone, hours)
    cached = _cache_get(key, ttl)
    if cached is not None:
        return cached  # type: ignore[return-value]

    if not settings.electricitymaps_key:
        return {"ok": False, "zone": zone, "points": [], "best_point": None, "error": "Missing ELECTRICITYMAPS_KEY"}

    url = f"{base}/v3/carbon-intensity/forecast?zone={zone}"
    headers = {"auth-token": settings.electricitymaps_key}
    payload, error = _request_json_with_retry(url, headers, timeout, attempts)
    if error:
        return {"ok": False, "zone": zone, "points": [], "best_point": None, "error": error}

    if isinstance(payload, dict):
        _mark_sensor_success(payload.get("datetime"))
    else:
        _mark_sensor_success()
    raw_points = _extract_forecast_points(payload)
    now_utc = datetime.now(timezone.utc)
    window_end = now_utc + timedelta(hours=hours)

    points: list[ForecastPoint] = []
    for point in raw_points:
        dt_value = point.get("datetime")
        ci = point.get("carbonIntensity")
        parsed_dt = _parse_dt(dt_value)
        if parsed_dt is None or ci is None:
            continue
        if parsed_dt < now_utc or parsed_dt > window_end:
            continue
        points.append({"datetime": parsed_dt.isoformat(), "carbonIntensity": int(ci)})

    points.sort(key=lambda p: p["datetime"])
    best_point = min(points, key=lambda p: p["carbonIntensity"]) if points else None

    result: ForecastResult = {
        "ok": True,
        "zone": zone,
        "points": points,
        "best_point": best_point,
        "error": None,
    }
    _cache_set(key, result)
    return result
