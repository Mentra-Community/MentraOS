/**
 * RawMapPage — dev-only full-screen viewer that renders a bare
 * `google.maps.Map` inside an iframe (WebView → React → iframe → map).
 * The iframe has its own document, its own head, and no exposure to
 * the surrounding React tree or Tailwind globals — useful for ruling
 * out interference from our own code while debugging gesture bugs.
 *
 * The API key is read from the same build-time env var the parent
 * uses, injected into the inline HTML.
 */

import {useEffect, useRef, useState} from "react"

import {getGoogleMaps} from "@/ui/lib/googleMaps"

function buildIframeHtml(apiKey: string): string {
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1,user-scalable=no" />
    <style>
      html, body, #map { margin: 0; padding: 0; height: 100%; width: 100%; }
    </style>
  </head>
  <body>
    <div id="map"></div>
    <script>
      function initMap() {
        new google.maps.Map(document.getElementById("map"), {
          zoom: 15,
          center: {lat: 37.7956, lng: -122.3933},
        });
      }
    </script>
    <script async defer
      src="https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(apiKey)}&callback=initMap"></script>
  </body>
</html>`
}

export function RawMapPage({onClose}: {onClose: () => void}) {
  const [srcDoc, setSrcDoc] = useState<string | null>(null)
  const iframeRef = useRef<HTMLIFrameElement | null>(null)

  useEffect(() => {
    // Reuse the parent's GoogleMapsManager only to grab the resolved
    // API key — we don't want the parent's loaded SDK leaking into the
    // iframe's window. Each iframe loads its own copy.
    getGoogleMaps()
      .whenReady()
      .then(() => {
        const key = getGoogleMaps().apiKey
        setSrcDoc(buildIframeHtml(key))
      })
      .catch(() => setSrcDoc(buildIframeHtml("")))
  }, [])

  return (
    <div className="fixed inset-0 z-60 bg-white">
      {srcDoc ? (
        <iframe
          ref={iframeRef}
          srcDoc={srcDoc}
          title="Raw Google Map"
          className="absolute inset-0 w-full h-full border-0"
        />
      ) : (
        <div className="absolute inset-0 flex items-center justify-center text-neutral-500 text-[13px]">
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
