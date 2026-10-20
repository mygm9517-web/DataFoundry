import { describe, expect, it } from "vitest";
import {
  closeWorkspacePanel,
  isWorkspacePanelOpen,
  NO_WORKSPACE_PANEL,
  openWorkspacePanel,
  type WorkspacePanelLayout,
} from "../workspace-panels";

/**
 * The four side panels used to be four booleans with a convention that each
 * opener clear the other three. Opening the data-sources panel from the big
 * screen broke the convention, and because the render chain tests the big screen
 * first, the click was swallowed: the panel stayed on screen and the sidebar
 * entry lit up as though it had worked. These cases pin the property that makes
 * that impossible — one panel at a time, whatever order they are opened in —
 * rather than pinning the one transition that was wrong.
 */

const OPENERS = [
  { name: "data sources", action: { type: "config", panel: "db" } as const },
  { name: "knowledge base", action: { type: "config", panel: "kb" } as const },
  { name: "agent tools", action: { type: "config", panel: "mcp" } as const },
  { name: "skills", action: { type: "config", panel: "skill" } as const },
  { name: "models", action: { type: "config", panel: "llm" } as const },
  { name: "workspace files", action: { type: "files" } as const },
  { name: "data link", action: { type: "datalink" } as const },
  { name: "big screens", action: { type: "bigscreen" } as const },
];

describe("openWorkspacePanel", () => {
  it("opens each panel from the closed state", () => {
    for (const { action } of OPENERS) {
      expect(isWorkspacePanelOpen(openWorkspacePanel(NO_WORKSPACE_PANEL, action))).toBe(true);
    }
  });

  it("never leaves two panels open, in any order", () => {
    // Every ordered pair, because the bug was order-dependent: the wrong one
    // only showed when a specific panel was already open.
    for (const first of OPENERS) {
      for (const second of OPENERS) {
        const after = openWorkspacePanel(openWorkspacePanel(NO_WORKSPACE_PANEL, first.action), second.action);
        expect(after).toEqual(
          samePanel(first.action, second.action)
            ? NO_WORKSPACE_PANEL
            : toLayout(second.action),
        );
      }
    }
  });

  it("switches when a different config panel is clicked", () => {
    const opened = openWorkspacePanel(NO_WORKSPACE_PANEL, { type: "config", panel: "db" });
    expect(openWorkspacePanel(opened, { type: "config", panel: "llm" })).toEqual({
      kind: "config",
      panel: "llm",
    });
  });

  it("closes a config panel when its own entry is clicked again", () => {
    const opened = openWorkspacePanel(NO_WORKSPACE_PANEL, { type: "config", panel: "db" });
    expect(openWorkspacePanel(opened, { type: "config", panel: "db" })).toEqual(NO_WORKSPACE_PANEL);
  });

  it.each([
    ["files", { type: "files" } as const],
    ["datalink", { type: "datalink" } as const],
    ["bigscreen", { type: "bigscreen" } as const],
  ])("closes %s when its own entry is clicked again", (_name, action) => {
    const opened = openWorkspacePanel(NO_WORKSPACE_PANEL, action);
    expect(openWorkspacePanel(opened, action)).toEqual(NO_WORKSPACE_PANEL);
  });

  it("leaves the big screen when a config panel is opened from it", () => {
    // The reported defect, stated as the transition it actually is.
    const bigScreen = openWorkspacePanel(NO_WORKSPACE_PANEL, { type: "bigscreen" });
    expect(openWorkspacePanel(bigScreen, { type: "config", panel: "db" })).toEqual({
      kind: "config",
      panel: "db",
    });
  });
});

describe("closeWorkspacePanel", () => {
  it("closes whatever is open", () => {
    expect(closeWorkspacePanel()).toEqual(NO_WORKSPACE_PANEL);
  });

  it("opens the named panel rather than toggling it shut", () => {
    // `onSwitchPanel` and the big screen's "go configure a datasource" button
    // both route through here; a toggle would close the column instead when the
    // target panel was already selected.
    expect(closeWorkspacePanel("mcp")).toEqual({ kind: "config", panel: "mcp" });
  });
});

function toLayout(action: (typeof OPENERS)[number]["action"]): WorkspacePanelLayout {
  switch (action.type) {
    case "config":
      return { kind: "config", panel: action.panel };
    case "files":
      return { kind: "files" };
    case "datalink":
      return { kind: "datalink" };
    case "bigscreen":
      return { kind: "bigscreen" };
  }
}

function samePanel(
  left: (typeof OPENERS)[number]["action"],
  right: (typeof OPENERS)[number]["action"],
): boolean {
  if (left.type !== right.type) return false;
  if (left.type === "config" && right.type === "config") return left.panel === right.panel;
  return true;
}
