/** Which workspace configuration the right column is editing. */
export type WorkspaceConfigPanelKey = "db" | "kb" | "mcp" | "skill" | "llm";

/**
 * Which of the workspace's four side panels occupies the right column.
 *
 * The column shows exactly one, and the four used to be separate booleans. That
 * works as long as every opener remembers to clear the other three, and one of
 * them did not: opening the data-sources panel from the big-screen panel left
 * `bigScreenPanelOpen` set, so the render chain — which tests the big screen
 * first — kept drawing it and the click looked like it had done nothing. The
 * models that got it right did so by listing three `set…(false)` calls in the
 * right order, which is a rule no compiler checks.
 *
 * One value instead of four flags makes "exactly one" structural: there is no
 * arrangement of these states in which two panels are open, so nothing has to
 * remember to close anything.
 */
export type WorkspacePanelLayout =
  | { kind: "none" }
  | { kind: "config"; panel: WorkspaceConfigPanelKey }
  | { kind: "files" }
  | { kind: "datalink" }
  | { kind: "bigscreen" };

export const NO_WORKSPACE_PANEL: WorkspacePanelLayout = { kind: "none" };

export function isWorkspacePanelOpen(layout: WorkspacePanelLayout): boolean {
  return layout.kind !== "none";
}

/**
 * The layout after a sidebar entry is clicked.
 *
 * The three non-config panels toggle: clicking the entry for the panel already
 * showing closes it, which is what a selected sidebar item is expected to do.
 * A config panel toggles only against itself — clicking "Data sources" while
 * "Models" is open switches, rather than closing and leaving the column empty.
 */
export function openWorkspacePanel(
  layout: WorkspacePanelLayout,
  action:
    | { type: "config"; panel: WorkspaceConfigPanelKey }
    | { type: "files" }
    | { type: "datalink" }
    | { type: "bigscreen" },
): WorkspacePanelLayout {
  switch (action.type) {
    case "config":
      return layout.kind === "config" && layout.panel === action.panel
        ? NO_WORKSPACE_PANEL
        : { kind: "config", panel: action.panel };
    case "files":
      return layout.kind === "files" ? NO_WORKSPACE_PANEL : { kind: "files" };
    case "datalink":
      return layout.kind === "datalink" ? NO_WORKSPACE_PANEL : { kind: "datalink" };
    case "bigscreen":
      return layout.kind === "bigscreen" ? NO_WORKSPACE_PANEL : { kind: "bigscreen" };
  }
}

/**
 * The layout after a panel's own `onBack` / post-action navigation.
 *
 * `config` names a panel that must be showing when the action finishes, or null
 * for "close whatever is open". It is not a toggle: the big screen's "go
 * configure a datasource" button has to land on the datasource panel even when
 * that is what was already open behind it.
 */
export function closeWorkspacePanel(
  panel: WorkspaceConfigPanelKey | null = null,
): WorkspacePanelLayout {
  return panel ? { kind: "config", panel } : NO_WORKSPACE_PANEL;
}
