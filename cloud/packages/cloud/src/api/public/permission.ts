// Public permissions API - allows SDK to check app permissions without authentication
// This endpoint is used by the SDK permission validation utilities to verify required permissions
import { Router, Request } from 'express';
import App from '../../models/app.model';

const router = Router();

// Get app permissions by package name - no authentication required
router.get('/:packageName', async (req: Request, res) => {
  try {
    const { packageName } = req.params;

    // Query database for app by package name
    const app = await App.findOne({ packageName });

    // Return 404 if app doesn't exist
    if (!app) {
      return res.status(404).json({ error: "App not found" });
    }

    // Return app permissions list
    return res.json({
      success: true,
      packageName,
      permissions: app.permissions || []
    });

  } catch (error) {
    // Handle any unexpected errors
    return res.status(500).json({ error: "Internal server error" });
  }
});

export default router;



