import { MentraApp } from "@mentra/sdk";

const app = new MentraApp({
  packageName: "com.test.hello",
  displayName: "Hello Test",
  version: "1.0.0",
  port: 3000,
});

app.onStart(async () => {
  console.log("App started!");
  
  // Display text on glasses
  await app.display.showText({
    lines: ["Hello from", "Test App!"],
  });
});

app.onStop(async () => {
  console.log("App stopped!");
});

// Start the app server
app.start();
