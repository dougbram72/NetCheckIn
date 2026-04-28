const state = {
  nets: [],
  selectedNetId: null,
  listening: false,
  transcript: "",
  lastCandidates: [],
  draggedStationId: null,
  modalSection: null,
  noteModalStationId: null,
  audioSource: "microphone",
  audioDeviceId: "",
  audioStream: null,
  systemAudioStream: null,
  audioPermissionGranted: false,
  audioContext: null,
  audioProcessor: null,
  audioSourceNode: null,
  audioMonitorNode: null,
  recordedChunks: [],
  recordedSampleRate: 16000,
};

const els = {
  netSelector: document.querySelector("#net-selector"),
  netForm: document.querySelector("#net-form"),
  netControlCallsign: document.querySelector("#net-control-callsign"),
  netControlDetails: document.querySelector("#net-control-details"),
  repeaterFields: document.querySelector("#repeater-fields"),
  newNetButton: document.querySelector("#new-net-button"),
  openingSections: document.querySelector("#opening-sections"),
  closingSections: document.querySelector("#closing-sections"),
  scriptTemplate: document.querySelector("#script-section-template"),
  scriptModal: document.querySelector("#script-editor-modal"),
  scriptModalTitle: document.querySelector("#script-modal-title"),
  scriptModalText: document.querySelector("#script-modal-text"),
  closeScriptModal: document.querySelector("#close-script-modal"),
  saveScriptModal: document.querySelector("#save-script-modal"),
  rollCallForm: document.querySelector("#roll-call-form"),
  rollCallInput: document.querySelector("#roll-call-input"),
  rollCallNote: document.querySelector("#roll-call-note"),
  rollCallList: document.querySelector("#roll-call-list"),
  stationNoteModal: document.querySelector("#station-note-modal"),
  stationNoteTitle: document.querySelector("#station-note-title"),
  stationNoteText: document.querySelector("#station-note-text"),
  closeStationNoteModal: document.querySelector("#close-station-note-modal"),
  saveStationNoteModal: document.querySelector("#save-station-note-modal"),
  markAllPresent: document.querySelector("#mark-all-present"),
  clearAllPresent: document.querySelector("#clear-all-present"),
  createPdfReport: document.querySelector("#create-pdf-report"),
  lookupForm: document.querySelector("#lookup-form"),
  lookupInput: document.querySelector("#lookup-input"),
  lookupResult: document.querySelector("#lookup-result"),
  transcriptOutput: document.querySelector("#transcript-output"),
  candidateList: document.querySelector("#candidate-list"),
  listeningStatus: document.querySelector("#listening-status"),
  rollCallTemplate: document.querySelector("#roll-call-item-template"),
  importForm: document.querySelector("#callsign-import-form"),
  importFile: document.querySelector("#callsign-file"),
  downloadFccData: document.querySelector("#download-fcc-data"),
  importStatus: document.querySelector("#import-status"),
  audioSource: document.querySelector("#audio-source"),
  audioDevice: document.querySelector("#audio-device"),
  audioDeviceWrap: document.querySelector("#audio-device-wrap"),
  requestAudioAccess: document.querySelector("#request-audio-access"),
  refreshAudioDevices: document.querySelector("#refresh-audio-devices"),
  audioHelp: document.querySelector("#audio-help"),
};

initialize().catch((error) => {
  console.error(error);
  els.lookupResult.textContent = `Startup error: ${error.message}`;
});

async function initialize() {
  bindEvents();
  await loadNets();
  initializeAudioControls();
}

function bindEvents() {
  els.netForm.addEventListener("submit", handleNetSave);
  els.netSelector.addEventListener("change", (event) => setSelectedNet(event.target.value || null));
  els.newNetButton.addEventListener("click", createBlankNet);
  els.rollCallForm.addEventListener("submit", handleAddRollCallEntry);
  els.markAllPresent.addEventListener("click", () => setAllStationsPresent(true));
  els.clearAllPresent.addEventListener("click", () => setAllStationsPresent(false));
  els.createPdfReport.addEventListener("click", handleCreatePdfReport);
  els.lookupForm.addEventListener("submit", handleLookup);
  els.importForm.addEventListener("submit", handleCallsignImport);
  els.downloadFccData.addEventListener("click", handleFccDownload);
  els.netControlCallsign.addEventListener("blur", handleNetControlLookup);
  els.closeStationNoteModal.addEventListener("click", closeStationNoteModal);
  els.saveStationNoteModal.addEventListener("click", saveStationNoteModal);
  els.closeScriptModal.addEventListener("click", closeScriptModal);
  els.saveScriptModal.addEventListener("click", saveScriptModal);
  els.audioSource.addEventListener("change", handleAudioSourceChange);
  els.audioDevice.addEventListener("change", handleAudioDeviceChange);
  els.requestAudioAccess.addEventListener("click", requestAudioAccess);
  els.refreshAudioDevices.addEventListener("click", refreshAudioDevices);
  els.scriptModal.addEventListener("click", (event) => {
    if (event.target === els.scriptModal) {
      closeScriptModal();
    }
  });
  els.stationNoteModal.addEventListener("click", (event) => {
    if (event.target === els.stationNoteModal) {
      closeStationNoteModal();
    }
  });

  document.querySelectorAll('input[name="mode"]').forEach((radio) => {
    radio.addEventListener("change", renderRepeaterFieldsVisibility);
  });

  document.addEventListener("keydown", handleGlobalKeyDown);
  document.addEventListener("keyup", handleGlobalKeyUp);
  window.addEventListener("blur", stopListening);
}

function initializeAudioControls() {
  renderAudioSourceControls();
  renderAudioHelp();
  void refreshAudioDevices();
}

