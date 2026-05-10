import { WebRecorder, recorderSupported } from "./recorder";
import {
  TTSPlayer,
  primeMobilePlaybackFromUserGesture,
  speakerSupported,
} from "./speaker";

/**
 * Phase 15 — singleton voice runtime.
 *
 * Wraps a single `WebRecorder` + `TTSPlayer` per browser tab so
 * the store layer doesn't have to manage lifecycle. Components and
 * the WS event listener call into these helpers; the store mirrors
 * the resulting state into its own zustand slice for rendering.
 *
 * This module is intentionally state-light — `lastInputWasVoice`
 * and the playback gating live in the store. Here we only own the
 * concrete browser objects (MediaRecorder, HTMLAudioElement queue).
 */

let recorderSingleton: WebRecorder | null = null;
let speakerSingleton: TTSPlayer | null = null;

export function getRecorder(): WebRecorder {
  if (!recorderSingleton) recorderSingleton = new WebRecorder();
  return recorderSingleton;
}

export function getSpeaker(): TTSPlayer {
  if (!speakerSingleton) speakerSingleton = new TTSPlayer();
  return speakerSingleton;
}

export function voiceClientSupported(): boolean {
  return recorderSupported() && speakerSupported();
}

export { primeMobilePlaybackFromUserGesture };
