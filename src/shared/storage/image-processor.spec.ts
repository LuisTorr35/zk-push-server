import { randomBytes } from 'node:crypto';
import sharp from 'sharp';
import { ImageProcessor, MAX_PHOTO_BYTES, MAX_UPLOAD_BYTES } from './image-processor';

describe('ImageProcessor', () => {
  const images = new ImageProcessor();
  it('accepts PNG bytes, preserves proportions, and does not enlarge', async () => {
    const input = await sharp({
      create: { width: 80, height: 120, channels: 4, background: '#ffffff00' },
    })
      .png()
      .toBuffer();
    const result = await images.process(input);
    const metadata = await sharp(result).metadata();
    expect(metadata.format).toBe('jpeg');
    expect([metadata.width, metadata.height]).toEqual([80, 120]);
    expect(result.length).toBeLessThanOrEqual(MAX_PHOTO_BYTES);
  });
  it('applies EXIF orientation and removes metadata', async () => {
    const input = await sharp({
      create: { width: 180, height: 320, channels: 3, background: '#883311' },
    })
      .withMetadata({ orientation: 6 })
      .jpeg()
      .toBuffer();
    const result = await images.process(input);
    const metadata = await sharp(result).metadata();
    expect([metadata.width, metadata.height]).toEqual([320, 180]);
    expect(metadata.orientation).toBeUndefined();
    expect(metadata.exif).toBeUndefined();
  });
  it('reduces a large noisy image to the terminal byte limit', async () => {
    const input = await sharp(randomBytes(1200 * 1200 * 3), {
      raw: { width: 1200, height: 1200, channels: 3 },
    })
      .png()
      .toBuffer();
    const result = await images.process(input);
    expect(result.length).toBeLessThanOrEqual(153600);
    const metadata = await sharp(result).metadata();
    expect(metadata.width).toBeLessThanOrEqual(600);
    expect(metadata.height).toBeLessThanOrEqual(600);
  });
  it.each([Buffer.alloc(0), Buffer.from('not an image'), Buffer.from('<svg></svg>')])(
    'rejects invalid or unsupported data',
    async (input) => {
      await expect(images.process(input)).rejects.toThrow();
    },
  );
  it('rejects oversized original uploads before decoding', async () => {
    await expect(images.process(Buffer.alloc(MAX_UPLOAD_BYTES + 1))).rejects.toThrow(
      '10 MiB',
    );
  });
});
