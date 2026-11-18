"""Check authored document links and immutable copied research inputs; no app tests."""
from pathlib import Path
from urllib.parse import unquote
import hashlib
import json
import re

root = Path(__file__).resolve().parents[1]
errors = []
authored = [root / 'README.md', root / 'DESIGN.md', *sorted((root / 'docs').glob('*.md'))]
for doc in authored:
    for target in re.findall(r'\]\(([^)]+)\)', doc.read_text()):
        if target.startswith(('https://', 'http://', '#', 'mailto:')):
            continue
        path = target.split('#', 1)[0]
        if path and not (doc.parent / unquote(path)).exists():
            errors.append(f'{doc.relative_to(root)}: missing link {target}')

manifest = json.loads((root / 'references/manifest.json').read_text())
for item in manifest['inputs']:
    path = root / item['snapshot']
    actual = hashlib.sha256(path.read_bytes()).hexdigest()
    if actual != item['sha256']:
        errors.append(f'Snapshot integrity mismatch: {item["snapshot"]}')
faq = root / 'references/dev3pack_faq_capture/faq_script_0thwfx_hqd4.js'
if hashlib.sha256(faq.read_bytes()).hexdigest() != manifest['faq_script_sha256']:
    errors.append('FAQ script integrity mismatch')

if errors:
    raise SystemExit('\n'.join(errors))
print(f'PASS: {len(authored)} authored documents linked; three research snapshots and FAQ script intact.')
print('Documentation validation only. No program, app or deployment is implemented or tested.')
