/**
 * The workspace this phone's person belongs to, as the Mentra App last heard it from Core. The Fleet sheets
 * fill it at startup and on foreground; Settings reads it for the Workspace row and refreshes it on focus.
 * Null means "in no workspace", or "not heard yet" (`loaded` tells them apart).
 */
import {create} from "zustand"

import {getWorkspaceApi, type MyWorkspace} from "./workspaceApi"

interface MyWorkspaceState {
  workspace: MyWorkspace | null
  loaded: boolean
  set: (workspace: MyWorkspace | null) => void
  reset: () => void
}

export const useMyWorkspaceStore = create<MyWorkspaceState>((set) => ({
  workspace: null,
  loaded: false,
  set: (workspace) => set({workspace, loaded: true}),
  reset: () => set({workspace: null, loaded: false}),
}))

/**
 * Asks Core for the person's workspace and stores the answer. A failed call keeps what was last heard: not
 * hearing from Core is never "no workspace". Resolves to the stored workspace.
 */
export async function refreshMyWorkspace(): Promise<MyWorkspace | null> {
  try {
    const workspace = await getWorkspaceApi().mine()
    useMyWorkspaceStore.getState().set(workspace)
    return workspace
  } catch (error) {
    console.warn("Fleet: could not read the workspace", error)
    return useMyWorkspaceStore.getState().workspace
  }
}
