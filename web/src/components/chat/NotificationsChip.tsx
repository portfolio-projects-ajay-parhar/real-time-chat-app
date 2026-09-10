"use client";

import { useEffect, useState } from "react";

/**
 * "Enable notifications" chip — the ONLY place permission is requested.
 * Browser gesture policy: Notification.requestPermission() must run inside a
 * user gesture, never on page load (PLAN §9.1). Renders nothing once granted
 * or denied/unsupported.
 */
export function NotificationsChip() {
  const [permission, setPermission] = useState<"default" | "granted" | "denied" | "unsupported">(
    "default"
  );

  // Read the real permission after mount (SSR-safe: the chip renders first,
  // then disappears for granted/denied/unsupported browsers).
  useEffect(() => {
    let alive = true;
    Promise.resolve().then(() => {
      if (!alive) return;
      if (typeof window === "undefined" || !("Notification" in window)) {
        setPermission("unsupported");
        return;
      }
      setPermission(Notification.permission);
    });
    return () => {
      alive = false;
    };
  }, []);

  if (permission !== "default") return null;

  const onClick = async () => {
    try {
      setPermission(await Notification.requestPermission());
    } catch {
      setPermission("denied");
    }
  };

  return (
    <button
      type="button"
      onClick={onClick}
      title="Get notified about new messages while the tab is in the background"
      className="rounded-full bg-zinc-800 px-3 py-1 text-xs font-medium text-zinc-300 hover:bg-zinc-700"
    >
      🔔 Notifications
    </button>
  );
}