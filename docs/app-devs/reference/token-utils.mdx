---
sidebar_position: 7
title: Token Utilities
---

# Token Utilities

The MentraOS SDK provides utility functions for creating and validating JWT tokens used for App authentication. These utilities are primarily used for implementing secure authentication mechanisms, especially for webviews.

## TokenUtils Namespace

```typescript
import { TokenUtils } from '@mentra/sdk';
```

### createToken()

Creates a signed JWT token for App authentication.

```typescript
function createToken(
  payload: Omit<AppTokenPayload, 'iat' | 'exp'>,
  config: TokenConfig
): string
```

**Parameters:**
- `payload`: The data to include in the token payload (excluding auto-generated fields)
- `config`: [Configuration](/reference/token-utils#tokenconfig) containing the secret key and optional expiration

**Returns:** The signed JWT token string

**Example:**
```typescript
const token = TokenUtils.createToken(
  {
    userId: 'user123',
    packageName: 'org.company.myapp',
    sessionId: 'session456'
  },
  {
    secretKey: 'my-app-secret-key', // Should match your secret key in MentraOS Cloud
    expiresIn: 3600 // 1 hour in seconds
  }
);
```

### validateToken()

Validates a JWT token using the provided secret key.

```typescript
function validateToken(
  token: string,
  secretKey: string
): TokenValidationResult
```

**Parameters:**
- `token`: The JWT token string to validate
- `secretKey`: The secret key used to sign the token

**Returns:** A [`TokenValidationResult`](#tokenvalidationresult) object with validation status and either the payload or error message

**Example:**
```typescript
const validationResult = TokenUtils.validateToken(
  receivedToken,
  'my-app-secret-key'
);

if (validationResult.valid) {
  console.log('Valid token for user:', validationResult.payload.userId);
} else {
  console.error('Token validation failed:', validationResult.error);
}
```

### generateWebviewUrl()

Appends a JWT token as a query parameter to a base URL, making it easy to create authenticated webview URLs.

```typescript
function generateWebviewUrl(
  baseUrl: string,
  token: string
): string
```

**Parameters:**
- `baseUrl`: The base URL for the webview
- `token`: The JWT token string

**Returns:** The full URL including the token parameter

**Example:**
```typescript
const webviewUrl = TokenUtils.generateWebviewUrl(
  'https://my-app.example.com/webview',
  token
);
// Result: https://my-app.example.com/webview?token=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
```

### extractTokenFromUrl()

Extracts the JWT token from the 'token' query parameter of a URL.

```typescript
function extractTokenFromUrl(
  url: string
): string | null
```

**Parameters:**
- `url`: The URL string potentially containing the token

**Returns:** The extracted token string, or null if not found or the URL is invalid

**Example:**
```typescript
// In a webview handling incoming requests
const incomingUrl = "https://my-app.example.com/webview?token=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...";
const token = TokenUtils.extractTokenFromUrl(incomingUrl);
if (token) {
  // Validate the token and process the webview request
}
```

## Token-Related Interfaces

### AppTokenPayload

The data structure embedded within a App JWT token.

```typescript
interface AppTokenPayload {
  userId: string;        // User identifier
  packageName: string;   // Package name of the App
  sessionId: string;     // Session identifier
  iat?: number;          // Issued At timestamp (added automatically)
  exp?: number;          // Expiration timestamp (added automatically)
}
```

### TokenValidationResult

The result returned by the [`validateToken`](#validatetoken) utility function.

```typescript
interface TokenValidationResult {
  valid: boolean;          // Indicates if the token is valid
  payload?: AppTokenPayload; // The decoded payload if valid
  error?: string;          // Error message if invalid
}
```

### TokenConfig

Configuration options for creating a App token using [`createToken`](#createtoken).

```typescript
interface TokenConfig {
  secretKey: string;     // Secret key for signing and verifying
  expiresIn?: number;    // Token lifetime in seconds (default: 1 day)
}
```

## Token Usage in AppServer

The [`AppServer`](/reference/app-server) class includes a protected method for generating tokens:

```typescript
protected generateToken(
  userId: string,
  sessionId: string,
  secretKey: string
): string
```

This method is available when you extend the [`AppServer`](/reference/app-server) class and is useful for generating tokens within webhook handlers.

## Common Token Usage Patterns

### Creating a Secure Webview

```typescript
class MyAppServer extends AppServer {
  private secretKey = process.env.APP_SECRET_KEY;

  protected async onSession(session, sessionId, userId) {
    // Set up event handlers, etc.

    // Register a route for handling webview requests
    const app = this.getExpressApp();
    app.get('/webview', (req, res) => {
      // Generate a token for this session
      const token = this.generateToken(userId, sessionId, this.secretKey);

      // Redirect to the actual webview with the token
      const webviewUrl = TokenUtils.generateWebviewUrl(
        'https://my-app.example.com/dashboard',
        token
      );

      res.redirect(webviewUrl);
    });
  }
}
```

### Validating Tokens in a Web Application

```typescript
// In your web application that serves the webview content
app.get('/dashboard', (req, res) => {
  const token = req.query.token;
  if (!token) {
    return res.status(401).send('No authentication token provided');
  }

  const validationResult = TokenUtils.validateToken(
    token,
    process.env.APP_SECRET_KEY
  );

  if (!validationResult.valid) {
    return res.status(401).send('Invalid token');
  }

  // Token is valid, render the dashboard for this user
  const { userId, sessionId, packageName } = validationResult.payload;
  // Continue with rendering the appropriate content...
});
```

## Security Considerations

1. **Secret Key Management**: Never expose your App secret key in client-side code. Always keep it on your server.

2. **Token Expiration**: Set appropriate expiration times for tokens based on your security requirements.

3. **HTTPS**: Always use HTTPS for webviews to prevent token interception.

4. **Validation**: Always validate tokens on your server before granting access to protected resources.

5. **Payload Size**: Keep token payloads minimal to reduce overhead and improve performance.