@echo off
REM Fix React Native library symlinks for Windows users
REM This script creates symlinks to avoid node command execution during Android builds
REM Automatically runs after npm install via postinstall script

setlocal enabledelayedexpansion

REM Check if node_modules exists
if not exist "node_modules" (
    echo 💡 No node_modules directory found, skipping symlink creation
    exit /b 0
)

echo 🔧 Creating React Native symlinks to avoid node command execution...

REM Change to script directory
cd /d "%~dp0"

REM Counter for created symlinks
set count=0

REM Create symlinks for all react-native-* libraries
for /d %%d in (node_modules\react-native-*) do (
    REM Check if the directory exists and create node_modules subfolder if needed
    if exist "%%d" (
        if not exist "%%d\node_modules" (
            mkdir "%%d\node_modules" 2>nul
        )

        REM Check if symlink doesn't already exist
        if not exist "%%d\node_modules\react-native" (
            REM Create symbolic link (requires admin privileges or developer mode)
            mklink /D "%%d\node_modules\react-native" "..\..\react-native" >nul 2>&1
            if !errorlevel! equ 0 (
                echo   ✅ Created symlink for %%d
                set /a count+=1
            ) else (
                REM Fallback: try junction if mklink fails
                mklink /J "%%d\node_modules\react-native" "..\..\react-native" >nul 2>&1
                if !errorlevel! equ 0 (
                    echo   ✅ Created junction for %%d
                    set /a count+=1
                ) else (
                    echo   ❌ Failed to create symlink/junction for %%d
                    echo      💡 Try running as administrator or enabling Developer Mode
                )
            )
        )
    )
)

if !count! equ 0 (
    echo 💡 All React Native symlinks already exist or none were needed
) else (
    echo 🎉 Created !count! React Native symlinks successfully!
)

echo 💡 This fixes the 'command node not found' error during Android builds.
echo 💡 If symlinks failed, try running as administrator or enabling Windows Developer Mode.

endlocal