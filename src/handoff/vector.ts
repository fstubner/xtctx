export function serializeVector(vector: Float32Array): Buffer {
  const copy = new Float32Array(vector.length);
  copy.set(vector);
  return Buffer.from(copy.buffer);
}

export function deserializeVector(buffer: Buffer, dimensions: number): Float32Array {
  const arrayBuffer = buffer.buffer.slice(
    buffer.byteOffset,
    buffer.byteOffset + buffer.byteLength,
  );
  const vector = new Float32Array(arrayBuffer);
  if (vector.length === dimensions) {
    return vector;
  }

  const resized = new Float32Array(dimensions);
  resized.set(vector.slice(0, dimensions));
  return resized;
}

export function cosineSimilarity(left: Float32Array, right: Float32Array): number {
  const length = Math.min(left.length, right.length);
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;

  for (let index = 0; index < length; index += 1) {
    dot += left[index] * right[index];
    leftNorm += left[index] * left[index];
    rightNorm += right[index] * right[index];
  }

  if (leftNorm === 0 || rightNorm === 0) {
    return 0;
  }

  return dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm));
}
