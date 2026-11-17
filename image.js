export async function resizeThumbnail(blob, { requireDetail = false } = {}) {
  const bitmap = await createImageBitmap(blob);
  const scale = Math.min(1, 480 / bitmap.width, 300 / bitmap.height);
  const canvas = new OffscreenCanvas(
    Math.max(1, Math.round(bitmap.width * scale)),
    Math.max(1, Math.round(bitmap.height * scale)),
  );
  try {
    const context = canvas.getContext("2d", { alpha: false });
    context.fillStyle = "#fff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    if (requireDetail && !hasImageDetail(canvas)) return;
  } finally {
    bitmap.close();
  }
  const jpeg = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.72 });
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(jpeg);
  });
}

function hasImageDetail(canvas) {
  const width = 64;
  const height = 36;
  const sample = new OffscreenCanvas(width, height).getContext("2d");
  sample.drawImage(canvas, 0, 0, width, height);
  const { data } = sample.getImageData(0, 0, width, height);

  // Discard near-uniform frames, including a small spinner on a blank page.
  const hasContrast = (a, b) => Math.max(
    Math.abs(data[a] - data[b]),
    Math.abs(data[a + 1] - data[b + 1]),
    Math.abs(data[a + 2] - data[b + 2]),
  ) >= 22;
  const minimumEdges = width * height * 0.025;
  let edges = 0;
  for (let y = 1; y < height; y++) {
    for (let x = 1; x < width; x++) {
      const pixel = (y * width + x) * 4;
      if (hasContrast(pixel, pixel - 4) || hasContrast(pixel, pixel - width * 4)) edges++;
      if (edges >= minimumEdges) return true;
    }
  }
  return false;
}
