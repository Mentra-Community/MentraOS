export interface AppApiKeyCredentials {
  packageName: string;
  apiKey: string;
}

export interface AppApiKeyCredentialsResult {
  credentials?: AppApiKeyCredentials;
  error?: string;
}

/**
 * Resolve SDK credentials from the Authorization header.
 *
 * Supports both the current format:
 *   Bearer <packageName>:<apiKey>
 *
 * And the legacy SDK format used by older published clients:
 *   Bearer <apiKey>
 * with packageName supplied in the request body.
 */
export function resolveAppApiKeyCredentials(
  authHeader: string | undefined,
  fallbackPackageName?: string,
): AppApiKeyCredentialsResult {
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return { error: "Missing or invalid Authorization header" };
  }

  const token = authHeader.substring(7).trim();
  if (!token) {
    return { error: "Invalid credentials" };
  }

  const parts = token.split(":");

  if (parts.length === 1) {
    if (!fallbackPackageName) {
      return { error: "Invalid token format" };
    }

    return {
      credentials: {
        packageName: fallbackPackageName,
        apiKey: token,
      },
    };
  }

  if (parts.length !== 2) {
    return { error: "Invalid token format" };
  }

  const [packageName, apiKey] = parts;

  if (!packageName || !apiKey) {
    return { error: "Invalid credentials" };
  }

  if (fallbackPackageName && fallbackPackageName !== packageName) {
    return { error: "Invalid credentials" };
  }

  return {
    credentials: {
      packageName,
      apiKey,
    },
  };
}