async function loadNets() {
  const nets = await apiRequest("/api/nets");
  state.nets = nets;
  renderNetOptions();

  if (!nets.length) {
    await createBlankNet();
    return;
  }

  setSelectedNet(nets[0].id);
}

async function handleNetSave(event) {
  event.preventDefault();
  await saveCurrentNet();
}

async function saveCurrentNet() {
  const payload = getCurrentNetPayload();

  await apiRequest("/api/nets", {
    method: "POST",
    body: payload,
  });

  await refreshNets(payload.id);
  return payload.id;
}

function getCurrentNetPayload() {
  const formData = new FormData(els.netForm);
  const currentNet = getSelectedNet();

  return {
    id: currentNet?.id ?? crypto.randomUUID(),
    name: String(formData.get("name") || "").trim(),
    date: String(formData.get("date") || ""),
    time: String(formData.get("time") || ""),
    frequency: String(formData.get("frequency") || "").trim(),
    mode: String(formData.get("mode") || "repeater"),
    repeaterName: String(formData.get("repeaterName") || "").trim(),
    repeaterOffset: String(formData.get("repeaterOffset") || "").trim(),
    plTone: String(formData.get("plTone") || "").trim(),
    netControlCallsign: normalizeCallsign(formData.get("netControlCallsign")),
    netControlName: els.netControlDetails.dataset.name || "",
    netControlLocation: els.netControlDetails.dataset.location || "",
    openingSections: getScriptSectionsFromUi("opening"),
    closingSections: getScriptSectionsFromUi("closing"),
  };
}

async function createBlankNet() {
  const blank = makeNet({
    date: new Date().toISOString().slice(0, 10),
    time: "19:00",
  });

  await apiRequest("/api/nets", {
    method: "POST",
    body: blank,
  });

  await refreshNets(blank.id);
}

async function handleAddRollCallEntry(event) {
  event.preventDefault();
  const callsign = normalizeCallsign(els.rollCallInput.value);
  const note = els.rollCallNote.value.trim();

  if (!callsign || !state.selectedNetId) {
    return;
  }

  let location = "";
  try {
    const result = await lookupCallsign(callsign);
    location = result.location || "";
  } catch {
    location = "";
  }

  await addStationToSelectedNet(makeStation(callsign, note, location));
  els.rollCallForm.reset();
  els.rollCallInput.focus();
}

async function handleLookup(event) {
  event.preventDefault();
  const query = normalizeCallsignSearchQuery(els.lookupInput.value);
  if (!query) {
    els.lookupResult.textContent = "Enter a callsign to lookup.";
    return;
  }

  const matches = await searchCallsigns(query);
  if (matches.length) {
    renderLookupResults(matches, query);
    return;
  }

  renderLookupResults([makeUnknownLookupResult(normalizeCallsign(query) || query)], query);
}

async function handleNetControlLookup() {
  const callsign = normalizeCallsign(els.netControlCallsign.value);
  els.netControlCallsign.value = callsign;

  if (!callsign) {
    renderNetControlDetails(null);
    return;
  }

  renderNetControlDetails({ callsign, name: "", location: "", loading: true });

  try {
    const result = await lookupCallsign(callsign);
    renderNetControlDetails(result);
  } catch (error) {
    renderNetControlDetails({
      callsign,
      name: "",
      location: "",
      source: `Lookup failed: ${error.message}`,
    });
  }
}

async function handleCreatePdfReport() {
  const currentNet = getSelectedNet();
  if (!currentNet) {
    return;
  }

  const reportWindow = window.open("", "_blank", "noopener");
  const netId = await saveCurrentNet();
  const reportUrl = `/api/nets/${netId}/report.pdf`;

  if (reportWindow) {
    reportWindow.location = reportUrl;
    return;
  }

  window.location.href = reportUrl;
}

async function handleCallsignImport(event) {
  event.preventDefault();

  const file = els.importFile.files?.[0];
  if (!file) {
    els.importStatus.textContent = "Choose an FCC file first.";
    return;
  }

  els.importStatus.textContent = `Importing ${file.name}...`;

  try {
    const content = await file.arrayBuffer();
    const result = await apiRequest("/api/callsigns/import-fcc", {
      method: "POST",
      body: content,
      headers: {
        "Content-Type": file.name.toLowerCase().endsWith(".zip") ? "application/zip" : "text/plain; charset=utf-8",
        "X-File-Name": file.name,
      },
    });
    renderFccImportStatus(result);
    els.importForm.reset();
  } catch (error) {
    els.importStatus.textContent = `Import failed: ${error.message}`;
  }
}

async function handleFccDownload() {
  els.importStatus.textContent = "Downloading latest FCC amateur data. This can take a few minutes...";
  els.downloadFccData.disabled = true;
  console.info("[FCC] Download/import request started.");

  try {
    const result = await apiRequest("/api/callsigns/download-fcc", {
      method: "POST",
      body: {},
    });
    console.info("[FCC] Download/import complete.", result);
    renderFccImportStatus(result, "Downloaded and imported");
  } catch (error) {
    console.error("[FCC] Download/import failed.", error);
    els.importStatus.textContent = `FCC download failed: ${error.message}`;
  } finally {
    els.downloadFccData.disabled = false;
  }
}

function renderFccImportStatus(result, verb = "Imported") {
  if (result.mode === "ZIP" && result.details) {
    const size = result.bytes ? ` (${formatBytes(result.bytes)})` : "";
    els.importStatus.textContent =
      `${verb} ${result.imported} records from ${result.fileName}${size} ` +
      `(EN: ${result.details.enImported}, AM: ${result.details.amImported}).`;
    return;
  }

  els.importStatus.textContent = `${verb} ${result.imported} records from ${result.fileName} (${result.mode}).`;
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return "";
  }

  const megabytes = bytes / 1024 / 1024;
  return `${megabytes.toFixed(1)} MB`;
}

