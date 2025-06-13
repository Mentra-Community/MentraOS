# AugmentOS React Auth Library (`augmentos-react`)

This library simplifies authentication for React-based webviews running within the AugmentOS manager application. It handles the extraction and verification of the `aos_signed_user_token` provided by the AugmentOS system and makes user information available through a React Context and Hook.

## Features

-   Extracts `aos_signed_user_token` from URL query parameters.
-   Verifies the token using `jsrsasign` against the AugmentOS Cloud public key.
-   Extracts `userId` and `frontendToken` from the token payload.
-   Stores `userId` and `frontendToken` in `localStorage` for persistence during the session.
-   Provides an `AugmentosAuthProvider` and `useAugmentosAuth` hook for easy integration.
-   Manages loading and error states.

## Prerequisites

-   React 16.8+
-   Your webview must be opened by the AugmentOS manager application, which will append the `aos_signed_user_token` to the URL.

## Installation

```bash
bun add @augmentos/react
# or
npm install @augmentos/react
# or
yarn add @augmentos/react
```

## Usage

### 1. Wrap your application with `AugmentosAuthProvider`

In your main application file (e.g., `src/main.tsx` or `src/index.tsx`):

```tsx
// src/main.tsx
import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { AugmentosAuthProvider } from 'augmentos-react';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <AugmentosAuthProvider>
      <App />
    </AugmentosAuthProvider>
  </React.StrictMode>
);
```

### 2. Access authentication state using `useAugmentosAuth`

In any component that needs user information:

```tsx
// src/MyComponent.tsx
import React from 'react';
import { useAugmentosAuth } from 'augmentos-react';

const MyComponent = () => {
  const { userId, frontendToken, isLoading, error, isAuthenticated, logout } = useAugmentosAuth();

  if (isLoading) {
    return <p>Loading authentication...</p>;
  }

  if (error) {
    return (
      <div>
        <p>Authentication Error: {error}</p>
        <p>Please ensure you are opening this page from the AugmentOS app.</p>
      </div>
    );
  }

  if (!isAuthenticated || !userId) {
    return <p>Not authenticated. Please open from the AugmentOS manager app.</p>;
  }

  // You are authenticated!
  return (
    <div>
      <h1>Welcome, AugmentOS User!</h1>
      <p>User ID: {userId}</p>
      {/* frontendToken is a JWT. Displaying it directly is usually for debugging. */}
      <p>Your Frontend Token (for backend calls): <small>{frontendToken ? frontendToken.substring(0, 20) + '...' : 'N/A'}</small></p>
      <button onClick={logout}>Logout</button>
      {/* Add your webview content here */}
    </div>
  );
};

export default MyComponent;
```

## How It Works

1.  When your webview is loaded by the AugmentOS manager, it appends an `aos_signed_user_token` (a JWT) as a URL query parameter.
2.  The `AugmentosAuthProvider` attempts to find this token.
3.  It verifies the token's signature against the AugmentOS Cloud public key and checks its claims (like issuer and expiration).
4.  If valid, it extracts the `userId` (from the `sub` claim) and a `frontendToken` (another JWT from the payload).
5.  These `userId` and `frontendToken` are then stored in `localStorage` and made available via the `useAugmentosAuth` hook.
6.  If the token is not found in the URL (e.g., on a page refresh within the webview), the provider attempts to load the `userId` and `frontendToken` from `localStorage`.

## Making Authenticated Calls to Your TPA Backend

The `frontendToken` obtained from `useAugmentosAuth` is a JWT. You should send this token in the `Authorization` header as a Bearer token when making requests from your webview to **your TPA's backend API**.  The AugmentOS SDK will automatically verify this token.

```typescript
// Example of an authenticated API call
const { frontendToken } = useAugmentosAuth();

async function fetchDataFromMyBackend(): Promise<void> {
  if (!frontendToken) {
    console.error("No frontend token available for backend call.");
    return;
  }

  try {
    const response = await fetch('https://your-tpa-backend.example.com/api/data', {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${frontendToken}`,
      },
    });

    if (!response.ok) {
      throw new Error(`Backend request failed: ${response.status}`);
    }

    const data = await response.json();
    console.log('Data from backend:', data);
    // Process data
  } catch (error) {
    console.error('Error fetching data from backend:', error);
  }
}
```

> **Note:**
> If your TPA webview is hosted on a different domain or port than your backend API, make sure your backend's CORS (Cross-Origin Resource Sharing) policy allows requests from the webview's origin.
> For example, if your backend is at `https://your-tpa-backend.example.com` and your webview is loaded from `https://some-other-frontend.com`, your backend must explicitly allow cross-origin requests from `https://some-other-frontend.com` (or use a wildcard for development, but restrict in production).
>
> **Example in the backend:**
> ```typescript
> import cors from 'cors';
>
> // Allow only your webview's origin in production
> app.use(cors({
>   origin: 'https://some-other-frontend.com', // Replace with your actual webview origin
>   credentials: true, // If you use cookies
> }));
> ```
>
> Failing to set the correct CORS policy will result in browser errors when your webview tries to call your backend API.


## TypeScript Support

This library includes full TypeScript support. The `useAugmentosAuth` hook returns a typed object with the following interface:

```typescript
interface AugmentosAuthContextType {
  userId: string | null;
  frontendToken: string | null;
  isLoading: boolean;
  error: string | null;
  isAuthenticated: boolean;
  logout: () => void;
}
```

## Troubleshooting

*   **"Token validation failed" / "Token expired":**
    *   Ensure the clock on the device running the AugmentOS manager is synchronized.
    *   The `gracePeriod` in `authCore.ts` (currently 120 seconds) can be adjusted if clock skew is a persistent issue, but large grace periods reduce security.
    *   The AugmentOS manager app should be providing a fresh token.
*   **"AugmentOS signed user token not found":**
    *   Make sure your webview is being launched from the AugmentOS manager app.
    *   Verify the manager app is correctly appending `?aos_signed_user_token=...` to your webview URL.
*   **`jsrsasign` errors:** Ensure `jsrsasign` is correctly installed and accessible in your frontend build.
*   **Backend Authentication Issues:**
    *   Ensure you're using `Authorization: Bearer ${frontendToken}` header format, not query parameters.
    *   Verify your backend allows CORS requests from the domain of your frontend.
