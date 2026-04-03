package com.mentra.asg_client.io.uvc.model;

public enum UvcState {
  IDLE,
  STARTING,
  STREAMING,
  STOPPING,
  ERROR;

  public boolean canTransitionTo(UvcState next) {
    switch (this) {
      case IDLE:
        return next == STARTING;
      case STARTING:
        return next == STREAMING || next == STOPPING || next == ERROR;
      case STREAMING:
        return next == STOPPING || next == ERROR;
      case STOPPING:
        return next == IDLE || next == ERROR;
      case ERROR:
        return next == IDLE || next == STARTING;
      default:
        return false;
    }
  }
}
