import { computed, ref } from "vue";

const STORAGE_KEY = "xtctx-theme";
const DEFAULT_THEME: ThemeMode = "dark";

export type ThemeMode = "dark" | "light";

const currentTheme = ref<ThemeMode>(DEFAULT_THEME);
let initialized = false;

export function useTheme() {
  if (!initialized && typeof window !== "undefined") {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (stored === "light" || stored === "dark") {
      currentTheme.value = stored;
    }
    applyTheme(currentTheme.value);
    initialized = true;
  }

  function setTheme(theme: ThemeMode): void {
    currentTheme.value = theme;
    if (typeof window !== "undefined") {
      window.localStorage.setItem(STORAGE_KEY, theme);
    }
    applyTheme(theme);
  }

  function toggleTheme(): void {
    setTheme(currentTheme.value === "dark" ? "light" : "dark");
  }

  return {
    theme: currentTheme,
    isDark: computed(() => currentTheme.value === "dark"),
    setTheme,
    toggleTheme,
  };
}

function applyTheme(theme: ThemeMode): void {
  if (typeof document === "undefined") {
    return;
  }

  const root = document.documentElement;
  root.classList.toggle("app-dark", theme === "dark");
  root.classList.toggle("light-mode", theme === "light");
}
