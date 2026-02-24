import type { Metadata } from "next";
import "./globals.css";
import Providers from "./providers";
import { themeInitScript } from "@/lib/theme";

export const metadata: Metadata = {
  title: "Carbon-Aware Compute Advisor",
  description: "Forecast-aware ESG job orchestration dashboard"
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script
          dangerouslySetInnerHTML={{
            __html: themeInitScript()
          }}
        />
      </head>
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
