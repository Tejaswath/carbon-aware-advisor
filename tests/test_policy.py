from src.policy import evaluate_policy


def test_policy_clean_routes_run_now_local() -> None:
    result = evaluate_policy(35, 40, "NO-NO1", 20)
    assert result["label"] == "clean"
    assert result["action"] == "run_now_local"


def test_policy_dirty_with_route_candidate_recommends_routing() -> None:
    result = evaluate_policy(62, 40, "NO-NO1", 18)
    assert result["label"] == "dirty"
    assert result["action"] == "route_to_clean_region"
    assert "Recommended route" in result["reason"]


def test_policy_dirty_without_route_candidate_requires_manager_decision() -> None:
    result = evaluate_policy(62, 40, None, None)
    assert result["label"] == "dirty"
    assert result["action"] == "require_manager_decision"
    assert "no compliant routing candidate" in result["reason"].lower()
