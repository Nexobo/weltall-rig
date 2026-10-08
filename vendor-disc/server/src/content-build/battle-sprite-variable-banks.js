/** Publish only the source byte-bank slots addressed by the compiled program. */
export function battleSpriteVariableBanks(program, sourceBytes) {
  const externalSlots = new Set();
  for (const instruction of program.instructions) {
    const args = Object.fromEntries(instruction.operands.map(row => [row.name, row.value]));
    let selector;
    if (instruction.operation === 'branch-on-variable') selector = args.variableSelector;
    else if (instruction.operation === 'apply-variable-operation' || instruction.opcode === 0xe8) selector = args.value >> 8;
    else if (instruction.operation === 'variable-operation' || instruction.opcode === 0xe5) selector = args.value & 255;
    else if (instruction.opcode === 0xb9) selector = args.value;
    if (selector & 128) externalSlots.add(selector & 127);
    if ([0xd0, 0xd1, 0xd2, 0xd3, 0xd5, 0xdd, 0xde].includes(instruction.opcode)) {
      const sourceSelector = args.value >> 8;
      if (sourceSelector & 128) externalSlots.add(sourceSelector & 127);
    }
    if ([0xdb, 0xdc].includes(instruction.opcode) && selector & 128) externalSlots.add((selector & 127) + 1);
    if (instruction.operation === 'battle-create-sprite-motion-trail') {
      const trailSelector = instruction.parameters.variableSelector;
      if (trailSelector & 128) { externalSlots.add(trailSelector & 127); externalSlots.add((trailSelector & 127) + 1); }
    }
  }
  return program.secondaryEntries.map(entry => ({ sourceOffset: entry.targetOffset,
    initialValues: [...externalSlots].sort((a, b) => a - b).map(slot => {
      const offset = entry.targetOffset + slot;
      if (offset < 0 || offset >= sourceBytes.length) throw new Error(`Battle variable bank ${entry.targetOffset}+${slot} is outside its source.`);
      return { slot, value: sourceBytes[offset] };
    }) }));
}
