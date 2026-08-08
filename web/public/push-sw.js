/* Push handlers for Grok Desk PWA (loaded via workbox importScripts). */
self.addEventListener("push", (event) => {
  let data = { title: "Grok Desk", body: "", tag: "grok-desk", url: "/" };
  try {
    if (event.data) {
      const parsed = event.data.json();
      data = { ...data, ...parsed };
    }
  } catch {
    try {
      const t = event.data && event.data.text();
      if (t) data.body = t;
    } catch {
      /* */
    }
  }
  event.waitUntil(
    self.registration.showNotification(data.title || "Grok Desk", {
      body: data.body || "",
      icon: "/icon-256.png",
      badge: "/icon-256.png",
      tag: data.tag || "grok-desk",
      data: { url: data.url || "/" },
      renotify: true,
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || "/";
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
      for (const client of list) {
        if ("focus" in client) {
          try {
            if (client.url && "navigate" in client) client.navigate(url);
          } catch {
            /* */
          }
          return client.focus();
        }
      }
      if (self.clients.openWindow) return self.clients.openWindow(url);
    }),
  );
});
