import type { Request, Response, NextFunction } from 'express';
import { logger } from '@augmentos/utils';
// Using App model from the cloud package instead of local model
import App, { type AppI } from '@augmentos/cloud/src/models/app.model';
import appService from '@augmentos/cloud/src/services/core/app.service';


export const validateTpaApiKey = async (req: Request, res: Response, next: NextFunction) => {

  const authHeader = req.headers.authorization;
  const packageName = req.body.packageName || req.query.packageName || req.params.packageName; // Try to get packageName if available

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    logger.warn('TPA API Key Middleware: Missing or invalid Authorization header');
    res.status(401).json({ error: 'Missing or invalid Authorization header' });
    return;
  }

  const apiKey = authHeader.substring(7); // Remove 'Bearer ' prefix

  if (!apiKey) {
    logger.warn('TPA API Key Middleware: Empty API key');
    res.status(401).json({ error: 'API Key required' });
    return;
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
      logger.warn('TPA API Key Middleware: Package name not provided for API key validation.');
      res.status(400).json({ error: 'Package name required for API key validation' });
      return;
    }


    if (!app) {
      logger.warn(`TPA API Key Middleware: App not found for package name: ${packageName}`);
      res.status(401).json({ error: 'Invalid API Key or Package Name' });
      return;
    }
    console.log('app', appService);
/*
    // Validate the provided API key against the stored hash
    const isValid = await appService.validateApiKey(app.packageName, apiKey, req.ip);

    if (!isValid) {
      logger.warn(`TPA API Key Middleware: Invalid API Key for package ${app.packageName}`);
      res.status(401).json({ error: 'Invalid API Key' });
      return;
    }

    // Attach the validated app object to the request
    (req as any).app = app;
    logger.info(`TPA API Key Middleware: Authenticated TPA ${app.packageName}`);
    next();
    */

  } catch (error) {
    logger.error('TPA API Key Middleware Error:', error);
    res.status(500).json({ error: 'Internal server error during API key validation' });
    return;
  }
};