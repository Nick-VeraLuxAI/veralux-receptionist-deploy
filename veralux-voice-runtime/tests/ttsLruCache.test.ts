import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import type { TTSRequest } from '../src/tts/types';
import { setTestEnv } from './testEnv';

setTestEnv();

let TtsLruCache: typeof import('../src/tts/ttsLruCache').TtsLruCache;
let buildCoquiTtsCacheKey: typeof import('../src/tts/ttsLruCache').buildCoquiTtsCacheKey;
let buildKokoroTtsCacheKey: typeof import('../src/tts/ttsLruCache').buildKokoroTtsCacheKey;

describe('TtsLruCache', () => {
  before(async () => {
    const mod = await import('../src/tts/ttsLruCache');
    TtsLruCache = mod.TtsLruCache;
    buildCoquiTtsCacheKey = mod.buildCoquiTtsCacheKey;
    buildKokoroTtsCacheKey = mod.buildKokoroTtsCacheKey;
  });

  it('evicts oldest when over maxEntries', () => {
    const cache = new TtsLruCache({ maxEntries: 2, maxTextChars: 10_000, maxAudioBytes: 10_000 });
    const a = Buffer.from('aa');
    const b = Buffer.from('bb');
    const c = Buffer.from('cc');
    cache.set('k1', 1, { audio: a, contentType: 'audio/wav' });
    cache.set('k2', 1, { audio: b, contentType: 'audio/wav' });
    assert.equal(cache.size, 2);
    cache.set('k3', 1, { audio: c, contentType: 'audio/wav' });
    assert.equal(cache.size, 2);
    assert.equal(cache.get('k1'), undefined);
    assert.ok(cache.get('k2'));
    assert.ok(cache.get('k3'));
  });

  it('get refreshes LRU order', () => {
    const cache = new TtsLruCache({ maxEntries: 2, maxTextChars: 10_000, maxAudioBytes: 10_000 });
    cache.set('k1', 1, { audio: Buffer.from('a'), contentType: 'audio/wav' });
    cache.set('k2', 1, { audio: Buffer.from('b'), contentType: 'audio/wav' });
    assert.ok(cache.get('k1'));
    cache.set('k3', 1, { audio: Buffer.from('c'), contentType: 'audio/wav' });
    assert.ok(cache.get('k1'));
    assert.equal(cache.get('k2'), undefined);
  });

  it('skips set when text exceeds maxTextChars', () => {
    const cache = new TtsLruCache({ maxEntries: 10, maxTextChars: 5, maxAudioBytes: 10_000 });
    cache.set('k1', 100, { audio: Buffer.from('x'), contentType: 'audio/wav' });
    assert.equal(cache.size, 0);
  });

  it('skips set when audio exceeds maxAudioBytes', () => {
    const cache = new TtsLruCache({ maxEntries: 10, maxTextChars: 10_000, maxAudioBytes: 2 });
    cache.set('k1', 1, { audio: Buffer.from('abcd'), contentType: 'audio/wav' });
    assert.equal(cache.size, 0);
  });

  it('returns a copy of audio on get', () => {
    const cache = new TtsLruCache({ maxEntries: 2, maxTextChars: 10_000, maxAudioBytes: 10_000 });
    const original = Buffer.from('xyz');
    cache.set('k1', 1, { audio: original, contentType: 'audio/wav' });
    const hit = cache.get('k1');
    assert.ok(hit);
    hit!.audio[0] = 0;
    assert.equal(original[0], 'x'.charCodeAt(0));
  });
});

describe('buildKokoroTtsCacheKey', () => {
  before(async () => {
    const mod = await import('../src/tts/ttsLruCache');
    buildKokoroTtsCacheKey = mod.buildKokoroTtsCacheKey;
  });

  it('is stable for the same effective request', () => {
    const r: TTSRequest = {
      text: 'Hello',
      voice: 'af_bella',
      kokoroUrl: 'http://kokoro:8880',
      kokoroSpeed: 1.2,
      format: 'wav',
      sampleRate: 8000,
    };
    assert.equal(buildKokoroTtsCacheKey(r), buildKokoroTtsCacheKey({ ...r }));
  });
});

describe('buildCoquiTtsCacheKey', () => {
  before(async () => {
    const mod = await import('../src/tts/ttsLruCache');
    buildCoquiTtsCacheKey = mod.buildCoquiTtsCacheKey;
  });

  it('is stable for the same effective request', () => {
    const r: TTSRequest = {
      text: 'Hours are nine to five.',
      coquiXttsUrl: 'http://xtts:7002/tts',
      voice: 'en_sample',
      language: 'en',
      coquiSpeed: 1.0,
    };
    assert.equal(buildCoquiTtsCacheKey(r), buildCoquiTtsCacheKey({ ...r }));
  });
});
