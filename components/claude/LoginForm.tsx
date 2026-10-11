"use client";

import { useState } from "react";
import { Eye, EyeClosed } from "iconoir-react";
import { Button } from "@/components/atoms/Button";
import { Pulse } from "./Pulse";

export function LoginForm() {
  const [password, setPassword] = useState("");
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!password) return;
    setBusy(true);
    setError(null);
    const res = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password }),
    }).catch(() => null);
    if (res?.ok) {
      window.location.href = "/";
      return;
    }
    const data = (await res?.json().catch(() => ({}))) as { error?: string } | undefined;
    setError(data?.error ?? "Couldn't reach the server. Check your connection and try again.");
    setBusy(false);
  };

  return (
    <form onSubmit={submit} noValidate className="w-full max-w-[360px] overflow-hidden rounded-window bg-surface shadow-overlay" style={{ animation: "fade-up 450ms cubic-bezier(0.23,1,0.32,1) both" }}>
      <div className="flex flex-col gap-5 p-5">
        <div className="flex items-center gap-2.5">
          <span className="flex size-8 shrink-0 items-center justify-center rounded-[9px] bg-ink">
            <Pulse busy={busy} size={4} cellClass="bg-surface" />
          </span>
          <div>
            <h1 className="text-[15px] font-semibold tracking-[-0.01em] text-ink">Claude</h1>
            <p className="text-[12.5px] text-ink-3">Sign in to reach your sessions.</p>
          </div>
        </div>

        <div className="flex flex-col gap-1.5">
          <label htmlFor="password" className="text-[13px] font-medium text-ink-2">
            Password
          </label>
          <div
            className={`flex h-11 items-center rounded-[10px] bg-field pr-1 transition-shadow duration-150 ${
              error ? "shadow-[0_0_0_1px_var(--red)]" : "shadow-hairline focus-within:shadow-[0_0_0_1px_var(--line-strong)]"
            }`}
          >
            <input
              id="password"
              name="password"
              type={show ? "text" : "password"}
              autoComplete="current-password"
              autoFocus
              value={password}
              onChange={(e) => {
                setPassword(e.target.value);
                if (error) setError(null);
              }}
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              enterKeyHint="go"
              aria-invalid={Boolean(error)}
              aria-describedby={error ? "login-error" : undefined}
              className="h-full min-w-0 flex-1 bg-transparent px-3 text-[16px] text-ink outline-none sm:text-[14px] sm:pointer-coarse:text-[16px]"
            />
            <button
              type="button"
              onClick={() => setShow((v) => !v)}
              aria-label={show ? "Hide password" : "Show password"}
              aria-pressed={show}
              className="tap relative flex size-9 shrink-0 items-center justify-center rounded-[8px] text-ink-3 hover:bg-hover hover:text-ink"
            >
              {show ? <EyeClosed width={16} height={16} strokeWidth={1.8} /> : <Eye width={16} height={16} strokeWidth={1.8} />}
            </button>
          </div>
          {error && (
            <p id="login-error" role="alert" className="text-[12.5px] text-red-ink" style={{ animation: "fade-up 200ms cubic-bezier(0.23,1,0.32,1) both" }}>
              {error}
            </p>
          )}
        </div>
      </div>
      <div className="flex justify-end border-t border-line bg-inset px-5 py-3">
        <Button type="submit" variant="primary" size="md" className="w-full pointer-coarse:h-11 sm:w-auto" disabled={busy || !password}>
          {busy ? "Signing in…" : "Sign in"}
        </Button>
      </div>
    </form>
  );
}
