"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { signOut, useSession } from "next-auth/react";

import { ThemeToggle } from "@/components/theme-toggle";
import { PolicyActionBadge, StatusBadge } from "@/components/status-badge";
import { api } from "@/lib/api";
import { useThemePreference } from "@/lib/use-theme-preference";
import { DecisionResponse, DemoScenario, ManagerOption, StartDecisionRequest } from "@/lib/types";

const POLL_MS = 2000;
const TIMEOUT_MS = 90000;
const GEOLOCATION_TIMEOUT_MS = 15000;
const MARGINAL_OVER_THRESHOLD_FACTOR = 1.3;
const MANAGER_CONFIRM_TIMEOUT_MS = 3000;
const DEFAULT_PRIMARY_ZONES = ["SE-SE1", "SE-SE2", "SE-SE3", "SE-SE4"];
const CONFIGURED_PRIMARY_ZONES = (
  process.env.NEXT_PUBLIC_PRIMARY_ZONES ?? DEFAULT_PRIMARY_ZONES.join(",")
)
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);
const ZONE_LABELS: Record<string, string> = {
  "SE-SE1": "SE-SE1 (North Sweden)",
  "SE-SE2": "SE-SE2 (Mid-North Sweden)",
  "SE-SE3": "SE-SE3 (Stockholm)",
  "SE-SE4": "SE-SE4 (South Sweden)"
};
const COUNTRY_LABELS: Record<string, string> = {
  SE: "Sweden",
  NO: "Norway",
  DK: "Denmark",
  FI: "Finland"
};
const PRIMARY_ZONE_STORAGE_KEY = "carbon_advisor.primary_zone";
const APPROVER_NAME_STORAGE_KEY = "carbon_advisor.approver_name";
const APPROVER_ORG_STORAGE_KEY = "carbon_advisor.approver_org";
const INTRO_SEEN_STORAGE_KEY = "carbon_advisor.intro_seen";
const DEMO_SCENARIO_LABELS: Record<DemoScenario, string> = {
  clean_local: "Demo: Grid Clean",
  routeable_dirty: "Demo: Route Available",
  non_routeable_dirty: "Demo: Needs Approval"
};
const THRESHOLD_PRESETS = [
  {
    key: "strict",
    label: "Strict (<=20)",
    value: 20,
    description: "Aggressive decarbonization policy. More approvals and routing expected."
  },
  {
    key: "moderate",
    label: "Moderate (<=40)",
    value: 40,
    description: "Balanced policy for reliability and carbon reduction."
  },
  {
    key: "relaxed",
    label: "Relaxed (<=80)",
    value: 80,
    description: "Permissive policy. Fewer routing decisions."
  }
] as const;
const WORKFLOW_STEPS = ["Sensing", "Policy", "Approval", "Execution", "Audit"] as const;

type ThresholdPresetKey = (typeof THRESHOLD_PRESETS)[number]["key"] | "custom";
type TradeoffRow = {
  option: "Run Local" | "Route" | "Postpone";
  zone: string;
  carbon: string;
  latency: string;
  dataResidency: string;
  costImpact: string;
};

type IntensitySeverity = "clean" | "marginal" | "dirty" | "unknown";
type UIState = "idle" | "submitting" | "processing" | "awaiting_approval" | "final" | "error";

const defaultDecision: DecisionResponse = {
  decision_id: "",
  status: "processing",
  primary_zone: CONFIGURED_PRIMARY_ZONES[0] ?? "SE-SE3",
  primary_intensity: null,
  selected_execution_zone: null,
  selected_execution_intensity: null,
  execution_mode: null,
  policy_action: null,
  policy_reason: null,
  estimated_kgco2_local: null,
  estimated_kgco2_routed: null,
  estimated_kgco2_saved_by_routing: null,
  accounting_method: "location-based",
  manager_options: [],
  manager_prompt: null,
  manager_id: null,
  override_reason: null,
  forecast_recommendation: null,
  audit_mode: null,
  audit_report: null,
  routing_top3: [],
  timeline: [],
  forecast_available: false,
  error: null
};

