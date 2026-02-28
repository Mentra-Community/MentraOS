package main

import (
	"os"
)

// Config holds the service configuration
type Config struct {
	Port             string
	LiveKitURL       string
	LiveKitAPIKey    string
	LiveKitAPISecret string
	LogLevel         string
	PublishGain      float64
}

// loadConfig loads configuration from environment variables
func loadConfig() *Config {
	config := &Config{
		Port:             getEnv("PORT", "9090"),
		LiveKitURL:       getEnv("LIVEKIT_URL", ""),
		LiveKitAPIKey:    getEnv("LIVEKIT_API_KEY", ""),
		LiveKitAPISecret: getEnv("LIVEKIT_API_SECRET", ""),
		LogLevel:         getEnv("LOG_LEVEL", "info"),
		PublishGain:      1.0,
	}

	return config
}

// getEnv gets an environment variable with a default fallback
func getEnv(key, defaultValue string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return defaultValue
}
