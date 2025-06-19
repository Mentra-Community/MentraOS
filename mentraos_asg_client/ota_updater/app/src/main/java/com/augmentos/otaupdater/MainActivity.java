package com.augmentos.otaupdater;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import androidx.appcompat.app.AppCompatActivity;
import com.augmentos.otaupdater.helper.Constants;
import com.augmentos.otaupdater.helper.OtaHelper;
import androidx.work.OneTimeWorkRequest;
import androidx.work.WorkManager;
import androidx.work.WorkInfo;
import androidx.work.WorkRequest;
import androidx.work.Data;

import com.augmentos.otaupdater.worker.RecoveryWorker;

public class MainActivity extends AppCompatActivity {
    private static final String TAG = "MainActivity";
    private OtaHelper otaHelper;

    // Heartbeat system state
    private Handler heartbeatHandler;
    private static final Object HEARTBEAT_LOCK = new Object(); // Using static to ensure all instances share the same lock
    private long lastHeartbeatSentTime = 0;     // When we last sent a heartbeat
    private long lastHeartbeatAckTime = 0;      // When we last received an acknowledgment
    private boolean heartbeatSystemActive = false;
    private boolean pendingHeartbeatResponse = false;
    private int consecutiveMissedHeartbeats = 0;

    // Recovery system state
    private static final String RECOVERY_WORK_TAG = "recovery_work";
    private boolean isInRecoveryMode = false;
    private boolean recoveryInProgress = false;
    private static boolean exitingRecoveryMode = false;
    // Flag to completely block heartbeats during recovery initialization
    private boolean heartbeatBlockedForRecovery = false;

    // Flag to prevent race conditions in heartbeat scheduling
    private long lastScheduledCheckTime = 0;
    private static final long MIN_CHECK_INTERVAL_MS = 1000; // Reduced to 1 second minimum between checks
    private static final Object SCHEDULE_LOCK = new Object(); // Lock specifically for scheduling operations
    // Unique tag to identify our heartbeat check task
    private static final Object HEARTBEAT_CHECK_TOKEN = new Object();
    // Last time we released the scheduling lock
    private static long lastLockReleaseTime = 0;

    // Update system state
    private boolean updateInProgress = false;
    private long updateStartTime = 0;
    private static final long MAX_UPDATE_DURATION_MS = 10 * 60 * 1000; // 10 minutes max update time

    private boolean processingHeartbeatAcknowledgment = false;
    // Broadcast receivers
    private BroadcastReceiver heartbeatReceiver;
    private BroadcastReceiver updateReceiver;
    private BroadcastReceiver recoveryReceiver;