function handleAudioSourceChange(event) {
  state.audioSource = event.target.value;
  renderAudioSourceControls();
  renderAudioHelp();
}

function handleAudioDeviceChange(event) {
  state.audioDeviceId = event.target.value;
}

async function requestAudioAccess() {
  try {
    if (state.audioSource === "system") {
      await ensureSystemAudioStream();
    } else {
      await ensureMicrophoneStream();
      await refreshAudioDevices();
    }

    state.audioPermissionGranted = true;
    renderAudioHelp("Audio access granted.");
  } catch (error) {
    renderAudioHelp(`Audio access failed: ${humanizeAudioError(error)}`);
  }
}

async function refreshAudioDevices() {
  if (!navigator.mediaDevices?.enumerateDevices) {
    els.audioDevice.innerHTML = '<option value="">Browser does not support device enumeration</option>';
    els.audioDevice.disabled = true;
    return;
  }

  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const inputs = devices.filter((device) => device.kind === "audioinput");
    els.audioDevice.innerHTML = "";

    if (!inputs.length) {
      const option = document.createElement("option");
      option.value = "";
      option.textContent = state.audioPermissionGranted ? "No audio inputs found" : "Allow audio access to list inputs";
      els.audioDevice.append(option);
      els.audioDevice.disabled = true;
      return;
    }

    inputs.forEach((device, index) => {
      const option = document.createElement("option");
      option.value = device.deviceId;
      option.textContent = device.label || `Input ${index + 1}`;
      els.audioDevice.append(option);
    });

    els.audioDevice.disabled = false;
    if (state.audioDeviceId && inputs.some((device) => device.deviceId === state.audioDeviceId)) {
      els.audioDevice.value = state.audioDeviceId;
    } else {
      state.audioDeviceId = inputs[0].deviceId;
      els.audioDevice.value = state.audioDeviceId;
    }
  } catch (error) {
    renderAudioHelp(`Unable to list audio devices: ${humanizeAudioError(error)}`);
  }
}

function handleGlobalKeyDown(event) {
  if (event.code === "Escape" && els.scriptModal.open) {
    closeScriptModal();
    return;
  }

  if (event.code !== "Space" || event.repeat) {
    return;
  }

  const activeTag = document.activeElement?.tagName;
  if (activeTag === "INPUT" || activeTag === "TEXTAREA") {
    return;
  }

  event.preventDefault();
  startListening();
}

function handleGlobalKeyUp(event) {
  if (event.code !== "Space") {
    return;
  }

  stopListening();
}

async function startListening() {
  if (state.listening) {
    return;
  }

  try {
    if (state.audioSource === "system") {
      await ensureSystemAudioStream();
    } else {
      await ensureMicrophoneStream();
    }

    state.listening = true;
    state.transcript = "";
    state.lastCandidates = [];
    renderListeningState();
    els.transcriptOutput.textContent = "Recording...";
    els.candidateList.innerHTML = "";
    beginRecordingFromActiveStream();
  } catch (error) {
    state.listening = false;
    renderListeningState();
    els.transcriptOutput.textContent = `Unable to start audio capture: ${humanizeAudioError(error)}`;
  }
}

async function stopListening() {
  if (!state.listening) {
    return;
  }

  state.listening = false;
  renderListeningState();

  try {
    const audioBlob = await finishRecording();
    if (!audioBlob || audioBlob.size === 0) {
      els.transcriptOutput.textContent = "No audio captured.";
      return;
    }

    els.transcriptOutput.textContent = "Transcribing...";
    const result = await transcribeAudioBlob(audioBlob);
    state.transcript = result.transcript || "";
    els.transcriptOutput.textContent = state.transcript || "No speech recognized.";
    const candidates = await extractCandidates(state.transcript);
    renderCandidates(candidates);
    if (state.transcript && !candidates.length) {
      els.transcriptOutput.textContent =
        `${state.transcript}\n\nNo callsign pattern was recognized from that transcription.`;
    }
  } catch (error) {
    els.transcriptOutput.textContent = `Transcription failed: ${humanizeAudioError(error)}`;
  }
}

function beginRecordingFromActiveStream() {
  const stream = state.audioSource === "system" ? state.systemAudioStream : state.audioStream;
  if (!stream) {
    throw new Error("No active audio stream is available.");
  }

  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextClass) {
    throw new Error("This browser does not support Web Audio recording.");
  }

  cleanupRecordingNodes();
  state.recordedChunks = [];
  state.audioContext = new AudioContextClass();
  state.recordedSampleRate = state.audioContext.sampleRate;
  state.audioSourceNode = state.audioContext.createMediaStreamSource(stream);
  state.audioProcessor = state.audioContext.createScriptProcessor(4096, 1, 1);
  state.audioMonitorNode = state.audioContext.createGain();
  state.audioMonitorNode.gain.value = 0;

  state.audioProcessor.onaudioprocess = (event) => {
    const channelData = event.inputBuffer.getChannelData(0);
    state.recordedChunks.push(new Float32Array(channelData));
  };

  state.audioSourceNode.connect(state.audioProcessor);
  state.audioProcessor.connect(state.audioMonitorNode);
  state.audioMonitorNode.connect(state.audioContext.destination);
}

