import { DecisionStatus } from "@/lib/types";

const styleMap: Record<DecisionStatus, string> = {
  processing: "bg-amber-100 text-amber-800 border-amber-300/80 dark:bg-amber-900/30 dark:text-amber-300 dark:border-amber-700/80",
  awaiting_approval: "bg-orange-100 text-orange-800 border-orange-300/80 dark:bg-orange-900/30 dark:text-orange-300 dark:border-orange-700/80",
  completed: "bg-emerald-100 text-emerald-800 border-emerald-300/80 dark:bg-emerald-900/30 dark:text-emerald-300 dark:border-emerald-700/80",
  postponed: "bg-sky-100 text-sky-800 border-sky-300/80 dark:bg-sky-900/30 dark:text-sky-300 dark:border-sky-700/80",
  error: "bg-red-100 text-red-800 border-red-300/80 dark:bg-red-900/30 dark:text-red-300 dark:border-red-700/80"
};

function statusLabel(status: DecisionStatus): string {
  if (status === "awaiting_approval") return "Awaiting approval";
  if (status === "processing") return "Processing";
  if (status === "completed") return "Completed";
  if (status === "postponed") return "Postponed";
  return "Error";
}

function statusIcon(status: DecisionStatus) {
  if (status === "processing") {
    return (
      <svg aria-hidden="true" viewBox="0 0 16 16" className="h-3.5 w-3.5 animate-spin fill-none stroke-current">
        <circle cx="8" cy="8" r="6" className="opacity-35" strokeWidth="1.8" />
        <path d="M8 2a6 6 0 0 1 6 6" strokeWidth="1.8" strokeLinecap="round" />
      </svg>
    );
  }
  if (status === "completed") {
    return (
      <svg aria-hidden="true" viewBox="0 0 16 16" className="h-3.5 w-3.5 fill-none stroke-current">
        <path d="M3 8.5 6.2 11.5 13 4.8" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  }
  if (status === "awaiting_approval") {
    return (
      <svg aria-hidden="true" viewBox="0 0 16 16" className="h-3.5 w-3.5 fill-none stroke-current">
        <circle cx="8" cy="8" r="5.5" strokeWidth="1.6" />
        <path d="M8 5v3.1l2 1.5" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  }
  if (status === "postponed") {
    return (
      <svg aria-hidden="true" viewBox="0 0 16 16" className="h-3.5 w-3.5 fill-none stroke-current">
        <path d="M5 4.5v7M10.5 4.5v7" strokeWidth="1.8" strokeLinecap="round" />
      </svg>
    );
  }
  return (
    <svg aria-hidden="true" viewBox="0 0 16 16" className="h-3.5 w-3.5 fill-none stroke-current">
      <circle cx="8" cy="8" r="6" strokeWidth="1.6" />
      <path d="M8 4.5v4.2M8 11.5h.01" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

export function StatusBadge({ status }: { status: DecisionStatus }) {
  return (
    <span role="status" className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-semibold ${styleMap[status]}`}>
      {statusIcon(status)}
      <span>{statusLabel(status)}</span>
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
  return <span className={`inline-flex rounded-full border px-2.5 py-1 text-xs font-semibold ${style}`}>{actionLabel(action)}</span>;
}
