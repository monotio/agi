/** Independent object-tree writer for synthetic LH1 streams. Literal-only
 * encoding keeps the media writer simple; matches have separate bit vectors.
 */
interface Node {
  weight: number;
  symbol?: number;
  left?: Node;
  right?: Node;
  up?: Node;
  rank: number;
}
export function lh1Literals(input: Uint8Array): Uint8Array {
  const leaves: Node[] = Array.from({ length: 314 }, (_, symbol) => ({
    weight: 1,
    symbol,
    rank: symbol,
  }));
  let order = [...leaves];
  const rebuild = (initial: boolean): void => {
    if (!initial)
      order = order
        .filter((node) => node.symbol !== undefined)
        .map((node) => ({ weight: Math.ceil(node.weight / 2), symbol: node.symbol!, rank: 0 }));
    for (let pair = 0; order.length < 627; pair += 2) {
      const left = order[pair]!;
      const right = order[pair + 1]!;
      const node: Node = { weight: left.weight + right.weight, left, right, rank: 0 };
      left.up = node;
      right.up = node;
      let at = order.length;
      while (at > pair + 1 && order[at - 1]!.weight > node.weight) at--;
      order.splice(at, 0, node);
    }
    order.forEach((node, rank) => {
      node.rank = rank;
      if (node.symbol !== undefined) leaves[node.symbol] = node;
    });
  };
  rebuild(true);
  const output: number[] = [];
  let byte = 0;
  let used = 0;
  const emit = (bit: number): void => {
    byte = byte * 2 + bit;
    if (++used === 8) {
      output.push(byte);
      byte = 0;
      used = 0;
    }
  };
  for (const symbol of input) {
    if (order[626]!.weight === 32768) rebuild(false);
    let node = leaves[symbol]!;
    const path: number[] = [];
    while (node.up) {
      path.push(Number(node.up.right === node));
      node = node.up;
    }
    path.reverse().forEach(emit);
    node = leaves[symbol]!;
    for (;;) {
      node.weight++;
      let rank = node.rank;
      while (rank < 626 && order[rank + 1]!.weight < node.weight) rank++;
      if (rank !== node.rank) {
        const other = order[rank]!;
        const a = node.up!;
        const b = other.up!;
        const aRight = a.right === node;
        const bRight = b.right === other;
        if (aRight) a.right = other;
        else a.left = other;
        if (bRight) b.right = node;
        else b.left = node;
        node.up = b;
        other.up = a;
        order[node.rank] = other;
        order[rank] = node;
        other.rank = node.rank;
        node.rank = rank;
      }
      if (!node.up) break;
      node = node.up;
    }
  }
  if (used) output.push(byte << (8 - used));
  return new Uint8Array(output);
}

export function advancedTd0(normal: Uint8Array): Uint8Array {
  const body = lh1Literals(normal.subarray(12));
  const output = new Uint8Array(12 + body.length);
  output.set(normal.subarray(0, 12));
  output[0] = 116;
  output[1] = 100;
  let checksum = 0;
  for (const byte of output.subarray(0, 10)) {
    checksum ^= byte * 256;
    for (let i = 0; i < 8; i++)
      checksum = ((checksum * 2) ^ (checksum >= 32768 ? 0xa097 : 0)) & 65535;
  }
  output[10] = checksum & 255;
  output[11] = checksum >> 8;
  output.set(body, 12);
  return output;
}
