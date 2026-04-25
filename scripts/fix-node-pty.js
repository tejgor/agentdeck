import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';

function getDarwinPrebuildDir() {
	if (process.platform !== 'darwin') {
		return undefined;
	}
	return path.join(process.cwd(), 'node_modules', 'node-pty', 'prebuilds', `darwin-${process.arch}`);
}

function maybeFixExecutable(file) {
	if (!fs.existsSync(file)) {
		return;
	}
	const stat = fs.statSync(file);
	const nextMode = stat.mode | 0o111;
	if (nextMode !== stat.mode) {
		fs.chmodSync(file, nextMode);
		console.log(`[fix-node-pty] chmod +x ${file}`);
	}
}

function maybeRemoveQuarantine(target) {
	if (!fs.existsSync(target)) {
		return;
	}
	try {
		execFileSync('xattr', ['-dr', 'com.apple.quarantine', target], {stdio: 'ignore'});
		console.log(`[fix-node-pty] removed quarantine from ${target}`);
	} catch {
		// ignore if xattr is unavailable or no attribute is set
	}
}

function maybeCodesign(file) {
	if (!fs.existsSync(file)) {
		return;
	}
	try {
		execFileSync('codesign', ['--force', '--sign', '-', file], {stdio: 'ignore'});
		console.log(`[fix-node-pty] codesigned ${file}`);
	} catch {
		// ignore if codesign is unavailable or unnecessary
	}
}

function main() {
	const prebuildDir = getDarwinPrebuildDir();
	if (!prebuildDir) {
		return;
	}

	const helperPath = path.join(prebuildDir, 'spawn-helper');
	const nativePath = path.join(prebuildDir, 'pty.node');

	maybeFixExecutable(helperPath);
	maybeRemoveQuarantine(prebuildDir);
	maybeCodesign(helperPath);
	maybeCodesign(nativePath);
}

main();
