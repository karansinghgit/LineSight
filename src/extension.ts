import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

// Configuration interface
interface LineCountConfig {
  enabled: boolean;
  countLinesOnStartup: boolean;
  excludeFolders: string[];
  excludeFiles: string[];
  maxFilesToProcess: number;
  maxFileSizeToRead: number;  // in KB
  scanDelay: number;          // in ms
  throttleTime: number;       // in ms
  cacheLifetime: number;      // in hours
  lowPerformanceMode: boolean;
}

// Default configuration values
const DEFAULT_CONFIG: LineCountConfig = {
  enabled: true,
  countLinesOnStartup: true,
  excludeFolders: [
    'node_modules', '.git', 'dist', 'build', 'out', '.vscode', 'bin', 'obj',
    'temp', 'tmp', 'cache', '.cache', 'vendor', 'logs', 'public', 
    '.next', '.nuxt', '.output', '.webpack', '.parcel-cache'
  ],
  excludeFiles: [
    'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', '.DS_Store',
    'thumbs.db', 'desktop.ini', '.gitignore', '.gitattributes',
    '.eslintcache', '.stylelintcache'
  ],
  maxFilesToProcess: 5000,
  maxFileSizeToRead: 5000,    // 5MB
  scanDelay: 3000,            // 3 seconds
  throttleTime: 500,          // 500ms
  cacheLifetime: 24,          // 24 hours
  lowPerformanceMode: false
};

// Current configuration
let config: LineCountConfig = { ...DEFAULT_CONFIG };

// Store line counts to avoid recounting
let lineCountCache = new Map<string, number>();
// Store decorations to update badges
const fileDecorations = new Map<string, vscode.FileDecoration>();
// Store watcher to avoid multiple instances
let fileWatcher: { dispose: () => void } | undefined;
// Store last modification times to avoid unnecessary updates
const fileModificationTimes = new Map<string, number>();
// Flag to track if initial counting is in progress
let isInitialCountInProgress = false;

// Load configuration
function loadConfiguration(): LineCountConfig {
  const vsConfig = vscode.workspace.getConfiguration('linesight');
  
  return {
    enabled: vsConfig.get('enabled', DEFAULT_CONFIG.enabled),
    countLinesOnStartup: vsConfig.get('countLinesOnStartup', DEFAULT_CONFIG.countLinesOnStartup),
    excludeFolders: vsConfig.get('excludeFolders', DEFAULT_CONFIG.excludeFolders),
    excludeFiles: vsConfig.get('excludeFiles', DEFAULT_CONFIG.excludeFiles),
    maxFilesToProcess: vsConfig.get('maxFilesToProcess', DEFAULT_CONFIG.maxFilesToProcess),
    maxFileSizeToRead: vsConfig.get('maxFileSizeToRead', DEFAULT_CONFIG.maxFileSizeToRead),
    scanDelay: vsConfig.get('scanDelay', DEFAULT_CONFIG.scanDelay),
    throttleTime: vsConfig.get('throttleTime', DEFAULT_CONFIG.throttleTime),
    cacheLifetime: vsConfig.get('cacheLifetime', DEFAULT_CONFIG.cacheLifetime),
    lowPerformanceMode: vsConfig.get('lowPerformanceMode', DEFAULT_CONFIG.lowPerformanceMode)
  };
}

// More efficient line counting using read stream instead of loading entire file
async function countLinesWithReadStream(filePath: string): Promise<number> {
  return new Promise((resolve, reject) => {
    // For very large files, use a sampling approach
    fs.stat(filePath, (err, stats) => {
      if (err) {
        reject(err);
        return;
      }
      
      // For very large files, use sampling to estimate
      if (stats.size > config.maxFileSizeToRead * 1024) {
        estimateLinesByFileSampling(filePath, stats.size).then(resolve).catch(reject);
        return;
      }

      const readStream = fs.createReadStream(filePath, {
        encoding: 'utf8',
        highWaterMark: 64 * 1024, // 64KB chunks
      });

      let lineCount = 0;
      let incompleteChunk = '';

      readStream.on('data', (chunk: string) => {
        // Combine with any leftover chunk from previous read
        const combinedChunk = incompleteChunk + chunk;
        
        // Count newlines directly without splitting for better performance
        for (let i = 0; i < combinedChunk.length; i++) {
          if (combinedChunk[i] === '\n') {
            lineCount++;
          }
        }
        
        // Check if the last character is a newline
        incompleteChunk = combinedChunk[combinedChunk.length - 1] === '\n' ? '' : 'X';
      });

      readStream.on('end', () => {
        // Count the last line if it doesn't end with a newline
        if (incompleteChunk.length > 0) {
          lineCount++;
        }
        resolve(lineCount);
      });

      readStream.on('error', (err) => {
        reject(err);
      });
    });
  });
}

