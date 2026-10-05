/** TeleDisk advanced compression is the LH1 LZSS/adaptive Huffman stream,
 * without LH1's size prefix. Format descriptions (no implementation code):
 * https://github.com/jmechnich/wteledsk/blob/master/doc/wteledsk.htm
 * https://www.masanao.site/staff/iz/formats/lzh.html
 * 314 symbols, 4 KiB history, lengths 3..60; frequencies halve at 32768.
 */
export function advancedBytes(input: Uint8Array): () => number {
  const symbols = 314;
  const nodes = 627;
  const root = 626;
  const frequency = new Uint32Array(nodes + 1);
  const child = new Uint16Array(nodes);
  const parent = new Uint16Array(nodes + symbols);
  for (let symbol = 0; symbol < symbols; symbol++) {
    frequency[symbol] = 1;
    child[symbol] = nodes + symbol;
    parent[nodes + symbol] = symbol;
  }
  for (let node = symbols, pair = 0; node < nodes; node++, pair += 2) {
    child[node] = pair;
    frequency[node] = frequency[pair]! + frequency[pair + 1]!;
    parent[pair] = node;
    parent[pair + 1] = node;
  }
  frequency[nodes] = 0xffff;
  let bitOffset = 0;
  const bits = (count: number): number => {
    if (bitOffset + count > input.length * 8)
      throw new Error("TeleDisk compression ends early. Add a fresh copy of the disk.");
    let value = 0;
    for (let bit = 0; bit < count; bit++, bitOffset++)
      value = (value << 1) | ((input[bitOffset >> 3]! >> (7 - (bitOffset & 7))) & 1);
    return value;
  };
  const assignParents = (node: number): void => {
    const first = child[node]!;
    parent[first] = node;
    if (first < nodes) parent[first + 1] = node;
  };
  const update = (symbol: number): void => {
    if (frequency[root] === 32768) {
      let leaves = 0;
      for (let node = 0; node < nodes; node++)
        if (child[node]! >= nodes) {
          frequency[leaves] = (frequency[node]! + 1) >> 1;
          child[leaves++] = child[node]!;
        }
      for (let node = symbols, pair = 0; node < nodes; node++, pair += 2) {
        const weight = frequency[pair]! + frequency[pair + 1]!;
        let insert = node;
        while (insert > 0 && frequency[insert - 1]! > weight) {
          frequency[insert] = frequency[insert - 1]!;
          child[insert] = child[insert - 1]!;
          insert--;
        }
        frequency[insert] = weight;
        child[insert] = pair;
      }
      for (let node = 0; node < nodes; node++) assignParents(node);
    }
    let node = parent[nodes + symbol]!;
    for (;;) {
      const weight = ++frequency[node]!;
      let destination = node;
      while (frequency[destination + 1]! < weight) destination++;
      if (destination !== node) {
        frequency[node] = frequency[destination]!;
        frequency[destination] = weight;
        const first = child[node]!;
        child[node] = child[destination]!;
        child[destination] = first;
        assignParents(node);
        assignParents(destination);
        node = destination;
      }
      if (node === root) break;
      node = parent[node]!;
    }
  };
  const history = new Uint8Array(4096).fill(32);
  let cursor = 4036;
  let remaining = 0;
  let source = 0;
  let expanded = 0;
  return () => {
    if (++expanded > 4 * 1024 * 1024)
      throw new Error("TeleDisk expands beyond a floppy disk. Add a fresh copy of the disk.");
    let value: number;
    if (remaining) {
      value = history[source]!;
      source = (source + 1) & 4095;
      remaining--;
    } else {
      let node = child[root]!;
      while (node < nodes) node = child[node + bits(1)]!;
      const symbol = node - nodes;
      update(symbol);
      if (symbol < 256) value = symbol;
      else {
        // Canonical static code for the upper six distance bits: counts
        // by code length 3..8 are 1, 3, 8, 12, 24, 16. Low six bits are raw.
        let code = bits(3);
        let first = 0;
        let base = 0;
        const counts = [1, 3, 8, 12, 24, 16];
        let high = -1;
        for (let length = 3; length <= 8; length++) {
          const count = counts[length - 3]!;
          if (code - first < count) {
            high = base + code - first;
            break;
          }
          base += count;
          first = (first + count) << 1;
          code = (code << 1) | bits(1);
        }
        if (high < 0)
          throw new Error("TeleDisk has an invalid distance code. Add a fresh copy of the disk.");
        source = (cursor - ((high << 6) | bits(6)) - 1) & 4095;
        remaining = symbol - 254;
        value = history[source]!;
        source = (source + 1) & 4095;
      }
    }
    history[cursor] = value;
    cursor = (cursor + 1) & 4095;
    return value;
  };
}
