import { Readable } from 'stream';

function* writeFormattedValue(value: unknown): Generator<string, void, undefined> {
  if (typeof value === 'function') {
    yield 'null';
  } else if (value === undefined) {
    yield 'null';
  } else if (value === null) {
    yield 'null';
  } else if (typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number') {
    // Standard primitives => let JSON.stringify handle proper escaping
    yield JSON.stringify(value);
  } else {
    // Fallback for any other data types (e.g. Symbol, BigInt, etc.)
    yield JSON.stringify(value);
  }
}
/**
 * Recursively serialize an object (including arrays, Dates, etc.) into JSON chunks.
 * This function is a generator that yields small JSON string segments.
 */
function* serializeObject<T>(
  obj: T,
  depth: number = 0,
  indent: string = '  ',
): Generator<string, void, undefined> {
  const currentIndent = indent.repeat(depth);
  const nextIndent = indent.repeat(depth + 1);

  // 1. Handle Date
  if (obj instanceof Date) {
    yield JSON.stringify(obj.toISOString());
    return;
  }

  // 2. Handle Array
  if (Array.isArray(obj)) {
    yield '[\n';
    for (let i = 0; i < obj.length; i++) {
      if (i > 0) {
        // separate elements by comma + newline
        yield ',\n';
      }
      yield nextIndent;
      // recursively yield elements
      yield* serializeObject(obj[i], depth + 1, indent);
    }
    yield `\n${currentIndent}]`;
    return;
  }

  // 3. Handle Object
  if (obj !== null && typeof obj === 'object') {
    yield '{\n';
    const entries = Object.entries(obj);
    for (let i = 0; i < entries.length; i++) {
      const [key, value] = entries[i];
      if (i > 0) {
        // separate properties by comma + newline
        yield ',\n';
      }
      yield `${nextIndent}${JSON.stringify(key)}: `;
      yield* serializeObject(value, depth + 1, indent);
    }
    yield `\n${currentIndent}}`;
    return;
  }

  // 4. Handle primitives (string, number, boolean, null, etc.)
  yield* writeFormattedValue(obj);
}

/**
 * Create a Readable stream that pushes JSON data by consuming our generator.
 */
export function objectToReadableStream<T>(obj: T, indent: string = '  '): Readable {
  const generator = serializeObject(obj, 0, indent);

  return new Readable({
    read() {
      const { value, done } = generator.next();
      if (done) {
        this.push(null); // Signal end of the stream
      } else {
        this.push(value);
      }
    },
  });
}
