// Tab Area Recorder - Content Script
(() => {
  if (window.__TAR_INITIALIZED__) return;
  window.__TAR_INITIALIZED__ = true;

  // State
  let state = "idle"; // "idle" | "recording" | "paused"
  let rect = {
    x: Math.round(window.innerWidth * 0.2),
    y: Math.round(window.innerHeight * 0.2),
    w: Math.round(window.innerWidth * 0.6),
    h: Math.round(window.innerHeight * 0.6)
  };

  let mediaRecorder = null;
  let recordedChunks = [];
  let displayStream = null;
  let micStream = null;
  let audioCtx = null;
  let micGainNode = null;
  let micCheckInterval = null;
  let canvasStream = null;
  let rafId = null;

  // DOM Elements
  let rootEl = null;
  let cropTargetEl = null;
  let frameEl = null;
  let controlsEl = null;
  let startPauseBtn = null;
  let stopBtn = null;

  const MIN_SIZE = 80;
  const FRAME_BORDER = 2;

  function clampRect(r) {
    const maxW = window.innerWidth;
    const maxH = window.innerHeight;
    const w = Math.max(MIN_SIZE, Math.min(r.w, maxW - 16));
    const h = Math.max(MIN_SIZE, Math.min(r.h, maxH - 16));
    const x = Math.max(4, Math.min(r.x, maxW - w - 4));
    const y = Math.max(4, Math.min(r.y, maxH - h - 4));
    return { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) };
  }

  function updateLayout() {
    if (!rootEl) return;
    rect = clampRect(rect);

    // 1. Exact inner crop target (captured by Region Capture CropTarget)
    cropTargetEl.style.left = `${rect.x}px`;
    cropTargetEl.style.top = `${rect.y}px`;
    cropTargetEl.style.width = `${rect.w}px`;
    cropTargetEl.style.height = `${rect.h}px`;

    // 2. Selection border sits strictly outside the crop target so border pixels aren't recorded
    frameEl.style.left = `${rect.x - FRAME_BORDER}px`;
    frameEl.style.top = `${rect.y - FRAME_BORDER}px`;
    frameEl.style.width = `${rect.w}px`;
    frameEl.style.height = `${rect.h}px`;

    // 3. Position the 2-button control bar strictly outside the crop target
    const ctrlRect = controlsEl.getBoundingClientRect();
    const ctrlW = ctrlRect.width || 150;
    const ctrlH = ctrlRect.height || 40;
    const gap = 10;

    let ctrlTop = rect.y + rect.h + gap;
    if (ctrlTop + ctrlH > window.innerHeight - 6) {
      ctrlTop = rect.y - ctrlH - gap;
    }
    if (ctrlTop < 6) {
      // Fallback: place outside horizontally or at bottom-right of viewport outside crop if possible
      ctrlTop = Math.max(6, window.innerHeight - ctrlH - 10);
    }

    let ctrlLeft = rect.x + rect.w - ctrlW;
    ctrlLeft = Math.max(8, Math.min(ctrlLeft, window.innerWidth - ctrlW - 8));

    controlsEl.style.left = `${Math.round(ctrlLeft)}px`;
    controlsEl.style.top = `${Math.round(ctrlTop)}px`;
  }

  function syncButtons() {
    if (!startPauseBtn || !stopBtn) return;
    startPauseBtn.classList.remove("is-recording", "is-paused");
    frameEl.classList.remove("tar-recording", "tar-paused");

    if (state === "idle") {
      startPauseBtn.textContent = "Start";
      stopBtn.disabled = true;
    } else if (state === "recording") {
      startPauseBtn.textContent = "Pause";
      startPauseBtn.classList.add("is-recording");
      frameEl.classList.add("tar-recording");
      stopBtn.disabled = false;
    } else if (state === "paused") {
      startPauseBtn.textContent = "Start";
      startPauseBtn.classList.add("is-paused");
      frameEl.classList.add("tar-paused");
      stopBtn.disabled = false;
    }
  }

  function attachDragAndResize() {
    let action = null; // "move" | handle direction
    let startX = 0;
    let startY = 0;
    let startRect = null;

    frameEl.addEventListener("mousedown", (e) => {
      if (state !== "idle" || e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();

      const handle = e.target.closest(".tar-handle");
      action = handle ? handle.dataset.dir : "move";
      startX = e.clientX;
      startY = e.clientY;
      startRect = { ...rect };

      const onMouseMove = (ev) => {
        const dx = ev.clientX - startX;
        const dy = ev.clientY - startY;
        let next = { ...startRect };

        if (action === "move") {
          next.x += dx;
          next.y += dy;
        } else {
          if (action.includes("e")) next.w = Math.max(MIN_SIZE, startRect.w + dx);
          if (action.includes("s")) next.h = Math.max(MIN_SIZE, startRect.h + dy);
          if (action.includes("w")) {
            const newW = Math.max(MIN_SIZE, startRect.w - dx);
            next.x = startRect.x + (startRect.w - newW);
            next.w = newW;
          }
          if (action.includes("n")) {
            const newH = Math.max(MIN_SIZE, startRect.h - dy);
            next.y = startRect.y + (startRect.h - newH);
            next.h = newH;
          }
        }
        rect = clampRect(next);
        updateLayout();
      };

      const onMouseUp = () => {
        window.removeEventListener("mousemove", onMouseMove, true);
        window.removeEventListener("mouseup", onMouseUp, true);
      };

      window.addEventListener("mousemove", onMouseMove, true);
      window.addEventListener("mouseup", onMouseUp, true);
    });
  }

  /**
   * Checks whether the microphone track is actively unmuted.
   * Also checks if the current page has an active web-app mic mute button or track state.
   */
  function isMicUnmuted(micTrack) {
    if (!micTrack || micTrack.readyState !== "live") return false;
    if (!micTrack.enabled || micTrack.muted) return false;
    return true;
  }

  /**
   * Builds a combined audio track containing:
   * 1. System / Tab audio (from displayStream)
   * 2. Microphone audio (automatically gated so it is ONLY mixed when unmuted)
   */
  async function createMixedAudioStream(displayMediaStream) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const destination = audioCtx.createMediaStreamDestination();
    let hasAnyAudioSource = false;

    // 1. Add system / tab audio if present in displayStream
    const sysAudioTracks = displayMediaStream.getAudioTracks();
    if (sysAudioTracks.length > 0) {
      const sysStream = new MediaStream([sysAudioTracks[0]]);
      const sysSource = audioCtx.createMediaStreamSource(sysStream);
      sysSource.connect(destination);
      hasAnyAudioSource = true;
    }

    // 2. Request microphone stream and gate it strictly by unmuted state
    try {
      micStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true
        },
        video: false
      });

      const micTrack = micStream.getAudioTracks()[0];
      if (micTrack) {
        const micSource = audioCtx.createMediaStreamSource(new MediaStream([micTrack]));
        micGainNode = audioCtx.createGain();

        const syncMicGain = () => {
          if (!audioCtx || !micGainNode) return;
          const active = isMicUnmuted(micTrack) && state === "recording";
          micGainNode.gain.setTargetAtTime(active ? 1.0 : 0.0, audioCtx.currentTime, 0.015);
        };

        // Initial gain based on mute status
        micGainNode.gain.value = isMicUnmuted(micTrack) ? 1.0 : 0.0;
        micSource.connect(micGainNode);
        micGainNode.connect(destination);
        hasAnyAudioSource = true;

        micTrack.addEventListener("mute", syncMicGain);
        micTrack.addEventListener("unmute", syncMicGain);
        micTrack.addEventListener("ended", syncMicGain);
        micCheckInterval = window.setInterval(syncMicGain, 250);
      }
    } catch {
      // Microphone unavailable or permission denied: continue with system audio only
      micStream = null;
    }

    return hasAnyAudioSource ? destination.stream.getAudioTracks() : [];
  }

  /**
   * Crops video stream to the selected tab area:
   * - Uses native Chromium Region Capture API (CropTarget) at default resolution when available
   * - Falls back to an offscreen canvas crop at native pixel resolution otherwise
   */
  async function getCroppedVideoTrack(displayMediaStream) {
    const [videoTrack] = displayMediaStream.getVideoTracks();
    if (!videoTrack) throw new Error("No video track available.");

    // Primary path: Region Capture API (native resolution & framerate, zero copy)
    if (typeof window.CropTarget !== "undefined" && typeof videoTrack.cropTo === "function") {
      try {
        const cropTarget = await window.CropTarget.fromElement(cropTargetEl);
        await videoTrack.cropTo(cropTarget);
        return videoTrack;
      } catch {
        // Fall through to canvas crop if user selected a non-tab surface
      }
    }

    // Fallback path: Canvas cropping at native display resolution
    const videoEl = document.createElement("video");
    videoEl.srcObject = new MediaStream([videoTrack]);
    videoEl.muted = true;
    videoEl.playsInline = true;
    await videoEl.play();

    const dpr = window.devicePixelRatio || 1;
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(2, Math.round(rect.w * dpr));
    canvas.height = Math.max(2, Math.round(rect.h * dpr));
    const ctx = canvas.getContext("2d", { alpha: false });

    const renderFrame = () => {
      if (!videoEl.paused && !videoEl.ended && videoEl.videoWidth > 0) {
        const scaleX = videoEl.videoWidth / window.innerWidth;
        const scaleY = videoEl.videoHeight / window.innerHeight;
        ctx.drawImage(
          videoEl,
          rect.x * scaleX,
          rect.y * scaleY,
          rect.w * scaleX,
          rect.h * scaleY,
          0,
          0,
          canvas.width,
          canvas.height
        );
      }
      rafId = requestAnimationFrame(renderFrame);
    };
    renderFrame();

    canvasStream = canvas.captureStream();
    return canvasStream.getVideoTracks()[0];
  }

  async function startRecording() {
    try {
      // Capture current tab with system/tab audio at default native resolution & quality
      displayStream = await navigator.mediaDevices.getDisplayMedia({
        video: {
          displaySurface: "browser"
        },
        audio: true,
        preferCurrentTab: true,
        selfBrowserSurface: "include",
        systemAudio: "include"
      });

      const croppedVideoTrack = await getCroppedVideoTrack(displayStream);
      const mixedAudioTracks = await createMixedAudioStream(displayStream);

      const combinedStream = new MediaStream([
        croppedVideoTrack,
        ...mixedAudioTracks
      ]);

      recordedChunks = [];
      // Use browser default resolution & quality (no custom bitrate/dimension overrides)
      mediaRecorder = new MediaRecorder(combinedStream);

      mediaRecorder.ondataavailable = (event) => {
        if (event.data && event.data.size > 0) {
          recordedChunks.push(event.data);
        }
      };

      mediaRecorder.onstop = () => {
        saveRecording();
        cleanupStreams();
        state = "idle";
        syncButtons();
      };

      // Stop automatically if the user stops screen sharing from Chrome's native bar
      displayStream.getVideoTracks()[0].addEventListener("ended", () => {
        if (state !== "idle") {
          stopRecording();
        }
      });

      mediaRecorder.start(250);
      state = "recording";
      syncButtons();
    } catch {
      cleanupStreams();
      state = "idle";
      syncButtons();
    }
  }

  function toggleStartPause() {
    if (state === "idle") {
      startRecording();
    } else if (state === "recording" && mediaRecorder?.state === "recording") {
      mediaRecorder.pause();
      if (audioCtx && micGainNode) {
        micGainNode.gain.setTargetAtTime(0.0, audioCtx.currentTime, 0.01);
      }
      state = "paused";
      syncButtons();
    } else if (state === "paused" && mediaRecorder?.state === "paused") {
      mediaRecorder.resume();
      if (audioCtx && micGainNode && micStream) {
        const micTrack = micStream.getAudioTracks()[0];
        micGainNode.gain.setTargetAtTime(isMicUnmuted(micTrack) ? 1.0 : 0.0, audioCtx.currentTime, 0.01);
      }
      state = "recording";
      syncButtons();
    }
  }

  function stopRecording() {
    if (!mediaRecorder || state === "idle") return;
    if (mediaRecorder.state !== "inactive") {
      mediaRecorder.stop();
    }
  }

  function saveRecording() {
    if (!recordedChunks.length) return;
    const mimeType = mediaRecorder?.mimeType || "video/webm";
    const blob = new Blob(recordedChunks, { type: mimeType });
    recordedChunks = [];

    const ext = mimeType.includes("mp4") ? "mp4" : "webm";
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const url = URL.createObjectURL(blob);

    const a = document.createElement("a");
    a.style.display = "none";
    a.href = url;
    a.download = `tab-area-recording-${timestamp}.${ext}`;
    document.body.appendChild(a);
    a.click();

    setTimeout(() => {
      URL.revokeObjectURL(url);
      a.remove();
    }, 2000);
  }

  function cleanupStreams() {
    if (rafId) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
    if (micCheckInterval) {
      clearInterval(micCheckInterval);
      micCheckInterval = null;
    }
    if (canvasStream) {
      canvasStream.getTracks().forEach((t) => t.stop());
      canvasStream = null;
    }
    if (displayStream) {
      displayStream.getTracks().forEach((t) => t.stop());
      displayStream = null;
    }
    if (micStream) {
      micStream.getTracks().forEach((t) => t.stop());
      micStream = null;
    }
    if (audioCtx) {
      audioCtx.close().catch(() => {});
      audioCtx = null;
      micGainNode = null;
    }
    mediaRecorder = null;
  }

  function buildUI() {
    rootEl = document.createElement("div");
    rootEl.id = "tar-root";

    cropTargetEl = document.createElement("div");
    cropTargetEl.id = "tar-crop-target";

    frameEl = document.createElement("div");
    frameEl.id = "tar-selection-frame";

    ["nw", "n", "ne", "e", "se", "s", "sw", "w"].forEach((dir) => {
      const handle = document.createElement("div");
      handle.className = `tar-handle ${dir}`;
      handle.dataset.dir = dir;
      frameEl.appendChild(handle);
    });

    controlsEl = document.createElement("div");
    controlsEl.id = "tar-controls";

    // Strictly ONLY Start/Pause and Stop buttons
    startPauseBtn = document.createElement("button");
    startPauseBtn.id = "tar-btn-start-pause";
    startPauseBtn.className = "tar-btn";
    startPauseBtn.type = "button";
    startPauseBtn.textContent = "Start";
    startPauseBtn.addEventListener("click", toggleStartPause);

    stopBtn = document.createElement("button");
    stopBtn.id = "tar-btn-stop";
    stopBtn.className = "tar-btn";
    stopBtn.type = "button";
    stopBtn.textContent = "Stop";
    stopBtn.disabled = true;
    stopBtn.addEventListener("click", stopRecording);

    controlsEl.appendChild(startPauseBtn);
    controlsEl.appendChild(stopBtn);

    rootEl.appendChild(cropTargetEl);
    rootEl.appendChild(frameEl);
    rootEl.appendChild(controlsEl);
    document.documentElement.appendChild(rootEl);

    attachDragAndResize();
    updateLayout();
    window.addEventListener("resize", updateLayout);
  }

  function destroyUI() {
    if (state !== "idle") {
      stopRecording();
    }
    cleanupStreams();
    window.removeEventListener("resize", updateLayout);
    if (rootEl) {
      rootEl.remove();
      rootEl = null;
    }
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === "TAR_TOGGLE_UI") {
      if (rootEl) {
        destroyUI();
      } else {
        buildUI();
      }
    }
  });

  buildUI();
})();
