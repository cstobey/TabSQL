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
  searchVisible:  null,          // Set of visible node ids while a search filter is active
  dateFormat:     'MM-DD h:mm A',
  focusState:     { activeTabChromeIds: new Set(), focusedWinChromeId: null },
};
