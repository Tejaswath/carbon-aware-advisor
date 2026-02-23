import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Carbon-Aware Compute Advisor",
  description: "Forecast-aware ESG job orchestration dashboard"
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
