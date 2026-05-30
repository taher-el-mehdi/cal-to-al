[![Version](https://vsmarketplacebadges.dev/version/TAHERElMehdi.cal-to-al.svg?&colorB=orange)](https://marketplace.visualstudio.com/items?itemName=TAHERElMehdi.cal-to-al) [![Report Bug](https://img.shields.io/badge/Report%20Bug-red?logo=github)](https://github.com/taher-el-mehdi/cal-to-al/issues/new)
![GitHub Discussions](https://img.shields.io/github/discussions/taher-el-mehdi/cal-to-al)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

[![Installs](https://vsmarketplacebadges.dev/installs/TAHERElMehdi.cal-to-al.svg)](https://marketplace.visualstudio.com/items?itemName=TAHERElMehdi.cal-to-al) [![Downloads](https://vsmarketplacebadges.dev/downloads/TAHERElMehdi.cal-to-al.svg)](https://marketplace.visualstudio.com/items?itemName=TAHERElMehdi.cal-to-al) [![Rating Short](https://vsmarketplacebadges.dev/rating-short/TAHERElMehdi.cal-to-al.svg)](https://marketplace.visualstudio.com/items?itemName=TAHERElMehdi.cal-to-al) [![Rating Star](https://vsmarketplacebadges.dev/rating-star/TAHERElMehdi.cal-to-al.svg)](https://marketplace.visualstudio.com/items?itemName=TAHERElMehdi.cal-to-al)

# C/AL to AL Converter for Visual Studio Code

The [C/AL to AL Converter](https://marketplace.visualstudio.com/items?itemName=TAHERElMehdi.cal-to-al) is a migration tool for converting Microsoft Dynamics NAV (C/AL) `.txt` files to Business Central `.al` objects directly from VS Code.

## Command:
- `Convert C/AL to AL` — available in the VS Code Explorer context menu for `.txt` files and folders.

## Settings
Open **Settings** (`Ctrl + ,`) and search for **CAL to AL Converter**.

| Setting | Default | Description |
| --- | --- | --- |
| `calToAl.type` | _(all)_ | Convert only a specific object type: `Codeunit`, `Table`, `Page`, `Report`, `Query`, or `XmlPort`. Leave empty to convert all types. |
| `calToAl.extensionStartId` | `70000000` | Starting numeric ID for extension objects, incremented by 1 for each object. |
| `calToAl.objectFileNamePattern` | `{type}-{id}.{name}` | File name pattern for AL object files. Placeholders: `{name}`, `{type}`, `{id}`. |
| `calToAl.extensionObjectFileNamePattern` | `{type}-{id}.{name}` | File name pattern for AL extension object files. Placeholders: `{name}`, `{type}`, `{id}`, `{targetName}`, `{targetId}`. |
| `calToAl.tableDataOnly` | `false` | For table objects, convert only table and field definitions — methods and trigger code are excluded. |
| `calToAl.injectDotNetAddIns` | `false` | Inject standard .NET add-in definitions into the output `.NET` package. |
| `calToAl.dotNetAddInsPackage` | _(empty)_ | Path to an AL file containing custom .NET type declarations to include in the package. |
| `calToAl.dotNetTypePrefix` | _(empty)_ | Prefix applied to all .NET type aliases created during conversion. |
| `calToAl.addLegacyTranslationInfo` | `false` | Add legacy translation mapping info to translation files to help migrate existing translated resources. |
| `calToAl.runtime` | _(latest)_ | Target AL runtime version, e.g. `15.0`. Leave empty to use the latest supported runtime. |
| `calToAl.dataClassificationDefaulting` | _(empty)_ | Default `DataClassification` value applied to all table fields that don't have it set. |
| `calToAl.verboseLogging` | `true` | Capture full conversion output — stdout, warnings, and errors — to the log file. Also implicitly enables `stacktrace`. |

## Acknowledgements
*This extension is a VS Code wrapper around the **txt2al** tool developed by Microsoft, which handles the underlying C/AL to AL conversion. For full documentation on supported flags and behaviour, see the official Microsoft reference:
[txt2al Conversion Tool — Microsoft Learn](https://learn.microsoft.com/en-us/dynamics365/business-central/dev-itpro/developer/devenv-txt2al-tool)*