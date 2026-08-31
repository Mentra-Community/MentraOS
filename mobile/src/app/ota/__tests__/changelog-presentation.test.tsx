import {act, render} from "@testing-library/react-native"

import {ChangelogList, type MentraLiveOtaFlowTheme} from "@/../modules/engine/src/react/MentraLiveOtaFlow"

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
        scrollHint="Scroll for more"
        title="What's new"
      />,
    )

    expect(getByTestId("ota-changelog-card")).toBeDefined()
    expect(getByTestId("ota-changelog-card")).toHaveStyle({flex: 1})
    expect(getByTestId("ota-changelog-scroll")).toHaveStyle({flex: 1})
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
    act(() => {
      scrollView.props.onLayout({nativeEvent: {layout: {height: 200}}})
      scrollView.props.onContentSizeChange(320, 400)
    })
    expect(getByTestId("ota-changelog-scroll-hint")).toHaveTextContent("Scroll for more ↓")

    act(() => {
      scrollView.props.onScroll({
        nativeEvent: {
          contentOffset: {y: 200},
          contentSize: {height: 400},
          layoutMeasurement: {height: 200},
        },
      })
    })
    expect(queryByTestId("ota-changelog-scroll-hint")).toBeNull()
  })
})
