/**
 * @fileoverview Express type extensions for custom request properties.
 *
 * This file centralizes all Express Request type augmentations to avoid
 * scattered declarations and ensure TypeScript picks them up correctly.
 *
 * Properties added by middleware:
 * - req.console - Added by console.middleware.ts
 * - req.sdk - Added by sdk.middleware.ts
 * - req.cli - Added by cli.middleware.ts
 * - req.email - Added by client.middleware.ts
 * - req.user - Added by client.middleware.ts
 * - req.userSession - Added by client.middleware.ts
 */

import type { User } from "../models/user.model";
import type UserSession from "../services/session/UserSession";

declare global {
  namespace Express {
    interface Request {
      /**
       * Console authentication data, set by console.middleware.ts
       */
      console?: {
        email: string;
      };

      /**
       * SDK authentication data, set by sdk.middleware.ts
       */
      sdk?: {
        packageName: string;
        apiKey: string;
      };

      /**
       * CLI authentication data, set by cli.middleware.ts
       */
      cli?: {
        email: string;
        keyId: string;
        keyName: string;
        type: "cli";
      };

      /**
       * User email from JWT, set by client.middleware.ts
       */
      email?: string;

      /**
       * User document from database, set by client.middleware.ts
       */
      user?: User;

      /**
       * Active user session, set by client.middleware.ts
       */
      userSession?: UserSession;
    }
  }
}

// Needed to make this a module
export {};
