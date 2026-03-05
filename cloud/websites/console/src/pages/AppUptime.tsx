import React, { useState, useMemo } from "react";
import {
  CheckCircle,
  AlertCircle,
  XCircle,
  Loader2,
  Clock,
  ChevronLeft,
  ChevronRight,
} from "lucide-react";
import { Badge, Button, Card } from "@mentra/shared";
import { UptimeStreakBar } from "@/components/ui/upTimeStreakBar";
import { DatePicker } from "@/components/ui/date-picker";

// Removed unused month constants

// Define the data structures using TypeScript interfaces
interface UptimeEvent {
  date: string;
  duration: number; // in minutes
  reason: string;
  details: string;
}

interface AppStatus {
  id: string;
  name: string;
  logo: string;
  packageName?: string;
  submitted: string;
  uptimePercentage: number;
  status: "Online" | "Offline";
  uptimeHistory: string[];
  details: {
    last24h: number;
    last7d: number;
    last30d: number;
    last90d: number;
    events: UptimeEvent[];
  };
}

// Mock data removed - using real data from appItems

// Removed fake random data generation - using real appItems data

// Removed unused UptimeBar and Legend components

// Status Badge Component
const StatusBadge: React.FC<{ status: string }> = ({ status }) => {
  const getStatusColor = () => {
    switch (status.toLowerCase()) {
      case "healthy":
      case "online":
      case "operational":
        return "bg-green-500";
      default:
        return "bg-red-600";
    }
  };

  const getStatusText = () => {
    switch (status.toLowerCase()) {
      case "healthy":
      case "online":
      case "operational":
        return "Online";
      default:
        return "Offline";
    }
  };

  return (
    <Badge variant="outline" className="text-xs w-17">
      <div className={`w-2 h-2 rounded-full ${getStatusColor()}`}></div>
      <span>{getStatusText()}</span>
    </Badge>
  );
};

// Removed MonthlyUptimeChart component - using real data in AppUptimeChart instead

// Component for the detailed view of a single app

interface AppBatchItem {
  packageName: string;
  timestamp: string;
  health: string;
  onlineStatus: boolean;
}

interface AppDetailViewProps {
  app: AppStatus;
  onRefresh?: () => void;
  isRefreshing?: boolean;
  appItems: AppBatchItem[];
  selectedDay?: number | null;
  selectedDayItems?: AppBatchItem[];
  currentMonth?: number;
  currentYear?: number;
  lastUpdateTime?: Date | null;
}

