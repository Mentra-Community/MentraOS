

// // Export module with factory function for singleton pattern
// export default {
//     getInstance: (): AOSManager => {
//       // Create singleton instance
//       if (!(<any>global).aosManagerInstance) {
//         (<any>global).aosManagerInstance = new AOSManager();
//       }
//       return (<any>global).aosManagerInstance;
//     }
//   };// AOSManager.ts
//   // TypeScript implementation of AOSManager

import { parsePlaceholders } from "./utils";

  
//   // Type definitions
//   interface ViewState {
//     topText: string;
//     bottomText: string;
//     layoutType: string;
//     text: string;
//     eventStr: string;
//   }
  
//   interface ThirdPartyCloudApp {
//     packageName: string;
//     name: string;
//     description: string;
//     webhookURL: string;
//     logoURL: string;
//     isRunning: boolean;
//   }
  
//   interface VadState {
//     speeching: string;
//   }
  
//   // Enums for command handling
  enum CommandType {
    SET_AUTH_SECRET_KEY = "set_auth_secret_key",
    REQUEST_STATUS = "request_status",
    CONNECT_WEARABLE = "connect_wearable",
    DISCONNECT_WEARABLE = "disconnect_wearable",
    SEARCH_FOR_COMPATIBLE_DEVICE_NAMES = "search_for_compatible_device_names",
    ENABLE_CONTEXTUAL_DASHBOARD = "enable_contextual_dashboard",
    FORCE_CORE_ONBOARD_MIC = "force_core_onboard_mic",
    SET_PREFERRED_MIC = "set_preferred_mic",
    PING = "ping",
    FORGET_SMART_GLASSES = "forget_smart_glasses",
    START_APP = "start_app",
    STOP_APP = "stop_app",
    UPDATE_GLASSES_HEAD_UP_ANGLE = "update_glasses_head_up_angle",
    UPDATE_GLASSES_BRIGHTNESS = "update_glasses_brightness",
    UPDATE_GLASSES_HEIGHT = "update_glasses_height",
    UPDATE_GLASSES_DEPTH = "update_glasses_depth",
    ENABLE_SENSING = "enable_sensing",
    ENABLE_ALWAYS_ON_STATUS_BAR = "enable_always_on_status_bar",
    BYPASS_VAD = "bypass_vad_for_debugging",
    BYPASS_AUDIO_ENCODING = "bypass_audio_encoding_for_debugging",
    SET_SERVER_URL = "set_server_url",
    SET_METRIC_SYSTEM_ENABLED = "set_metric_system_enabled",
    SHOW_DASHBOARD = "show_dashboard",
    UNKNOWN = "unknown"
  }
  
//   // Interface for callbacks
//   interface ServerCommsCallback {
//     onConnectionAck(): void;
//     onAppStateChange(apps: ThirdPartyCloudApp[]): void;
//     onConnectionError(error: string): void;
//     onAuthError(): void;
//     onMicrophoneStateChange(isEnabled: boolean): void;
//     onDisplayEvent(event: any): void;
//     onRequestSingle(dataType: string): void;
//   }
  
//   interface MicCallback {
//     onRouteChange(reason: string, availableInputs: any[]): void;
//     onInterruption(began: boolean): void;
//   }
  
//   // Mock classes for dependencies
  

  

  
//   class PcmConverter {
//     encode(pcmData: Uint8Array): Uint8Array {
//       console.log(`Encoding PCM data of size: ${pcmData.length}`);
//       return new Uint8Array(pcmData.length / 2); // Mock encoder
//     }
  
//     decode(lc3Data: Uint8Array): Uint8Array {
//       console.log(`Decoding LC3 data of size: ${lc3Data.length}`);
//       return new Uint8Array(lc3Data.length * 2); // Mock decoder
//     }
//   }
  
//   class CoreCommsService {
//     static emitter = new EventEmitter();
//   }
  



  // Main AOSManager class
class AOSManager {
    private coreToken: string = "";
    private coreTokenOwner: string = "";
    
