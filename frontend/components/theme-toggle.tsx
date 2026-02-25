"use client";

type ThemeToggleProps = {
  resolvedTheme: "light" | "dark";
  onToggle: () => void;
  className?: string;
};

export function ThemeToggle({ resolvedTheme, onToggle, className }: ThemeToggleProps) {
  const nextTheme = resolvedTheme === "dark" ? "light" : "dark";
  return (
    <button
      type="button"
      className={
        className ??
        "inline-flex h-9 w-9 items-center justify-center rounded-full border border-zinc-300/80 text-fern transition hover:bg-zinc-200/60 dark:border-zinc-700 dark:hover:bg-zinc-800"
      }
      onClick={onToggle}
      aria-label={`Switch to ${nextTheme} mode`}
      title={`Switch to ${nextTheme} mode`}
    >
      {resolvedTheme === "dark" ? (
        <svg aria-hidden="true" viewBox="0 0 24 24" className="h-4 w-4" fill="none">
          <circle cx="12" cy="12" r="4" stroke="currentColor" strokeWidth="1.8" />
          <path
            d="M12 2.5v2.5M12 19v2.5M4.9 4.9l1.8 1.8M17.3 17.3l1.8 1.8M2.5 12H5M19 12h2.5M4.9 19.1l1.8-1.8M17.3 6.7l1.8-1.8"
            stroke="currentColor"
            strokeLinecap="round"
            strokeWidth="1.8"
          />
        </svg>
      ) : (
        <svg aria-hidden="true" viewBox="0 0 24 24" className="h-4 w-4" fill="none">
          <path
            d="M20.6 14.7A8.5 8.5 0 1 1 9.3 3.4a7 7 0 1 0 11.3 11.3Z"
            stroke="currentColor"
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth="1.8"
          />
        </svg>
      )}
    </button>
  );
}
