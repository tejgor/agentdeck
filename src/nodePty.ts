import fs from 'node:fs/promises';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {createRequire} from 'node:module';
import {promisify} from 'node:util';

const execFileAsync = promisify(execFile);

interface DarwinNodePtyPaths {
	prebuildDir: string;
	helperPath: string;
	nativePath: string;
}

function getDarwinNodePtyPaths(): DarwinNodePtyPaths | undefined {
	if (process.platform !== 'darwin') {
		return undefined;
	}
	const require = createRequire(import.meta.url);
	const packageJsonPath = require.resolve('node-pty/package.json');
	const packageDir = path.dirname(packageJsonPath);
	const prebuildDir = path.join(packageDir, 'prebuilds', `darwin-${process.arch}`);
	return {
		prebuildDir,
		helperPath: path.join(prebuildDir, 'spawn-helper'),
		nativePath: path.join(prebuildDir, 'pty.node'),
	};
}

async function ensureExecutable(filePath: string): Promise<void> {
	const stat = await fs.stat(filePath);
	const nextMode = stat.mode | 0o111;
	if (nextMode !== stat.mode) {
		await fs.chmod(filePath, nextMode);
	}
}

async function tryExecFile(file: string, args: string[]): Promise<void> {
	try {
		await execFileAsync(file, args);
	} catch {
		// best-effort only
	}
}

export async function ensureNodePtyReady(): Promise<void> {
	const paths = getDarwinNodePtyPaths();
	if (!paths) {
		return;
	}

	await ensureExecutable(paths.helperPath);
	await tryExecFile('xattr', ['-dr', 'com.apple.quarantine', paths.prebuildDir]);
	await tryExecFile('codesign', ['--force', '--sign', '-', paths.helperPath]);
	await tryExecFile('codesign', ['--force', '--sign', '-', paths.nativePath]);
}
