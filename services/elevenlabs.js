import fetch from 'node-fetch';
import { createHash } from 'crypto';

const audioCache = new Map();
const AUDIO_TTL_MS = 4 * 60 * 60 * 1000; // 4 hours

export async function textToSpeech(script) {
  // Cache by MD5 of script — same recommendation → same audio, no re-synthesis
  const cacheKey = createHash('md5').update(script).digest('hex');
  const cached = audioCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < AUDIO_TTL_MS) {
    console.log('[TTS] cache hit');
    return cached.buffer;
  }

  const apiKey = process.env.ELEVENLABS_API_KEY;
  const voiceId = process.env.ELEVENLABS_VOICE_ID || '21m00Tcm4TlvDq8ikWAM';

  const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
    method: 'POST',
    headers: {
      'xi-api-key': apiKey,
      'Content-Type': 'application/json',
      Accept: 'audio/mpeg',
    },
    body: JSON.stringify({
      text: script,
      model_id: 'eleven_multilingual_v2',
      voice_settings: {
        stability: 0.4,
        similarity_boost: 0.75,
        style: 0.6,
        use_speaker_boost: true,
      },
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`ElevenLabs error: ${res.status} — ${err}`);
  }

  const buffer = Buffer.from(await res.arrayBuffer());
  audioCache.set(cacheKey, { buffer, ts: Date.now() });
  return buffer;
}
