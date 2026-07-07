import { describe, expect, test } from "bun:test";

import {
  detectLanIPv4,
  resolveUdpAdvertisedHost,
  shouldAutoDetectUdpAdvertisedHost,
} from "./index";

const interfaces = {
  lo0: [
    {
      address: "127.0.0.1",
      netmask: "255.0.0.0",
      family: "IPv4" as const,
      mac: "00:00:00:00:00:00",
      internal: true,
      cidr: "127.0.0.1/8",
    },
  ],
  bridge100: [
    {
      address: "192.168.64.1",
      netmask: "255.255.255.0",
      family: "IPv4" as const,
      mac: "00:00:00:00:00:00",
      internal: false,
      cidr: "192.168.64.1/24",
    },
  ],
  en0: [
    {
      address: "192.168.1.238",
      netmask: "255.255.255.0",
      family: "IPv4" as const,
      mac: "00:00:00:00:00:00",
      internal: false,
      cidr: "192.168.1.238/24",
    },
  ],
  utun4: [
    {
      address: "10.8.0.12",
      netmask: "255.255.255.255",
      family: "IPv4" as const,
      mac: "00:00:00:00:00:00",
      internal: false,
      cidr: "10.8.0.12/32",
    },
  ],
};

describe("runtime UDP advertised host resolution", () => {
  test("explicit runtime option wins", () => {
    expect(
      resolveUdpAdvertisedHost({
        explicitHost: "udp.example.com",
        env: { AUDIO_UDP_ADVERTISED_HOST: "192.168.1.238" },
        interfaces,
      }),
    ).toEqual({ host: "udp.example.com", source: "option" });
  });

  test("env advertised host wins over local auto detection", () => {
    expect(
      resolveUdpAdvertisedHost({
        env: { AUDIO_UDP_ADVERTISED_HOST: "audio-udp.dev.example.com" },
        interfaces,
      }),
    ).toEqual({ host: "audio-udp.dev.example.com", source: "env" });
  });

  test("local dev auto-detects a LAN IPv4", () => {
    expect(
      resolveUdpAdvertisedHost({
        env: { NODE_ENV: "development" },
        interfaces,
      }),
    ).toEqual({ host: "192.168.1.238", source: "auto-lan" });
  });

  test("deployed runtime falls back to loopback when no host is configured", () => {
    expect(
      resolveUdpAdvertisedHost({
        env: { NODE_ENV: "production", PORTER_APP_NAME: "cloud-runtime" },
        interfaces,
      }),
    ).toEqual({ host: "127.0.0.1", source: "fallback" });
  });

  test("local auto-detect can be disabled", () => {
    expect(
      resolveUdpAdvertisedHost({
        env: { AUDIO_UDP_AUTO_DETECT_LAN: "false" },
        interfaces,
      }),
    ).toEqual({ host: "127.0.0.1", source: "fallback" });
  });

  test("preferred interface can be selected explicitly", () => {
    expect(detectLanIPv4({ interfaces, preferredInterface: "utun4" })).toBe("10.8.0.12");
  });

  test("auto-detect is off for deployment signals unless explicitly enabled", () => {
    expect(shouldAutoDetectUdpAdvertisedHost({ KUBERNETES_SERVICE_HOST: "10.0.0.1" })).toBe(false);
    expect(
      shouldAutoDetectUdpAdvertisedHost({
        AUDIO_UDP_AUTO_DETECT_LAN: "true",
        KUBERNETES_SERVICE_HOST: "10.0.0.1",
      }),
    ).toBe(true);
  });
});
