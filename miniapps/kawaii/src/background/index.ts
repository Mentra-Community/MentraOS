import {registerMiniapp} from "@mentra/miniapp/background"

const FACES = [
  "(づ｡◕‿‿◕｡)づ",
  "(ﾉ◕ヮ◕)ﾉ*:･ﾟ✧",
  "ʕっ•ᴥ•ʔっ",
  "(´｡• ᵕ •｡`)",
  "(≧◡≦)",
  "٩(◕‿◕｡)۶",
]

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
    session.display.showTextWall(face)
    ui.send("kawaii:face", {face})
  }

  showFace(FACES[index])

  ui.on("kawaii:set-face", ({face}) => {
    showFace(face)
  })

  ui.onOpen(() => {
    ui.send("kawaii:face", {face: FACES[index]})
  })

  session.input.onButtonPress(() => {
    index = (index + 1) % FACES.length
    showFace(FACES[index])
  })
})