    private g1Manager: G1Manager | null = null;
    private micManager: OnboardMicrophoneManager | null = null;
    private serverComms: ServerComms;
    
    private subscriptions: Subscription[] = [];
    private cachedThirdPartyAppList: ThirdPartyCloudApp[] = [];
    private defaultWearable: string = "";
    private deviceName: string = "";
    private somethingConnected: boolean = false;
    private shouldEnableMic: boolean = false;
    private contextualDashboard: boolean = true;
    private headUpAngle: number = 30;
    private brightness: number = 50;
    private batteryLevel: number = -1;
    private autoBrightness: boolean = true;
    private dashboardHeight: number = 4;
    private depth: number = 5;
    private sensingEnabled: boolean = true;
    private isSearching: boolean = true;
    private alwaysOnStatusBar: boolean = false;
    private bypassVad: boolean = false;
    private bypassAudioEncoding: boolean = false;
    private onboardMicUnavailable: boolean = false;
    private metricSystemEnabled: boolean = false;
    private settingsLoaded: boolean = false;
    private connectTask: any = null;
    
    public viewStates: ViewState[] = [
      { topText: " ", bottomText: " ", layoutType: "text_wall", text: "", eventStr: "" },
      { topText: " ", bottomText: " ", layoutType: "text_wall", text: "$TIME12$ $DATE$ $GBATT$ $CONNECTION_STATUS", eventStr: "" },
    ];
    
    private useOnboardMic: boolean = false;
    private preferredMic: string = "glasses";
    private micEnabled: boolean = false;
    
    private vad: SileroVADStrategy | null = null;
    private vadBuffer: Uint8Array[] = [];
    private isSpeaking: boolean = false;
    
    constructor() {
      this.vad = new SileroVADStrategy();
      this.serverComms = ServerComms.getInstance();
      
      this.loadSettings().then(() => {
        if (this.vad) {
          this.vad.setup({
            sampleRate: "rate_16k",
            frameSize: "size_1024",
            quality: "normal",
            silenceTriggerDurationMs: 4000,
            speechTriggerDurationMs: 50
          });
        }
      });
    }
    
    // Public Methods
    public setup(): void {
      this.g1Manager = new G1Manager();
      this.micManager = new OnboardMicrophoneManager();
      this.serverComms.locationManager.setup();
      this.serverComms.mediaManager.setup();
      
      if (!this.g1Manager) {
        return;
      }
  
      // Set up callbacks
      this.serverComms.setServerCommsCallback(this);
      if (this.micManager) {
        this.micManager.setMicCallback(this);
      }
      
      // Set up voice data handling
      this.setupVoiceDataHandling();
      
      // Set up connection state change handler
      this.g1Manager.onConnectionStateChanged = () => {
        console.log(`G1 glasses connection changed to: ${this.g1Manager?.g1Ready ? "Connected" : "Disconnected"}`);
        
        if (this.g1Manager?.g1Ready) {
          this.handleDeviceReady();
        } else {
          this.handleDeviceDisconnected();
          this.handleRequestStatus();
        }
      };
      
      // Listen to changes in battery level
      this.subscriptions.push(
        this.g1Manager.batteryLevel.subscribe(level => {
          if (level >= 0) {
            this.batteryLevel = level;
            this.serverComms.sendBatteryStatus(this.batteryLevel, false);
          }
        })
      );
      
      // Listen to headUp events
      this.subscriptions.push(
        this.g1Manager.isHeadUp.subscribe(value => {
          this.sendCurrentState(value);
        })
      );
      
      // Subscribe to WebSocket status changes
      this.subscriptions.push(
        this.serverComms.wsManager.status.subscribe(() => {
          this.handleRequestStatus();
        })
      );
    }
    
    public connectServer(): void {
      this.serverComms.connectWebSocket();
    }
    
    public setCoreToken(coreToken: string): void {
      this.serverComms.setAuthCredentials("", coreToken);
    }
    
    public startApp(packageName: string): void {
      this.serverComms.startApp(packageName);
    }
    
    public stopApp(packageName: string): void {
      this.serverComms.stopApp(packageName);
    }
    
