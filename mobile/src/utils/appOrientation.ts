/** Let the device sensor choose portrait or landscape on opted-in tablets.
 * The shortest edge is rotation invariant, so rotating cannot flip this policy.
 */
export function appOrientation(
  platform: string,
  enabled: boolean,
  width: number,
  height: number,
): "all" | "portrait" {
  return platform === "android" && enabled && Math.min(width, height) >= 600
    ? "all"
    : "portrait"
}
