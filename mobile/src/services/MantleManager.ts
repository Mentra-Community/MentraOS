import CoreModule from "core"
import * as Calendar from "expo-calendar"
import * as Location from "expo-location"
import * as TaskManager from "expo-task-manager"
import {shallow} from "zustand/shallow"

import bridge from "@/bridge/MantleBridge"
import livekit from "@/services/Livekit"
import {migrate} from "@/services/Migrations"
import restComms from "@/services/RestComms"
import socketComms from "@/services/SocketComms"
import {gallerySyncService} from "@/services/asg/gallerySyncService"
import {useDisplayStore} from "@/stores/display"
import {useGlassesStore, GlassesInfo, getGlasesInfoPartial} from "@/stores/glasses"
import {useSettingsStore, SETTINGS} from "@/stores/settings"
import GlobalEventEmitter from "@/utils/GlobalEventEmitter"
import TranscriptProcessor from "@/utils/TranscriptProcessor"

const LOCATION_TASK_NAME = "handleLocationUpdates"

// @ts-ignore
TaskManager.defineTask(LOCATION_TASK_NAME, ({data: {locations}, error}) => {
  if (error) {
    // check `error.message` for more details.
    // console.error("Error handling location updates", error)
    return
  }
  const locs = locations as Location.LocationObject[]
  if (locs.length === 0) {
    console.log("MANTLE: LOCATION: No locations received")
    return
  }

  // console.log("Received new locations", locations)
  const first = locs[0]!
  // socketComms.sendLocationUpdate(first.coords.latitude, first.coords.longitude, first.coords.accuracy ?? undefined)
  restComms.sendLocationData(first)
})

class MantleManager {
  private static instance: MantleManager | null = null
  private calendarSyncTimer: ReturnType<typeof setInterval> | null = null
  private clearTextTimeout: ReturnType<typeof setTimeout> | null = null
  private transcriptProcessor: TranscriptProcessor

  public static getInstance(): MantleManager {
    if (!MantleManager.instance) {
      MantleManager.instance = new MantleManager()
    }
    return MantleManager.instance
  }

  private constructor() {
    // Pass callback to send pending updates when timer fires
    this.transcriptProcessor = new TranscriptProcessor(() => {
      this.sendPendingTranscript()
    })
  }

  private sendPendingTranscript() {
    const pendingText = this.transcriptProcessor.getPendingUpdate()
    if (pendingText) {
      socketComms.handle_display_event({
        type: "display_event",
        view: "main",
        layout: {
          layoutType: "text_wall",
          text: pendingText,
        },
      })
    }
  }

  // run at app start on the init.tsx screen:
  // should only ever be run once
  // sets up the bridge and initializes app state
  public async init() {
    await bridge.dummy()
    await migrate() // do any local migrations here
    const res = await restComms.loadUserSettings() // get settings from server
    if (res.is_ok()) {
      const loadedSettings = res.value
      await useSettingsStore.getState().setManyLocally(loadedSettings) // write settings to local storage
    } else {
      console.error("MANTLE: No settings received from server")
    }

    await CoreModule.updateSettings(useSettingsStore.getState().getCoreSettings()) // send settings to core
    // send initial status request:
    await CoreModule.getStatus()

    this.initServices()
    this.setupPeriodicTasks()
    this.setupSubscriptions()
  }

  public async cleanup() {
    // Stop timers
    if (this.calendarSyncTimer) {
      clearInterval(this.calendarSyncTimer)
      this.calendarSyncTimer = null
    }
    Location.stopLocationUpdatesAsync(LOCATION_TASK_NAME)
    this.transcriptProcessor.clear()

    livekit.disconnect()
    socketComms.cleanup()
    restComms.goodbye()
  }

  private initServices() {
    socketComms.connectWebsocket()
    gallerySyncService.initialize()
  }

  private async setupPeriodicTasks() {
    this.sendCalendarEvents()
    // Calendar sync every hour
    this.calendarSyncTimer = setInterval(
      () => {
        this.sendCalendarEvents()
      },
      60 * 60 * 1000,
    ) // 1 hour
    try {
      let locationAccuracy = await useSettingsStore.getState().getSetting(SETTINGS.location_tier.key)
      let properAccuracy = this.getLocationAccuracy(locationAccuracy)
      Location.startLocationUpdatesAsync(LOCATION_TASK_NAME, {
        accuracy: properAccuracy,
      })
    } catch (error) {
      console.error("MANTLE: Error starting location updates", error)
    }

    // check for requirements immediately, but only if we've passed through onboarding:
    // const onboardingCompleted = await useSettingsStore.getState().getSetting(SETTINGS.onboarding_completed.key)
    // if (onboardingCompleted) {
    //   try {
    //     const requirementsCheck = await checkConnectivityRequirementsUI()
    //     if (!requirementsCheck) {
    //       return
    //     }
    //     // give some time for the glasses to be fully ready:
    //     BackgroundTimer.setTimeout(async () => {
    //       await CoreModule.connectDefault()
    //     }, 3000)
    //   } catch (error) {
    //     console.error("connect to glasses error:", error)
    //     showAlert("Connection Error", "Failed to connect to glasses. Please try again.", [{text: "OK"}])
    //   }
    // }
  }