const AppDetailView: React.FC<AppDetailViewProps> = ({
  app,
  onRefresh,
  isRefreshing = false,
  appItems,
  selectedDay,
  selectedDayItems,
  currentMonth,
  currentYear,
  lastUpdateTime,
}) => {
  const [dayFilterState, setDayFilterState] = useState<{
    selectedDay: number | null;
    selectedDayItems: AppBatchItem[];
    currentMonth: number;
    currentYear: number;
  }>({
    selectedDay: null,
    selectedDayItems: [],
    currentMonth: new Date().getMonth(),
    currentYear: new Date().getFullYear(),
  });

  const handleDaySelection = (
    day: number | null,
    items: AppBatchItem[],
    month: number,
    year: number,
  ) => {
    setDayFilterState({
      selectedDay: day,
      selectedDayItems: items,
      currentMonth: month,
      currentYear: year,
    });
  };

  return (
    <div className="  flex   p-4 font-sans">
      <div className="w-full max-w-4xl mx-auto">
        <Card className="p-8 bg-white text-black font-sans">
          <div className="flex flex-row items-center">
            <div className="flex flex-col flex-1">
              <div className="text-3xl font-bold">
                Service Status {app.status}
              </div>
              <div className="text-sm text-gray-500">
                Last updated{" "}
                {lastUpdateTime ? lastUpdateTime.toLocaleTimeString() : "Never"}
              </div>
            </div>
            {onRefresh && (
              <Button
                className="w-[100px]"
                onClick={onRefresh}
                disabled={isRefreshing}
              >
                {isRefreshing ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <>
                    <Clock className="h-4 w-4" />
                    <div>Update</div>
                  </>
                )}
              </Button>
            )}
          </div>

          <div className="p-4 md:p-6 rounded-2xl shadow-sm flex flex-col sm:flex-row items-start sm:items-center gap-4">
            <div className="flex-shrink-0">
              <img
                src={app.logo}
                alt={`${app.name} logo`}
                className="w-16 h-16 md:w-20 md:h-20 lg:w-24 lg:h-24 rounded-[15px] object-cover aspect-square"
              />
            </div>
            <div className="flex-1 min-w-0">
              <h2 className="text-lg sm:text-xl md:text-2xl font-bold m-0 truncate">
                {app.name}
              </h2>
              <p className="text-xs sm:text-sm text-gray-500 truncate">
                Submitted on {app.submitted}
              </p>
              <p className="text-xs sm:text-sm text-gray-500 truncate">
                {app.packageName || "N/A"}
              </p>
            </div>
            <div className="flex flex-col sm:flex-row gap-2 sm:gap-4 items-center w-full sm:w-auto">
              {app.status.toLowerCase() === "online" ? (
                <CheckCircle className="w-8 h-8 sm:w-10 sm:h-10 md:w-12 md:h-12 text-green-500 flex-shrink-0" />
              ) : (
                <XCircle className="w-8 h-8 sm:w-10 sm:h-10 md:w-12 md:h-12 text-red-500 flex-shrink-0" />
              )}
              <div className="text-center sm:text-left">
                <h2 className="text-sm sm:text-base md:text-lg lg:text-xl font-bold m-0">
                  {app.status.toLowerCase() === "online"
                    ? "All systems operational"
                    : "System experiencing issues"}
                </h2>
                <p className="text-xs sm:text-sm text-gray-500">
                  {app.status.toLowerCase() === "online"
                    ? ``
                    : `Current status: ${app.status} - Check events below`}
                </p>
              </div>
            </div>
          </div>

          {/* App Uptime Chart */}
          <AppUptimeChart
            appItems={appItems}
            onDaySelection={handleDaySelection}
          />

          {dayFilterState.selectedDay && (
            <div className="rounded-2xl">
              <div className="flex items-center gap-4 mb-6">
                <h3 className="text-2xl font-bold text-red-700 flex items-center gap-2">
                  <AlertCircle size={28} className="text-red-500" />
                  Problems
                </h3>
                {dayFilterState.selectedDay && (
                  <div className="bg-red-100 border border-red-200 px-3 py-1 rounded-full text-sm font-medium text-red-700">
                    Day {dayFilterState.selectedDay},{" "}
                    {new Date(
                      dayFilterState.currentYear,
                      dayFilterState.currentMonth,
                    ).toLocaleString("default", {
                      month: "long",
                      year: "numeric",
                    })}
                  </div>
                )}
              </div>

              {/* Show selected day items if a day is selected */}
              {dayFilterState.selectedDay ? (
                // Check if there are any actual unhealthy items for this day
                dayFilterState.selectedDayItems.some(
                  (item) => item.health !== "healthy" || !item.onlineStatus,
                ) ? (
                  // Show unhealthy items
                  dayFilterState.selectedDayItems
                    .filter(
                      (item) => item.health !== "healthy" || !item.onlineStatus,
                    )
                    .map((item, index) => (
                      <div
                        key={index}
                        className="bg-red-50 border border-red-200 flex items-center gap-6 mb-4 p-4 rounded-lg hover:bg-red-100 transition-colors duration-200"
                      >
                        <AlertCircle
                          size={24}
                          className="text-red-500 flex-shrink-0"
                        />
                        <div className="flex flex-1 items-center justify-between">
                          <div className="flex items-center gap-8">
                            <div>
                              <p className="font-semibold text-red-800">
                                {item.packageName} - Unhealthy Status
                              </p>
                              <p className="text-sm text-red-600">
                                {new Date(item.timestamp).toLocaleString()}
                              </p>
                            </div>
                            <div className="flex gap-6">
                              <div>
                                <span className="text-xs font-medium text-red-700 uppercase tracking-wide">
                                  Health
                                </span>
                                <p className="text-sm text-red-600 font-medium">
                                  {item.health}
                                </p>
                              </div>
                              <div>
                                <span className="text-xs font-medium text-red-700 uppercase tracking-wide">
                                  Status
                                </span>
                                <p className="text-sm text-red-600 font-medium">
                                  {item.onlineStatus ? "Online" : "Offline"}
                                </p>
                              </div>
                            </div>
                          </div>
                        </div>
                      </div>
                    ))
                ) : (
                  // Show "no issues" message for healthy days (whether they have items or not)
                  <div className="bg-green-50 border border-green-200 flex items-center gap-6 mb-4 p-4 rounded-lg">
                    <CheckCircle
                      size={24}
                      className="text-green-500 flex-shrink-0"
                    />
                    <div className="flex flex-1 items-center justify-between">
                      <div className="flex items-center gap-8">
                        <div>
                          <p className="font-semibold text-green-800">
                            No issues found for this day
                          </p>
                          <p className="text-sm text-green-600">
                            All systems were operational
                          </p>
                        </div>
                      </div>
                    </div>
                  </div>
                )
              ) : null}
            </div>
          )}
        </Card>
      </div>
    </div>
  );
};

// App Uptime Chart Component with Month Navigation
interface AppUptimeChartProps {
  appItems: AppBatchItem[];
  onMonthYearChange?: (month: number, year: number) => void;
  setMonthNumberDynamic?: (monthName: number) => void;
  setYearNumber?: (yearNumber: number) => void;
  currentMonth?: number;
  onDaySelection?: (
    day: number | null,
    items: AppBatchItem[],
    month: number,
    year: number,
  ) => void;
}

