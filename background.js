// Tab Area Recorder - Background Service Worker (Manifest V3)

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab?.id || !tab.url || /^(chrome|edge|about|chrome-extension):/i.test(tab.url)) {
    return;
  }

  try {
    // Try toggling existing overlay if already injected
    await chrome.tabs.sendMessage(tab.id, { type: "TAR_TOGGLE_UI" });
  } catch {
    // Inject CSS and Content Script on first click
    await chrome.scripting.insertCSS({
      target: { tabId: tab.id },
      files: ["recorder.css"]
    });
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ["content.js"]
    });
  }
});
