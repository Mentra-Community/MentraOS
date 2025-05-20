// routes/tools.routes.ts
import { Router, Request, Response } from 'express';
import App from '../models/app.model';
import { logger } from '@augmentos/utils';
import { Exception } from '@sentry/node';
import appService from '../services/core/app.service';
import { User } from '../models/user.model';
import { ToolCall } from '@augmentos/sdk';
const router = Router();
/**
 * Trigger a tool webhook to a TPA
 * Used by Mira AI to send tools to TPAs
 */
const triggerTool = async (req: Request, res: Response) => {
  try {
    console.log('🔨 Triggering tool for:', req.params.packageName);
    console.log('🔨 Payload:', req.body);
    const { packageName } = req.params;
    const payload: ToolCall = req.body;
    
    // Validate the payload has the required fields
    if (!payload.toolId) {
      return res.status(400).json({ 
        error: true, 
        message: 'Missing required fields: toolId' 
      });
    }
    if (!payload.userId) {
      return res.status(400).json({ 
        error: true, 
        message: 'Missing required fields: userId' 
      });
    }
    

    // Log the tool request
    logger.info(`Triggering tool webhook for app ${packageName}`, {
      toolId: payload.toolId,
      userId: payload.userId
    });
    
    // Call the service method to trigger the webhook
    const result = await appService.triggerTpaToolWebhook(packageName, payload);

    console.log('result', result);
    
    // Return the response from the TPA
    return res.status(result.status).json(result.data);
  } catch (error) {
    logger.error('Error triggering tool webhook:', error);
    return res.status(500).json({ 
    error: true,
    message: error instanceof Error ? error.message : 'Unknown error occurred' 
    });
  }
  };
  
  /**
   * Get all tools for a specific TPA
   * Used by Mira AI to discover available tools
   */
  const getTpaTools = async (req: Request, res: Response) => {
  try {
    const { packageName } = req.params;
    
    // Call the service method to get the tools
    const tools = await appService.getTpaTools(packageName);
    
    // Return the tools array
    res.json(tools);
  } catch (error) {
    logger.error('Error fetching TPA tools:', error);
    res.status(500).json({ 
    error: true,
    message: error instanceof Error ? error.message : 'Unknown error occurred' 
    });
  }
  };
  
  /**
   * Get all tools for a user's installed TPAs
   * Used by Mira AI to discover all available tools for a user
   */
  const getUserTools = async (req: Request, res: Response) => {

    try {
      const { userId } = req.params;
      
      if (!userId) {
        return res.status(400).json({ 
          error: true, 
          message: 'Missing required parameter: userId' 
        });
      }
      
      // Find the user by userId (email)
      const user = await User.findOne({ email: userId });
      
      if (!user) {
        return res.status(404).json({ 
          error: true, 
          message: 'User not found' 
        });
      }
      
      // Get list of installed app packageNames from user
      const installedPackageNames = user.installedApps?.map(app => app.packageName) || [];
      
      if (installedPackageNames.length === 0) {
        return res.json([]);
      }
      
      // Collect all tools from all installed apps
      const allUserTools = [];
      
      for (const packageName of installedPackageNames) {
      try {
        // Get tools for this app
        const appTools = await appService.getTpaTools(packageName);
        
        // Add app identifier to each tool
        const toolsWithAppInfo = appTools.map(tool => ({
        ...tool,
        appPackageName: packageName
        }));
        
        allUserTools.push(...toolsWithAppInfo);
      } catch (error) {
        // Log error but continue with other apps
        logger.error(`Error fetching tools for app ${packageName}:`, error);
      }
      }
      
      // Return the combined list of tools
      res.json(allUserTools);
  } catch (error) {
    logger.error('Error fetching user tools:', error);
    res.status(500).json({ 
    error: true,
    message: error instanceof Error ? error.message : 'Unknown error occurred' 
    });
  }
};
  

// Tool webhook routes - Used by Mira AI
router.post('/apps/:packageName/tool', triggerTool);
router.get('/apps/:packageName/tools', getTpaTools);
router.get('/users/:userId/tools', getUserTools);

export default router;