// Estimate lines by sampling the file at regular intervals
async function estimateLinesByFileSampling(filePath: string, fileSize: number): Promise<number> {
  return new Promise((resolve, reject) => {
    try {
      // Take 10 samples of 4KB each from different parts of the file
      const sampleSize = 4096; // 4KB sample size
      const samplesCount = 10;
      const fd = fs.openSync(filePath, 'r');
      
      let totalSampleSize = 0;
      let totalSampleLines = 0;
      
      // Take samples at regular intervals through the file
      for (let i = 0; i < samplesCount; i++) {
        try {
          const position = Math.floor((i / samplesCount) * (fileSize - sampleSize));
          const buffer = Buffer.alloc(sampleSize);
          
          const bytesRead = fs.readSync(fd, buffer, 0, sampleSize, position);
          if (bytesRead <= 0) continue;
          
          const sample = buffer.toString('utf8', 0, bytesRead);
          
          // Count newlines in this sample
          let sampleLineCount = 0;
          for (let j = 0; j < sample.length; j++) {
            if (sample[j] === '\n') {
              sampleLineCount++;
            }
          }
          
          totalSampleSize += bytesRead;
          totalSampleLines += sampleLineCount;
        } catch (e) {
          // Skip sample on error
          continue;
        }
      }
      
      fs.closeSync(fd);
      
      // Calculate average lines per byte and estimate total
      if (totalSampleSize > 0) {
        const avgLinesPerByte = totalSampleLines / totalSampleSize;
        const estimatedLines = Math.ceil(avgLinesPerByte * fileSize);
        resolve(estimatedLines);
      } else {
        // Fallback if sampling failed
        resolve(Math.floor(fileSize / 50));
      }
    } catch (error) {
      // Fallback to simpler estimate
      resolve(Math.floor(fileSize / 50));
    }
  });
}

// Throttle manager to limit concurrent operations
class ThrottleManager {
  private activeCount = 0;
  private maxConcurrent: number;
  private queue: Array<() => Promise<void>> = [];
  private isProcessing = false;
  
  constructor(maxConcurrent = 5) {
    this.maxConcurrent = maxConcurrent;
  }
  
  // Add a task to the queue
  enqueue<T>(task: () => Promise<T>): Promise<T> {
    return new Promise((resolve, reject) => {
      this.queue.push(async () => {
        try {
          this.activeCount++;
          const result = await task();
          resolve(result);
        } catch (error) {
          reject(error);
        } finally {
          this.activeCount--;
          this.processQueue();
        }
      });
      
      this.processQueue();
    });
  }
  
  // Process the next items in the queue if under limit
  private processQueue() {
    if (this.isProcessing) return;
    this.isProcessing = true;
    
    setTimeout(() => {
      while (this.queue.length > 0 && this.activeCount < this.maxConcurrent) {
        const task = this.queue.shift();
        if (task) {
          task();
        }
      }
      this.isProcessing = false;
    }, 0);
  }
  
  // Adjust concurrency limit based on system load
  adjustConcurrency() {
    // If running in VS Code extension, use a lower limit to be a good citizen
    // This is a simple adaptive approach - can be made more sophisticated
    const newLimit = this.queue.length > 100 ? 2 : this.queue.length > 50 ? 3 : 5;
    this.maxConcurrent = newLimit;
  }
}

// Global throttle manager
const throttleManager = new ThrottleManager(config.lowPerformanceMode ? 2 : 5);

