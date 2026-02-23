from typing import Optional

from src.models import PolicyDecision


def evaluate_policy(
    current_intensity: int,
    threshold: int,
    selected_execution_zone: Optional[str],
    selected_execution_intensity: Optional[int],
) -> PolicyDecision:
    if current_intensity <= threshold:
        return {
            "label": "clean",
            "action": "run_now_local",
            "reason": (
                f"Current carbon intensity ({current_intensity} gCO2eq/kWh) is within threshold "
                f"({threshold} gCO2eq/kWh)."
            ),
        }

    if selected_execution_zone and selected_execution_intensity is not None:
        return {
            "label": "dirty",
            "action": "route_to_clean_region",
            "reason": (
                f"Current intensity ({current_intensity} gCO2eq/kWh) exceeds threshold ({threshold} gCO2eq/kWh). "
                f"Recommended route: {selected_execution_zone} at {selected_execution_intensity} gCO2eq/kWh."
            ),
        }

    return {
        "label": "dirty",
        "action": "require_manager_decision",
        "reason": (
            f"Current intensity ({current_intensity} gCO2eq/kWh) exceeds threshold ({threshold} gCO2eq/kWh) "
            "and no compliant routing candidate is available."
        ),
    }
