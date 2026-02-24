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
        "rounded-full border border-fern/30 px-3 py-1 text-xs font-semibold uppercase tracking-wide text-fern transition hover:bg-fern/10"
      }
      onClick={onToggle}
      aria-label={`Switch to ${resolvedTheme === "dark" ? "light" : "dark"} mode`}
    >
      {resolvedTheme === "dark" ? "Light Mode" : "Dark Mode"}
    </button>
  );
}
