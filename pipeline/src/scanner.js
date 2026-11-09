export class TopLevelScanner {
  constructor({ onValue, onItem }) {
    this.onValue = onValue || (() => {});
    this.onItem = onItem || (() => {});
    this.i = 0;
    this.depth = 0;
    this.inStr = false;
    this.esc = false;
    this.strStart = -1;
    this.expectKey = false;
    this.key = null;
    this.valueStart = -1;
    this.valueIsArray = false;
    this.itemStart = -1;
    this.itemCount = 0;
  }

  feed(text) {
    if (text.length < this.i) {
      this.i = 0;
      this.depth = 0;
      this.inStr = false;
      this.esc = false;
      this.expectKey = false;
      this.key = null;
    }
    for (; this.i < text.length; this.i++) {
      const c = text[this.i];
      if (this.inStr) {
        if (this.esc) this.esc = false;
        else if (c === '\\') this.esc = true;
        else if (c === '"') {
          this.inStr = false;
          if (this.depth === 1 && this.expectKey) this.key = text.slice(this.strStart + 1, this.i);
        }
        continue;
      }
      if (c === '"') {
        this.inStr = true;
        this.strStart = this.i;
      } else if (c === '{' || c === '[') {
        this.depth++;
        if (this.depth === 1) this.expectKey = true;
        else if (this.depth === 2) {
          this.valueStart = this.i;
          this.valueIsArray = c === '[';
          this.itemCount = 0;
        } else if (this.depth === 3 && this.valueIsArray) this.itemStart = this.i;
      } else if (c === '}' || c === ']') {
        if (this.depth === 3 && this.valueIsArray) this.emitItem(text.slice(this.itemStart, this.i + 1));
        if (this.depth === 2) this.emitValue(text.slice(this.valueStart, this.i + 1));
        this.depth--;
      } else if (this.depth === 1 && c === ':') this.expectKey = false;
      else if (this.depth === 1 && c === ',') this.expectKey = true;
    }
  }

  emitItem(raw) {
    try {
      this.onItem(this.key, JSON.parse(raw), this.itemCount++);
    } catch {}
  }

  emitValue(raw) {
    try {
      this.onValue(this.key, JSON.parse(raw));
    } catch {}
  }
}
