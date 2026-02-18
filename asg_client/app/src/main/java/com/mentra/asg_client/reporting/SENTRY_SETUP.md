# Sentry Configuration Setup

This document explains how Sentry error reporting is configured in the ASG Client project.

## Configuration Files

The Sentry configuration is loaded from multiple sources in order of priority:

1. **Environment Variables** (highest priority)
   - `SENTRY_DSN` - Sentry DSN URL
   - `SENTRY_ENABLED` - Enable/disable Sentry (true/false)
   - `SENTRY_SAMPLE_RATE` - Sample rate (0.0 to 1.0)
   - `SENTRY_ENVIRONMENT` - Environment name
   - `SENTRY_RELEASE` - Release version

2. **Properties Files** (medium priority)
   - `sentry.properties.development` - Development config (in .gitignore)
   - `sentry.properties` - Fallback config
   - `config.properties` - General config

3. **BuildConfig** (lowest priority)
   - Set during build time via Gradle

## Files Structure

```
app/src/main/assets/
├── sentry.properties              # Main config file (committed)
├── sentry.properties.example      # Example config (committed)
├── sentry.properties.development  # Development config (.gitignore)
└── .gitignore                     # Git ignore rules
```

## Configuration Example

```properties
# Sentry DSN (Data Source Name)
sentry.dsn=https://your-dsn@sentry.io/your-project

# Enable Sentry
sentry.enabled=true

# Sample rate for error reporting (0.0 to 1.0)
sentry.sample_rate=0.1

# Environment name
sentry.environment=development

# Release version
sentry.release=1.0.0
```

## Troubleshooting

### "Unable to load Sentry configurations"

This error occurs when the configuration files cannot be loaded. Check:

1. **File exists**: Ensure `sentry.properties.development` exists in `app/src/main/assets/`
2. **File permissions**: Check file read permissions
3. **File format**: Ensure properties file format is correct
4. **DSN validity**: Verify the DSN URL is valid

### Debug Steps

1. Check logs for configuration status:

   ```
   adb logcat | grep SentryConfig
   ```

2. Verify file loading:

   ```
   adb logcat | grep "Successfully loaded properties"
   ```

3. Check Sentry initialization:
   ```
   adb logcat | grep SentryReportProvider
   ```

### Common Issues

1. **Missing .env file**: The code was looking for a `.env` file but now uses `sentry.properties.development`
2. **Invalid DSN**: Ensure the DSN URL is correct and accessible
3. **Network issues**: Sentry requires internet access to send reports
4. **Build issues**: Ensure Sentry SDK dependency is included in build.gradle

## Security Notes

- Never commit actual DSNs to version control
- Use environment variables for production deployments
- The `sentry.properties.development` file is in `.gitignore`
- Sensitive data is filtered by the `DataFilter` utility

## Testing

The app includes a test method in `MainActivity.testSentryConfiguration()` that:

- Logs configuration status
- Sends a test message to Sentry
- Reports provider status

Run the app and check logs to verify Sentry is working correctly.
