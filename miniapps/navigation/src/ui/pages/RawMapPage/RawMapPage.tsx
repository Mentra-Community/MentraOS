/**
 * RawMapPage — dev-only full-screen viewer that renders a bare Mapbox GL JS
 * map inside an iframe (WebView → React → iframe → map). The iframe has its
 * own document, its own head, and no exposure to the surrounding React tree
 * or Tailwind globals — useful for ruling out interference from our own
 * code while debugging gesture bugs.
 *
 * The iframe can't reuse the parent's bundled `mapbox-gl` module (separate
 * window), so it loads GL JS from the CDN. The token is read from the same
 * MapboxManager the parent uses, injected into the inline HTML.
 */

import {useEffect, useRef, useState} from "react"
import {useColorScheme} from "@mentra/miniapp/ui"

import {getMapbox} from "@/ui/lib/mapbox"

function buildIframeHtml(token: string, dark: boolean): string {
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1,user-scalable=no" />
    <link href="https://api.mapbox.com/mapbox-gl-js/v3.25.0/mapbox-gl.css" rel="stylesheet" />
    <style>
      html, body, #map { margin: 0; padding: 0; height: 100%; width: 100%; }
    </style>
  </head>
  <body>
    <div id="map"></div>
    <script src="https://api.mapbox.com/mapbox-gl-js/v3.25.0/mapbox-gl.js"></script>
    <script>
      mapboxgl.accessToken = ${JSON.stringify(token)};
      new mapboxgl.Map({
        container: "map",
        style: ${JSON.stringify(dark ? "mapbox://styles/mapbox/dark-v11" : "mapbox://styles/mapbox/streets-v12")},
        center: [-122.3933, 37.7956],
        zoom: 15,
      });
    </script>
  </body>
</html>`
}

export function RawMapPage({onClose}: {onClose: () => void}) {
  const [srcDoc, setSrcDoc] = useState<string | null>(null)
  const iframeRef = useRef<HTMLIFrameElement | null>(null)
  // The iframe has its own document, so the parent's .dark class can't style
  // it — bake the scheme-appropriate basemap into the generated HTML instead.
  const dark = useColorScheme() === "dark"

  useEffect(() => {
    // Reuse the parent's MapboxManager only to grab the resolved token —
    // the iframe loads its own copy of GL JS from the CDN.
    getMapbox()
      .whenReady()
      .then(() => {
        const token = getMapbox().apiKey
        setSrcDoc(buildIframeHtml(token, dark))
      })
      .catch(() => setSrcDoc(buildIframeHtml("", dark)))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div className="fixed inset-0 z-60 bg-white dark:bg-zinc-950">
      {srcDoc ? (
        <iframe
          ref={iframeRef}
          srcDoc={srcDoc}
          title="Raw Mapbox Map"
          className="absolute inset-0 w-full h-full border-0"
        />
      ) : (
        <div className="absolute inset-0 flex items-center justify-center text-neutral-500 dark:text-zinc-400 text-[13px]">
          loading raw map…
        </div>
      )}
      <button
        type="button"
        onClick={onClose}
        className="absolute top-4 right-4 z-10 w-10 h-10 rounded-full bg-white shadow-lg flex items-center justify-center text-neutral-800 text-2xl leading-none"
        aria-label="Close raw map">
        ×
      </button>
    </div>
  )
}