// Function to count lines in a file
async function countLines(filePath: string): Promise<number> {
  // Add to throttle queue
  return throttleManager.enqueue(async () => {
    try {
      // Check if file exists
      const stats = await fs.promises.stat(filePath);
      
      // Periodically adjust concurrency
      throttleManager.adjustConcurrency();
      
      // Get last modification time to detect changes
      const modTime = stats.mtimeMs;
      const cachedModTime = fileModificationTimes.get(filePath);
      
      // If we have a cached count and mod time hasn't changed, use cached count
      const cachedCount = lineCountCache.get(filePath);
      if (cachedCount !== undefined && cachedModTime === modTime) {
        return cachedCount;
      }
      
      // Update mod time
      fileModificationTimes.set(filePath, modTime);
      
      // If file is too large, estimate instead
      if (stats.size > 5000000) { // 5MB limit to prevent performance issues
        return Math.floor(stats.size / 50); // Rough estimate: 50 bytes per line
      }

      // Skip files with no extension or known binary extensions
      const ext = path.extname(filePath).toLowerCase();
      const binaryExtensions = ['.exe', '.dll', '.obj', '.bin', '.jpg', '.jpeg', '.png', '.gif', '.mp3', '.mp4', '.zip', '.gz', '.tar'];
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
  const skippedFolders = config.excludeFolders;
  
  // Skip files that are commonly large or binary
  const skippedFiles = config.excludeFiles;
  
  // Skip by filename directly
  const fileName = path.basename(filePath);
  if (skippedFiles.includes(fileName)) {
    return true;
  }
  
  // Check if path contains any of the skipped folders
  const normalizedPath = filePath.replace(/\\/g, '/'); // Normalize path for consistent checks
  for (const folder of skippedFolders) {
    const folderPattern = `/${folder}/`;
    const endPattern = `/${folder}`;
    
    if (normalizedPath.includes(folderPattern) || normalizedPath.endsWith(endPattern)) {
      return true;
    }
  }
  
  // Skip files over size threshold (over 1MB is likely not meaningful to count)
  try {
    const stats = fs.statSync(filePath);
    if (stats.size > 1024 * 1024) {
      return true;
    }
  } catch (error) {
    // If we can't access the file, best to skip it
    return true;
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
  
  // Skip files with binary extensions
  const binaryExtensions = [
    '.exe', '.dll', '.obj', '.bin', '.jpg', '.jpeg', '.png', '.gif', 
    '.mp3', '.mp4', '.mov', '.avi', '.zip', '.gz', '.tar', '.pdf', 
    '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.ttf', '.otf',
    '.woff', '.woff2', '.eot', '.ico', '.sqlite', '.db'
  ];
  
  if (binaryExtensions.includes(ext)) {
    return true;
  }
  
  return false;
}

// Save cache to persistent storage
async function saveCacheToStorage(context: vscode.ExtensionContext) {
  // Only save if cache has items and not during initial loading
  if (lineCountCache.size > 0 && !isInitialCountInProgress) {
    const cacheObj: Record<string, number> = {};
    const modTimeObj: Record<string, number> = {};
    
    // Limit cache size to prevent storage issues (max 5000 files)
    const entries = Array.from(lineCountCache.entries()).slice(0, 5000);
    
    entries.forEach(([file, count]) => {
      cacheObj[file] = count;
      // Also save modification time
      const modTime = fileModificationTimes.get(file);
      if (modTime) {
        modTimeObj[file] = modTime;
      }
    });
    
    await context.globalState.update('lineCountCache', cacheObj);
    await context.globalState.update('fileModificationTimes', modTimeObj);
  }
}

// Load cache from persistent storage
async function loadCacheFromStorage(context: vscode.ExtensionContext) {
  const cacheObj = context.globalState.get<Record<string, number>>('lineCountCache');
  const modTimeObj = context.globalState.get<Record<string, number>>('fileModificationTimes');
  
  if (cacheObj) {
    lineCountCache = new Map(Object.entries(cacheObj));
  }
  
  if (modTimeObj) {
    Object.entries(modTimeObj).forEach(([file, time]) => {
      fileModificationTimes.set(file, time);
    });
  }
}

// Main file decorator provider
class LineCountDecorationProvider implements vscode.FileDecorationProvider {
  private _onDidChangeFileDecorations = new vscode.EventEmitter<vscode.Uri | vscode.Uri[]>();
  readonly onDidChangeFileDecorations = this._onDidChangeFileDecorations.event;

  // Add a queue system to prevent too many concurrent operations
  private processingQueue = new Map<string, Promise<number>>();
  // Throttling parameters
  private pendingRefreshes = new Map<string, number>(); // File path -> timestamp
  private throttleTimer: NodeJS.Timeout | null = null;
  private context: vscode.ExtensionContext;
  
  // Track metrics for adaptive throttling
  private processingStartTimes = new Map<string, number>();
  private lastUIUpdateTime = Date.now();
  private consecutiveHighLoadCount = 0;
  // Flag to indicate if the extension is enabled
  private isEnabled = true;

  constructor(context: vscode.ExtensionContext) {
    this.context = context;
    this.isEnabled = config.enabled;
    
    // Set up periodic cache cleanup
    setInterval(() => this.cleanupOldCaches(), 5 * 60 * 1000); // Every 5 minutes
    
    // Set up adaptive throttling check
    if (!config.lowPerformanceMode) {
      setInterval(() => this.checkUIResponsiveness(), 30 * 1000); // Every 30 seconds
    } else {
      // In low performance mode, be more aggressive with throttling
      setInterval(() => this.checkUIResponsiveness(), 15 * 1000); // Every 15 seconds
    }
  }

  // Set enabled state
  setEnabled(enabled: boolean) {
    this.isEnabled = enabled;
    
    // If disabled, clear all decorations
    if (!enabled) {
      this._onDidChangeFileDecorations.fire([]);
    }
  }

  // Check if UI is responsive and adjust throttling
  private checkUIResponsiveness() {
    // If processing queue is large, increase throttling
    if (this.processingQueue.size > 10) {
      this.consecutiveHighLoadCount++;
      
      // Progressively reduce load if consistently high
      if (this.consecutiveHighLoadCount >= 3) {
        // Pause any non-critical processing for a while
        this.pendingRefreshes.clear();
        
        if (this.throttleTimer) {
          clearTimeout(this.throttleTimer);
          this.throttleTimer = null;
        }
      }
    } else {
      this.consecutiveHighLoadCount = 0;
    }
  }
  
  // Cleanup old caches to prevent memory leaks
  private cleanupOldCaches() {
    // Only perform cleanup when not in high-activity periods
    if (this.processingQueue.size > 5 || this.pendingRefreshes.size > 10) {
      return; // Skip cleanup during high load
    }
    
    const now = Date.now();
    
    // Remove decorations for files not accessed recently
    const oldDecorationsThreshold = now - (config.cacheLifetime * 60 * 60 * 1000); // Convert hours to ms
    
    // Limit cache size by removing old entries if too large
    if (lineCountCache.size > 10000) {
      const entries = Array.from(fileModificationTimes.entries());
      entries.sort((a, b) => a[1] - b[1]); // Sort by modification time
      
      // Remove oldest 20% of entries
      const removeCount = Math.floor(entries.length * 0.2);
      for (let i = 0; i < removeCount; i++) {
        if (i < entries.length) {
          const [filePath] = entries[i];
          lineCountCache.delete(filePath);
          fileDecorations.delete(filePath);
          fileModificationTimes.delete(filePath);
        }
      }
    }
  }

  async provideFileDecoration(uri: vscode.Uri): Promise<vscode.FileDecoration | undefined> {
    // If disabled, don't provide decorations
    if (!this.isEnabled || !config.enabled) {
      return undefined;
    }
    
    try {
      // Skip non-file schemes (like git:// or untitled:)
      if (uri.scheme !== 'file') {
        return undefined;
      }

      const filePath = uri.fsPath;
      
      // Quick reject of paths that should be skipped
      if (shouldSkipPath(filePath)) {
        return undefined;
      }
      
      // Check if we already have a decoration for this file
      const existingDecoration = fileDecorations.get(filePath);
      if (existingDecoration) {
        return existingDecoration;
      }
      
      try {
        // Track processing start time for performance metrics
        this.processingStartTimes.set(filePath, Date.now());
        
        // Lazy loading approach - only process files when they're requested
        // Check if file exists and is a regular file
        const stat = await fs.promises.stat(filePath);
        if (!stat.isFile()) {
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
                // Periodically save cache to storage
                this.scheduleCacheSave();
              }
              
              // Track processing time for performance metrics
              const startTime = this.processingStartTimes.get(filePath);
              if (startTime) {
                const processingTime = Date.now() - startTime;
                this.processingStartTimes.delete(filePath);
                
                // If file took too long to process, add to skip list for future
                if (processingTime > 1000) { // 1 second threshold
                  // Consider adding to more permanent skip list if this happens consistently
                }
              }
              
              // Remove from processing queue when done
              this.processingQueue.delete(filePath);
              return count;
            }).catch(err => {
              console.error(`Error counting lines in ${filePath}:`, err);
              this.processingQueue.delete(filePath);
              this.processingStartTimes.delete(filePath);
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

  // Throttled refresh to avoid too many updates
  refresh(resources?: vscode.Uri | vscode.Uri[]) {
    // If disabled, don't refresh
    if (!this.isEnabled || !config.enabled) {
      return;
    }
    
    // Measure time since last UI update to detect UI pressure
    const now = Date.now();
    const timeSinceLastUpdate = now - this.lastUIUpdateTime;
    this.lastUIUpdateTime = now;
    
    // If UI is under pressure (updates happening too frequently), increase throttling
    const baseThrottleTime = timeSinceLastUpdate < 100 ? 
      (config.throttleTime * 4) : config.throttleTime;
    
    // Add resources to pending refreshes with timestamp for prioritization
    if (resources) {
      if (Array.isArray(resources)) {
        resources.forEach(uri => {
          if (uri.scheme === 'file' && !shouldSkipPath(uri.fsPath)) {
            this.pendingRefreshes.set(uri.fsPath, now);
            lineCountCache.delete(uri.fsPath);
            fileDecorations.delete(uri.fsPath);
          }
        });
      } else if (resources.scheme === 'file' && !shouldSkipPath(resources.fsPath)) {
        this.pendingRefreshes.set(resources.fsPath, now);
        lineCountCache.delete(resources.fsPath);
        fileDecorations.delete(resources.fsPath);
      }
    }
    
    // If timer is already set, don't set another one
    if (this.throttleTimer !== null) {
      return;
    }
    
    // Set timer to process pending refreshes
    this.throttleTimer = setTimeout(() => {
      // Process limited number of files per batch
      const maxFilesToProcess = Math.min(50, this.pendingRefreshes.size);
      
      if (maxFilesToProcess > 0) {
        // Sort by timestamp (newest first)
        const entries = Array.from(this.pendingRefreshes.entries())
          .sort((a, b) => b[1] - a[1]);
          
        const urisToRefresh: vscode.Uri[] = [];
        
        // Take the most recent files
        for (let i = 0; i < maxFilesToProcess && i < entries.length; i++) {
          urisToRefresh.push(vscode.Uri.file(entries[i][0]));
          this.pendingRefreshes.delete(entries[i][0]);
        }
        
        // Fire event to refresh decorations
        if (urisToRefresh.length > 0) {
          this._onDidChangeFileDecorations.fire(urisToRefresh);
        }
      }
      
      // Set new timer if there are still pending refreshes
      this.throttleTimer = null;
      if (this.pendingRefreshes.size > 0) {
        // Use exponential backoff for remaining items
        const nextBatchDelay = Math.min(5000, baseThrottleTime * (1 + Math.log10(this.pendingRefreshes.size)));
        setTimeout(() => this.refresh(), nextBatchDelay);
      }
    }, baseThrottleTime);
  }
  
  // Schedule saving cache to storage with debounce
  private cacheSaveTimer: NodeJS.Timeout | null = null;
  private scheduleCacheSave() {
    if (this.cacheSaveTimer !== null) {
      clearTimeout(this.cacheSaveTimer);
    }
    
    this.cacheSaveTimer = setTimeout(() => {
      saveCacheToStorage(this.context);
      this.cacheSaveTimer = null;
    }, 30000); // Save every 30 seconds when changes occur
  }
}

// Main extension activation
export function activate(context: vscode.ExtensionContext) {
  console.log('LineSight extension activated');
  
  // Load configuration
  config = loadConfiguration();
  
  // Register configuration change listener
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(event => {
      if (event.affectsConfiguration('linesight')) {
        const newConfig = loadConfiguration();
        const wasEnabled = config.enabled;
        config = newConfig;
        
        // If enabled state changed, update provider
        if (wasEnabled !== config.enabled) {
          provider.setEnabled(config.enabled);
        }
        
        // If the extension is still enabled, refresh the watchers
        if (config.enabled) {
          setupFileWatcher(context, provider);
        } else if (fileWatcher) {
          // If disabled, remove watchers
          fileWatcher.dispose();
          fileWatcher = undefined;
        }
      }
    })
  );
  
  // If not enabled, just register the provider and return
  if (!config.enabled) {
    const provider = new LineCountDecorationProvider(context);
    context.subscriptions.push(
      vscode.window.registerFileDecorationProvider(provider)
    );
    return;
  }
  
  // Load cache from storage
  loadCacheFromStorage(context);
  
  // Create provider and register it
  const provider = new LineCountDecorationProvider(context);
  context.subscriptions.push(
    vscode.window.registerFileDecorationProvider(provider)
  );
  
  // Set up file system watcher with optimized patterns
  setupFileWatcher(context, provider);
  
  // Initialize decorations for visible files only with a delay
  if (config.countLinesOnStartup) {
    setTimeout(() => {
      initializeVisibleFiles(provider);
    }, config.scanDelay); // Use configured delay
  }
  
  // Save cache when extension is deactivated
  context.subscriptions.push({
    dispose: () => {
      saveCacheToStorage(context);
    }
  });
  
  // Register command to manually refresh all line counts
  const refreshCommand = vscode.commands.registerCommand('linesight.refresh', async () => {
    // Clear cache to force recounting
    lineCountCache.clear();
    
    // Refresh all files
    await initializeDecorations(provider);
  });
  
  // Register command to toggle extension
  const toggleCommand = vscode.commands.registerCommand('linesight.toggle', async () => {
    config.enabled = !config.enabled;
    
    // Update configuration
    await vscode.workspace.getConfiguration('linesight').update('enabled', config.enabled, true);
    
    // Update provider
    provider.setEnabled(config.enabled);
    
    vscode.window.showInformationMessage(`LineSight ${config.enabled ? 'enabled' : 'disabled'}`);
  });
  
  context.subscriptions.push(refreshCommand, toggleCommand);
  
  // Watch for workspace folder changes
  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      if (config.enabled) {
        setupFileWatcher(context, provider);
        // Only initialize visible files to reduce overhead
        initializeVisibleFiles(provider);
      }
    })
  );

  // Register status bar item
  const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBarItem.text = "$(eye) LineSight";
  statusBarItem.tooltip = "Toggle LineSight line count decorations";
  statusBarItem.command = "linesight.toggle";
  statusBarItem.show();
  
  context.subscriptions.push(statusBarItem);
}

// Optimize how batches of files are processed
async function processFilesBatch(files: vscode.Uri[], provider: LineCountDecorationProvider, maxFilesPerBatch = 100) {
  // Sort files by extension to prioritize most relevant files first
  const priorityExtensions = ['.js', '.ts', '.py', '.go', '.java', '.c', '.cpp', '.cs'];
  
  // Sort function that prioritizes certain file types
  const sortedFiles = [...files].sort((a, b) => {
    const extA = path.extname(a.fsPath).toLowerCase();
    const extB = path.extname(b.fsPath).toLowerCase();
    
    const priorityA = priorityExtensions.includes(extA) ? 0 : 1;
    const priorityB = priorityExtensions.includes(extB) ? 0 : 1;
    
    return priorityA - priorityB;
  });
  
  // Process in smaller batches
  const batchSize = Math.min(maxFilesPerBatch, 100);
  for (let i = 0; i < sortedFiles.length; i += batchSize) {
    const batch = sortedFiles.slice(i, i + batchSize);
    
    // Process the batch
    provider.refresh(batch);
    
    // Yield to other tasks between batches
    if (i + batchSize < sortedFiles.length) {
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  }
}

// Initialize only visible files to reduce overhead
async function initializeVisibleFiles(provider: LineCountDecorationProvider) {
  // Get files from visible text editors
  const openFiles = vscode.window.visibleTextEditors
    .map(editor => editor.document.uri)
    .filter(uri => uri.scheme === 'file' && !shouldSkipPath(uri.fsPath));
  
  if (openFiles.length > 0) {
    await processFilesBatch(openFiles, provider, 20); // Small batch for visible files
  }
  
  // After processing open files, schedule a background scan for files likely to be viewed
  setTimeout(async () => {
    try {
      if (!vscode.workspace.workspaceFolders) return;
      
      // Look for common source directories to scan
      const sourceDirs = ['src', 'lib', 'app', 'main'];
      
      for (const folder of vscode.workspace.workspaceFolders) {
        for (const dir of sourceDirs) {
          try {
            const dirPath = path.join(folder.uri.fsPath, dir);
            // Check if directory exists
            await fs.promises.stat(dirPath);
            
            // Find key files in this directory
            const pattern = new vscode.RelativePattern(
              vscode.Uri.file(dirPath), 
              '**/*.{js,ts,py,go,java}'
            );
            const files = await vscode.workspace.findFiles(pattern, null, 100);
            
            if (files.length > 0) {
              await processFilesBatch(files, provider, 50);
            }
          } catch (error) {
            // Directory doesn't exist, skip
          }
        }
      }
    } catch (error) {
      console.log('Error scanning source directories:', error);
    }
  }, 5000); // Delay background scan
}

// Initialize decorations for all files
async function initializeDecorations(provider: LineCountDecorationProvider) {
  // If disabled, don't initialize
  if (!config.enabled) {
    return;
  }
  
  // Get all workspace folders
  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (!workspaceFolders) return;

  isInitialCountInProgress = true;
  vscode.window.showInformationMessage('LineSight is counting lines in your files...');

  // Force refresh on all files in workspace
  for (const folder of workspaceFolders) {
    try {
      // Define file patterns to include - limit to most common code files
      const includePattern = '**/*.{js,jsx,ts,tsx,go,py,java,c,cpp,cs,php,rb,rs}';
      
      // Define patterns to exclude
      let excludePatterns = [];
      for (const folder of config.excludeFolders) {
        excludePatterns.push(`**/${folder}/**`);
      }
      const excludePattern = `{${excludePatterns.join(',')}}`;
      
      // Find all matching files
      const files = await vscode.workspace.findFiles(
        new vscode.RelativePattern(folder, includePattern),
        excludePattern,
        config.maxFilesToProcess / 3 // Limit per workspace folder
      );
      
      console.log(`Found ${files.length} files to process in ${folder.name}`);
      
      // Process files in optimized batches
      await processFilesBatch(files, provider, config.lowPerformanceMode ? 50 : 100);
      
      // In low performance mode, skip docs/config files
      if (!config.lowPerformanceMode) {
        // After source code files, process documentation and config files with lower priority
        const docAndConfigPattern = '**/*.{html,css,scss,less,json,yaml,yml,xml,md,txt}';
        const docFiles = await vscode.workspace.findFiles(
          new vscode.RelativePattern(folder, docAndConfigPattern),
          excludePattern,
          config.maxFilesToProcess / 5 // Lower limit for non-source files
        );
        
        console.log(`Found ${docFiles.length} documentation/config files to process`);
        
        // Process with smaller batch size and longer delays
        const docBatchSize = config.lowPerformanceMode ? 25 : 50;
        for (let i = 0; i < docFiles.length; i += docBatchSize) {
          const batch = docFiles.slice(i, i + docBatchSize);
          provider.refresh(batch);
          
          await new Promise(resolve => setTimeout(resolve, 100)); // Longer delay
        }
      }
    } catch (error) {
      console.error(`Error initializing decorations for ${folder.uri.fsPath}:`, error);
    }
  }

  isInitialCountInProgress = false;
  vscode.window.showInformationMessage('LineSight is ready!');
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
    // Watch only the most common source code file types
    const sourceCodePattern = new vscode.RelativePattern(
      folder, 
      '**/*.{js,jsx,ts,tsx,py,go,java,c,cpp,cs,rs}'
    );
    
    // Less aggressive watching for less frequently changed files
    const lessFrequentPattern = new vscode.RelativePattern(
      folder,
      '**/*.{php,rb,html,css,scss,less}'
    );
    
    // Minimal watching for rarely changed files
    const rarelyChangedPattern = new vscode.RelativePattern(
      folder,
      '**/*.{json,yaml,yml,xml,md,txt}'
    );
    
    // Create watchers with optimized settings
    // For frequently changed files
    const watcher = vscode.workspace.createFileSystemWatcher(sourceCodePattern, false, true, false);
    // For less frequently changed files, only track create/delete
    const lessFrequentWatcher = vscode.workspace.createFileSystemWatcher(lessFrequentPattern, false, true, false);
    // For rarely changed files, only track create/delete
    const rarelyChangedWatcher = vscode.workspace.createFileSystemWatcher(rarelyChangedPattern, false, true, false);
    
    // Use a debounced function for file changes with more aggressive throttling
    let changeTimeout: NodeJS.Timeout | null = null;
    const changedFiles = new Map<string, number>(); // File path -> priority
    
    const processChangedFiles = () => {
      if (changedFiles.size === 0) return;
      
      // Process higher priority files first (lower number = higher priority)
      const sortedFiles = Array.from(changedFiles.entries())
        .sort((a, b) => a[1] - b[1])
        .map(([file]) => vscode.Uri.file(file));
      
      // Process in smaller batches to reduce impact
      if (sortedFiles.length <= 5) {
        provider.refresh(sortedFiles);
      } else {
        // For larger batches, process incrementally
        const firstBatch = sortedFiles.slice(0, 5);
        provider.refresh(firstBatch);
        
        // Schedule remaining files with delay
        setTimeout(() => {
          const remainingFiles = sortedFiles.slice(5);
          processFilesBatch(remainingFiles, provider, 10);
        }, 2000);
      }
      
      changedFiles.clear();
    };
    
    // Add file to changed set with priority
    const addChangedFile = (uri: vscode.Uri, priority: number) => {
      if (uri.scheme !== 'file' || shouldSkipPath(uri.fsPath)) return;
      
      // Check if file exists before adding
      try {
        const stats = fs.statSync(uri.fsPath);
        if (stats.isFile()) {
          changedFiles.set(uri.fsPath, priority);
          
          // Clear existing timeout
          if (changeTimeout) {
            clearTimeout(changeTimeout);
          }
          
          // Set new timeout with adaptive delay based on number of pending files
          const delay = Math.min(5000, Math.max(2000, changedFiles.size * 100));
          changeTimeout = setTimeout(processChangedFiles, delay);
        }
      } catch (error) {
        // File doesn't exist or inaccessible, remove from caches
        lineCountCache.delete(uri.fsPath);
        fileDecorations.delete(uri.fsPath);
        fileModificationTimes.delete(uri.fsPath);
      }
    };
    
    // When a file is changed, update its line count with debouncing
    watcher.onDidChange(uri => addChangedFile(uri, 1)); // Priority 1 (highest)
    lessFrequentWatcher.onDidChange(uri => addChangedFile(uri, 2)); // Priority 2
    rarelyChangedWatcher.onDidChange(uri => addChangedFile(uri, 3)); // Priority 3
    
    // When a file is created, add to tracking
    watcher.onDidCreate(uri => addChangedFile(uri, 1));
    lessFrequentWatcher.onDidCreate(uri => addChangedFile(uri, 2));
    rarelyChangedWatcher.onDidCreate(uri => addChangedFile(uri, 3));
    
    // Handle file deletion
    const handleDelete = (uri: vscode.Uri) => {
      if (uri.scheme === 'file') {
        lineCountCache.delete(uri.fsPath);
        fileDecorations.delete(uri.fsPath);
        fileModificationTimes.delete(uri.fsPath);
      }
    };
    
    watcher.onDidDelete(handleDelete);
    lessFrequentWatcher.onDidDelete(handleDelete);
    rarelyChangedWatcher.onDidDelete(handleDelete);
    
    // Register watchers
    context.subscriptions.push(watcher, lessFrequentWatcher, rarelyChangedWatcher);
    watchers.push(watcher, lessFrequentWatcher, rarelyChangedWatcher);
  }
  
  // Store all watchers
  fileWatcher = {
    dispose: () => {
      watchers.forEach(w => w.dispose());
    }
  };
}

// Called when extension is deactivated
export function deactivate() {
  lineCountCache.clear();
  fileDecorations.clear();
  fileModificationTimes.clear();
  if (fileWatcher) {
    fileWatcher.dispose();
  }
} 