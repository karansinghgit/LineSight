# LineSight

VS Code extension that displays line counts in the file explorer with minimal overhead.

![LineSight Screenshot](screenshot.png)

## Features

- Shows the line count for each file as a decoration in the file explorer
- Optimized for performance with minimal impact on VS Code
- Intelligent caching to avoid recounting unchanged files
- Configurable to suit your performance needs
- Persistent cache between sessions
- Lazy loading of line counts for files as they become visible
- Adaptive throttling based on system load

## Performance Optimizations

LineSight has been carefully optimized to run efficiently in the background without impacting your VS Code experience:

1. **Lazy Loading**: Only counts lines for files that are visible in the explorer or likely to be viewed soon
2. **Smart Caching**: Caches line counts in memory and persists them between sessions
3. **Efficient Line Counting**: Uses streaming and sampling techniques to count lines efficiently
4. **Throttled Processing**: Limits concurrent operations to prevent overloading the system
5. **Adaptive Throttling**: Adjusts processing speed based on system responsiveness
6. **Intelligent Filtering**: Skips large files, binary files, and files in common exclude directories
7. **Low Performance Mode**: Optional mode that further reduces resource usage for large projects
8. **Configurable Settings**: Fine-tune performance parameters to suit your environment

## Usage

After installation, line counts will automatically appear next to files in the explorer. The extension tries to be as unobtrusive as possible.

- Use the `LineSight: Refresh Line Counts` command to manually refresh all line counts
- Use the `LineSight: Toggle Line Count Decorations` command to enable/disable the extension
- Click the `LineSight` status bar item to toggle the extension on/off

## Configuration

LineSight offers several configuration options to customize its behavior and performance impact:

| Setting | Description | Default |
|---------|-------------|---------|
| `linesight.enabled` | Enable or disable line count decorations | `true` |
| `linesight.countLinesOnStartup` | Automatically count lines when VS Code starts | `true` |
| `linesight.excludeFolders` | List of folder names to exclude | Various common folders |
| `linesight.excludeFiles` | List of file names to exclude | Various common files |
| `linesight.maxFilesToProcess` | Maximum number of files to process | `5000` |
| `linesight.maxFileSizeToRead` | Maximum file size in KB to read fully | `5000` |
| `linesight.scanDelay` | Delay in ms before starting to scan files | `3000` |
| `linesight.throttleTime` | Base throttle time in ms for refreshing | `500` |
| `linesight.cacheLifetime` | Lifetime of cached line counts in hours | `24` |
| `linesight.lowPerformanceMode` | Enable low performance mode | `false` |

## Low Performance Mode

If you're working with very large projects or on a slower machine, you can enable `linesight.lowPerformanceMode` to:

- Process fewer files at once
- Increase throttling delays
- Skip non-essential file types
- Reduce concurrent operations
- More aggressively filter files

## How it Works

LineSight uses a series of optimizations to efficiently count lines:

1. For small and medium files (<5MB), it uses an efficient stream-based line counter
2. For large files (>5MB), it uses a sampling approach to estimate line counts
3. File modification times are tracked to avoid recounting unchanged files
4. Files are processed in small batches with adaptive delays between batches
5. A priority queue ensures the most relevant files are processed first
6. Periodic cleanup prevents memory leaks from old cached items

## Troubleshooting

If the extension is causing performance issues:

1. Enable low performance mode in settings
2. Increase the throttle time setting
3. Reduce the maximum files to process setting
4. Add more folders to the exclude list
5. Disable automatically counting lines on startup

## License

This extension is licensed under the MIT License. 