const AppUptimeChart: React.FC<AppUptimeChartProps> = ({
  appItems,
  onMonthYearChange,
  setMonthNumberDynamic,
  setYearNumber,
  onDaySelection,
}) => {
  const [currentDate, setCurrentDate] = useState(new Date());
  const [selectedDay, setSelectedDay] = useState<number | null>(null);
  const [selectedDayItems, setSelectedDayItems] = useState<AppBatchItem[]>([]);

  // Get current month and year
  const monthName = currentDate.toLocaleString("default", { month: "long" });
  const year = currentDate.getFullYear();

  // Calculate days in current month
  const daysInMonth = new Date(year, currentDate.getMonth() + 1, 0).getDate();

  // Handle day selection from streak bar
  const handleDayClick = (day: number, itemsForDay: AppBatchItem[]) => {
    setSelectedDay(day);
    setSelectedDayItems(itemsForDay);
    if (onDaySelection) {
      onDaySelection(
        day,
        itemsForDay,
        currentDate.getMonth(),
        currentDate.getFullYear(),
      );
    }
  };

  // Navigate to previous month
  const handlePreviousMonth = () => {
    setCurrentDate((prevDate) => {
      const newDate = new Date(prevDate);
      newDate.setMonth(newDate.getMonth() - 1);
      return newDate;
    });
    // Reset day selection when changing months
    setSelectedDay(null);
    setSelectedDayItems([]);
  };

  // Navigate to next month
  const handleNextMonth = () => {
    setCurrentDate((prevDate) => {
      const newDate = new Date(prevDate);
      newDate.setMonth(newDate.getMonth() + 1);
      return newDate;
    });
    // Reset day selection when changing months
    setSelectedDay(null);
    setSelectedDayItems([]);
  };

  // Calculate uptime percentage from appItems
  const calculateUptimePercentage = () => {
    if (!appItems || appItems.length === 0) return 0;

    // Get items from current month
    const currentMonthItems = appItems.filter((item) => {
      const itemDate = new Date(item.timestamp);
      return (
        itemDate.getMonth() === currentDate.getMonth() &&
        itemDate.getFullYear() === currentDate.getFullYear()
      );
    });

    if (currentMonthItems.length === 0) return 0;

    const upItems = currentMonthItems.filter(
      (item) => item.onlineStatus === true || item.health === "healthy",
    );

    return ((upItems.length / currentMonthItems.length) * 100).toFixed(1);
  };

  const uptimePercentage = calculateUptimePercentage();

  return (
    <div className="rounded-lg p-2">
      <div className="flex flex-row items-center justify-between relative mb-4">
        <div className="text-[22px] font-bold ">
          <div className="flex items-center gap-3">
            <span className="text-lg font-medium">
              {uptimePercentage}% Uptime
            </span>
          </div>
        </div>
        <div className="flex items-center gap-6 text-sm">
          <div className="flex items-center gap-2">
            <div className="w-3 h-3 bg-green-500 rounded-sm"></div>
            <span className="text-gray-700">All Healthy</span>
          </div>
          <div className="flex items-center gap-2">
            <div className="w-3 h-3 bg-yellow-500 rounded-sm"></div>
            <span className="text-gray-700">Mixed Status</span>
          </div>
          <div className="flex items-center gap-2">
            <div className="w-3 h-3 bg-red-500 rounded-sm"></div>
            <span className="text-gray-700">All Unhealthy</span>
          </div>
          <div className="flex items-center gap-2">
            <div className="w-3 h-3 bg-gray-300 rounded-sm"></div>
            <span className="text-gray-700">No Data</span>
          </div>
        </div>
      </div>
      <div className="flex flex-row gap-0.5 justify-between items-center">
        <UptimeStreakBar
          appItems={appItems}
          dayCount={daysInMonth}
          title="Daily Status Overview"
          barWidth="w-4.5"
          barHeight="h-10"
          containerWidth="w-full"
          containerHeight="h-auto"
          currentMonth={currentDate.getMonth()}
          currentYear={currentDate.getFullYear()}
          selectedDay={selectedDay}
          onDayClick={handleDayClick}
        />
        <div className="text-base font-bold ml-4 text-gray-500">
          <DatePicker
            className="w-42 bg-gray-50 h-10.5 rounded-[7px] text-black"
            initialYear={year}
            initialMonth={currentDate.getMonth()}
            setMonthNumberDynamic={setMonthNumberDynamic}
            setYearNumber={setYearNumber}
            onNextMonth={handleNextMonth}
            onPrevMonth={handlePreviousMonth}
          />
        </div>
      </div>
    </div>
  );
};

export default AppDetailView;
