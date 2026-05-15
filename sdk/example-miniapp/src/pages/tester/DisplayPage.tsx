// Tester page — diagnostic surface, ephemeral by design.
// This is the ONLY place in the example where inline-subscribing to
// `session.*` (or imperative one-shot calls in response to user input)
// is acceptable. User-facing glasses logic must live in
// src/controller/GlassesController.ts.

import {useState} from "react"
import {useNavigate} from "react-router-dom"
import {MiniappHeader, useSession} from "@mentra/miniapp/react"

import {Button} from "../../ui/button"
import {Input} from "../../ui/input"
import {Label} from "../../ui/label"
import {Textarea} from "../../ui/textarea"
import {Shell} from "../Shell"

export default function DisplayPage() {
  const session = useSession()
  const navigate = useNavigate()

  const [wallText, setWallText] = useState("Hello from the SDK tester")
  const [topText, setTopText] = useState("Top row")
  const [bottomText, setBottomText] = useState("Bottom row")
  const [cardTitle, setCardTitle] = useState("Card title")
  const [cardBody, setCardBody] = useState("Card body text goes here.")
  const [log, setLog] = useState<string[]>([])

  const appendLog = (msg: string) =>
    setLog((prev) => [`${new Date().toLocaleTimeString()} — ${msg}`, ...prev].slice(0, 10))

  const handleTextWall = () => {
    session.display.showTextWall(wallText)
    appendLog(`showTextWall(${wallText.length} chars)`)
  }
  const handleDoubleWall = () => {
    session.display.showDoubleTextWall(topText, bottomText)
    appendLog(`showDoubleTextWall()`)
  }
  const handleCard = () => {
    session.display.showReferenceCard(cardTitle, cardBody)
    appendLog(`showReferenceCard()`)
  }
  const handleClear = () => {
    session.display.clearView()
    appendLog(`clearView()`)
  }

  return (
    <Shell>
      <MiniappHeader title="session.display" onBack={() => navigate("/tester")} />

      <div className="flex-1 overflow-y-auto px-4 pb-6">
        <p className="mb-3 text-[13px] text-muted-foreground">
          Each button sends a layout to the glasses. Check your glasses display to verify.
        </p>

        <Section emoji="📄" title="Text Wall">
          <Label htmlFor="wall">Text</Label>
          <Textarea id="wall" rows={2} value={wallText} onChange={(e) => setWallText(e.target.value)} />
          <Button className="mt-2" onClick={handleTextWall}>Show Text Wall</Button>
        </Section>

        <Section emoji="🔼" title="Double Text Wall">
          <Label htmlFor="top">Top</Label>
          <Input id="top" value={topText} onChange={(e) => setTopText(e.target.value)} />
          <Label htmlFor="bot" className="mt-2">Bottom</Label>
          <Input id="bot" value={bottomText} onChange={(e) => setBottomText(e.target.value)} />
          <Button className="mt-2" onClick={handleDoubleWall}>Show Double Text Wall</Button>
        </Section>

        <Section emoji="🏷️" title="Reference Card">
          <Label htmlFor="title">Title</Label>
          <Input id="title" value={cardTitle} onChange={(e) => setCardTitle(e.target.value)} />
          <Label htmlFor="body" className="mt-2">Body</Label>
          <Textarea id="body" rows={2} value={cardBody} onChange={(e) => setCardBody(e.target.value)} />
          <Button className="mt-2" onClick={handleCard}>Show Reference Card</Button>
        </Section>

        <Section emoji="🧹" title="Clear">
          <Button variant="destructive" onClick={handleClear}>Clear Glasses Display</Button>
        </Section>

        <div className="rounded-xl border border-border bg-card p-4">
          <div className="mb-2 text-[12px] font-semibold uppercase tracking-wider text-muted-foreground">
            Log
          </div>
          {log.length === 0 ? (
            <p className="text-sm text-muted-foreground">No activity yet.</p>
          ) : (
            log.map((entry, i) => (
              <div key={i} className="font-mono text-[11px] text-foreground/80">{entry}</div>
            ))
          )}
        </div>
      </div>
    </Shell>
  )
}

function Section({emoji, title, children}: {emoji: string; title: string; children: React.ReactNode}) {
  return (
    <div className="mb-4 rounded-xl border border-border bg-card p-4">
      <div className="mb-2 flex items-center gap-2">
        <span className="text-lg">{emoji}</span>
        <span className="font-semibold">{title}</span>
      </div>
      <div className="flex flex-col gap-1">{children}</div>
    </div>
  )
}
