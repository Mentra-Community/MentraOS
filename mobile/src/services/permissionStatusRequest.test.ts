const mockWriteStatusReceipt = jest.fn(async (requestId: string) => ({requestId}))
jest.mock("@mentra/engine", () => ({engine: {permissions: {writeStatusReceipt: (...args: unknown[]) => mockWriteStatusReceipt(...args as [string])}}}))
import {publishPermissionStatusRequest} from "./permissionStatusRequest"

beforeEach(() => mockWriteStatusReceipt.mockClear())

test("the diagnostic request publishes only the correlated passive receipt", async () => {
  await expect(publishPermissionStatusRequest("com.mentra://test/permissions?request_id=permission-read-1"))
    .resolves.toEqual({requestId: "permission-read-1"})
  expect(mockWriteStatusReceipt).toHaveBeenCalledTimes(1)
  expect(mockWriteStatusReceipt).toHaveBeenCalledWith("permission-read-1")
})

test.each([
  "https://example.com/test/permissions?request_id=read-1",
  "com.mentra://test/submit-incident-report?request_id=read-1",
  "com.mentra://test/permissions",
  "com.mentra://test/permissions?request_id=read-1&request_id=read-2",
  "com.mentra://test/permissions?request_id=read-1&path=/tmp/result.json",
  "com.mentra://test/permissions?request_id=read-1&request=location",
  "com.mentra://test/permissions?request_id=%0A",
  "com.mentra://test/permissions?request_id=read-1%0A",
  "com.mentra://test/permissions?request_id=" + "x".repeat(161),
  "com.mentra://test/permissions?request_id=read-1#fragment",
])("invalid diagnostic source is rejected before observing %s", async (url) => {
  await expect(publishPermissionStatusRequest(url)).rejects.toThrow("permission-status link")
  expect(mockWriteStatusReceipt).not.toHaveBeenCalled()
})

test("native observation failures propagate without manufacturing a successful receipt", async () => {
  mockWriteStatusReceipt.mockRejectedValueOnce(new Error("Native status unavailable"))
  await expect(publishPermissionStatusRequest("com.mentra://test/permissions?request_id=read-1"))
    .rejects.toThrow("Native status unavailable")
})
