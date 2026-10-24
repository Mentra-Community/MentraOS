/**
 * The domain rule: a package name may only come from a domain that owns it, its reversed registrable domain plus at
 * least one more part, and `com.mentra.*` only from mentraglass.com. Core applies the same rule, from the same
 * implementation in `@mentra/cloud-protocol`.
 */
export {isPackageNameAllowedForUrl} from "@mentra/cloud-protocol/miniapp-url"
