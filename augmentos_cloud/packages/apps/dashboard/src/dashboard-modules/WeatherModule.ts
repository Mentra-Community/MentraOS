import axios from 'axios';
import { logger } from '@augmentos/utils';

export interface WeatherSummary {
  condition: string;
  temp_f: number;
  temp_c: number;
}

export class WeatherModule {
  private apiKey: string;
  private baseUrl: string;

  constructor() {
    this.apiKey = "53394e85a9b325c2f46e7e097859a7b8";
    this.baseUrl = 'https://api.openweathermap.org';
    logger.info('🌤️ WeatherModule initialized');
  }

  /**
   * Fetch the current weather condition and temperature in Fahrenheit.
   */
  public async fetchWeatherForecast(latitude: number, longitude: number): Promise<WeatherSummary | null> {
    const url = `${this.baseUrl}/data/3.0/onecall?lat=${latitude}&lon=${longitude}&exclude=minutely,hourly,daily,alerts&units=imperial&appid=${this.apiKey}`;
    logger.info(`🌤️ Fetching weather data for lat=${latitude}, lon=${longitude}`);
    
    try {
      const response = await axios.get(url);
      const data = response.data;
      
      if (!data || !data.current || !data.current.weather || data.current.weather.length === 0) {
        logger.error('❌ Unexpected weather API response structure:', data);
        return null;
      }

      console.log(`[Weather] Data: ${JSON.stringify(data)}`);

      const tempF = Math.round(data.current.temp);
      // Convert Fahrenheit to Celsius: (F - 32) * 5/9
      const tempC = Math.round((data.current.temp - 32) * 5/9);

      console.log(`[Weather] Temp F: ${tempF}, Temp C: ${tempC}`);

      return {
        condition: data.current.weather[0].main,
        temp_f: tempF,
        temp_c: tempC,
      };
    } catch (error) {
      logger.error('❌ Error fetching weather data:', error);
      return null;
    }
  }
}
