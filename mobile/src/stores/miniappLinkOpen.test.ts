import {beginMiniappLinkOpen, cancelMiniappLinkOpens, useMiniappLinkOpenStore} from "./miniappLinkOpen"

const view = () => useMiniappLinkOpenStore.getState().view

afterEach(() => cancelMiniappLinkOpens())

it("shows the splash at once, then the miniapp the link names", () => {
  const opening = beginMiniappLinkOpen()
  expect(view()).toEqual({id: expect.any(Number), installing: false})
  opening.show({name: "Notes", iconUrl: "https://notes.example.com/icon.png"})
  expect(view()).toEqual({
    id: expect.any(Number),
    name: "Notes",
    iconUrl: "https://notes.example.com/icon.png",
    installing: true,
  })
  opening.end()
  expect(view()).toBeNull()
})

it("shows a miniapp without an icon by its name alone", () => {
  const opening = beginMiniappLinkOpen()
  opening.show({name: "Notes", iconUrl: null})
  expect(view()).toEqual({id: expect.any(Number), name: "Notes", installing: true})
})

it("keeps one splash up until every link being opened has ended", () => {
  const first = beginMiniappLinkOpen()
  const id = view()?.id
  first.show({name: "Notes", iconUrl: null})
  const second = beginMiniappLinkOpen()
  expect(view()).toEqual({id, name: "Notes", installing: true})
  second.end()
  second.end()
  expect(view()).toEqual({id, name: "Notes", installing: true})
  first.end()
  expect(view()).toBeNull()
})

it("keeps showing the first link's miniapp when a different link names another", () => {
  const first = beginMiniappLinkOpen()
  const second = beginMiniappLinkOpen()
  first.show({name: "Notes", iconUrl: null})
  second.show({name: "Maps", iconUrl: "https://maps.example.com/icon.png"})
  expect(view()).toEqual({id: expect.any(Number), name: "Notes", installing: true})
  // Once the first has opened or stopped, the splash is the second's.
  first.end()
  expect(view()).toEqual({
    id: expect.any(Number),
    name: "Maps",
    iconUrl: "https://maps.example.com/icon.png",
    installing: true,
  })
  second.end()
  expect(view()).toBeNull()
})

it("says a link is still being read when the one whose miniapp it showed has ended", () => {
  const first = beginMiniappLinkOpen()
  beginMiniappLinkOpen()
  first.show({name: "Notes", iconUrl: null})
  first.end()
  expect(view()).toEqual({id: expect.any(Number), installing: false})
})

it("gives the next link its own splash", () => {
  const first = beginMiniappLinkOpen()
  const id = view()?.id
  first.end()
  beginMiniappLinkOpen()
  expect(view()?.id).not.toBe(id)
})

it("cancels every link being opened when the person closes the splash", () => {
  const first = beginMiniappLinkOpen()
  const second = beginMiniappLinkOpen()
  expect(first.cancelled).toBe(false)
  cancelMiniappLinkOpens()
  expect(view()).toBeNull()
  expect(first.cancelled).toBe(true)
  expect(second.cancelled).toBe(true)
  // A cancelled link puts nothing back on screen.
  first.show({name: "Notes", iconUrl: null})
  first.end()
  expect(view()).toBeNull()
  expect(beginMiniappLinkOpen().cancelled).toBe(false)
})
