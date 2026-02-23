"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import { PolicyActionBadge, StatusBadge } from "@/components/status-badge";
import { api } from "@/lib/api";
import { DecisionResponse, DemoScenario, ManagerOption } from "@/lib/types";

const POLL_MS = 2000;
const TIMEOUT_MS = 90000;
const GEOLOCATION_TIMEOUT_MS = 15000;
const MARGINAL_OVER_THRESHOLD_FACTOR = 1.3;
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
const MANAGER_ID_STORAGE_KEY = "carbon_advisor.manager_id";
const APPROVER_NAME_STORAGE_KEY = "carbon_advisor.approver_name";
const APPROVER_ORG_STORAGE_KEY = "carbon_advisor.approver_org";
const INTRO_SEEN_STORAGE_KEY = "carbon_advisor.intro_seen";
const DEMO_SCENARIO_LABELS: Record<DemoScenario, string> = {
  clean_local: "Demo: Clean Local",
  routeable_dirty: "Demo: Routeable Dirty",
  non_routeable_dirty: "Demo: No Route (Approval)"
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
type ThresholdPresetKey = (typeof THRESHOLD_PRESETS)[number]["key"] | "custom";
type TradeoffRow = {
  option: string;
  zone: string;
  carbon: string;
  latency: string;
  dataResidency: string;
  costImpact: string;
};

type IntensitySeverity = "clean" | "marginal" | "dirty" | "unknown";

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
  if (severity === "clean") return "text-emerald-700";
  if (severity === "marginal") return "text-amber-700";
  if (severity === "dirty") return "text-red-700";
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

function processingStepLabel(decision: DecisionResponse, uiState: "idle" | "submitting" | "processing" | "awaiting_approval" | "final" | "error"): string | null {
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

export default function HomePage() {
  const [estimatedKwhStr, setEstimatedKwhStr] = useState<string>("500");
  const [thresholdStr, setThresholdStr] = useState<string>("40");
  const estimatedKwh = parsePositiveInt(estimatedKwhStr, 1);
  const threshold = parsePositiveInt(thresholdStr, 1);
  const [thresholdPreset, setThresholdPreset] = useState<ThresholdPresetKey>(thresholdPresetForValue(40));
  const [zone, setZone] = useState<string>(CONFIGURED_PRIMARY_ZONES[0] ?? "SE-SE3");
  const [managerId, setManagerId] = useState<string>("manager@example.com");
  const [approverName, setApproverName] = useState<string>("");
  const [approverOrg, setApproverOrg] = useState<string>("");
  const [showApproverProfile, setShowApproverProfile] = useState<boolean>(false);
  const [overrideReason, setOverrideReason] = useState<string>("");
  const [geoHint, setGeoHint] = useState<string>("");
  const [canRetryGeo, setCanRetryGeo] = useState<boolean>(false);
  const [showIntroModal, setShowIntroModal] = useState<boolean>(false);

  const [decision, setDecision] = useState<DecisionResponse>(defaultDecision);
  const [decisionId, setDecisionId] = useState<string>("");
  const [uiState, setUiState] = useState<"idle" | "submitting" | "processing" | "awaiting_approval" | "final" | "error">("idle");
  const [error, setError] = useState<string>("");
  const startedAtRef = useRef<number | null>(null);

  const shouldPoll = uiState === "processing" && Boolean(decisionId);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const savedZone = window.localStorage.getItem(PRIMARY_ZONE_STORAGE_KEY);
    const savedManagerId = window.localStorage.getItem(MANAGER_ID_STORAGE_KEY);
    const savedApproverName = window.localStorage.getItem(APPROVER_NAME_STORAGE_KEY);
    const savedApproverOrg = window.localStorage.getItem(APPROVER_ORG_STORAGE_KEY);
    const introSeen = window.localStorage.getItem(INTRO_SEEN_STORAGE_KEY);
    if (savedZone) {
      setZone(savedZone);
    }
    if (savedManagerId) {
      setManagerId(savedManagerId);
    }
    if (savedApproverName) {
      setApproverName(savedApproverName);
      setShowApproverProfile(true);
    }
    if (savedApproverOrg) {
      setApproverOrg(savedApproverOrg);
      setShowApproverProfile(true);
    }
    if (!introSeen) {
      setShowIntroModal(true);
    }
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(PRIMARY_ZONE_STORAGE_KEY, zone);
  }, [zone]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(MANAGER_ID_STORAGE_KEY, managerId);
  }, [managerId]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(APPROVER_NAME_STORAGE_KEY, approverName);
  }, [approverName]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(APPROVER_ORG_STORAGE_KEY, approverOrg);
  }, [approverOrg]);

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

  const onStart = async (demoScenario: DemoScenario | null = null) => {
    try {
      setUiState("submitting");
      setError("");
      setGeoHint("");
      setCanRetryGeo(false);
      setOverrideReason("");

      const started = await api.startDecision({
        estimated_kwh: estimatedKwh,
        threshold,
        zone,
        demo_scenario: demoScenario ?? undefined
      });

      setDecision(started);
      setDecisionId(started.decision_id);
      startedAtRef.current = Date.now();
      setUiState("processing");
    } catch (err) {
      setUiState("error");
      setError(err instanceof Error ? err.message : "Unable to start decision");
    }
  };

  const onResetDecision = () => {
    setDecision(defaultDecision);
    setDecisionId("");
    setUiState("idle");
    setError("");
    setGeoHint("");
    setCanRetryGeo(false);
    setOverrideReason("");
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

  const onManagerAction = async (option: ManagerOption) => {
    if (!decisionId) return;
    const cleanManagerId = managerId.trim();
    const cleanOverrideReason = overrideReason.trim();
    const isOverride = recommendedManagerAction !== null && option !== recommendedManagerAction;

    if (!cleanManagerId) {
      setError("Manager ID is required to submit approval actions.");
      return;
    }
    if (isOverride && !cleanOverrideReason) {
      setError("Override reason is required when manager action overrides the policy recommendation.");
      return;
    }

    try {
      setUiState("processing");
      setError("");

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
  const saved = decision.estimated_kgco2_saved_by_routing ?? 0;
  const isRealized = decision.execution_mode === "routed" && saved > 0;
  const isForegone = decision.execution_mode === "local" && saved > 0;
  const primaryIntensitySeverity = intensitySeverity(decision.primary_intensity, threshold);
  const selectedIntensitySeverity = intensitySeverity(decision.selected_execution_intensity, threshold);
  const activeProcessingStep = processingStepLabel(decision, uiState);

  const decisionExplanation = useMemo(() => {
    if (decision.status === "processing") {
      return activeDemoScenario
        ? `Evaluating synthetic ${DEMO_SCENARIO_LABELS[activeDemoScenario]} scenario...`
        : "Evaluating primary and candidate grid zones...";
    }
    if (decision.status === "awaiting_approval") {
      if (decision.policy_action === "route_to_clean_region") {
        return `Approval required: primary zone is above threshold and routing to ${decision.selected_execution_zone ?? "a cleaner zone"} is available.`;
      }
      return "Approval required: primary zone is above threshold and no compliant route is currently available.";
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
      ? (countryCodeFromZone(routeZone) === countryCodeFromZone(localZone)
        ? `Same-country (${countryLabelFromZone(routeZone)})`
        : `Cross-border (${countryLabelFromZone(routeZone)})`)
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
              <button
                type="button"
                className="rounded-full border border-fern/30 px-3 py-1 text-xs font-semibold uppercase tracking-wide text-fern transition hover:bg-fern/10"
                onClick={() => setShowIntroModal(true)}
              >
                Help
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
              <p className="text-xs text-fern">{thresholdPresetDescription}</p>
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
              <span className="text-xs font-semibold uppercase tracking-wide text-fern">Manager ID (required for approvals)</span>
              <input
                className="w-full rounded-xl border border-moss/30 bg-white px-4 py-3 text-sm text-ink shadow-sm"
                type="text"
                value={managerId}
                onChange={(e) => setManagerId(e.target.value)}
                placeholder="name@company.com"
              />
            </label>
            <div className="space-y-2">
              <button
                type="button"
                className="rounded-lg border border-fern/30 px-3 py-1 text-xs font-semibold uppercase tracking-wide text-fern transition hover:bg-fern/10"
                onClick={() => setShowApproverProfile((value) => !value)}
              >
                {showApproverProfile ? "Hide Approver Profile" : "Show Approver Profile"}
              </button>
              <p className="text-xs text-fern">Local-only metadata for demo context. Not sent to backend.</p>
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

          <div className="mt-6 flex flex-wrap gap-3">
            <button
              className="rounded-xl bg-ink px-6 py-3 text-sm font-semibold text-white transition hover:bg-fern disabled:cursor-not-allowed disabled:opacity-60"
              onClick={() => onStart()}
              disabled={uiState === "submitting" || uiState === "processing"}
            >
              {uiState === "submitting" ? "Starting..." : "Evaluate and decide (Live)"}
            </button>
            <button
              className="rounded-xl border border-fern px-4 py-3 text-sm font-semibold text-fern transition hover:bg-fern/10 disabled:cursor-not-allowed disabled:opacity-60"
              onClick={() => onStart("clean_local")}
              disabled={uiState === "submitting" || uiState === "processing"}
            >
              Force Clean Path
            </button>
            <button
              className="rounded-xl border border-fern px-4 py-3 text-sm font-semibold text-fern transition hover:bg-fern/10 disabled:cursor-not-allowed disabled:opacity-60"
              onClick={() => onStart("routeable_dirty")}
              disabled={uiState === "submitting" || uiState === "processing"}
            >
              Force Route Path
            </button>
            <button
              className="rounded-xl border border-fern px-4 py-3 text-sm font-semibold text-fern transition hover:bg-fern/10 disabled:cursor-not-allowed disabled:opacity-60"
              onClick={() => onStart("non_routeable_dirty")}
              disabled={uiState === "submitting" || uiState === "processing"}
            >
              Force Approval Path
            </button>
            {(uiState === "final" || uiState === "error") && (
              <button
                className="rounded-xl border border-ink px-4 py-3 text-sm font-semibold text-ink transition hover:bg-ink/10"
                onClick={onResetDecision}
              >
                New Decision
              </button>
            )}
            {uiState === "awaiting_approval" &&
              decision.manager_options.map((option) => (
                <button
                  key={option}
                  className="rounded-xl border border-fern px-6 py-3 text-sm font-semibold text-fern transition hover:bg-fern/10"
                  onClick={() => onManagerAction(option)}
                >
                  {managerLabel(option, decision.selected_execution_zone)}
                </button>
              ))}
            <button
              className="rounded-xl bg-ember px-6 py-3 text-sm font-semibold text-white transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
              onClick={onDownloadAudit}
              disabled={!canDownloadAudit}
            >
              Download Audit CSV
            </button>
          </div>
          {uiState === "awaiting_approval" && (
            <div className="mt-4 grid gap-3">
              <label className="space-y-2">
                <span className="text-xs font-semibold uppercase tracking-wide text-fern">
                  Override Reason (required only for policy override)
                </span>
                <textarea
                  className="min-h-20 w-full rounded-xl border border-moss/30 bg-white px-4 py-3 text-sm text-ink shadow-sm"
                  value={overrideReason}
                  onChange={(e) => setOverrideReason(e.target.value)}
                  placeholder={
                    recommendedManagerAction === "route"
                      ? "Required if choosing Run Local or Postpone instead of Route."
                      : "Optional"
                  }
                />
              </label>
            </div>
          )}
          <p className="mt-3 text-xs text-fern">
            Demo buttons use deterministic synthetic intensities to guarantee interview-ready outcomes.
          </p>

          {decisionId && (
            <p className="mt-4 text-xs text-fern">
              Decision ID: <span className="font-mono">{decisionId}</span>
            </p>
          )}
          {decisionId && (
            <p className="mt-2 text-xs uppercase tracking-wide text-fern">
              Run mode: {activeDemoScenario ? DEMO_SCENARIO_LABELS[activeDemoScenario] : "Live API"}
            </p>
          )}
          {decisionId && activeProcessingStep && (
            <p className="mt-2 text-xs font-semibold uppercase tracking-wide text-fern">
              Step: {activeProcessingStep}
            </p>
          )}
          {decisionId && (
            <p className="mt-3 rounded-lg border border-moss/30 bg-moss/5 px-3 py-2 text-sm text-ink">{decisionExplanation}</p>
          )}
          {decision.manager_prompt && uiState === "awaiting_approval" && (
            <p className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
              {decision.manager_prompt}
            </p>
          )}
          {error && <p className="mt-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
        </section>

        <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          <article className="panel-strong rounded-2xl p-4">
            <p className="text-xs uppercase tracking-[0.14em] text-fern">Primary Zone Intensity</p>
            <p className={`mt-2 text-2xl font-bold ${intensityClassName(primaryIntensitySeverity)}`}>{decision.primary_intensity ?? "-"}</p>
            <p className="text-sm text-fern">gCO2eq/kWh</p>
          </article>
          <article className="panel-strong rounded-2xl p-4">
            <p className="text-xs uppercase tracking-[0.14em] text-fern">Selected Execution Zone</p>
            <p className="mt-2 text-2xl font-bold text-ink">{decision.selected_execution_zone ?? "-"}</p>
            <p className={`text-sm ${intensityClassName(selectedIntensitySeverity)}`}>{decision.selected_execution_intensity ?? "-"} gCO2eq/kWh</p>
          </article>
          <article className="panel-strong rounded-2xl p-4">
            <p className="text-xs uppercase tracking-[0.14em] text-fern">Execution Mode</p>
            <p className="mt-2 text-2xl font-bold text-ink">{decision.execution_mode ?? "-"}</p>
            <p className="text-sm text-fern">local / routed / postponed</p>
          </article>
          <article
            className={`rounded-2xl p-4 ${
              isRealized
                ? "border border-emerald-200 bg-emerald-50"
                : isForegone
                  ? "border border-amber-200 bg-amber-50"
                  : "panel-strong"
            }`}
          >
            <p
              className={`text-xs uppercase tracking-[0.14em] ${
                isRealized ? "text-emerald-700" : isForegone ? "text-amber-700" : "text-fern"
              }`}
            >
              {isForegone ? "Foregone Savings" : "Routing Savings"}
            </p>
            <p
              className={`mt-2 text-2xl font-bold ${
                isRealized ? "text-emerald-800" : isForegone ? "text-amber-800" : "text-ink"
              }`}
            >
              {decision.estimated_kgco2_saved_by_routing ?? "-"}
            </p>
            <p
              className={`text-sm ${
                isRealized ? "text-emerald-600" : isForegone ? "text-amber-600" : "text-fern"
              }`}
            >
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
              <span className="font-mono text-xs text-fern/80">{decision.policy_action ?? "pending"}</span>
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
              <span className="font-semibold text-ink">Manager ID:</span> {decision.manager_id ?? "N/A"}
            </p>
            <p className="mt-2 text-sm text-fern">
              <span className="font-semibold text-ink">Override Reason:</span> {decision.override_reason ?? "N/A"}
            </p>
          </article>

          <article className="panel-strong rounded-2xl p-5">
            <h2 className="text-lg font-bold text-ink">Audit Report</h2>
            <p className="mt-2 text-xs uppercase tracking-wide text-fern">Mode: {decision.audit_mode ?? "pending"}</p>
            <p className="mt-3 whitespace-pre-wrap text-sm text-ink">
              {decision.audit_report ?? "Audit report appears when workflow reaches completion."}
            </p>
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
              <tbody className="divide-y divide-moss/10 bg-white/70">
                {tradeoffRows.map((row) => (
                  <tr key={row.option}>
                    <td className="px-4 py-3 font-semibold text-ink">{row.option}</td>
                    <td className="px-4 py-3 text-ink">{row.zone}</td>
                    <td className="px-4 py-3 text-ink">{row.carbon}</td>
                    <td className="px-4 py-3 text-ink">{row.latency}</td>
                    <td className="px-4 py-3 text-ink">{row.dataResidency}</td>
                    <td className="px-4 py-3 text-ink">{row.costImpact}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {decision.execution_mode === "postponed" && (
            <div className="mt-4 rounded-lg border border-sky-200 bg-sky-50 px-4 py-3 text-sm text-sky-900">
              {decision.forecast_available && decision.forecast_recommendation ? (
                <>
                  <span className="font-semibold">Forecast guidance:</span>{" "}
                  {decision.forecast_recommendation}
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
              <tbody className="divide-y divide-moss/10 bg-white/70">
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
                <details key={`${event.ts}-${event.stage}-${index}`} className="rounded-xl border border-moss/20 bg-white/70 px-4 py-3">
                  <summary className="cursor-pointer text-sm font-semibold text-ink">
                    {formatTimestamp(event.ts)} | {event.stage} | {event.message}
                  </summary>
                  <pre className="mt-3 overflow-x-auto rounded bg-slate-100 p-3 text-xs text-slate-700">
                    {JSON.stringify(event.data, null, 2)}
                  </pre>
                </details>
              ))}
            </div>
          )}
        </section>
      </div>
      {showIntroModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-2xl rounded-2xl border border-moss/20 bg-white p-6 shadow-2xl">
            <h2 className="text-xl font-bold text-ink">Welcome to Carbon-Aware Compute Advisor</h2>
            <p className="mt-2 text-sm text-fern">
              This dashboard decides whether compute workloads should run locally, route to a cleaner region, or be escalated for manager approval.
            </p>
            <div className="mt-4 space-y-3 text-sm text-fern">
              <p>
                <span className="font-semibold text-ink">Inputs:</span> Estimated Job Energy drives emissions math, Carbon Threshold sets policy strictness, and
                Primary Grid Zone is the origin region for execution.
              </p>
              <p>
                <span className="font-semibold text-ink">Actions:</span> Evaluate Live uses real API signals. Force buttons run deterministic scenarios for demo flows
                (clean, routeable dirty, non-routeable dirty).
              </p>
              <p>
                <span className="font-semibold text-ink">Governance:</span> Dirty scenarios can require manager decisions (`run_local`, `route`, `postpone`) with
                auditable reasoning and CSV export.
              </p>
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
