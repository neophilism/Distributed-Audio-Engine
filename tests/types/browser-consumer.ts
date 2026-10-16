import { BrowserAudioSink } from '@neophilism/distributed-audio-engine/browser';
import type { PlaybackAuthority } from '@neophilism/distributed-audio-engine';
declare const context: AudioContext;
declare const authority: PlaybackAuthority;
const sink = new BrowserAudioSink(context, authority, { nowUnixMs: () => 1000 });
void sink;

import { convertPcmFormat } from '@neophilism/distributed-audio-engine';
void convertPcmFormat({ sampleRate: 8000, channels: 1, samples: new Float32Array(8) },
  { sampleRate: 48000, channels: 2 }, { signal: new AbortController().signal });
