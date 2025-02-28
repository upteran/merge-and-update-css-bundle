import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import postcss from 'postcss';
import postcssDiscardDuplicates from 'postcss-discard-duplicates';

// Helper function to recursively find files with specific extensions
const getAllFiles = async (
  dir: string,
  pattern: RegExp,
  exclude: string[] = [],
  verbose = false
) => {
  let files: string[] = [];
  const entries = await fs.promises.readdir(dir, { withFileTypes: true });

  if (verbose) {
    console.log(`Scanning directory: ${dir}`);
    console.log(`Looking for pattern: ${pattern}`);
  }

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);

    if (exclude.includes(fullPath)) {
      if (verbose) console.log(`Skipping excluded path: ${fullPath}`);
      continue;
    }

    if (entry.isDirectory()) {
      if (entry.name === 'node_modules') {
        if (verbose) console.log(`Skipping node_modules: ${fullPath}`);
        continue;
      }
      if (verbose) console.log(`Scanning subdirectory: ${fullPath}`);
      const subDirFiles = await getAllFiles(
        fullPath,
        pattern,
        exclude,
        verbose
      );
      files = files.concat(subDirFiles);
    } else if (entry.isFile() && pattern.test(entry.name)) {
      if (verbose) console.log(`Found matching file: ${fullPath}`);
      files.push(fullPath);
    }
  }

  return files;
};

// Helper function to calculate hash of a single file using streams
const calculateFileHash = async (filePath: string): Promise<string> => {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);

    stream.on('data', data => hash.update(data));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
};

// Helper function to calculate combined hash of multiple files
const calculateHash = async (files: string[]): Promise<string> => {
  const finalHash = crypto.createHash('sha256');

  // Process files in parallel with a concurrency limit of 5
  const batchSize = 5;
  for (let i = 0; i < files.length; i += batchSize) {
    const batch = files.slice(i, i + batchSize);
    const hashes = await Promise.all(
      batch.map(file => calculateFileHash(file))
    );
    hashes.forEach(hash => finalHash.update(hash));
  }

  return finalHash.digest('hex');
};

type MergeCssPluginOptions = {
  extensions?: string[];
  deduplicate?: boolean;
  verbose?: boolean;
};

