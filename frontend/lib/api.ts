import { DecisionResponse, ManagerActionRequest, StartDecisionRequest } from "@/lib/types";

const BASE = process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:8000/api/v1";

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(`${BASE}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {})
    }
  });

  if (!response.ok) {
    let detail = `HTTP ${response.status}`;
    try {
      const json = await response.json();
      detail = json.detail || detail;
    } catch {
      // no-op
    }
    throw new Error(detail);
  }

  return response.json() as Promise<T>;
}

export const api = {
  startDecision: (payload: StartDecisionRequest) =>
    request<DecisionResponse>("/decisions/start", {
      method: "POST",
      body: JSON.stringify(payload)
    }),
  getDecision: (decisionId: string) => request<DecisionResponse>(`/decisions/${decisionId}`),
  runLocalDecision: (decisionId: string, payload: ManagerActionRequest) =>
    request<DecisionResponse>(`/decisions/${decisionId}/run-local`, { method: "POST", body: JSON.stringify(payload) }),
  routeDecision: (decisionId: string, payload: ManagerActionRequest) =>
    request<DecisionResponse>(`/decisions/${decisionId}/route`, { method: "POST", body: JSON.stringify(payload) }),
  postponeDecision: (decisionId: string, payload: ManagerActionRequest) =>
    request<DecisionResponse>(`/decisions/${decisionId}/postpone`, { method: "POST", body: JSON.stringify(payload) }),
  downloadAuditCsv: async (decisionId: string): Promise<Blob> => {
    const response = await fetch(`${BASE}/decisions/${decisionId}/audit.csv`);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    return response.blob();
  }
};
