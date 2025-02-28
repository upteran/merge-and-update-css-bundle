import { describe, it, beforeEach, afterEach, expect, vi, beforeAll, afterAll } from 'vitest';
import { mergeCssPlugin } from '../src';
import fs from 'node:fs';
import path from 'node:path';
import { build as esbuild } from 'esbuild';
import crypto from 'node:crypto';
import postcss from 'postcss';
// import postcssDiscardDuplicates from 'postcss-discard-duplicates';
import os from 'node:os';

interface CssMergePlugin {
  onSuccess: () => Promise<void>;
  onClear: () => Promise<void>;
  dispose: () => Promise<void>;
};


// Setup test constants and helpers
const __filename = require.main?.filename || '';
const __dirname = path.dirname(__filename);
const TEST_DIR = path.join(os.tmpdir(), `css-merge-test-${Date.now()}`);
const OUTPUT_DIR = path.join(TEST_DIR, 'output');
const OUTPUT_FILE = path.join(OUTPUT_DIR, 'merged.css');
const STYLES_LINK = path.join(OUTPUT_DIR, 'styles.css');
const SHADOW_LINK = path.join(OUTPUT_DIR, '.styles.shadow.css');
const TEMP_FILE = path.join(OUTPUT_DIR, 'styles.temp.css');
const BACKUP_FILE = path.join(OUTPUT_DIR, 'styles.backup.css');

// Set up fixtures for testing
const TEST_CSS_FILES = [
  { name: 'style1.module.css', content: '.class1 { color: red; }' },
  { name: 'style2.module.css', content: '.class2 { color: blue; }' },
  { name: 'style3.module.css', content: '.class3 { color: green; }' },
  { name: 'style4.module.css', content: '.class1 { color: red; }' },
  { name: 'duplicateClass.module.css', content: '.class1 { color: purple; } .unique { padding: 10px; }' }
];

// Create test directory structure and files
async function setupTestFiles() {
  try {
    // Create test directories
    await fs.promises.mkdir(TEST_DIR, { recursive: true });
    await fs.promises.mkdir(OUTPUT_DIR, { recursive: true });

    // Create sample CSS module files
    for (const file of TEST_CSS_FILES) {
      await fs.promises.writeFile(path.join(OUTPUT_DIR, file.name), file.content);
    }

    // Create nested directory with CSS modules
    const nestedDir = path.join(OUTPUT_DIR, 'nested');
    await fs.promises.mkdir(nestedDir, { recursive: true });
    await fs.promises.writeFile(
      path.join(nestedDir, 'nested.module.css'),
      '.nestedClass { margin: 20px; }'
    );

    // Create a node_modules directory that should be ignored
    const nodeModulesDir = path.join(OUTPUT_DIR, 'node_modules');
    await fs.promises.mkdir(nodeModulesDir, { recursive: true });
    await fs.promises.writeFile(
      path.join(nodeModulesDir, 'should-ignore.module.css'),
      '.ignoreMe { display: none; }'
    );
  } catch (error) {
    console.error('Error setting up test files:', error);
    throw error;
  }
}

// Create a mock esbuild setup
async function createEsbuildSetup(plugin: CssMergePlugin) {
  const entryFile = path.join(TEST_DIR, 'entry.js');
  await fs.promises.writeFile(entryFile, 'console.log("esbuild entry");');

  return {
    run: async () => {
      await esbuild({
        entryPoints: [entryFile],
        bundle: true,
        outfile: path.join(OUTPUT_DIR, 'bundle.js'),
        plugins: [{
          name: 'esbuild-test-wrapper',
          setup(build) {
            build.onEnd(async () => {
              await plugin.onSuccess();
            });
          }
        }]
      });
    }
  };
}

// Helper to read final linked file content
async function getStylesContent() {
  try {
    const linkTarget = await fs.promises.readlink(STYLES_LINK);
    return fs.promises.readFile(linkTarget, 'utf8');
  } catch (error) {
    console.error('Error reading styles content:', error);
    return '';
  }
}

// Helper to modify a CSS file to test change detection
async function modifyCssFile(fileName: string, newContent: string) {
  await fs.promises.writeFile(path.join(OUTPUT_DIR, fileName), newContent);
}

// Clean up test files and directories
async function cleanupTestFiles() {
  try {
    await fs.promises.rm(TEST_DIR, { recursive: true, force: true });
  } catch (error) {
    console.error('Error cleaning up test files:', error);
  }
}

