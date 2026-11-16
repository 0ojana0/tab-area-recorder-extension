// Tab Area Recorder - Content Script
(() => {
  if (window.__TAR_INITIALIZED__) return;
  window.__TAR_INITIALIZED__ = true;

  // State
  let state = "idle"; // "idle" | "recording" | "paused"
  let isFullTabDefault = true;
  let micMuted = false; // Controlled strictly by the Mic Mute/Unmute button

  // Default to full current tab viewport area size
  let rect = {
    x: 0,
    y: 0,
    w: window.innerWidth,
    h: window.innerHeight
  };

  let mediaRecorder = null;
  let recordedChunks = [];
  let displayStream = null;
  let micStream = null;
  let audioCtx = null;
  let audioDestination = null;
  let sysGainNode = null;
  let micSourceNode = null;
  let micGainNode = null;
  let canvasStream = null;
  let rafId = null;

  // Accurate active recording duration tracking (excluding paused intervals) for seekable WebM
  let accumulatedMs = 0;
  let lastResumeTime = 0;

  // DOM Elements
  let rootEl = null;
  let cropTargetEl = null;
  let frameEl = null;
  let controlsEl = null;
  let startPauseBtn = null;
  let stopBtn = null;
  let micBtn = null;

  const MIN_SIZE = 80;

  function clampRect(r) {
    const maxW = window.innerWidth;
    const maxH = window.innerHeight;
    const w = Math.max(MIN_SIZE, Math.min(r.w, maxW));
    const h = Math.max(MIN_SIZE, Math.min(r.h, maxH));
    const x = Math.max(0, Math.min(r.x, maxW - w));
    const y = Math.max(0, Math.min(r.y, maxH - h));
    return { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) };
  }

  function isFullViewport(r) {
    return (
      r.x <= 2 &&
      r.y <= 2 &&
      Math.abs(r.w - window.innerWidth) <= 4 &&
      Math.abs(r.h - window.innerHeight) <= 4
    );
  }

  function updateLayout() {
    if (!rootEl) return;
    if (isFullTabDefault && state === "idle") {
      rect = { x: 0, y: 0, w: window.innerWidth, h: window.innerHeight };
    } else {
      rect = clampRect(rect);
    }

    cropTargetEl.style.left = `${rect.x}px`;
    cropTargetEl.style.top = `${rect.y}px`;
    cropTargetEl.style.width = `${rect.w}px`;
    cropTargetEl.style.height = `${rect.h}px`;

    frameEl.style.left = `${rect.x}px`;
    frameEl.style.top = `${rect.y}px`;
    frameEl.style.width = `${rect.w}px`;
    frameEl.style.height = `${rect.h}px`;

    const ctrlRect = controlsEl.getBoundingClientRect();
    const ctrlW = ctrlRect.width || 240;
    const ctrlH = ctrlRect.height || 40;
    const gap = 10;

    let ctrlTop = rect.y + rect.h + gap;
    if (ctrlTop + ctrlH > window.innerHeight - 8) {
      ctrlTop = rect.y - ctrlH - gap;
    }
    if (ctrlTop < 8) {
      ctrlTop = Math.max(8, window.innerHeight - ctrlH - 12);
    }

    let ctrlLeft = rect.x + rect.w - ctrlW;
    ctrlLeft = Math.max(8, Math.min(ctrlLeft, window.innerWidth - ctrlW - 8));

    controlsEl.style.left = `${Math.round(ctrlLeft)}px`;
    controlsEl.style.top = `${Math.round(ctrlTop)}px`;
  }

  function syncButtons() {
    if (!startPauseBtn || !stopBtn || !micBtn) return;
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

    micBtn.textContent = micMuted ? "Mic: Muted" : "Mic: Unmuted";
    micBtn.classList.toggle("is-muted", micMuted);
  }

  /**
   * Acquires and connects the microphone stream on demand ONLY when unmuted,
   * and disables Chrome/OS echoCancellation & audio ducking so system sound stays crystal clear.
   */
  async function syncMicConnection() {
    syncButtons();
    if (!audioCtx || !audioDestination || state === "idle") {
      return;
    }

    if (micMuted) {
      // Mute & release mic track so OS/Bluetooth never ducks or downgrades system audio
      if (micGainNode && audioCtx) {
        micGainNode.gain.setTargetAtTime(0.0, audioCtx.currentTime, 0.01);
      }
      if (micSourceNode) {
        try { micSourceNode.disconnect(); } catch {}
        micSourceNode = null;
      }
      if (micStream) {
        micStream.getTracks().forEach((t) => t.stop());
        micStream = null;
      }
      return;
    }

    // Mic is Unmuted: acquire mic if not already active
    if (!micStream || micStream.getAudioTracks().every((t) => t.readyState !== "live")) {
      try {
        // Disable echoCancellation & googDucking so Chrome's WebRTC APM does NOT filter/duck system audio
        micStream = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: false,
            autoGainControl: false,
            noiseSuppression: true,
            googEchoCancellation: false,
            googAutoGainControl: false,
            googDucking: false,
            sampleRate: 48000,
            channelCount: 1
          },
          video: false
        });

        const micTrack = micStream.getAudioTracks()[0];
        if (micTrack) {
          await micTrack.applyConstraints({
            echoCancellation: false,
            autoGainControl: false,
            noiseSuppression: true
          }).catch(() => {});

          if (!micGainNode) {
            micGainNode = audioCtx.createGain();
            micGainNode.connect(audioDestination);
          }
          micSourceNode = audioCtx.createMediaStreamSource(new MediaStream([micTrack]));
          micSourceNode.connect(micGainNode);
        }
      } catch {
        micStream = null;
      }
    }

    if (micGainNode && audioCtx) {
      const activeGain = !micMuted && state === "recording" ? 1.0 : 0.0;
      micGainNode.gain.setTargetAtTime(activeGain, audioCtx.currentTime, 0.01);
    }
  }

  function toggleMicMute() {
    micMuted = !micMuted;
    syncMicConnection();
  }

  function attachDragAndResize() {
    let action = null;
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
        if (Math.abs(dx) > 2 || Math.abs(dy) > 2) {
          isFullTabDefault = false;
        }
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
   * Builds a high-definition 48kHz stereo audio pipeline:
   * - Disables all voice/noise/echo filters on system audio so music & system sound are crystal clear
   * - Explicitly configures 2-channel stereo destination so stereo channels never collapse or phase-cancel
   * - Mixes microphone only when Mic button is Unmuted
   */
  async function createMixedAudioStream(displayMediaStream) {
    const sysAudioTracks = displayMediaStream.getAudioTracks();

    // Disable any Chromium voice-processing filters on the captured system/tab audio track
    for (const sysTrack of sysAudioTracks) {
      sysTrack.enabled = true;
      await sysTrack.applyConstraints({
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        voiceIsolation: false,
        channelCount: 2,
        sampleRate: 48000
      }).catch(() => {});
    }

    // High-resolution 48kHz playback-grade stereo AudioContext
    audioCtx = new (window.AudioContext || window.webkitAudioContext)({
      sampleRate: 48000,
      latencyHint: "playback"
    });
    if (audioCtx.state === "suspended") {
      await audioCtx.resume().catch(() => {});
    }

    audioDestination = audioCtx.createMediaStreamDestination();
    // Force explicit 2-channel stereo output so system audio is never downmixed to mono
    try {
      audioDestination.channelCount = 2;
      audioDestination.channelCountMode = "explicit";
      audioDestination.channelInterpretation = "speakers";
    } catch {}

    // 1. Incoming system / tab audio (ALWAYS active, unprocessed stereo)
    if (sysAudioTracks.length > 0) {
      const sysStream = new MediaStream([sysAudioTracks[0]]);
      const sysSource = audioCtx.createMediaStreamSource(sysStream);
      sysGainNode = audioCtx.createGain();
      sysGainNode.gain.value = 1.0;
      try {
        sysGainNode.channelCount = 2;
        sysGainNode.channelCountMode = "explicit";
        sysGainNode.channelInterpretation = "speakers";
      } catch {}
      sysSource.connect(sysGainNode);
      sysGainNode.connect(audioDestination);
    }

    // 2. Microphone audio (connected only if Mic is Unmuted)
    await syncMicConnection();

    return audioDestination.stream.getAudioTracks();
  }

  /**
   * Captures the current tab area at native default resolution & quality
   */
  async function getAreaVideoTrack(displayMediaStream) {
    const [videoTrack] = displayMediaStream.getVideoTracks();
    if (!videoTrack) throw new Error("No video track available.");

    // Exclude our #tar-root overlay (mounted on documentElement outside body) when RestrictionTarget is supported
    if (typeof window.RestrictionTarget !== "undefined" && typeof videoTrack.restrictTo === "function" && document.body) {
      try {
        const restrictionTarget = await window.RestrictionTarget.fromElement(document.body);
        await videoTrack.restrictTo(restrictionTarget);
      } catch {}
    }

    if (isFullViewport(rect)) {
      return videoTrack;
    }

    if (typeof window.CropTarget !== "undefined" && typeof videoTrack.cropTo === "function") {
      try {
        const cropTarget = await window.CropTarget.fromElement(cropTargetEl);
        await videoTrack.cropTo(cropTarget);
        return videoTrack;
      } catch {}
    }

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

  /**
   * EBML / WebM Post-Processor that injects the exact Duration (0x4489), known Segment size,
   * and Cluster Cues (0x1C53BB6B) seek index so recorded WebM videos support instant
   * seeking and timeline scrubbing in Chrome, VLC, and standard players.
   */
  async function makeWebmSeekable(blob, durationMs) {
    try {
      const buf = new Uint8Array(await blob.arrayBuffer());
      if (buf.length < 32) return blob;

      if (buf[0] !== 0x1a || buf[1] !== 0x45 || buf[2] !== 0xdf || buf[3] !== 0xa3) {
        return blob;
      }

      function readVint(arr, pos, keepMask = false) {
        if (pos >= arr.length) return null;
        const first = arr[pos];
        if (first === 0) return null;
        let len = 1;
        let mask = 0x80;
        while (len <= 8 && (first & mask) === 0) {
          len++;
          mask >>= 1;
        }
        if (len > 8 || pos + len > arr.length) return null;
        let value = keepMask ? first : first & (mask - 1);
        for (let i = 1; i < len; i++) {
          value = value * 256 + arr[pos + i];
        }
        return { len, value };
      }

      function encodeVintSize(size, byteLength = 0) {
        let len = byteLength;
        if (!len) {
          if (size < (1 << 7) - 1) len = 1;
          else if (size < (1 << 14) - 1) len = 2;
          else if (size < (1 << 21) - 1) len = 3;
          else if (size < (1 << 28) - 1) len = 4;
          else len = 8;
        }
        const out = new Uint8Array(len);
        let temp = size;
        for (let i = len - 1; i >= 0; i--) {
          out[i] = temp & 0xff;
          temp = Math.floor(temp / 256);
        }
        out[0] |= 1 << (8 - len);
        return out;
      }

      function encodeUintElement(idBytes, uintVal) {
        const bytes = [];
        let v = Math.max(0, Math.floor(uintVal));
        do {
          bytes.unshift(v & 0xff);
          v = Math.floor(v / 256);
        } while (v > 0);
        const sizeBytes = encodeVintSize(bytes.length, 1);
        const out = new Uint8Array(idBytes.length + sizeBytes.length + bytes.length);
        out.set(idBytes, 0);
        out.set(sizeBytes, idBytes.length);
        out.set(bytes, idBytes.length + sizeBytes.length);
        return out;
      }

      function concatArrays(arrays) {
        let total = 0;
        for (const a of arrays) total += a.length;
        const out = new Uint8Array(total);
        let offset = 0;
        for (const a of arrays) {
          out.set(a, offset);
          offset += a.length;
        }
        return out;
      }

      const ebmlId = readVint(buf, 0, true);
      const ebmlSize = readVint(buf, ebmlId.len, false);
      const segmentStart = ebmlId.len + ebmlSize.len + ebmlSize.value;

      if (
        segmentStart + 12 >= buf.length ||
        buf[segmentStart] !== 0x18 ||
        buf[segmentStart + 1] !== 0x53 ||
        buf[segmentStart + 2] !== 0x80 ||
        buf[segmentStart + 3] !== 0x67
      ) {
        return blob;
      }

      const segSizeVint = readVint(buf, segmentStart + 4, false);
      const segDataStart = segmentStart + 4 + segSizeVint.len;

      let pos = segDataStart;
      let infoStart = -1;
      let infoDataStart = -1;
      let infoEnd = -1;
      let firstClusterStart = -1;

      while (pos < buf.length) {
        const id = readVint(buf, pos, true);
        if (!id) break;
        const size = readVint(buf, pos + id.len, false);
        if (!size) break;
        const elemDataStart = pos + id.len + size.len;

        if (id.value === 0x1f43b675) {
          firstClusterStart = pos;
          break;
        }
        if (id.value === 0x1549a966) {
          infoStart = pos;
          infoDataStart = elemDataStart;
          infoEnd = elemDataStart + size.value;
        }
        pos = elemDataStart + size.value;
      }

      if (infoStart === -1 || firstClusterStart === -1) {
        return blob;
      }

      const infoChildren = [];
      let infoPos = infoDataStart;
      while (infoPos < infoEnd) {
        const cId = readVint(buf, infoPos, true);
        if (!cId) break;
        const cSize = readVint(buf, infoPos + cId.len, false);
        if (!cSize) break;
        const cEnd = infoPos + cId.len + cSize.len + cSize.value;
        if (cId.value !== 0x4489) {
          infoChildren.push(buf.subarray(infoPos, cEnd));
        }
        infoPos = cEnd;
      }

      const durationElem = new Uint8Array(11);
      durationElem[0] = 0x44;
      durationElem[1] = 0x89;
      durationElem[2] = 0x88;
      const dv = new DataView(durationElem.buffer);
      dv.setFloat64(3, Math.max(100, durationMs), false);
      infoChildren.push(durationElem);

      const newInfoPayload = concatArrays(infoChildren);
      const newInfoSizeBytes = encodeVintSize(newInfoPayload.length);
      const newInfoElem = concatArrays([
        new Uint8Array([0x15, 0x49, 0xa9, 0x66]),
        newInfoSizeBytes,
        newInfoPayload
      ]);

      const preInfo = buf.subarray(segDataStart, infoStart);
      const postInfoBeforeCluster = buf.subarray(infoEnd, firstClusterStart);
      const metadataBlock = concatArrays([preInfo, newInfoElem, postInfoBeforeCluster]);
      const clustersBlock = buf.subarray(firstClusterStart);

      const cuePoints = [];
      let scanPos = firstClusterStart;
      while (scanPos + 12 < buf.length) {
        if (
          buf[scanPos] === 0x1f &&
          buf[scanPos + 1] === 0x43 &&
          buf[scanPos + 2] === 0xb6 &&
          buf[scanPos + 3] === 0x75
        ) {
          const cSize = readVint(buf, scanPos + 4, false);
          if (cSize) {
            const cDataStart = scanPos + 4 + cSize.len;
            if (cDataStart + 2 < buf.length && buf[cDataStart] === 0xe7) {
              const tsSize = readVint(buf, cDataStart + 1, false);
              if (tsSize && tsSize.value <= 8 && cDataStart + 1 + tsSize.len + tsSize.value <= buf.length) {
                let clusterTime = 0;
                for (let b = 0; b < tsSize.value; b++) {
                  clusterTime = clusterTime * 256 + buf[cDataStart + 1 + tsSize.len + b];
                }
                const clusterOffsetInSegment = metadataBlock.length + (scanPos - firstClusterStart);
                const cueTrack = encodeUintElement([0xf7], 1);
                const cueClusterPos = encodeUintElement([0xf1], clusterOffsetInSegment);
                const trackPosPayload = concatArrays([cueTrack, cueClusterPos]);
                const cueTrackPositions = concatArrays([
                  new Uint8Array([0xb7]),
                  encodeVintSize(trackPosPayload.length),
                  trackPosPayload
                ]);
                const cueTime = encodeUintElement([0xb3], clusterTime);
                const cuePointPayload = concatArrays([cueTime, cueTrackPositions]);
                const cuePoint = concatArrays([
                  new Uint8Array([0xbb]),
                  encodeVintSize(cuePointPayload.length),
                  cuePointPayload
                ]);
                cuePoints.push(cuePoint);
              }
            }
            const rawSizeBytes = buf.subarray(scanPos + 4, scanPos + 4 + cSize.len);
            const isUnknownSize = rawSizeBytes.every((b, idx) => (idx === 0 ? b === 0x01 || b === 0xff : b === 0xff));
            if (!isUnknownSize && cSize.value > 0 && cDataStart + cSize.value <= buf.length) {
              scanPos = cDataStart + cSize.value;
              continue;
            }
          }
        }
        scanPos++;
      }

      let cuesElem = new Uint8Array(0);
      if (cuePoints.length > 0) {
        const cuesPayload = concatArrays(cuePoints);
        cuesElem = concatArrays([
          new Uint8Array([0x1c, 0x53, 0xbb, 0x6b]),
          encodeVintSize(cuesPayload.length),
          cuesPayload
        ]);
      }

      const newSegmentPayloadLength = metadataBlock.length + clustersBlock.length + cuesElem.length;
      const newSegmentHeader = concatArrays([
        buf.subarray(0, segmentStart),
        new Uint8Array([0x18, 0x53, 0x80, 0x67]),
        encodeVintSize(newSegmentPayloadLength, 8)
      ]);

      return new Blob([newSegmentHeader, metadataBlock, clustersBlock, cuesElem], {
        type: blob.type || "video/webm"
      });
    } catch {
      return blob;
    }
  }

  async function startRecording() {
    try {
      // Request unprocessed, stereo 48kHz system/tab audio so Chrome does NOT apply voice/noise filters to system sound
      displayStream = await navigator.mediaDevices.getDisplayMedia({
        video: {
          displaySurface: "browser"
        },
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
          googEchoCancellation: false,
          googAutoGainControl: false,
          googNoiseSuppression: false,
          googHighpassFilter: false,
          channelCount: 2,
          sampleRate: 48000,
          sampleSize: 16
        },
        preferCurrentTab: true,
        selfBrowserSurface: "include",
        systemAudio: "include",
        suppressLocalAudioPlayback: false
      });

      const areaVideoTrack = await getAreaVideoTrack(displayStream);
      const mixedAudioTracks = await createMixedAudioStream(displayStream);

      const combinedStream = new MediaStream([
        areaVideoTrack,
        ...mixedAudioTracks
      ]);

      recordedChunks = [];
      accumulatedMs = 0;
      lastResumeTime = performance.now();

      // Use high-clarity 192 kbps audio encoding so stereo system sound is never muffled by low-bitrate speech compression
      mediaRecorder = new MediaRecorder(combinedStream, {
        audioBitsPerSecond: 192000
      });

      mediaRecorder.ondataavailable = (event) => {
        if (event.data && event.data.size > 0) {
          recordedChunks.push(event.data);
        }
      };

      mediaRecorder.onstop = async () => {
        if (lastResumeTime > 0) {
          accumulatedMs += performance.now() - lastResumeTime;
          lastResumeTime = 0;
        }
        const totalDurationMs = Math.max(100, accumulatedMs);
        await saveRecording(totalDurationMs);
        cleanupStreams();
        state = "idle";
        syncButtons();
      };

      displayStream.getVideoTracks()[0].addEventListener("ended", () => {
        if (state !== "idle") {
          stopRecording();
        }
      });

      mediaRecorder.start(250);
      state = "recording";
      await syncMicConnection();
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
      if (lastResumeTime > 0) {
        accumulatedMs += performance.now() - lastResumeTime;
        lastResumeTime = 0;
      }
      state = "paused";
      syncMicConnection();
    } else if (state === "paused" && mediaRecorder?.state === "paused") {
      mediaRecorder.resume();
      lastResumeTime = performance.now();
      state = "recording";
      syncMicConnection();
    }
  }

  function stopRecording() {
    if (!mediaRecorder || state === "idle") return;
    if (mediaRecorder.state !== "inactive") {
      mediaRecorder.stop();
    }
  }

  async function saveRecording(durationMs) {
    if (!recordedChunks.length) return;
    const mimeType = mediaRecorder?.mimeType || "video/webm";
    let blob = new Blob(recordedChunks, { type: mimeType });
    recordedChunks = [];

    if (!mimeType.includes("mp4")) {
      blob = await makeWebmSeekable(blob, durationMs);
    }

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
    }, 3000);
  }

  function cleanupStreams() {
    if (rafId) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
    if (canvasStream) {
      canvasStream.getTracks().forEach((t) => t.stop());
      canvasStream = null;
    }
    if (displayStream) {
      displayStream.getTracks().forEach((t) => t.stop());
      displayStream = null;
    }
    if (micSourceNode) {
      try { micSourceNode.disconnect(); } catch {}
      micSourceNode = null;
    }
    if (micStream) {
      micStream.getTracks().forEach((t) => t.stop());
      micStream = null;
    }
    if (audioCtx) {
      audioCtx.close().catch(() => {});
      audioCtx = null;
      audioDestination = null;
      sysGainNode = null;
      micGainNode = null;
    }
    mediaRecorder = null;
  }

  function buildUI() {
    isFullTabDefault = true;
    rect = {
      x: 0,
      y: 0,
      w: window.innerWidth,
      h: window.innerHeight
    };

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

    // 1. Start / Pause button
    startPauseBtn = document.createElement("button");
    startPauseBtn.id = "tar-btn-start-pause";
    startPauseBtn.className = "tar-btn";
    startPauseBtn.type = "button";
    startPauseBtn.textContent = "Start";
    startPauseBtn.addEventListener("click", toggleStartPause);

    // 2. Stop button
    stopBtn = document.createElement("button");
    stopBtn.id = "tar-btn-stop";
    stopBtn.className = "tar-btn";
    stopBtn.type = "button";
    stopBtn.textContent = "Stop";
    stopBtn.disabled = true;
    stopBtn.addEventListener("click", stopRecording);

    // 3. Manual Mic Mute / Unmute button
    micBtn = document.createElement("button");
    micBtn.id = "tar-btn-mic";
    micBtn.className = "tar-btn";
    micBtn.type = "button";
    micBtn.textContent = "Mic: Unmuted";
    micBtn.addEventListener("click", toggleMicMute);

    controlsEl.appendChild(startPauseBtn);
    controlsEl.appendChild(stopBtn);
    controlsEl.appendChild(micBtn);

    rootEl.appendChild(cropTargetEl);
    rootEl.appendChild(frameEl);
    rootEl.appendChild(controlsEl);
    document.documentElement.appendChild(rootEl);

    attachDragAndResize();
    syncButtons();
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