async function finishRecording() {
  const chunks = state.recordedChunks;
  const sampleRate = state.recordedSampleRate;

  cleanupRecordingNodes();

  if (!chunks.length) {
    return null;
  }

  const wavBuffer = encodeWavFromFloat32(chunks, sampleRate);
  state.recordedChunks = [];
  return new Blob([wavBuffer], { type: "audio/wav" });
}

function cleanupRecordingNodes() {
  if (state.audioProcessor) {
    state.audioProcessor.disconnect();
    state.audioProcessor.onaudioprocess = null;
    state.audioProcessor = null;
  }

  if (state.audioSourceNode) {
    state.audioSourceNode.disconnect();
    state.audioSourceNode = null;
  }

  if (state.audioMonitorNode) {
    state.audioMonitorNode.disconnect();
    state.audioMonitorNode = null;
  }

  if (state.audioContext) {
    void state.audioContext.close();
    state.audioContext = null;
  }
}

function encodeWavFromFloat32(chunks, sampleRate) {
  const totalSamples = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const wavBuffer = new ArrayBuffer(44 + totalSamples * 2);
  const view = new DataView(wavBuffer);

  writeAscii(view, 0, "RIFF");
  view.setUint32(4, 36 + totalSamples * 2, true);
  writeAscii(view, 8, "WAVE");
  writeAscii(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeAscii(view, 36, "data");
  view.setUint32(40, totalSamples * 2, true);

  let offset = 44;
  for (const chunk of chunks) {
    for (let index = 0; index < chunk.length; index += 1) {
      const sample = Math.max(-1, Math.min(1, chunk[index]));
      view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
      offset += 2;
    }
  }

  return wavBuffer;
}

function writeAscii(view, offset, value) {
  for (let index = 0; index < value.length; index += 1) {
    view.setUint8(offset + index, value.charCodeAt(index));
  }
}

async function transcribeAudioBlob(audioBlob) {
  const result = await apiRequest("/api/stt/transcribe", {
    method: "POST",
    body: await audioBlob.arrayBuffer(),
    headers: {
      "Content-Type": "audio/wav",
      "X-File-Name": "capture.wav",
    },
  });

  return result;
}

function renderListeningState() {
  els.listeningStatus.textContent = state.listening ? "Listening" : "Idle";
}

function renderAudioSourceControls() {
  const isSystemAudio = state.audioSource === "system";
  els.audioDeviceWrap.classList.toggle("hidden", isSystemAudio);
}

function renderAudioHelp(message = "") {
  if (message) {
    els.audioHelp.textContent = message;
    return;
  }

  if (state.audioSource === "system") {
    els.audioHelp.textContent =
      "System audio requires the browser share dialog. In most browsers, transcription support is more limited than microphone mode.";
    return;
  }

  els.audioHelp.textContent =
    "Microphone mode is the most reliable in the browser. If device names are blank, click Allow Audio Access first.";
}

function renderNetOptions() {
  const previousValue = els.netSelector.value;
  els.netSelector.innerHTML = "";

  state.nets.forEach((net) => {
    const option = document.createElement("option");
    option.value = net.id;
    option.textContent = net.name ? `${net.name} | ${net.date}` : "Untitled Net";
    els.netSelector.append(option);
  });

  els.netSelector.value = state.selectedNetId ?? previousValue ?? state.nets[0]?.id ?? "";
}

function setSelectedNet(netId) {
  state.selectedNetId = netId;
  els.netSelector.value = netId ?? "";

  const net = getSelectedNet();
  if (!net) {
    els.netForm.reset();
    els.rollCallList.innerHTML = "";
    els.openingSections.innerHTML = "";
    els.closingSections.innerHTML = "";
    return;
  }

  fillNetForm(net);
  renderScriptSections("opening", net.openingSections);
  renderScriptSections("closing", net.closingSections);
  renderRollCallList(net.rollCall);
}

function fillNetForm(net) {
  els.netForm.elements.name.value = net.name;
  els.netForm.elements.date.value = net.date;
  els.netForm.elements.time.value = net.time;
  els.netForm.elements.frequency.value = net.frequency;
  els.netForm.elements.mode.value = net.mode;
  els.netForm.elements.repeaterName.value = net.repeaterName;
  els.netForm.elements.repeaterOffset.value = net.repeaterOffset;
  els.netForm.elements.plTone.value = net.plTone;
  els.netForm.elements.netControlCallsign.value = net.netControlCallsign || "";
  renderNetControlDetails({
    callsign: net.netControlCallsign || "",
    name: net.netControlName || "",
    location: net.netControlLocation || "",
    source: net.netControlCallsign ? "Saved net record" : "",
  });

  const modeRadio = els.netForm.querySelector(`input[name="mode"][value="${net.mode}"]`);
  if (modeRadio) {
    modeRadio.checked = true;
  }
  renderRepeaterFieldsVisibility();
}

function renderRepeaterFieldsVisibility() {
  const mode = els.netForm.elements.mode.value;
  els.repeaterFields.classList.toggle("hidden", mode === "simplex");
}

function renderScriptSections(kind, sections) {
  const container = kind === "opening" ? els.openingSections : els.closingSections;
  container.innerHTML = "";

  sections.forEach((section, index) => {
    const fragment = els.scriptTemplate.content.cloneNode(true);
    const card = fragment.querySelector(".script-card");
    const preview = fragment.querySelector(".script-preview");
    const editButton = fragment.querySelector(".edit-section");
    const addButton = fragment.querySelector(".add-section");

    card.dataset.kind = kind;
    card.dataset.sectionId = section.id;
    preview.textContent = section.text || "Click to add text for this section.";
    preview.classList.toggle("script-preview-empty", !section.text.trim());
    preview.addEventListener("click", () => openScriptModal(kind, section.id));
    editButton.addEventListener("click", () => openScriptModal(kind, section.id));
    addButton.addEventListener("click", () => addScriptSection(kind, index + 1));

    container.append(fragment);
  });
}

function addScriptSection(kind, insertAtIndex) {
  const sections = getScriptSectionsFromUi(kind);
  const nextSections = [...sections];
  nextSections.splice(insertAtIndex, 0, {
    id: crypto.randomUUID(),
    text: "",
  });
  renderScriptSections(kind, nextSections);
  openScriptModal(kind, nextSections[insertAtIndex].id);
}

function openScriptModal(kind, sectionId) {
  const sections = getScriptSectionsFromUi(kind);
  const section = sections.find((entry) => entry.id === sectionId);
  if (!section) {
    return;
  }

  state.modalSection = { kind, sectionId };
  els.scriptModalTitle.textContent = `${capitalize(kind)} Script Section`;
  els.scriptModalText.value = section.text;
  els.scriptModal.showModal();
  els.scriptModalText.focus();
}

function closeScriptModal() {
  state.modalSection = null;
  els.scriptModal.close();
}

function openStationNoteModal(station) {
  state.noteModalStationId = station.id;
  els.stationNoteTitle.textContent = `Notes for ${station.callsign}`;
  els.stationNoteText.value = station.note || "";
  els.stationNoteModal.showModal();
  els.stationNoteText.focus();
}

function closeStationNoteModal() {
  state.noteModalStationId = null;
  els.stationNoteModal.close();
}

async function saveScriptModal() {
  if (!state.modalSection) {
    return;
  }

  const { kind, sectionId } = state.modalSection;
  const updatedSections = getScriptSectionsFromUi(kind).map((section) =>
    section.id === sectionId ? { ...section, text: els.scriptModalText.value } : section
  );
  renderScriptSections(kind, updatedSections);
  closeScriptModal();
  await saveCurrentNet();
}

async function saveStationNoteModal() {
  if (!state.noteModalStationId) {
    return;
  }

  await updateStation(state.noteModalStationId, { note: els.stationNoteText.value });
  closeStationNoteModal();
}

function getScriptSectionsFromUi(kind) {
  const container = kind === "opening" ? els.openingSections : els.closingSections;
  const cards = [...container.querySelectorAll(".script-card")];

  if (!cards.length) {
    return [{ id: crypto.randomUUID(), text: "" }];
  }

  return cards.map((card) => ({
    id: card.dataset.sectionId,
    text: card.querySelector(".script-preview").classList.contains("script-preview-empty")
      ? ""
      : card.querySelector(".script-preview").textContent,
  }));
}

function renderRollCallList(stations) {
  els.rollCallList.innerHTML = "";

  if (stations.length === 0) {
    els.rollCallList.innerHTML = '<p class="capture-note">No stations entered yet.</p>';
    return;
  }

  stations.forEach((station) => {
    const fragment = els.rollCallTemplate.content.cloneNode(true);
    const wrapper = fragment.querySelector(".roll-call-item");
    const checkbox = fragment.querySelector(".station-present");
    const summaryEl = fragment.querySelector(".station-summary");
    const notePreviewEl = fragment.querySelector(".station-note-preview");
    const noteButton = fragment.querySelector(".note-button");
    const removeButton = fragment.querySelector(".remove-station");

    wrapper.dataset.stationId = station.id;
    checkbox.checked = station.present;
    checkbox.addEventListener("change", () => {
      updateStation(station.id, { present: checkbox.checked });
    });

    wrapper.addEventListener("dragstart", () => {
      state.draggedStationId = station.id;
      wrapper.classList.add("dragging");
    });

    wrapper.addEventListener("dragend", () => {
      state.draggedStationId = null;
      wrapper.classList.remove("dragging");
      clearDragOverStyles();
    });

    wrapper.addEventListener("dragover", (event) => {
      event.preventDefault();
      if (state.draggedStationId && state.draggedStationId !== station.id) {
        wrapper.classList.add("drag-over");
      }
    });

    wrapper.addEventListener("dragleave", () => {
      wrapper.classList.remove("drag-over");
    });

    wrapper.addEventListener("drop", async (event) => {
      event.preventDefault();
      wrapper.classList.remove("drag-over");
      if (!state.draggedStationId || state.draggedStationId === station.id) {
        return;
      }
      await reorderRollCall(state.draggedStationId, station.id);
    });

    summaryEl.textContent = formatStationSummary(station);
    notePreviewEl.textContent = station.note?.trim() ? truncateStationNote(station.note) : "";
    notePreviewEl.classList.toggle("hidden", !station.note?.trim());
    noteButton.classList.toggle("note-button-active", Boolean(station.note?.trim()));
    noteButton.addEventListener("click", () => openStationNoteModal(station));
    removeButton.addEventListener("click", () => removeStation(station.id));
    els.rollCallList.append(fragment);
  });
}

function formatStationSummary(station) {
  const parts = [station.callsign];
  if (station.name) {
    parts.push(station.name);
  }

  const city = extractCityFromLocation(station.location);
  if (city) {
    parts.push(city);
  }

  return parts.join(" | ");
}

function extractCityFromLocation(location) {
  const trimmed = String(location || "").trim();
  if (!trimmed) {
    return "";
  }

  return trimmed.split(",")[0].trim();
}

function truncateStationNote(note) {
  const normalized = String(note || "").replace(/\s+/g, " ").trim();
  if (normalized.length <= 48) {
    return normalized;
  }

  return `${normalized.slice(0, 45)}...`;
}

function clearDragOverStyles() {
  els.rollCallList.querySelectorAll(".drag-over").forEach((element) => {
    element.classList.remove("drag-over");
  });
}

async function reorderRollCall(draggedStationId, targetStationId) {
  const currentNet = getSelectedNet();
  if (!currentNet) {
    return;
  }

  const stationIds = currentNet.rollCall.map((station) => station.id);
  const draggedIndex = stationIds.indexOf(draggedStationId);
  const targetIndex = stationIds.indexOf(targetStationId);

  if (draggedIndex < 0 || targetIndex < 0) {
    return;
  }

  stationIds.splice(targetIndex, 0, stationIds.splice(draggedIndex, 1)[0]);

  await apiRequest(`/api/nets/${currentNet.id}/stations/reorder`, {
    method: "POST",
    body: { stationIds },
  });

  await refreshNets(currentNet.id);
}

function renderLookupResults(results, query) {
  els.lookupResult.innerHTML = "";

  const heading = document.createElement("div");
  heading.className = "lookup-result-heading";
  heading.textContent = results.length === 1 && results[0].callsign === query
    ? "Lookup result"
    : `Matches for ${query}`;
  els.lookupResult.append(heading);

  results.forEach((result) => {
    const row = document.createElement("div");
    row.className = "lookup-result-row";

    const details = document.createElement("div");
    details.className = "lookup-result-details";
    details.innerHTML = `
      <strong>${result.callsign}</strong>
      <span>${result.name || "Unknown operator"}</span>
      <span>${result.location || "Location unavailable"}</span>
      <small>Source: ${result.source}</small>
    `;

    const rankPill = document.createElement("span");
    rankPill.className = `rank-pill rank-pill-${result.confidence || "low"}`;
    rankPill.textContent = result.rank ? `${result.rank}% match` : "manual";

    const addButton = document.createElement("button");
    addButton.type = "button";
    addButton.className = "button button-primary";
    addButton.textContent = "Add";
    addButton.addEventListener("click", async () => {
      await addStationToSelectedNet(makeStation(result.callsign, result.name || "", result.location || ""));
    });

    row.append(details, rankPill, addButton);
    els.lookupResult.append(row);
  });
}

function renderNetControlDetails(result) {
  els.netControlDetails.dataset.name = result?.name || "";
  els.netControlDetails.dataset.location = result?.location || "";

  if (!result?.callsign) {
    els.netControlDetails.innerHTML = `
      <span class="net-control-label">Net Control</span>
      <strong>No net control selected</strong>
      <small>Enter a callsign to look up name and location.</small>
    `;
    return;
  }

  if (result.loading) {
    els.netControlDetails.innerHTML = `
      <span class="net-control-label">Net Control</span>
      <strong>${result.callsign}</strong>
      <small>Looking up operator...</small>
    `;
    return;
  }

  els.netControlDetails.innerHTML = `
    <span class="net-control-label">Net Control</span>
    <strong>${result.callsign}</strong>
    <span>${result.name || "Unknown operator"}</span>
    <small>${result.location || "Location unavailable"}</small>
  `;
}

function renderCandidates(candidates) {
  state.lastCandidates = candidates;
  els.candidateList.innerHTML = "";

  if (!candidates.length) {
    return;
  }

  candidates.forEach((candidate) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `candidate-chip candidate-chip-${candidate.confidence || "medium"}`;
    button.textContent = candidate.callsign;
    button.title = candidate.name ? `${candidate.name} | ${candidate.location}` : "Add to roll call";
    button.addEventListener("click", async () => {
      await addStationToSelectedNet(makeStation(candidate.callsign, candidate.name || "", candidate.location || ""));
    });
    els.candidateList.append(button);
  });
}

