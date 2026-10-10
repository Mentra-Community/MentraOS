package com.mentra.asg_client.io.bes.log;

/**
 * Process-wide seam between the upload/phone-notification side and the incident store. The store
 * registers itself with {@link #set}; handlers read {@link #get} at command time and treat
 * {@code null} as "no incident support" (the user bug-report path is unaffected).
 */
public final class BesIncidentAccessProvider {
    private static volatile BesIncidentUploadAccess sAccess;

    private BesIncidentAccessProvider() {}

    public static void set(BesIncidentUploadAccess access) {
        sAccess = access;
    }

    /** The registered access, or {@code null} until the store has registered. */
    public static BesIncidentUploadAccess get() {
        return sAccess;
    }
}
