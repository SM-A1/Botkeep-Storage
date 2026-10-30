"""
Botkeep launcher for the File Vault bot (Node.js 20+).

Botkeep starts `Main.py`; this file installs the npm dependencies once and then
replaces itself with `node src/index.js`. It only works if the Botkeep container
has Node.js 20+ and npm available - otherwise it stops with a clear message.
"""
import os
import re
import shutil
import subprocess
import sys

ROOT = os.path.dirname(os.path.abspath(__file__))
os.chdir(ROOT)

node = shutil.which("node")
npm = shutil.which("npm")
if not node or not npm:
    sys.exit("ERROR: Node.js 20+ and npm are required on this host (not found). "
             "Choose a Node.js runtime/image in Botkeep or use a host that provides Node.js.")

version = subprocess.run([node, "--version"], capture_output=True, text=True).stdout.strip()
major = int(re.match(r"v(\d+)", version).group(1)) if re.match(r"v\d+", version) else 0
if major < 20:
    sys.exit(f"ERROR: Node.js 20+ is required, found {version or 'unknown'}.")

if not os.path.isdir(os.path.join(ROOT, "node_modules")):
    print("Installing dependencies (first start)...", flush=True)
    cmd = [npm, "ci", "--omit=dev"] if os.path.exists("package-lock.json") else [npm, "install", "--omit=dev"]
    if subprocess.call(cmd) != 0:
        sys.exit("ERROR: npm install failed.")

os.environ.setdefault("NODE_ENV", "production")
os.execv(node, [node, os.path.join("src", "index.js")])
