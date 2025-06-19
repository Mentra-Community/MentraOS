// src/telemetry/PostHogTransport.ts
import Transport from 'winston-transport'          // <–– base class :contentReference[oaicite:1]{index=1}
import { posthog } from './posthog'

export interface PostHogTransportOpts extends Transport.TransportStreamOptions {
	captureExceptions?: boolean          // also call posthog.captureException
}

export class PostHogTransport extends Transport {
	private readonly captureExceptions: boolean

	constructor(opts: PostHogTransportOpts = {}) {
		super(opts)
		this.captureExceptions = opts.captureExceptions ?? true
	}

	log(info: any, callback: () => void) {
		setImmediate(() => this.emit('logged', info))  // Winston boiler-plate

		const { level, message, stack, error, service, ...rest } = info

		// Extract service name from log message using regex pattern
		const serviceMatch = typeof message === 'string' ? message.match(/\[(.+\.service)\]:? ?([\s\S]+)/) : null;
		const serviceName = serviceMatch ? serviceMatch[1] : (service==="unknown-service" ? undefined : service);
		const remaining_message = serviceMatch ? serviceMatch[2] : message;

		if (posthog) {
			if ((level === 'error' || level === 'warn') || (error instanceof Error || info instanceof Error)) {
				const error_message = `[${level}]: ${remaining_message ?? error?.message}`;
				const error_info = {
					level: level,
					service: serviceName,
					stack: stack ?? error?.stack,
					message: error_message,
					...rest,
				}
				posthog.captureException(error_info, rest.userId || 'system', {
					level: level,
					service: serviceName,
					stack: stack ?? error?.stack,
					message: error_message,
					...rest,
				})
			} else {
				posthog.capture({
					distinctId: rest.userId || 'system',
					event: `$LOG ${level}`,
					properties: {
						message: remaining_message,
						service: serviceName,
						level,
						stack: stack ?? (error?.stack as string | undefined),
						timestamp: Date.now(),
						...rest,
					},
				})
			}
		}

		callback()
	}

	async close() {
		if (posthog) {
			await posthog.shutdown()
		}
	}
}
