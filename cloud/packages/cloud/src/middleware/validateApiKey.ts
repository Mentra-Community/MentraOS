import { Request, Response, NextFunction } from "express";
import { logger } from "../services/logging/pino-logger";
import appService from "../services/core/app.service";
import App, { AppI } from "../models/app.model";

export const validateAppApiKey = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  const authHeader = req.headers.authorization;
  const packageName =
    req.body.packageName || req.query.packageName || req.params.packageName; // Try to get packageName if available

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    logger.warn(
      "App API Key Middleware: Missing or invalid Authorization header",
    );
    return res
      .status(401)
      .json({ error: "Missing or invalid Authorization header" });
  }

  const apiKey = authHeader.substring(7); // Remove 'Bearer ' prefix

  if (!apiKey) {
    logger.warn("App API Key Middleware: Empty API key");
    return res.status(401).json({ error: "API Key required" });
  }

  try {
    // Find the app associated with the API key
    // Note: This requires a way to look up the app by API key hash.
    // If you don't store the hash directly, you might need to iterate or adjust the schema.
    // For now, let's assume we can find the app by package name if provided,
    // otherwise this validation needs adjustment based on how API keys are managed.

    let app: AppI | null = null;
    if (packageName) {
      app = await App.findOne({ packageName: packageName }).lean();
    } else {
      // If packageName isn't provided, you might need a different lookup strategy
      // or require packageName in the request body/query for this middleware.
      // For now, we'll assume packageName is available somehow.
      // A more robust approach might involve looking up the API key hash directly.
      logger.warn(
        "App API Key Middleware: Package name not provided for API key validation.",
      );
      return res
        .status(400)
        .json({ error: "Package name required for API key validation" });
    }

    if (!app) {
      logger.warn(
        `App API Key Middleware: App not found for package name: ${packageName}`,
      );
      return res.status(401).json({ error: "Invalid API Key or Package Name" });
    }

    // Validate the provided API key against the stored hash
    const isValid = await appService.validateApiKey(app.packageName, apiKey);

    if (!isValid) {
      logger.warn(
        `App API Key Middleware: Invalid API Key for package ${app.packageName}`,
      );
      return res.status(401).json({ error: "Invalid API Key" });
    }

    // Attach the validated app object to the request
    (req as any).app = app;
    logger.info(`App API Key Middleware: Authenticated App ${app.packageName}`);
    next();
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    logger.error(err, "App API Key Middleware Error:");
    return res
      .status(500)
      .json({ error: "Internal server error during API key validation" });
  }
};

export const hashWithApiKey = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  const packageName =
    req.body.packageName || req.query.packageName || req.params.packageName; // Try to get packageName if available
  const stringToHash = req.body.stringToHash;

  if (!stringToHash) {
    logger.warn("Hash With API Key Middleware: No string to hash provided");
    return res.status(400).json({ error: "String to hash is required" });
  }

  try {
    // Find the app associated with the API key
    // Note: This requires a way to look up the app by API key hash.
    // If you don't store the hash directly, you might need to iterate or adjust the schema.
    // For now, let's assume we can find the app by package name if provided,
    // otherwise this validation needs adjustment based on how API keys are managed.

    let app: AppI | null = null;
    if (packageName) {
      app = await App.findOne({ packageName: packageName }).lean();
    } else {
      // If packageName isn't provided, you might need a different lookup strategy
      // or require packageName in the request body/query for this middleware.
      // For now, we'll assume packageName is available somehow.
      // A more robust approach might involve looking up the API key hash directly.
      logger.warn(
        "App API Key Middleware: Package name not provided for API key hashing.",
      );
      return res
        .status(400)
        .json({ error: "Package name required for API key hashing" });
    }

    if (!app) {
      logger.warn(
        `App API Key Middleware: App not found for package name: ${packageName}`,
      );
      return res.status(401).json({ error: "Invalid API Key or Package Name" });
    }

    // Generate the hash and add it to the request
    const hash = await appService.hashWithApiKey(stringToHash, packageName);
    (req as any).generatedHash = hash;

    // Attach the validated app object to the request
    (req as any).app = app;
    logger.info(
      `App API Key Middleware: Generated hash for ${app.packageName}`,
    );
    next();
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    logger.error(err, "App API Key Middleware Error:");
    return res
      .status(500)
      .json({ error: "Internal server error during API key hashing" });
  }
};
