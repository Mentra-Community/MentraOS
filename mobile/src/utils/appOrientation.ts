/** Let the device sensor choose portrait or landscape on large screens.
 * The shortest edge is rotation invariant, so rotating cannot flip this policy.
 */
export function appOrientation(
  platform: string,
  width: number,
  height: number,
): "all" | "portrait" {
  return (platform === "android" || platform === "ios") && Math.min(width, height) >= 600
    ? "all"
    : "portrait"
}
