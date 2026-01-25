import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';

function getWorkspaceRoot(): string | undefined {
  const folders = vscode.workspace.workspaceFolders;
  return folders && folders.length > 0 ? folders[0].uri.fsPath : undefined;
}

function ensureDir(dir: string) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function resolveTxt2AlPath(
  context: vscode.ExtensionContext,
  workspaceRoot: string
): string | undefined {

  const cfg = vscode.workspace.getConfiguration('calToAl');
  const configured = (cfg.get<string>('txt2alPath') || '').trim();

  if (configured) {
    if (fs.existsSync(configured)) return configured;
    vscode.window.showWarningMessage(`Configured txt2al path does not exist: ${configured}`);
  }

  // 1) Workspace bin
  if (workspaceRoot) {
    const wsCandidates = [
      path.join(workspaceRoot, 'bin', 'Txt2Al.exe'),
    ];
    for (const p of wsCandidates) {
      if (fs.existsSync(p)) return p;
    }
  }

  // 2) Extension bin
  const extCandidates = [
    path.join(context.extensionPath, 'bin', 'Txt2Al.exe'),
  ];

  for (const p of extCandidates) {
    if (fs.existsSync(p)) return p;
  }

  return undefined;
}

async function countAlFiles(dir: string): Promise<number> {
  try {
    const items = await fs.promises.readdir(dir);
    let count = 0;
    for (const item of items) {
      const full = path.join(dir, item);
      const stat = await fs.promises.stat(full);
      if (stat.isFile() && full.toLowerCase().endsWith('.al')) count++;
    }
    return count;
  } catch {
    return 0;
  }
}

function buildArgs(source: string, target: string): string[] {
  const cfg = vscode.workspace.getConfiguration('calToAl');
  const args: string[] = ['--source', source, '--target', target];

  if (cfg.get<boolean>('rename')) args.push('--rename');

  const type = (cfg.get<string>('type') || '').trim();
  if (type) args.push('--type', type);

  const startId = cfg.get<number>('extensionStartId') || 0;
  if (startId > 0) args.push('--extensionStartId', String(startId));

  if (cfg.get<boolean>('injectDotNetAddIns')) args.push('--injectDotNetAddIns');

  const addInsPkg = (cfg.get<string>('dotNetAddInsPackage') || '').trim();
  if (addInsPkg) args.push('--dotNetAddInsPackage', addInsPkg);

  const typePrefix = (cfg.get<string>('dotNetTypePrefix') || '').trim();
  if (typePrefix) args.push('--dotNetTypePrefix', typePrefix);

  const transFmt = (cfg.get<string>('translationFormat') || '').trim();
  if (transFmt) args.push('--translationFormat', transFmt);

  if (cfg.get<boolean>('addLegacyTranslationInfo')) args.push('--addLegacyTranslationInfo');

  return args;
}

async function runConversion(context: vscode.ExtensionContext, resource: vscode.Uri) {
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

  // 🔑 txt2al requires a DIRECTORY
  let tempSourceDir: string | undefined;

  if (stat.isFile()) {
    tempSourceDir = path.join(workspaceRoot, '.caltoal-temp');
    ensureDir(tempSourceDir);

    const destFile = path.join(tempSourceDir, path.basename(sourcePath));
    await fs.promises.copyFile(sourcePath, destFile);

    sourcePath = tempSourceDir;

  }

  const targetPath = path.join(workspaceRoot, 'src');
  ensureDir(targetPath);

  const exePath = resolveTxt2AlPath(context, workspaceRoot);
  if (!exePath) {
    vscode.window.showErrorMessage(
      'txt2al.exe not found. Set calToAl.txt2alPath or place Txt2Al.exe in bin.'
    );
    return;
  }

  const beforeCount = await countAlFiles(targetPath);

  await vscode.window.withProgress({
    location: vscode.ProgressLocation.Notification,
    title: 'Converting C/AL to AL...',
    cancellable: false
  }, async () => {

    const args = buildArgs(sourcePath, targetPath);
    const child = spawn(exePath, args, {
      cwd: path.dirname(exePath), // important for .NET DLL resolution
      windowsHide: true,
      shell: false
    });

    let stdoutBuf = '';
    let stderrBuf = '';

    child.stdout.on('data', d => stdoutBuf += d.toString());
    child.stderr.on('data', d => stderrBuf += d.toString());

    const exitCode: number = await new Promise(resolve => {
      child.on('close', resolve);
      child.on('error', () => resolve(-1));
    });

    const afterCount = await countAlFiles(targetPath);
    const delta = Math.max(0, afterCount - beforeCount);

    // Cleanup temp folder
    if (tempSourceDir) {
      try {
        await fs.promises.rm(tempSourceDir, { recursive: true, force: true });
      } catch { }
    }

    if (exitCode === 0) {
      vscode.window.showInformationMessage(
        `Conversion complete: ${delta} object(s) converted to AL in src.`
      );
      if (stdoutBuf.trim()) console.log('txt2al output:', stdoutBuf);
    } else {
      const errMsg = stderrBuf.trim() || 'Conversion failed.';
      vscode.window.showErrorMessage(
        errMsg.length > 800 ? errMsg.slice(0, 800) + '...' : errMsg
      );
    }
  });
}

export function activate(context: vscode.ExtensionContext) {
  const disposable = vscode.commands.registerCommand(
    'calToAl.convertSelection',
    async (resource: vscode.Uri) => {
      if (!resource) {
        vscode.window.showErrorMessage('No file or folder selected.');
        return;
      }
      await runConversion(context, resource);
    }
  );

  context.subscriptions.push(disposable);
}

export function deactivate() {}
