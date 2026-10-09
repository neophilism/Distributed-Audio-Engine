import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzePcm,encodePcm16,decodeWave,packageRendition,decryptAttachment,validateStemAlignment } from '../src/index.js';
const pcm={sampleRate:48000,channels:2,samples:Float32Array.from([0.5,-0.5,0.25,-0.25,0,0])};
const context={tenantId:'tenant',application:'scenesignal' as const,parentMessageId:'parent'};
test('PCM packaging preserves stereo frame count, duration and bounded sample peaks',()=>{
  const a=analyzePcm(pcm);assert.equal(a.frames,3);assert.equal(a.durationSeconds,3/48000);assert.equal(a.samplePeak,0.5);assert.equal(a.metric,'digital-sample-amplitude');
  const out=decodeWave(encodePcm16(pcm));assert.equal(out.channels,2);assert.equal(out.samples.length,6);assert.ok(Math.abs(out.samples[0]!-0.5)<1/32768);
});
test('misaligned, unsupported, truncated or corrupt waveform inputs reject',()=>{
  const wave=encodePcm16(pcm);const bad=Uint8Array.from(wave);new DataView(bad.buffer).setUint16(20,17,true);
  assert.throws(()=>decodeWave(bad));assert.throws(()=>decodeWave(wave.slice(0,-1)));
  assert.throws(()=>analyzePcm({...pcm,samples:new Float32Array([1])}));assert.throws(()=>analyzePcm({...pcm,samples:Float32Array.from([NaN,0])}));
});
test('stem alignment allows different channels but rejects incompatible frame counts or rates',()=>{
  validateStemAlignment([pcm,{sampleRate:48000,channels:1,samples:Float32Array.from([1,0,-1])}]);
  assert.throws(()=>validateStemAlignment([pcm,{...pcm,sampleRate:44100}]));assert.throws(()=>validateStemAlignment([pcm,{...pcm,samples:new Float32Array(4)}]));
});
test('each endpoint rendition is attenuated and separately encrypted with a fresh key',async()=>{
  const a=await packageRendition(pcm,0.5,context,'quiet.wav');const b=await packageRendition(pcm,0.5,context,'quiet.wav');
  assert.equal(a.privateMetadata.samplePeak,0.25);assert.notEqual(a.privateManifest.attachmentKeyHex,b.privateManifest.attachmentKeyHex);
  const clear=await decryptAttachment(a.privateManifest,a.ciphertextChunks,context);assert.equal(decodeWave(clear).samples.length,6);
  await assert.rejects(packageRendition(pcm,1.01,context,'boost.wav'));
});