    // ServerCommsCallback Implementation
    public onConnectionAck(): void {
      this.handleRequestStatus();
    }
    
    public onAppStateChange(apps: ThirdPartyCloudApp[]): void {
      this.cachedThirdPartyAppList = apps;
      this.handleRequestStatus();
    }
    
    public onConnectionError(error: string): void {
      this.handleRequestStatus();
    }
    
    public onAuthError(): void {}
    
    // // Voice Data Handling
    // private checkSetVadStatus(speaking: boolean): void {
    //   if (speaking !== this.isSpeaking) {
    //     this.isSpeaking = speaking;
    //     this.serverComms.sendVadStatus(this.isSpeaking);
    //   }
    // }
    
    // private emptyVadBuffer(): void {
    //   while (this.vadBuffer.length > 0) {
    //     const chunk = this.vadBuffer.shift();
    //     if (chunk) {
    //       this.serverComms.sendAudioChunk(chunk);
    //     }
    //   }
    // }
    
    // private addToVadBuffer(chunk: Uint8Array): void {
    //   const MAX_BUFFER_SIZE = 20;
    //   this.vadBuffer.push(chunk);
    //   while (this.vadBuffer.length > MAX_BUFFER_SIZE) {
    //     this.vadBuffer.shift();
    //   }
    // }
    
    // private setupVoiceDataHandling(): void {
    //   if (!this.micManager || !this.g1Manager) {
    //     return;
    //   }
      
    //   // Handle incoming PCM data from the microphone manager
    //   this.subscriptions.push(
    //     this.micManager.voiceData.subscribe(pcmData => {
    //       if (!this.vad) {
    //         console.log("VAD not initialized");
    //         return;
    //       }
          
    //       if (this.bypassVad) {
    //         this.serverComms.sendAudioChunk(pcmData);
    //         return;
    //       }
          
    //       // Convert Uint8Array to Int16Array
    //       const int16Array = new Int16Array(pcmData.buffer);
    //       const pcmDataArray = Array.from(int16Array);
          
    //       this.vad.checkVAD(pcmDataArray, (state) => {
    //         console.log(`VAD State: ${state}`);
    //       });
          
    //       const vadState = this.vad.currentState();
    //       if (vadState === "speeching") {
    //         this.checkSetVadStatus(true);
    //         this.emptyVadBuffer();
    //         this.serverComms.sendAudioChunk(pcmData);
    //       } else {
    //         this.checkSetVadStatus(false);
    //         this.addToVadBuffer(pcmData);
    //       }
    //     })
    //   );
      
    //   // Handle G1 audio data
    //   this.subscriptions.push(
    //     this.g1Manager.compressedVoiceData.subscribe(rawLC3Data => {
    //       if (rawLC3Data.length <= 2) {
    //         console.log(`Received invalid PCM data size: ${rawLC3Data.length}`);
    //         return;
    //       }
          
    //       // Skip command bytes
    //       const lc3Data = rawLC3Data.slice(2);
          
    //       if (lc3Data.length === 0) {
    //         console.log("No PCM data after removing command bytes");
    //         return;
    //       }
          
    //       if (this.bypassVad) {
    //         this.checkSetVadStatus(true);
    //         this.emptyVadBuffer();
    //         const pcmConverter = new PcmConverter();
    //         const pcmData = pcmConverter.decode(lc3Data);
    //         this.serverComms.sendAudioChunk(pcmData);
    //         return;
    //       }
          
    //       const pcmConverter = new PcmConverter();
    //       const pcmData = pcmConverter.decode(lc3Data);
          
    //       if (pcmData.length === 0) {
    //         console.log("PCM conversion resulted in empty data");
    //         return;
    //       }
          
    //       if (!this.vad) {
    //         console.log("VAD not initialized");
    //         return;
    //       }
          
    //       // Convert to Int16Array
    //       const int16Array = new Int16Array(pcmData.buffer);
    //       const pcmDataArray = Array.from(int16Array);
          
    //       this.vad.checkVAD(pcmDataArray, (state) => {
    //         console.log(`VAD State: ${state}`);
    //       });
          
