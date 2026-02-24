"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { getProviders, signIn, useSession } from "next-auth/react";

import { ThemeToggle } from "@/components/theme-toggle";
import { useThemePreference } from "@/lib/use-theme-preference";

export default function LoginPage() {
  const { status } = useSession();
  const router = useRouter();
  const { resolvedTheme, toggleTheme } = useThemePreference();
  const [providers, setProviders] = useState<Record<string, { id: string; name: string }> | null>(null);

  useEffect(() => {
    if (status === "authenticated") {
      router.replace("/");
    }
  }, [status, router]);

  useEffect(() => {
    let isMounted = true;
    void getProviders()
      .then((value) => {
        if (!isMounted) return;
        setProviders((value as Record<string, { id: string; name: string }> | null) ?? {});
      })
      .catch(() => {
        if (!isMounted) return;
        setProviders({});
      });
    return () => {
      isMounted = false;
    };
  }, []);

  const providersLoading = providers === null;
  const googleEnabled = Boolean(providers?.google);
  const githubEnabled = Boolean(providers?.github);

  return (
    <main className="px-4 py-8 md:px-8">
      <div className="mx-auto max-w-6xl">
        <div className="mb-4 flex justify-end">
          <ThemeToggle resolvedTheme={resolvedTheme} onToggle={toggleTheme} />
        </div>
        <section className="grid gap-5 lg:grid-cols-5">
          <article className="glass-panel rounded-3xl p-6 lg:col-span-2">
            <p className="text-xs font-semibold uppercase tracking-[0.2em] text-fern">ESG Orchestration Console</p>
            <h1 className="mt-3 text-3xl font-bold text-ink">Carbon-Aware Compute Advisor</h1>
            <p className="mt-3 text-sm text-fern">
              Real-time compute-routing decisions using live carbon-intensity signals, policy rules, and auditable manager governance.
            </p>
            <ul className="mt-5 space-y-2 text-sm text-fern">
              <li>Live Electricity Maps signals for Nordic grid zones</li>
              <li>Human-in-the-loop manager approvals for dirty-grid cases</li>
              <li>Replay timeline and downloadable CSV audit artifacts</li>
            </ul>
          </article>

          <article className="panel-strong rounded-3xl p-6 md:p-8 lg:col-span-3">
            <p className="text-xs font-semibold uppercase tracking-[0.2em] text-fern">Secure Access</p>
            <h2 className="mt-3 text-3xl font-bold text-ink">Sign in to Carbon-Aware Compute Advisor</h2>
            <p className="mt-3 text-sm text-fern">
              Sign in with a federated identity provider to access the dashboard and submit governance actions with auditable approver identity.
            </p>

            <div className="mt-6 grid gap-3 sm:max-w-sm">
              <button
                type="button"
                className="rounded-xl border border-transparent bg-[#1f5f3f] px-6 py-3 text-sm font-semibold text-white transition hover:bg-[#2b7a52] disabled:cursor-not-allowed disabled:opacity-70 dark:bg-emerald-400 dark:text-[#04120a] dark:hover:bg-emerald-300"
                onClick={() => void signIn("google", { callbackUrl: "/" })}
                disabled={status === "loading" || providersLoading || !googleEnabled}
              >
                {status === "loading" ? "Checking session..." : "Sign in with Google"}
              </button>

              <button
                type="button"
                className="rounded-xl border border-fern/40 bg-transparent px-6 py-3 text-sm font-semibold text-fern transition hover:bg-fern/10 disabled:cursor-not-allowed disabled:opacity-60"
                onClick={() => void signIn("github", { callbackUrl: "/" })}
                disabled={status === "loading" || providersLoading || !githubEnabled}
              >
                Sign in with GitHub
              </button>
            </div>

            {!providersLoading && !githubEnabled && (
              <p className="mt-3 text-xs text-amber-700 dark:text-amber-300">
                GitHub provider is not configured in this environment. Set `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET` to enable it.
              </p>
            )}
          </article>
        </section>
      </div>
    </main>
  );
}
