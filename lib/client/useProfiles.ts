"use client";

import { useEffect, useState } from "react";
import type { AgentId, ProfileInfo } from "@/lib/types";
import { api } from "./api";

/* Agent profiles from /api/profiles, shared by every screen; saving in settings refreshes them all. */

export const PROFILES_CHANGED = "agentu:profiles";
type Data = { profiles: ProfileInfo[]; configPath: string };
let cache: Data | null = null;
let inflight: Promise<Data> | null = null;

function load(force = false): Promise<Data> {
  if (cache && !force) return Promise.resolve(cache);
  inflight ??= api<Data>("/api/profiles")
    .then((d) => (cache = d))
    .finally(() => (inflight = null));
  return inflight;
}

export function setProfilesCache(d: Data) {
  cache = d;
  window.dispatchEvent(new Event(PROFILES_CHANGED));
}

export function useProfiles() {
  const [data, setData] = useState<Data | null>(cache);
  useEffect(() => {
    let live = true;
    const pull = (force: boolean) => load(force).then((d) => live && setData(d), () => undefined);
    void pull(false);
    const on = () => setData(cache);
    window.addEventListener(PROFILES_CHANGED, on);
    return () => {
      live = false;
      window.removeEventListener(PROFILES_CHANGED, on);
    };
  }, []);
  return { profiles: data?.profiles ?? null, configPath: data?.configPath ?? "" };
}

/** Composer model choices for a profile: its own list, else the agent's default list. */
export function profileModels(p: ProfileInfo | undefined, fallback: { key: string; name: string }[]) {
  if (!p?.models.length) return fallback;
  return [{ key: "", name: p.defaultModel ? `Default (${p.defaultModel})` : "Default" }, ...p.models.map((m) => ({ key: m, name: m }))];
}

export const profilesFor = (all: ProfileInfo[] | null, agent: AgentId) => (all ?? []).filter((p) => p.agent === agent && !p.hidden);
