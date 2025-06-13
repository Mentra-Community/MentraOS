import { AppI, PermissionType } from "@augmentos/sdk";

const systemApps = {
  dashboard: {
    host: "dashboard-manager",
    packageName: 'system.augmentos.dashboard',
    name: 'Dashboard',
    description: "Dashboard",
    isSystemApp: true,
    permissions: [
      {
        type: PermissionType.READ_NOTIFICATIONS,
        description: 'Access phone notifications for dashboard display'
      },
      {
        type: PermissionType.LOCATION,
        description: 'Access location for weather and location-based dashboard information'
      },
      {
        type: PermissionType.CALENDAR,
        description: 'Access calendar events for dashboard display'
      }
    ]
  },
  // notify: {
  //   host: "notify",
  //   packageName: 'com.augmentos.notify',
  //   name: 'Notify',
  //   description: "See your phone notifications on your smart glasses",
  //   isSystemApp: true,
  //   permissions: [
  //     {
  //       type: PermissionType.READ_NOTIFICATIONS,
  //       description: 'Send notifications to your phone'
  //     }
  //   ]
  // },
  // mira: {
  //   host: "mira",
  //   packageName: 'com.augmentos.miraai',
  //   name: 'Mira AI',
  //   description: "The AugmentOS AI Assistant. Say 'Hey Mira...' followed by a question or command.",
  //   isSystemApp: true,
  // },
  // teleprompter: {
  //   host: `teleprompter`,
  //   packageName: 'com.augmentos.teleprompter',
  //   name: 'Teleprompt',
  //   description: "Teleprompter for live presentations.",
  //   isSystemApp: true,
  // },
  // xstats: {
  //   host: `xstats`,
  //   packageName: 'com.augmentos.xstats',
  //   name: 'X Stats',
  //   description: "Show X stats on your smart glasses.",
  //   isSystemApp: true,
  // },
  // liveTranslation: {
  //   host: "live-translation",
  //   packageName: 'com.augmentos.live-translation',
  //   name: 'Live Translation',
  //   description: "Live language translation.",
  //   isSystemApp: true,
  // },
  // merge: {
  //   host: process.env.MERGE_HOST_NAME || `merge`,
  //   packageName: 'com.mentra.merge',
  //   name: 'Merge',
  //   description: "Proactive AI that helps you during conversations. Turn it on, have a conversation, and let Merge agents enhance your convo.",
  //   isSystemApp: true,
  //   skipPorterHostUpdate: true,
  // },
  // calendarreminder: {
  //   host: "calendarreminder",
  //   packageName: 'com.augmentos.calendarreminder',
  //   name: 'Calendar Reminder',
  //   description: "Calendar Reminder",
  //   isSystemApp: true,
  // },
  // tictactoe: {
  //   host: "tictactoe",
  //   packageName: 'com.augmentos.tictactoe',
  //   name: 'Tic Tac Toe',
  //   description: "Tic Tac Toe",
  //   isSystemApp: true,
  // },
};

// Check if deployed on porter. if so we need to modify the hosts with the porter env prefix.
// seems like we gotta do: augmentos-cloud-dev-live-captions.default.svc.cluster.local:80
// aka <PORTER_APP_NAME>-<app.host>.default.svc.cluster.local:<app.port (default:80)>
// this is because porter doesn't support the use of the default host names the same way docker-compose does.
// The default host names are used for the system apps in the docker-compose file.
// In cloud environments i.e production, development, staging: the system apps are deployed as services in the porter cluster.

for (const app of Object.values(systemApps)) {

  // Add public Url

  // @ts-ignore
  (app as any).publicUrl = "http://" + app.host;
  // if the app is already using the porter host, skip it
  // @ts-ignore
  if ((app as any).skipPorterHostUpdate) {
    console.log(`⚡️⚡️⚡️⚡️⚡️ Skipping porter host update for ${app.name} ||| HOST ||| (${app.host}) ⚡️⚡️⚡️⚡️⚡️`);
    continue;
  }

  if (process.env.PORTER_APP_NAME) {
    app.host = `${process.env.PORTER_APP_NAME}-${app.host}.default.svc.cluster.local:${process.env.PORTER_APP_PORT || 80}`;
    console.log(`⚡️ System app ${app.name} host: ${app.host}`);
  }
}

export { systemApps };
export default systemApps;