function formatTimestamp(value: string | null): string {
  if (!value) return "Unavailable";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

function managerLabel(option: ManagerOption, routeZone: string | null): string {
  if (option === "run_local") return "Run Local";
  if (option === "route") return `Route to ${routeZone ?? "candidate zone"}`;
  return "Postpone";
}

function zoneLabel(zone: string): string {
  return ZONE_LABELS[zone] ?? zone;
}

function inferSwedenZoneFromCoordinates(latitude: number, longitude: number): string | null {
  const inSwedenBounds = latitude >= 55 && latitude <= 69 && longitude >= 10 && longitude <= 25;
  if (!inSwedenBounds) return null;
  if (latitude >= 65.5) return "SE-SE1";
  if (latitude >= 61.5) return "SE-SE2";
  if (latitude >= 57.5) return "SE-SE3";
  return "SE-SE4";
}

function activeScenarioFromTimeline(decision: DecisionResponse): DemoScenario | null {
  const primarySensorEvent = decision.timeline.find((event) => event.stage === "sensor.primary");
  if (!primarySensorEvent?.data || typeof primarySensorEvent.data !== "object") return null;
  const value = (primarySensorEvent.data as Record<string, unknown>).demo_scenario;
  if (value === "clean_local" || value === "routeable_dirty" || value === "non_routeable_dirty") return value;
  return null;
}

function thresholdPresetForValue(value: number): ThresholdPresetKey {
  const matched = THRESHOLD_PRESETS.find((preset) => preset.value === value);
  return matched?.key ?? "custom";
}

function digitsOnly(raw: string): string {
  return raw.replace(/[^0-9]/g, "");
}

function parsePositiveInt(raw: string, fallback: number): number {
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

function countryCodeFromZone(zone: string | null): string | null {
  if (!zone) return null;
  const first = zone.split("-")[0]?.trim();
  if (!first) return null;
  return first.toUpperCase();
}

function countryLabelFromZone(zone: string | null): string {
  const code = countryCodeFromZone(zone);
  if (!code) return "Unknown";
  return COUNTRY_LABELS[code] ?? code;
}

function estimatedLatency(primaryZone: string | null, targetZone: string | null): string {
  if (!primaryZone || !targetZone) return "N/A";
  if (primaryZone === targetZone) return "Baseline";
  const primaryCountry = countryCodeFromZone(primaryZone);
  const targetCountry = countryCodeFromZone(targetZone);
  if (primaryCountry && targetCountry && primaryCountry === targetCountry) return "+15-30ms";
  return "+40-90ms";
}

function intensitySeverity(intensity: number | null, threshold: number): IntensitySeverity {
  if (intensity === null) return "unknown";
  if (intensity <= threshold) return "clean";
  if (intensity <= threshold * MARGINAL_OVER_THRESHOLD_FACTOR) return "marginal";
  return "dirty";
}

function intensityClassName(severity: IntensitySeverity): string {
  if (severity === "clean") return "text-emerald-700 dark:text-emerald-400";
  if (severity === "marginal") return "text-amber-700 dark:text-amber-400";
  if (severity === "dirty") return "text-red-700 dark:text-red-400";
  return "text-ink";
}

function geolocationErrorMessage(geoError: GeolocationPositionError): string {
  if (geoError.code === 1) {
    return "Location permission denied. Enable location access in your browser and retry.";
  }
  if (geoError.code === 2) {
    return "Location unavailable. Check device location services and retry.";
  }
  if (geoError.code === 3) {
    return "Location request timed out. Retry, or keep manual zone selection.";
  }
  return `Location unavailable: ${geoError.message || "Unknown geolocation error."}`;
}

function processingStepLabel(decision: DecisionResponse, uiState: UIState): string | null {
  if (uiState === "awaiting_approval") return "Awaiting manager decision...";
  if (uiState !== "processing") return null;
  if (decision.timeline.length === 0) return "Initializing decision...";
  const stages = new Set(decision.timeline.map((event) => event.stage));
  if (stages.has("timeline.finalized") || stages.has("audit.generated")) return "Generating audit...";
  if (stages.has("execution.final")) return "Finalizing execution...";
  if (stages.has("policy.result")) return "Evaluating policy...";
  if (stages.has("sensor.primary") || stages.has("sensor.candidates")) return "Sensing grid...";
  return "Preparing decision...";
}

function splitAuditParagraphs(text: string | null): string[] {
  if (!text) return [];
  const normalized = text
    .replace(/\*\*(.*?)\*\*/g, "$1")
    .replace(/__(.*?)__/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (!normalized) return [];
  const byBlankLine = normalized
    .split(/\n\s*\n/)
    .map((part) => part.trim())
    .filter(Boolean);
  if (byBlankLine.length > 1) return byBlankLine;
  return normalized
    .split(/(?<=\.)\s+(?=[A-Z])/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function cleanManagerPrompt(prompt: string): string {
  let cleaned = prompt.trim();
  cleaned = cleaned.replace(/Choose:\s*run_local,\s*route,\s*or\s*postpone\.?/gi, "Choose an action below.");
  cleaned = cleaned.replace(/Choose:\s*run_local\s*or\s*postpone\.?/gi, "Choose an action below.");
  cleaned = cleaned.replace(/\brun_local\b/g, "run local");
  cleaned = cleaned.replace(/\broute_to_clean_region\b/g, "route to a cleaner region");
  cleaned = cleaned.replace(/\brequire_manager_decision\b/g, "manager approval required");
  return cleaned;
}

function workflowStepIndex(decision: DecisionResponse, uiState: UIState): number {
  if (uiState === "idle") return -1;
  if (uiState === "submitting") return 0;
  if (uiState === "awaiting_approval") return 2;
  if (uiState === "final" || uiState === "error") return 4;

  const stages = new Set(decision.timeline.map((event) => event.stage));
  if (stages.has("audit.generated") || stages.has("timeline.finalized")) return 4;
  if (stages.has("execution.final")) return 3;
  if (stages.has("manager.prompted") || stages.has("manager.decision")) return 2;
  if (stages.has("policy.result")) return 1;
  if (stages.has("sensor.primary") || stages.has("sensor.candidates")) return 0;
  return 0;
}

export default function HomePage() {
  const { data: session, status: sessionStatus } = useSession();
  const [estimatedKwhStr, setEstimatedKwhStr] = useState<string>("500");
  const [thresholdStr, setThresholdStr] = useState<string>("40");
  const estimatedKwh = parsePositiveInt(estimatedKwhStr, 1);
  const threshold = parsePositiveInt(thresholdStr, 1);
  const [thresholdPreset, setThresholdPreset] = useState<ThresholdPresetKey>(thresholdPresetForValue(40));
  const [zone, setZone] = useState<string>(CONFIGURED_PRIMARY_ZONES[0] ?? "SE-SE3");
  const [approverName, setApproverName] = useState<string>("");
  const [approverOrg, setApproverOrg] = useState<string>("");
  const [showApproverProfile, setShowApproverProfile] = useState<boolean>(false);
  const [overrideReason, setOverrideReason] = useState<string>("");
  const [geoHint, setGeoHint] = useState<string>("");
  const [canRetryGeo, setCanRetryGeo] = useState<boolean>(false);
  const [showIntroModal, setShowIntroModal] = useState<boolean>(false);
  const [showDemoScenarios, setShowDemoScenarios] = useState<boolean>(false);
  const { resolvedTheme, toggleTheme } = useThemePreference();

  const [decision, setDecision] = useState<DecisionResponse>(defaultDecision);
  const [decisionId, setDecisionId] = useState<string>("");
  const [uiState, setUiState] = useState<UIState>("idle");
  const [error, setError] = useState<string>("");
  const [selectedManagerAction, setSelectedManagerAction] = useState<ManagerOption | null>(null);
  const [armedManagerAction, setArmedManagerAction] = useState<ManagerOption | null>(null);
  const [lastStartPayload, setLastStartPayload] = useState<StartDecisionRequest | null>(null);
  const approverEmail = session?.user?.email?.trim() ?? "";

  const startedAtRef = useRef<number | null>(null);
  const shouldPoll = uiState === "processing" && Boolean(decisionId);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const savedZone = window.localStorage.getItem(PRIMARY_ZONE_STORAGE_KEY);
    const savedApproverName = window.localStorage.getItem(APPROVER_NAME_STORAGE_KEY);
    const savedApproverOrg = window.localStorage.getItem(APPROVER_ORG_STORAGE_KEY);
    const introSeen = window.localStorage.getItem(INTRO_SEEN_STORAGE_KEY);

    if (savedZone) setZone(savedZone);
    if (savedApproverName) {
      setApproverName(savedApproverName);
      setShowApproverProfile(true);
    }
    if (savedApproverOrg) {
      setApproverOrg(savedApproverOrg);
      setShowApproverProfile(true);
    }
    if (!introSeen) setShowIntroModal(true);
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(PRIMARY_ZONE_STORAGE_KEY, zone);
  }, [zone]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(APPROVER_NAME_STORAGE_KEY, approverName);
  }, [approverName]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(APPROVER_ORG_STORAGE_KEY, approverOrg);
  }, [approverOrg]);

  useEffect(() => {
    if (!showIntroModal) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        dismissIntroModal();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [showIntroModal]);

  useEffect(() => {
    if (!armedManagerAction) return;
    const id = window.setTimeout(() => {
      setArmedManagerAction(null);
    }, MANAGER_CONFIRM_TIMEOUT_MS);
    return () => window.clearTimeout(id);
  }, [armedManagerAction]);

  useEffect(() => {
    if (!shouldPoll) return;

    const poll = async () => {
      try {
        const next = await api.getDecision(decisionId);
        setDecision(next);

        if (next.status === "awaiting_approval") {
          setUiState("awaiting_approval");
          return;
        }
        if (next.status === "completed" || next.status === "postponed") {
          setUiState("final");
          return;
        }
        if (next.status === "error") {
          setUiState("error");
          setError(next.error || "Decision workflow failed.");
          return;
        }

        if (startedAtRef.current && Date.now() - startedAtRef.current > TIMEOUT_MS) {
          setUiState("error");
          setError("Polling timed out after 90 seconds. Retry with the same decision ID.");
        }
      } catch (err) {
        setUiState("error");
        setError(err instanceof Error ? err.message : "Polling failed");
      }
    };

    void poll();
    const id = window.setInterval(() => {
      void poll();
    }, POLL_MS);

    return () => window.clearInterval(id);
  }, [decisionId, shouldPoll]);

  const startDecision = async (payload: StartDecisionRequest) => {
    try {
      setUiState("submitting");
      setError("");
      setGeoHint("");
      setCanRetryGeo(false);
      setOverrideReason("");
      setArmedManagerAction(null);
      setSelectedManagerAction(null);

      const started = await api.startDecision(payload);

      setDecision(started);
      setDecisionId(started.decision_id);
      startedAtRef.current = Date.now();
      setUiState("processing");
      setLastStartPayload(payload);
    } catch (err) {
      setUiState("error");
      setError(err instanceof Error ? err.message : "Unable to start decision");
    }
  };

  const onStart = async (demoScenario: DemoScenario | null = null) => {
    const payload: StartDecisionRequest = {
      estimated_kwh: estimatedKwh,
      threshold,
      zone,
      demo_scenario: demoScenario ?? undefined
    };
    await startDecision(payload);
  };

  const onRetryLastDecision = async () => {
    if (!lastStartPayload) return;
    await startDecision(lastStartPayload);
  };

  const onResetDecision = () => {
    setDecision(defaultDecision);
    setDecisionId("");
    setUiState("idle");
    setError("");
    setGeoHint("");
    setCanRetryGeo(false);
    setOverrideReason("");
    setArmedManagerAction(null);
    setSelectedManagerAction(null);
    startedAtRef.current = null;
  };

  const dismissIntroModal = () => {
    setShowIntroModal(false);
    if (typeof window === "undefined") return;
    window.localStorage.setItem(INTRO_SEEN_STORAGE_KEY, "1");
  };

  const onSuggestPrimaryZone = () => {
    if (typeof window === "undefined" || !window.navigator.geolocation) {
      setGeoHint("Geolocation is not available in this browser. Use manual zone selection.");
      setCanRetryGeo(false);
      return;
    }

    setGeoHint("Detecting location...");
    setCanRetryGeo(false);
    window.navigator.geolocation.getCurrentPosition(
      ({ coords }) => {
        const suggested = inferSwedenZoneFromCoordinates(coords.latitude, coords.longitude);
        if (!suggested) {
          setGeoHint("Could not map your location to SE-SE1..SE-SE4. Keep manual selection.");
          setCanRetryGeo(true);
          return;
        }
        setZone(suggested);
        setGeoHint(`Suggested ${zoneLabel(suggested)} from your current location.`);
        setCanRetryGeo(false);
      },
      (geoError) => {
        setGeoHint(geolocationErrorMessage(geoError));
        setCanRetryGeo(true);
      },
      { enableHighAccuracy: false, timeout: GEOLOCATION_TIMEOUT_MS, maximumAge: 300000 }
    );
  };

  const recommendedManagerAction: ManagerOption | null = useMemo(() => {
    if (decision.policy_action === "route_to_clean_region") return "route";
    return null;
  }, [decision.policy_action]);

  const selectedActionIsOverride =
    selectedManagerAction !== null &&
    recommendedManagerAction !== null &&
    selectedManagerAction !== recommendedManagerAction;

  const submitManagerAction = async (option: ManagerOption) => {
    if (!decisionId) return;
    const cleanManagerId = approverEmail;
    const cleanOverrideReason = overrideReason.trim();
    const isOverride = recommendedManagerAction !== null && option !== recommendedManagerAction;

    if (!cleanManagerId) {
      setError("Signed-in account is missing an email address. Sign out and sign back in with Google.");
      return;
    }
    if (isOverride && !cleanOverrideReason) {
      setError("Override reason is required when manager action overrides the policy recommendation.");
      return;
    }

    try {
      setUiState("processing");
      setError("");
      setArmedManagerAction(null);

      let result: DecisionResponse;
      if (option === "run_local") {
        result = await api.runLocalDecision(decisionId, {
          manager_id: cleanManagerId,
          override_reason: cleanOverrideReason || undefined
        });
      } else if (option === "route") {
        result = await api.routeDecision(decisionId, {
          manager_id: cleanManagerId,
          override_reason: cleanOverrideReason || undefined
        });
      } else {
        result = await api.postponeDecision(decisionId, {
          manager_id: cleanManagerId,
          override_reason: cleanOverrideReason || undefined
        });
      }

      setDecision(result);
      setOverrideReason("");
      setSelectedManagerAction(null);
      if (result.status === "completed" || result.status === "postponed") {
        setUiState("final");
      } else if (result.status === "awaiting_approval") {
        setUiState("awaiting_approval");
      } else if (result.status === "error") {
        setUiState("error");
        setError(result.error || "Decision transition failed");
      } else {
        setUiState("processing");
      }
    } catch (err) {
      setUiState("error");
      setError(err instanceof Error ? err.message : "Decision action failed");
    }
  };

  const onManagerAction = async (option: ManagerOption) => {
    setSelectedManagerAction(option);
    if (armedManagerAction !== option) {
      setArmedManagerAction(option);
      setError("");
      return;
    }
    await submitManagerAction(option);
  };

  const onDownloadAudit = async () => {
    const isDownloadReady =
      Boolean(decisionId) && (uiState === "final" || decision.status === "completed" || decision.status === "postponed");
    if (!isDownloadReady) return;
    try {
      const blob = await api.downloadAuditCsv(decisionId);
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `${decisionId}_audit.csv`;
      anchor.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to download audit CSV");
    }
  };

  const statusForBadge = useMemo(() => {
    if (uiState === "awaiting_approval") return "awaiting_approval" as const;
    if (uiState === "final" || uiState === "error") return decision.status;
    return "processing" as const;
  }, [decision.status, uiState]);

  const canDownloadAudit =
    Boolean(decisionId) && (uiState === "final" || decision.status === "completed" || decision.status === "postponed");

  const zoneOptions = useMemo(() => {
    const ordered: string[] = [];
    const seen = new Set<string>();
    for (const candidate of [...CONFIGURED_PRIMARY_ZONES, zone]) {
      if (!candidate || seen.has(candidate)) continue;
      seen.add(candidate);
      ordered.push(candidate);
    }
    return ordered;
  }, [zone]);

  const activeDemoScenario = useMemo(() => activeScenarioFromTimeline(decision), [decision]);
  const thresholdPresetDescription = useMemo(() => {
    if (thresholdPreset === "custom") {
      return "Custom threshold. Use policy presets for recommended defaults.";
    }
    const selected = THRESHOLD_PRESETS.find((preset) => preset.key === thresholdPreset);
    return selected?.description ?? "Custom threshold.";
  }, [thresholdPreset]);

  const presetMatch = useMemo(() => THRESHOLD_PRESETS.find((preset) => preset.value === threshold) ?? null, [threshold]);

  const saved = decision.estimated_kgco2_saved_by_routing ?? 0;
  const isRealized = decision.execution_mode === "routed" && saved > 0;
  const isForegone = decision.execution_mode === "local" && saved > 0;
  const primaryIntensitySeverity = intensitySeverity(decision.primary_intensity, threshold);
  const selectedIntensitySeverity = intensitySeverity(decision.selected_execution_intensity, threshold);
  const activeProcessingStep = processingStepLabel(decision, uiState);
  const currentWorkflowStepIndex = workflowStepIndex(decision, uiState);
  const showProcessingBar = uiState === "processing";

  const decisionExplanation = useMemo(() => {
    if (decision.status === "processing") {
      return activeDemoScenario
        ? `Evaluating synthetic ${DEMO_SCENARIO_LABELS[activeDemoScenario]} scenario...`
        : "Evaluating primary and candidate grid zones...";
    }
    if (decision.status === "awaiting_approval") {
      if (decision.policy_action === "route_to_clean_region") {
        return `${decision.primary_zone} exceeds the configured threshold. A cleaner route is available via ${decision.selected_execution_zone ?? "a candidate zone"}. Review the decision briefing and choose an action.`;
      }
      return `${decision.primary_zone} exceeds the configured threshold and no compliant route is currently available. Review the briefing and choose run local or postpone.`;
    }
    if (decision.status === "error") {
      return decision.error || "Decision failed during workflow execution.";
    }
    if (decision.policy_action === "run_now_local" && decision.primary_intensity !== null) {
      return `No routing needed: ${decision.primary_zone} is ${decision.primary_intensity} gCO2eq/kWh, below threshold ${threshold} gCO2eq/kWh.`;
    }
    if (decision.execution_mode === "routed") {
      return `Routing executed: workload shifted to ${decision.selected_execution_zone} with estimated savings of ${decision.estimated_kgco2_saved_by_routing ?? 0} kgCO2.`;
    }
    if (decision.policy_action === "route_to_clean_region" && decision.execution_mode === "local") {
      return "Routing was available, but manager chose local execution (compliance/operational override).";
    }
    if (decision.execution_mode === "postponed") {
      return "Execution postponed by manager decision.";
    }
    return decision.policy_reason || "Decision completed.";
  }, [activeDemoScenario, decision, threshold]);

  const tradeoffRows = useMemo<TradeoffRow[]>(() => {
    const localZone = decision.primary_zone || zone;
    const routeCandidateFromTop3 =
      decision.routing_top3.find((candidate) => candidate.ok && candidate.zone !== localZone) ?? null;
    const routeZone =
      decision.selected_execution_zone && decision.selected_execution_zone !== localZone
        ? decision.selected_execution_zone
        : routeCandidateFromTop3?.zone ?? null;
    const localCarbon = decision.estimated_kgco2_local !== null ? `${decision.estimated_kgco2_local}` : "N/A";
    const routedCarbon = decision.estimated_kgco2_routed !== null ? `${decision.estimated_kgco2_routed}` : "N/A";
    const sameCountryLocal = countryLabelFromZone(localZone);
    const routeResidency = routeZone
      ? countryCodeFromZone(routeZone) === countryCodeFromZone(localZone)
        ? `Same-country (${countryLabelFromZone(routeZone)})`
        : `Cross-border (${countryLabelFromZone(routeZone)})`
      : "Not available";

    return [
      {
        option: "Run Local",
        zone: localZone,
        carbon: localCarbon,
        latency: "Baseline",
        dataResidency: `Same-country (${sameCountryLocal})`,
        costImpact: "Baseline"
      },
      {
        option: "Route",
        zone: routeZone ?? "Not available",
        carbon: routeZone ? routedCarbon : "N/A",
        latency: routeZone ? estimatedLatency(localZone, routeZone) : "N/A",
        dataResidency: routeResidency,
        costImpact: routeZone ? "Possible data transfer overhead" : "N/A"
      },
      {
        option: "Postpone",
        zone: "Deferred",
        carbon: "TBD",
        latency: "+hours",
        dataResidency: `No zone change (${sameCountryLocal})`,
        costImpact: "Potential SLA delay cost"
      }
    ];
  }, [decision, zone]);

  const chosenTradeoffOption: TradeoffRow["option"] | null =
    decision.execution_mode === "local"
      ? "Run Local"
      : decision.execution_mode === "routed"
        ? "Route"
        : decision.execution_mode === "postponed"
          ? "Postpone"
          : null;

  const hasDecision = Boolean(decisionId);
  const showLiveControls = uiState === "idle" || uiState === "submitting" || uiState === "processing";
  const showFinalControls = uiState === "final";
  const showErrorControls = uiState === "error";
  const showApprovalControls = uiState === "awaiting_approval";
  const auditParagraphs = splitAuditParagraphs(decision.audit_report);

  if (sessionStatus === "loading") {
    return (
      <main className="px-4 py-8 md:px-8">
        <div className="mx-auto max-w-6xl">
          <section className="panel-strong rounded-3xl p-6 md:p-8">
            <p className="text-sm text-fern">Checking session...</p>
          </section>
        </div>
      </main>
    );
  }

  if (sessionStatus === "unauthenticated") {
    return null;
  }

  return (
    <main className="px-4 py-8 md:px-8">
      <div className="mx-auto max-w-6xl space-y-6">
        <section className="glass-panel rounded-3xl p-6 md:p-8">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div>
              <p className="text-sm font-semibold uppercase tracking-[0.2em] text-fern">ESG Orchestration Console</p>
              <h1 className="mt-2 text-3xl font-bold text-ink md:text-4xl">Carbon-Aware Compute Advisor</h1>
              <p className="mt-3 max-w-2xl text-sm text-fern md:text-base">
                Real-time GreenOps routing with manager governance and auditable decision trails.
              </p>
              <p className="mt-2 text-xs uppercase tracking-[0.15em] text-fern">Forecast Mode: Disabled (Routing-First)</p>
            </div>
            <div className="flex items-center gap-2">
              {approverEmail && (
                <span className="max-w-[220px] truncate rounded-full border border-moss/30 px-3 py-1 text-xs text-fern" title={approverEmail}>
                  {approverEmail}
                </span>
              )}
              <ThemeToggle resolvedTheme={resolvedTheme} onToggle={toggleTheme} />
              <button
                type="button"
                className="rounded-full border border-fern/30 px-3 py-1 text-xs font-semibold uppercase tracking-wide text-fern transition hover:bg-fern/10"
                onClick={() => setShowIntroModal(true)}
              >
                Help
              </button>
              <button
                type="button"
                className="rounded-full border border-fern/30 px-3 py-1 text-xs font-semibold uppercase tracking-wide text-fern transition hover:bg-fern/10"
                onClick={() => void signOut({ callbackUrl: "/login" })}
              >
                Sign out
              </button>
              <StatusBadge status={statusForBadge} />
            </div>
          </div>
        </section>

        <section className="panel-strong rounded-3xl p-6 md:p-8">
          <div className="grid gap-5 md:grid-cols-3">
            <label className="space-y-2 md:col-span-1">
              <span className="text-sm font-semibold text-ink">Estimated Job Energy (kWh)</span>
              <input
                className="w-full rounded-xl border border-moss/30 bg-white px-4 py-3 text-ink shadow-sm"
                type="text"
                inputMode="numeric"
                pattern="[0-9]*"
                value={estimatedKwhStr}
                onChange={(e) => setEstimatedKwhStr(digitsOnly(e.target.value))}
                onBlur={() => {
                  setEstimatedKwhStr(String(parsePositiveInt(estimatedKwhStr, 1)));
                }}
              />
            </label>
            <label className="space-y-2 md:col-span-1">
              <span className="text-sm font-semibold text-ink">Carbon Threshold (gCO2eq/kWh)</span>
              <input
                className="w-full rounded-xl border border-moss/30 bg-white px-4 py-3 text-ink shadow-sm"
                type="text"
                inputMode="numeric"
                pattern="[0-9]*"
                value={thresholdStr}
                onChange={(e) => {
                  const nextThreshold = digitsOnly(e.target.value);
                  setThresholdStr(nextThreshold);
                  setThresholdPreset(thresholdPresetForValue(parsePositiveInt(nextThreshold, 0)));
                }}
                onBlur={() => {
                  const normalizedThreshold = String(parsePositiveInt(thresholdStr, 1));
                  setThresholdStr(normalizedThreshold);
                  setThresholdPreset(thresholdPresetForValue(parsePositiveInt(normalizedThreshold, 1)));
                }}
              />
              <select
                className="w-full rounded-xl border border-moss/30 bg-white px-4 py-2 text-sm text-ink shadow-sm"
                value={thresholdPreset}
                onChange={(e) => {
                  const selectedPreset = e.target.value as ThresholdPresetKey;
                  setThresholdPreset(selectedPreset);
                  if (selectedPreset === "custom") return;
                  const match = THRESHOLD_PRESETS.find((preset) => preset.key === selectedPreset);
                  if (match) setThresholdStr(String(match.value));
                }}
              >
                {THRESHOLD_PRESETS.map((preset) => (
                  <option key={preset.key} value={preset.key}>
                    {preset.label}
                  </option>
                ))}
                <option value="custom">Custom</option>
              </select>
              <div className="flex flex-wrap items-center gap-2 text-xs text-fern">
                <span>{thresholdPresetDescription}</span>
                {presetMatch && (
                  <span className="rounded-full border border-emerald-300 bg-emerald-50 px-2 py-0.5 font-semibold text-emerald-700 dark:border-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300">
                    Preset match: {presetMatch.label}
                  </span>
                )}
              </div>
            </label>
            <label className="space-y-2 md:col-span-1">
              <span className="text-sm font-semibold text-ink">Primary Grid Zone</span>
              <select
                className="w-full rounded-xl border border-moss/30 bg-white px-4 py-3 text-ink shadow-sm"
                value={zone}
                onChange={(e) => setZone(e.target.value)}
              >
                {zoneOptions.map((zoneOption) => (
                  <option key={zoneOption} value={zoneOption}>
                    {zoneLabel(zoneOption)}
                  </option>
                ))}
              </select>
              <p className="text-xs text-fern">
                This is the primary execution region; routing may still shift the workload to a cleaner zone.
              </p>
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  className="rounded-lg border border-fern/30 px-3 py-1 text-xs font-semibold text-fern transition hover:bg-fern/10"
                  onClick={onSuggestPrimaryZone}
                >
                  Suggest from my location
                </button>
                {canRetryGeo && (
                  <button
                    type="button"
                    className="rounded-lg border border-fern/30 px-3 py-1 text-xs font-semibold text-fern transition hover:bg-fern/10"
                    onClick={onSuggestPrimaryZone}
                  >
                    Retry location
                  </button>
                )}
                {geoHint && (
                  <>
                    <span className="text-xs text-fern">{geoHint}</span>
                    <button
                      type="button"
                      className="rounded-lg border border-fern/30 px-3 py-1 text-xs font-semibold text-fern transition hover:bg-fern/10"
                      onClick={() => {
                        setGeoHint(`Using ${zoneLabel(zone)}. You can change the zone manually.`);
                        setCanRetryGeo(false);
                      }}
                    >
                      Use selected zone
                    </button>
                  </>
                )}
              </div>
            </label>
          </div>

          <div className="mt-5 grid gap-4 md:grid-cols-2">
            <label className="space-y-2">
              <span className="text-xs font-semibold uppercase tracking-wide text-fern">Approver Email (required for approvals)</span>
              <span className="block text-xs text-fern">Sourced from your signed-in Google account and stored in the backend audit trail.</span>
              <input
                className="w-full rounded-xl border border-moss/30 bg-moss/10 px-4 py-3 text-sm text-ink shadow-sm"
                type="text"
                value={approverEmail || "Signed-in email unavailable"}
                readOnly
              />
              {!approverEmail && (
                <span className="block text-xs text-red-600 dark:text-red-400">
                  This Google account does not expose an email address. Sign out and use another account.
                </span>
              )}
            </label>
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  className="rounded-lg border border-fern/30 px-3 py-1 text-xs font-semibold uppercase tracking-wide text-fern transition hover:bg-fern/10"
                  onClick={() => setShowApproverProfile((value) => !value)}
                >
                  {showApproverProfile ? "Hide Approver Profile" : "Show Approver Profile"}
                </button>
                <span className="rounded-full border border-sky-300 bg-sky-50 px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-sky-700 dark:border-sky-800 dark:bg-sky-900/30 dark:text-sky-300">
                  Client-side only
                </span>
              </div>
              <p className="text-sm text-fern">Local context fields help demo storytelling. They are never sent to backend APIs.</p>
            </div>
          </div>

          {showApproverProfile && (
            <div className="mt-3 grid gap-3 md:grid-cols-2">
              <label className="space-y-2">
                <span className="text-xs font-semibold uppercase tracking-wide text-fern">Approver Name</span>
                <input
                  className="w-full rounded-xl border border-moss/30 bg-white px-4 py-3 text-sm text-ink shadow-sm"
                  type="text"
                  value={approverName}
                  onChange={(e) => setApproverName(e.target.value)}
                  placeholder="Jane Svensson"
                />
              </label>
              <label className="space-y-2">
                <span className="text-xs font-semibold uppercase tracking-wide text-fern">Organization</span>
                <input
                  className="w-full rounded-xl border border-moss/30 bg-white px-4 py-3 text-sm text-ink shadow-sm"
                  type="text"
                  value={approverOrg}
                  onChange={(e) => setApproverOrg(e.target.value)}
                  placeholder="Nordea"
                />
              </label>
            </div>
          )}

          <div className="mt-6 space-y-4">
            {showLiveControls && (
              <div className="flex flex-wrap items-center gap-3 rounded-2xl border border-moss/25 bg-moss/5 p-4">
                <button
                  className="rounded-xl border border-transparent bg-[#1f5f3f] px-6 py-3 text-sm font-semibold text-white transition hover:bg-[#2b7a52] disabled:cursor-not-allowed disabled:bg-[#7fae97] disabled:text-white/85 dark:bg-emerald-400 dark:text-[#04120a] dark:hover:bg-emerald-300 dark:disabled:border-zinc-600 dark:disabled:bg-zinc-700 dark:disabled:text-zinc-300"
                  onClick={() => void onStart()}
                  disabled={uiState === "submitting" || uiState === "processing"}
                >
                  {uiState === "submitting" ? "Starting..." : "Evaluate and decide (Live)"}
                </button>
                {(uiState === "idle" || uiState === "submitting") && (
                  <button
                    className="rounded-xl border border-fern px-4 py-3 text-sm font-semibold text-fern transition hover:bg-fern/10 disabled:cursor-not-allowed disabled:opacity-60"
                    onClick={() => setShowDemoScenarios((value) => !value)}
                    disabled={uiState === "submitting"}
                  >
                    {showDemoScenarios ? "Hide Demo Scenarios" : "Show Demo Scenarios"}
                  </button>
                )}
              </div>
            )}

            {(uiState === "idle" || uiState === "submitting") && showDemoScenarios && (
              <div className="rounded-2xl border border-dashed border-fern/35 bg-white/60 p-4 dark:bg-zinc-900/60">
                <p className="text-xs font-semibold uppercase tracking-wide text-fern">Demo Scenarios</p>
                <p className="mt-1 text-xs text-fern">Deterministic scenarios for interview-ready outcomes.</p>
                <div className="mt-3 flex flex-wrap gap-3">
                  <button
                    className="rounded-xl border border-fern px-4 py-3 text-sm font-semibold text-fern transition hover:bg-fern/10 disabled:cursor-not-allowed disabled:opacity-60"
                    onClick={() => void onStart("clean_local")}
                    disabled={uiState === "submitting"}
                  >
                    {DEMO_SCENARIO_LABELS.clean_local}
                  </button>
                  <button
                    className="rounded-xl border border-fern px-4 py-3 text-sm font-semibold text-fern transition hover:bg-fern/10 disabled:cursor-not-allowed disabled:opacity-60"
                    onClick={() => void onStart("routeable_dirty")}
                    disabled={uiState === "submitting"}
                  >
                    {DEMO_SCENARIO_LABELS.routeable_dirty}
                  </button>
                  <button
                    className="rounded-xl border border-fern px-4 py-3 text-sm font-semibold text-fern transition hover:bg-fern/10 disabled:cursor-not-allowed disabled:opacity-60"
                    onClick={() => void onStart("non_routeable_dirty")}
                    disabled={uiState === "submitting"}
                  >
                    {DEMO_SCENARIO_LABELS.non_routeable_dirty}
                  </button>
                </div>
              </div>
            )}

            {showApprovalControls && (
              <div className="rounded-2xl border border-amber-200 bg-amber-50/70 p-4 dark:border-amber-900 dark:bg-amber-900/20">
                <p className="text-xs font-semibold uppercase tracking-wide text-amber-800 dark:text-amber-300">Manager Approval Required</p>
                <div className="mt-3 rounded-xl border border-moss/25 bg-white/80 p-3 text-sm text-ink dark:border-moss/40 dark:bg-zinc-900/65">
                  <p className="text-xs font-semibold uppercase tracking-wide text-fern">Decision Briefing</p>
                  <p className="mt-2 text-sm text-fern">
                    Primary zone <span className="font-semibold text-ink">{decision.primary_zone}</span> is at{" "}
                    <span className="font-semibold text-ink">{decision.primary_intensity ?? "-"}</span> gCO2eq/kWh against threshold{" "}
                    <span className="font-semibold text-ink">{threshold}</span>.
                  </p>
                  {decision.policy_action === "route_to_clean_region" ? (
                    <p className="mt-1 text-sm text-fern">
                      Cleaner route available: <span className="font-semibold text-ink">{decision.selected_execution_zone ?? "-"}</span> at{" "}
                      <span className="font-semibold text-ink">{decision.selected_execution_intensity ?? "-"}</span> gCO2eq/kWh.
                    </p>
                  ) : (
                    <p className="mt-1 text-sm text-fern">No compliant route candidate is currently available under this threshold.</p>
                  )}
                  <div className="mt-2 grid gap-2 sm:grid-cols-3">
                    <p className="text-xs text-fern">
                      Local estimate: <span className="font-semibold text-ink">{decision.estimated_kgco2_local ?? "-"}</span> kgCO2
                    </p>
                    <p className="text-xs text-fern">
                      Routed estimate: <span className="font-semibold text-ink">{decision.estimated_kgco2_routed ?? "-"}</span> kgCO2
                    </p>
                    <p className="text-xs text-fern">
                      Potential savings: <span className="font-semibold text-ink">{decision.estimated_kgco2_saved_by_routing ?? "-"}</span> kgCO2
                    </p>
                  </div>
                </div>
                <div className="mt-3 flex flex-wrap gap-3">
                  {decision.manager_options.map((option) => {
                    const isArmed = armedManagerAction === option;
                    const label = managerLabel(option, decision.selected_execution_zone);
                    return (
                      <button
                        key={option}
                        className={`rounded-xl border px-6 py-3 text-sm font-semibold transition ${
                          isArmed
                            ? "border-amber-500 bg-amber-100 text-amber-900 hover:bg-amber-200 dark:border-amber-500 dark:bg-amber-900/40 dark:text-amber-200"
                            : "border-fern text-fern hover:bg-fern/10"
                        }`}
                        onClick={() => void onManagerAction(option)}
                        aria-label={`Manager action: ${label}`}
                      >
                        {isArmed ? `Confirm: ${label}` : label}
                      </button>
                    );
                  })}
                </div>
                {armedManagerAction && (
                  <p className="mt-3 text-xs text-amber-800 dark:text-amber-300">
                    Click the same action again within {MANAGER_CONFIRM_TIMEOUT_MS / 1000}s to confirm.
                  </p>
                )}

                {selectedActionIsOverride && (
                  <div className="mt-4 grid gap-3">
                    <label className="space-y-2">
                      <span className="text-xs font-semibold uppercase tracking-wide text-amber-800 dark:text-amber-300">
                        Override Reason (required)
                      </span>
                      <textarea
                        className="min-h-20 w-full rounded-xl border border-amber-300 bg-white px-4 py-3 text-sm text-ink shadow-sm dark:border-amber-800"
                        value={overrideReason}
                        onChange={(e) => setOverrideReason(e.target.value)}
                        placeholder="This action overrides the policy recommendation. Provide justification."
                      />
                    </label>
                  </div>
                )}
              </div>
            )}

            {showFinalControls && (
              <div className="flex flex-wrap gap-3">
                <button
                  className="rounded-xl border border-ink px-4 py-3 text-sm font-semibold text-ink transition hover:bg-ink/10 dark:hover:bg-zinc-800/70"
                  onClick={onResetDecision}
                >
                  New Decision
                </button>
                <button
                  className="rounded-xl bg-ember px-6 py-3 text-sm font-semibold text-white transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
                  onClick={() => void onDownloadAudit()}
                  disabled={!canDownloadAudit}
                >
                  Download Audit CSV
                </button>
              </div>
            )}

            {showErrorControls && (
              <div className="flex flex-wrap gap-3">
                <button
                  className="rounded-xl border border-ink px-4 py-3 text-sm font-semibold text-ink transition hover:bg-ink/10 disabled:opacity-50 dark:hover:bg-zinc-800/70"
                  onClick={() => void onRetryLastDecision()}
                  disabled={!lastStartPayload}
                >
                  Retry Last Decision
                </button>
                <button
                  className="rounded-xl border border-ink px-4 py-3 text-sm font-semibold text-ink transition hover:bg-ink/10 dark:hover:bg-zinc-800/70"
                  onClick={onResetDecision}
                >
                  New Decision
                </button>
              </div>
            )}
          </div>

          {hasDecision ? (
            <>
              <p className="mt-3 text-xs text-fern">Demo scenarios use deterministic synthetic intensities to guarantee interview-ready outcomes.</p>
              <p className="mt-4 text-xs text-fern">
                Decision ID: <span className="font-mono">{decisionId}</span>
              </p>
              <p className="mt-2 text-xs uppercase tracking-wide text-fern">
                Run mode: {activeDemoScenario ? DEMO_SCENARIO_LABELS[activeDemoScenario] : "Live API"}
              </p>

              <div className="mt-4 rounded-xl border border-moss/25 bg-white/60 p-4 dark:bg-zinc-900/60">
                <ol className="grid gap-2 md:grid-cols-5">
                  {WORKFLOW_STEPS.map((step, index) => {
                    const isComplete = currentWorkflowStepIndex > index;
                    const isActive = currentWorkflowStepIndex === index;
                    return (
                      <li key={step} className="flex items-center gap-2">
                        <span
                          className={`inline-flex h-6 w-6 items-center justify-center rounded-full border text-xs font-bold ${
                            isComplete
                              ? "border-emerald-500 bg-emerald-500 text-white"
                              : isActive
                                ? "border-amber-500 bg-amber-100 text-amber-900 dark:bg-amber-900/40 dark:text-amber-200"
                                : "border-moss/40 bg-white/70 text-fern dark:bg-zinc-800/70"
                          }`}
                        >
                          {index + 1}
                        </span>
                        <span className={`text-xs font-semibold ${isActive ? "text-ink" : "text-fern"}`}>{step}</span>
                      </li>
                    );
                  })}
                </ol>
                {activeProcessingStep && (
                  <p className="mt-3 text-xs font-semibold uppercase tracking-wide text-fern">Step: {activeProcessingStep}</p>
                )}
                {showProcessingBar && (
                  <div className="mt-3 h-1.5 w-full overflow-hidden rounded-full bg-moss/20 dark:bg-moss/35">
                    <span className="block h-full w-1/3 rounded-full bg-emerald-500 motion-safe:animate-[indeterminate_1.35s_ease-in-out_infinite] dark:bg-emerald-400" />
                  </div>
                )}
              </div>

              <p className="mt-3 rounded-lg border border-moss/30 bg-moss/5 px-3 py-2 text-sm text-ink">{decisionExplanation}</p>
              {decision.manager_prompt && uiState === "awaiting_approval" && (
                <p className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:border-amber-900 dark:bg-amber-900/20 dark:text-amber-300">
                  {cleanManagerPrompt(decision.manager_prompt)}
                </p>
              )}
            </>
          ) : (
            <p className="mt-4 text-sm text-fern">Start a live or demo decision to populate metrics, policy output, tradeoffs, and timeline.</p>
          )}

          {error && <p className="mt-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-900 dark:bg-red-900/20 dark:text-red-300">{error}</p>}
        </section>

        {hasDecision && (
          <>
            <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
              <article className="panel-strong rounded-2xl p-4">
                <p className="text-xs uppercase tracking-[0.14em] text-fern">Primary Zone Intensity</p>
                <div className="mt-2 min-h-9">
                  {uiState === "processing" && decision.primary_intensity === null ? (
                    <span className="inline-block h-8 w-20 animate-pulse rounded bg-moss/30 dark:bg-moss/40" />
                  ) : (
                    <p className={`text-2xl font-bold ${intensityClassName(primaryIntensitySeverity)}`}>{decision.primary_intensity ?? "-"}</p>
                  )}
                </div>
                <p className="text-sm text-fern">gCO2eq/kWh</p>
              </article>
              <article className="panel-strong rounded-2xl p-4">
                <p className="text-xs uppercase tracking-[0.14em] text-fern">Selected Execution Zone</p>
                <div className="mt-2 min-h-9">
                  {uiState === "processing" && decision.selected_execution_zone === null ? (
                    <span className="inline-block h-8 w-24 animate-pulse rounded bg-moss/30 dark:bg-moss/40" />
                  ) : (
                    <p className="text-2xl font-bold text-ink">{decision.selected_execution_zone ?? "-"}</p>
                  )}
                </div>
                <p className={`text-sm ${intensityClassName(selectedIntensitySeverity)}`}>{decision.selected_execution_intensity ?? "-"} gCO2eq/kWh</p>
              </article>
              <article className="panel-strong rounded-2xl p-4">
                <p className="text-xs uppercase tracking-[0.14em] text-fern">Execution Mode</p>
                <div className="mt-2 min-h-9">
                  {uiState === "processing" && decision.execution_mode === null ? (
                    <span className="inline-block h-8 w-16 animate-pulse rounded bg-moss/30 dark:bg-moss/40" />
                  ) : (
                    <p className="text-2xl font-bold text-ink">{decision.execution_mode ?? "-"}</p>
                  )}
                </div>
                <p className="text-sm text-fern">local / routed / postponed</p>
              </article>
              <article
                className={`rounded-2xl p-4 ${
                  isRealized
                    ? "border border-emerald-200 bg-emerald-50 dark:border-emerald-900 dark:bg-emerald-900/20"
                    : isForegone
                      ? "border border-amber-200 bg-amber-50 dark:border-amber-900 dark:bg-amber-900/20"
                      : "panel-strong"
                }`}
              >
                <p
                  className={`text-xs uppercase tracking-[0.14em] ${
                    isRealized ? "text-emerald-700 dark:text-emerald-300" : isForegone ? "text-amber-700 dark:text-amber-300" : "text-fern"
                  }`}
                >
                  {isForegone ? "Foregone Savings" : "Routing Savings"}
                </p>
                <div className="mt-2 min-h-9">
                  {uiState === "processing" && decision.estimated_kgco2_saved_by_routing === null ? (
                    <span className="inline-block h-8 w-20 animate-pulse rounded bg-moss/30 dark:bg-moss/40" />
                  ) : (
                    <p
                      className={`text-2xl font-bold ${
                        isRealized ? "text-emerald-800 dark:text-emerald-300" : isForegone ? "text-amber-800 dark:text-amber-300" : "text-ink"
                      }`}
                    >
                      {decision.estimated_kgco2_saved_by_routing ?? "-"}
                    </p>
                  )}
                </div>
                <p className={`text-sm ${isRealized ? "text-emerald-600 dark:text-emerald-300" : isForegone ? "text-amber-600 dark:text-amber-300" : "text-fern"}`}>
                  kgCO2
                </p>
              </article>
            </section>

            <section className="grid gap-4 lg:grid-cols-2">
              <article className="panel-strong rounded-2xl p-5">
                <h2 className="text-lg font-bold text-ink">Policy Decision</h2>
                <div className="mt-3 flex flex-wrap items-center gap-2 text-sm text-fern">
                  <span className="font-semibold text-ink">Action:</span>
                  <PolicyActionBadge action={decision.policy_action} />
                </div>
                <p className="mt-2 text-sm text-fern">
                  <span className="font-semibold text-ink">Reason:</span> {decision.policy_reason ?? "Waiting for evaluation..."}
                </p>
                <p className="mt-2 text-sm text-fern">
                  <span className="font-semibold text-ink">Estimated Local:</span> {decision.estimated_kgco2_local ?? "-"} kgCO2
                </p>
                <p className="mt-2 text-sm text-fern">
                  <span className="font-semibold text-ink">Estimated Routed:</span> {decision.estimated_kgco2_routed ?? "-"} kgCO2
                </p>
                <p className="mt-2 text-sm text-fern">
                  <span className="font-semibold text-ink">Accounting Method:</span> {decision.accounting_method}
                </p>
                <p className="mt-2 text-sm text-fern">
                  <span className="font-semibold text-ink">Approver Email:</span> {decision.manager_id ?? "N/A"}
                </p>
                <p className="mt-2 text-sm text-fern">
                  <span className="font-semibold text-ink">Override Reason:</span> {decision.override_reason ?? "N/A"}
                </p>
                <p className="mt-3 rounded-md border border-moss/30 bg-moss/10 px-2 py-1 text-xs text-fern dark:bg-moss/20">
                  Estimates use point-in-time intensity; actual emissions depend on job duration.
                </p>
              </article>

              <article className="panel-strong rounded-2xl p-5">
                <h2 className="text-lg font-bold text-ink">Audit Report</h2>
                <p className="mt-2 text-xs uppercase tracking-wide text-fern">Mode: {decision.audit_mode ?? "pending"}</p>
                {auditParagraphs.length > 0 ? (
                  <div className="mt-3 space-y-3 text-sm text-ink">
                    {auditParagraphs.map((paragraph, idx) => (
                      <p key={`${idx}-${paragraph.slice(0, 20)}`}>{paragraph}</p>
                    ))}
                  </div>
                ) : (
                  <p className="mt-3 whitespace-pre-wrap text-sm text-ink">Audit report appears when workflow reaches completion.</p>
                )}
              </article>
            </section>

            <section className="panel-strong rounded-2xl p-5">
              <h2 className="text-lg font-bold text-ink">Execution Tradeoff Comparison</h2>
              <p className="mt-2 text-xs text-fern">
                Compares operational options on emissions, latency, residency, and estimated cost impact.
              </p>
              <div className="mt-4 overflow-x-auto rounded-xl border border-moss/20">
                <table className="min-w-full divide-y divide-moss/20 text-sm">
                  <thead className="bg-moss/10 text-left">
                    <tr>
                      <th className="px-4 py-3 font-semibold text-ink">Option</th>
                      <th className="px-4 py-3 font-semibold text-ink">Zone</th>
                      <th className="px-4 py-3 font-semibold text-ink">Carbon (kgCO2)</th>
                      <th className="px-4 py-3 font-semibold text-ink">Est. Latency</th>
                      <th className="px-4 py-3 font-semibold text-ink">Data Residency</th>
                      <th className="px-4 py-3 font-semibold text-ink">Cost Impact</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-moss/10 bg-white/70 dark:bg-zinc-900/60">
                    {tradeoffRows.map((row) => {
                      const selected = chosenTradeoffOption === row.option;
                      return (
                        <tr key={row.option} className={selected ? "bg-emerald-50/70 dark:bg-emerald-900/20" : ""}>
                          <td className={`px-4 py-3 font-semibold text-ink ${selected ? "border-l-4 border-emerald-500" : ""}`}>{row.option}</td>
                          <td className="px-4 py-3 text-ink">{row.zone}</td>
                          <td className="px-4 py-3 text-ink">{row.carbon}</td>
                          <td className="px-4 py-3 text-ink">{row.latency}</td>
                          <td className="px-4 py-3 text-ink">{row.dataResidency}</td>
                          <td className="px-4 py-3 text-ink">{row.costImpact}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              {decision.execution_mode === "postponed" && (
                <div className="mt-4 rounded-lg border border-sky-200 bg-sky-50 px-4 py-3 text-sm text-sky-900 dark:border-sky-900 dark:bg-sky-900/20 dark:text-sky-200">
                  {decision.forecast_available && decision.forecast_recommendation ? (
                    <>
                      <span className="font-semibold">Forecast guidance:</span> {decision.forecast_recommendation}
                    </>
                  ) : (
                    "No forecast guidance available — check back manually."
                  )}
                </div>
              )}
            </section>

            <section className="panel-strong rounded-2xl p-5">
              <h2 className="text-lg font-bold text-ink">Top 3 Cleanest Candidate Zones</h2>
              <div className="mt-4 overflow-x-auto rounded-xl border border-moss/20">
                <table className="min-w-full divide-y divide-moss/20 text-sm">
                  <thead className="bg-moss/10 text-left">
                    <tr>
                      <th className="px-4 py-3 font-semibold text-ink">Zone</th>
                      <th className="px-4 py-3 font-semibold text-ink">Intensity (gCO2eq/kWh)</th>
                      <th className="px-4 py-3 font-semibold text-ink">Updated</th>
                      <th className="px-4 py-3 font-semibold text-ink">Status</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-moss/10 bg-white/70 dark:bg-zinc-900/60">
                    {decision.routing_top3.length > 0 ? (
                      decision.routing_top3.map((candidate) => (
                        <tr key={`${candidate.zone}-${candidate.datetime ?? "none"}`}>
                          <td className="px-4 py-3 text-ink">{candidate.zone}</td>
                          <td className="px-4 py-3 font-semibold text-ink">{candidate.carbonIntensity ?? "-"}</td>
                          <td className="px-4 py-3 text-ink">{formatTimestamp(candidate.datetime)}</td>
                          <td className="px-4 py-3 text-ink">{candidate.ok ? "OK" : `Error: ${candidate.error ?? "unknown"}`}</td>
                        </tr>
                      ))
                    ) : (
                      <tr>
                        <td className="px-4 py-6 text-fern" colSpan={4}>
                          No routing candidates available yet.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </section>

            <section className="panel-strong rounded-2xl p-5">
              <h2 className="text-lg font-bold text-ink">Decision Replay Timeline</h2>
              {decision.timeline.length === 0 ? (
                <p className="mt-3 text-sm text-fern">Timeline appears as the workflow executes.</p>
              ) : (
                <div className="mt-4 space-y-3">
                  {decision.timeline.map((event, index) => (
                    <details
                      key={`${event.ts}-${event.stage}-${index}`}
                      open={index === decision.timeline.length - 1}
                      className="rounded-xl border border-moss/20 bg-white/70 px-4 py-3 dark:bg-zinc-900/60"
                    >
                      <summary className="cursor-pointer text-sm font-semibold text-ink">
                        {formatTimestamp(event.ts)} | {event.stage} | {event.message}
                      </summary>
                      {event.data && Object.keys(event.data).length > 0 && (
                        <details className="mt-3 rounded border border-moss/20 bg-slate-50 dark:bg-zinc-900/80">
                          <summary className="cursor-pointer px-3 py-2 text-xs font-semibold uppercase tracking-wide text-fern">
                            Show technical details
                          </summary>
                          <pre className="overflow-x-auto border-t border-moss/20 px-3 py-3 text-xs text-slate-700 dark:text-slate-200">
                            {JSON.stringify(event.data, null, 2)}
                          </pre>
                        </details>
                      )}
                    </details>
                  ))}
                </div>
              )}
            </section>
          </>
        )}
      </div>

      {showIntroModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-[2px]">
          <div
            role="dialog"
            aria-modal="true"
            aria-label="Welcome to Carbon-Aware Compute Advisor"
            className="panel-strong w-full max-w-2xl rounded-2xl p-6 shadow-2xl"
          >
            <h2 className="text-xl font-bold text-ink">Welcome to Carbon-Aware Compute Advisor</h2>
            <div className="mt-4 space-y-4 text-sm text-fern">
              <div>
                <p className="font-semibold text-ink">What this solves</p>
                <p className="mt-1">
                  This tool decides whether a workload should run in its primary zone, route to a cleaner region, or pause for manager approval based on
                  real-time grid carbon intensity.
                </p>
              </div>
              <div>
                <p className="font-semibold text-ink">How to run a decision</p>
                <ol className="mt-1 list-decimal space-y-1 pl-5">
                  <li>Set estimated job energy (kWh).</li>
                  <li>Choose a carbon threshold (lower means stricter policy).</li>
                  <li>Select the primary grid zone.</li>
                  <li>Run Live, or use Demo scenarios for deterministic outcomes.</li>
                </ol>
              </div>
              <div>
                <p className="font-semibold text-ink">How approval works</p>
                <p className="mt-1">
                  When the primary zone exceeds policy limits, the workflow pauses and shows a Decision Briefing with local vs routed emissions before the
                  approver selects Run Local, Route, or Postpone.
                </p>
              </div>
              <div>
                <p className="font-semibold text-ink">Understanding results</p>
                <p className="mt-1">
                  The dashboard explains the policy action, emissions estimates, routing savings, tradeoffs, and a timeline of every decision stage.
                </p>
              </div>
              <div>
                <p className="font-semibold text-ink">Data handling</p>
                <p className="mt-1">
                  Approver email and override reason are persisted in backend audit artifacts. Approver name and organization are client-side context only and
                  never sent to backend APIs.
                </p>
              </div>
            </div>
            <div className="mt-6 flex justify-end gap-3">
              <button
                type="button"
                className="rounded-xl border border-fern px-4 py-2 text-sm font-semibold text-fern transition hover:bg-fern/10"
                onClick={dismissIntroModal}
              >
                Got it
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}
