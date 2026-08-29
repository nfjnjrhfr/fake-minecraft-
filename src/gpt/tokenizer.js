// 字元級分詞器：每一個字（含標點、換行）就是一個 token。
// 大模型用的是 BPE 子詞，但中文字元級最直觀，也讓詞彙表小到能在 CPU 上訓練。
export class CharTokenizer {
  constructor(chars) {
    this.itos = chars;
    this.stoi = new Map(chars.map((c, i) => [c, i]));
  }

  static fromText(text) {
    return new CharTokenizer([...new Set([...text])].sort());
  }

  get vocabSize() {
    return this.itos.length;
  }

  encode(text) {
    const out = [];
    for (const ch of text) {
      const id = this.stoi.get(ch);
      if (id !== undefined) out.push(id); // 沒看過的字直接跳過
    }
    return Int32Array.from(out);
  }

  decode(ids) {
    let s = '';
    for (const id of ids) s += this.itos[id] ?? '';
    return s;
  }

  toJSON() {
    return { chars: this.itos };
  }

  static fromJSON(obj) {
    return new CharTokenizer(obj.chars);
  }
}
