import { DecisionStatus } from "@/lib/types";

const styleMap: Record<DecisionStatus, string> = {
  processing: "bg-amber-100 text-amber-800 border-amber-200",
  awaiting_approval: "bg-orange-100 text-orange-800 border-orange-200",
  completed: "bg-emerald-100 text-emerald-800 border-emerald-200",
  postponed: "bg-sky-100 text-sky-800 border-sky-200",
  error: "bg-red-100 text-red-800 border-red-200"
};

export function StatusBadge({ status }: { status: DecisionStatus }) {
  return (
    <span className={`inline-flex rounded-full border px-3 py-1 text-xs font-semibold uppercase tracking-wide ${styleMap[status]}`}>
      {status.replace("_", " ")}
    </span>
  );
}
