/**
 * @fileoverview Core WebSocket service that initializes and manages WebSocket servers.
 * This service handles connection upgrade requests and routes them to the appropriate
 * specialized handlers for glasses clients and Apps.
 */

import WebSocket from "ws";
import { Server } from "http";
import jwt, { JwtPayload } from "jsonwebtoken";
import { CloudToGlassesMessageType } from "@mentra/sdk";
import { GlassesWebSocketService } from "./websocket-glasses.service";
import { AppWebSocketService } from "./websocket-app.service";
import { logger } from "../logging/pino-logger";
import { UserSession } from "../session/UserSession";

// Environment variables
const AUGMENTOS_AUTH_JWT_SECRET = process.env.AUGMENTOS_AUTH_JWT_SECRET || "";

/**
 * Core WebSocket service that manages WebSocket server instances
 * and routes connections to the appropriate handlers
 */
export class WebSocketService {
  private glassesWss: WebSocket.Server;
  private appWss: WebSocket.Server;
  private glassesHandler: GlassesWebSocketService;
  private appHandler: AppWebSocketService;
  private static instance: WebSocketService;

  /**
   * Private constructor to ensure singleton pattern
   */
  private constructor() {
    this.glassesWss = new WebSocket.Server({ noServer: true });
    this.appWss = new WebSocket.Server({ noServer: true });

    this.glassesHandler = GlassesWebSocketService.getInstance();
    this.appHandler = AppWebSocketService.getInstance();

    // Set up connection handlers
    this.glassesWss.on("connection", (ws, request) => {
      logger.info("New glasses WebSocket connection established");
      this.glassesHandler.handleConnection(ws, request).catch((error) => {
        logger.error(error, "Error handling glasses connection");
      });
    });

    this.appWss.on("connection", (ws, request) => {
      logger.info("New App WebSocket connection established");
      this.appHandler.handleConnection(ws, request).catch((error) => {
        logger.error(
          {
            error: {
              name: error.name,
              message: error.message,
              stack: error.stack,
            },
          },
          "Error handling App connection",
        );
      });
    });
  }

  /**
   * Get singleton instance
   */
  public static getInstance(): WebSocketService {
    if (!WebSocketService.instance) {
      WebSocketService.instance = new WebSocketService();
    }
    return WebSocketService.instance;
  }

  /**
   * Send an app started message to the glasses client
   */
  public sendAppStarted(userSession: UserSession, packageName: string) {
    if (userSession.websocket && userSession.websocket.readyState === 1) {
      const appStartedMessage = {
        type: "app_started",
        packageName: packageName,
        timestamp: new Date(),
      };
      userSession.websocket.send(JSON.stringify(appStartedMessage));
      logger.info(
        `Sent app_started message to ${userSession.userId} for app ${packageName}`,
      );
    } else {
      logger.warn(
        `Cannot send app_started message: WebSocket not ready for user ${userSession.userId}`,
      );
    }
  }

  /**
   * Send an app stopped message to the glasses client
   */
  public sendAppStopped(userSession: UserSession, packageName: string) {
    if (userSession.websocket && userSession.websocket.readyState === 1) {
      const appStoppedMessage = {
        type: "app_stopped",
        packageName: packageName,
        timestamp: new Date(),
      };
      userSession.websocket.send(JSON.stringify(appStoppedMessage));
      logger.info(
        `Sent app_stopped message to ${userSession.userId} for app ${packageName}`,
      );
    } else {
      logger.warn(
        `Cannot send app_stopped message: WebSocket not ready for user ${userSession.userId}`,
      );
    }
  }

