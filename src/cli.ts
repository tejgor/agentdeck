#!/usr/bin/env node
import React from 'react';
import {render} from 'ink';
import {randomBytes, createHash, randomUUID} from 'node:crypto';
import {ensureDaemonRunning, request} from './client.js';
import {attachSession} from './attach.js';
import {App} from './app.js';
import {InkDaemon} from './daemon.js';
import {ensureGitRepo} from './git.js';
import {remoteHttpUrl} from './network.js';
import {runSessionWorker} from './sessionWorker.js';
import {runSetup} from './setup.js';
import {loadAppConfig, saveAppConfig} from './storage.js';
import {resetTerminalState} from './terminalState.js';
import type {RemoteControlMode, RemotePairingInfo, RightPaneTab, UiExitResult} from './types.js';

process.title = 'deckhand';

function clearTerminalScreen(): void {
	if (process.stdout.isTTY) {
		resetTerminalState();
		process.stdout.write('\x1b[?47l\x1b[?1047l\x1b[?1049l\x1b[2J\x1b[H');
	}
}

function enterAlternateScreen(): void {
	if (process.stdout.isTTY) {
		resetTerminalState();
		process.stdout.write('\x1b[?1049h\x1b[2J\x1b[H');
	}
}

function leaveAlternateScreen(): void {
	if (process.stdout.isTTY) {
		resetTerminalState();
		process.stdout.write('\x1b[?1049l');
	}
}

function sha256(value: string): string {
	return createHash('sha256').update(value).digest('hex');
}

function getArgValue(args: string[], name: string, fallback?: string): string | undefined {
	const index = args.indexOf(name);
	return index >= 0 ? args[index + 1] : fallback;
}

function getMode(args: string[]): RemoteControlMode {
	const value = getArgValue(args, '--mode', 'admin');
	if (value === 'read-only' || value === 'interactive' || value === 'admin') {
		return value;
	}
	throw new Error('--mode must be read-only, interactive, or admin');
}

async function runRemoteCommand(args: string[]): Promise<void> {
	const command = args[0] || 'status';
	const config = await loadAppConfig();
	if (command === 'enable') {
		const host = getArgValue(args, '--host', '127.0.0.1')!;
		const port = Number.parseInt(getArgValue(args, '--port', '17345')!, 10);
		if (!Number.isFinite(port) || port <= 0 || port > 65535) throw new Error('--port must be a TCP port');
		const token = randomBytes(24).toString('base64url');
		await saveAppConfig({...config, remote_control: {enabled: true, host, port, mode: getMode(args), tokenHash: sha256(token)}});
		console.log(`Deckhand mobile remote enabled.\n\nURL: ${remoteHttpUrl(host, port)}\nLogin URL: ${remoteHttpUrl(host, port, `/#token=${token}`)}\nMode: ${getMode(args)}\nToken: ${token}\n\nRestart the daemon if it is already running: kill $(cat ~/.deckhand/daemon.pid)\nFor phone use, prefer a trusted LAN/VPN/Tailscale network; do not expose this port to the public internet.`);
		return;
	}
	if (command === 'disable') {
		await saveAppConfig({...config, remote_control: {...config.remote_control, enabled: false}});
		console.log('Deckhand mobile remote disabled. Restart the daemon if it is already running.');
		return;
	}
	if (command === 'token') {
		const token = randomBytes(24).toString('base64url');
		await saveAppConfig({...config, remote_control: {...config.remote_control, enabled: config.remote_control?.enabled ?? true, host: config.remote_control?.host || '127.0.0.1', port: config.remote_control?.port || 17345, mode: config.remote_control?.mode || 'admin', tokenHash: sha256(token)}});
		console.log(token);
		return;
	}
	if (command === 'pair') {
		await ensureDaemonRunning();
		const info = await request<RemotePairingInfo>({type: 'remote-pair', requestId: randomUUID()});
		console.log(`Open ${info.url} on your phone and enter pairing code:\n\n  ${info.code}\n\nExpires: ${info.expiresAt}`);
		return;
	}
	if (command === 'status') {
		const remote = config.remote_control;
		console.log(`Remote mobile control: ${remote?.enabled ? 'enabled' : 'disabled'}`);
		if (remote?.enabled) {
			console.log(`URL: ${remoteHttpUrl(remote.host || '127.0.0.1', remote.port || 17345)}`);
			console.log(`Mode: ${remote.mode || 'admin'}`);
			console.log(`Token configured: ${remote.tokenHash ? 'yes' : 'no'}`);
		}
		return;
	}
	throw new Error(`unknown remote command: ${command}`);
}

async function runUi(uiState: {selectedId?: string; activeTab?: RightPaneTab; sidebarWidth?: number}): Promise<UiExitResult | undefined> {
	const repoRoot = await ensureGitRepo(process.cwd());
	enterAlternateScreen();
	const instance = render(
		React.createElement(App, {
			repoRoot,
			cwd: repoRoot,
			initialSelectedId: uiState.selectedId,
			initialActiveTab: uiState.activeTab,
			initialSidebarWidth: uiState.sidebarWidth,
			onSelectedIdChange: sessionId => {
				uiState.selectedId = sessionId;
			},
			onActiveTabChange: tab => {
				uiState.activeTab = tab;
			},
			onSidebarWidthChange: width => {
				uiState.sidebarWidth = width;
			},
		}),
		{
			exitOnCtrlC: true,
			patchConsole: false,
		},
	);
	try {
		return (await instance.waitUntilExit()) as UiExitResult | undefined;
	} finally {
		instance.clear();
		instance.cleanup();
		leaveAlternateScreen();
		clearTerminalScreen();
	}
}

async function main(): Promise<void> {
	if (process.argv.includes('--session-worker')) {
		await runSessionWorker();
		return;
	}

	if (process.argv.includes('--daemon')) {
		const daemon = new InkDaemon();
		await daemon.start();
		await new Promise(() => {});
		return;
	}

	if (process.argv[2] === 'setup' || process.argv[2] === 'doctor') {
		await runSetup(process.argv.slice(3));
		return;
	}

	if (process.argv[2] === 'remote') {
		await runRemoteCommand(process.argv.slice(3));
		return;
	}

	const uiState: {selectedId?: string; activeTab?: RightPaneTab; sidebarWidth?: number} = {};
	while (true) {
		const result = await runUi(uiState);
		if (!result || result.kind === 'quit') {
			return;
		}
		if (result.kind === 'attach') {
			uiState.selectedId = result.sessionId;
			uiState.activeTab = result.target === 'terminal' ? 'terminal' : result.target === 'git' ? 'git' : result.target === 'dev' ? 'dev' : 'preview';
			clearTerminalScreen();
			try {
				const config = await loadAppConfig();
				await attachSession(result.sessionId, result.target, {title: result.title, scrollSensitivity: config.attach_scroll_sensitivity});
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				process.stderr.write(`\nattach failed: ${message}\n`);
				await new Promise(resolve => setTimeout(resolve, 1500));
			}
			clearTerminalScreen();
		}
	}
}

main().catch(error => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exit(1);
});
