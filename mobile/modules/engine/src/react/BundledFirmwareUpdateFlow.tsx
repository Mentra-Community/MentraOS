import {MentraLiveOtaFlow} from "./MentraLiveOtaFlow"
import {FirmwareUpdateFlow, type FirmwareUpdateFlowProps, type FirmwareUpdateViewRegistry} from "./FirmwareUpdateFlow"

/** Presentation composition only. Every view's execution goes through the registered provider service. */
const bundledViews: FirmwareUpdateViewRegistry = {
  "mentra-live": (props) => (
    <MentraLiveOtaFlow
      allowDevSkip={props.allowDevelopmentSkip}
      deviceName={props.target.displayName}
      initialPage={props.legacyProgressEntry ? "progress" : "check"}
      initializeRuntime={props.initializeRuntime}
      onFinished={props.onFinished}
      onFirmwareRestartingChange={props.onFirmwareRestartingChange}
      onSnapshot={props.onSnapshot}
      onOpenWifiSetup={props.onOpenWifiSetup ?? (() => {})}
      superMode={props.superMode}
      theme={props.theme}
      translate={props.translate}
      style={props.style}
    />
  ),
}

export function BundledFirmwareUpdateFlow(props: FirmwareUpdateFlowProps) {
  return <FirmwareUpdateFlow {...props} views={bundledViews} />
}
