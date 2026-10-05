import type { Page } from "@playwright/test";

/** Fixed-scale PNG for A/B inspection, computed from the rendered PCM itself. */
export async function offlineSpectrogram(page: Page, samples: number[]): Promise<Buffer> {
  const png = await page.evaluate((samples) => {
    const size = 512;
    const hop = 480;
    const width = Math.floor(samples.length / hop);
    const height = 256;
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d")!;
    const pixels = ctx.createImageData(width, height);
    for (let frame = 0; frame < width; frame++) {
      const re = new Float64Array(size);
      const im = new Float64Array(size);
      for (let n = 0; n < size; n++)
        re[n] =
          (samples[frame * hop + n] ?? 0) * (0.5 - 0.5 * Math.cos((2 * Math.PI * n) / (size - 1)));
      for (let i = 1, j = 0; i < size; i++) {
        let bit = size >> 1;
        for (; j & bit; bit >>= 1) j ^= bit;
        j ^= bit;
        if (i < j) [re[i], re[j]] = [re[j]!, re[i]!];
      }
      for (let length = 2; length <= size; length *= 2) {
        for (let start = 0; start < size; start += length) {
          for (let j = 0; j < length / 2; j++) {
            const angle = (-2 * Math.PI * j) / length;
            const a = start + j;
            const b = a + length / 2;
            const tr = re[b]! * Math.cos(angle) - im[b]! * Math.sin(angle);
            const ti = re[b]! * Math.sin(angle) + im[b]! * Math.cos(angle);
            re[b] = re[a]! - tr;
            im[b] = im[a]! - ti;
            re[a] = re[a]! + tr;
            im[a] = im[a]! + ti;
          }
        }
      }
      for (let bin = 0; bin < height; bin++) {
        const db = 10 * Math.log10((re[bin]! ** 2 + im[bin]! ** 2) / size ** 2 + 1e-20);
        const intensity = Math.max(0, Math.min(1, (db + 100) / 80));
        const pixel = ((height - 1 - bin) * width + frame) * 4;
        pixels.data[pixel] = 255 * intensity;
        pixels.data[pixel + 1] = 180 * intensity ** 2;
        pixels.data[pixel + 2] = 140 * Math.sqrt(intensity);
        pixels.data[pixel + 3] = 255;
      }
    }
    ctx.putImageData(pixels, 0, 0);
    return canvas.toDataURL("image/png").split(",")[1]!;
  }, samples);
  return Buffer.from(png, "base64");
}
