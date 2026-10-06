/**
 * Download a WhatsApp media object (document, image, …) by its media id.
 * Best-effort: returns null when config is missing or any upstream call fails,
 * so the ingest path can drop the message instead of crashing.
 */

const GRAPH_BASE = "https://graph.facebook.com/v19.0";

export async function downloadMedia(
  mediaId: string,
): Promise<{ data: Buffer; mime: string } | null> {
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
    return { data, mime: info.mime_type ?? "application/octet-stream" };
  } catch {
    return null;
  }
}

/** Map a MIME type to a file extension for the parser dispatcher. */
export function extFromMime(mime: string): string {
  if (mime.includes("csv")) return "csv";
  if (mime.includes("spreadsheetml") || mime.includes("ms-excel")) return "xlsx";
  if (mime.includes("pdf")) return "pdf";
  if (mime.includes("png")) return "png";
  if (mime.includes("jpeg") || mime.includes("jpg")) return "jpg";
  if (mime.includes("webp")) return "webp";
  if (mime.includes("tiff")) return "tiff";
  return "bin";
}
