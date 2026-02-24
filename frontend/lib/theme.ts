export const THEME_STORAGE_KEY = "carbon_advisor.theme";

export type ThemePreference = "system" | "light" | "dark";
export type ResolvedTheme = "light" | "dark";

export function parseThemePreference(raw: string | null): ThemePreference {
  if (raw === "light" || raw === "dark") return raw;
  return "system";
}

export function resolveTheme(preference: ThemePreference, systemPrefersDark: boolean): ResolvedTheme {
  if (preference === "dark") return "dark";
  if (preference === "light") return "light";
  return systemPrefersDark ? "dark" : "light";
}

export function themeInitScript(): string {
  return `
    (function() {
      try {
        var key = ${JSON.stringify(THEME_STORAGE_KEY)};
        var stored = window.localStorage.getItem(key);
        var preference = (stored === "light" || stored === "dark") ? stored : "system";
        var systemDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
        var resolved = preference === "system" ? (systemDark ? "dark" : "light") : preference;
        document.documentElement.classList.toggle("dark", resolved === "dark");
      } catch (_) {}
    })();
  `;
}