    //       const vadState = this.vad.currentState();
    //       if (vadState === "speeching") {
    //         this.checkSetVadStatus(true);
    //         this.emptyVadBuffer();
    //         this.serverComms.sendAudioChunk(pcmData);
    //       } else {
    //         this.checkSetVadStatus(false);
    //         this.addToVadBuffer(pcmData);
    //       }
    //     })
    //   );
    // }
    
    // MicCallback Implementation
    public onMicrophoneStateChange(isEnabled: boolean): void {
      console.log(`Changing microphone state to: ${isEnabled}`);
      
      // Clear the VAD buffer
      this.vadBuffer = [];
      this.micEnabled = isEnabled;
      
      // Manage microphone state
      this.manageMicrophoneState(isEnabled);
    }
    
    private async manageMicrophoneState(isEnabled: boolean): Promise<void> {
      let actuallyEnabled = isEnabled && this.sensingEnabled;
      if (!this.somethingConnected) {
        actuallyEnabled = false;
      }
  
      const glassesHasMic = this.getGlassesHasMic();
      
      let useGlassesMic = false;
      let useOnboardMic = false;
  
      useOnboardMic = this.preferredMic === "phone";
      useGlassesMic = this.preferredMic === "glasses";
      
      if (this.onboardMicUnavailable) {
        useOnboardMic = false;
      }
      
      if (!glassesHasMic) {
        useGlassesMic = false;
      }
  
      if (!useGlassesMic && !useOnboardMic) {
        if (glassesHasMic) {
          useGlassesMic = true;
        } else if (!this.onboardMicUnavailable) {
          useOnboardMic = true;
        }
  
        if (!useGlassesMic && !useOnboardMic) {
          console.log("No mic to use!");
        }
      }
      
      useGlassesMic = actuallyEnabled && useGlassesMic;
      useOnboardMic = actuallyEnabled && useOnboardMic;
  
      console.log(`User enabled microphone: ${isEnabled}, sensingEnabled: ${this.sensingEnabled}, useOnboardMic: ${useOnboardMic}, useGlassesMic: ${useGlassesMic}, glassesHasMic: ${glassesHasMic}, preferredMic: ${this.preferredMic}, somethingConnected: ${this.somethingConnected}, onboardMicUnavailable: ${this.onboardMicUnavailable}`);
  
      if (this.somethingConnected && this.g1Manager) {
        await this.g1Manager.setMicEnabled(useGlassesMic);
      }
      
      this.setOnboardMicEnabled(useOnboardMic);
    }
    
    private setOnboardMicEnabled(isEnabled: boolean): void {
      if (isEnabled) {
        if (!(this.micManager?.checkPermissions() ?? false)) {
          console.log("Microphone permissions not granted. Cannot enable microphone.");
          return;
        }
        
        this.micManager?.startRecording();
      } else {
        this.micManager?.stopRecording();
      }
    }
    
    public clearState(): void {
      this.sendCurrentState(this.g1Manager?.isHeadUp.getValue() ?? false);
    }
    
    public sendCurrentState(isDashboard: boolean): void {
      const currentViewState = isDashboard ? this.viewStates[1] : this.viewStates[0];
      
      if (isDashboard && !this.contextualDashboard) {
        return;
      }
      
      const eventStr = currentViewState.eventStr;
      if (eventStr !== "") {
        // CoreCommsService.emitter.emit("CoreMessageEvent", eventStr);
      }
      
      if (this.defaultWearable.includes("Simulated") || this.defaultWearable === "") {
        return;
      }
      
      if (!this.somethingConnected) {
        return;
      }
      
      const layoutType = currentViewState.layoutType;
      switch (layoutType) {
        case "text_wall":
          const text = currentViewState.text;
          this.sendText(text);
          break;
        case "double_text_wall":
          const topText = currentViewState.topText;
          const bottomText = currentViewState.bottomText;
          this.g1Manager?.RN_sendDoubleTextWall(topText, bottomText);
          break;
        case "reference_card":
          this.sendText(currentViewState.topText + "\n\n" + currentViewState.bottomText);
          break;
        default:
          console.log(`UNHANDLED LAYOUT_TYPE ${layoutType}`);
          break;
      }
    }
    
