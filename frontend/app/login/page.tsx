"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { getProviders, signIn, useSession } from "next-auth/react";

import { ThemeToggle } from "@/components/theme-toggle";
import { useThemePreference } from "@/lib/use-theme-preference";

type ProviderMap = Record<string, { id: string; name: string }>;

function BoltIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="mx-auto mb-2 h-6 w-6 text-emerald-500">
      <path
        d="M13 2L4 14h6l-1 8 9-12h-6l1-8z"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.8"
      />
    </svg>
  );
}

function UserIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="mx-auto mb-2 h-6 w-6 text-emerald-500">
      <circle cx="12" cy="8" r="4" fill="none" stroke="currentColor" strokeWidth="1.8" />
      <path d="M4 20c1.8-3.5 5-5.2 8-5.2s6.2 1.7 8 5.2" fill="none" stroke="currentColor" strokeLinecap="round" strokeWidth="1.8" />
    </svg>
  );
}

function FileIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="mx-auto mb-2 h-6 w-6 text-emerald-500">
      <path d="M7 3h7l5 5v13H7z" fill="none" stroke="currentColor" strokeLinejoin="round" strokeWidth="1.8" />
      <path d="M14 3v5h5M10 12h7M10 16h7" fill="none" stroke="currentColor" strokeLinecap="round" strokeWidth="1.8" />
    </svg>
  );
}

export default function LoginPage() {
  const { status } = useSession();
  const router = useRouter();
  const { resolvedTheme, toggleTheme } = useThemePreference();
  const [providers, setProviders] = useState<ProviderMap | null>(null);

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
        setProviders((value as ProviderMap | null) ?? {});
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
  const authLoading = status === "loading";
  const disableGoogle = authLoading || providersLoading || !googleEnabled;
  const disableGitHub = authLoading || providersLoading || !githubEnabled;

  return (
    <main className="relative min-h-screen overflow-hidden bg-zinc-50 px-4 py-10 dark:bg-black">
      <div
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            "radial-gradient(ellipse at 50% 0%, rgba(24,24,27,0.95) 0%, rgba(9,9,11,0.92) 48%, rgba(0,0,0,1) 78%)"
        }}
      />

      <div className="relative z-10 mx-auto flex min-h-[calc(100vh-5rem)] w-full max-w-[520px] flex-col">
        <div className="mb-6 flex justify-end">
          <ThemeToggle resolvedTheme={resolvedTheme} onToggle={toggleTheme} />
        </div>

        <div className="flex flex-1 items-center justify-center">
          <section className="w-full space-y-8">
            <div className="text-center">
              <span className="inline-flex rounded-full border border-zinc-700 px-3 py-1 text-xs font-semibold uppercase tracking-[0.2em] text-zinc-500">
                ESG Orchestration Console
              </span>
            </div>

            <div className="space-y-3 text-center">
              <h1 className="text-4xl font-bold tracking-tight text-white md:text-5xl">Carbon-Aware Compute Advisor</h1>
              <p className="mx-auto max-w-xl text-lg text-zinc-400">
                Route compute workloads to the cleanest grid zone. Auditable decision trails your compliance team will trust.
              </p>
            </div>

            <div className="space-y-4">
              <button
                type="button"
                className="w-full rounded-xl border border-transparent bg-emerald-500 px-6 py-3 text-lg font-semibold text-white transition hover:bg-emerald-600 disabled:cursor-not-allowed disabled:opacity-65"
                onClick={() => void signIn("google", { callbackUrl: "/" })}
                disabled={disableGoogle}
              >
                {authLoading ? "Checking session..." : "Sign in with Google"}
              </button>

              <button
                type="button"
                className="w-full rounded-xl border border-zinc-700 bg-transparent px-6 py-3 text-lg font-semibold text-white transition hover:bg-zinc-900 disabled:cursor-not-allowed disabled:opacity-60"
                onClick={() => void signIn("github", { callbackUrl: "/" })}
                disabled={disableGitHub}
              >
                Sign in with GitHub
              </button>

              {!providersLoading && !githubEnabled && (
                <p className="text-sm text-amber-300">
                  GitHub provider is not configured in this environment. Set `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET` to enable it.
                </p>
              )}
            </div>

            <div className="grid grid-cols-3 gap-3 pt-2">
              <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-4 text-center">
                <BoltIcon />
                <p className="text-xs leading-tight text-zinc-400">Real-Time Grid Signals</p>
              </div>
              <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-4 text-center">
                <UserIcon />
                <p className="text-xs leading-tight text-zinc-400">Human-in-the-Loop</p>
              </div>
              <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-4 text-center">
                <FileIcon />
                <p className="text-xs leading-tight text-zinc-400">Audit-Ready Export</p>
              </div>
            </div>

            <p className="text-center text-sm text-zinc-500">Sense grid -&gt; Apply policy -&gt; Route or escalate -&gt; Audit trail</p>
          </section>
        </div>
      </div>
    </main>
  );
}
