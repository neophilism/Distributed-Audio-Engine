import type { PcmAudio } from './media.js';
import { analyzePcm, packageRendition } from './media.js';
import type { AttachmentContext } from './attachments.js';
import { finite, integer, invariant } from './validation.js';

export interface PcmFormatTarget {
  sampleRate: number;
  channels: number;
  /** Explicit output-row/input-column matrix. Each absolute row sum is <= 1.
   * Required for layouts other than identity, mono->stereo and stereo->mono. */
  channelMatrix?: readonly (readonly number[])[];
}
export interface PcmConversionOptions {
  signal?: AbortSignal;
  /** Output PCM limit; may tighten, never exceed, the 64 MiB engine limit. */
  maxOutputBytes?: number;
  /** Bounded operation estimate; default 250 million, hard ceiling 1 billion. */
  maxOperations?: number;
}
export interface PcmConversion {
  audio: PcmAudio;
  conversion: Readonly<{
    algorithm: 'identity-rate' | 'blackman-windowed-sinc-v1';
    sourceSampleRate: number; sourceChannels: number; sourceFrames: number;
    outputFrames: number; durationErrorSeconds: number;
    /** Attenuation only, keeping output sample peak <= original sample peak. */
    peakAttenuation: number;
    estimatedOperations: number;
    edgePolicy: 'constant-extension';
    realtimeQualified: false;
  }>;
}
const MAX_PCM_BYTES = 64 * 1024 * 1024;
const MAX_PHASES = 2048, MAX_COEFFICIENTS = 1048576;
const YIELD_FRAMES = 1024;
function gcd(a: number, b: number): number { while (b !== 0) { const next = a % b; a = b; b = next; } return a; }
function abortCheck(signal: AbortSignal | undefined): void { invariant(!signal?.aborted, 'PCM_CONVERSION_ABORTED'); }
function allowedKeys(value: object, required: string[], optional: string[]): void {
  invariant(value && typeof value === 'object' && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null), 'INVALID_PCM_CONVERSION_OPTIONS');
  const descriptors = Object.getOwnPropertyDescriptors(value);
  invariant(Reflect.ownKeys(value).every(key => typeof key === 'string' && [...required, ...optional].includes(key)) &&
    required.every(key => Object.hasOwn(value, key)) && Object.values(descriptors).every(d => 'value' in d && d.enumerable),
    'INVALID_PCM_CONVERSION_OPTIONS');
}
function channelMatrix(inputChannels: number, target: PcmFormatTarget): number[][] {
  let rows: readonly (readonly number[])[];
  if (target.channelMatrix !== undefined) rows = target.channelMatrix;
  else if (target.channels === inputChannels)
    rows = Array.from({ length: target.channels }, (_, out) => Array.from({ length: inputChannels }, (_, source) => out === source ? 1 : 0));
  else if (inputChannels === 1 && target.channels === 2) rows = [[1], [1]];
  else if (inputChannels === 2 && target.channels === 1) rows = [[0.5, 0.5]];
  else { invariant(false, 'PCM_CHANNEL_MATRIX_REQUIRED'); }
  invariant(Array.isArray(rows) && rows.length === target.channels, 'INVALID_PCM_CHANNEL_MATRIX');
  return rows.map(row => {
    invariant(Array.isArray(row) && row.length === inputChannels, 'INVALID_PCM_CHANNEL_MATRIX');
    const values = Array.from(row);
    for (const value of values) finite(value, -1, 1);
    invariant(values.reduce((sum, value) => sum + Math.abs(value), 0) <= 1, 'PCM_CHANNEL_GAIN_EXCEEDED');
    return values;
  });
}

/** Endpoint-only, bounded offline format preparation BEFORE encryption. Never
 * run on a relay or in a real-time audio callback. No implicit native fallback,
 * drift correction, loudness/physical calibration or OS-volume change occurs. */
