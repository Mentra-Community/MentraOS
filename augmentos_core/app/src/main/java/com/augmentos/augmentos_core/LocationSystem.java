package com.augmentos.augmentos_core;

import android.Manifest;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.util.Log;
import android.content.pm.PackageManager;
import android.location.Location;
import android.os.Binder;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;

import androidx.annotation.Nullable;
import androidx.core.app.ActivityCompat;
import androidx.core.app.NotificationCompat;

import com.augmentos.augmentos_core.augmentos_backend.ServerComms;
import com.google.android.gms.location.FusedLocationProviderClient;
import com.google.android.gms.location.LocationCallback;
import com.google.android.gms.location.LocationRequest;
import com.google.android.gms.location.LocationResult;
import com.google.android.gms.location.LocationServices;


public class LocationSystem extends Service {
    private static final String TAG = "LocationSystem";
    private static final int NOTIFICATION_ID = 1004;
    private static final String CHANNEL_ID = "LocationServiceChannel";
    
    // Service binder
    private final IBinder binder = new LocationBinder();
    
    // We no longer need this context since we are a Service
    // private Context context;
    
    public double lat = 0;
    public double lng = 0;

    public double latestAccessedLat = 0;
    public double latestAccessedLong = 0;
    private FusedLocationProviderClient fusedLocationProviderClient;
    private LocationCallback locationCallback;

    // Store last known location
    private Location lastKnownLocation = null;

    /**
     * Class for clients to access this service
     */
    public class LocationBinder extends Binder {
        public LocationSystem getService() {
            return LocationSystem.this;
        }
    }
    
    @Override
    public void onCreate() {
        super.onCreate();
        Log.d(TAG, "LocationService created");
        createNotificationChannel();
        
        // Initialize location components
        fusedLocationProviderClient = LocationServices.getFusedLocationProviderClient(this);
        setupLocationCallbacks();
        
        // Immediately request a single, fast location fix on startup
        requestSingleFastUpdate();

        // Set the default mode to our standard, low-power 15-minute updates.
        setHighAccuracyMode(false); 
    }
    
    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        Log.d(TAG, "Starting LocationService as foreground service");
        
        // Check if we have required permissions for foreground service
        if (!hasRequiredLocationPermissions()) {
            Log.w(TAG, "Missing location permissions - cannot start as foreground service");
            handleMissingLocationPermissions();
            return START_NOT_STICKY;
        }
        
        try {
            startForeground(NOTIFICATION_ID, createNotification());
            Log.d(TAG, "Successfully started LocationService as foreground service");
        } catch (SecurityException e) {
            Log.e(TAG, "SecurityException starting foreground service: " + e.getMessage());
            handleMissingLocationPermissions();
        }
        
