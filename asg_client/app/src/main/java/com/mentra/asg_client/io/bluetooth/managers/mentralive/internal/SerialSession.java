package com.mentra.asg_client.io.bluetooth.managers.mentralive.internal;

import java.util.concurrent.locks.ReentrantReadWriteLock;

/** Immutable identity and callback lifetime for one physical serial descriptor. */
public final class SerialSession {
    private final long id;
    private final String path;
    private final int baud;
    private final ReentrantReadWriteLock lifecycleLock = new ReentrantReadWriteLock(true);
    private boolean active = true;

    SerialSession(long id, String path, int baud) {
        this.id = id;
        this.path = path;
        this.baud = baud;
    }

    /** Run a receive callback only while this descriptor is still active. */
    boolean dispatch(Runnable callback) {
        lifecycleLock.readLock().lock();
        try {
            if (!active || callback == null) {
                return false;
            }
            callback.run();
            return true;
        } finally {
            lifecycleLock.readLock().unlock();
        }
    }

    /** Prevent new callbacks and wait for any callback already using this descriptor to finish. */
    void retire() {
        lifecycleLock.writeLock().lock();
        try {
            active = false;
        } finally {
            lifecycleLock.writeLock().unlock();
        }
    }

    public long getId() {
        return id;
    }

    public String getPath() {
        return path;
    }

    public int getBaud() {
        return baud;
    }

    public boolean isActive() {
        lifecycleLock.readLock().lock();
        try {
            return active;
        } finally {
            lifecycleLock.readLock().unlock();
        }
    }

    @Override
    public String toString() {
        return "SerialSession{id=" + id + ", path='" + path + "', baud=" + baud + "}";
    }
}
