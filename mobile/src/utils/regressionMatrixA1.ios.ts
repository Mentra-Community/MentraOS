// REGRESSION MATRIX A1 (reverted in the next commit).
// iOS-only resolution failure: this package does not exist. The directive
// keeps tsc green so that only Metro's iOS resolution can catch it.
// @ts-expect-error -- deliberately unresolvable module for the regression matrix
import {nothing} from "regression-matrix-a1-nonexistent-package"

export const regressionMatrixA1 = String(nothing)
