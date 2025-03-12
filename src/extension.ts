import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

// Store line counts to avoid recounting
const lineCountCache = new Map<string, number>();
// Store decorations to update badges
const fileDecorations = new Map<string, vscode.FileDecoration>();
// Store watcher to avoid multiple instances
let fileWatcher: { dispose: () => void } | undefined;

// Function to count lines in a file
async function countLines(filePath: string): Promise<number> {
  try {
    // Check if file exists
    const stats = await fs.promises.stat(filePath);
    
    // If file is too large, estimate instead
    if (stats.size > 5000000) { // 5MB limit to prevent performance issues
      return Math.floor(stats.size / 50); // Rough estimate: 50 bytes per line
    }

    // Skip files with no extension or known binary extensions
    const ext = path.extname(filePath).toLowerCase();
    const binaryExtensions = ['.exe', '.dll', '.obj', '.bin', '.jpg', '.png', '.gif', '.mp3', '.mp4', '.zip', '.gz', '.tar'];
    if (binaryExtensions.includes(ext)) {
      return 0;
    }

    try {
      // More efficient line counting using stream reading
      return await countLinesWithReadStream(filePath);
    } catch (error) {
      // If we can't read as UTF-8, it might be binary or have encoding issues
      console.error(`Error reading file ${filePath}:`, error);
      return 0;
    }
  } catch (error) {
    console.error(`Error accessing ${filePath}:`, error);
    return 0;
  }
}

// More efficient line counting using read stream instead of loading entire file
async function countLinesWithReadStream(filePath: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const readStream = fs.createReadStream(filePath, {
      encoding: 'utf8',
      highWaterMark: 64 * 1024, // 64KB chunks
    });

    let lineCount = 0;
    let incompleteChunk = '';

    readStream.on('data', (chunk: string) => {
      // Combine with any leftover chunk from previous read
      const combinedChunk = incompleteChunk + chunk;
      
      // Split by newlines and count
      const lines = combinedChunk.split('\n');
      
      // Last line might be incomplete, save for next chunk
      incompleteChunk = lines.pop() || '';
      
      // Add to line count
      lineCount += lines.length;
    });

    readStream.on('end', () => {
      // Count the last line if it has content
      if (incompleteChunk.length > 0) {
        lineCount++;
      }
      resolve(lineCount);
    });

    readStream.on('error', (err) => {
      reject(err);
    });
  });
}

// Format line count for display
function formatLineCount(count: number): string {
  if (count >= 1000000) {
    return `${Math.floor(count / 1000000)}M`; // e.g., "1M"
  } else if (count >= 1000) {
    return `${Math.floor(count / 1000)}K`; // e.g., "1K"
  } else if (count >= 100) {
    return `${Math.floor(count / 100)}H`; // e.g., "1H" for hundreds
  } else {
    return count.toString(); // exact count for <100
  }
}

