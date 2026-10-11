"use client";

import { useEffect, useState } from "react";
import { Check, Clock, WarningTriangle } from "iconoir-react";
import type { Pending } from "@/lib/client/useSession";

/* How long a delivered message can go unseen in the transcript before we say so. */
const SLOW_MS = 90_000;

/**
 * A message that isn't in the transcript yet, with where it is in delivery:
 * sending, handed to the terminal/web run (and queued if Claude is mid-turn),
 * or failed with the reason and a way out.
 */
export function PendingBubble({
  pending,
  where,
  claudeBusy,
  onRetry,
  onDiscard,
}: {
  pending: Pending;
  where: string | null;
  claudeBusy: boolean;
  onRetry: () => void;
  onDiscard: () => void;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (pending.state !== "sent") return;
    const t = setInterval(() => setNow(Date.now()), 5000);
    return () => clearInterval(t);
  }, [pending.state]);

  const slow = pending.state === "sent" && now - pending.at > SLOW_MS;
  const target = pending.via === "terminal" ? where ?? "the terminal" : "Claude";
  const status =
    pending.state === "sending"
      ? { icon: <Clock width={12} height={12} strokeWidth={2} />, text: pending.via === "terminal" || where ? `Typing into ${where ?? "the terminal"}…` : "Sending…", tone: "text-ink-3" }
      : pending.state === "failed"
        ? { icon: <WarningTriangle width={12} height={12} strokeWidth={2} />, text: pending.error ?? "Couldn't send.", tone: "text-red-ink" }
        : slow
          ? { icon: <WarningTriangle width={12} height={12} strokeWidth={2} />, text: `Sent to ${target}, but it isn't in this conversation yet. Check the terminal view.`, tone: "text-orange-ink" }
          : claudeBusy
            ? { icon: <Clock width={12} height={12} strokeWidth={2} />, text: `Queued. ${target === "Claude" ? "Claude" : "Claude in " + target} reads it after the current step.`, tone: "text-ink-3" }
            : { icon: <Check width={12} height={12} strokeWidth={2.2} />, text: `Delivered to ${target}`, tone: "text-ink-3" };

  return (
    <div className="flex flex-col items-end gap-1 pl-8 sm:pl-20" style={{ animation: "fade-up 260ms cubic-bezier(0.23,1,0.32,1) both" }}>
      <div
        className={`max-w-full min-w-0 rounded-[14px] border border-dashed px-3.5 py-2.5 text-[15px] leading-relaxed whitespace-pre-wrap text-ink [overflow-wrap:anywhere] sm:py-2 sm:text-[13.5px] ${
          pending.state === "failed" ? "border-red/40 bg-red-tint" : "border-line-strong bg-field/60"
        }`}
        aria-busy={pending.state === "sending" || undefined}
      >
        {pending.text}
      </div>
      <div role="status" className={`flex max-w-full items-center gap-1.5 text-[11.5px] ${status.tone}`}>
        <span className="shrink-0">{status.icon}</span>
        <span className="min-w-0">{status.text}</span>
        {(pending.state === "failed" || slow) && (
          <span className="ml-1 flex shrink-0 items-center gap-1">
            {pending.state === "failed" && (
              <button type="button" onClick={onRetry} className="tap relative rounded-full px-2 py-0.5 font-medium text-ink hover:bg-hover">
                Retry
              </button>
            )}
            <button type="button" onClick={onDiscard} className="tap relative rounded-full px-2 py-0.5 font-medium text-ink-2 hover:bg-hover">
              Discard
            </button>
          </span>
        )}
      </div>
    </div>
  );
}
