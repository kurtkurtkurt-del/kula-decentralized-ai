// A download progress bar on stderr, so stdout stays clean for --json.
// On a terminal it redraws one line; piped, it prints a line every 25 %.

export function mb(bytes: number): string {
  return `${(bytes / 1e6).toFixed(1)} MB`;
}

// "[#########...............]  37%  13.9 / 37.6 MB"; without a total, just the bytes.
export function bar(got: number, total: number, width = 24): string {
  if (!(total > 0)) return `${mb(got)}`;
  const f = Math.max(0, Math.min(1, got / total));
  const full = Math.round(f * width);
  return `[${'#'.repeat(full)}${'.'.repeat(width - full)}] ${String(Math.floor(f * 100)).padStart(3)}%  ${(got / 1e6).toFixed(1)} / ${mb(total)}`;
}

export interface ProgressSink { write(s: string): unknown; isTTY?: boolean }

// A Progress callback for download(). `knownTotal` is used when the server
// sends no length (github's source tarballs come chunked).
export function progressBar(label: string, knownTotal = 0, out: ProgressSink = process.stderr): { update: (got: number, total: number) => void; done: () => void } {
  let lastStep = -1;
  let drew = false;
  return {
    update(got, total) {
      const t = total > 0 ? total : knownTotal;
      if (out.isTTY) { out.write(`\r  ${label} ${bar(got, t)}`); drew = true; return; }
      const step = t > 0 ? Math.floor((got / t) * 4) : -1;
      if (step > lastStep) { lastStep = step; out.write(`  ${label} ${bar(got, t)}\n`); }
    },
    done() { if (drew) out.write('\n'); },
  };
}