// Skip directories that should be ignored
function shouldSkipPath(filePath: string): boolean {
  // Skip directories that are commonly large or not relevant
  const skippedFolders = ['node_modules', '.git', 'dist', 'build', 'out'];
  
  // Check if path contains any of the skipped folders
  for (const folder of skippedFolders) {
    const folderPattern = `${path.sep}${folder}${path.sep}`;
    const endPattern = `${path.sep}${folder}`;
    
    if (filePath.includes(folderPattern) || filePath.endsWith(endPattern)) {
      return true;
    }
  }
  
  // Don't skip files with these extensions
  const codeFileExtensions = [
    // Web/JavaScript
    '.js', '.jsx', '.ts', '.tsx', '.html', '.css', '.scss', '.less',
    // Backend
    '.go', '.py', '.java', '.c', '.cpp', '.cs', '.php', '.rb', '.rs',
    // Data/Config
    '.json', '.yaml', '.yml', '.xml', '.md', '.txt'
  ];
  
  const ext = path.extname(filePath).toLowerCase();
  
  // If it's a common code file extension, never skip it
  if (codeFileExtensions.includes(ext)) {
    return false;
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
      // Define file patterns to include
      const includePattern = '**/*.{js,jsx,ts,tsx,go,py,java,c,cpp,cs,php,rb,rs,html,css,scss,less,json,yaml,yml,xml,md,txt}';
      
      // Define patterns to exclude
      const excludePattern = '{**/node_modules/**,**/.git/**,**/dist/**,**/build/**,**/out/**,**/.vscode/**,**/bin/**,**/obj/**}';
      
      // Find all matching files
      const files = await vscode.workspace.findFiles(
        new vscode.RelativePattern(folder, includePattern),
        excludePattern,
        10000 // Increased limit for larger projects
      );
      
      console.log(`Found ${files.length} files to process in ${folder.name}`);
      
      // Process files in batches to avoid overwhelming the system
      const batchSize = 200; // Increased for faster processing
      for (let i = 0; i < files.length; i += batchSize) {
        const batch = files.slice(i, i + batchSize);
        
        // Update progress periodically
        if (i % 1000 === 0 && i > 0) {
          vscode.window.setStatusBarMessage(`LineSight: Processing files (${i}/${files.length})...`, 2000);
        }
        
        // Process the batch
        provider.refresh(batch);
        
        // Small delay to allow UI to update and prevent blocking
        await new Promise(resolve => setTimeout(resolve, 20));
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

  // Add a queue system to prevent too many concurrent operations
  private processingQueue = new Map<string, Promise<number>>();

  async provideFileDecoration(uri: vscode.Uri): Promise<vscode.FileDecoration | undefined> {
    try {
      // Skip non-file schemes (like git:// or untitled:)
      if (uri.scheme !== 'file') {
        return undefined;
      }

      const filePath = uri.fsPath;
      
      // Check if we already have a decoration for this file
      const existingDecoration = fileDecorations.get(filePath);
      if (existingDecoration) {
        return existingDecoration;
      }
      
      try {
        // Check if file exists and is a regular file
        const stat = await fs.promises.stat(filePath);
        if (!stat.isFile()) {
          return undefined;
        }

        // Check if this file should be skipped based on path or type
        if (shouldSkipPath(filePath)) {
          return undefined;
        }

        // Skip very small files (likely empty or nearly empty)
        if (stat.size === 0) {
          const zeroDecoration = new vscode.FileDecoration('0', '0 lines');
          fileDecorations.set(filePath, zeroDecoration);
          return zeroDecoration;
        }

        // Try to get line count from cache first
        let lineCount = lineCountCache.get(filePath);
        
        // If not in cache or 0, count lines
        if (lineCount === undefined || lineCount === 0) {
          // Check if this file is already being processed
          let countPromise = this.processingQueue.get(filePath);
          
          if (!countPromise) {
            // If not already processing, create a new counting promise
            countPromise = countLines(filePath).then(count => {
              // Store result in cache when done
              if (count > 0) {
                lineCountCache.set(filePath, count);
              }
              // Remove from processing queue when done
              this.processingQueue.delete(filePath);
              return count;
            }).catch(err => {
              console.error(`Error counting lines in ${filePath}:`, err);
              this.processingQueue.delete(filePath);
              return 0;
            });
            
            // Add to processing queue
            this.processingQueue.set(filePath, countPromise);
          }
          
          // Wait for counting to complete
          lineCount = await countPromise;
        }
        
        // Only create decoration if we have a positive line count
        if (lineCount > 0) {
          const formattedCount = formatLineCount(lineCount);
          
          // Create the decoration with the formatted count
          const decoration = new vscode.FileDecoration(
            formattedCount, 
            `${lineCount} lines`,
          );
          
          // Store decoration for later reference
          fileDecorations.set(filePath, decoration);
          return decoration;
        }
        
        return undefined;
      } catch (error) {
        // File might not exist or be inaccessible
        console.error(`Error providing decoration for ${filePath}:`, error);
        return undefined;
      }
    } catch (error) {
      console.error(`Unexpected error for ${uri.fsPath}:`, error);
      return undefined;
    }
  }

  // Notify VS Code to refresh decorations
  refresh(resources?: vscode.Uri | vscode.Uri[]) {
    // Clear caches for these resources if provided
    if (resources && !Array.isArray(resources)) {
      lineCountCache.delete(resources.fsPath);
      fileDecorations.delete(resources.fsPath);
    } else if (Array.isArray(resources)) {
      resources.forEach(uri => {
        lineCountCache.delete(uri.fsPath);
        fileDecorations.delete(uri.fsPath);
      });
    }
    
    this._onDidChangeFileDecorations.fire(resources || []);
  }
}

// Set up file system watcher to track changes
function setupFileWatcher(context: vscode.ExtensionContext, provider: LineCountDecorationProvider) {
  // Clear any existing watchers
  if (fileWatcher) {
    fileWatcher.dispose();
  }
  
  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (!workspaceFolders) return;
  
  // Watch for file changes in all workspace folders
  const watchers: vscode.FileSystemWatcher[] = [];
  
  for (const folder of workspaceFolders) {
    // Watch common code file types - optimize the patterns
    const codeFilePattern = new vscode.RelativePattern(
      folder, 
      '**/*.{js,jsx,ts,tsx,go,py,java,c,cpp,cs,php,rb,rs,html,css,scss,less,json,yaml,yml,xml,md,txt}'
    );
    
    const watcher = vscode.workspace.createFileSystemWatcher(codeFilePattern);
    
    // When a file is changed, update its line count
    watcher.onDidChange(async (uri: vscode.Uri) => {
      if (uri.scheme !== 'file' || shouldSkipPath(uri.fsPath)) return;
      
      try {
        const stat = await fs.promises.stat(uri.fsPath);
        if (stat.isFile()) {
          // Clear cache and update decoration
          lineCountCache.delete(uri.fsPath);
          fileDecorations.delete(uri.fsPath); // Also clear decoration cache
          
          // Use a small delay to avoid overloading VS Code with updates
          setTimeout(() => {
            provider.refresh(uri);
          }, 100);
        }
      } catch (error) {
        // File might have been deleted, ignore
        console.log(`Error updating decoration for ${uri.fsPath}:`, error);
      }
    });
    
    // When a file is created, add to tracking
    watcher.onDidCreate((uri: vscode.Uri) => {
      if (uri.scheme !== 'file' || shouldSkipPath(uri.fsPath)) return;
      
      // Small delay to let the file system settle
      setTimeout(() => {
        provider.refresh(uri);
      }, 200);
    });
    
    // When a file is deleted, remove from cache
    watcher.onDidDelete((uri: vscode.Uri) => {
      lineCountCache.delete(uri.fsPath);
      fileDecorations.delete(uri.fsPath);
    });
    
    context.subscriptions.push(watcher);
    watchers.push(watcher);
  }
  
  // Store all watchers
  fileWatcher = {
    dispose: () => {
      watchers.forEach(w => w.dispose());
    }
  };
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