"use client";

import { useEffect, useState } from "react";

export function useOnlineStatus(): boolean {
  // `navigator.onLine` is only reliable after mount (SSR has no
  // navigator) — default to true so the offline badge doesn't flash
  // on every page load before the browser reports its real state.
  const [online, setOnline] = useState(true);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setOnline(navigator.onLine);
    const goOnline = () => setOnline(true);
    const goOffline = () => setOnline(false);
    window.addEventListener("online", goOnline);
    window.addEventListener("offline", goOffline);
    return () => {
      window.removeEventListener("online", goOnline);
      window.removeEventListener("offline", goOffline);
    };
  }, []);

  return online;
}
