//
//  CalendarManager.swift
//  AugmentOS_Manager
//
//  Created by Matthew Fosse on 3/14/25.
//


import EventKit


struct CalendarItem {
  let title: String
  let eventId: String
  let dtStart: Int64  // Unix timestamp in milliseconds
  let dtEnd: Int64    // Unix timestamp in milliseconds
  let timeZone: String
}

func convertEKEventToCalendarItem(_ event: EKEvent) -> CalendarItem {
  // Convert EKEvent start/end dates to millisecond timestamps
  let dtStart = Int64(event.startDate.timeIntervalSince1970 * 1000)
  let dtEnd = Int64(event.endDate.timeIntervalSince1970 * 1000)
  
  return CalendarItem(
    title: event.title ?? "Untitled Event",
    eventId: event.eventIdentifier,
    dtStart: dtStart,
    dtEnd: dtEnd,
    timeZone: event.timeZone?.identifier ?? TimeZone.current.identifier
  )
}

class CalendarManager {
  private let eventStore = EKEventStore()
  private var calendarObserver: NSObjectProtocol?
  private var onCalendarChanged: (() -> Void)?
  
  init() {
    setupCalendarChangeObserver()
    // Start monitoring for authorization status changes
    NotificationCenter.default.addObserver(
      self,
      selector: #selector(handleAuthorizationStatusChange),
      name: NSNotification.Name(rawValue: "EKAuthorizationStatusDidChangeNotification"),
      object: nil
    )
  }
  
  deinit {
    removeCalendarChangeObserver()
    NotificationCenter.default.removeObserver(self, name: NSNotification.Name(rawValue: "EKAuthorizationStatusDidChangeNotification"), object: nil)
  }
  
  func setCalendarChangedCallback(_ callback: @escaping () -> Void) {
      self.onCalendarChanged = callback
  }
  
  // Handle authorization status changes
  @objc private func handleAuthorizationStatusChange() {
    print("Calendar authorization status changed")
    let status = EKEventStore.authorizationStatus(for: .event)
    if status == .authorized {
      print("Calendar access now authorized, triggering callback")
      handleCalendarChanged()
    } else {
      print("Calendar access status changed to: \(status)")
    }
  }
  
  // No longer directly requesting access - permissions are handled by React Native
  func requestAccess() async -> Bool {
    // This method is kept for compatibility but no longer requests permissions directly
    // It just returns the current status
    return EKEventStore.authorizationStatus(for: .event) == .authorized
  }
  
  func fetchUpcomingEvents(days: Int = 7) async -> [EKEvent]? {
    // Check calendar authorization status
    let status = EKEventStore.authorizationStatus(for: .event)
    
    switch status {
    case .authorized:
      return fetchEvents(days: days)
    case .notDetermined, .denied, .restricted:
      // No longer requesting access here - will just return nil if not authorized
      print("Calendar access not authorized")
      return nil
    default:
      print("Calendar access not authorized")
      return nil
    }
  }
  
  private func fetchEvents(days: Int) -> [EKEvent] {
    // Create date range (now to X days in the future)
    let startDate = Date()
    let endDate = Calendar.current.date(byAdding: .day, value: days, to: startDate)!
    
    // Create the predicate to fetch events
    let predicate = eventStore.predicateForEvents(withStart: startDate, end: endDate, calendars: nil)
    
    // Fetch events
    let events = eventStore.events(matching: predicate)
    let sortedEvents = events.sorted { $0.startDate < $1.startDate }// soonest events are the first
    
    // filter out events that started more than 3 hours ago:
    let threeHoursAgo = Calendar.current.date(byAdding: .hour, value: -3, to: Date())!
    let filteredEvents = sortedEvents.filter { event in
        return event.startDate > threeHoursAgo
    }
    
    return filteredEvents
  }
  
  // Helper method to format events for display
  func formatEvent(_ event: EKEvent) -> String {
    let dateFormatter = DateFormatter()
    dateFormatter.dateStyle = .short
    dateFormatter.timeStyle = .short
    
    var eventInfo = "📅 \(event.title ?? "Untitled Event")\n"
    eventInfo += "📆 \(dateFormatter.string(from: event.startDate)) - \(dateFormatter.string(from: event.endDate))\n"
    
    if let location = event.location, !location.isEmpty {
      eventInfo += "📍 \(location)\n"
    }
    
    if let notes = event.notes, !notes.isEmpty {
      eventInfo += "📝 \(notes)\n"
    }
    
    return eventInfo
  }
  
  // MARK: - Calendar Change Observer
  
  private func setupCalendarChangeObserver() {
      // Remove any existing observer first
      removeCalendarChangeObserver()
      
      // Register for EKEventStore change notifications
      calendarObserver = NotificationCenter.default.addObserver(
          forName: .EKEventStoreChanged,
          object: eventStore,
          queue: .main
      ) { [weak self] _ in
          print("Calendar database changed")
          self?.handleCalendarChanged()
      }
  }
  
  private func removeCalendarChangeObserver() {
      if let observer = calendarObserver {
          NotificationCenter.default.removeObserver(observer)
          calendarObserver = nil
      }
  }
  
  private func handleCalendarChanged() {
      // Call the calendar changed callback if set
      if let callback = onCalendarChanged {
          callback()
      }
  }
}
