import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

// Store line counts to avoid recounting
const lineCountCache = new Map<string, number>();
// Store decorations to update badges
const fileDecorations = new Map<string, vscode.FileDecoration>();
// Store watcher to avoid multiple instances
let fileWatcher: { dispose: () => void } | undefined;
// Store file sizes to use for estimation and change detection
const fileSizeCache = new Map<string, number>();
// Debounce timer for batch updates
let debounceTimer: NodeJS.Timeout | undefined;
// Flag to track initialization state
let isInitializing = false;

// Configuration defaults
const DEFAULT_CONFIG = {
  sizeLimit: 5000000,      // 5MB limit to prevent performance issues
  batchSize: 200,          // Files to process per batch
  debounceDelay: 300,      // ms to wait before updating after changes
  initialScanDelay: 5000,  // ms to wait before initial scan after activation
  estimationFactor: 50     // bytes per line for estimation
};

// Function to count lines in a file
async function countLines(filePath: string): Promise<number> {
  try {
    // Check if file exists
    const stats = await fs.promises.stat(filePath);
    
    // Store file size for later change detection
    fileSizeCache.set(filePath, stats.size);
    
    // If file is too large, estimate instead
    if (stats.size > DEFAULT_CONFIG.sizeLimit) {
      return Math.floor(stats.size / DEFAULT_CONFIG.estimationFactor);
    }

    // Skip files with no extension or known binary extensions
    const ext = path.extname(filePath).toLowerCase();
    const binaryExtensions = ['.exe', '.dll', '.obj', '.bin', '.jpg', '.jpeg', '.png', '.gif', '.mp3', '.mp4', 
                             '.zip', '.gz', '.tar', '.pdf', '.class', '.pyc', '.pyd', '.so', '.dylib'];
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
    // Remove from caches if file is inaccessible
    lineCountCache.delete(filePath);
    fileSizeCache.delete(filePath);
    console.error(`Error accessing ${filePath}:`, error);
    return 0;
  }
}

