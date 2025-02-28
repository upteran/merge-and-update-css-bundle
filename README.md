# CSS Module Merge Plugin

A plugin that automatically merges and deduplicates CSS module files in your build output directory. It provides atomic file updates and maintains a consistent stylesheet through symbolic links.

## Purpose

This plugin solves several common problems when working with CSS modules in build systems:

1. Automatically combines multiple `.module.css` files into a single output file
2. Deduplicates CSS rules to prevent redundancy
3. Provides atomic updates to prevent style flickering during rebuilds
4. Maintains file system consistency using symlinks and backup files
5. Handles concurrent file operations safely

## Installation

```bash
npm install css-module-merge-plugin
# or
pnpm install css-module-merge-plugin
```

```bash
pnpm install
```

To build the project:

```bash
pnpm build
```

Built files will be output to the `dist/` directory.

## Prerequisites

- Node.js
- pnpm (Package Manager)

## Testing

Test files are written with TypeScript and are located in the `tests/` directory.

## API

### mergeCssPlugin(outputFile, outputDir, options)

Creates a new instance of the merge CSS plugin.

#### Parameters:

- `outputFile` (string): The path where the final merged CSS file should be written
- `outputDir` (string): The directory to scan for CSS module files
- `options` (MergeCssPluginOptions): Configuration options

```typescript
type MergeCssPluginOptions = {
  extensions?: string[];     // File extensions to process (default: ['.module.css'])
  deduplicate?: boolean;     // Whether to remove duplicate rules (default: true)
  verbose?: boolean;         // Enable detailed logging (default: true)
}
```

#### Usage Example:

```typescript
import { mergeCssPlugin } from 'css-module-merge-plugin';

const plugin = mergeCssPlugin(
  'dist/styles.css',        // output file
  'dist',                   // directory to scan
  {
    verbose: true,          // enable logging
    deduplicate: true       // remove duplicates
  }
);
```

## Plugin Methods

### onSuccess()

Automatically triggered after a successful build. This method:
- Scans the output directory for `.module.css` files
- Merges all found CSS files
- Deduplicates rules using postcss
- Performs atomic updates of the output file

### onClear()

Clears all merged styles. Useful for clean builds or resets.

### dispose()

Cleanup method to properly close file handles and remove temporary files.

## File Structure

The plugin maintains several files for atomic updates:
- `styles.css`: Main symlink that applications should reference
- `.styles.shadow.css`: Internal symlink for atomic updates
- `styles.temp.css` and `styles.backup.css`: Alternating files for atomic writes

## Features

1. **Atomic Updates**: Uses a symlink-based system to prevent file corruption during updates
2. **Deduplication**: Removes duplicate CSS rules using postcss
3. **Parallel Processing**: Handles file operations in batches for better performance
4. **Error Recovery**: Includes rollback mechanisms for failed operations
5. **Resource Cleanup**: Properly handles file descriptors and cleanup on process exit

## Example Integration

```typescript
import { build } from 'your-build-system';
import { mergeCssPlugin } from 'css-module-merge-plugin';

build({
  plugins: [
    mergeCssPlugin('dist/styles.css', 'dist', {
      verbose: true,
      deduplicate: true
    })
  ]
});
```

## Error Handling

The plugin includes comprehensive error handling and logging:
- File system operation errors are caught and logged
- Symlink verification ensures file system consistency
- Atomic updates include rollback mechanisms
- Resource cleanup on process termination

## Limitations

1. Requires file system support for symlinks
- File system with symlink support:
  - Unix-based systems (Linux, macOS): Supported by default
  - Windows: 
    - Requires Developer Mode OR
    - Administrative privileges OR
    - Node.js with --enable-symlinks flag
2. Designed for `.module.css` files by default
3. Requires write permissions in the output directory
