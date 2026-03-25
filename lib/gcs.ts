import { Storage } from '@google-cloud/storage';

const bucketName = process.env.GCS_BUCKET;
if (!bucketName) throw new Error('GCS_BUCKET env var is required');

const storage = new Storage(); // uses ADC or GOOGLE_APPLICATION_CREDENTIALS
const bucket = storage.bucket(bucketName);

export async function streamToGCS(
  source: NodeJS.ReadableStream,
  gcsKey: string,
  contentType: string,
): Promise<void> {
  const file = bucket.file(gcsKey);
  const writeStream = file.createWriteStream({
    metadata: { contentType },
    // resumable upload (default) is correct for streaming — avoids content-length requirement
  });
  return new Promise((resolve, reject) => {
    source.pipe(writeStream);
    writeStream.on('finish', resolve);
    writeStream.on('error', reject);
  });
}

export async function deleteFromGCS(gcsKey: string): Promise<void> {
  await bucket.file(gcsKey).delete();
}

export function getGCSReadStream(gcsKey: string): NodeJS.ReadableStream {
  return bucket.file(gcsKey).createReadStream();
}

/** Rename a GCS object from oldKey to newKey. Returns the new key. */
export async function renameInGCS(oldKey: string, newKey: string): Promise<void> {
  await bucket.file(oldKey).rename(newKey);
}
