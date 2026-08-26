/** Combine registry-enforced visibility with the user's home-screen choice. */
export const resolveHiddenStatus = (registryHidden: boolean, userHidden: boolean): boolean =>
  registryHidden || userHidden