  /**
   * Set up WebSocket servers and attach them to the HTTP server
   *
   * @param server HTTP/HTTPS server instance
   */
  setupWebSocketServers(server: Server): void {
    server.on("upgrade", (request, socket, head) => {
      try {
        const url = new URL(
          request.url || "",
          `http://${request.headers.host}`,
        );

        // Log detailed information about the upgrade request
        logger.debug(
          {
            path: url.pathname,
            headers: {
              host: request.headers.host,
              origin: request.headers.origin,
              upgrade: request.headers.upgrade,
              connection: request.headers.connection,
              secWebSocketKey:
                request.headers["sec-websocket-key"]?.substring(0, 10) + "...",
              secWebSocketVersion: request.headers["sec-websocket-version"],
              authorization: request.headers.authorization
                ? "Present"
                : "Missing",
              sessionId: request.headers["x-session-id"] || "N/A",
              userId: request.headers["x-user-id"] || "N/A",
            },
            remoteAddress: request.socket.remoteAddress,
          },
          "WebSocket upgrade request received",
        );

        // Route to appropriate handler based on path
        if (url.pathname === "/glasses-ws") {
          logger.debug("Processing glasses-ws upgrade request");

          try {
            // Extract JWT token from Authorization header for glasses
            const queryParams = url.searchParams;
            const coreTokenQueryParam = queryParams.get("token");
            const coreToken =
              request.headers.authorization?.split(" ")[1] ||
              coreTokenQueryParam;
            logger.debug(
              { feature: "websocket" },
              `Glasses core token: ${
                coreToken ? coreToken.substring(0, 10) + "..." : "None"
              }`,
            );

            if (!coreToken) {
              logger.error("No core token provided in request headers");
              socket.write(
                "HTTP/1.1 401 Unauthorized\r\n" +
                  "Content-Type: application/json\r\n" +
                  "\r\n" +
                  JSON.stringify({
                    type: CloudToGlassesMessageType.CONNECTION_ERROR,
                    message: "No core token provided",
                    timestamp: new Date(),
                  }),
              );
              socket.destroy();
              return;
            }

            // Verify the JWT token
            try {
              const userData = jwt.verify(coreToken, AUGMENTOS_AUTH_JWT_SECRET);
              const userId = (userData as JwtPayload).email;
              if (!userId) {
                throw new Error("User ID is required");
              }

              // Attach the userId to the request for use by the handler
              (request as any).userId = userId;

              // Check for LiveKit preference in headers
              const livekitQueryParam = queryParams.get("livekit");
              const livekitHeader = request.headers["livekit"];
              const livekitPreference =
                livekitHeader === "true" || livekitQueryParam === "true";
              (request as any).livekitRequested = livekitPreference;

              if (livekitPreference) {
                logger.info(
                  { userId, feature: "livekit" },
                  "Client requested LiveKit transport",
                );
              }

              // If validation successful, proceed with connection
              this.glassesWss.handleUpgrade(request, socket, head, (ws) => {
                logger.debug("Glasses WebSocket upgrade successful");
                this.glassesWss.emit("connection", ws, request);
              });
            } catch (jwtError) {
              logger.error(jwtError, "Error verifying glasses JWT token:");
              socket.write(
                "HTTP/1.1 401 Unauthorized\r\n" +
                  "Content-Type: application/json\r\n" +
                  "\r\n" +
                  JSON.stringify({
                    type: CloudToGlassesMessageType.CONNECTION_ERROR,
                    message: "Invalid core token",
                    timestamp: new Date(),
                  }),
              );
              socket.destroy();
            }
          } catch (upgradeError) {
            logger.error(
              {
                error: upgradeError,
              },
              "Failed to upgrade glasses WebSocket connection",
            );
            socket.destroy();
          }
        } else if (url.pathname === "/app-ws") {
          logger.debug("Processing app-ws upgrade request");

          try {
            // Check for JWT in Authorization header (new approach)
            const authHeader = request.headers.authorization;
            const userId = request.headers["x-user-id"];
            const sessionId = request.headers["x-session-id"];

            if (authHeader && authHeader.startsWith("Bearer ")) {
              const appJwt = authHeader.substring(7);

              // Ensure userId and sessionId are present in headers.
              if (!userId || !sessionId) {
                logger.error("Missing userId or sessionId in request headers");
                socket.write(
                  "HTTP/1.1 401 Unauthorized\r\n" +
                    "Content-Type: application/json\r\n" +
                    "\r\n" +
                    JSON.stringify({
                      type: "tpa_connection_error",
                      code: "MISSING_HEADERS",
                      message: "Missing userId or sessionId in request headers",
                      timestamp: new Date(),
                    }),
                );
                socket.destroy();
                return;
              }

              // Attach userId and sessionId to the request for use by the handler
              (request as any).userId = userId;
              (request as any).sessionId = sessionId;

              try {
                // Verify and extract JWT payload
                const payload = jwt.verify(
                  appJwt,
                  AUGMENTOS_AUTH_JWT_SECRET,
                ) as {
                  packageName: string;
                  apiKey: string;
                };

                // Attach the payload to the request for use by the handler
                (request as any).appJwtPayload = payload;
                logger.debug(
                  { packageName: payload.packageName },
                  `App JWT authentication successful for ${payload.packageName}`,
                );
              } catch (jwtError) {
                // Send a specific error response for JWT verification failures
                if (jwtError instanceof jwt.JsonWebTokenError) {
                  logger.warn(
                    {
                      error: jwtError,
                      request,
                    },
                    "Invalid JWT token for App WebSocket connection",
                  );

                  // Send a 401 Unauthorized response with error details
                  socket.write(
                    "HTTP/1.1 401 Unauthorized\r\n" +
                      "Content-Type: application/json\r\n" +
                      "\r\n" +
                      JSON.stringify({
                        type: "tpa_connection_error",
                        code: "JWT_INVALID",
                        message: "Invalid JWT token: " + jwtError.message,
                        timestamp: new Date(),
                      }),
                  );
                  socket.destroy();
                  return;
                } else {
                  logger.error(
                    { error: jwtError, request },
                    "Error verifying App JWT token",
                  );
                }

                // For other types of errors, continue without failing
                // This maintains backward compatibility with message-based auth
              }
            }

            // Proceed with connection (authentication will be completed in the handler)
            this.appWss.handleUpgrade(request, socket, head, (ws) => {
              logger.debug("App WebSocket upgrade successful");
              this.appWss.emit("connection", ws, request);
            });
          } catch (upgradeError) {
            logger.error(
              {
                error: upgradeError,
              },
              "Failed to upgrade App WebSocket connection",
            );
            socket.destroy();
          }
        } else {
          logger.debug(
            {
              path: url.pathname,
            },
            "Unknown WebSocket path, destroying socket",
          );
          socket.destroy();
        }
      } catch (error) {
        logger.error(
          {
            error,
            url: request.url,
          },
          "Error in WebSocket upgrade handler",
        );
        socket.destroy();
      }
    });
  }
}

// Export singleton instance
export const websocketService = WebSocketService.getInstance();
export default websocketService;
