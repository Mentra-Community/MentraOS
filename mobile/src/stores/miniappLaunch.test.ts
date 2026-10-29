import {useMiniappPresentationStore} from "./miniappLaunch"

it("replaces only the named miniapp surface", () => {
  const store = useMiniappPresentationStore
  store.setState({replacementGenerations: {}, revealedPackageName: "com.mentra.notes"})
  store.getState().replaceSurface("com.mentra.notes")
  const notesGeneration = store.getState().replacementGenerations["com.mentra.notes"]
  store.getState().replaceSurface("com.mentra.captions")
  expect(store.getState().replacementGenerations["com.mentra.notes"]).toBe(notesGeneration)
  expect(store.getState().revealedPackageName).toBe("com.mentra.notes")
  store.getState().replaceSurface("com.mentra.notes")
  expect(store.getState().replacementGenerations["com.mentra.notes"]).toBe(notesGeneration + 1)
  expect(store.getState().replacementGenerations["com.mentra.captions"]).toBe(1)
})
