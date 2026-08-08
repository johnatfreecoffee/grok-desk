import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: "autoUpdate",
      includeAssets: ["icon.svg", "icon-256.png", "icon-512.png"],
      manifest: {
        name: "Grok Desk",
        short_name: "GrokDesk",
        description: "Grok chat on your Mac — phone PWA via Tailscale",
        theme_color: "#0b1220",
        background_color: "#0b1220",
        display: "standalone",
        start_url: "/",
        scope: "/",
        icons: [
          {
            src: "/icon.svg",
            sizes: "any",
            type: "image/svg+xml",
            purpose: "any maskable",
          },
          {
            src: "/icon-256.png",
            sizes: "256x256",
            type: "image/png",
          },
          {
            src: "/icon-512.png",
            sizes: "512x512",
            type: "image/png",
            purpose: "any maskable",
          },
        ],
      },
      workbox: {
        // Never cache API/WS — local daemon only
        navigateFallback: "/index.html",
        runtimeCaching: [],
        // Phone push handlers (public/push-sw.js → dist)
        importScripts: ["push-sw.js"],
      },
    }),
  ],
  server: {
    port: 5177,
    proxy: {
      "/api": "http://127.0.0.1:8787",
      "/ws": { target: "ws://127.0.0.1:8787", ws: true },
    },
  },
});
