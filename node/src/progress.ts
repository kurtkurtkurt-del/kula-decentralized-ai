// A one-line progress bar for downloads and hashes. Quiet when stdout is not
// a terminal (logs, --json), so nothing fills a file with carriage returns.
export const mb = (n: number) => (n / 1e6).toFixed(n < 10e6 ? 1 : 0);

export function bar(label: string, quiet = !process.stdout.isTTY): (got: number, total: number) => void {
  let last = 0;
  let done = false;
  const t0 = Date.now();
  return (got, total) => {
    if (quiet || done) return;
    const now = Date.now();
    const finished = total > 0 && got >= total;
    if (!finished && now - last < 100) return;
    last = now;
    const width = Math.max(10, Math.min(40, (process.stdout.columns ?? 80) - label.length - 40));
    const frac = total > 0 ? Math.min(1, got / total) : 0;
    const fill = Math.round(frac * width);
    const secs = (now - t0) / 1000;
    const rate = secs > 0 ? got / 1e6 / secs : 0;
    const eta = rate > 0 && total > got ? ` ${Math.round((total - got) / 1e6 / rate)} s` : '';
    const pct = total > 0 ? `${String(Math.round(frac * 100)).padStart(3)}%` : '    ';
    const size = total > 0 ? `${mb(got)}/${mb(total)} MB` : `${mb(got)} MB`;
    process.stdout.write(`\r${label} [${'#'.repeat(fill)}${'-'.repeat(width - fill)}] ${pct} ${size} ${rate.toFixed(1)} MB/s${eta}  `);
    if (finished) { process.stdout.write('\n'); done = true; }
  };
}
