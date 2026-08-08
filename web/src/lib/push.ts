/** Web Push subscribe/unsubscribe for phone PWA. */

function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

export function pushSupported(): boolean {
  if (typeof window === "undefined") return false;
  if (window.deskApp?.isApp) return false; // Electron unregisters SW
  return "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
}

export function isSecureForPush(): boolean {
  return window.isSecureContext === true;
}

export async function getPushState(): Promise<{
  supported: boolean;
  secure: boolean;
  permission: NotificationPermission | "unsupported";
  subscribed: boolean;
}> {
  if (!pushSupported()) {
    return {
      supported: false,
      secure: isSecureForPush(),
      permission: "unsupported",
      subscribed: false,
    };
  }
  const permission = Notification.permission;
  let subscribed = false;
  try {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    subscribed = Boolean(sub);
  } catch {
    /* */
  }
  return {
    supported: true,
    secure: isSecureForPush(),
    permission,
    subscribed,
  };
}

export async function enablePush(): Promise<{ ok: boolean; error?: string }> {
  if (!pushSupported()) {
    return { ok: false, error: "Push needs a browser/PWA (not the desktop app shell)." };
  }
  if (!isSecureForPush()) {
    return {
      ok: false,
      error: "Push needs HTTPS. Enable Tailscale Serve HTTPS, then reinstall the home-screen app from the https:// URL.",
    };
  }
  try {
    const reg = await navigator.serviceWorker.ready;
    const perm = await Notification.requestPermission();
    if (perm !== "granted") {
      return { ok: false, error: "Notification permission denied." };
    }
    const vapid = await fetch("/api/push/vapid").then((r) => r.json());
    if (!vapid.publicKey) return { ok: false, error: vapid.error || "No VAPID key from Mac" };

    let sub = await reg.pushManager.getSubscription();
    if (!sub) {
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(vapid.publicKey) as BufferSource,
      });
    }
    const resp = await fetch("/api/push/subscribe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(sub.toJSON()),
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) return { ok: false, error: data.error || "Subscribe failed" };
    localStorage.setItem("grok-desk-push", "1");
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function disablePush(): Promise<{ ok: boolean; error?: string }> {
  try {
    if ("serviceWorker" in navigator) {
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      if (sub) {
        const endpoint = sub.endpoint;
        await sub.unsubscribe().catch(() => {});
        await fetch("/api/push/unsubscribe", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ endpoint }),
        }).catch(() => {});
      }
    }
    localStorage.setItem("grok-desk-push", "0");
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