  private setupSubscriptions() {
    useGlassesStore.subscribe(
      getGlasesInfoPartial,
      (state: Partial<GlassesInfo>, previousState: Partial<GlassesInfo>) => {
        const statusObj: Partial<GlassesInfo> = {}

        for (const key in state) {
          const k = key as keyof GlassesInfo
          if (state[k] !== previousState[k]) {
            statusObj[k] = state[k] as any
          }
        }
        restComms.updateGlassesState(statusObj)
      },
      {equalityFn: shallow},
    )

    // subscribe to core settings changes and update the core:
    useSettingsStore.subscribe(
      (state) => state.getCoreSettings(),
      (state: Record<string, any>, previousState: Record<string, any>) => {
        const coreSettingsObj: Record<string, any> = {}

        for (const key in state) {
          const k = key as keyof Record<string, any>
          if (state[k] !== previousState[k]) {
            coreSettingsObj[k] = state[k] as any
          }
        }
        console.log("MANTLE: core settings changed", coreSettingsObj)
        CoreModule.updateSettings(coreSettingsObj)
      },
      {equalityFn: shallow},
    )
  }

  private async sendCalendarEvents() {
    try {
      console.log("MANTLE: sendCalendarEvents()")
      const calendars = await Calendar.getCalendarsAsync(Calendar.EntityTypes.EVENT)
      const calendarIds = calendars.map((calendar: Calendar.Calendar) => calendar.id)
      // from 2 hours ago to 1 week from now:
      const startDate = new Date(Date.now() - 2 * 60 * 60 * 1000)
      const endDate = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
      const events = await Calendar.getEventsAsync(calendarIds, startDate, endDate)
      restComms.sendCalendarData({events, calendars})
    } catch (error) {
      // it's fine if this fails
      console.log("MANTLE: Error sending calendar events", error)
    }
  }

  private async sendLocationUpdates() {
    console.log("MANTLE: sendLocationUpdates()")
    // const location = await Location.getCurrentPositionAsync()
    // socketComms.sendLocationUpdate(location)
  }

  public getLocationAccuracy(accuracy: string) {
    switch (accuracy) {
      case "realtime":
        return Location.LocationAccuracy.BestForNavigation
      case "tenMeters":
        return Location.LocationAccuracy.High
      case "hundredMeters":
        return Location.LocationAccuracy.Balanced
      case "kilometer":
        return Location.LocationAccuracy.Low
      case "threeKilometers":
        return Location.LocationAccuracy.Lowest
      case "reduced":
        return Location.LocationAccuracy.Lowest
      default:
        // console.error("MANTLE: unknown accuracy: " + accuracy)
        return Location.LocationAccuracy.Lowest
    }
  }

  public async setLocationTier(tier: string) {
    console.log("MANTLE: setLocationTier()", tier)
    // restComms.sendLocationData({tier})
    try {
      const accuracy = this.getLocationAccuracy(tier)
      await Location.stopLocationUpdatesAsync(LOCATION_TASK_NAME)
      await Location.startLocationUpdatesAsync(LOCATION_TASK_NAME, {
        accuracy: accuracy,
        pausesUpdatesAutomatically: false,
      })
    } catch (error) {
      console.log("MANTLE: Error setting location tier", error)
    }
  }

  public async requestSingleLocation(accuracy: string, correlationId: string) {
    console.log("MANTLE: requestSingleLocation()")
    // restComms.sendLocationData({tier})
    try {
      const location = await Location.getCurrentPositionAsync({accuracy: this.getLocationAccuracy(accuracy)})
      socketComms.sendLocationUpdate(
        location.coords.latitude,
        location.coords.longitude,
        location.coords.accuracy ?? undefined,
        correlationId,
      )
    } catch (error) {
      console.log("MANTLE: Error requesting single location", error)
    }
  }

  // mostly for debugging / local stt:
  public async displayTextMain(text: string) {
    this.resetDisplayTimeout()
    socketComms.handle_display_event({
      type: "display_event",
      view: "main",
      layout: {
        layoutType: "text_wall",
        text: text,
      },
    })
  }

  public async handle_head_up(isUp: boolean) {
    socketComms.sendHeadPosition(isUp)
    useDisplayStore.getState().setView(isUp ? "dashboard" : "main")
  }

  public async resetDisplayTimeout() {
    if (this.clearTextTimeout) {
      // console.log("MANTLE: canceling pending timeout")
      clearTimeout(this.clearTextTimeout)
    }
    this.clearTextTimeout = setTimeout(() => {
      console.log("MANTLE: clearing text from wall")
    }, 10000) // 10 seconds
  }

  public async handle_local_transcription(data: any) {
    // TODO: performance!
    const offlineStt = await useSettingsStore.getState().getSetting(SETTINGS.offline_captions_running.key)
    if (offlineStt) {
      this.transcriptProcessor.changeLanguage(data.transcribeLanguage)
      const processedText = this.transcriptProcessor.processString(data.text, data.isFinal ?? false)

      // Scheduling timeout to clear text from wall. In case of online STT online dashboard manager will handle it.
      // if (data.isFinal) {
      //   this.resetDisplayTimeout()
      // }

      if (processedText) {
        this.displayTextMain(processedText)
      }

      return
    }

    socketComms.sendLocalTranscription(data)
  }

  public async handle_button_press(id: string, type: string, timestamp: string) {
    // Emit event to React Native layer for handling
    GlobalEventEmitter.emit("BUTTON_PRESS", {
      buttonId: id,
      pressType: type,
      timestamp: timestamp,
    })
    socketComms.sendButtonPress(id, type)
  }
}

const mantle = MantleManager.getInstance()
export default mantle
