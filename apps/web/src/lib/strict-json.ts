const MAX_JSON_NESTING_DEPTH = 64;

export function parseJsonWithUniqueMembers(source: string): unknown {
  let position = 0;

  const fail = (): never => {
    throw new SyntaxError('Invalid JSON body');
  };

  const skipWhitespace = () => {
    while (position < source.length) {
      const code = source.charCodeAt(position);
      if (code !== 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d)
        return;
      position += 1;
    }
  };

  const isDigit = (code: number) => code >= 0x30 && code <= 0x39;

  const parseString = (): string => {
    if (source[position] !== '"') fail();
    const start = position;
    position += 1;
    while (position < source.length) {
      const code = source.charCodeAt(position);
      if (code === 0x22) {
        position += 1;
        const decoded: unknown = JSON.parse(source.slice(start, position));
        if (typeof decoded === 'string') return decoded;
        return fail();
      }
      if (code < 0x20) fail();
      if (code === 0x5c) {
        position += 1;
        const escape = source[position];
        if (escape === 'u') {
          for (let offset = 1; offset <= 4; offset += 1) {
            const hex = source.charCodeAt(position + offset);
            const validHex =
              (hex >= 0x30 && hex <= 0x39) ||
              (hex >= 0x41 && hex <= 0x46) ||
              (hex >= 0x61 && hex <= 0x66);
            if (!validHex) fail();
          }
          position += 5;
          continue;
        }
        if (
          escape !== '"' &&
          escape !== '\\' &&
          escape !== '/' &&
          escape !== 'b' &&
          escape !== 'f' &&
          escape !== 'n' &&
          escape !== 'r' &&
          escape !== 't'
        ) {
          fail();
        }
      }
      position += 1;
    }
    return fail();
  };

  const parseNumber = () => {
    if (source[position] === '-') position += 1;
    const first = source.charCodeAt(position);
    if (first === 0x30) {
      position += 1;
      if (isDigit(source.charCodeAt(position))) fail();
    } else {
      if (first < 0x31 || first > 0x39) fail();
      position += 1;
      while (isDigit(source.charCodeAt(position))) position += 1;
    }
    if (source[position] === '.') {
      position += 1;
      if (!isDigit(source.charCodeAt(position))) fail();
      while (isDigit(source.charCodeAt(position))) position += 1;
    }
    if (source[position] === 'e' || source[position] === 'E') {
      position += 1;
      if (source[position] === '+' || source[position] === '-') position += 1;
      if (!isDigit(source.charCodeAt(position))) fail();
      while (isDigit(source.charCodeAt(position))) position += 1;
    }
  };

  const consumeLiteral = (literal: 'true' | 'false' | 'null') => {
    if (!source.startsWith(literal, position)) fail();
    position += literal.length;
  };

  const parseValue = (depth: number): void => {
    skipWhitespace();
    const token = source[position];
    if (token === '"') {
      parseString();
      return;
    }
    if (token === '-' || isDigit(source.charCodeAt(position))) {
      parseNumber();
      return;
    }
    if (token === 't') return consumeLiteral('true');
    if (token === 'f') return consumeLiteral('false');
    if (token === 'n') return consumeLiteral('null');
    if (depth >= MAX_JSON_NESTING_DEPTH) fail();
    if (token === '{') {
      position += 1;
      skipWhitespace();
      if (source[position] === '}') {
        position += 1;
        return;
      }
      const members = new Set<string>();
      while (position < source.length) {
        const member = parseString();
        if (members.has(member)) fail();
        members.add(member);
        skipWhitespace();
        if (source[position] !== ':') fail();
        position += 1;
        parseValue(depth + 1);
        skipWhitespace();
        if (source[position] === '}') {
          position += 1;
          return;
        }
        if (source[position] !== ',') fail();
        position += 1;
        skipWhitespace();
      }
      return fail();
    }
    if (token === '[') {
      position += 1;
      skipWhitespace();
      if (source[position] === ']') {
        position += 1;
        return;
      }
      while (position < source.length) {
        parseValue(depth + 1);
        skipWhitespace();
        if (source[position] === ']') {
          position += 1;
          return;
        }
        if (source[position] !== ',') fail();
        position += 1;
      }
      return fail();
    }
    fail();
  };

  parseValue(0);
  skipWhitespace();
  if (position !== source.length) fail();
  return JSON.parse(source) as unknown;
}

export async function readBoundedUtf8(
  body: ReadableStream<Uint8Array> | null,
  maximumBytes: number,
): Promise<string> {
  if (body === null) throw new SyntaxError('Missing JSON body');
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      totalBytes += chunk.value.byteLength;
      if (totalBytes > maximumBytes) {
        await reader.cancel();
        throw new SyntaxError('JSON body is too large');
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
  const joined = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder('utf-8', { fatal: true }).decode(joined);
}

export function isJsonContentType(value: string | null): boolean {
  return (
    value !== null &&
    /^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(value)
  );
}
