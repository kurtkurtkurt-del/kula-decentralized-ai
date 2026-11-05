// The worker api's event stream as the phone reads it: `data: <json>` lines, events apart
// by a blank line, exactly what node/src/api.ts (class Sse) and the Kotlin ApiServer write.
// Kept free of imports so node/test can run the server's writer against this reader.
//
// The reader takes the stream in whatever pieces the transport hands over (XHR gives the
// whole text so far, fetch gives chunks) and the result never depends on where the cuts
// fall. Lines that are not `data:` or do not parse are skipped; nothing after the `done`
// event counts, whatever a confused or hostile peer sends afterwards.
export type SseEvent = Record<string, unknown>;

export class SseReader {
  private buf = '';
  private finished = false;
  /** true once a `done` event was read (or a final partial event flushed) */
  get done() { return this.finished; }

  /** Feeds the next piece of the stream and returns the complete events it finished. */
  feed(chunk: string): SseEvent[] {
    if (this.finished || !chunk) return [];
    this.buf += chunk;
    const cut = this.buf.lastIndexOf('\n\n');
    if (cut < 0) return [];
    const head = this.buf.slice(0, cut);
    this.buf = this.buf.slice(cut + 2);
    return this.take(head);
  }

  /** The stream ended: a last event without its blank line still counts. */
  end(): SseEvent[] {
    if (this.finished) return [];
    const rest = this.buf;
    this.buf = '';
    const out = this.take(rest);
    this.finished = true;
    return out;
  }

  private take(text: string): SseEvent[] {
    const out: SseEvent[] = [];
    for (const raw of text.split('\n')) {
      if (this.finished) break;
      const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (!data) continue;
      let o: unknown;
      try { o = JSON.parse(data); } catch { continue; }
      if (!o || typeof o !== 'object' || Array.isArray(o)) continue;
      out.push(o as SseEvent);
      if ((o as SseEvent).done) this.finished = true;
    }
    return out;
  }
}

/** The events of a whole stream at once (the `/load` answer is read this way). */
export function parseSse(text: string): SseEvent[] {
  const r = new SseReader();
  return [...r.feed(text), ...r.end()];
}