    public handleDisplayEvent(event: any): void {
      const view = event.view;
      if (!view) {
        console.log("Invalid view");
        return;
      }
      
      const isDashboard = view === "dashboard";
      const stateIndex = isDashboard ? 1 : 0;
      
      // Save state string to forward to the mirror
      const wrapperObj = { glasses_display_event: event };
      let eventStr = "";
      try {
        eventStr = JSON.stringify(wrapperObj);
      } catch (error) {
        console.log(`Error converting to JSON: ${error}`);
      }
      
      this.viewStates[stateIndex].eventStr = eventStr;
      const layout = event.layout;
      const layoutType = layout.layoutType;
      this.viewStates[stateIndex].layoutType = layoutType;
      
      let text = layout.text || " ";
      let topText = layout.topText || " ";
      let bottomText = layout.bottomText || " ";
      let title = layout.title || " ";
      
      text = parsePlaceholders(text, this.batteryLevel, this.serverComms.isWebSocketConnected());
      topText = parsePlaceholders(topText, this.batteryLevel, this.serverComms.isWebSocketConnected());
      bottomText = parsePlaceholders(bottomText, this.batteryLevel, this.serverComms.isWebSocketConnected());
      title = parsePlaceholders(title, this.batteryLevel, this.serverComms.isWebSocketConnected());
      
      switch (layoutType) {
        case "text_wall":
          this.viewStates[stateIndex].text = text;
          break;
        case "double_text_wall":
          this.viewStates[stateIndex].topText = topText;
          this.viewStates[stateIndex].bottomText = bottomText;
          break;
        case "reference_card":
          this.viewStates[stateIndex].topText = text;
          this.viewStates[stateIndex].bottomText = title;
          break;
        default:
          console.log(`UNHANDLED LAYOUT_TYPE ${layoutType}`);
          break;
      }
      
      const headUp = this.g1Manager?.isHeadUp.getValue() ?? false;
      if ((stateIndex === 0 && !headUp) || (stateIndex === 1 && headUp)) {
        this.sendCurrentState(stateIndex === 1);
      }
    }
    
    public onDisplayEvent(event: any): void {
      this.handleDisplayEvent(event);
    }
    
    public onRequestSingle(dataType: string): void {
      this.handleRequestStatus();
    }
  
    public onRouteChange(reason: string, availableInputs: any[]): void {
      console.log(`onRouteChange: ${reason}`);
      
      switch (reason) {
        case "newDeviceAvailable":
          this.micManager?.stopRecording();
          this.micManager?.startRecording();
          break;
        case "oldDeviceUnavailable":
          this.micManager?.stopRecording();
          this.micManager?.startRecording();
          break;
        default:
          break;
      }
    }
    
    public onInterruption(began: boolean): void {
      console.log(`Interruption: ${began}`);
      this.onboardMicUnavailable = began;
      this.onMicrophoneStateChange(this.micEnabled);
    }
    
    private handleSearchForCompatibleDeviceNames(modelName: string): void {
      console.log(`Searching for compatible device names for: ${modelName}`);
      
      if (modelName.includes("Simulated")) {
        this.defaultWearable = "Simulated Glasses";
        this.preferredMic = "phone";
        this.saveSettings();
        this.handleRequestStatus();
      } else if (modelName.includes("Audio")) {
        this.defaultWearable = "Audio Wearable";
        this.preferredMic = "phone";
        this.saveSettings();
        this.handleRequestStatus();
      } else if (modelName.includes("G1")) {
        this.defaultWearable = "Even Realities G1";
        this.g1Manager?.RN_startScan();
      }
    }
    
    private handleSetServerUrl(url: string): void {
      console.log(`Setting server URL to: ${url}`);
      this.serverComms.setServerUrl(url);
    }
    
