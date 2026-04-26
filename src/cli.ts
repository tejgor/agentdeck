#!/usr/bin/env node
import React from 'react';
import {render} from 'ink';
import {attachSession} from './attach.js';
import {App} from './app.js';
import {InkDaemon} from './daemon.js';
import {ensureGitRepo} from './git.js';
import type {UiExitResult} from './types.js';

async function runUi(sidebarWidth: {current?: number}): Promise<UiExitResult | undefined> {
	const repoRoot = await ensureGitRepo(process.cwd());
	const instance = render(
		React.createElement(App, {
			repoRoot,
			cwd: repoRoot,
			initialSidebarWidth: sidebarWidth.current,
			onSidebarWidthChange: width => {
				sidebarWidth.current = width;
			},
		}),
		{
			exitOnCtrlC: true,
			patchConsole: false,
		},
	);
	return instance.waitUntilExit() as Promise<UiExitResult | undefined>;
}

async function main(): Promise<void> {
	if (process.argv.includes('--daemon')) {
		const daemon = new InkDaemon();
		await daemon.start();
		await new Promise(() => {});
		return;
	}

	const sidebarWidth: {current?: number} = {};
	while (true) {
		const result = await runUi(sidebarWidth);
		if (!result || result.kind === 'quit') {
			return;
		}
		if (result.kind === 'attach') {
			await attachSession(result.sessionId);
		}
	}
}

main().catch(error => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exit(1);
});
