"use client";

import { useEffect, useState } from "react";

/** A quiet strip while the browser is offline. Work on the server carries on; sends go out when it's back. */
export function OfflineBanner() {
  const [offline, setOffline] = useState(false);
  useEffect(() => {
    const sync = () => setOffline(!navigator.onLine);
    sync();
    window.addEventListener("online", sync);
    window.addEventListener("offline", sync);
    return () => {
      window.removeEventListener("online", sync);
      window.removeEventListener("offline", sync);
    };
  }, []);
  if (!offline) return null;
  return (
    <div role="status" className="safe-top fixed inset-x-0 top-0 z-[60] flex justify-center px-3 pt-2 pointer-events-none">
      <p className="pointer-events-auto rounded-full bg-ink px-3.5 py-1.5 text-[12.5px] font-medium text-page shadow-overlay">
        Offline. Agents keep running on the server; messages send when you&apos;re back.
      </p>
    </div>
  );
}
