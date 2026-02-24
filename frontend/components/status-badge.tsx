import { DecisionStatus } from "@/lib/types";

const styleMap: Record<DecisionStatus, string> = {
  processing: "bg-amber-100 text-amber-800 border-amber-200 dark:bg-amber-900/30 dark:text-amber-300 dark:border-amber-700",
  awaiting_approval: "bg-orange-100 text-orange-800 border-orange-200 dark:bg-orange-900/30 dark:text-orange-300 dark:border-orange-700",
  completed: "bg-emerald-100 text-emerald-800 border-emerald-200 dark:bg-emerald-900/30 dark:text-emerald-300 dark:border-emerald-700",
  postponed: "bg-sky-100 text-sky-800 border-sky-200 dark:bg-sky-900/30 dark:text-sky-300 dark:border-sky-700",
  error: "bg-red-100 text-red-800 border-red-200 dark:bg-red-900/30 dark:text-red-300 dark:border-red-700"
};

export function StatusBadge({ status }: { status: DecisionStatus }) {
  return (
    <span className={`inline-flex rounded-full border px-3 py-1 text-xs font-semibold uppercase tracking-wide ${styleMap[status]}`}>
      {status.split("_").join(" ")}
    </span>
  );
}

const actionStyleMap = {
  run_now_local: "bg-emerald-100 text-emerald-800 border-emerald-200 dark:bg-emerald-900/30 dark:text-emerald-300 dark:border-emerald-700",
  route_to_clean_region: "bg-blue-100 text-blue-800 border-blue-200 dark:bg-blue-900/30 dark:text-blue-300 dark:border-blue-700",
  require_manager_decision: "bg-amber-100 text-amber-800 border-amber-200 dark:bg-amber-900/30 dark:text-amber-300 dark:border-amber-700",
  pending: "bg-slate-100 text-slate-700 border-slate-200 dark:bg-slate-800 dark:text-slate-200 dark:border-slate-600"
} as const;

function actionLabel(action: "run_now_local" | "route_to_clean_region" | "require_manager_decision" | null): string {
  if (action === "run_now_local") return "Run Local";
  if (action === "route_to_clean_region") return "Route to Clean Region";
  if (action === "require_manager_decision") return "Manager Approval Required";
  return "Pending";
}

export function PolicyActionBadge({
  action
}: {
  action: "run_now_local" | "route_to_clean_region" | "require_manager_decision" | null;
}) {
  const style = action ? actionStyleMap[action] : actionStyleMap.pending;
  return <span className={`inline-flex rounded-full border px-3 py-1 text-xs font-semibold ${style}`}>{actionLabel(action)}</span>;
}
