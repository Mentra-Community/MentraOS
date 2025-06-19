package com.augmentos.augmentos_core;

import android.content.ContentResolver;
import android.content.Context;
import android.database.Cursor;
import android.net.Uri;
import android.os.Handler;
import android.os.Looper;
import android.provider.CalendarContract;
import android.util.Log;
import androidx.core.content.ContextCompat;
import android.Manifest;
import android.content.pm.PackageManager;

import com.augmentos.augmentos_core.augmentos_backend.ServerComms;

import java.util.ArrayList;
import java.util.List;

/**
 * CalendarSystem wraps interactions with the Android Calendar Provider.
 * It offers methods to query for calendar events—specifically the next upcoming event.
 */
public class CalendarSystem {

    private static final String TAG = "CalendarSystem";
    private static CalendarSystem instance;
    private Context context;

    // Calendar data tracking
    public CalendarItem latestCalendarItem = null;
    public CalendarItem latestAccessedCalendarItem = null;

    private final Handler calendarSendingLoopHandler = new Handler(Looper.getMainLooper());
    private Runnable calendarSendingRunnableCode;
    private final long calendarSendTime = 1000 * 60 * 10; // 5 minutes

    private final long firstFetchPollingInterval = 10000; // 5 seconds

    private CalendarSystem(Context context) {
        this.context = context.getApplicationContext();
        scheduleCalendarUpdates();
    }

    /**
     * Get the singleton instance of CalendarSystem
     *
     * @param context The application context
     * @return The singleton instance
     */
    public static synchronized CalendarSystem getInstance(Context context) {
        if (instance == null) {
            instance = new CalendarSystem(context);
        }
        return instance;
    }

    /**
     * Checks if the necessary calendar permissions are granted.
     *
     * @return true if permissions are granted.
     */
    private boolean hasCalendarPermissions() {
        return ContextCompat.checkSelfPermission(context, Manifest.permission.READ_CALENDAR)
                == PackageManager.PERMISSION_GRANTED;
    }

    /**
     * Request a calendar update from the system
     */
    public void requestCalendarUpdate() {
        if (!hasCalendarPermissions()) {
            Log.w(TAG, "Calendar permissions are not granted.");
            return;
        }

        Log.d(TAG, "Requesting calendar update.");

        // Fetch the next calendar event
        CalendarItem nextEvent = getNextUpcomingEvent();
        if (nextEvent != null) {
            latestCalendarItem = nextEvent;
            sendCalendarEventToServer();
        }
    }

    /**
     * Send the calendar event to the server if it's new
     */
    public void sendCalendarEventToServer() {
        CalendarItem calendarItem = getNewCalendarItem();

        if (calendarItem == null) return;

        ServerComms.getInstance().sendCalendarEvent(calendarItem);
    }

    /**
     * Get a new calendar item if available
     *
     * @return the new calendar item or null if nothing new
     */
    public CalendarItem getNewCalendarItem() {
        if (latestAccessedCalendarItem == latestCalendarItem || latestCalendarItem == null) return null;
        latestAccessedCalendarItem = latestCalendarItem;
        return latestAccessedCalendarItem;
    }

    /**
     * Retrieves the next upcoming event from the device's calendar.
     *
     * @return a CalendarItem representing the next upcoming event or null if none found.
     */
    private CalendarItem getNextUpcomingEvent() {
        if (!hasCalendarPermissions()) {
            Log.w(TAG, "Calendar permissions are not granted.");
            return null;
        }

        ContentResolver contentResolver = context.getContentResolver();
        String selection = CalendarContract.Events.DTSTART + " >= ?";
        String[] selectionArgs = new String[]{ String.valueOf(System.currentTimeMillis()) };
        String sortOrder = CalendarContract.Events.DTSTART + " ASC LIMIT 1";
        Uri eventsUri = CalendarContract.Events.CONTENT_URI;

        Cursor cursor = contentResolver.query(eventsUri, null, selection, selectionArgs, sortOrder);
        CalendarItem nextEvent = null;

        if (cursor != null) {
            if (cursor.moveToFirst()) {
                // Extract event details from the cursor
                long eventId = cursor.getLong(cursor.getColumnIndexOrThrow(CalendarContract.Events._ID));
                String title = cursor.getString(cursor.getColumnIndexOrThrow(CalendarContract.Events.TITLE));
                long dtStart = cursor.getLong(cursor.getColumnIndexOrThrow(CalendarContract.Events.DTSTART));
                long dtEnd = cursor.getLong(cursor.getColumnIndexOrThrow(CalendarContract.Events.DTEND));
                String timeZone = cursor.getString(cursor.getColumnIndexOrThrow(CalendarContract.Events.EVENT_TIMEZONE));

                nextEvent = new CalendarItem(eventId, title, dtStart, dtEnd, timeZone);
                Log.d(TAG, "Next event: " + nextEvent.toString());
            } else {
                Log.d(TAG, "No upcoming calendar events found.");
            }
            cursor.close();
        } else {
            Log.e(TAG, "Query to calendar content provider failed.");
        }

        return nextEvent;
    }

    /**
     * Retrieves the next N upcoming events from the device's calendar.
     *
     * @param count Number of events to fetch
     * @return a List of CalendarItem representing the next upcoming events
     */
    private List<CalendarItem> getNextUpcomingEvents(int count) {
        List<CalendarItem> events = new ArrayList<>();
        if (!hasCalendarPermissions()) {
            Log.w(TAG, "Calendar permissions are not granted.");
            return events;
        }

        ContentResolver contentResolver = context.getContentResolver();
        String selection = CalendarContract.Events.DTSTART + " >= ?";
        String[] selectionArgs = new String[]{ String.valueOf(System.currentTimeMillis()) };
        String sortOrder = CalendarContract.Events.DTSTART + " ASC LIMIT " + count;
        Uri eventsUri = CalendarContract.Events.CONTENT_URI;

        Cursor cursor = contentResolver.query(eventsUri, null, selection, selectionArgs, sortOrder);
        if (cursor != null) {
            while (cursor.moveToNext()) {
                long eventId = cursor.getLong(cursor.getColumnIndexOrThrow(CalendarContract.Events._ID));
                String title = cursor.getString(cursor.getColumnIndexOrThrow(CalendarContract.Events.TITLE));
                long dtStart = cursor.getLong(cursor.getColumnIndexOrThrow(CalendarContract.Events.DTSTART));
                long dtEnd = cursor.getLong(cursor.getColumnIndexOrThrow(CalendarContract.Events.DTEND));
                String timeZone = cursor.getString(cursor.getColumnIndexOrThrow(CalendarContract.Events.EVENT_TIMEZONE));
                events.add(new CalendarItem(eventId, title, dtStart, dtEnd, timeZone));
            }
            cursor.close();
        } else {
            Log.e(TAG, "Query to calendar content provider failed.");
        }
        return events;
    }

    /**
     * Send the next 5 calendar events to the server
     */
    public void sendNextFiveCalendarEventsToServer() {
        List<CalendarItem> events = getNextUpcomingEvents(5);
        for (CalendarItem event : events) {
            ServerComms.getInstance().sendCalendarEvent(event);
        }
    }

    /**
     * Schedule periodic calendar updates
     */
    public final void scheduleCalendarUpdates() {
        calendarSendingRunnableCode = new Runnable() {
            @Override
            public void run() {
                sendNextFiveCalendarEventsToServer(); // Send next 5 events
                calendarSendingLoopHandler.postDelayed(this, calendarSendTime);
            }
        };
        calendarSendingLoopHandler.postDelayed(calendarSendingRunnableCode, firstFetchPollingInterval);
    }
}