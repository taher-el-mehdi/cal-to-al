import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { spawn, ChildProcess } from 'child_process';
import {
  CONFIG_NAMESPACE,
  EXECUTABLE_NAMES,
  DIRECTORY_NAMES,
  CONVERSION_SETTINGS,
} from './constants';

/** Output channel for diagnostics visible to the user */
let outputChannel: vscode.OutputChannel;

/** Currently running conversion process (for cleanup on deactivate) */
let activeChild: ChildProcess | undefined;

/**
 * Get the root directory of the active workspace.
 * Note: only uses the first root in multi-root workspaces.
 */
function getWorkspaceRoot(): string | undefined {
  const folders = vscode.workspace.workspaceFolders;
  return folders && folders.length > 0 ? folders[0].uri.fsPath : undefined;
}

/**
 * Ensure a directory exists, creating it recursively if needed.
 */
function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

/**
 * Resolve the path to txt2al.exe.
 * Priority: configured path > workspace bin > parent directory bin > extension bin.
 */
function resolveTxt2AlPath(
  context: vscode.ExtensionContext,
  workspaceRoot: string
): string | undefined {
  const cfg = vscode.workspace.getConfiguration(CONFIG_NAMESPACE);
  const configured = (cfg.get<string>(CONVERSION_SETTINGS.txt2alPath) || '').trim();

  if (configured) {
    if (fs.existsSync(configured)) return configured;
    vscode.window.showWarningMessage(
      `Configured txt2al path not found: "${configured}". Falling back to default locations.`
    );
  }

  const wsPrimary = path.join(workspaceRoot, DIRECTORY_NAMES.WORKSPACE_BIN, EXECUTABLE_NAMES.TXT2AL_WINDOWS);
  if (fs.existsSync(wsPrimary)) return wsPrimary;

  const parent = path.dirname(workspaceRoot);
  if (parent && parent !== workspaceRoot) {
    const wsParent = path.join(parent, DIRECTORY_NAMES.WORKSPACE_BIN, EXECUTABLE_NAMES.TXT2AL_WINDOWS);
    if (fs.existsSync(wsParent)) return wsParent;
  }

  const extPath = path.join(context.extensionPath, DIRECTORY_NAMES.WORKSPACE_BIN, EXECUTABLE_NAMES.TXT2AL_WINDOWS);
  if (fs.existsSync(extPath)) return extPath;

  return undefined;
}

/**
 * Count AL files directly inside a directory (non-recursive).
 * Uses withFileTypes to avoid a stat() call per entry.
 */
async function countAlFiles(dir: string): Promise<number> {
  try {
    const entries = await fs.promises.readdir(dir, { withFileTypes: true });
    return entries.filter(
      e => e.isFile() && e.name.toLowerCase().endsWith('.al')
    ).length;
  } catch {
    return 0;
  }
}

/**
 * Write a conversion log file after each run.
 * Path priority: user-configured > default (<AL output folder>/conversion.log).
 * Appends to the file so repeated runs accumulate in one place.
 */
