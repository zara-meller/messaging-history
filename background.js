// Clicking the toolbar icon opens the side panel and tells it which tab to read.
// sidePanel.open must run inside the click gesture, so it goes first, unawaited.
chrome.action.onClicked.addListener((tab) => {
  chrome.sidePanel.open({ windowId: tab.windowId });
  chrome.storage.session.set({
    target: { tabId: tab.id, url: tab.url || '', at: Date.now() },
  });
});
