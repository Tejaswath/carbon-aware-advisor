import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
    "./components/**/*.{js,ts,jsx,tsx,mdx}",
    "./lib/**/*.{js,ts,jsx,tsx,mdx}"
  ],
  theme: {
    extend: {
      colors: {
        ink: "#132a1d",
        fern: "#2f5d50",
        moss: "#7a9e7e",
        sand: "#f6f2ea",
        ember: "#d86f45"
      },
      boxShadow: {
        panel: "0 20px 40px -24px rgba(19,42,29,0.35)"
      }
    }
  },
  plugins: []
};

export default config;
