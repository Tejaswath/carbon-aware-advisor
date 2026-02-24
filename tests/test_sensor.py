from datetime import datetime, timedelta, timezone

import pytest
import requests

from src import sensor


class DummyResponse:
    def __init__(self, status_code: int, payload: dict):
        self.status_code = status_code
        self._payload = payload

    def json(self):
        return self._payload

    def raise_for_status(self):
        if self.status_code >= 400:
            err = requests.HTTPError(f"status={self.status_code}")
            err.response = self
            raise err


@pytest.fixture(autouse=True)
def _clear_cache_fixture():
    sensor.clear_cache()


def test_latest_success(monkeypatch):
    def fake_get(url, headers, timeout):
        assert "latest" in url
        return DummyResponse(200, {"carbonIntensity": 55, "datetime": "2026-02-20T01:00:00Z"})

    monkeypatch.setattr(sensor.requests, "get", fake_get)
    monkeypatch.setattr(sensor.settings, "electricitymaps_key", "test-key")

    result = sensor.get_carbon_intensity_latest("SE3", cache_ttl_seconds=300)
    assert result["ok"] is True
    assert result["intensity"] == 55


def test_forecast_best_point_within_window(monkeypatch):
    now = datetime.now(timezone.utc)
    payload = {
        "forecast": [
            {"datetime": (now + timedelta(hours=1)).isoformat(), "carbonIntensity": 50},
            {"datetime": (now + timedelta(hours=2)).isoformat(), "carbonIntensity": 20},
            {"datetime": (now + timedelta(hours=30)).isoformat(), "carbonIntensity": 5},
        ]
    }

    def fake_get(url, headers, timeout):
        assert "forecast" in url
        return DummyResponse(200, payload)

    monkeypatch.setattr(sensor.requests, "get", fake_get)
    monkeypatch.setattr(sensor.settings, "electricitymaps_key", "test-key")

    result = sensor.get_carbon_intensity_forecast("SE3", window_hours=24)
    assert result["ok"] is True
    assert result["best_point"] is not None
    assert result["best_point"]["carbonIntensity"] == 20


def test_cache_hit_skips_second_request(monkeypatch):
    calls = {"count": 0}

    def fake_get(url, headers, timeout):
        calls["count"] += 1
        return DummyResponse(200, {"carbonIntensity": 42, "datetime": "2026-02-20T01:00:00Z"})

    monkeypatch.setattr(sensor.requests, "get", fake_get)
    monkeypatch.setattr(sensor.settings, "electricitymaps_key", "test-key")

    first = sensor.get_carbon_intensity_latest("SE3", cache_ttl_seconds=300)
    second = sensor.get_carbon_intensity_latest("SE3", cache_ttl_seconds=300)

    assert first["ok"] and second["ok"]
    assert calls["count"] == 1


def test_retry_on_429_then_success(monkeypatch):
    responses = [
        DummyResponse(429, {"error": "rate limited"}),
        DummyResponse(200, {"carbonIntensity": 33, "datetime": "2026-02-20T01:00:00Z"}),
    ]

    def fake_get(url, headers, timeout):
        return responses.pop(0)

    monkeypatch.setattr(sensor.requests, "get", fake_get)
    monkeypatch.setattr(sensor.settings, "electricitymaps_key", "test-key")
    monkeypatch.setattr(sensor.time, "sleep", lambda _: None)
    monkeypatch.setattr(sensor.random, "uniform", lambda a, b: 0)

    result = sensor.get_carbon_intensity_latest("SE3", max_attempts=3, cache_ttl_seconds=0)
    assert result["ok"] is True
    assert result["intensity"] == 33


def test_no_retry_on_non_429_4xx(monkeypatch):
    calls = {"count": 0}

    def fake_get(url, headers, timeout):
        calls["count"] += 1
        return DummyResponse(401, {"error": "unauthorized"})

    monkeypatch.setattr(sensor.requests, "get", fake_get)
    monkeypatch.setattr(sensor.settings, "electricitymaps_key", "test-key")

    result = sensor.get_carbon_intensity_latest("SE3", max_attempts=3, cache_ttl_seconds=0)
    assert result["ok"] is False
    assert calls["count"] == 1


def test_get_latest_for_zones_sequential_mixed_results(monkeypatch):
    mapping = {
        "SE-SE3": {"ok": True, "zone": "SE-SE3", "intensity": 50, "timestamp": "2026-02-20T01:00:00Z", "error": None},
        "SE-SE1": {"ok": False, "zone": "SE-SE1", "intensity": None, "timestamp": None, "error": "HTTP error (401): status=401"},
        "NO-NO1": {"ok": True, "zone": "NO-NO1", "intensity": 20, "timestamp": "2026-02-20T01:05:00Z", "error": None},
    }

    def fake_latest(zone, **kwargs):
        return mapping[zone]

    monkeypatch.setattr(sensor, "get_carbon_intensity_latest", fake_latest)

    result = sensor.get_latest_for_zones(["SE-SE3", "SE-SE1", "NO-NO1"], fetch_mode="sequential", max_zones=6)
    assert [row["zone"] for row in result] == ["SE-SE3", "SE-SE1", "NO-NO1"]
    assert result[0]["ok"] is True and result[0]["carbonIntensity"] == 50
    assert result[1]["ok"] is False and result[1]["carbonIntensity"] is None
    assert result[2]["ok"] is True and result[2]["carbonIntensity"] == 20


