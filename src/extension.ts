import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import { spawn, ChildProcess } from 'child_process';
import {
  CONFIG_NAMESPACE,
  EXECUTABLE_NAMES,
  DIRECTORY_NAMES,
  FILE_NAMES,
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

// Set to true only while developing the extension; keep false for production installs.
const DEVELOPMENT_MODE = false;

function debugLog(message: string): void {
  if (!DEVELOPMENT_MODE) return;
  console.log(`[calToAl DEBUG] ${message}`);
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
 * Resolve the path to object-mapping.json.
 * Priority: configured path > workspace bin > parent directory bin > extension bin > workspace root.
 */
function resolveObjectMappingPath(
  context: vscode.ExtensionContext,
  workspaceRoot: string
): string | undefined {
  const cfg = vscode.workspace.getConfiguration(CONFIG_NAMESPACE);
  const configured = (cfg.get<string>(CONVERSION_SETTINGS.objectMappingPath) || '').trim();

  if (configured) {
    if (fs.existsSync(configured)) return configured;
    vscode.window.showWarningMessage(
      `Configured object-mapping path not found: "${configured}". Falling back to default locations.`
    );
  }

  const wsPrimary = path.join(workspaceRoot, DIRECTORY_NAMES.WORKSPACE_BIN, DIRECTORY_NAMES.OBJECT_MAPPING_FILE);
  if (fs.existsSync(wsPrimary)) return wsPrimary;

  const parent = path.dirname(workspaceRoot);
  if (parent && parent !== workspaceRoot) {
    const wsParent = path.join(parent, DIRECTORY_NAMES.WORKSPACE_BIN, DIRECTORY_NAMES.OBJECT_MAPPING_FILE);
    if (fs.existsSync(wsParent)) return wsParent;
  }

  const extPath = path.join(context.extensionPath, DIRECTORY_NAMES.WORKSPACE_BIN, DIRECTORY_NAMES.OBJECT_MAPPING_FILE);
  if (fs.existsSync(extPath)) return extPath;

  const rootPath = path.join(workspaceRoot, DIRECTORY_NAMES.OBJECT_MAPPING_FILE);
  if (fs.existsSync(rootPath)) return rootPath;

  return undefined;
}

/**
 * Write a conversion log file after each run.
 * Path priority: user-configured > default (<AL output folder>/_conversion.log).
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
  const logPath = configured || path.join(targetPath, FILE_NAMES.CONVERSION_LOG);

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
  lines.push(timestamp('=== Conversion ended ==='));
  lines.push('');

  try {
    await fs.promises.appendFile(logPath, lines.join('\n'), 'utf8');
    debugLog(`[INFO] Log written to: ${logPath}`);
  } catch (err) {
    debugLog(`[WARN] Could not write log file: ${err}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Object Reference Resolver
// ─────────────────────────────────────────────────────────────────────────────

async function loadObjectMapping(
  context: vscode.ExtensionContext,
  workspaceRoot: string
): Promise<Map<string, string>> {
  const mappingPath = resolveObjectMappingPath(context, workspaceRoot);
  if (!mappingPath) {
    debugLog('object-mapping.json not found in configured or default locations.');
    return new Map();
  }

  debugLog(`object-mapping.json resolved to: ${mappingPath}`);

  try {
    const raw = await fs.promises.readFile(mappingPath, 'utf8');
    const parsed: unknown = JSON.parse(raw);

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      debugLog(`[WARN] object-mapping.json must be a flat key/value object. Resolver skipped.`);
      return new Map();
    }

    const map = new Map<string, string>();
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === 'string') {
        map.set(key, value);
      } else {
        debugLog(`[WARN] Skipping non-string mapping value for key: "${key}"`);
      }
    }

    debugLog(`[INFO] Loaded ${map.size} object name mapping(s) from: ${mappingPath}`);
    return map;
  } catch (err) {
    debugLog(`[WARN] Could not parse object-mapping.json: ${err}. Resolver skipped.`);
    return new Map();
  }
}
async function resolveObjectReferences(
  targetPath: string,
  mapping: Map<string, string>,
  logPath: string
): Promise<void> {
  if (mapping.size === 0) return;

  const escapedKeys = Array.from(mapping.keys()).map(k =>
    k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  );

  // Case-insensitive flag added — handles any casing variation from txt2al
  const pattern = new RegExp(escapedKeys.join('|'), 'gi');

  // Diagnostic pattern: finds any remaining numeric object references
  // that look like Record/Page/Query/etc. "NNN" after the mapping runs.
  // These are logged so you can add them to object-mapping.json.
  const unmappedPattern = /\b(Record|Page|Query|Codeunit|Report|XmlPort|Enum|Table)\s+"(\d+)"/gi;

  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(targetPath, { withFileTypes: true });
  } catch {
    debugLog(`[WARN] Could not read output directory for resolver: ${targetPath}`);
    return;
  }

  const alFiles = entries.filter(e => e.isFile() && e.name.toLowerCase().endsWith('.al'));
  if (alFiles.length === 0) return;

  const timestamp = (label: string) => `[${new Date().toISOString()}] ${label}`;
  const logLines: string[] = [timestamp('=== Object reference resolver ===')];

  let totalFiles = 0;
  let totalReplacements = 0;
  const unmappedRefs = new Set<string>(); // collect unique unmapped refs across all files

  for (const entry of alFiles) {
    const filePath = path.join(targetPath, entry.name);

    let content: string;
    try {
      content = await fs.promises.readFile(filePath, 'utf8');
    } catch (err) {
      const msg = `[WARN] Could not read ${entry.name}: ${err}`;
      debugLog(msg);
      logLines.push(timestamp(msg));
      continue;
    }

    let fileReplacements = 0;
    const fileLog: string[] = [];

    // Use case-insensitive match but preserve the replacement value exactly
    // as written in the mapping (so casing in the output is always correct).
    const updated = content.replace(pattern, (match) => {
      // Map lookup must also be case-insensitive — find the key that matches
      const key = Array.from(mapping.keys()).find(
        k => k.toLowerCase() === match.toLowerCase()
      );
      if (key === undefined) return match;
      const replacement = mapping.get(key)!;
      fileReplacements++;
      fileLog.push(timestamp(`  ${entry.name}: "${match}" → "${replacement}"`));
      return replacement;
    });

    // After replacement, scan for any still-numeric references and collect
    // them so we can report what's missing from the mapping file.
    let unmatchedResult: RegExpExecArray | null;
    unmappedPattern.lastIndex = 0;
    while ((unmatchedResult = unmappedPattern.exec(updated)) !== null) {
      unmappedRefs.add(unmatchedResult[0]);
    }

    if (fileReplacements === 0) continue;

    try {
      await fs.promises.writeFile(filePath, updated, 'utf8');
      totalFiles++;
      totalReplacements += fileReplacements;

      const summary = `[RESOLVER] ${entry.name}: ${fileReplacements} replacement(s)`;
      debugLog(summary);
      logLines.push(timestamp(summary));
      fileLog.forEach(l => {
        debugLog(l);
        logLines.push(l);
      });
    } catch (err) {
      const msg = `[WARN] Could not write ${entry.name}: ${err}`;
      debugLog(msg);
      logLines.push(timestamp(msg));
    }
  }

  const summary = `[RESOLVER] Done — ${totalReplacements} replacement(s) across ${totalFiles} file(s).`;
  debugLog(summary);
  logLines.push(timestamp(summary));

  // Report any numeric references that had no mapping entry — these are
  // the exact strings you need to add to object-mapping.json.
  if (unmappedRefs.size > 0) {
    const unmappedHeader = `[RESOLVER] ${unmappedRefs.size} unmapped numeric reference(s) found:`;
    debugLog(unmappedHeader);
    logLines.push(timestamp(unmappedHeader));
    outputChannel.show(true); // bring output channel to front so user sees the list

    for (const ref of [...unmappedRefs].sort()) {
      const line = `  ${ref}`;
      debugLog(line);
      logLines.push(timestamp(line));
    }
  }

  logLines.push('');

  try {
    await fs.promises.appendFile(logPath, logLines.join('\n'), 'utf8');
  } catch {
    // Non-fatal
  }
}
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build command-line arguments for txt2al from VS Code settings.
 */
function buildArgs(source: string, target: string): string[] {
  const cfg = vscode.workspace.getConfiguration(CONFIG_NAMESPACE);
  const args: string[] = ['--source', source, '--target', target];

  const verbose = cfg.get<boolean>(CONVERSION_SETTINGS.verboseLogging);
  if (verbose) args.push('--stacktrace');

  args.push('--multithreaded');
  args.push('--rename');
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

  const cfg = vscode.workspace.getConfiguration(CONFIG_NAMESPACE);
  const configuredLog = (cfg.get<string>(CONVERSION_SETTINGS.logFilePath) || '').trim();
  const logPath = configuredLog || path.join(targetPath, FILE_NAMES.CONVERSION_LOG);

  const objectMapping = await loadObjectMapping(context, workspaceRoot);

  // Developer debug logging
  debugLog(`objectMapping size: ${objectMapping.size}`);
  if (objectMapping.size > 0) {
    debugLog('objectMapping contents:');
    for (const [key, value] of objectMapping.entries()) {
      debugLog(`  "${key}" → "${value}"`);
    }
  }

  try {
    await vscode.window.withProgress({
      location: vscode.ProgressLocation.Notification,
      title: 'C/AL → AL',
      cancellable: true,
    }, async (progress) => {
      progress.report({ message: 'Starting conversion…' });

      const args = buildArgs(sourcePath, targetPath);
      const child = spawn(exePath, args, {
        cwd: path.dirname(exePath),
        windowsHide: true,
        shell: false,
      });

      activeChild = child;

      let stdoutBuf = '';
      let stderrBuf = '';
      let convertedCount = 0;

      const rl = readline.createInterface({ input: child.stdout, terminal: false });

      rl.on('line', (line: string) => {
        stdoutBuf += `${line}\n`;

        if (line.startsWith('Writing:') || line.startsWith('Overwriting:')) {
          convertedCount++;
          const writtenFile = path.basename(line.slice('Writing:'.length).trim());

          // Show "X — filename" when total is known, otherwise just filename
          const countLabel = `${convertedCount}`;

          progress.report({
            message: `${countLabel} — ${writtenFile}`,
            // increment drives the VS Code progress bar fill
            // increment: totalObjects > 0 ? (100 / totalObjects) : undefined,
          });
        }
      });

      child.stderr.on('data', (d: Buffer) => { stderrBuf += d.toString(); });

      const exitCode: number = await new Promise(resolve => {
        let exitCode: number | undefined;
        let rlClosed = false;
        let processClosed = false;

        function tryResolve() {
          if (rlClosed && processClosed) {
            resolve(exitCode ?? -1);
          }
        }

        rl.on('close', () => {
          rlClosed = true;
          tryResolve();
        });

        child.on('close', code => {
          progress.report({ message: `Ending Conversion…` });
          exitCode = code ?? -1;
          processClosed = true;
          // Don't destroy stdout — let readline drain naturally, it will close on its own
          tryResolve();
        });

        child.on('error', () => {
          exitCode = -1;
          processClosed = true;
          rlClosed = true; // force resolve on error
          tryResolve();
        });
      });

      activeChild = undefined;

      if (tempSourceDir) {
        await fs.promises.rm(tempSourceDir, { recursive: true, force: true }).catch(() => { });
      }

      await writeConversionLog(targetPath, stdoutBuf, stderrBuf, exitCode);

      if (exitCode !== 0) {
        const errMsg = stderrBuf.trim() || 'Conversion failed with no output.';
        debugLog(`[ERROR] txt2al exited with code ${exitCode}`);
        debugLog(errMsg);
        outputChannel.show(true);

        // Use convertedCount (tracked in memory) instead of re-scanning disk
        if (convertedCount === 0) {
          vscode.window.showErrorMessage(
            `Conversion failed — 0 objects converted. See "${FILE_NAMES.CONVERSION_LOG}" inside '${DIRECTORY_NAMES.AL_OUTPUT}' for details.`
          );
        } else {
          vscode.window.showErrorMessage(
            errMsg.length > 800 ? errMsg.slice(0, 800) + '…' : errMsg
          );
        }
        return;
      }

      if (stdoutBuf.trim()) {
        debugLog('[INFO] txt2al output:');
        debugLog(stdoutBuf.trim());
      }

      if (objectMapping.size > 0) {
        await resolveObjectReferences(targetPath, objectMapping, logPath);
      }

      // Use convertedCount tracked during streaming — avoids a slow
      // readdir over the entire output folder at the end.
      vscode.window.showInformationMessage(
        `C/AL → AL: ${convertedCount} object(s) converted. ` +
        `Output: "${DIRECTORY_NAMES.AL_OUTPUT}" — Log: "${FILE_NAMES.CONVERSION_LOG}".`
      );
    });
  } catch (err) {
    debugLog(`[EXCEPTION] Conversion threw: ${String(err)}`);
    outputChannel.show(true);
    vscode.window.showErrorMessage(
      `Conversion crashed. See "${FILE_NAMES.CONVERSION_LOG}" inside '${DIRECTORY_NAMES.AL_OUTPUT}' for details.`
    );
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