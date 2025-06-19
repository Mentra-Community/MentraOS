// import { getSessionService } from "../core/session.service";
// // Debug Tools and KPIs for the server.

// // Interface for the server stats
// export interface ServerStats {
//     cpuUsage: number; // CPU usage percentage
//     memoryUsage: number; // Memory usage percentage
//     uptime: number; // Uptime in seconds
//     activeSessions: number; // Number of active sessions
// }

// // Function to get the number of active sessions from sessionService.
// export function getSessionStats(): { total: number, active: number, disconnected: number } {
//     try {
//         const sessions = getSessionService().getAllSessions();
//         const total = sessions.length;
//         const active = sessions.filter(session => !!!session.disconnectedAt).length;
//         const disconnected = sessions.filter(session => !!session.disconnectedAt).length;
//         return {
//             total,
//             active,
//             disconnected
//         };
//     } catch (error) {
//         console.error("Error getting session stats:", error);
//         return {
//             total: 0,
//             active: 0,
//             disconnected: 0
//         };
//     }
// }
