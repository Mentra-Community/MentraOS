// Tester page — diagnostic surface, ephemeral by design.
// This is the ONLY place in the example where inline-subscribing to
// `session.*` (or imperative one-shot calls in response to user input)
// is acceptable. User-facing glasses logic must live in
// src/controller/GlassesController.ts.

import {useNavigate} from "react-router-dom"
import {MiniappHeader} from "@mentra/miniapp/react"

import {Button} from "../../ui/button"
import {Shell} from "../Shell"

const ITEMS: Array<{emoji: string; title: string; subtitle: string}> = [
  {emoji: "📸", title: "Camera — takePhoto()", subtitle: "V2: photos route via cloud upload (OS-1301)."},
  {emoji: "🎬", title: "Streaming — startUnmanaged/startManaged", subtitle: "V2: RTMP/HLS streaming (OS-1302, OS-1303)."},
  {emoji: "📊", title: "Dashboard — updateContent()", subtitle: "Deferred in V1 per the local miniapp plan."},
]

export default function ComingSoonPage() {
  const navigate = useNavigate()
  return (
    <Shell>
      <MiniappHeader title="Coming Soon" onBack={() => navigate("/tester")} />

      <div className="flex-1 overflow-y-auto px-4 pb-6">
        <p className="mb-3 text-[13px] text-muted-foreground">
          These SDK methods are declared but not yet wired end-to-end. They won't fail loudly — they're just no-ops today.
        </p>

        <div className="flex flex-col gap-2">
          {ITEMS.map((item) => (
            <div
              key={item.title}
              className="flex items-center gap-3 rounded-xl border border-border bg-muted/30 px-4 py-3 opacity-60">
              <div className="text-2xl">{item.emoji}</div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="font-semibold">{item.title}</span>
                  <span className="rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-[1px] text-[10px] font-medium uppercase tracking-wider text-amber-500">
                    soon
                  </span>
                </div>
                <div className="truncate text-[12px] text-muted-foreground">{item.subtitle}</div>
              </div>
              <Button variant="outline" size="sm" disabled>
                Try
              </Button>
            </div>
          ))}
        </div>
      </div>
    </Shell>
  )
}
