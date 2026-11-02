# vendor/ — Bundled third-party binaries

## 7zr.exe (Windows)

Standalone console version of 7-Zip, used by the in-app updater to extract
split `.7z` volumes downloaded from the Gitee mirror.

- Source: https://www.7-zip.org/a/7zr.exe (official, unmodified)
- Copyright (c) Igor Pavlov
- License: BSD 3-Clause (the 7zr.exe console build carries the unmodified
  BSD licence; full text in the official source package "License.txt")
- Distribution: redistribution of official unmodified binaries is permitted
  under that licence; source at https://www.7-zip.org/download.html

The updater never writes anything but archive output with this binary, and
always spawns it with explicit arguments (no shell).