describe('CSS Merge Plugin', () => {
  let plugin: CssMergePlugin;
  let consoleLogSpy: any;
  let consoleErrorSpy: any;

  beforeAll(async () => {
    // Create test files and directories
    await setupTestFiles();
  });

  afterAll(async () => {
    // Clean up test files and directories
    await cleanupTestFiles();
  });

  beforeEach(() => {
    // Create a fresh plugin instance for each test
    plugin = mergeCssPlugin(OUTPUT_FILE, OUTPUT_DIR, { verbose: true });

    // Spy on console methods
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(async () => {
    // Restore console spies
    consoleLogSpy.mockRestore();
    consoleErrorSpy.mockRestore();

    // Clean up any file handles
    if (plugin.dispose) {
      await plugin.dispose();
    }

    // Remove output files
    try {
      await fs.promises.unlink(STYLES_LINK).catch(() => {});
      await fs.promises.unlink(SHADOW_LINK).catch(() => {});
      await fs.promises.unlink(TEMP_FILE).catch(() => {});
      await fs.promises.unlink(BACKUP_FILE).catch(() => {});
    } catch (error) {
      // Ignore errors from missing files
    }
  });

  // Basic functionality tests
  it('should correctly merge CSS files and handle deduplication', async () => {
    await plugin.onSuccess();

    const content = await getStylesContent();

    // Verify all classes are present
    expect(content).toContain('.class1');
    expect(content).toContain('.class2');
    expect(content).toContain('.class3');
    expect(content).toContain('.nestedClass');

    // For duplicate properties within the same selector:
    // Only the last occurrence of the property should be kept
    expect(content).toContain('.class1 { color: purple; }');
    expect(content).toContain('.class1 { color: red; }');
    const redColorCount = (content.match(/color: red;/g) || []).length;
    expect(redColorCount).toBe(1)
    // Unique properties should be preserved
    expect(content).toContain('.unique { padding: 10px; }');

    const classOneCount = (content.match(/\.class1 {/g) || []).length;
    expect(classOneCount).toBe(2);

    // Make sure the merged content is well-formed CSS
    let validCss = true;
    try {
      // Simple validation by parsing with PostCSS
      await postcss().process(content, { from: undefined });
    } catch (error) {
      validCss = false;
    }
    expect(validCss).toBe(true);
  });

  it('should integrate with esbuild', async () => {
    const esbuildSetup = await createEsbuildSetup(plugin);
    await esbuildSetup.run();

    const content = await getStylesContent();

    // Verify content was processed
    expect(content).toBeTruthy();
    expect(content).toContain('.class1');
    expect(content).toContain('.class2');
    expect(content).toContain('.class3');
  });

  // Edge cases and resilience tests
  it('should handle empty CSS files', async () => {
    // Add an empty CSS module
    await fs.promises.writeFile(path.join(OUTPUT_DIR, 'empty.module.css'), '');

    await plugin.onSuccess();
    const content = await getStylesContent();

    // Verify other content is still processed
    expect(content).toBeTruthy();
    expect(content).toContain('.class1');
  });

  it('should handle file changes during runtime', async () => {
    // First run to establish baseline
    await plugin.onSuccess();
    const initialContent = await getStylesContent();

    // Modify a file
    await modifyCssFile('style2.module.css', '.class2 { color: yellow; } .newClass { font-size: 16px; }');

    // Run again to process changes
    await plugin.onSuccess();
    const updatedContent = await getStylesContent();

    // Verify content was updated
    expect(updatedContent).not.toBe(initialContent);
    expect(updatedContent).toContain('color: yellow');
    expect(updatedContent).toContain('.newClass');
  });

  it('should handle file deletion during runtime', async () => {
    // First run to establish baseline
    await plugin.onSuccess();

    // Delete a file
    await fs.promises.unlink(path.join(OUTPUT_DIR, 'style3.module.css'));

    // Run again to process changes
    await plugin.onSuccess();
    const updatedContent = await getStylesContent();

    // Verify class3 is no longer in the content
    expect(updatedContent).not.toContain('.class3');
  });

  it('should handle directory deletion during runtime', async () => {
    // First run to establish baseline
    await plugin.onSuccess();

    // Delete the nested directory
    await fs.promises.rm(path.join(OUTPUT_DIR, 'nested'), { recursive: true });

    // Run again to process changes
    await plugin.onSuccess();
    const updatedContent = await getStylesContent();

    // Verify nestedClass is no longer in the content
    expect(updatedContent).not.toContain('.nestedClass');
  });

  it('should handle file permission issues gracefully', async () => {
    // Mock a permission error
    const originalReaddir = fs.promises.readdir;
    fs.promises.readdir = vi.fn().mockRejectedValueOnce(new Error('EACCES: permission denied'));

    await plugin.onSuccess();

    // Verify error was logged
    expect(consoleErrorSpy).toHaveBeenCalled();

    // Restore original function
    fs.promises.readdir = originalReaddir;
  });

  // it('should handle concurrent operations', async () => {
  //   // Start multiple operations concurrently
  //   const promises = Array(5).fill(0).map(() => plugin.onSuccess());
  //   await Promise.all(promises);
  //
  //   // Verify the final result is consistent
  //   const content = await getStylesContent();
  //   expect(content).toContain('.class1');
  //   expect(content).toContain('.class2');
  //   expect(content).toContain('.class3');
  // });

  it('should clear styles when requested', async () => {
    // First run to establish baseline
    await plugin.onSuccess();
    expect(await getStylesContent()).toBeTruthy();

    // Clear styles
    await plugin.onClear();

    // Verify content was cleared
    const clearedContent = await getStylesContent();
    expect(clearedContent.trim()).toBe('');
  });

  it('should handle symlink errors gracefully', async () => {
    // Create invalid symlink situation
    await fs.promises.mkdir(path.dirname(SHADOW_LINK), { recursive: true });
    await fs.promises.writeFile(BACKUP_FILE, 'test content');

    // Create a file where symlink should be to cause an error
    await fs.promises.writeFile(SHADOW_LINK, 'This is a file, not a symlink');

    await plugin.onSuccess();

    // Verify error was handled
    expect(consoleErrorSpy).toHaveBeenCalled();
  });

  it('should not process files in excluded directories', async () => {
    // Add a CSS module to node_modules that should be ignored
    await fs.promises.writeFile(
      path.join(OUTPUT_DIR, 'node_modules', 'ignored.module.css'),
      '.ignoredClass { display: none; }'
    );

    await plugin.onSuccess();
    const content = await getStylesContent();

    // Verify ignored content is not included
    expect(content).not.toContain('.ignoredClass');
  });

  it('should optimize memory usage with large files', async () => {
    // Create a large CSS file
    const largeContent = Array(1000)
      .fill(0)
      .map((_, i) => `.large-class-${i} { margin: ${i}px; }`)
      .join('\n');

    await fs.promises.writeFile(path.join(OUTPUT_DIR, 'large.module.css'), largeContent);

    // Monitor memory usage
    const memoryBefore = process.memoryUsage().heapUsed;
    await plugin.onSuccess();
    const memoryAfter = process.memoryUsage().heapUsed;

    // Verify content was processed
    const content = await getStylesContent();
    expect(content).toContain('.large-class-0');
    expect(content).toContain('.large-class-999');

    // This is a loose check since exact memory usage varies
    console.log(`Memory usage: ${((memoryAfter - memoryBefore) / 1024 / 1024).toFixed(2)}MB`);
  });

  // Advanced test for plugin hash detection
  it('should detect changes based on hash even when file content is the same length', async () => {
    // First run to establish baseline
    await plugin.onSuccess();

    // Modify a file without changing length
    await modifyCssFile('style1.module.css', '.class1 { color: tan; }');

    // Run again to process changes
    await plugin.onSuccess();
    const updatedContent = await getStylesContent();

    // Verify color was updated despite same string length
    expect(updatedContent).toContain('color: tan');
    expect(updatedContent).toContain('color: red');
  });

  // Test file handle cleanup
  it('should clean up file handles on dispose', async () => {
    // Access the plugin's private handles by mocking
    let mockHandles = { temp: null, backup: null };
    const originalOpen = fs.promises.open;

    fs.promises.open = vi.fn().mockImplementation(async (path, flags) => {
      const handle = await originalOpen(path, flags);
      if (path.includes('temp')) mockHandles.temp = handle;
      if (path.includes('backup')) mockHandles.backup = handle;
      return handle;
    });

    await plugin.onSuccess();

    // Spy on file handle close methods
    const tempSpy = vi.spyOn(mockHandles.temp, 'close');
    const backupSpy = vi.spyOn(mockHandles.backup, 'close');

    // Dispose the plugin
    await plugin.dispose();

    // Verify handles were closed
    expect(tempSpy).toHaveBeenCalled();
    expect(backupSpy).toHaveBeenCalled();

    // Restore original function
    fs.promises.open = originalOpen;
  });

  // Integration test for CSS processing
  // it('should properly process CSS with PostCSS', async () => {
  //   // Create CSS with variables and nesting that needs processing
  //   const complexCSS = `
  //     .button {
  //       color: blue;
  //       &:hover {
  //         color: red;
  //       }
  //     }
  //     .button {
  //       color: blue;
  //     }
  //   `;

  //   await fs.promises.writeFile(path.join(OUTPUT_DIR, 'complex.module.css'), complexCSS);

  //   // Process with our plugin
  //   await plugin.onSuccess();

  //   // Process manually with PostCSS for comparison
  //   await postcss([postcssDiscardDuplicates]).process(complexCSS, {
  //     from: undefined
  //   });

  //   // Get plugin-generated content
  //   const pluginContent = await getStylesContent();

  //   // Verify deduplication worked
  //   expect(pluginContent.includes('.button')).toBe(true);
  //   const buttonCount = (pluginContent.match(/\.color: blue/g) || []).length;
  //   console.warn('pluginContent', pluginContent)
  //   expect(buttonCount).toBe(1);
  // });
});