async function addStationToSelectedNet(station) {
  const currentNet = getSelectedNet();
  if (!currentNet) {
    return;
  }

  const alreadyExists = currentNet.rollCall.some((entry) => entry.callsign === station.callsign);
  if (alreadyExists) {
    return;
  }

  await apiRequest(`/api/nets/${currentNet.id}/stations`, {
    method: "POST",
    body: station,
  });

  await refreshNets(currentNet.id);
}

async function updateStation(stationId, partial) {
  const currentNet = getSelectedNet();
  if (!currentNet) {
    return;
  }

  await apiRequest(`/api/nets/${currentNet.id}/stations/${stationId}`, {
    method: "PATCH",
    body: partial,
  });

  await refreshNets(currentNet.id);
}

async function removeStation(stationId) {
  const currentNet = getSelectedNet();
  if (!currentNet) {
    return;
  }

  await apiRequest(`/api/nets/${currentNet.id}/stations/${stationId}`, {
    method: "DELETE",
  });

  await refreshNets(currentNet.id);
}

async function setAllStationsPresent(present) {
  const currentNet = getSelectedNet();
  if (!currentNet) {
    return;
  }

  await Promise.all(
    currentNet.rollCall.map((station, index) =>
      apiRequest(`/api/nets/${currentNet.id}/stations/${station.id}`, {
        method: "PATCH",
        body: { present, sortOrder: index },
      })
    )
  );

  await refreshNets(currentNet.id);
}

