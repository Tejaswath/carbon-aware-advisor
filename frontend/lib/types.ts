export type DecisionStatus =
  | "processing"
  | "awaiting_approval"
  | "completed"
  | "postponed"
  | "error";

export type ManagerOption = "run_local" | "route" | "postpone";
export type DemoScenario = "clean_local" | "routeable_dirty" | "non_routeable_dirty";

export type RoutingCandidate = {
  zone: string;
  carbonIntensity: number | null;
  datetime: string | null;
  ok: boolean;
  error: string | null;
};

export type TimelineEvent = {
  ts: string;
  stage: string;
  message: string;
  data: Record<string, unknown>;
};

export type DecisionResponse = {
  decision_id: string;
  status: DecisionStatus;
  primary_zone: string;
  primary_intensity: number | null;
  selected_execution_zone: string | null;
  selected_execution_intensity: number | null;
  execution_mode: "local" | "routed" | "postponed" | null;
  policy_action: "run_now_local" | "route_to_clean_region" | "require_manager_decision" | null;
  policy_reason: string | null;
  estimated_kgco2_local: number | null;
  estimated_kgco2_routed: number | null;
  estimated_kgco2_saved_by_routing: number | null;
  accounting_method: "location-based";
  manager_options: Array<ManagerOption>;
  manager_prompt: string | null;
  manager_id: string | null;
  override_reason: string | null;
  forecast_recommendation: string | null;
  audit_mode: "llm" | "template" | "pending" | null;
  audit_report: string | null;
  routing_top3: Array<RoutingCandidate>;
  timeline: Array<TimelineEvent>;
  forecast_available: boolean;
  error: string | null;
};

export type ManagerActionRequest = {
  manager_id: string;
  override_reason?: string;
};

export type StartDecisionRequest = {
  estimated_kwh: number;
  threshold?: number;
  zone?: string;
  demo_scenario?: DemoScenario;
};
