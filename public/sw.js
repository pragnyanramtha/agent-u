/* agent-u service worker: shows push notifications and opens the session they're about. No caching. */

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

/* Safari takes push permission back from sites whose pushes show nothing, so there it always shows */
const apple = /Safari/.test(navigator.userAgent) && !/Chrome|Chromium|CriOS|Edg|Firefox|FxiOS/.test(navigator.userAgent);

self.addEventListener("push", (event) => {
  let msg;
  try {
    msg = event.data.json();
  } catch {
    msg = { title: "agent-u", body: event.data ? event.data.text() : "", tag: "agent-u", url: "/", kind: "test" };
  }
  event.waitUntil(
    (async () => {
      const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const c of wins) c.postMessage({ type: "push", msg });
      const watching = wins.some((c) => c.focused && c.visibilityState === "visible");
      if (watching && !apple && msg.kind !== "test") return;
      await self.registration.showNotification(msg.title || "agent-u", {
        body: msg.body || "",
        tag: msg.tag || "agent-u",
        renotify: msg.kind !== "done",
        icon: "/apple-touch-icon.png",
        data: { url: msg.url || "/" },
      });
    })(),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = new URL((event.notification.data && event.notification.data.url) || "/", self.location.origin).href;
  event.waitUntil(
    (async () => {
      const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      const win = wins.find((c) => new URL(c.url).origin === self.location.origin);
      if (win) {
        await win.focus();
        win.postMessage({ type: "open", url });
        return;
      }
      await self.clients.openWindow(url);
    })(),
  );
});