// Plugin to merge and deduplicate CSS files
export const mergeCssPlugin = (
  outputFile: string,
  outputDir: string,
  options: MergeCssPluginOptions = {}
) => {
  const { verbose = true } = options;

  // Ensure paths are absolute
  const absoluteOutputDir = path.resolve(outputDir);
  const absoluteOutputFile = path.resolve(outputFile);

  // Update path construction to ensure correct relative paths
  const tempFile = path.join(
    path.dirname(absoluteOutputFile),
    'styles.temp.css'
  );
  const backupFile = path.join(
    path.dirname(absoluteOutputFile),
    'styles.backup.css'
  );
  const mainStylesLink = path.join(absoluteOutputDir, 'styles.css');
  const shadowLink = path.join(
    path.dirname(mainStylesLink),
    '.styles.shadow.css'
  );

  if (verbose) {
    console.log('Plugin initialized with paths:');
    console.log('Output directory:', absoluteOutputDir);
    console.log('Output file:', absoluteOutputFile);
    console.log('Main styles link:', mainStylesLink);
  }

  let lastKnownFiles = new Set<string>();
  let lastKnownHash = '';

  // Store FileHandle objects instead of raw file descriptors
  let tempFileHandle: fs.promises.FileHandle | null = null;
  let backupFileHandle: fs.promises.FileHandle | null = null;

  async function setupInitialFiles() {
    try {
      if (!tempFileHandle) {
        tempFileHandle = await fs.promises.open(tempFile, 'a+');
      }
      if (!backupFileHandle) {
        backupFileHandle = await fs.promises.open(backupFile, 'a+');
      }

      // Add debug logging
      if (verbose) {
        console.log('Setting up files with paths:');
        console.log('Main styles link:', mainStylesLink);
        console.log('Shadow link:', shadowLink);
        console.log('Backup file:', backupFile);
        console.log('Temp file:', tempFile);
      }

      // Create directories if they don't exist
      await fs.promises.mkdir(path.dirname(mainStylesLink), {
        recursive: true
      });
      await fs.promises.mkdir(path.dirname(shadowLink), { recursive: true });

      // Remove existing links if they're invalid
      try {
        const shadowTarget = await fs.promises.readlink(shadowLink);
        if (!fs.existsSync(shadowTarget)) {
          await fs.promises.unlink(shadowLink);
        }
      } catch (e) {
        // Ignore errors if link doesn't exist
      }

      try {
        const mainTarget = await fs.promises.readlink(mainStylesLink);
        if (!fs.existsSync(mainTarget)) {
          await fs.promises.unlink(mainStylesLink);
        }
      } catch (e) {
        // Ignore errors if link doesn't exist
      }

      // Create shadow link if it doesn't exist
      if (!fs.existsSync(shadowLink)) {
        if (verbose) console.log('Creating shadow link');
        await fs.promises.symlink(backupFile, shadowLink, 'file');
      }

      // Create main link if it doesn't exist
      if (!fs.existsSync(mainStylesLink)) {
        if (verbose) console.log('Creating main styles link');
        await fs.promises.symlink(shadowLink, mainStylesLink, 'file');
      }

      // Verify the links are created correctly
      if (verbose) {
        try {
          const shadowTarget = await fs.promises.readlink(shadowLink);
          const mainTarget = await fs.promises.readlink(mainStylesLink);
          console.log('Shadow link points to:', shadowTarget);
          console.log('Main styles link points to:', mainTarget);
        } catch (e) {
          console.error('Error verifying links:', e);
        }
      }
    } catch (error) {
      console.error('Error during initial setup:', error);
      await cleanup();
      throw error;
    }
  }

  async function atomicStyleUpdate(newContent: string, forceUpdate = false): Promise<boolean> {
    try {
      // Early return for empty content
      if (!newContent.trim() && !forceUpdate) {
        if (verbose) console.log('Skipping update with empty content');
        return false;
      }

      // Get current shadow link target with a single read
      let currentTarget: string;
      try {
        currentTarget = await fs.promises.readlink(shadowLink);
      } catch (error) {
        // Handle initial setup case
        await fs.promises.writeFile(backupFile, newContent, { mode: 0o644 });
        await fs.promises.symlink(backupFile, shadowLink);
        await fs.promises.symlink(shadowLink, mainStylesLink);
        return true;
      }

      const isUsingBackup = currentTarget === backupFile;
      const activeFile = isUsingBackup ? tempFile : backupFile;
      const inactiveFile = isUsingBackup ? backupFile : tempFile;

      // Write new content to inactive file
      await fs.promises.writeFile(activeFile, newContent);

      try {
        // Atomic switch using symlink
        await fs.promises.unlink(shadowLink);
        await fs.promises.symlink(activeFile, shadowLink);

        // Copy content to the other file for next switch
        await fs.promises.writeFile(inactiveFile, newContent);

        return true;
      } catch (error) {
        // Rollback in case of failure
        try {
          await fs.promises.unlink(shadowLink);
          await fs.promises.symlink(currentTarget, shadowLink);
        } catch (rollbackError) {
          console.error('Critical: Failed to rollback symlink:', rollbackError);
        }
        throw error;
      }
    } catch (error) {
      console.error('Error during atomic style update:', error);
      return false;
    }
  }

  // Explicit cleanup function
  async function cleanup() {
    try {
      if (tempFileHandle) {
        await tempFileHandle.close();
        tempFileHandle = null;
      }
      if (backupFileHandle) {
        await backupFileHandle.close();
        backupFileHandle = null;
      }
    } catch (error) {
      console.error('Error during cleanup:', error);
    }
  }

  const plugin = {
    name: 'merge-css-plugin',

    async onSuccess() {
      console.log(`🔍 Processing CSS files in: ${outputDir}`);

      try {
        await setupInitialFiles();

        const moduleFiles = await getAllFiles(
          outputDir,
          /\.module\.css$/,
          [absoluteOutputFile, tempFile, backupFile],
          verbose
        );

        if (verbose) {
          console.log('Found module.css files:', moduleFiles);
        }

        // Read current content before any changes
        let currentContent = '';
        try {
          const currentTarget = await fs.promises.readlink(shadowLink);
          currentContent = await fs.promises.readFile(currentTarget, 'utf8');
        } catch (error) {
          // @ts-expect-error fixme
          if (error.code !== 'ENOENT') {
            console.error('Error reading current content:', error);
          }
        }

        if (moduleFiles.length > 0) {
          // Calculate hash before reading file contents
          const currentHash = await calculateHash(moduleFiles);

          if (
            currentHash !== lastKnownHash ||
            moduleFiles.length !== lastKnownFiles.size ||
            !moduleFiles.every(file => lastKnownFiles.has(file))
          ) {
            // Process files in batches to avoid memory issues
            const batchSize = 5;
            let combinedContent = '';

            for (let i = 0; i < moduleFiles.length; i += batchSize) {
              const batch = moduleFiles.slice(i, i + batchSize);
              // eslint-disable-next-line no-await-in-loop
              const contents = await Promise.all(
                batch.map(file => fs.promises.readFile(file, 'utf8'))
              );
              combinedContent += contents.join('\n');
            }

            console.log('combinedContent', combinedContent)
            const result = await postcss([postcssDiscardDuplicates]).process(
              combinedContent,
              {
                from: undefined,
                map: false
              }
            );

            console.log('combinedContent result', result)

            const success = await atomicStyleUpdate(result.css);

            if (success) {
              lastKnownFiles = new Set(moduleFiles);
              lastKnownHash = currentHash;
              console.log(`✅ Updated styles successfully`);
            }
          } else if (verbose) {
            console.log(
              'No changes detected in module files, preserving existing styles'
            );
            // Ensure we preserve the current content when no changes
            if (currentContent.trim()) {
              await atomicStyleUpdate(currentContent);
            }
          }
        } else {
          // If no module files found, preserve existing content if it exists
          // eslint-disable-next-line no-lonely-if
          if (currentContent.trim()) {
            if (verbose) {
              console.log('No module files found, preserving existing styles');
            }
            await atomicStyleUpdate(currentContent);
          } else {
            if (verbose) {
              console.log(
                'No module files found and no existing styles to preserve'
              );
            }
            await atomicStyleUpdate('');
          }
        }
      } catch (error) {
        console.error('❌ Error during processing:', error);
        // @ts-expect-error fixme
        console.error('Stack trace:', error.stack);
      }
    },

    async onClear() {
      try {
        // Pass true as the second parameter to force the update even with empty content
        await atomicStyleUpdate('', true);
        console.log('🧹 Styles cleared successfully');
      } catch (error) {
        console.error('❌ Error during clear:', error);
      }
    },

    // Add dispose method for cleanup
    async dispose() {
      await cleanup();
    }
  };

  // Ensure cleanup happens on process exit
  process.on('exit', () => {
    if (tempFileHandle || backupFileHandle) {
      cleanup().catch(console.error);
    }
  });

  // Also handle other termination signals
  ['SIGINT', 'SIGTERM', 'SIGQUIT'].forEach(signal => {
    process.on(signal, async () => {
      await cleanup();
      process.exit(0);
    });
  });

  return plugin;
};
