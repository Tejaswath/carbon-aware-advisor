"use client";

import { useEffect, useState } from "react";

import { ResolvedTheme, ThemePreference, THEME_STORAGE_KEY, parseThemePreference, resolveTheme } from "@/lib/theme";

export function useThemePreference() {
  const [themePreference, setThemePreference] = useState<ThemePreference>("system");
  const [resolvedTheme, setResolvedTheme] = useState<ResolvedTheme>(() => {
    if (typeof document === "undefined") return "light";
    return document.documentElement.classList.contains("dark") ? "dark" : "light";
  });

  useEffect(() => {
    if (typeof window === "undefined") return;
    const savedThemePreference = window.localStorage.getItem(THEME_STORAGE_KEY);
    setThemePreference(parseThemePreference(savedThemePreference));
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");

    const applyTheme = () => {
      const resolved = resolveTheme(themePreference, mediaQuery.matches);
      document.documentElement.classList.toggle("dark", resolved === "dark");
      setResolvedTheme(resolved);
    };

    applyTheme();
    mediaQuery.addEventListener("change", applyTheme);

    if (themePreference === "system") {
      window.localStorage.removeItem(THEME_STORAGE_KEY);
    } else {
      window.localStorage.setItem(THEME_STORAGE_KEY, themePreference);
    }

    return () => mediaQuery.removeEventListener("change", applyTheme);
  }, [themePreference]);

  const toggleTheme = () => {
    setThemePreference((current) => {
      if (current === "system") {
        return resolvedTheme === "dark" ? "light" : "dark";
      }
      return current === "dark" ? "light" : "dark";
    });
  };

  return {
    themePreference,
    resolvedTheme,
    setThemePreference,
    toggleTheme
  };
}
