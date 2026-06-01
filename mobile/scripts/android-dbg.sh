adb reverse tcp:8081 tcp:8081

adb devices -l
# then watch for it bouncing:
while true; do adb devices; sleep 1; done


# cpu usage:
adb shell top -H -p $(adb shell pidof com.mentra.mentra)

# memory usage:
adb shell dumpsys meminfo com.mentra.mentra


adb shell input keyevent 82