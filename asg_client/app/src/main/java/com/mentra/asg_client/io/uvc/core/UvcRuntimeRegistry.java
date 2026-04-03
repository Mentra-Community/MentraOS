package com.mentra.asg_client.io.uvc.core;

public final class UvcRuntimeRegistry {
  private static volatile UvcBridgeManager manager;

  private UvcRuntimeRegistry() {
  }

  public static synchronized UvcBridgeManager getOrCreate() {
    if (manager == null) {
      manager = new UvcBridgeManager();
    }
    return manager;
  }

  public static synchronized void set(UvcBridgeManager value) {
    manager = value;
  }

  public static UvcBridgeManager get() {
    return manager;
  }
}
