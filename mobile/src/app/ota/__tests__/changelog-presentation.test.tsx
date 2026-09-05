import {fireEvent, render, within} from "@testing-library/react-native"

import {
  ChangelogList,
  MentraLiveOtaFlow,
  type MentraLiveOtaFlowTheme,
} from "@/../modules/engine/src/react/MentraLiveOtaFlow"
import * as otaHook from "@/../modules/engine/src/react/useMentraLiveOta"

const colors: MentraLiveOtaFlowTheme = {
  background: "#FFFFFF",
  border: "#D7DFDA",
  error: "#C43131",
  foreground: "#0E2C1A",
  primary: "#00B869",
  primaryText: "#FFFFFF",
  textDim: "#66736B",
}

describe("OTA changelog presentation", () => {
  it("places release notes in a scrollable card and renders standard Markdown", () => {
    const {getAllByTestId, getByRole, getByTestId, getByText, queryByTestId, queryByText} = render(
      <ChangelogList
        changelogs={[
          {
            version: "3.1.0",
            markdown: `# Highlights

Release **overview** with [details](https://example.com).

- First improvement.
- Second improvement.

1. Follow-up step.

> A useful note.

Use \`safe mode\`.`,
          },
        ]}
        colors={colors}
        title="What's new"
      />,
    )

    expect(getByTestId("ota-changelog-card")).toBeDefined()
    expect(getByTestId("ota-changelog-card")).toHaveStyle({flexGrow: 1, minHeight: 200})
    expect(getByTestId("ota-changelog-scroll")).toHaveStyle({flexGrow: 1, height: 120})
    expect(getByTestId("ota-changelog-markdown")).toBeDefined()
    expect(getByText("What's new")).toBeDefined()
    expect(getByText("Highlights")).toBeDefined()
    expect(getByText("overview")).toBeDefined()
    expect(getByRole("link")).toBeDefined()
    expect(getByText("First improvement.")).toBeDefined()
    expect(getByText("A useful note.")).toBeDefined()
    expect(getByText("safe mode")).toBeDefined()
    expect(getAllByTestId("marked-list-item")).toHaveLength(3)
    expect(queryByText("# Highlights")).toBeNull()
    expect(queryByText("**overview**")).toBeNull()

    const scrollView = getByTestId("ota-changelog-scroll")
    expect(scrollView.props.showsVerticalScrollIndicator).toBe(true)
    expect(scrollView.props.persistentScrollbar).toBe(true)
    expect(scrollView.props.nestedScrollEnabled).toBe(true)
    expect(scrollView.props.onScroll).toBeUndefined()
    expect(queryByTestId("ota-changelog-scroll-hint")).toBeNull()
  })

  it.each(["complete", "up_to_date"] as const)("keeps %s content scrollable with Done outside it", (screen) => {
    const finish = jest.fn()
    const hook = jest.spyOn(otaHook, "useMentraLiveOta").mockReturnValue({
      finish,
      check: jest.fn(),
      retryCheck: jest.fn(),
      install: jest.fn(),
      retryInstall: jest.fn(),
      discard: jest.fn(),
      openWifiSetup: jest.fn(),
      state: {
        screen,
        connected: true,
        batteryLevel: 100,
        transport: null,
        updateRequired: false,
        versionChange: false,
        versionChangeConverged: false,
        versionChangePhase: null,
        wifiConnected: true,
        wifiStatusKnown: true,
        hotspotSupported: true,
        hotspotPhase: "idle",
        hotspotArtifactPercent: null,
        phase: null,
        step: null,
        currentStep: null,
        totalSteps: null,
        progress: null,
        installingApkOnly: false,
        firmwareRestarting: false,
        error: null,
        canInstall: false,
        canRetry: false,
        canFinish: true,
        canDismiss: true,
        canDiscard: false,
        canOpenWifiSetup: false,
        continueDisabled: false,
        completedUpdate: true,
        changelogs: [{version: "3.1.0", markdown: "Release notes.\n\n".repeat(100)}],
        releaseTransition: {fromVersion: "3.0.0", toVersion: "3.1.0-beta.128"},
      },
    })

    try {
      const {getByTestId} = render(<MentraLiveOtaFlow onFinished={finish} onOpenWifiSetup={jest.fn()} />)
      const page = getByTestId("ota-page-scroll")
      expect(page).toHaveStyle({flex: 1})
      expect(page.props.contentContainerStyle).toEqual(expect.arrayContaining([expect.objectContaining({flexGrow: 1})]))
      expect(within(page).getByTestId("ota-changelog-scroll")).toBeDefined()
      expect(within(page).queryByTestId("button-Done")).toBeNull()
      fireEvent.press(getByTestId("button-Done"))
      expect(finish).toHaveBeenCalledTimes(1)
    } finally {
      hook.mockRestore()
    }
  })
})
