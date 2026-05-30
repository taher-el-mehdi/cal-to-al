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

  // User-configured path takes priority
  if (configured) {
    if (fs.existsSync(configured)) return configured;
    // Warn but fall through to defaults — don't abort
    vscode.window.showWarningMessage(
      `Configured txt2al path not found: "${configured}". Falling back to default locations.`
    );
  }

  // Check workspace bin folder
  const wsPrimary = path.join(workspaceRoot, DIRECTORY_NAMES.WORKSPACE_BIN, EXECUTABLE_NAMES.TXT2AL_WINDOWS);
  if (fs.existsSync(wsPrimary)) return wsPrimary;

  // Check parent directory bin (for sub-folder workspaces like src/)
  const parent = path.dirname(workspaceRoot);
  if (parent && parent !== workspaceRoot) {
    const wsParent = path.join(parent, DIRECTORY_NAMES.WORKSPACE_BIN, EXECUTABLE_NAMES.TXT2AL_WINDOWS);
    if (fs.existsSync(wsParent)) return wsParent;
  }

  // Check extension bin folder
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
 * Each entry is prefixed with an ISO timestamp.
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
    stdout.trim().split(/\r?\n/).forEach(line => {
      lines.push(timestamp(line));
    });
  }

  if (stderr.trim()) {
    stderr.trim().split(/\r?\n/).forEach(line => {
      lines.push(timestamp(`[WARN/ERR] ${line}`));
    });
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

/**
 * Build command-line arguments for txt2al from VS Code settings.
 */
function buildArgs(source: string, target: string): string[] {
  const cfg = vscode.workspace.getConfiguration(CONFIG_NAMESPACE);
  const args: string[] = ['--source', source, '--target', target];

  // verboseLogging implicitly forces --stacktrace
  const verbose = cfg.get<boolean>(CONVERSION_SETTINGS.verboseLogging);
  if (verbose) args.push('--stacktrace');
  
  
  // alwasy enable multithreading as it significantly improves performance.
  // if (cfg.get<boolean>(CONVERSION_SETTINGS.multithreaded)) 
  args.push('--multithreaded');
  
  // alwasy enable renaming to ensure consistent results and avoid naming conflicts.
  args.push('--rename');

  // alwasy enable formatting to ensure consistent code style in the generated AL.
  args.push('--format');

  if (cfg.get<boolean>(CONVERSION_SETTINGS.injectDotNetAddIns)) args.push('--injectDotNetAddIns');
  if (cfg.get<boolean>(CONVERSION_SETTINGS.addLegacyTranslationInfo)) args.push('--addLegacyTranslationInfo');
  if (cfg.get<boolean>(CONVERSION_SETTINGS.tableDataOnly)) args.push('--tableDataOnly');

  // String parameters
  const type = (cfg.get<string>(CONVERSION_SETTINGS.type) || '').trim();
  if (type) args.push('--type', type);

  // Explicit null check so a zero value is preserved and a misconfigured
  // non-numeric value doesn't silently become 0.
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
  // If user selected a file, copy it to a temporary directory.
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

  // Snapshot output directory before conversion so we can report new files.
  // Note: files overwritten in place are not reflected in the delta.
  const beforeCount = await countAlFiles(targetPath);

  // Wrap the conversion run in a try/catch so any unexpected exception is
  // surfaced to the user and we can provide a helpful hint to inspect the
  // conversion.log inside the AL output folder when no objects were produced.
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

    // Track the active process so deactivate() can clean it up
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

    // Always clean up the temp directory, even if conversion failed
    if (tempSourceDir) {
      await fs.promises.rm(tempSourceDir, { recursive: true, force: true }).catch(() => {
        // Ignore cleanup errors — don't mask the real result
      });
    }

    // Only write conversion log if verbose logging is enabled
    const cfg = vscode.workspace.getConfiguration(CONFIG_NAMESPACE);
    const verbose = cfg.get<boolean>(CONVERSION_SETTINGS.verboseLogging);
    if (verbose) {
      await writeConversionLog(targetPath, stdoutBuf, stderrBuf, exitCode);
    }

    // Count output files after conversion regardless of exit code so we can
    // provide a helpful hint when nothing was produced.
    const afterCount = await countAlFiles(targetPath);
    const delta = Math.max(0, afterCount - beforeCount);

    if (exitCode !== 0) {
      const errMsg = stderrBuf.trim() || 'Conversion failed with no output.';

      // Log full stderr to the output channel so users can inspect it
      outputChannel.appendLine(`[ERROR] txt2al exited with code ${exitCode}`);
      outputChannel.appendLine(errMsg);
      outputChannel.show(true);

      // If nothing was produced, point users to the conversion.log inside
      // the AL output folder for more details.
      if (delta === 0) {
        vscode.window.showErrorMessage(
          `Conversion failed and 0 objects were converted. See conversion.log inside '${DIRECTORY_NAMES.AL_OUTPUT}' folder to see why.`
        );
      } else {
        vscode.window.showErrorMessage(
          errMsg.length > 800 ? errMsg.slice(0, 800) + '…' : errMsg
        );
      }
      return;
    }

    // Log stdout diagnostics to the output channel
    if (stdoutBuf.trim()) {
      outputChannel.appendLine('[INFO] txt2al output:');
      outputChannel.appendLine(stdoutBuf.trim());
    }

    vscode.window.showInformationMessage(
      `Conversion complete: ${delta} new object(s) converted to AL in ${DIRECTORY_NAMES.AL_OUTPUT}.`
    );
  });
  } catch (err) {
    // Unexpected exception while running the conversion. Surface it to the
    // output channel and show a message guiding users to the conversion.log
    // inside the AL output folder if nothing was produced.
    outputChannel.appendLine(`[EXCEPTION] Conversion threw: ${String(err)}`);
    outputChannel.show(true);

    const afterCount = await countAlFiles(targetPath).catch(() => 0);
    const delta = Math.max(0, afterCount - beforeCount);

    if (delta === 0) {
      vscode.window.showErrorMessage(
        `Conversion crashed and 0 objects were converted. See conversion.log inside '${DIRECTORY_NAMES.AL_OUTPUT}' folder to see why.`
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
        vscode.window.showErrorMessage('No file or folder selected.');
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
 * context.subscriptions, but active child must be handled explicitly here.
 */
export function deactivate(): void {
  if (activeChild) {
    activeChild.kill();
    activeChild = undefined;
  }
}