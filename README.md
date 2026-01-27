# C/AL to AL Converter

Convert **Microsoft Dynamics NAV (C/AL)** objects to **Business Central AL** directly from VS Code.

## How it works

- 🖱️ Right-click on the file or folder from VS Code Explorer.
- 📂 Automatically generates AL `./src` folder with al objects converted.
- 📋 Displays conversion logs and errors inside VS Code.


## Settings:

- Open **Settings** (`Ctrl + ,`)
- Search for **CAL to AL Converter**
---
| Setting                            | Description                                                           |
| ---------------------------------- | --------------------------------------------------------------------- |
| `calToAl.type`                     | Convert only a specific object type (`table`, `page`, `report`, etc.) |
| `calToAl.extensionStartId`         | Starting object ID for the generated AL extension                     |
| `calToAl.tableDataOnly`            | Convert only table data.                                              |