def test_get_latest_for_zones_respects_max_cap(monkeypatch):
    calls = {"count": 0}

    def fake_latest(zone, **kwargs):
        calls["count"] += 1
        return {"ok": True, "zone": zone, "intensity": 10, "timestamp": "2026-02-20T01:00:00Z", "error": None}

    monkeypatch.setattr(sensor, "get_carbon_intensity_latest", fake_latest)

    zones = ["A", "B", "C", "D", "E", "F", "G"]
    result = sensor.get_latest_for_zones(zones, fetch_mode="sequential", max_zones=4)
    assert len(result) == 4
    assert calls["count"] == 4


def test_parallel_fetch_matches_sequential(monkeypatch):
    intensities = {
        "SE-SE3": 44,
        "SE-SE1": 20,
        "SE-SE2": 28,
        "SE-SE4": 33,
    }

    def fake_latest(zone, **kwargs):
        return {
            "ok": True,
            "zone": zone,
            "intensity": intensities[zone],
            "timestamp": f"2026-02-20T0{intensities[zone] % 10}:00:00Z",
            "error": None,
        }

    monkeypatch.setattr(sensor, "get_carbon_intensity_latest", fake_latest)
    zones = ["SE-SE3", "SE-SE1", "SE-SE2", "SE-SE4"]

    sequential = sensor.get_latest_for_zones(zones, fetch_mode="sequential", max_zones=6)
    parallel = sensor.get_latest_for_zones(zones, fetch_mode="parallel", max_zones=6, parallel_workers=2)

    seq_by_zone = {row["zone"]: row for row in sequential}
    par_by_zone = {row["zone"]: row for row in parallel}
    assert seq_by_zone == par_by_zone


def test_429_subset_soft_failure_per_candidate(monkeypatch):
    def fake_latest(zone, **kwargs):
        if zone == "SE-SE1":
            return {
                "ok": False,
                "zone": zone,
                "intensity": None,
                "timestamp": None,
                "error": "HTTP error (429): status=429",
            }
        return {
            "ok": True,
            "zone": zone,
            "intensity": 15,
            "timestamp": "2026-02-20T01:00:00Z",
            "error": None,
        }

    monkeypatch.setattr(sensor, "get_carbon_intensity_latest", fake_latest)

    result = sensor.get_latest_for_zones(["SE-SE3", "SE-SE1", "NO-NO1"], fetch_mode="sequential", max_zones=6)
    assert len(result) == 3
    assert result[1]["zone"] == "SE-SE1"
    assert result[1]["ok"] is False
    assert "429" in (result[1]["error"] or "")


def test_sequential_call_count_equals_capped_candidates(monkeypatch):
    calls = {"count": 0}

    def fake_latest(zone, **kwargs):
        calls["count"] += 1
        return {"ok": True, "zone": zone, "intensity": 18, "timestamp": "2026-02-20T01:00:00Z", "error": None}

    monkeypatch.setattr(sensor, "get_carbon_intensity_latest", fake_latest)
    monkeypatch.setattr(sensor.settings, "routing_candidate_zones", ["Z1", "Z2", "Z3", "Z4", "Z5", "Z6"])
    monkeypatch.setattr(sensor.settings, "max_routing_candidates", 3)
    monkeypatch.setattr(sensor.settings, "candidate_fetch_mode", "sequential")

    result = sensor.get_latest_for_zones()
    assert len(result) == 3
    assert calls["count"] == 3


def test_sensor_health_snapshot_defaults_to_unreachable():
    snapshot = sensor.get_sensor_health_snapshot()
    assert snapshot["sensor_reachable"] is False
    assert snapshot["last_sensor_success_at"] is None


def test_sensor_health_snapshot_updates_on_success(monkeypatch):
    def fake_get(url, headers, timeout):
        return DummyResponse(200, {"carbonIntensity": 41, "datetime": "2026-02-20T01:00:00Z"})

    monkeypatch.setattr(sensor.requests, "get", fake_get)
    monkeypatch.setattr(sensor.settings, "electricitymaps_key", "test-key")
    sensor.get_carbon_intensity_latest("SE3", cache_ttl_seconds=0)

    snapshot = sensor.get_sensor_health_snapshot(stale_after_seconds=999999)
    assert snapshot["sensor_reachable"] is True
    assert snapshot["last_sensor_success_at"] is not None
