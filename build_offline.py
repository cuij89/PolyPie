#!/usr/bin/env python3
"""Build the offline copy of PolyPie.

The site loads its five libraries from CDNs. This writes a copy into dist/
with those libraries downloaded into dist/vendor/ and every reference pointed
at them, so the folder runs from a double-clicked index.html with no network.

There is deliberately no second copy of the source: the page, the script and
the stylesheet are taken from this directory, and only the library references
are rewritten. Run it again after any change.

    python build_offline.py [--zip]
"""
import argparse, pathlib, re, shutil, sys, urllib.request, zipfile

ROOT = pathlib.Path(__file__).resolve().parent
DIST = ROOT / 'dist'
SOURCES = ('index.html', 'app.js', 'style.css')
# app.js loads this one lazily, so it is not in index.html
LAZY = 'https://cdn.jsdelivr.net/npm/pptxgenjs@3.12.0/dist/pptxgen.bundle.js'


def local_name(url):
    return url.rsplit('/', 1)[-1]


def fetch(url, dest):
    if dest.exists():
        print(f'  have {dest.name}')
        return
    print(f'  get  {dest.name}')
    with urllib.request.urlopen(url, timeout=60) as r:
        dest.write_bytes(r.read())


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--zip', action='store_true', help='also write PolyPie_offline.zip')
    args = ap.parse_args()

    html = (ROOT / 'index.html').read_text(encoding='utf-8')
    urls = re.findall(r'<script src="(https://[^"]+)"></script>', html)
    if not urls:
        sys.exit('No CDN script tags found in index.html.')
    urls.append(LAZY)

    vendor = DIST / 'vendor'
    vendor.mkdir(parents=True, exist_ok=True)
    print(f'vendor ({len(urls)} libraries)')
    for u in urls:
        fetch(u, vendor / local_name(u))

    for name in SOURCES:
        text = (ROOT / name).read_text(encoding='utf-8')
        for u in urls:
            text = text.replace(u, f'vendor/{local_name(u)}')
        text = re.sub(r'\?v=\d+', '', text)   # no cache busting on a local file
        (DIST / name).write_text(text, encoding='utf-8', newline='')
        print(f'wrote dist/{name}')

    (DIST / 'README.txt').write_text(
        'PolyPie - offline copy\n\n'
        'Keep this folder together, then open index.html in Chrome or Edge.\n'
        'app.js, style.css and the vendor folder must stay beside it.\n'
        'Click an Example button first to confirm the page works, then load your own file.\n\n'
        'Nothing is uploaded; everything runs in the browser.\n\n'
        'Bundled libraries keep their own licences:\n'
        + ''.join(f'  {local_name(u)}  <- {u}\n' for u in urls),
        encoding='utf-8', newline='')
    print('wrote dist/README.txt')

    if args.zip:
        out = ROOT / 'PolyPie_offline.zip'
        with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED) as z:
            for f in sorted(DIST.rglob('*')):
                if f.is_file():
                    z.write(f, pathlib.Path('PolyPie') / f.relative_to(DIST))
        print(f'wrote {out.name} ({out.stat().st_size // 1024} KB)')


if __name__ == '__main__':
    main()
