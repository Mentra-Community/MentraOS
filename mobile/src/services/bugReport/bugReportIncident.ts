import type * as ImagePicker from "expo-image-picker"

import {toolkit, type IncidentReport, type IncidentTrigger} from "@mentra/island"

export interface SubmitBugIncidentInput {
  trigger: IncidentTrigger
  report: IncidentReport
}

export interface SubmitBugIncidentOptions {
  screenshots?: ImagePicker.ImagePickerAsset[]
}

export function buildIncidentReport(input: {
  expectedBehavior?: string
  actualBehavior: string
  userSeverity?: 1 | 2 | 3 | 4 | 5
  systemPriority?: IncidentReport["systemPriority"]
  contactEmail?: string
}): IncidentReport {
  const expectedBehavior = input.expectedBehavior?.trim()
  const actualBehavior = input.actualBehavior.trim()
  const contactEmail = input.contactEmail?.trim()

  return {
    actualBehavior,
    ...(expectedBehavior && {expectedBehavior}),
    ...(input.userSeverity && {userSeverity: input.userSeverity}),
    ...(input.systemPriority && {systemPriority: input.systemPriority}),
    ...(contactEmail && {contactEmail}),
  }
}

/**
 * Host compatibility shim. UI/trigger-specific code passes what happened;
 * toolkit owns context collection, logs, Cloud V2 calls, screenshots, and
 * glasses notification.
 */
export async function submitBugIncident(
  input: SubmitBugIncidentInput,
  options?: SubmitBugIncidentOptions,
): Promise<{ok: true; incidentId: string} | {ok: false; error: Error}> {
  const res = await toolkit.incidents.file({
    trigger: input.trigger,
    report: input.report,
    screenshots: options?.screenshots,
  })
  if (res.error || !res.incidentId) {
    return {ok: false, error: new Error(res.error ?? "incident creation failed")}
  }

  return {ok: true, incidentId: res.incidentId}
}
