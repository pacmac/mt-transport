---
task: fw-binary-archive
status: IMPLEMENTED + VERIFIED 2026-07-24. pio run prints `archive_fw: firmware/archive/<ver>.zip`; the archive is BYTE-IDENTICAL to firmware.zip (flashable); a 2nd build adds 2-260724-5 keeping -4; firmware/archive/ is git-ignored.
source_hash:
  pac-garage-alarm/tools/archive_fw.py: a1770bd4d26a8806e3c5498878f2c4c01e9582d06b76036d916e659841b2c54c
  pac-garage-alarm/platformio.ini: 2f0db97012a55f0844a673bb336c44e2943902a8277ec2e7e47504877b05ec26
  pac-garage-alarm/.gitignore: 22f81933743dbe66e187eedbaad853fefe5981e550faeba72328df359a33c2a9

project: pac-garage-alarm
scope:
  - mt-transport/specs/fw-binary-archive.md          # this spec (task workspace)
  - pac-garage-alarm/tools/archive_fw.py             # NEW — post-build: firmware.zip -> firmware/archive/<FW_VERSION>.zip
  - pac-garage-alarm/platformio.ini                  # add post:tools/archive_fw.py to rak4631_camuart extra_scripts
  - pac-garage-alarm/.gitignore                      # ignore firmware/archive/ (build artifacts, not committed)
# NOT changing:
#   tools/bump_fw.py — unchanged; archive_fw reads the FW_VERSION it wrote.
#   src/build_version.h — the version source (read-only here).
---

# Spec: fw-binary-archive — keep a flashable copy of every built version

## Why
`pio run` builds to a FIXED path (`.pio/build/<env>/firmware.zip`), overwritten each build,
so there is no way to re-flash a prior version without `git checkout <commit> -> rebuild`.
Archiving each build's zip by its stamped FW_VERSION makes any version one-command flashable
(e.g. A/B a suspected regression) with zero git churn. Peter: daily-build phase is short, so
no prune needed; archive every build. Local artifacts — gitignored.

## tools/archive_fw.py (NEW) — mirrors bump_fw.py's SCons style
```python
# Post-build: archive the flashable firmware.zip by FW_VERSION (the value bump_fw.py stamped
# into build_version.h) so any built version can be re-flashed directly. Local, gitignored.
import os, re, shutil
Import("env")  # noqa: F821

PROJ = env.subst("$PROJECT_DIR")  # noqa: F821
HEADER = os.path.join(PROJ, "src", "build_version.h")

def _version():
    try:
        with open(HEADER) as f:
            m = re.search(r'FW_VERSION_STR\s+"([^"]+)"', f.read())
            return m.group(1) if m else None
    except OSError:
        return None

def _archive(target, source, env):  # noqa: F821
    ver = _version()
    if not ver:
        print("archive_fw: no FW_VERSION — skipped"); return
    src = str(target[0])                                   # the built firmware.zip
    dst_dir = os.path.join(PROJ, "firmware", "archive")
    os.makedirs(dst_dir, exist_ok=True)
    dst = os.path.join(dst_dir, "%s.zip" % ver)
    shutil.copyfile(src, dst)
    print("archive_fw: firmware/archive/%s.zip" % ver)

env.AddPostAction("$BUILD_DIR/firmware.zip", _archive)  # noqa: F821
```

## platformio.ini — add the post hook (both rak envs that build a DFU zip)
```diff
-extra_scripts = pre:tools/bump_fw.py
+extra_scripts =
+    pre:tools/bump_fw.py
+    post:tools/archive_fw.py
```
(Apply to the env(s) that produce firmware.zip — at minimum `rak4631_camuart`; add to
`rak4631` too if it also builds/flashes.)

## .gitignore
```
firmware/archive/
```

## Verify (Observe)
1. **Build:** `pio run -e rak4631_camuart` → console prints `archive_fw: firmware/archive/<ver>.zip`.
2. **Static:** `ls firmware/archive/` shows `<FW_VERSION>.zip` matching build_version.h, and its
   bytes equal `.pio/build/rak4631_camuart/firmware.zip` (same flashable artifact).
3. A second build stamps a new version → a NEW archive entry appears; the prior stays.
4. `git status` shows firmware/archive/ ignored (not staged).