async function extractCandidates(transcript) {
  const candidates = parseCallsignCandidates(transcript);
  const result = await apiRequest("/api/callsigns/candidates-from-transcript", {
    method: "POST",
    body: { transcript, callsigns: candidates },
  });

  return result.candidates || [];
}

function parseCallsignCandidates(transcript) {
  const compact = transcript
    .toUpperCase()
    .replace(/[^A-Z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!compact) {
    return [];
  }

  const joined = compact.replace(/\s/g, "");
  const directMatches = joined.match(/[AKNW][A-Z]?\d[A-Z]{1,3}/g) ?? [];
  const tokenMatches = compact.match(/[AKNW][A-Z]?\s*\d\s*[A-Z]{1,3}/g) ?? [];
  const normalizedTokens = tokenMatches.map((entry) => entry.replace(/\s/g, ""));
  const sequenceMatches = extractCallsignsFromTranscriptStream(compact);

  return [
    ...new Set(
      [...directMatches, ...normalizedTokens, ...sequenceMatches]
        .map(normalizeCallsign)
        .filter(isLikelyCallsign)
    ),
  ];
}

async function lookupCallsign(callsign) {
  return apiRequest("/api/callsigns/lookup", {
    method: "POST",
    body: { callsign },
  });
}

async function searchCallsigns(query) {
  return apiRequest("/api/callsigns/search", {
    method: "POST",
    body: { query, limit: 50 },
  });
}

async function refreshNets(selectedNetId = state.selectedNetId) {
  const nets = await apiRequest("/api/nets");
  state.nets = nets;
  renderNetOptions();
  setSelectedNet(selectedNetId ?? state.nets[0]?.id ?? null);
}

function getSelectedNet() {
  return state.nets.find((net) => net.id === state.selectedNetId) ?? null;
}

function makeNet(overrides) {
  return {
    id: crypto.randomUUID(),
    name: "",
    date: "",
    time: "",
    frequency: "",
    mode: "repeater",
    repeaterName: "",
    repeaterOffset: "",
    plTone: "",
    netControlCallsign: "",
    netControlName: "",
    netControlLocation: "",
    openingSections: [{ id: crypto.randomUUID(), text: "" }],
    closingSections: [{ id: crypto.randomUUID(), text: "" }],
    ...overrides,
  };
}

function makeStation(callsign, note = "", location = "") {
  return {
    id: crypto.randomUUID(),
    callsign,
    location,
    note,
    present: false,
  };
}

function makeUnknownLookupResult(callsign) {
  return {
    callsign,
    name: "",
    location: "",
    source: "No exact or partial FCC match",
  };
}

function normalizeCallsign(value) {
  return String(value || "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .trim();
}

function normalizeCallsignSearchQuery(value) {
  return String(value || "")
    .toUpperCase()
    .replace(/[^A-Z0-9*?_]/g, "")
    .trim();
}

function capitalize(value) {
  return `${String(value).slice(0, 1).toUpperCase()}${String(value).slice(1)}`;
}

function extractCallsignsFromTranscriptStream(transcript) {
  const stream = buildSymbolStream(transcript);
  const candidates = [];

  let currentRun = [];
  for (const symbol of stream) {
    if (symbol) {
      currentRun.push(symbol);
      continue;
    }

    candidates.push(...extractCallsignsFromSymbolRun(currentRun));
    currentRun = [];
  }

  candidates.push(...extractCallsignsFromSymbolRun(currentRun));
  return candidates;
}

function buildSymbolStream(transcript) {
  const tokens = transcript.split(/\s+/).filter(Boolean);
  const symbols = [];

  for (let index = 0; index < tokens.length; index += 1) {
    const phraseMatch = matchSpokenPhrase(tokens, index);
    if (phraseMatch) {
      symbols.push([phraseMatch.symbol]);
      index += phraseMatch.consumed - 1;
      continue;
    }

    const normalizedToken = normalizeCallsignTokenCandidates(tokens[index]);
    if (!normalizedToken.length) {
      symbols.push(null);
      continue;
    }

    if (normalizedToken.length === 1 && isLikelyCallsign(normalizedToken[0])) {
      symbols.push(...normalizedToken[0].split("").map((character) => [character]));
      continue;
    }

    symbols.push(normalizedToken);
  }

  return symbols;
}

function extractCallsignsFromSymbolRun(run) {
  if (run.length < 4) {
    return [];
  }

  const candidates = [];
  for (let length = 4; length <= 6; length += 1) {
    for (let start = 0; start <= run.length - length; start += 1) {
      const window = run.slice(start, start + length);
      for (const candidate of expandCandidateWindows(window)) {
        if (isLikelyCallsign(candidate)) {
          candidates.push(candidate);
        }
      }
    }
  }

  return candidates;
}

function matchSpokenPhrase(tokens, startIndex) {
  for (const length of [3, 2]) {
    const phrase = tokens.slice(startIndex, startIndex + length).join(" ");
    if (SPOKEN_CALLSIGN_PHRASES[phrase]) {
      return {
        symbol: SPOKEN_CALLSIGN_PHRASES[phrase],
        consumed: length,
      };
    }
  }

  return null;
}

function normalizeCallsignTokenCandidates(token) {
  const candidates = [];

  if (SPOKEN_CALLSIGN_MAP[token]) {
    candidates.push(SPOKEN_CALLSIGN_MAP[token]);
  }

  if (/^[A-Z]$/.test(token) || /^\d$/.test(token)) {
    candidates.push(token);
  }

  if (isLikelyCallsign(token)) {
    candidates.push(token);
  }

  for (const [spoken, symbol] of Object.entries(SPOKEN_CALLSIGN_MAP)) {
    if (spoken.length >= 3 && token.includes(spoken)) {
      candidates.push(symbol);
    }

    if (levenshteinDistance(token, spoken) <= phoneticDistanceThreshold(token, spoken)) {
      candidates.push(symbol);
    }
  }

  if (/^[A-Z]{2,}$/.test(token)) {
    candidates.push(token[0]);
  }

  return [...new Set(candidates.filter(Boolean))].slice(0, 3);
}

function expandCandidateWindows(window) {
  const results = [];

  function visit(index, current) {
    if (results.length >= 32) {
      return;
    }

    if (index >= window.length) {
      results.push(current);
      return;
    }

    for (const symbol of window[index]) {
      visit(index + 1, current + symbol);
    }
  }

  visit(0, "");
  return results;
}

function phoneticDistanceThreshold(token, spoken) {
  const maxLength = Math.max(token.length, spoken.length);
  if (maxLength <= 4) {
    return 1;
  }
  if (maxLength <= 7) {
    return 2;
  }
  return 3;
}

function levenshteinDistance(left, right) {
  const rows = left.length + 1;
  const cols = right.length + 1;
  const matrix = Array.from({ length: rows }, () => new Array(cols).fill(0));

  for (let row = 0; row < rows; row += 1) {
    matrix[row][0] = row;
  }

  for (let col = 0; col < cols; col += 1) {
    matrix[0][col] = col;
  }

  for (let row = 1; row < rows; row += 1) {
    for (let col = 1; col < cols; col += 1) {
      const cost = left[row - 1] === right[col - 1] ? 0 : 1;
      matrix[row][col] = Math.min(
        matrix[row - 1][col] + 1,
        matrix[row][col - 1] + 1,
        matrix[row - 1][col - 1] + cost
      );
    }
  }

  return matrix[rows - 1][cols - 1];
}

function isLikelyCallsign(value) {
  return /^[AKNW][A-Z]?\d[A-Z]{1,3}$/.test(value);
}

async function ensureMicrophoneStream() {
  cleanupSystemAudioStream();
  cleanupAudioStream();

  const constraints = {
    audio: state.audioDeviceId
      ? {
          deviceId: { exact: state.audioDeviceId },
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        }
      : {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        },
  };

  state.audioStream = await navigator.mediaDevices.getUserMedia(constraints);
  state.audioPermissionGranted = true;
}

async function ensureSystemAudioStream() {
  cleanupAudioStream();
  cleanupSystemAudioStream();

  if (!navigator.mediaDevices?.getDisplayMedia) {
    throw new Error("This browser does not support system audio capture.");
  }

  state.systemAudioStream = await navigator.mediaDevices.getDisplayMedia({
    video: true,
    audio: true,
  });

  if (!state.systemAudioStream.getAudioTracks().length) {
    cleanupSystemAudioStream();
    throw new Error("No system-audio track was shared. Choose a source with audio enabled.");
  }

  state.audioPermissionGranted = true;
}

function cleanupAudioStream() {
  if (!state.audioStream) {
    return;
  }

  state.audioStream.getTracks().forEach((track) => track.stop());
  state.audioStream = null;
}

function cleanupSystemAudioStream() {
  if (!state.systemAudioStream) {
    return;
  }

  state.systemAudioStream.getTracks().forEach((track) => track.stop());
  state.systemAudioStream = null;
}

function humanizeAudioError(error) {
  const name = error?.name || "";
  if (name === "NotAllowedError" || name === "PermissionDeniedError") {
    return "browser permission was denied";
  }
  if (name === "NotFoundError" || name === "DevicesNotFoundError") {
    return "no matching audio device was found";
  }
  if (name === "NotReadableError" || name === "TrackStartError") {
    return "the selected audio device is busy or unavailable";
  }
  return error?.message || "unknown audio error";
}

const SPOKEN_CALLSIGN_MAP = {
  ALFA: "A",
  ALPHA: "A",
  BRAVO: "B",
  CHARLIE: "C",
  DELTA: "D",
  ECHO: "E",
  FOXTROT: "F",
  GOLF: "G",
  HOTEL: "H",
  INDIA: "I",
  JULIET: "J",
  JULIETT: "J",
  KILO: "K",
  LIMA: "L",
  LEMA: "L",
  LEMAH: "L",
  LEMUR: "L",
  MIKE: "M",
  EN: "N",
  IN: "N",
  NOVEMBER: "N",
  OSCAR: "O",
  PAPA: "P",
  QUEBEC: "Q",
  ROMEO: "R",
  SIERRA: "S",
  TANGO: "T",
  UNIFORM: "U",
  VICTOR: "V",
  VICTA: "V",
  WHISKEY: "W",
  WHISKY: "W",
  WHISKI: "W",
  XRAY: "X",
  XRAYS: "X",
  "X-RAY": "X",
  YANKEE: "Y",
  ZULU: "Z",
  ZERO: "0",
  OH: "0",
  ONE: "1",
  TWO: "2",
  TO: "2",
  TOO: "2",
  THREE: "3",
  FOUR: "4",
  FOR: "4",
  FIVE: "5",
  SIX: "6",
  SEVEN: "7",
  EIGHT: "8",
  ATE: "8",
  AT: "8",
  NINE: "9",
};

const SPOKEN_CALLSIGN_PHRASES = {
  "AL FA": "A",
  "FOX TROT": "F",
  "HO TEL": "H",
  "KEE LOH": "K",
  "LEE MA": "L",
  "LEE MUH": "L",
  "KEY LO": "K",
  "WHIS KEY": "W",
  "WHIS KY": "W",
  "X RAY": "X",
  "DOUBLE YOU": "W",
};

async function apiRequest(path, options = {}) {
  const response = await fetch(path, {
    method: options.method ?? "GET",
    headers: options.headers ?? {
      "Content-Type": "application/json",
    },
    body: options.body
      ? options.headers
        ? options.body
        : JSON.stringify(options.body)
      : undefined,
  });

  if (!response.ok) {
    let message = `Request failed with status ${response.status}`;
    try {
      const payload = await response.json();
      if (payload?.error) {
        message = payload.error;
      }
    } catch {
      // Leave fallback message in place.
    }
    throw new Error(message);
  }

  return response.status === 204 ? null : response.json();
}
