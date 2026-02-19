import { BaseWidget, WidgetData } from './Widget';
import DisplayFormatter from '../DisplayFormatter';

interface WeatherData extends WidgetData {
  current?: {
    condition?: string;
    temperature?: number;
    feelsLike?: number;
  };
  forecast?: {
    high?: number;
    low?: number;
  };
  output?: string;
}

export class WeatherWidget extends BaseWidget {
  id = 'weather';
  name = 'Weather';
  refreshInterval = 3600; // 1 hour

  async fetchData(): Promise<WeatherData> {
    try {
      // Use weather.gov API (free, no key required)
      // Columbus, OH coordinates
      const lat = 40.0;
      const lon = -83.0;
      
      const response = await fetch(
        `https://api.weather.gov/points/${lat},${lon}`
      );
      
      if (!response.ok) {
        throw new Error('Weather API failed');
      }
      
      const pointData = await response.json();
      const forecastUrl = pointData.properties.forecast;
      
      const forecastResponse = await fetch(forecastUrl);
      const forecastData = await forecastResponse.json();
      
      const current = forecastData.properties.periods[0];
      
      return {
        current: {
          condition: current.shortForecast,
          temperature: current.temperature,
        },
        forecast: {
          high: current.temperature,
          low: forecastData.properties.periods[1]?.temperature || current.temperature - 10,
        },
      };
    } catch (error) {
      console.error('[WeatherWidget] Error fetching data:', error);
      return {};
    }
  }

  formatDisplay(data: WeatherData): string {
    if (!data.output && !data.current) {
      return this.formatEmpty();
    }

    // If we have raw output, parse it
    if (data.output) {
      return this.formatFromOutput(data.output);
    }

    // Otherwise format from structured data
    return this.formatFromStructured(data);
  }

  private formatEmpty(): string {
    const lines = [
      '☀️ WEATHER',
      'No data available',
      '',
      '',
      ''
    ];
    return lines.join('\n');
  }

  private formatFromOutput(output: string): string {
    const lines: string[] = [];
    
    lines.push('☀️ WEATHER');
    
    // Parse temperature and condition
    const tempMatch = output.match(/(\d+)°[FC]/);
    const conditionMatch = output.match(/(Sunny|Cloudy|Rainy|Clear|Partly Cloudy|Overcast|Snow|Fog)/i);
    
    if (tempMatch && conditionMatch) {
      lines.push(`${conditionMatch[1]}, ${tempMatch[0]}`);
    } else if (tempMatch) {
      lines.push(`${tempMatch[0]}`);
    } else {
      lines.push(DisplayFormatter['truncate'](output.split('\n')[0], 40));
    }
    
    // Parse high/low
    const highLowMatch = output.match(/High[:\s]+(\d+).*Low[:\s]+(\d+)/i);
    if (highLowMatch) {
      lines.push(`High ${highLowMatch[1]}° / Low ${highLowMatch[2]}°`);
    } else {
      lines.push('');
    }
    
    lines.push('');
    
    // Add contextual message
    if (conditionMatch) {
      const condition = conditionMatch[1].toLowerCase();
      if (condition.includes('rain')) {
        lines.push('Bring an umbrella!');
      } else if (condition.includes('sunny') || condition.includes('clear')) {
        lines.push('Great day outside!');
      } else if (condition.includes('snow')) {
        lines.push('Bundle up!');
      } else {
        lines.push('');
      }
    } else {
      lines.push('');
    }

    return lines.slice(0, 5).join('\n');
  }

  private formatFromStructured(data: WeatherData): string {
    const lines: string[] = [];
    
    lines.push('☀️ WEATHER');
    
    if (data.current) {
      const condition = data.current.condition || 'Unknown';
      const temp = data.current.temperature || 0;
      lines.push(`${condition}, ${temp}°F`);
    } else {
      lines.push('');
    }
    
    if (data.forecast) {
      const high = data.forecast.high || 0;
      const low = data.forecast.low || 0;
      lines.push(`High ${high}° / Low ${low}°`);
    } else {
      lines.push('');
    }
    
    lines.push('');
    
    // Contextual message based on temperature
    if (data.current?.temperature) {
      const temp = data.current.temperature;
      if (temp > 80) {
        lines.push('Stay hydrated!');
      } else if (temp < 40) {
        lines.push('Bundle up!');
      } else {
        lines.push('Perfect weather!');
      }
    } else {
      lines.push('');
    }

    return lines.join('\n');
  }
}
