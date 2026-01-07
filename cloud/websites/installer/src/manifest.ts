export function generateManifest(redirectUrl?: string) {
  const startUrl = redirectUrl ? `/?url=${encodeURIComponent(redirectUrl)}` : "/"

  return {
    name: "MentraOS",
    short_name: "MentraOS",
    description: "MentraOS - Operating system for smart glasses",
    start_url: startUrl,
    display: "standalone",
    background_color: "#0a0a0a",
    theme_color: "#0a0a0a",
    orientation: "portrait",
    icons: [
      {
        src: "/icon-192.png",
        sizes: "192x192",
        type: "image/png",
        purpose: "any",
      },
      {
        src: "/icon-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "any",
      },
      {
        src: "/icon-192-maskable.png",
        sizes: "192x192",
        type: "image/png",
        purpose: "maskable",
      },
      {
        src: "/icon-512-maskable.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable",
      },
    ],
    categories: ["productivity", "utilities"],
    prefer_related_applications: false,
  }
}
