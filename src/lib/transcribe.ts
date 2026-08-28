import { groqAvailable } from "./groq.js";

/**
 * Best-effort voice-note transcription for WhatsApp audio messages.
 *
 * Fail-closed: if the required config (WHATSAPP_TOKEN / GROQ_API_KEY) is
 * missing, or any upstream call errors, this returns `null` so the caller can
 * gracefully drop the audio instead of crashing the ingest path.
 */

const GRAPH_BASE = "https://graph.facebook.com/v19.0";
const GROQ_AUDIO_URL = "https://api.groq.com/openai/v1/audio/transcriptions";
const GROQ_TRANSCRIBE_MODEL = "whisper-large-v3-turbo";

export function transcriptionEnabled(): boolean {
  return groqAvailable() && !!process.env.WHATSAPP_TOKEN;
}

async function downloadAudio(mediaId: string): Promise<{ data: Buffer; mime: string } | null> {
  const token = process.env.WHATSAPP_TOKEN;
  if (!token) return null;
  try {
    const infoRes = await fetch(`${GRAPH_BASE}/${mediaId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!infoRes.ok) return null;
    const info = (await infoRes.json()) as { url?: string; mime_type?: string };
    if (!info.url) return null;
    const fileRes = await fetch(info.url, { headers: { Authorization: `Bearer ${token}` } });
    if (!fileRes.ok) return null;
    const data = Buffer.from(await fileRes.arrayBuffer());
    return { data, mime: info.mime_type ?? "audio/ogg" };
  } catch {
    return null;
  }
}

async function transcribe(audio: Buffer, mime: string): Promise<string | null> {
  if (!groqAvailable()) return null;
  const apiKey = process.env.GROQ_API_KEY!;
  try {
    const form = new FormData();
    const ext = mime.includes("mp4") ? "m4a" : mime.includes("mpeg") ? "mp3" : "ogg";
    form.append("file", new Blob([audio], { type: mime }), `voice-${Date.now()}.${ext}`);
    form.append("model", GROQ_TRANSCRIBE_MODEL);
    const res = await fetch(GROQ_AUDIO_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { text?: string };
    const text = body.text?.trim();
    return text ? text : null;
  } catch {
    return null;
  }
}

/**
 * Transcribe a WhatsApp audio message. Returns the transcript text, or null
 * when transcription is unavailable or fails (caller should drop the message).
 */
export async function transcribeAudioMessage(mediaId: string): Promise<string | null> {
  if (!transcriptionEnabled()) return null;
  const audio = await downloadAudio(mediaId);
  if (!audio) return null;
  return transcribe(audio.data, audio.mime);
}
