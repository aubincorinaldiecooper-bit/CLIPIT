/**
 * Vectors on their way to the database and back.
 *
 * A window's embedding is stored as its raw little-endian float32 bytes,
 * because pgvector is not installed and cannot be assumed (see migration
 * 044). That makes this module the only place that knows the storage format,
 * and the only place that has to change if a vector column ever arrives.
 *
 * Nothing here talks to the database or to a model. It is arithmetic over
 * numbers, which is what makes it testable without either.
 */

/** Four bytes to a float32, everywhere. */
const BYTES_PER_FLOAT = 4;

/**
 * A vector as bytes.
 *
 * Rejects anything that is not a finite number rather than writing it. A NaN
 * that reaches storage poisons every comparison it takes part in — it does not
 * throw, it silently scores as "not similar to anything", which reads as a
 * video that contains nothing.
 */
export function packVector(values: readonly number[]): Buffer {
  const buffer = Buffer.allocUnsafe(values.length * BYTES_PER_FLOAT);
  for (let i = 0; i < values.length; i += 1) {
    const value = values[i];
    // Finite in JavaScript is not the same as finite in float32. 1e39 passes
    // Number.isFinite and becomes Infinity the moment it is written, and an
    // infinity poisons every comparison it takes part in — the whole video
    // then scores as similar to nothing. Math.fround is exactly the rounding
    // writeFloatLE will apply, so this checks the value that actually lands.
    const stored = Math.fround(value ?? Number.NaN);
    if (value === undefined || !Number.isFinite(value) || !Number.isFinite(stored)) {
      throw new Error(`embedding value at index ${i} is not a finite float32 (${String(value)})`);
    }
    buffer.writeFloatLE(stored, i * BYTES_PER_FLOAT);
  }
  return buffer;
}

/**
 * Bytes back to a vector.
 *
 * `dims` is passed separately and checked against the byte length rather than
 * inferred from it, so a row whose vector was written by a different model —
 * or truncated in transit — is caught here instead of quietly producing a
 * shorter vector that still compares against everything.
 */
export function unpackVector(bytes: Buffer, dims: number): Float32Array {
  if (bytes.length !== dims * BYTES_PER_FLOAT) {
    throw new Error(
      `stored vector is ${bytes.length} bytes, which is not ${dims} float32 values (${dims * BYTES_PER_FLOAT} bytes)`,
    );
  }
  const values = new Float32Array(dims);
  for (let i = 0; i < dims; i += 1) {
    values[i] = bytes.readFloatLE(i * BYTES_PER_FLOAT);
  }
  return values;
}

/**
 * How alike two vectors are, between -1 and 1.
 *
 * True cosine rather than a bare dot product: whether a model returns
 * normalised vectors is a property of that model and of its serving code, and
 * assuming it is a way to get scores that look plausible and rank wrongly.
 * The extra arithmetic is a rounding error against the cost of being wrong.
 *
 * A zero-length vector is similar to nothing, including itself. Returning 0
 * rather than dividing by zero keeps a dead row out of the results instead of
 * putting NaN at the top of them.
 */
export function cosineSimilarity(a: Float32Array | readonly number[], b: Float32Array | readonly number[]): number {
  if (a.length !== b.length) {
    throw new Error(`cannot compare a ${a.length}-dimension vector with a ${b.length}-dimension one`);
  }
  let dot = 0;
  let aSquared = 0;
  let bSquared = 0;
  for (let i = 0; i < a.length; i += 1) {
    const left = a[i] ?? 0;
    const right = b[i] ?? 0;
    dot += left * right;
    aSquared += left * left;
    bSquared += right * right;
  }
  if (aSquared === 0 || bSquared === 0) return 0;
  return dot / (Math.sqrt(aSquared) * Math.sqrt(bSquared));
}
