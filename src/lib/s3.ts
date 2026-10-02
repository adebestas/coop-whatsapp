import { readFile } from "node:fs/promises";
import { createHash, createHmac } from "node:crypto";

const BACKUP_BUCKET = process.env.BACKUP_BUCKET ?? "";
const BACKUP_KEY = process.env.BACKUP_KEY ?? "";
const BACKUP_SECRET = process.env.BACKUP_SECRET ?? "";
const BACKUP_ENDPOINT = process.env.BACKUP_ENDPOINT ?? "";
const BACKUP_REGION = process.env.BACKUP_REGION ?? "eu-west-1";

/**
 * Upload a file to S3-compatible storage using the AWS Signature V4 presigned
 * PUT approach. This avoids pulling in the full AWS SDK.
 */
export async function uploadToS3(filePath: string, key: string): Promise<boolean> {
  if (!s3Configured()) return false;
  try {
    const date = new Date().toISOString().replace(/[:-]|\.\d{3}/g, "");
    const dateStamp = date.slice(0, 8);
    const endpoint = BACKUP_ENDPOINT
      ? `${BACKUP_ENDPOINT}/${BACKUP_BUCKET}/${key}`
      : `https://${BACKUP_BUCKET}.s3.${BACKUP_REGION}.amazonaws.com/${key}`;

    const payloadHash = createHash("sha256")
      .update(await readFile(filePath))
      .digest("hex");
    const canonicalRequest = [
      "PUT",
      `/${key}`,
      "",
      `host:${BACKUP_BUCKET}.s3.${BACKUP_REGION}.amazonaws.com`,
      `x-amz-content-sha256:${payloadHash}`,
      `x-amz-date:${new Date().toISOString().replace(/[:-]|\.\d{3}/g, "")}`,
      "",
      "host;x-amz-content-sha256;x-amz-date",
      payloadHash,
    ].join("\n");
    const credentialScope = `${dateStamp}/${BACKUP_REGION}/s3/aws4_request`;
    const stringToSign = [
      "AWS4-HMAC-SHA256",
      new Date().toISOString().replace(/[:-]|\.\d{3}/g, ""),
      credentialScope,
      createHash("sha256").update(canonicalRequest).digest("hex"),
    ].join("\n");

    const hmac = (key: Buffer | string, data: string) =>
      createHmac("sha256", key).update(data).digest();
    const signingKey = hmac(
      hmac(hmac(hmac(`AWS4${BACKUP_SECRET}`, dateStamp), BACKUP_REGION), "s3"),
      "aws4_request",
    );
    const signature = createHmac("sha256", signingKey).update(stringToSign).digest("hex");

    const authHeader = `AWS4-HMAC-SHA256 Credential=${BACKUP_KEY}/${credentialScope}, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=${signature}`;

    const res = await fetch(endpoint, {
      method: "PUT",
      headers: {
        Host: `${BACKUP_BUCKET}.s3.${BACKUP_REGION}.amazonaws.com`,
        "x-amz-content-sha256": payloadHash,
        "x-amz-date": new Date().toISOString().replace(/[:-]|\.\d{3}/g, ""),
        Authorization: authHeader,
      },
      body: await readFile(filePath),
    });

    if (!res.ok) {
      console.error(`[S3] upload failed (${res.status}): ${await res.text()}`);
      return false;
    }
    console.log(`[S3] uploaded to s3://${BACKUP_BUCKET}/${key}`);
    return true;
  } catch (err: any) {
    console.error("[S3] upload error:", err?.message ?? err);
    return false;
  }
}

function s3Configured(): boolean {
  return !!(BACKUP_BUCKET && BACKUP_KEY && BACKUP_SECRET);
}
