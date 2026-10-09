import { BrowserAudioSink } from '@neophilism/distributed-audio-engine/browser';
import type { PlaybackAuthority } from '@neophilism/distributed-audio-engine';
declare const context: AudioContext;
declare const authority: PlaybackAuthority;
const sink = new BrowserAudioSink(context, authority, { nowUnixMs: () => 1000 });
void sink;
