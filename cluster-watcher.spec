# -*- mode: python ; coding: utf-8 -*-
"""PyInstaller recipe for a console-enabled, single-file Cluster Watcher."""

from pathlib import Path
import sys


project_root = Path(SPECPATH or ".").resolve()
sys.path.insert(0, str(project_root))

from clusterwatcher.packaging import standalone_artifact_name


artifact_name = standalone_artifact_name()

analysis = Analysis(
    [str(project_root / "cluster_watcher.py")],
    pathex=[str(project_root)],
    binaries=[],
    # The GPU catalog is personal configuration read beside clusters.toml.
    datas=[],
    hiddenimports=[],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[],
    noarchive=False,
    optimize=0,
)
python_archive = PYZ(analysis.pure)

executable = EXE(
    python_archive,
    analysis.scripts,
    analysis.binaries,
    analysis.datas,
    [],
    name=artifact_name,
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    upx_exclude=[],
    runtime_tmpdir=None,
    console=True,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)
