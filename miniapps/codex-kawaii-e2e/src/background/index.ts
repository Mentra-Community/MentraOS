import {registerMiniapp} from "@mentra/miniapp/background"

const FACES = ["づ(^_^)づ", "ᕕ(^_^)ᕗ", "ᕙ(^_^)ᕗ", "٩(^‿^)۶", "\\(^o^)/", "b(^_^)d"]

registerMiniapp((session) => {
  console.log(`[kawaii] session started for ${session.packageName}`)
  let index = 0

  const ui = session.ui as unknown as {
    on: (channel: "kawaii:set-face", cb: (payload: {face: string}) => void) => () => void
    send: (channel: "kawaii:face", payload: {face: string}) => void
    onOpen: (cb: () => void) => () => void
  }

  const showFace = (face: string) => {
    index = Math.max(0, FACES.indexOf(face))
    console.log(`[kawaii] showing face ${index + 1}/${FACES.length}: ${FACES[index]}`)
    // Full-canvas text element with a stable id — each face updates in place.
    const d = session.capabilities?.display
    void session.display.render([
      {type: "text", id: "face", box: {x: 0, y: 0, w: d?.width ?? 576, h: d?.height ?? 288}, text: face},
    ])
    ui.send("kawaii:face", {face})
  }

  const advanceFace = (source: string) => {
    index = (index + 1) % FACES.length
    console.log(`[kawaii] ${source} advanced to face ${index + 1}/${FACES.length}`)
    showFace(FACES[index])
  }

  showFace(FACES[index])

  ui.on("kawaii:set-face", ({face}) => {
    showFace(face)
  })

  ui.onOpen(() => {
    ui.send("kawaii:face", {face: FACES[index]})
  })

  session.input.onButtonPress(() => {
    advanceFace("button press")
  })

  session.input.onTouch((data) => {
    advanceFace(`touch ${data.kind}`)
  })
})
