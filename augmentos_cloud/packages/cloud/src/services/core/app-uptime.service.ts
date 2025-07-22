import mongoose from 'mongoose';
import dotenv from 'dotenv';
import path from 'path';
import https from 'https';
import http from 'http';
import express from 'express';
import cors from 'cors';

dotenv.config({
  path: path.resolve(__dirname, '../../../../../.env')
});

const MONGO_URI = process.env.MONGO_URL;
if (!MONGO_URI) throw new Error('Missing MONGO_URL in .env');

mongoose.set('strictQuery', false);

// Express app setup
const app = express();
const PORT = process.env.HEALTH_MONITOR_PORT || 8003;

app.use(cors());
app.use(express.json());

// Function to fetch health status
async function fetchHealthStatus(url) {
  return new Promise((resolve) => {
    try {
      const healthUrl = `${url}/health`;
      const urlObj = new URL(healthUrl);
      const client = urlObj.protocol === 'https:' ? https : http;
      
      const req = client.get(healthUrl, { timeout: 5000 }, (res) => {
        let data = '';
        res.on('data', (chunk) => data += chunk);
        res.on('end', () => {
          try {
            const healthData = JSON.parse(data);
            resolve({
              status: 'success',
              data: healthData
            });
          } catch (e) {
            resolve({ status: 'error', error: 'Invalid JSON response' });
          }
        });
      });
      
      req.on('error', () => resolve({ status: 'error', error: 'Connection failed' }));
      req.on('timeout', () => {
        req.destroy();
        resolve({ status: 'error', error: 'Timeout' });
      });
    } catch (e) {
      resolve({ status: 'error', error: 'Invalid URL' });
    }
  });
}

async function connectToDB() {
  if (mongoose.connection.readyState === 0) {
    await mongoose.connect(MONGO_URI);
  }
}

// Model import
import App, { AppI } from '../../models/app.model';

async function getAllApps(): Promise<AppI[]> {
  await connectToDB();
  return App.find().lean();
}

// NEW: Function to update app health status in database
async function updateAppHealthStatus(packageName: string, healthStatus: string, healthData?: any) {
  await connectToDB();
  
  const updateData = {
    healthStatus: healthStatus, // 'online', 'offline', 'unknown'
    lastHealthCheck: new Date(),
    ...(healthData && { healthData: healthData })
  };
  
  await App.updateOne(
    { packageName: packageName },
    { $set: updateData }
  );
}

// NEW: API endpoint to get app health statuses
app.get('/api/app-health', async (req, res) => {
  try {
    await connectToDB();
    const apps = await App.find({}, {
      packageName: 1,
      name: 1,
      healthStatus: 1,
      lastHealthCheck: 1,
      healthData: 1
    }).lean();
    
    // Create a map for easy lookup
    const healthMap = {};
    apps.forEach(app => {
      healthMap[app.packageName] = {
        status: app.healthStatus || 'unknown',
        lastCheck: app.lastHealthCheck,
        data: app.healthData
      };
    });
    
    res.json({
      success: true,
      healthStatuses: healthMap
    });
  } catch (error) {
    console.error('Error fetching app health statuses:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch app health statuses'
    });
  }
});

// NEW: API endpoint to get specific app health
app.get('/api/app-health/:packageName', async (req, res) => {
  try {
    await connectToDB();
    const { packageName } = req.params;
    
    const app = await App.findOne({ packageName }, {
      packageName: 1,
      name: 1,
      healthStatus: 1,
      lastHealthCheck: 1,
      healthData: 1
    }).lean();
    
    if (!app) {
      return res.status(404).json({
        success: false,
        error: 'App not found'
      });
    }
    
    res.json({
      success: true,
      packageName: app.packageName,
      status: app.healthStatus || 'unknown',
      lastCheck: app.lastHealthCheck,
      data: app.healthData
    });
  } catch (error) {
    console.error('Error fetching app health status:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch app health status'
    });
  }
});

async function printAppStatus() {
  try {
    const apps = await getAllApps();
    const count = await App.countDocuments();

    const publishedApps = apps.filter(app => app.appStoreStatus === 'PUBLISHED');
    const submittedApps = apps.filter(app => app.appStoreStatus === 'SUBMITTED');

    // Clear console for better readability
    console.clear();
    
    // Print timestamp
    console.log(`🕒 Last updated: ${new Date().toLocaleString()}\n`);

    // Print published apps with public URLs and health status
    console.log('📘 PUBLISHED APPS:\n');
    for (const app of publishedApps) {
      console.log(`📱 ${app.name || 'Unnamed'} → ${app.appStoreStatus}`);
      console.log(`   🔗 Public URL: ${app.publicUrl || 'No public URL'}`);
      
      if (app.publicUrl && app.packageName) {
        const health = await fetchHealthStatus(app.publicUrl);
        if (health.status === 'success') {
          const { status, app: appName, activeSessions } = health.data;
          console.log(`   💚 Health: ${status} | App: ${appName || 'N/A'} | Active Sessions: ${activeSessions || 0}`);
          
          // NEW: Update database with online status
          await updateAppHealthStatus(app.packageName, 'online', health.data);
        } else {
          console.log(`   ❌ Health: ${health.error}`);
          
          // NEW: Update database with offline status
          await updateAppHealthStatus(app.packageName, 'offline', { error: health.error });
        }
      } else if (app.packageName) {
        // NEW: Update database with unknown status for apps without public URL
        await updateAppHealthStatus(app.packageName, 'unknown');
      }
      console.log(''); // Empty line for spacing
    }
    console.log(`✅ Total PUBLISHED apps: ${publishedApps.length}\n`);

    // Print submitted apps with public URLs and health status
    console.log('🟦 SUBMITTED APPS:\n');
    for (const app of submittedApps) {
      console.log(`📱 ${app.name || 'Unnamed'} → ${app.appStoreStatus}`);
      console.log(`   🔗 Public URL: ${app.publicUrl || 'No public URL'}`);
      
      if (app.publicUrl && app.packageName) {
        const health = await fetchHealthStatus(app.publicUrl);
        if (health.status === 'success') {
          const { status, app: appName, activeSessions } = health.data;
          console.log(`   💚 Health: ${status} | App: ${appName || 'N/A'} | Active Sessions: ${activeSessions || 0}`);
          
          // NEW: Update database with online status
          await updateAppHealthStatus(app.packageName, 'online', health.data);
        } else {
          console.log(`   ❌ Health: ${health.error}`);
          
          // NEW: Update database with offline status
          await updateAppHealthStatus(app.packageName, 'offline', { error: health.error });
        }
      } else if (app.packageName) {
        // NEW: Update database with unknown status for apps without public URL
        await updateAppHealthStatus(app.packageName, 'unknown');
      }
      console.log(''); // Empty line for spacing
    }
    console.log(`✅ Total SUBMITTED apps: ${submittedApps.length}\n`);

    // Print total apps in DB
    console.log(`📦 Total apps in DB: ${count}\n`);
    console.log('━'.repeat(60));
    console.log('⏰ Next update in 1 minute...\n');

  } catch (error) {
    console.error('❌ Error fetching apps:', error);
  }
}

// Start the Express server
app.listen(PORT, () => {
  console.log(`🚀 App Health Monitor API running on port ${PORT}`);
});

// Initial run
printAppStatus();

// Set up interval to run every minute (60000 ms)
setInterval(printAppStatus, 60000);

// Handle graceful shutdown
process.on('SIGINT', () => {
  console.log('\n👋 Shutting down app monitor...');
  mongoose.connection.close();
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('\n👋 Shutting down app monitor...');
  mongoose.connection.close();
  process.exit(0);
});