#!/usr/bin/env python3
"""kula — build passport/mac.sh, the Mac's passport script, from its three sources.

`curl … | bash` runs one file, so the C benchmark and the qr encoder travel inside it.
They are kept as readable files and joined here:

  passport/mac.template.sh   the bash and the JavaScript (@@BENCH_C@@, @@QR_JS@@ and the
                             relay's @@RELAY_URL@@ / @@RELAY_KEY@@ are filled in)
  passport/mac-bench.c       the native test: read and copy bandwidth, compute
  passport/qr.js             the site's qr encoder (the web page draws with it too)
  config.js                  the relay: kula's live server and its public key

    python3 tools-passport-mac.py           build passport/mac.sh
    python3 tools-passport-mac.py --check   fail when mac.sh is not what the sources make

Exit 0 clean, exit 1 with what is wrong.
"""
import pathlib, re, sys

ROOT = pathlib.Path(__file__).resolve().parent
P = ROOT / "passport"
check_only = "--check" in sys.argv

template = (P / "mac.template.sh").read_text(encoding="utf-8")
bench = (P / "mac-bench.c").read_text(encoding="utf-8").rstrip("\n")
qr = (P / "qr.js").read_text(encoding="utf-8").rstrip("\n")
config = (ROOT / "config.js").read_text(encoding="utf-8")
url = re.search(r'url:\s*"([^"]+)"', config)
key = re.search(r'anonKey:\s*"([^"]+)"', config)
if not url or not key:
    sys.exit("config.js has no url / anonKey: the script would have nowhere to send")
for marker in ("MAC_BENCH_C", "MAC_PASSPORT_JS"):
    if marker in bench or marker in qr:
        sys.exit(f"a source contains the heredoc marker {marker}")

out = (template.replace("@@BENCH_C@@", bench).replace("@@QR_JS@@", qr)
       .replace("@@RELAY_URL@@", url.group(1)).replace("@@RELAY_KEY@@", key.group(1)))
if "@@" in out:
    sys.exit("a @@marker@@ was left unfilled")

target = P / "mac.sh"
if check_only:
    if not target.exists() or target.read_text(encoding="utf-8") != out:
        sys.exit("passport/mac.sh is stale: run python3 tools-passport-mac.py")
    print("passport/mac.sh matches its sources")
else:
    target.write_text(out, encoding="utf-8")
    target.chmod(0o755)
    print(f"passport/mac.sh  {len(out):,} bytes")
