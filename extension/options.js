const backendBaseUrlInput = document.getElementById("backendBaseUrl");
const saveButton = document.getElementById("saveButton");
const statusMessage = document.getElementById("statusMessage");

async function restoreOptions() {
  const stored = await chrome.storage.sync.get({
    backendBaseUrl: "http://localhost:3000",
  });

  backendBaseUrlInput.value = stored.backendBaseUrl;
}

async function saveOptions() {
  const backendBaseUrl = backendBaseUrlInput.value.trim().replace(/\/$/, "");

  await chrome.storage.sync.set({
    backendBaseUrl,
  });

  statusMessage.textContent = "Saved.";
  setTimeout(() => {
    statusMessage.textContent = "";
  }, 1500);
}

saveButton.addEventListener("click", saveOptions);
restoreOptions();
