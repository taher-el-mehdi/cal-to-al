# Changelog

All notable changes to this project will be documented in this file.

---

## [2.0.0] - 2026-05-20

### ✨ Added
- Add all paramters of txt2al in Settings of the extension.
- Enables detailed logging `_conversion.log` for capturing full conversion details to the log file.
- Improved output file naming convention: {type}-{id}.{name}.al and a dedicated src-cal-to-al output folder for cleaner workspace organisation.
- Improve Real-time conversion progress with naming of file that are converting.
- Resolve the issue of  variable declarations are generated using numeric object references instead of readable object names.

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