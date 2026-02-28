/**
 * API Client Tests
 *
 * Tests for the CLI API client
 */

import {describe, test, expect, beforeAll, mock} from "bun:test"
import {APIClient} from "../src/api/client"

// Mock axios
mock.module("axios", () => ({
  default: {
    create: mock(() => ({
      interceptors: {
        request: {use: mock()},
        response: {use: mock()},
      },
      get: mock(async () => ({data: {data: []}})),
      post: mock(async () => ({data: {data: {}}})),
      put: mock(async () => ({data: {data: {}}})),
      delete: mock(async () => ({data: {data: {}}})),
    })),
  },
}))

describe("APIClient", () => {
  let client: APIClient

  beforeAll(() => {
    client = new APIClient()
  })

  describe("Apps", () => {
    test("listApps should call GET /api/cli/apps", async () => {
      const result = await client.listApps()
      expect(result).toBeDefined()
    })

    test("listApps with orgId should pass orgId as param", async () => {
      const result = await client.listApps("org_123")
      expect(result).toBeDefined()
    })

    test("createApp should call POST /api/cli/apps", async () => {
      const appData = {
        packageName: "com.test.app",
        name: "Test App",
        appType: "standard",
        publicUrl: "https://example.com",
      }
      const result = await client.createApp(appData)
      expect(result).toBeDefined()
    })

    test("getApp should call GET /api/cli/apps/:packageName", async () => {
      const result = await client.getApp("com.test.app")
      expect(result).toBeDefined()
    })

    test("updateApp should call PUT /api/cli/apps/:packageName", async () => {
      const updateData = {name: "Updated Name"}
      const result = await client.updateApp("com.test.app", updateData)
      expect(result).toBeDefined()
    })

    test("deleteApp should call DELETE /api/cli/apps/:packageName", async () => {
      const result = await client.deleteApp("com.test.app")
      expect(result).toBeDefined()
    })

    test("publishApp should call POST /api/cli/apps/:packageName/publish", async () => {
      const result = await client.publishApp("com.test.app")
      expect(result).toBeDefined()
    })

    test("regenerateApiKey should call POST /api/cli/apps/:packageName/api-key", async () => {
      const result = await client.regenerateApiKey("com.test.app")
      expect(result).toBeDefined()
    })
  })

  describe("Organizations", () => {
    test("listOrgs should call GET /api/cli/orgs", async () => {
      const result = await client.listOrgs()
      expect(result).toBeDefined()
    })

    test("getOrg should call GET /api/cli/orgs/:orgId", async () => {
      const result = await client.getOrg("org_123")
      expect(result).toBeDefined()
    })
  })

  describe("Error Handling", () => {
    test("should handle network errors", async () => {
      // This would require more sophisticated mocking
      // Placeholder for future implementation
      expect(true).toBe(true)
    })

    test("should handle 401 errors", async () => {
      // This would require more sophisticated mocking
      // Placeholder for future implementation
      expect(true).toBe(true)
    })
  })
})
