// Shared mutable state — imported by all tree.js modules
export const state = {
  allNodes:       [],
  nodeMap:        {},
  collapsed:      new Set(),
  selected:       null,
  dragSrcId:      null,
  allTags:        [],
  nodeTagsMap:    {},
  dupUrls:        new Set(),
  tagPickerNodeId: null,
  focusState:     { activeTabChromeIds: new Set(), focusedWinChromeId: null },
};
