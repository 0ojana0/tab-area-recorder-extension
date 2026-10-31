# tab-area-recorder-extension
Manifest V3 Chrome extension for recording a selected area of a tab at native default resolution and quality, combining system/tab audio with microphone input only when your mic is unmuted, and featuring a floating bar with only Start/Pause and Stop buttons.

# Key Features
- Draggable & Resizable Area Selection: Clicking the extension icon overlays a resizable selection rectangle on the active tab, keeping the border and control pill strictly outside the recorded crop target so UI controls never appear in the video.
- Default Resolution & Quality: Uses Chromium's Region Capture API (CropTarget.fromElement and videoTrack.cropTo) with a device-pixel-ratio <canvas> fallback and default MediaRecorder encoding without downscaling or custom bitrate overrides.
- System Audio + Unmuted Mic Mixing: Combines tab/system audio (systemAudio: "include") and microphone audio through a Web Audio AudioContext mixer that monitors micTrack.muted, micTrack.enabled, and mute/unmute events to zero out mic gain whenever the microphone is muted or recording is paused.
- Two-Button Control Bar: Displays only Start (toggles to Pause when recording and Start when paused) and Stop (automatically downloads the recorded .webm/.mp4 file).

# Installation & Usage
Extract tab-area-recorder-extension.zip to a folder on your computer.
Open chrome://extensions in Chrome, enable Developer mode in the top-right corner, and click Load unpacked to select the extracted folder.
Click the Tab Area Recorder extension icon on any standard web page, drag or resize the selection frame, and click Start (keep Also share tab audio checked in Chrome's prompt to include tab/system audio).
