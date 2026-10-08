/** Retain the six source-owned bytes addressed by Battle F9/3A. */
export function battleScreenEffectParameters(program, animationBytes) {
  return program.instructions.filter(instruction => instruction.operation === 'battle-effect'
    && instruction.opcode === 0xf9 && instruction.operands[0].value === 0x3a).map(instruction => {
    const pointer = instruction.offset + 2 + instruction.operands.find(row => row.name === 'argument').value;
    if (pointer < 0 || pointer + 6 > animationBytes.length) throw new Error('Battle screen-effect parameters exceed their source.');
    return { sourceOffset: instruction.offset, kind: 'screen-effect-3a',
      vector: [...animationBytes.subarray(pointer, pointer + 3)].map(value => (value << 24) >> 24), durationTicks: animationBytes[pointer + 3] * 2,
      mode: animationBytes[pointer + 4], amount: animationBytes[pointer + 5] };
  });
}
