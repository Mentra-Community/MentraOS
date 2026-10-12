import {expect, test} from "bun:test";

import {submitReport, type SubmitReportInput} from "./report.service";

test("service input types allow keys only on bug and automatic reports", () => {
  const keyedBug: SubmitReportInput = {
    mentraUserId: "mu_test",
    kind: "bug",
    incidentKey: "manual-bug-1",
    trigger: {type: "manual", source: "test", reason: "manual_bug_report"},
    report: {actualBehavior: "The app stopped"},
    context: {},
  };
  const keyedAutomatic: SubmitReportInput = {
    mentraUserId: "mu_test",
    kind: "automatic",
    incidentKey: "automatic-1",
    trigger: {type: "automatic", source: "watchdog", reason: "runtime_failure"},
    report: {actualBehavior: "The runtime stopped"},
    context: {},
  };
  const keylessFeedback: SubmitReportInput = {
    mentraUserId: "mu_test",
    kind: "feedback",
    feedback: "More controls",
    context: {},
  };
  const keyedFeedbackCandidate = {
    ...keylessFeedback,
    incidentKey: "feedback-1",
  };
  // @ts-expect-error A prebuilt feedback object with an incident key must not cross the service boundary.
  const keyedFeedback: SubmitReportInput = keyedFeedbackCandidate;

  expect([keyedBug.kind, keyedAutomatic.kind, keylessFeedback.kind, keyedFeedback.kind]).toEqual([
    "bug",
    "automatic",
    "feedback",
    "feedback",
  ]);
});

test("service rejects keyed feedback from an untyped caller before persistence", async () => {
  const keyedFeedback = {
    mentraUserId: "mu_test",
    kind: "feedback",
    incidentKey: "feedback-1",
    feedback: "More controls",
    context: {},
  } as unknown as SubmitReportInput;

  await expect(submitReport(keyedFeedback)).rejects.toThrow("feedback reports do not accept incidentKey");
});