    // Thread ID tracking for debugging
    private long mainThreadId = -1;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_main);
        
        otaHelper = new OtaHelper(this);

        // Track main thread ID for debugging
        mainThreadId = Thread.currentThread().getId();
        Log.d(TAG, "MainActivity created on thread ID: " + mainThreadId);

        // Initialize heartbeat handler and periodic check task
        heartbeatHandler = new Handler(Looper.getMainLooper());

        // Register receivers
        registerReceivers();

        // Start the heartbeat system
        startHeartbeatSystem();
    }

    /**
     * Registers all broadcast receivers needed by the application
     */
    private void registerReceivers() {
        // Register heartbeat acknowledgment receiver
        heartbeatReceiver = new BroadcastReceiver() {
            @Override
            public void onReceive(Context context, Intent intent) {
                if (Constants.ACTION_ASG_HEARTBEAT_ACK.equals(intent.getAction())) {
                    Log.i(TAG, "Heartbeat acknowledgment received "+ System.currentTimeMillis());
//                    if (!processingHeartbeatAcknowledgment) {
//                        processingHeartbeatAcknowledgment = true;
                    Log.d(TAG, "Processing heartbeat acknowledgment on thread ID: " + Thread.currentThread().getId());
                    handleHeartbeatAcknowledgment();
//                        processingHeartbeatAcknowledgment = false;
//                    }
                }
            }
        };

        // Register update status receiver
        updateReceiver = new BroadcastReceiver() {
            @Override
            public void onReceive(Context context, Intent intent) {
                String action = intent.getAction();
                if (Constants.ACTION_INSTALL_OTA.equals(action)) {
                    Log.i(TAG, "OTA installation starting - pausing heartbeats");
                    updateInProgress = true;
                    updateStartTime = System.currentTimeMillis();
                    pauseHeartbeatSystem();

                    // Safety timer to make sure we eventually resume if completion broadcast is missed
                    heartbeatHandler.postDelayed(() -> {
                        synchronized (HEARTBEAT_LOCK) {
                            long updateDuration = System.currentTimeMillis() - updateStartTime;
                            if (updateInProgress && updateDuration > MAX_UPDATE_DURATION_MS) {
                                Log.w(TAG, "Max update duration reached after " + (updateDuration / 1000) +
                                        " seconds - forcing heartbeat system restart");
                                updateInProgress = false;
                                heartbeatSystemActive = false;
                                startHeartbeatSystem();
                            }
                        }
                    }, MAX_UPDATE_DURATION_MS);

                } else if (Constants.ACTION_UPDATE_COMPLETED.equals(action)) {
                    Log.i(TAG, "OTA installation completed - preparing to resume heartbeats");
                    updateInProgress = false;
                    // Clear all pending operations and ensure clean restart
                    synchronized (HEARTBEAT_LOCK) {
                        if (heartbeatHandler != null) {
                            heartbeatHandler.removeCallbacksAndMessages(null);
                        }
                        // Reset state before restarting
                        heartbeatSystemActive = false;
                        pendingHeartbeatResponse = false;
                        consecutiveMissedHeartbeats = 0;
                    }
                    // Start fresh heartbeat system
                    startHeartbeatSystem();
                }
            }
        };

        // Register recovery control receiver
        recoveryReceiver = new BroadcastReceiver() {
            @Override
            public void onReceive(Context context, Intent intent) {
                String action = intent.getAction();
                if (Constants.ACTION_UNBLOCK_HEARTBEATS.equals(action)) {
                    Log.i(TAG, "Received explicit signal to unblock heartbeats");
                    synchronized (HEARTBEAT_LOCK) {
                        heartbeatBlockedForRecovery = false;

                        // Also check if we need to restart the heartbeat system
                        if (!heartbeatSystemActive) {
                            Log.i(TAG, "Restarting heartbeat system after unblock signal");
                            startHeartbeatSystem();
                        } else {
                            Log.d(TAG, "Heartbeat system already active, just unblocking");
                            // Force an immediate check to send heartbeat now that we're unblocked
                            heartbeatHandler.post(() -> performHeartbeatCheck());
                        }
                    }
                } else if (Constants.ACTION_RECOVERY_HEARTBEAT_ACK.equals(action)) {
                    Log.i(TAG, "Received recovery heartbeat acknowledgment");
                    // Directly call the heartbeat acknowledgment handler instead of broadcasting
                    handleHeartbeatAcknowledgment();
                }
            }
        };

        // Register with system
        IntentFilter heartbeatFilter = new IntentFilter(Constants.ACTION_ASG_HEARTBEAT_ACK);
        registerReceiver(heartbeatReceiver, heartbeatFilter, Context.RECEIVER_NOT_EXPORTED);

        IntentFilter updateFilter = new IntentFilter();
        updateFilter.addAction(Constants.ACTION_INSTALL_OTA);
        updateFilter.addAction(Constants.ACTION_UPDATE_COMPLETED);
        registerReceiver(updateReceiver, updateFilter, Context.RECEIVER_NOT_EXPORTED);

        // Register recovery receiver
        IntentFilter recoveryFilter = new IntentFilter();
        recoveryFilter.addAction(Constants.ACTION_UNBLOCK_HEARTBEATS);
        recoveryFilter.addAction(Constants.ACTION_RECOVERY_HEARTBEAT_ACK);
        registerReceiver(recoveryReceiver, recoveryFilter, Context.RECEIVER_NOT_EXPORTED);
    }

    /**
     * Starts the heartbeat monitoring system
     */
    private void startHeartbeatSystem() {
        synchronized (HEARTBEAT_LOCK) {
            // Already active? Skip
            if (heartbeatSystemActive) {
                Log.d(TAG, "Heartbeat system already active, not starting again");
                return;
            }

            // Clean up any existing tasks and reset state
            if (heartbeatHandler != null) {
                heartbeatHandler.removeCallbacksAndMessages(null);
            }
            // Ensure all state is reset
            lastHeartbeatSentTime = 0;
            pendingHeartbeatResponse = false;
            consecutiveMissedHeartbeats = 0;

            // Reset state
            Log.i(TAG, "Starting heartbeat system");
            lastHeartbeatSentTime = 0;
            lastHeartbeatAckTime = System.currentTimeMillis(); // Initialize with current time
            pendingHeartbeatResponse = false;
            consecutiveMissedHeartbeats = 0;
            heartbeatSystemActive = true;

            // Log timeouts for debugging
            Log.d(TAG, "Heartbeat timeout set to " + Constants.HEARTBEAT_TIMEOUT_MS +
                    "ms, max missed heartbeats before recovery: " + Constants.MAX_MISSED_HEARTBEATS);

            // Clear any pending tasks before scheduling
            if (heartbeatHandler != null) {
                heartbeatHandler.removeCallbacksAndMessages(null);
            }
            // Schedule first heartbeat check
            scheduleNextHeartbeatCheck();
        }
    }

    /**
     * Stops the heartbeat monitoring system
     */
    private void stopHeartbeatSystem() {
        synchronized (HEARTBEAT_LOCK) {
            if (!heartbeatSystemActive) {
                return;
            }

            Log.i(TAG, "Stopping heartbeat system");
            if (heartbeatHandler != null) {
                heartbeatHandler.removeCallbacksAndMessages(null);
            }

            heartbeatSystemActive = false;
            pendingHeartbeatResponse = false;
        }
    }

    /**
     * Pauses the heartbeat system (for updates, etc.)
     */
    private void pauseHeartbeatSystem() {
        synchronized (HEARTBEAT_LOCK) {
            Log.d(TAG, "Pausing heartbeat system");
            if (heartbeatHandler != null) {
                heartbeatHandler.removeCallbacksAndMessages(null);
            }

            // Set timeout to auto-resume with proper state cleanup
            heartbeatHandler.postDelayed(() -> {
                synchronized (HEARTBEAT_LOCK) {
                    if (updateInProgress) {
                        Log.w(TAG, "Update timeout reached - preparing to resume heartbeats");
                        updateInProgress = false;
                        // Clear all operations and reset state
                        if (heartbeatHandler != null) {
                            heartbeatHandler.removeCallbacksAndMessages(null);
                        }
                        heartbeatSystemActive = false;
                        pendingHeartbeatResponse = false;
                        consecutiveMissedHeartbeats = 0;
                        // Start fresh heartbeat system
                        startHeartbeatSystem();
                    }
                }
            }, Constants.UPDATE_TIMEOUT_MS);
        }
    }

    /**
     * Schedules the next heartbeat check based on current state
     */
    private void scheduleNextHeartbeatCheck() {
        // Log which thread is calling this method
        long threadId = Thread.currentThread().getId();
        Log.d(TAG, "scheduleNextHeartbeatCheck called on thread ID: " + threadId +
                (threadId == mainThreadId ? " (main thread)" : " (background thread)"));

        // Use a separate lock for scheduling to prevent deadlocks
        synchronized (SCHEDULE_LOCK) {
            Log.d(TAG, "Acquired SCHEDULE_LOCK in scheduleNextHeartbeatCheck on thread: " + threadId);

            if (!heartbeatSystemActive) {
                Log.d(TAG, "Heartbeat system inactive, skipping scheduling");
                return;
            }

            long currentTime = System.currentTimeMillis();

            // CRITICAL: Enforce minimum time since last lock release before proceeding
            long timeSinceLastRelease = currentTime - lastLockReleaseTime;
            if (timeSinceLastRelease < MIN_CHECK_INTERVAL_MS) {
                Log.w(TAG, "Skipping heartbeat scheduling - too soon after previous scheduling (" +
                        timeSinceLastRelease + "ms). Minimum interval is " + MIN_CHECK_INTERVAL_MS + "ms");
                return;
            }

            // Calculate next check interval - use a shorter interval if we're waiting for a response
            // This ensures we check for timeouts more frequently
            long interval;
            if (pendingHeartbeatResponse && !isInRecoveryMode) {
                // If we're waiting for a response, check more frequently to detect timeouts faster
                // Use half the timeout interval or the standard interval, whichever is shorter
                interval = Math.min(Constants.HEARTBEAT_TIMEOUT_MS / 2, Constants.HEARTBEAT_INTERVAL_MS);
                Log.d(TAG, "Using shorter check interval (" + interval +
                        "ms) because we're waiting for acknowledgment");
            } else {
                interval = isInRecoveryMode ?
                        Constants.RECOVERY_HEARTBEAT_INTERVAL_MS :
                        Constants.HEARTBEAT_INTERVAL_MS;
            }

            // CRITICAL: Remove only our heartbeat checks, preserving other tasks like timeout handlers
            heartbeatHandler.removeCallbacksAndMessages(HEARTBEAT_CHECK_TOKEN);

            // Use an anonymous inner class with a stable instance for better control
            Runnable heartbeatCheckTask = new Runnable() {
                @Override
                public void run() {
                    // Record the task execution in logs
                    String taskId = "task-" + System.nanoTime();
                    Log.d(TAG, "Executing scheduled heartbeat check: " + taskId);

                    synchronized (HEARTBEAT_LOCK) {
                        // IMPORTANT: Always check for timeouts, don't skip even if a response is pending
                        long currentTime = System.currentTimeMillis();

                        // If we have a pending response, check if it has timed out
                        if (pendingHeartbeatResponse) {
                            long timeSinceLastHeartbeat = currentTime - lastHeartbeatSentTime;

                            // If heartbeat has timed out, we need to handle it
                            if (timeSinceLastHeartbeat > Constants.HEARTBEAT_TIMEOUT_MS) {
                                Log.w(TAG, "Heartbeat timed out after " + timeSinceLastHeartbeat +
                                        "ms, processing timeout");
                                performHeartbeatCheck(); // This will handle the timeout
                                return;
                            } else {
                                // Not timed out yet, just log and reschedule
                                Log.d(TAG, "Heartbeat pending but not timed out yet (" +
                                        timeSinceLastHeartbeat + "/" + Constants.HEARTBEAT_TIMEOUT_MS +
                                        "ms). Rescheduling check.");
                                scheduleNextHeartbeatCheck();
                                return;
                            }
                        }

                        // No pending heartbeat, so perform normal check
                        performHeartbeatCheck();
                    }
                }
            };

            // Schedule next check - use our token for identification
            heartbeatHandler.postDelayed(heartbeatCheckTask, HEARTBEAT_CHECK_TOKEN, interval);
            lastScheduledCheckTime = currentTime;
            Log.d(TAG, "Scheduled next heartbeat check in " + interval + "ms with token");

            // Record lock release time
            lastLockReleaseTime = System.currentTimeMillis();
            Log.d(TAG, "Releasing SCHEDULE_LOCK in scheduleNextHeartbeatCheck");
        }
    }

    /**
     * Core heartbeat check logic - determines if we need to send a heartbeat
     * and handles missed heartbeats
     */
    private void performHeartbeatCheck() {
        // Log which thread is calling this method
        long threadId = Thread.currentThread().getId();
        Log.d(TAG, "performHeartbeatCheck called on thread ID: " + threadId +
                (threadId == mainThreadId ? " (main thread)" : " (background thread)"));

        // Use a stricter synchronized block that includes stack trace
        synchronized (HEARTBEAT_LOCK) {
            Log.d(TAG, "Acquired HEARTBEAT_LOCK in performHeartbeatCheck on thread: " + threadId);

            if (!heartbeatSystemActive || updateInProgress) {
                Log.d(TAG, "Heartbeat system inactive or update in progress, skipping check");
                return;
            }

            long currentTime = System.currentTimeMillis();

            // IMPORTANT: Double-check if we already have a pending heartbeat to prevent duplicates
            if (pendingHeartbeatResponse) {
                long timeSinceLastHeartbeat = currentTime - lastHeartbeatSentTime;

                // If we've waited long enough, count it as missed
                if (timeSinceLastHeartbeat > Constants.HEARTBEAT_TIMEOUT_MS) {
                    Log.w(TAG, "Missed heartbeat acknowledgment after " + timeSinceLastHeartbeat + "ms");
                    Log.d(TAG, "Last heartbeat sent at: " + lastHeartbeatSentTime + ", current time: " + currentTime);
                    consecutiveMissedHeartbeats++;
                    pendingHeartbeatResponse = false; // Reset for next attempt

                    // If too many consecutive misses, enter recovery
                    if (consecutiveMissedHeartbeats >= Constants.MAX_MISSED_HEARTBEATS) {
                        Log.e(TAG, "Too many missed heartbeats (" + consecutiveMissedHeartbeats +
                                "), entering recovery mode");
                        enterRecoveryMode();
                        // Recovery mode will handle rescheduling
                        return;
                    }

                    // Only send a new heartbeat if we're not already waiting for a response
                    Log.d(TAG, "Sending new heartbeat after timeout");
                    sendHeartbeat();
                } else {
                    // Still waiting for ack, but not timed out yet
                    Log.d(TAG, "Still waiting for heartbeat acknowledgment (" +
                            timeSinceLastHeartbeat + "ms elapsed, timeout at " +
                            Constants.HEARTBEAT_TIMEOUT_MS + "ms)");
                    scheduleNextHeartbeatCheck();
                }
            } else {
                // No pending heartbeat, send one now
                Log.d(TAG, "No pending heartbeat, sending one now");
                sendHeartbeat();
            }

            Log.d(TAG, "Releasing HEARTBEAT_LOCK in performHeartbeatCheck");
        }
    }

    /**
     * Sends a single heartbeat to the client application
     */
    private void sendHeartbeat() {
        // Log which thread is calling this method
        long threadId = Thread.currentThread().getId();
        Log.d(TAG, "sendHeartbeat called on thread ID: " + threadId +
                (threadId == mainThreadId ? " (main thread)" : " (background thread)"));

        synchronized (HEARTBEAT_LOCK) {
            Log.d(TAG, "Acquired HEARTBEAT_LOCK in sendHeartbeat on thread: " + threadId);

            // CRITICAL: Check if we already have a pending heartbeat, and don't send another if we do
            if (pendingHeartbeatResponse) {
                Log.w(TAG, "PREVENTED DUPLICATE HEARTBEAT - Already waiting for acknowledgment");
                return;
            }

            // CRITICAL: Check if heartbeats are blocked during recovery initialization
            if (heartbeatBlockedForRecovery) {
                Log.w(TAG, "PREVENTED HEARTBEAT - Currently blocked during recovery initialization");
                return;
            }

            if (!heartbeatSystemActive || updateInProgress) {
                Log.d(TAG, "Heartbeat system inactive or update in progress, skipping send");
                return;
            }

            long currentTime = System.currentTimeMillis();

            // Log heartbeat send with timestamp
            Log.i(TAG, "⚡ Sending heartbeat at " + currentTime);

            // Create and send the heartbeat broadcast
            Intent heartbeatIntent = new Intent(Constants.ACTION_HEARTBEAT);
            heartbeatIntent.setPackage("com.augmentos.asg_client");
            sendBroadcast(heartbeatIntent);

            // Update state BEFORE scheduling next check
            lastHeartbeatSentTime = currentTime;
            pendingHeartbeatResponse = true;

            // Log diagnostics
            long timeSinceLastAck = currentTime - lastHeartbeatAckTime;
            Log.d(TAG, "Time since last acknowledgment: " + timeSinceLastAck + "ms");

            // Always schedule the next check after sending a heartbeat
            scheduleNextHeartbeatCheck();

            Log.d(TAG, "Releasing HEARTBEAT_LOCK in sendHeartbeat");
        }
    }

    /**
     * Handles heartbeat acknowledgment from client
     * This now handles both regular and recovery acknowledgments since recovery ACKs are converted to regular ACKs
     */
    private synchronized void handleHeartbeatAcknowledgment() {
        synchronized (HEARTBEAT_LOCK) {
            long currentTime = System.currentTimeMillis();
            long timeSinceLastAck = currentTime - lastHeartbeatAckTime;

            Log.i(TAG, "@$%% Handling heartbeat acknowledgment " + timeSinceLastAck + "ms");
            // Filter duplicate acknowledgments that arrive close together
            if (timeSinceLastAck < 2000) {  // 2000ms deduplication window - increased from 500ms
                Log.d(TAG, "Ignoring duplicate acknowledgment received after only " + timeSinceLastAck + "ms");
                return;
            }

            // Check if we actually sent a heartbeat recently enough to be acknowledged
            long timeSinceHeartbeatSent = currentTime - lastHeartbeatSentTime;
            if (timeSinceHeartbeatSent > Constants.HEARTBEAT_TIMEOUT_MS * 2) {
                Log.w(TAG, "Received acknowledgment for heartbeat that was sent " + timeSinceHeartbeatSent +
                        "ms ago (more than 2x timeout period) - ignoring");
                return;
            }

            Log.i(TAG, "Received heartbeat acknowledgment");

            // Calculate time since we sent the heartbeat
            timeSinceHeartbeatSent = currentTime - lastHeartbeatSentTime;
            Log.d(TAG, "Time since heartbeat sent: " + timeSinceHeartbeatSent + "ms");

            // Update state
            lastHeartbeatAckTime = currentTime;
            pendingHeartbeatResponse = false;
            consecutiveMissedHeartbeats = 0;

            // Only force a new schedule if we've received an acknowledgment for a heartbeat that
            // was sent a while ago. This prevents duplicate scheduling when we get an immediate response.
            if (timeSinceHeartbeatSent > MIN_CHECK_INTERVAL_MS) {
                long fullInterval = isInRecoveryMode ?
                        Constants.RECOVERY_HEARTBEAT_INTERVAL_MS :
                        Constants.HEARTBEAT_INTERVAL_MS;
                Log.d(TAG, "Heartbeat acknowledged after " + timeSinceHeartbeatSent +
                        "ms, scheduling next heartbeat with full interval");
//                forceScheduleNextHeartbeatWithDelay(fullInterval);
            } else {
                // If we just sent the heartbeat and immediately got a response, don't reschedule -
                // the schedule created in sendHeartbeat() is sufficient
                Log.d(TAG, "Heartbeat acknowledged quickly (" + timeSinceHeartbeatSent +
                        "ms), using existing schedule");
            }

            // If in recovery mode, exit
            if (isInRecoveryMode) {
                exitRecoveryMode();
            }
        }
    }

    /**
     * Schedules the next heartbeat with a forced delay, used after acknowledgments
     */
    private void forceScheduleNextHeartbeatWithDelay(long delayMs) {
        // Log call for tracking
        long threadId = Thread.currentThread().getId();
        Log.d(TAG, "forceScheduleNextHeartbeatWithDelay(" + delayMs + "ms) called on thread ID: " + threadId);

        synchronized (SCHEDULE_LOCK) {
            if (!heartbeatSystemActive) {
                return;
            }

            long currentTime = System.currentTimeMillis();

            // Relaxed enforcement for forced scheduling - we know it's coming from an acknowledgment handler
            // This is important to ensure we properly schedule after receiving a response
            long timeSinceLastRelease = currentTime - lastLockReleaseTime;
            if (timeSinceLastRelease < 100) { // Very small window to prevent true duplicates
                Log.w(TAG, "Skipping forced heartbeat scheduling - extreme scheduling contention (" +
                        timeSinceLastRelease + "ms)");
                return;
            }

            // CRITICAL: Only remove our heartbeat checks, preserving other tasks
            heartbeatHandler.removeCallbacksAndMessages(HEARTBEAT_CHECK_TOKEN);

            // Create a stable task with tracking info
            Runnable heartbeatCheckTask = new Runnable() {
                @Override
                public void run() {
                    String taskId = "forced-task-" + System.nanoTime();
                    Log.d(TAG, "Executing FORCED heartbeat check: " + taskId);
                    performHeartbeatCheck();
                }
            };

            // Schedule with our token for identification
            heartbeatHandler.postDelayed(heartbeatCheckTask, HEARTBEAT_CHECK_TOKEN, delayMs);
            lastScheduledCheckTime = currentTime;
            Log.d(TAG, "Force scheduled next heartbeat check in " + delayMs + "ms with token");

            // Record lock release time
            lastLockReleaseTime = System.currentTimeMillis();
        }
    }

    /**
     * Transitions the system into recovery mode
     */
    private void enterRecoveryMode() {
        synchronized (HEARTBEAT_LOCK) {
            if (isInRecoveryMode) {
                Log.w(TAG, "Already in recovery mode, ignoring request");
                return;
            }

            Log.w(TAG, "Entering recovery mode");
            isInRecoveryMode = true;
            recoveryInProgress = true;

            // IMPORTANT: Block all heartbeats during recovery initialization
            heartbeatBlockedForRecovery = true;
            Log.i(TAG, "Completely blocking heartbeats until recovery process is initialized");

            // Restart heartbeat system (with shorter intervals)
            stopHeartbeatSystem();
            startHeartbeatSystem();

            // Start the recovery process
            initiateRecoveryProcess();
        }
    }

    /**
     * Exits recovery mode
     */
    private void exitRecoveryMode() {
        synchronized (HEARTBEAT_LOCK) {
            // Only proceed if actually in recovery mode
            if (!isInRecoveryMode) {
                return;
            }

            // Use synchronized static lock to prevent concurrent exit attempts
            synchronized (MainActivity.class) {
                if (exitingRecoveryMode) {
                    Log.d(TAG, "Recovery mode exit already in progress");
                    return;
                }

                exitingRecoveryMode = true;
                try {
                    Log.i(TAG, "Exiting recovery mode");
                    isInRecoveryMode = false;
                    recoveryInProgress = false;

                    // Important: Wait before restarting heartbeat system to prevent race conditions
                    // Use a post-delayed instead of immediate restart
                    heartbeatHandler.removeCallbacksAndMessages(null);
                    heartbeatHandler.postDelayed(() -> {
                        Log.d(TAG, "Restarting heartbeat system after recovery mode exit");
                        stopHeartbeatSystem();
                        startHeartbeatSystem();
                    }, 1000); // 1 second delay to allow system to stabilize
                } finally {
                    exitingRecoveryMode = false;
                }
            }
        }
    }

    /**
     * Initiates the recovery process using WorkManager
     */
    private void initiateRecoveryProcess() {
        Log.w(TAG, "Initiating recovery process");

        // Cancel any existing recovery work first
        WorkManager.getInstance(this).cancelAllWorkByTag(RECOVERY_WORK_TAG);

        // Make sure we unblock heartbeats if we restart recovery
        heartbeatBlockedForRecovery = true;
        Log.i(TAG, "Blocking heartbeats during recovery initialization");

        // Add a safety timeout to unblock heartbeats in case the worker fails
        heartbeatHandler.postDelayed(() -> {
            synchronized (HEARTBEAT_LOCK) {
                if (heartbeatBlockedForRecovery) {
                    Log.w(TAG, "Safety timeout reached - force unblocking heartbeats");
                    heartbeatBlockedForRecovery = false;
                    // Also check if we need to restart the heartbeat system
                    if (!heartbeatSystemActive) {
                        Log.i(TAG, "Restarting heartbeat system after safety timeout");
                        startHeartbeatSystem();
                    }
                }
            }
        }, 10000); // 10 second timeout

        // Create work request data
        Data inputData = new Data.Builder()
            .putBoolean("is_recovery_mode", true)
            .build();

        // Create a one-time work request for recovery
        OneTimeWorkRequest recoveryWork = new OneTimeWorkRequest.Builder(RecoveryWorker.class)
            .setInputData(inputData)
            .addTag(RECOVERY_WORK_TAG)
            .build();

        // Enqueue as unique work to ensure only one recovery process runs at a time
        WorkManager.getInstance(this)
                .enqueueUniqueWork(
                        "recovery_work_unique",
                        androidx.work.ExistingWorkPolicy.REPLACE,
                        recoveryWork
                );

        // Setup work observation
        WorkManager.getInstance(this)
            .getWorkInfoByIdLiveData(recoveryWork.getId())
            .observe(this, workInfo -> {
                if (workInfo != null) {
                    // Unblock heartbeats after worker has started
                    if (workInfo.getState() == WorkInfo.State.RUNNING && heartbeatBlockedForRecovery) {
                        synchronized (HEARTBEAT_LOCK) {
                            Log.i(TAG, "Recovery process initialized, unblocking heartbeats");
                            heartbeatBlockedForRecovery = false;
                        }
                    }

                    switch (workInfo.getState()) {
                        case SUCCEEDED:
                            Log.i(TAG, "Recovery work completed successfully");
                            boolean success = workInfo.getOutputData().getBoolean("success", false);
                            recoveryInProgress = false;
                            synchronized (HEARTBEAT_LOCK) {
                                heartbeatBlockedForRecovery = false;
                            }
                            if (success) {
                                // Restart ASG Client service after a delay
                                new Handler(Looper.getMainLooper()).postDelayed(() -> {
                                    Intent restartIntent = new Intent(Constants.ACTION_RESTART_ASG_CLIENT);
                                    restartIntent.setPackage("com.augmentos.asg_client");
                                    sendBroadcast(restartIntent);
                                    Log.i(TAG, "Sent restart broadcast to ASG Client service");
                                }, Constants.RECOVERY_RESTART_DELAY_MS);
                            } else {
                                Log.e(TAG, "APK reinstallation failed - no valid backup found");
                                if (isInRecoveryMode) {
                                    isInRecoveryMode = false;
                                    Log.i(TAG, "Exiting recovery mode due to recovery failure");
                                    // Defer heartbeat restart to avoid overlapping schedulers
                                    heartbeatHandler.post(() -> {
                                        stopHeartbeatSystem();
                                        startHeartbeatSystem();
                                    });
                                }
                            }
                            break;
                        case FAILED:
                            Log.e(TAG, "Recovery work failed: " + workInfo.getOutputData().getString("error"));
                            recoveryInProgress = false;
                            synchronized (HEARTBEAT_LOCK) {
                                heartbeatBlockedForRecovery = false;
                            }
                            // Exit recovery mode and restart normal heartbeat when recovery fails
                            if (isInRecoveryMode) {
                                isInRecoveryMode = false;
                                Log.i(TAG, "Exiting recovery mode due to recovery failure");
                                // Defer heartbeat restart to avoid overlapping schedulers
                                heartbeatHandler.post(() -> {
                                    stopHeartbeatSystem();
                                    startHeartbeatSystem();
                                });
                            }
                            break;
                        case CANCELLED:
                            Log.w(TAG, "Recovery work was cancelled");
                            recoveryInProgress = false;
                            synchronized (HEARTBEAT_LOCK) {
                                heartbeatBlockedForRecovery = false;
                            }
                            // Exit recovery mode and restart normal heartbeat when recovery is cancelled
                            if (isInRecoveryMode) {
                                isInRecoveryMode = false;
                                Log.i(TAG, "Exiting recovery mode due to recovery cancellation");
                                // Defer heartbeat restart to avoid overlapping schedulers
                                heartbeatHandler.post(() -> {
                                    stopHeartbeatSystem();
                                    startHeartbeatSystem();
                                });
                            }
                            break;
                    }
                }
            });
    }

    @Override
    protected void onDestroy() {
        super.onDestroy();

        // Stop heartbeat system
        stopHeartbeatSystem();

        // Unregister receivers
        if (heartbeatReceiver != null) {
            unregisterReceiver(heartbeatReceiver);
            heartbeatReceiver = null;
        }

        if (updateReceiver != null) {
            unregisterReceiver(updateReceiver);
            updateReceiver = null;
        }

        // Unregister recovery receiver
        if (recoveryReceiver != null) {
            unregisterReceiver(recoveryReceiver);
            recoveryReceiver = null;
        }

        // Cancel any pending recovery work
        WorkManager.getInstance(this).cancelAllWorkByTag(RECOVERY_WORK_TAG);
    }
}