export async function convertPcmFormat(source: PcmAudio, target: PcmFormatTarget,
  options: PcmConversionOptions = {}): Promise<PcmConversion> {
  allowedKeys(target, ['sampleRate', 'channels'], ['channelMatrix']);
  allowedKeys(options, [], ['signal', 'maxOutputBytes', 'maxOperations']);
  const { signal } = options;
  invariant(signal === undefined || (typeof signal.aborted === 'boolean' && typeof signal.addEventListener === 'function'),
    'INVALID_PCM_ABORT_SIGNAL');
  abortCheck(signal);
  const metadata = analyzePcm(source);
  const sampleRate = target.sampleRate, channels = target.channels;
  integer(sampleRate, 8000, 192000); integer(channels, 1, 8);
  const maxOutputBytes = options.maxOutputBytes ?? MAX_PCM_BYTES;
  const maxOperations = options.maxOperations ?? 250000000;
  integer(maxOutputBytes, 4, MAX_PCM_BYTES); integer(maxOperations, 1, 1000000000);
  const matrix = channelMatrix(metadata.channels, target);
  // Integer products remain well below MAX_SAFE_INTEGER under the source cap.
  const frames = Math.max(1, Math.round(metadata.frames * sampleRate / metadata.sampleRate));
  integer(frames, 1);
  invariant(frames * channels * 4 <= maxOutputBytes, 'PCM_CONVERSION_OUTPUT_LIMIT');
  const resample = sampleRate !== metadata.sampleRate;
  const divisor = gcd(sampleRate, metadata.sampleRate);
  const phases = resample ? sampleRate / divisor : 1;
  const step = metadata.sampleRate / divisor;
  const cutoff = 0.9 * Math.min(1, sampleRate / metadata.sampleRate);
  const radius = resample ? Math.ceil(32 / cutoff) : 0;
  const taps = 2 * radius + 1;
  invariant(phases <= MAX_PHASES && phases * taps <= MAX_COEFFICIENTS, 'PCM_RATE_RATIO_UNSUPPORTED');
  const estimatedOperations = phases * taps + frames * (metadata.channels * taps + channels * metadata.channels) +
    source.samples.length + frames * channels * 2;
  invariant(estimatedOperations <= maxOperations, 'PCM_CONVERSION_WORK_LIMIT');
  // Own all plaintext accessed after the first yield; caller mutation cannot alter it.
  const input = Float32Array.from(source.samples);
  let output: Float32Array | undefined;
  let filtered: Float64Array | undefined;
  let complete = false;
  try {
    filtered = new Float64Array(metadata.channels);
    output = new Float32Array(frames * channels);
    const coefficients = new Float64Array(phases * taps);
    if (resample) {
      for (let phase = 0; phase < phases; phase++) {
        let sum = 0;
        for (let index = 0; index < taps; index++) {
          const x = index - radius - phase / phases;
          const sincArgument = Math.PI * cutoff * x;
          const sinc = sincArgument === 0 ? 1 : Math.sin(sincArgument) / sincArgument;
          const window = Math.abs(x) >= radius ? 0 :
            0.42 + 0.5 * Math.cos(Math.PI * x / radius) + 0.08 * Math.cos(2 * Math.PI * x / radius);
          const value = cutoff * sinc * window; coefficients[phase * taps + index] = value; sum += value;
        }
        invariant(Number.isFinite(sum) && Math.abs(sum) > 0.5, 'PCM_FILTER_NORMALIZATION_FAILED');
        for (let index = 0; index < taps; index++) coefficients[phase * taps + index] = coefficients[phase * taps + index]! / sum;
        if (phase % 64 === 63) { await new Promise<void>(resolve => setTimeout(resolve, 0)); abortCheck(signal); }
      }
    }
    let peak = 0;
    for (let frame = 0; frame < frames; frame++) {
      if (frame % YIELD_FRAMES === 0) { await new Promise<void>(resolve => setTimeout(resolve, 0)); abortCheck(signal); }
      if (resample) {
        const position = frame * step, base = Math.floor(position / phases), phase = position % phases;
        filtered.fill(0);
        for (let index = 0; index < taps; index++) {
          const at = Math.max(0, Math.min(metadata.frames - 1, base + index - radius)) * metadata.channels;
          const weight = coefficients[phase * taps + index]!;
          for (let channel = 0; channel < metadata.channels; channel++)
            filtered[channel] = filtered[channel]! + input[at + channel]! * weight;
        }
      } else {
        for (let channel = 0; channel < metadata.channels; channel++) filtered[channel] = input[frame * metadata.channels + channel]!;
      }
      for (let channel = 0; channel < channels; channel++) {
        let value = 0;
        for (let from = 0; from < metadata.channels; from++) value += filtered[from]! * matrix[channel]![from]!;
        invariant(Number.isFinite(value), 'PCM_CONVERSION_NONFINITE_OUTPUT');
        output[frame * channels + channel] = value;
        peak = Math.max(peak, Math.abs(output[frame * channels + channel]!));
      }
    }
    const peakAttenuation = peak > metadata.samplePeak ? metadata.samplePeak / peak : 1;
    // Sinc ringing can exceed the input peak. Use a single uniform attenuation,
    // not independent per-sample clipping or an upward normalization.
    if (peakAttenuation < 1) {
      for (let index = 0; index < output.length; index++) {
        if (index % (YIELD_FRAMES * channels) === 0) { await new Promise<void>(resolve => setTimeout(resolve, 0)); abortCheck(signal); }
        output[index] = Math.max(-metadata.samplePeak, Math.min(metadata.samplePeak, output[index]! * peakAttenuation));
      }
    }
    abortCheck(signal); complete = true;
    return { audio: { sampleRate, channels, samples: output }, conversion: Object.freeze({
      algorithm: resample ? 'blackman-windowed-sinc-v1' : 'identity-rate', sourceSampleRate: metadata.sampleRate,
      sourceChannels: metadata.channels, sourceFrames: metadata.frames, outputFrames: frames,
      durationErrorSeconds: frames / sampleRate - metadata.frames / metadata.sampleRate,
      peakAttenuation, estimatedOperations, edgePolicy: 'constant-extension', realtimeQualified: false,
    }) };
  } finally { input.fill(0); filtered?.fill(0); if (!complete) output?.fill(0); }
}

/** Publish a fresh endpoint-encrypted rendition of an explicitly selected format.
 * The returned private manifest still requires authenticated parent delivery.
 * Callback cancellation cannot stop native Web Crypto, but withholds its result. */
export async function packageNormalizedRendition(source: PcmAudio, target: PcmFormatTarget, gain: number,
  context: AttachmentContext, filename: string, options: PcmConversionOptions = {}) {
  finite(gain, 0, 1);
  const boundContext = { ...context }, signal = options.signal;
  const converted = await convertPcmFormat(source, target, options);
  try {
    abortCheck(signal);
    const packaged = await packageRendition(converted.audio, gain, boundContext, filename);
    if (signal?.aborted) { packaged.privateManifest.attachmentKeyHex = ''; invariant(false, 'PCM_CONVERSION_ABORTED'); }
    return { ...packaged, conversion: converted.conversion };
  } finally { converted.audio.samples.fill(0); }
}
