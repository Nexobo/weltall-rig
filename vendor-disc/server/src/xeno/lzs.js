import { BinaryReader, XenoFormatError } from './binary-reader.js';

export function decompressLzs(input, outputSize) {
  const source = Buffer.isBuffer(input) ? input : Buffer.from(input);

  if (!Number.isInteger(outputSize) || outputSize < 0) {
    throw new XenoFormatError('Invalid LZS output size', 'INVALID_LZS_SIZE', { outputSize });
  }

  const output = Buffer.alloc(outputSize);
  let inputOffset = 0;
  let outputOffset = 0;
  let command = 0;
  let bitsRemaining = 0;

  while (outputOffset < outputSize) {
    if (bitsRemaining === 0) {
      if (inputOffset >= source.length) {
        throw new XenoFormatError('LZS command stream ended early', 'TRUNCATED_LZS', {
          inputOffset,
          outputOffset,
          outputSize,
        });
      }

      command = source[inputOffset++];
      bitsRemaining = 8;
    }

    if ((command & 1) !== 0) {
      if (inputOffset + 2 > source.length) {
        throw new XenoFormatError('LZS back-reference ended early', 'TRUNCATED_LZS', {
          inputOffset,
          outputOffset,
          outputSize,
        });
      }

      const a = source[inputOffset++];
      const b = source[inputOffset++];
      const distance = a | ((b & 0x0f) << 8);
      const length = (b >> 4) + 3;
      let readOffset = outputOffset - distance;

      for (let index = 0; index < length && outputOffset < outputSize; index += 1) {
        output[outputOffset++] = readOffset < 0 ? 0 : output[readOffset];
        readOffset += 1;
      }
    } else {
      if (inputOffset >= source.length) {
        throw new XenoFormatError('LZS literal stream ended early', 'TRUNCATED_LZS', {
          inputOffset,
          outputOffset,
          outputSize,
        });
      }

      output[outputOffset++] = source[inputOffset++];
    }

    command >>= 1;
    bitsRemaining -= 1;
  }

  return output;
}

export function decompressLzsFile(buffer) {
  const reader = new BinaryReader(buffer, 'LZS file');
  const outputSize = reader.u32(0);
  return decompressLzs(reader.slice(4, buffer.length - 4), outputSize);
}