        return START_NOT_STICKY; // Don't restart if killed
    }
    
    /**
     * Check if we have all required permissions for location foreground service
     */
    private boolean hasRequiredLocationPermissions() {
        // Check basic location permissions
        boolean hasCoarseLocation = ActivityCompat.checkSelfPermission(this, 
                Manifest.permission.ACCESS_COARSE_LOCATION) == PackageManager.PERMISSION_GRANTED;
        boolean hasFineLocation = ActivityCompat.checkSelfPermission(this, 
                Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED;
        
        // Check foreground service location permission (Android 14+)
        boolean hasForegroundServiceLocation = true;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            hasForegroundServiceLocation = ActivityCompat.checkSelfPermission(this, 
                    Manifest.permission.FOREGROUND_SERVICE_LOCATION) == PackageManager.PERMISSION_GRANTED;
        }
        
        return (hasCoarseLocation || hasFineLocation) && hasForegroundServiceLocation;
    }
    
    /**
     * Handle the case where location permissions are missing
     */
    private void handleMissingLocationPermissions() {
        Log.w(TAG, "Location permissions missing - stopping service gracefully");
        
        // Don't try to access any location data - user removed permissions for a reason
        // Just stop the service and let the app continue without location functionality
        stopSelf();
    }
    
    @Nullable
    @Override
    public IBinder onBind(Intent intent) {
        return binder;
    }
    
    @Override
    public void onDestroy() {
        Log.d(TAG, "LocationService destroyed");
        cleanup();
        super.onDestroy();
    }
    
    /**
     * Create notification for the foreground service
     */
    private Notification createNotification() {
        Intent notificationIntent = new Intent(this, MainActivity.class);
        PendingIntent pendingIntent = PendingIntent.getActivity(
                this,
                0,
                notificationIntent,
                PendingIntent.FLAG_IMMUTABLE
        );
        
        return new NotificationCompat.Builder(this, CHANNEL_ID)
                .setContentTitle("Location Service")
                .setContentText("Providing location for smart glasses")
                .setSmallIcon(R.drawable.ic_launcher_foreground)
                .setContentIntent(pendingIntent)
                .setPriority(NotificationCompat.PRIORITY_LOW)
                .setOngoing(true)
                .build();
    }
    
    /**
     * Create the notification channel for Android O and above
     */
    private void createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel channel = new NotificationChannel(
                    CHANNEL_ID,
                    "Location Service",
                    NotificationManager.IMPORTANCE_LOW
            );
            channel.setDescription("Used for location updates for smart glasses");
            NotificationManager manager = getSystemService(NotificationManager.class);
            if (manager != null) {
                manager.createNotificationChannel(channel);
            }
        }
    }
    
    // Required no-argument constructor for Android services
    public LocationSystem() {
        // No initialization here - it will be done in onCreate()
    }
    
    // For backward compatibility - this constructor is no longer the main entry point
    // since we're now a Service, but keeping it allows existing code to work
    public LocationSystem(Context context) {
        // We don't need to do anything here since onCreate() will handle initialization
        // This is just for API compatibility
    }

    private void getLastKnownLocation() {
        if (ActivityCompat.checkSelfPermission(this, Manifest.permission.ACCESS_FINE_LOCATION) != PackageManager.PERMISSION_GRANTED) {
            return;
        }

        fusedLocationProviderClient.getLastLocation()
                .addOnSuccessListener(location -> {
                    if (location != null) {
                        // Use the last known location immediately
                        lastKnownLocation = location;
                        lat = location.getLatitude();
                        lng = location.getLongitude();
                        Log.d(TAG, "Using last known location: " + lat + ", " + lng);
                    }
                });
    }

    public void setHighAccuracyMode(boolean enabled) {
        stopLocationUpdates(); // always stop previous requests

        if (enabled) {
            Log.d(TAG, "LocationSystem: Enabling high accuracy mode (realtime).");
            LocationRequest realtimeRequest = LocationRequest.create();
            realtimeRequest.setPriority(LocationRequest.PRIORITY_HIGH_ACCURACY);
            realtimeRequest.setInterval(1000); // 1 second
            realtimeRequest.setFastestInterval(500);

            if (ActivityCompat.checkSelfPermission(this, Manifest.permission.ACCESS_FINE_LOCATION) != PackageManager.PERMISSION_GRANTED) {
                return;
            }
            fusedLocationProviderClient.requestLocationUpdates(realtimeRequest, locationCallback, Looper.getMainLooper());
        } else {
            Log.d(TAG, "LocationSystem: Disabling high accuracy mode, reverting to standard 15-minute updates.");
            LocationRequest standardRequest = LocationRequest.create();
            standardRequest.setPriority(LocationRequest.PRIORITY_LOW_POWER);
            standardRequest.setInterval(900000); // 15 minutes
            standardRequest.setFastestInterval(300000); // 5 minutes

            if (ActivityCompat.checkSelfPermission(this, Manifest.permission.ACCESS_FINE_LOCATION) != PackageManager.PERMISSION_GRANTED) {
                return;
            }
            fusedLocationProviderClient.requestLocationUpdates(standardRequest, locationCallback, Looper.getMainLooper());
        }
    }

    public void stopLocationUpdates() {
        if (fusedLocationProviderClient != null && locationCallback != null) {
            fusedLocationProviderClient.removeLocationUpdates(locationCallback);
        }
    }

    public void sendLocationToServer() {
        double latitude = getNewLat();
        double longitude = getNewLng();

        if (latitude == -1 && longitude == -1) {
            Log.d(TAG, "Location not available, cannot send to server");
            return;
        }

        ServerComms.getInstance().sendLocationUpdate(latitude, longitude);
    }

    public double getNewLat() {
        if (latestAccessedLat == lat) return -1;
        latestAccessedLat = lat;
        return latestAccessedLat;
    }

    public double getNewLng() {
        if (latestAccessedLong == lng) return -1;
        latestAccessedLong = lng;
        return latestAccessedLong;
    }

    private void setupLocationCallbacks() {
        // A single unified callback for all location updates
        locationCallback = new LocationCallback() {
            @Override
            public void onLocationResult(LocationResult locationResult) {
                if (locationResult == null || locationResult.getLocations().isEmpty()) return;

                Location location = locationResult.getLastLocation();
                lat = location.getLatitude();
                lng = location.getLongitude();
                lastKnownLocation = location;

                Log.d(TAG, "LocationSystem: Received location update: " + lat + ", " + lng);
                sendLocationToServer();
            }
        };
    }

    // Get the current location - will return last known location if available
    public Location getCurrentLocation() {
        return lastKnownLocation;
    }
    
    /**
     * Call this method to cleanup all resources when the app is being destroyed
     */
    public void cleanup() {
        // Make sure location updates are stopped
        stopLocationUpdates();
    }

    // gets a single fast update on startup
    public void requestSingleFastUpdate() {
        if (ActivityCompat.checkSelfPermission(this, Manifest.permission.ACCESS_FINE_LOCATION) != PackageManager.PERMISSION_GRANTED) {
            return;
        }

        Log.d(TAG, "Requesting single fast location update on startup.");
        LocationRequest fastUpdateRequest = LocationRequest.create();
        fastUpdateRequest.setPriority(LocationRequest.PRIORITY_HIGH_ACCURACY);
        fastUpdateRequest.setNumUpdates(1); // Only want one update
        fastUpdateRequest.setMaxWaitTime(10000); // Wait at most 10 seconds

        fusedLocationProviderClient.requestLocationUpdates(
                fastUpdateRequest,
                new LocationCallback() { // Use a one-time callback
                    @Override
                    public void onLocationResult(LocationResult locationResult) {
                        if (locationResult == null || locationResult.getLocations().isEmpty()) return;
                        Location location = locationResult.getLastLocation();
                        lat = location.getLatitude();
                        lng = location.getLongitude();
                        lastKnownLocation = location;
                        Log.d(TAG, ">>>> received single fast startup location update: " + lat + ", " + lng);
                        sendLocationToServer();
                        // This callback is self-terminating because of setNumUpdates(1)
                    }
                },
                Looper.getMainLooper()
        );
    }
}