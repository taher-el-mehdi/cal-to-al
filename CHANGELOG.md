# Changelog

All notable changes to this project will be documented in this file.

---

## [2.0.0] - 2026-05-20

### ✨ Added
- Centralises all shared configuration keys, directory names, and executable names to avoid magic strings across the codebase.
- enables detailed logging `_conversion.log` for capturing full conversion details to the log file.
- Improved output file naming convention: {type}-{id}.{name}.al and a dedicated src-cal-to-al output folder for cleaner workspace organisation.
 - Real-time conversion progress: VS Code notification now updates per-file as `txt2al` writes output, and logging was improved (stdout parsed line-by-line; conversion log path is configurable and only written when `calToAl.verboseLogging` is enabled).

---

## [1.1.0] - 2026-01-27

### ✨ Added
- Advanced configuration options to customize txt2al behavior
- Support for advanced txt2al parameter `--tableDataOnly` via VS Code settings (`calToAl.tableDataOnly`)

---

## [1.0.0] - 2026-01-26

### 🎉 Initial Release
- Convert C/AL objects to AL directly from VS Code
- Right-click support on files and folders
- Conversion logs inside VS Code
- Automatic generation of AL output folder