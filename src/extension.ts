import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

// Store line counts to avoid recounting
const lineCountCache = new Map<string, number>();
// Store decorations to update badges
const fileDecorations = new Map<string, vscode.FileDecoration>();
// Track watcher to avoid multiple instances
let fileWatcher: vscode.FileSystemWatcher | undefined;

// Function to count lines in a file
async function countLines(filePath: string): Promise<number> {
  try {
    // If file is too large, estimate instead
    const stats = await fs.promises.stat(filePath);
    if (stats.size > 1000000) { // 1MB limit to prevent performance issues
      return Math.floor(stats.size / 50); // Rough estimate: 50 bytes per line
    }

    const content = await fs.promises.readFile(filePath, 'utf8');
    return content.split('\n').length;
  } catch (error) {
    // Using console.error is fine in VS Code extensions
    console.error(`Error counting lines in ${filePath}:`, error);
    return 0;
  }
}

// Format line count for display
function formatLineCount(count: number): string {
  if (count >= 1000000) {
    return `${(count / 1000000).toFixed(1)}M`;
  } else if (count >= 1000) {
    return `${(count / 1000).toFixed(1)}k`;
  } else {
    return count.toString();
  }
}

// Skip directories that should be ignored
function shouldSkipPath(filePath: string): boolean {
  const skippedFolders = ['node_modules', '.git', 'dist', 'build', 'out'];
  for (const folder of skippedFolders) {
    const folderPattern = `${path.sep}${folder}${path.sep}`;
    const endPattern = `${path.sep}${folder}`;
    
    if (filePath.includes(folderPattern) || filePath.endsWith(endPattern)) {
      return true;
    }
  }
  return false;
}

// Initialize decorations for all visible files
async function initializeDecorations(provider: LineCountDecorationProvider) {
  // Get all workspace folders
  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (!workspaceFolders) return;

  vscode.window.showInformationMessage('LineSight is counting lines in your files...');

  // Force refresh on all files in workspace
  for (const folder of workspaceFolders) {
    try {
      const pattern = new vscode.RelativePattern(folder, '**/*');
      const files = await vscode.workspace.findFiles(pattern, '**/node_modules/**', 1000);
      
      // Process files in batches to avoid overwhelming the system
      const batchSize = 50;
      for (let i = 0; i < files.length; i += batchSize) {
        const batch = files.slice(i, i + batchSize);
        provider.refresh(batch);
        
        // Small delay to allow UI to update
        await new Promise(resolve => setTimeout(resolve, 10));
      }
    } catch (error) {
      console.error(`Error initializing decorations for ${folder.uri.fsPath}:`, error);
    }
  }

  vscode.window.showInformationMessage('LineSight is ready!');
}

// Main file decorator provider
class LineCountDecorationProvider implements vscode.FileDecorationProvider {
  private _onDidChangeFileDecorations = new vscode.EventEmitter<vscode.Uri | vscode.Uri[]>();
  readonly onDidChangeFileDecorations = this._onDidChangeFileDecorations.event;

  async provideFileDecoration(uri: vscode.Uri): Promise<vscode.FileDecoration | undefined> {
    try {
      // Skip schemes that aren't file
      if (uri.scheme !== 'file') return undefined;

      try {
        // Only process files, not directories
        const stat = await fs.promises.stat(uri.fsPath);
        if (!stat.isFile()) return undefined;

        // Skip binary files and ignored directories
        if (shouldSkipPath(uri.fsPath)) return undefined;

        // Check cache first
        let lineCount = lineCountCache.get(uri.fsPath);
        if (lineCount === undefined) {
          lineCount = await countLines(uri.fsPath);
          lineCountCache.set(uri.fsPath, lineCount);
        }

        // Create decoration with line count
        const decoration = new vscode.FileDecoration(
          formatLineCount(lineCount), 
          `${lineCount} lines`
        );
        
        fileDecorations.set(uri.fsPath, decoration);
        return decoration;
      } catch (error) {
        // File might not exist or be accessible
        return undefined;
      }
    } catch (error) {
      console.error(`Error providing decoration for ${uri.fsPath}:`, error);
      return undefined;
    }
  }

  // Notify VS Code to refresh decorations
  refresh(resources?: vscode.Uri | vscode.Uri[]) {
    this._onDidChangeFileDecorations.fire(resources || []);
  }
}

// Set up file system watcher to track changes
function setupFileWatcher(context: vscode.ExtensionContext, provider: LineCountDecorationProvider) {
  if (fileWatcher) {
    fileWatcher.dispose();
  }
  
  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (!workspaceFolders) return;
  
  // Watch for file changes in all workspace folders
  for (const folder of workspaceFolders) {
    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(folder, '**/*')
    );
    
    // When a file is changed, update its line count
    watcher.onDidChange(async (uri: vscode.Uri) => {
      if (uri.scheme !== 'file' || shouldSkipPath(uri.fsPath)) return;
      
      try {
        const stat = await fs.promises.stat(uri.fsPath);
        if (stat.isFile()) {
          // Clear cache and update decoration
          lineCountCache.delete(uri.fsPath);
          provider.refresh(uri);
        }
      } catch (error) {
        // File might have been deleted, ignore
      }
    });
    
    // When a file is created, add to tracking
    watcher.onDidCreate((uri: vscode.Uri) => {
      if (uri.scheme !== 'file' || shouldSkipPath(uri.fsPath)) return;
      provider.refresh(uri);
    });
    
    // When a file is deleted, remove from cache
    watcher.onDidDelete((uri: vscode.Uri) => {
      lineCountCache.delete(uri.fsPath);
      fileDecorations.delete(uri.fsPath);
    });
    
    context.subscriptions.push(watcher);
  }
}

// Main extension activation
export function activate(context: vscode.ExtensionContext) {
  console.log('LineSight extension activated');
  
  // Create provider and register it
  const provider = new LineCountDecorationProvider();
  context.subscriptions.push(
    vscode.window.registerFileDecorationProvider(provider)
  );
  
  // Set up file system watcher
  setupFileWatcher(context, provider);
  
  // Initialize decorations for all visible files
  initializeDecorations(provider);
  
  // Register command to manually refresh all line counts
  const refreshCommand = vscode.commands.registerCommand('linesight.refresh', async () => {
    // Clear cache to force recounting
    lineCountCache.clear();
    
    // Refresh all files
    await initializeDecorations(provider);
  });
  
  context.subscriptions.push(refreshCommand);
  
  // Watch for workspace folder changes
  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      setupFileWatcher(context, provider);
      initializeDecorations(provider);
    })
  );
}

// Called when extension is deactivated
export function deactivate() {
  lineCountCache.clear();
  fileDecorations.clear();
  if (fileWatcher) {
    fileWatcher.dispose();
  }
} 