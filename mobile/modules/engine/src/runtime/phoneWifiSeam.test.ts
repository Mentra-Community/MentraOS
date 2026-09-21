import {expect, mock, test} from "bun:test"
import {invokePhoneWifiSeam} from "./phoneWifiSeam"

test("status and prompt route to distinct host capabilities", async () => {
  const ui = {
    isPhoneWifiEnabled: mock(async () => null),
    requestPhoneWifiEnable: mock(async () => ({enabled: true, cancelled: false})),
  }
  expect(await invokePhoneWifiSeam(ui, {type: "miniapp_phone_is_wifi_enabled"})).toBeNull()
  expect(ui.requestPhoneWifiEnable).not.toHaveBeenCalled()
  expect(await invokePhoneWifiSeam(ui, {type: "miniapp_phone_request_wifi_enable", reason: "Video"})).toEqual({
    enabled: true,
    cancelled: false,
  })
  expect(ui.requestPhoneWifiEnable).toHaveBeenCalledWith("Video")
})

test("missing host capabilities return NOT_IMPLEMENTED", async () => {
  for (const type of ["miniapp_phone_is_wifi_enabled", "miniapp_phone_request_wifi_enable"]) {
    await expect(invokePhoneWifiSeam({}, {type})).rejects.toMatchObject({code: "NOT_IMPLEMENTED"})
  }
})

test("malformed reasons never reach host UI", async () => {
  const ui = {requestPhoneWifiEnable: mock(async () => ({enabled: null, cancelled: true}))}
  await expect(
    invokePhoneWifiSeam(ui, {type: "miniapp_phone_request_wifi_enable", reason: {text: "Video"}}),
  ).rejects.toMatchObject({code: "INVALID_ARGUMENT"})
  expect(ui.requestPhoneWifiEnable).not.toHaveBeenCalled()
})
