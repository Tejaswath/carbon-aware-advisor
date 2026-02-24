import type { Config } from "tailwindcss";

const config: Config = {
  darkMode: "class",
  content: [
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
    "./components/**/*.{js,ts,jsx,tsx,mdx}",
    "./lib/**/*.{js,ts,jsx,tsx,mdx}"
  ],
  theme: {
    extend: {
      colors: {
        ink: "rgb(var(--color-ink) / <alpha-value>)",
        fern: "rgb(var(--color-fern) / <alpha-value>)",
        moss: "rgb(var(--color-moss) / <alpha-value>)",
        sand: "rgb(var(--color-sand) / <alpha-value>)",
        ember: "rgb(var(--color-ember) / <alpha-value>)"
      },
      boxShadow: {
        panel: "0 20px 40px -24px rgba(19,42,29,0.35)"
      }
    }
  },
  plugins: []
};

export default config;
