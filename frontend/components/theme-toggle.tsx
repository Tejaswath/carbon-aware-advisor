"use client";

type ThemeToggleProps = {
  resolvedTheme: "light" | "dark";
  onToggle: () => void;
  className?: string;
};

export function ThemeToggle({ resolvedTheme, onToggle, className }: ThemeToggleProps) {
  return (
    <button
      type="button"
      className={
        className ??
        "rounded-full border border-zinc-300/80 px-3 py-1 text-xs font-semibold uppercase tracking-wide text-fern transition hover:bg-zinc-200/60 dark:border-zinc-700 dark:hover:bg-zinc-800"
      }
      onClick={onToggle}
      aria-label={`Switch to ${resolvedTheme === "dark" ? "light" : "dark"} mode`}
    >
      {resolvedTheme === "dark" ? "Light Mode" : "Dark Mode"}
    </button>
  );
}
