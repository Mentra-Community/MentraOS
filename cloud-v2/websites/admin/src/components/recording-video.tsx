import {forwardRef, type ComponentPropsWithoutRef} from "react";

/** A consistent, bounded player for routine examples, run evidence and reports. */
export const RecordingVideo = forwardRef<HTMLVideoElement, ComponentPropsWithoutRef<"video">>(
  function RecordingVideo({className = "", ...props}, ref) {
    return <video ref={ref} controls playsInline preload="metadata" {...props}
      className={`mx-auto block h-[var(--recording-height)] w-full max-w-[60rem] rounded-lg bg-black object-contain ${className}`} />;
  },
);
