// REGRESSION MATRIX A1 (reverted in the next commit).
// Default/Android resolution: valid. The .ios.ts sibling imports a package
// that does not exist, so only the iOS Metro bundle can fail. tsc resolves
// this file, not the platform variant.
export const regressionMatrixA1 = "android-or-default"
