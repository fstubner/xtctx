import type { Config } from "tailwindcss";

export default {
  darkMode: ["class", ".app-dark"],
  content: ["./index.html", "./src/**/*.{vue,ts}"],
  theme: {
    extend: {
      colors: {
        bg: "hsl(var(--bg) / <alpha-value>)",
        surface: "hsl(var(--surface) / <alpha-value>)",
        "surface-2": "hsl(var(--surface-2) / <alpha-value>)",
        border: "hsl(var(--border) / <alpha-value>)",
        text: "hsl(var(--text) / <alpha-value>)",
        muted: "hsl(var(--muted) / <alpha-value>)",
        accent: "hsl(var(--accent) / <alpha-value>)",
      },
      borderRadius: {
        lg: "0.9rem",
        xl: "1.15rem",
      },
      boxShadow: {
        soft: "0 12px 30px rgba(2, 7, 16, 0.16)",
      },
    },
  },
  plugins: [],
} satisfies Config;
