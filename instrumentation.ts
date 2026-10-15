export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { installShutdown } = await import("./lib/server/shutdown");
  installShutdown();
  const { startNotify } = await import("./lib/server/notify");
  startNotify();
}