// More efficient line counting using read stream instead of loading entire file
async function countLinesWithReadStream(filePath: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const readStream = fs.createReadStream(filePath, {
      encoding: 'utf8',
      highWaterMark: 128 * 1024, // Increase to 128KB chunks for better throughput
    });

    let lineCount = 0;
    let incompleteChunk = '';

    readStream.on('data', (chunk: string) => {
      // Count newlines directly for better performance
      for (let i = 0; i < chunk.length; i++) {
        if (chunk[i] === '\n') {
          lineCount++;
        }
      }
      
      // Check if last character was not a newline
      // This handles the case where the file doesn't end with a newline
      if (chunk.length > 0 && chunk[chunk.length - 1] !== '\n') {
        incompleteChunk = chunk[chunk.length - 1];
      } else {
        incompleteChunk = '';
      }
    });

    readStream.on('end', () => {
      // If the file doesn't end with a newline and has content, count the last line
      if (incompleteChunk || lineCount === 0) {
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
  const skippedFolders = [
    'node_modules', '.git', 'dist', 'build', 'out', 'bin', 'obj', 
    '.vscode', '.idea', '.vs', 'vendor', 'coverage', '.next', '.nuxt',
    'public/assets', 'static/assets', 'target', '.sass-cache', '.cache'
  ];
  
  // Check if path contains any of the skipped folders
  for (const folder of skippedFolders) {
    const folderPattern = `${path.sep}${folder}${path.sep}`;
    const endPattern = `${path.sep}${folder}`;
    
    if (filePath.includes(folderPattern) || filePath.endsWith(endPattern)) {
      return true;
    }
  }
  
  // Skip files with large binary extensions
  const skipExtensions = [
    '.exe', '.dll', '.obj', '.bin', '.jpg', '.jpeg', '.png', '.gif', 
    '.mp3', '.mp4', '.zip', '.gz', '.tar', '.pdf', '.class', '.pyc', 
    '.pyd', '.so', '.dylib', '.o', '.a', '.lib', '.woff', '.woff2',
    '.ttf', '.eot', '.svg', '.ico', '.bmp', '.tiff', '.webp'
  ];
  
  const ext = path.extname(filePath).toLowerCase();
  if (skipExtensions.includes(ext)) {
    return true;
  }
  
  // Focus on common code file extensions
  const codeFileExtensions = [
    // Web/JavaScript
    '.js', '.jsx', '.ts', '.tsx', '.html', '.css', '.scss', '.less',
    // Backend
    '.go', '.py', '.java', '.c', '.cpp', '.cs', '.php', '.rb', '.rs',
    // Data/Config
    '.json', '.yaml', '.yml', '.xml', '.md', '.txt'
  ];
  
  if (codeFileExtensions.includes(ext)) {
    return false;
  }
  
  // If the file is very large, skip it
  try {
    const cachedSize = fileSizeCache.get(filePath);
    if (cachedSize && cachedSize > DEFAULT_CONFIG.sizeLimit) {
      return true;
    }
  } catch (error) {
    // If we can't check the size, continue with other checks
  }
  
  // Skip files that aren't likely to be text/source code
  return true;
}

// Initialize decorations for all visible files
async function initializeDecorations(provider: LineCountDecorationProvider) {
  // Prevent multiple initializations
  if (isInitializing) return;
  isInitializing = true;
  
  // Get all workspace folders
  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (!workspaceFolders) {
    isInitializing = false;
    return;
  }

  vscode.window.showInformationMessage('LineSight is counting lines in your files...');
  vscode.window.setStatusBarMessage('LineSight: Initializing...', 2000);

  // Process files in stages to reduce initial load
  setTimeout(async () => {
    // Force refresh on all files in workspace
    for (const folder of workspaceFolders) {
      try {
        // Define file patterns to include - only the most common code files first
        const highPriorityPattern = '**/*.{js,jsx,ts,tsx,py,java,c,cpp,cs,go}';
        const lowPriorityPattern = '**/*.{html,css,scss,less,php,rb,rs,json,yaml,yml,xml,md,txt}';
        
        // Define patterns to exclude
        const excludePattern = '{**/node_modules/**,**/.git/**,**/dist/**,**/build/**,**/out/**,**/.vscode/**,**/bin/**,**/obj/**,**/.idea/**,**/.vs/**,**/vendor/**,**/coverage/**}';
        
        // First process high-priority files (most likely to be viewed)
        const highPriorityFiles = await vscode.workspace.findFiles(
          new vscode.RelativePattern(folder, highPriorityPattern),
          excludePattern,
          1000 // Limit to 1000 most important files first
        );
        
        console.log(`Found ${highPriorityFiles.length} high-priority files in ${folder.name}`);
        
        // Process high-priority files in small batches
        await processBatchesWithDelay(highPriorityFiles, provider, 100, 50); // 100 files per batch, 50ms delay
        
        // Then process remaining files with lower priority
        const lowPriorityFiles = await vscode.workspace.findFiles(
          new vscode.RelativePattern(folder, lowPriorityPattern),
          excludePattern,
          5000 // Limit total files to prevent excessive processing
        );
        
        console.log(`Found ${lowPriorityFiles.length} low-priority files in ${folder.name}`);
        
        // Process low-priority files in larger batches with more delay
        await processBatchesWithDelay(lowPriorityFiles, provider, DEFAULT_CONFIG.batchSize, 100);
      } catch (error) {
        console.error(`Error initializing decorations for ${folder.uri.fsPath}:`, error);
      }
    }

    isInitializing = false;
    vscode.window.showInformationMessage('LineSight is ready!');
  }, DEFAULT_CONFIG.initialScanDelay); // Delay initial scan to let the editor load fully
}

// Helper function to process files in batches with delays
async function processBatchesWithDelay(
  files: vscode.Uri[], 
  provider: LineCountDecorationProvider, 
  batchSize: number, 
  delayMs: number
): Promise<void> {
  for (let i = 0; i < files.length; i += batchSize) {
    const batch = files.slice(i, i + batchSize);
    
    // Update progress periodically
    if (i % 1000 === 0 && i > 0) {
      vscode.window.setStatusBarMessage(`LineSight: Processing files (${i}/${files.length})...`, 2000);
    }
    
    // Process batch
    provider.refresh(batch);
    
    // Delay to prevent UI freezing
    await new Promise(resolve => setTimeout(resolve, delayMs));
  }
}

// Main file decorator provider
class LineCountDecorationProvider implements vscode.FileDecorationProvider {
  private _onDidChangeFileDecorations = new vscode.EventEmitter<vscode.Uri | vscode.Uri[]>();
  readonly onDidChangeFileDecorations = this._onDidChangeFileDecorations.event;

  // Add a queue system to prevent too many concurrent operations
  private processingQueue = new Map<string, Promise<number>>();
  // Add a throttling mechanism
  private lastUpdate = 0;
  private pendingUpdates = new Set<string>();

  async provideFileDecoration(uri: vscode.Uri): Promise<vscode.FileDecoration | undefined> {
    try {
      // Skip non-file schemes
      if (uri.scheme !== 'file') {
        return undefined;
      }

      const filePath = uri.fsPath;
      
      // Skip paths that should be ignored
      if (shouldSkipPath(filePath)) {
        return undefined;
      }
      
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

        // For empty files, return 0 immediately
        if (stat.size === 0) {
          const zeroDecoration = new vscode.FileDecoration('0', '0 lines');
          fileDecorations.set(filePath, zeroDecoration);
          return zeroDecoration;
        }

        // Check for file size changes - if size matches cache, use cached line count
        const cachedSize = fileSizeCache.get(filePath);
        let lineCount = lineCountCache.get(filePath);
        
        if (cachedSize === stat.size && lineCount !== undefined) {
          // Use cached value if file size hasn't changed
          const formattedCount = formatLineCount(lineCount);
          const decoration = new vscode.FileDecoration(
            formattedCount, 
            `${lineCount} lines`,
          );
          return decoration;
        }
        
        // Update file size cache
        fileSizeCache.set(filePath, stat.size);
        
        // If file is too large, use an estimation
        if (stat.size > DEFAULT_CONFIG.sizeLimit) {
          lineCount = Math.floor(stat.size / DEFAULT_CONFIG.estimationFactor);
          lineCountCache.set(filePath, lineCount);
          const formattedCount = formatLineCount(lineCount);
          const decoration = new vscode.FileDecoration(
            formattedCount, 
            `~${lineCount} lines (estimated)`,
          );
          fileDecorations.set(filePath, decoration);
          return decoration;
        }
        
        // If not in cache or size changed, count lines
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

  // Notify VS Code to refresh decorations with debouncing
  refresh(resources?: vscode.Uri | vscode.Uri[]) {
    // Clear any pending debounce
    if (debounceTimer) {
      clearTimeout(debounceTimer);
    }
    
    // Add resources to pending updates
    if (resources && !Array.isArray(resources)) {
      this.pendingUpdates.add(resources.fsPath);
      lineCountCache.delete(resources.fsPath);
      fileDecorations.delete(resources.fsPath);
    } else if (Array.isArray(resources)) {
      resources.forEach(uri => {
        this.pendingUpdates.add(uri.fsPath);
        lineCountCache.delete(uri.fsPath);
        fileDecorations.delete(uri.fsPath);
      });
    }
    
    // Throttle updates
    const now = Date.now();
    const timeSinceLastUpdate = now - this.lastUpdate;
    
    // If we've updated recently, use a debounce
    if (timeSinceLastUpdate < DEFAULT_CONFIG.debounceDelay && !isInitializing) {
      debounceTimer = setTimeout(() => {
        this.flushUpdates();
      }, DEFAULT_CONFIG.debounceDelay - timeSinceLastUpdate);
    } else {
      // Otherwise update immediately
      this.flushUpdates();
    }
  }
  
  // Flush all pending updates
  private flushUpdates() {
    if (this.pendingUpdates.size === 0) {
      // No pending updates, just fire empty array
      this._onDidChangeFileDecorations.fire([]);
      return;
    }
    
    // Convert pending updates to Uri array
    const updates: vscode.Uri[] = [];
    this.pendingUpdates.forEach(fsPath => {
      updates.push(vscode.Uri.file(fsPath));
    });
    
    // Clear pending updates
    this.pendingUpdates.clear();
    
    // Update last update time
    this.lastUpdate = Date.now();
    
    // Fire event
    this._onDidChangeFileDecorations.fire(updates);
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
    // Only watch the most common code file types to reduce overhead
    const highPriorityPattern = new vscode.RelativePattern(
      folder, 
      '**/*.{js,jsx,ts,tsx,py,java,c,cpp,cs,go}'
    );
    
    const watcher = vscode.workspace.createFileSystemWatcher(highPriorityPattern, false, true, false);
    
    // Only listen for created and deleted events, not changed (reduces overhead)
    // We'll use file size detection to handle changes
    
    // When a file is created, add to tracking
    watcher.onDidCreate((uri: vscode.Uri) => {
      if (uri.scheme !== 'file' || shouldSkipPath(uri.fsPath)) return;
      
      // Queue update with debouncing
      queueUpdate(uri, provider);
    });
    
    // When a file is deleted, remove from cache
    watcher.onDidDelete((uri: vscode.Uri) => {
      lineCountCache.delete(uri.fsPath);
      fileDecorations.delete(uri.fsPath);
      fileSizeCache.delete(uri.fsPath);
    });
    
    context.subscriptions.push(watcher);
    watchers.push(watcher);
    
    // Add a lower priority watcher for less commonly edited file types
    const lowPriorityPattern = new vscode.RelativePattern(
      folder, 
      '**/*.{html,css,scss,less,php,rb,rs,json,yaml,yml,xml,md,txt}'
    );
    
    const lowPriorityWatcher = vscode.workspace.createFileSystemWatcher(lowPriorityPattern, false, true, false);
    
    // Same event handlers but with more throttling
    lowPriorityWatcher.onDidCreate((uri: vscode.Uri) => {
      if (uri.scheme !== 'file' || shouldSkipPath(uri.fsPath)) return;
      queueUpdate(uri, provider, 500); // longer delay for low priority files
    });
    
    lowPriorityWatcher.onDidDelete((uri: vscode.Uri) => {
      lineCountCache.delete(uri.fsPath);
      fileDecorations.delete(uri.fsPath);
      fileSizeCache.delete(uri.fsPath);
    });
    
    context.subscriptions.push(lowPriorityWatcher);
    watchers.push(lowPriorityWatcher);
  }
  
  // Also watch for visible editor changes to update counts for currently viewed files
  context.subscriptions.push(
    vscode.window.onDidChangeVisibleTextEditors((editors) => {
      editors.forEach(editor => {
        const uri = editor.document.uri;
        if (uri.scheme === 'file' && !shouldSkipPath(uri.fsPath)) {
          queueUpdate(uri, provider, 100);
        }
      });
    })
  );
  
  // Store all watchers
  fileWatcher = {
    dispose: () => {
      watchers.forEach(w => w.dispose());
    }
  };
}

// Helper function to queue updates with debouncing
function queueUpdate(uri: vscode.Uri, provider: LineCountDecorationProvider, delay: number = DEFAULT_CONFIG.debounceDelay) {
  if (debounceTimer) {
    clearTimeout(debounceTimer);
  }
  
  debounceTimer = setTimeout(() => {
    provider.refresh(uri);
  }, delay);
}

// Main extension activation
export function activate(context: vscode.ExtensionContext) {
  console.log('LineSight extension activated');
  
  // Create provider and register it
  const provider = new LineCountDecorationProvider();
  context.subscriptions.push(
    vscode.window.registerFileDecorationProvider(provider)
  );
  
  // Set up file system watcher with a delay to let the editor start up
  setTimeout(() => {
    setupFileWatcher(context, provider);
    
    // Initialize decorations with delay
    initializeDecorations(provider);
  }, 2000);
  
  // Register command to manually refresh all line counts
  const refreshCommand = vscode.commands.registerCommand('linesight.refresh', async () => {
    // Clear cache to force recounting
    lineCountCache.clear();
    fileSizeCache.clear();
    fileDecorations.clear();
    
    // Refresh all files
    await initializeDecorations(provider);
  });
  
  context.subscriptions.push(refreshCommand);
  
  // Watch for workspace folder changes
  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      // Add delay to prevent immediate heavy processing when changing workspaces
      setTimeout(() => {
        setupFileWatcher(context, provider);
        initializeDecorations(provider);
      }, 5000);
    })
  );
}

// Called when extension is deactivated
export function deactivate() {
  // Clear all caches
  lineCountCache.clear();
  fileDecorations.clear();
  fileSizeCache.clear();
  
  // Clear any pending timers
  if (debounceTimer) {
    clearTimeout(debounceTimer);
  }
  
  // Dispose watchers
  if (fileWatcher) {
    fileWatcher.dispose();
  }
} 