import { describe, it, expect } from 'vitest';
import { Readable } from 'stream';
import crypto from 'crypto';
import { computeMD5AndStream } from '@/lib/md5';

function expectedMd5(buf: Buffer): string {
  return crypto.createHash('md5').update(buf).digest('hex');
}

describe('computeMD5AndStream()', () => {
  it('resolves md5Promise to the correct MD5 hex string', async () => {
    const input = Buffer.from('hello world');
    const source = Readable.from(input);
    const { md5Promise, passThrough } = computeMD5AndStream(source);

    // Drain the passThrough so 'end' fires
    passThrough.resume();

    const md5 = await md5Promise;
    expect(md5).toBe(expectedMd5(input));
  });

  it('resolves sizePromise to the correct byte count', async () => {
    const input = Buffer.from('hello world');
    const source = Readable.from(input);
    const { sizePromise, passThrough } = computeMD5AndStream(source);

    passThrough.resume();

    const size = await sizePromise;
    expect(size).toBe(input.byteLength);
  });

  it('passThrough emits the same data as the source', async () => {
    const input = Buffer.from('test data for streaming');
    const source = Readable.from(input);
    const { passThrough } = computeMD5AndStream(source);

    const chunks: Buffer[] = [];
    await new Promise<void>((resolve, reject) => {
      passThrough.on('data', (chunk: Buffer) => chunks.push(chunk));
      passThrough.on('end', resolve);
      passThrough.on('error', reject);
    });

    expect(Buffer.concat(chunks).toString()).toBe(input.toString());
  });

  it('handles empty input correctly', async () => {
    const source = Readable.from(Buffer.alloc(0));
    const { md5Promise, sizePromise, passThrough } = computeMD5AndStream(source);

    passThrough.resume();

    const [md5, size] = await Promise.all([md5Promise, sizePromise]);
    expect(md5).toBe(expectedMd5(Buffer.alloc(0)));
    expect(size).toBe(0);
  });

  it('handles multi-chunk input correctly', async () => {
    async function* multiChunk() {
      yield Buffer.from('chunk1');
      yield Buffer.from('chunk2');
      yield Buffer.from('chunk3');
    }
    const source = Readable.from(multiChunk());
    const { md5Promise, sizePromise, passThrough } = computeMD5AndStream(source);

    passThrough.resume();

    const [md5, size] = await Promise.all([md5Promise, sizePromise]);
    const combined = Buffer.from('chunk1chunk2chunk3');
    expect(md5).toBe(expectedMd5(combined));
    expect(size).toBe(combined.byteLength);
  });
});