async function writeConversionLog(
  targetPath: string,
  stdout: string,
  stderr: string,
  exitCode: number
): Promise<void> {
  const cfg = vscode.workspace.getConfiguration(CONFIG_NAMESPACE);
  const configured = (cfg.get<string>(CONVERSION_SETTINGS.logFilePath) || '').trim();
  const logPath = configured || path.join(targetPath, 'conversion.log');

  const timestamp = (label: string) => `[${new Date().toISOString()}] ${label}`;
  const lines: string[] = [];

  lines.push(timestamp('=== Conversion started ==='));

  if (stdout.trim()) {
    stdout.trim().split(/\r?\n/).forEach(line => lines.push(timestamp(line)));
  }

  if (stderr.trim()) {
    stderr.trim().split(/\r?\n/).forEach(line => lines.push(timestamp(`[WARN/ERR] ${line}`)));
  }

  lines.push(timestamp(`Process exited with code: ${exitCode}`));
  lines.push('');

  try {
    await fs.promises.appendFile(logPath, lines.join('\n'), 'utf8');
    outputChannel.appendLine(`[INFO] Log written to: ${logPath}`);
  } catch (err) {
    outputChannel.appendLine(`[WARN] Could not write log file: ${err}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Object Reference Resolver
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Load the object-name mapping from the JSON file configured.
 *
 * Expected JSON format
 * {
 *   "Record \"3\"":   "Record \"Payment Terms\"",
 *   "Record \"4\"":   "Record \"Currency\"",
 *   "Query \"7300\"": "Query \"Lot Numbers by Bin\""
 * }
 *
 * Path priority: calToAl.objectMappingPath setting > <workspaceRoot>/object-mapping.json
 *
 * Returns an empty map (not an error) when the file does not exist so the
 * resolver step is silently skipped on workspaces that don't need it.
 */
async function loadObjectMapping(workspaceRoot: string): Promise<Map<string, string>> {
  const cfg = vscode.workspace.getConfiguration(CONFIG_NAMESPACE);
  const configured = (cfg.get<string>(CONVERSION_SETTINGS.objectMappingPath) || '').trim();
  const mappingPath = configured || path.join(workspaceRoot, DIRECTORY_NAMES.OBJECT_MAPPING_FILE);

  if (!fs.existsSync(mappingPath)) {
    return new Map();
  }

  try {
    const raw = await fs.promises.readFile(mappingPath, 'utf8');
    const parsed: unknown = JSON.parse(raw);

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      outputChannel.appendLine(`[WARN] object-mapping.json must be a flat key/value object. Resolver skipped.`);
      return new Map();
    }

    const map = new Map<string, string>();
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === 'string') {
        map.set(key, value);
      } else {
        outputChannel.appendLine(`[WARN] Skipping non-string mapping value for key: "${key}"`);
      }
    }

    outputChannel.appendLine(`[INFO] Loaded ${map.size} object name mapping(s) from: ${mappingPath}`);
    return map;
  } catch (err) {
    outputChannel.appendLine(`[WARN] Could not parse object-mapping.json: ${err}. Resolver skipped.`);
    return new Map();
  }
}

/**
 * Apply the object-name mapping to all .al files in the target directory.
 *
 * For each file:
 *  - Read the content
 *  - Replace every mapped numeric reference with its readable name
 *  - Write back in place only if at least one replacement was made
 *  - Log each replacement to the output channel and conversion.log
 *
 * Returns a summary string logged at the end of the step.
 */
async function resolveObjectReferences(
  targetPath: string,
  mapping: Map<string, string>,
  logPath: string
): Promise<void> {
  if (mapping.size === 0) return;

  // Build a single regex that matches any of the mapped keys (keys are
  // treated as plain strings, not regex patterns, to match the PowerShell
  // behaviour of Regex.Escape).
  const escapedKeys = Array.from(mapping.keys()).map(k =>
    k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  );
  const pattern = new RegExp(escapedKeys.join('|'), 'g');

  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(targetPath, { withFileTypes: true });
  } catch {
    outputChannel.appendLine(`[WARN] Could not read output directory for resolver: ${targetPath}`);
    return;
  }

  const alFiles = entries.filter(e => e.isFile() && e.name.toLowerCase().endsWith('.al'));

  if (alFiles.length === 0) return;

  const timestamp = (label: string) => `[${new Date().toISOString()}] ${label}`;
  const logLines: string[] = [timestamp('=== Object reference resolver ===')];

  let totalFiles = 0;
  let totalReplacements = 0;

  for (const entry of alFiles) {
    const filePath = path.join(targetPath, entry.name);

    let content: string;
    try {
      content = await fs.promises.readFile(filePath, 'utf8');
    } catch (err) {
      const msg = `[WARN] Could not read ${entry.name}: ${err}`;
      outputChannel.appendLine(msg);
      logLines.push(timestamp(msg));
      continue;
    }

    let fileReplacements = 0;
    const fileLog: string[] = [];

    const updated = content.replace(pattern, (match) => {
      const replacement = mapping.get(match);
      if (replacement === undefined) return match; // safety — should never happen
      fileReplacements++;
      fileLog.push(timestamp(`  ${entry.name}: "${match}" → "${replacement}"`));
      return replacement;
    });

    if (fileReplacements === 0) continue;

    try {
      await fs.promises.writeFile(filePath, updated, 'utf8');
      totalFiles++;
      totalReplacements += fileReplacements;

      const summary = `[RESOLVER] ${entry.name}: ${fileReplacements} replacement(s)`;
      outputChannel.appendLine(summary);
      logLines.push(timestamp(summary));
      fileLog.forEach(l => {
        outputChannel.appendLine(l);
        logLines.push(l);
      });
    } catch (err) {
      const msg = `[WARN] Could not write ${entry.name}: ${err}`;
      outputChannel.appendLine(msg);
      logLines.push(timestamp(msg));
    }
  }

  const summary = `[RESOLVER] Done — ${totalReplacements} replacement(s) across ${totalFiles} file(s).`;
  outputChannel.appendLine(summary);
  logLines.push(timestamp(summary));
  logLines.push('');

  // Append resolver results to the same conversion.log
  try {
    await fs.promises.appendFile(logPath, logLines.join('\n'), 'utf8');
  } catch {
    // Non-fatal — resolver already ran successfully, just couldn't log it
  }
}

// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build command-line arguments for txt2al from VS Code settings.
 */
function buildArgs(source: string, target: string): string[] {
  const cfg = vscode.workspace.getConfiguration(CONFIG_NAMESPACE);
  const args: string[] = ['--source', source, '--target', target];

  // verboseLogging implicitly forces --stacktrace
  const verbose = cfg.get<boolean>(CONVERSION_SETTINGS.verboseLogging);
  if (verbose) args.push('--stacktrace');

  // Always enabled — multithreading significantly improves performance
  args.push('--multithreaded');

  // Always enabled — ensures consistent output and avoids naming conflicts
  args.push('--rename');

  // Always enabled — ensures consistent AL code style
  args.push('--format');

  if (cfg.get<boolean>(CONVERSION_SETTINGS.injectDotNetAddIns)) args.push('--injectDotNetAddIns');
  if (cfg.get<boolean>(CONVERSION_SETTINGS.addLegacyTranslationInfo)) args.push('--addLegacyTranslationInfo');
  if (cfg.get<boolean>(CONVERSION_SETTINGS.tableDataOnly)) args.push('--tableDataOnly');

  const type = (cfg.get<string>(CONVERSION_SETTINGS.type) || '').trim();
  if (type) args.push('--type', type);

  const startId = cfg.get<number>(CONVERSION_SETTINGS.extensionStartId);
  if (startId != null && startId > 0) args.push('--extensionStartId', String(startId));

  const addInsPkg = (cfg.get<string>(CONVERSION_SETTINGS.dotNetAddInsPackage) || '').trim();
  if (addInsPkg) args.push('--dotNetAddInsPackage', addInsPkg);

  const typePrefix = (cfg.get<string>(CONVERSION_SETTINGS.dotNetTypePrefix) || '').trim();
  if (typePrefix) args.push('--dotNetTypePrefix', typePrefix);

  const runtime = (cfg.get<string>(CONVERSION_SETTINGS.runtime) || '').trim();
  if (runtime) args.push('--runtime', runtime);

  const objPattern = (cfg.get<string>(CONVERSION_SETTINGS.objectFileNamePattern) || '').trim();
  if (objPattern) args.push('--objectFileNamePattern', objPattern);

  const extObjPattern = (cfg.get<string>(CONVERSION_SETTINGS.extensionObjectFileNamePattern) || '').trim();
  if (extObjPattern) args.push('--extensionObjectFileNamePattern', extObjPattern);

  const dataClass = (cfg.get<string>(CONVERSION_SETTINGS.dataClassificationDefaulting) || '').trim();
  if (dataClass) args.push('--dataClassificationDefaulting', dataClass);

  return args;
}

/**
 * Execute the conversion from C/AL to AL.
 */
async function runConversion(context: vscode.ExtensionContext, resource: vscode.Uri): Promise<void> {
  const workspaceRoot = getWorkspaceRoot();
  if (!workspaceRoot) {
    vscode.window.showErrorMessage('No workspace is open.');
    return;
  }

  let sourcePath = resource.fsPath;
  const stat = await fs.promises.stat(sourcePath).catch(() => undefined);
  if (!stat) {
    vscode.window.showErrorMessage('Selected path is invalid.');
    return;
  }

  // txt2al requires a directory as input, not a single file.
  let tempSourceDir: string | undefined;
  if (stat.isFile()) {
    tempSourceDir = path.join(workspaceRoot, DIRECTORY_NAMES.TEMP_CONVERSION);
    ensureDir(tempSourceDir);
    const destFile = path.join(tempSourceDir, path.basename(sourcePath));
    await fs.promises.copyFile(sourcePath, destFile);
    sourcePath = tempSourceDir;
  }

  const targetPath = path.join(workspaceRoot, DIRECTORY_NAMES.AL_OUTPUT);
  ensureDir(targetPath);

  const exePath = resolveTxt2AlPath(context, workspaceRoot);
  if (!exePath) {
    vscode.window.showErrorMessage(
      'txt2al.exe not found. Set calToAl.txt2alPath or place Txt2Al.exe in bin.'
    );
    return;
  }

  // Resolve the log path once so both writeConversionLog and
  // resolveObjectReferences append to the same file.
  const cfg = vscode.workspace.getConfiguration(CONFIG_NAMESPACE);
  const configuredLog = (cfg.get<string>(CONVERSION_SETTINGS.logFilePath) || '').trim();
  const logPath = configuredLog || path.join(targetPath, 'conversion.log');

  // Load the object mapping before starting — if the file is missing or
  // empty the resolver step is silently skipped after conversion.
  const objectMapping = await loadObjectMapping(workspaceRoot);

  const beforeCount = await countAlFiles(targetPath);

  try {
    await vscode.window.withProgress({
      location: vscode.ProgressLocation.Notification,
      title: 'Converting C/AL to AL...',
      cancellable: true,
    }, async () => {
      const args = buildArgs(sourcePath, targetPath);
      const child = spawn(exePath, args, {
        cwd: path.dirname(exePath),
        windowsHide: true,
        shell: false,
      });

      activeChild = child;

      let stdoutBuf = '';
      let stderrBuf = '';

      child.stdout.on('data', (d: Buffer) => { stdoutBuf += d.toString(); });
      child.stderr.on('data', (d: Buffer) => { stderrBuf += d.toString(); });

      const exitCode: number = await new Promise(resolve => {
        child.on('close', resolve);
        child.on('error', () => resolve(-1));
      });

      activeChild = undefined;

      // Always clean up the temp directory
      if (tempSourceDir) {
        await fs.promises.rm(tempSourceDir, { recursive: true, force: true }).catch(() => {});
      }

      // Write conversion log when verbose logging is enabled
      const verbose = cfg.get<boolean>(CONVERSION_SETTINGS.verboseLogging);
      if (verbose) {
        await writeConversionLog(targetPath, stdoutBuf, stderrBuf, exitCode);
      }

      const afterCount = await countAlFiles(targetPath);
      const delta = Math.max(0, afterCount - beforeCount);

      if (exitCode !== 0) {
        const errMsg = stderrBuf.trim() || 'Conversion failed with no output.';
        outputChannel.appendLine(`[ERROR] txt2al exited with code ${exitCode}`);
        outputChannel.appendLine(errMsg);
        outputChannel.show(true);

        if (delta === 0) {
          vscode.window.showErrorMessage(
            `Conversion failed and 0 objects were converted. See conversion.log inside '${DIRECTORY_NAMES.AL_OUTPUT}' for details.`
          );
        } else {
          vscode.window.showErrorMessage(
            errMsg.length > 800 ? errMsg.slice(0, 800) + '…' : errMsg
          );
        }
        return;
      }

      if (stdoutBuf.trim()) {
        outputChannel.appendLine('[INFO] txt2al output:');
        outputChannel.appendLine(stdoutBuf.trim());
      }

      // ── Post-processing: resolve numeric object references ──────────────
      // Runs automatically after a successful conversion. Silently skipped
      // when no mapping file is found in the workspace.
      if (objectMapping.size > 0) {
        await resolveObjectReferences(targetPath, objectMapping, logPath);
      }
      // ────────────────────────────────────────────────────────────────────

      vscode.window.showInformationMessage(
        `Conversion complete: ${delta} new object(s) converted to AL in ${DIRECTORY_NAMES.AL_OUTPUT}.`
      );
    });
  } catch (err) {
    outputChannel.appendLine(`[EXCEPTION] Conversion threw: ${String(err)}`);
    outputChannel.show(true);

    const afterCount = await countAlFiles(targetPath).catch(() => 0);
    const delta = Math.max(0, afterCount - beforeCount);

    if (delta === 0) {
      vscode.window.showErrorMessage(
        `Conversion crashed and 0 objects were converted. See conversion.log inside '${DIRECTORY_NAMES.AL_OUTPUT}' for details.`
      );
    } else {
      vscode.window.showErrorMessage(`Conversion crashed: ${String(err)}`);
    }
  }
}

/**
 * Extension activation.
 */
export function activate(context: vscode.ExtensionContext): void {
  outputChannel = vscode.window.createOutputChannel('C/AL to AL');

  const disposable = vscode.commands.registerCommand(
    'calToAl.convertSelection',
    async (resource?: vscode.Uri) => {
      if (!resource) {
        vscode.window.showErrorMessage(
          'No file or folder selected. Right-click a file/folder in Explorer and click "Convert C/AL to AL".'
        );
        return;
      }
      await runConversion(context, resource);
    }
  );

  context.subscriptions.push(disposable, outputChannel);
}

/**
 * Extension deactivation.
 * Kills any in-flight conversion process. OutputChannel is disposed via
 * context.subscriptions.
 */
export function deactivate(): void {
  if (activeChild) {
    activeChild.kill();
    activeChild = undefined;
  }
}