    private sendText(text: string): void {
      console.log(`Sending text: ${text}`);
      if (this.defaultWearable.includes("Simulated") || this.defaultWearable === "") {
        return;
      }
      this.g1Manager?.RN_sendText(text);
    }
    
    private disconnect(): void {
      this.somethingConnected = false;
      this.g1Manager?.disconnect();
    }
    
    public handleCommand(command: string): void {
      console.log(`Received command: ${command}`);
      
      if (!this.settingsLoaded) {
        // In a real implementation, we'd wait for settings to load
        console.log("Warning: Settings not loaded, proceeding with default values");
      }
      
      // Try to parse JSON
      try {
        const jsonDict = JSON.parse(command);
        
        const commandString = jsonDict.command;
        if (!commandString) {
          console.log("Invalid command format: missing 'command' field");
          return;
        }
        
        const commandType = commandString as CommandType;
        const params = jsonDict.params;
        
        // Process based on command type
        switch (commandType) {
          case CommandType.SET_SERVER_URL:
            if (!params || !params.url) {
              console.log("set_server_url invalid params");
              break;
            }
            this.handleSetServerUrl(params.url);
            break;
            
          case CommandType.SET_AUTH_SECRET_KEY:
            if (!params || !params.userId || !params.authSecretKey) {
              console.log("set_auth_secret_key invalid params");
              break;
            }
            this.handleSetAuthSecretKey(params.userId, params.authSecretKey);
            this.handleRequestStatus();
            break;
            
          case CommandType.REQUEST_STATUS:
            this.handleRequestStatus();
            break;
            
          case CommandType.CONNECT_WEARABLE:
            if (!params || !params.model_name || !params.device_name) {
              console.log("connect_wearable invalid params");
              this.handleConnectWearable(this.defaultWearable, "");
              break;
            }
            this.handleConnectWearable(params.model_name, params.device_name);
            break;
            
          case CommandType.DISCONNECT_WEARABLE:
            this.sendText(" "); // clear the screen
            this.handleDisconnectWearable();
            break;
            
          case CommandType.FORGET_SMART_GLASSES:
            this.handleDisconnectWearable();
            this.defaultWearable = "";
            this.deviceName = "";
            if (this.g1Manager) {
              this.g1Manager.DEVICE_SEARCH_ID = "";
            }
            this.saveSettings();
            this.handleRequestStatus();
            break;
            
          case CommandType.SEARCH_FOR_COMPATIBLE_DEVICE_NAMES:
            if (!params || !params.model_name) {
              console.log("search_for_compatible_device_names invalid params");
              break;
            }
            this.handleSearchForCompatibleDeviceNames(params.model_name);
            break;
            
          case CommandType.ENABLE_CONTEXTUAL_DASHBOARD:
            if (!params || params.enabled === undefined) {
              console.log("enable_contextual_dashboard invalid params");
              break;
            }
            this.contextualDashboard = params.enabled;
            this.saveSettings();
            this.handleRequestStatus(); // to update the UI
            break;
            
          case CommandType.SET_PREFERRED_MIC:
            if (!params || !params.mic) {
              console.log("set_preferred_mic invalid params");
              break;
            }
            this.preferredMic = params.mic;
            this.onMicrophoneStateChange(this.micEnabled);
            this.saveSettings();
            this.handleRequestStatus(); // to update the UI
            break;
            
          case CommandType.START_APP:
            if (!params || !params.target) {
              console.log("start_app invalid params");
              break;
            }
            console.log(`Starting app: ${params.target}`);
            this.serverComms.startApp(params.target);
            this.handleRequestStatus();
            break;
            
          case CommandType.STOP_APP:
            if (!params || !params.target) {
              console.log("stop_app invalid params");
              break;
            }
            console.log(`Stopping app: ${params.target}`);
            this.serverComms.stopApp(params.target);
            break;
            
          case CommandType.UPDATE_GLASSES_HEAD_UP_ANGLE:
            if (!params || params.headUpAngle === undefined) {
              console.log("update_glasses_head_up_angle invalid params");
              break;
            }
            this.headUpAngle = params.headUpAngle;
            this.g1Manager?.RN_setHeadUpAngle(params.headUpAngle);
            this.saveSettings();
            this.handleRequestStatus(); // to update the UI
            break;
            
          case CommandType.UPDATE_GLASSES_BRIGHTNESS:
            if (!params || params.brightness === undefined || params.autoBrightness === undefined) {
              console.log("update_glasses_brightness invalid params");
              break;
            }
            const autoBrightnessChanged = this.autoBrightness !== params.autoBrightness;
            this.brightness = params.brightness;
            this.autoBrightness = params.autoBrightness;
            
            this.g1Manager?.RN_setBrightness(params.brightness, params.autoBrightness);
            
            setTimeout(() => {
              if (autoBrightnessChanged) {
                this.sendText(params.autoBrightness ? "Enabled auto brightness" : "Disabled auto brightness");
              } else {
                this.sendText(`Set brightness to ${params.brightness}%`);
              }
              
              setTimeout(() => {
                this.sendText(" "); // clear screen
              }, 800);
            }, 0);
            
            this.saveSettings();
            this.handleRequestStatus(); // to update the UI
            break;
            
          case CommandType.UPDATE_GLASSES_HEIGHT:
            if (!params || params.height === undefined) {
              console.log("update_glasses_height invalid params");
              break;
            }
            this.dashboardHeight = params.height;
            
            (async () => {
              await this.g1Manager?.RN_setDashboardPosition(this.dashboardHeight, this.depth);
            })();
            
            this.saveSettings();
            this.handleRequestStatus(); // to update the UI
            break;
            
          case CommandType.SHOW_DASHBOARD:
            (async () => {
              await this.g1Manager?.RN_showDashboard();
            })();
            break;
            
          case CommandType.UPDATE_GLASSES_DEPTH:
            if (!params || params.depth === undefined) {
              console.log("update_glasses_depth invalid params");
              break;
            }
            this.depth = params.depth;
            
            (async () => {
              await this.g1Manager?.RN_setDashboardPosition(this.dashboardHeight, this.depth);
            })();
            
            this.saveSettings();
            break;
            
          case CommandType.ENABLE_SENSING:
            if (!params || params.enabled === undefined) {
              console.log("enable_sensing invalid params");
              break;
            }
            this.sensingEnabled = params.enabled;
            this.saveSettings();
            // Update microphone state when sensing is toggled
            this.onMicrophoneStateChange(this.micEnabled);
            this.handleRequestStatus(); // to update the UI
            break;
            
          case CommandType.ENABLE_ALWAYS_ON_STATUS_BAR:
            if (!params || params.enabled === undefined) {
              console.log("enable_always_on_status_bar invalid params");
              break;
            }
            this.alwaysOnStatusBar = params.enabled;
            this.saveSettings();
            this.handleRequestStatus(); // to update the UI
            break;
            
          case CommandType.BYPASS_VAD:
            if (!params || params.enabled === undefined) {
              console.log("bypass_vad invalid params");
              break;
            }
            this.bypassVad = params.enabled;
            this.saveSettings();
            this.handleRequestStatus(); // to update the UI
            break;
            
          case CommandType.BYPASS_AUDIO_ENCODING:
            if (!params || params.enabled === undefined) {
              console.log("bypass_audio_encoding invalid params");
              break;
            }
            this.bypassAudioEncoding = params.enabled;
            break;
            
          case CommandType.FORCE_CORE_ONBOARD_MIC:
            console.log("force_core_onboard_mic deprecated");
            break;
            
          case CommandType.SET_METRIC_SYSTEM_ENABLED:
            if (!params || params.enabled === undefined) {
              console.log("set_metric_system_enabled invalid params");
              break;
            }
            this.metricSystemEnabled = params.enabled;
            this.saveSettings();
            this.handleRequestStatus();
            break;
            
          case CommandType.PING:
            // Just acknowledge ping
            break;
            
          default:
            console.log(`Unknown command type: ${commandString}`);
            this.handleRequestStatus();
            break;
        }
      } catch (error) {
        console.error("Error parsing command:", error);
      }
    }

}

export default AOSManager;