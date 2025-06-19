# Webview Authentication

AugmentOS provides a simple and secure way for apps to identify users within webviews. When a user opens your web application through the AugmentOS manager app, you can automatically identify them without requiring a separate login process.

```typescript
// Example of using webview authentication in your app
import { TpaServer, AuthenticatedRequest } from '@augmentos/sdk';

const server = new TpaServer({
  packageName: 'org.example.myapp',
  apiKey: process.env.API_KEY // Load from environment variables
});

const app = server.getExpressApp();

app.get('/webview', (req: AuthenticatedRequest, res) => {
  const userId = req.authUserId;

  if (userId) {
    // User is authenticated, show personalized content
    res.send(`Welcome user ${userId}!`);
  } else {
    // User is not authenticated
    res.send('Please open this page from the AugmentOS app');
  }
});
```

## What Is Webview Authentication?

Webview authentication lets your web application identify AugmentOS users without requiring them to log in separately. When a user opens your webview through the AugmentOS manager app:

1. The manager app automatically appends a temporary authentication token to your URL
2. The AugmentOS SDK middleware automatically exchanges this token for the user's ID
3. Your webview can then provide a personalized experience based on the user's identity

## How It Works

### 1. Include a Webview in Your App

First, specify a webview URL in your app's configuration through the AugmentOS Developer Console:

1. Log in to the [AugmentOS Developer Console](https://console.augmentos.org/tpas/)
2. Navigate to your app's settings
3. Add your `Webview URL`
4. Save your changes

### 2. Set Up Authentication with the SDK

The AugmentOS SDK provides built-in middleware that handles the token exchange process automatically:

```typescript
import { TpaServer, AuthenticatedRequest } from '@augmentos/sdk';

// Create an app server instance
const server = new TpaServer({
  packageName: 'org.example.myapp',
  apiKey: process.env.API_KEY // Load from environment variables, never check it into source control
});

// The SDK automatically sets up the authentication middleware
```

### 3. Access User ID in Your Routes

In your Express route handlers, access the authenticated user ID:

```typescript
const app = server.getExpressApp();

app.get('/webview', (req: AuthenticatedRequest, res) => {
  // Access the authenticated user ID
  const userId = req.authUserId;

  if (userId) {
    // User is authenticated, provide personalized content
    res.render('dashboard', {
      userId
    });
  } else {
    // User is not authenticated
    res.render('login', {
      message: 'Please open this page from the AugmentOS app'
    });
  }
});
```

## Common Use Cases

Webview authentication enables:

- Personalized dashboards and content
- User-specific settings and preferences
- Integration with your existing user database
- Seamless experiences without additional login steps

## React Webviews

If you want to build your frontend webview using React, see the [React Webviews](/react-webviews) guide.


