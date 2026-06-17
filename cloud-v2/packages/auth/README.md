# @mentra/auth

Helpers for miniapp backends that need to verify Local Runtime auto-auth tokens.

```ts
import {createMiniappAuthVerifier, MiniappAuthError} from "@mentra/auth";

const auth = createMiniappAuthVerifier({
  packageName: "com.example.miniapp",
  coreUrl: process.env.MENTRA_CORE_URL,
});

app.post("/api/endpoint", async (c) => {
  try {
    const session = await auth.verifyAuthHeader(c.req.header("Authorization"));
    return c.json({userId: session.mentraUserId});
  } catch (error) {
    if (error instanceof MiniappAuthError) {
      return c.json({error: error.message}, 401);
    }
    throw error;
  }
});
```

Defaults:

- `packageName`: required, or set `MENTRA_PACKAGE_NAME`, `MINIAPP_PACKAGE_NAME`, or `PACKAGE_NAME`.
- `coreUrl`: `MENTRA_CORE_URL`, falling back to `http://localhost:3000`.
- `jwksUrl`: `MENTRA_JWKS_URL`, falling back to `<coreUrl>/.well-known/jwks.json`.
- `issuer`: `MENTRA_MINIAPP_TOKEN_ISSUER`, falling back to `mentra`.
