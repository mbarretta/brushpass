import crypto from 'crypto';
import { PassThrough, Readable } from 'stream';

export interface MD5Result {
  md5Promise: Promise<string>;
  sizePromise: Promise<number>;
  passThrough: PassThrough;
}

export function computeMD5AndStream(source: Readable): MD5Result {
  const passThrough = new PassThrough();
  const hash = crypto.createHash('md5');
  let size = 0;

  const md5Promise = new Promise<string>((resolve, reject) => {
    passThrough.on('data', (chunk: Buffer) => {
      hash.update(chunk);
      size += chunk.length;
    });
    passThrough.on('end', () => resolve(hash.digest('hex')));
    passThrough.on('error', reject);
  });

  const sizePromise = md5Promise.then(() => size);

  source.pipe(passThrough);

  return { md5Promise, sizePromise, passThrough };
}
