import React from 'react';
import {Box, Text} from 'ink';
import type {DevRecord, SessionRecord} from './types.js';

interface DevPaneProps {
	session?: SessionRecord;
	dev: DevRecord;
	width: number;
	height: number;
}

function truncate(text: string, width: number): string {
	if (width <= 0) return '';
	if (text.length <= width) return text;
	return width === 1 ? text.slice(0, 1) : `${text.slice(0, width - 1)}…`;
}

function fitLines(text: string, width: number, height: number): string[] {
	const rawLines = text.length > 0 ? text.split('\n') : [''];
	const lines = rawLines.map(line => truncate(line, width));
	if (lines.length >= height) return lines.slice(0, height);
	return [...lines, ...Array.from({length: height - lines.length}, () => '')];
}

function fallbackMessage(session: SessionRecord | undefined, dev: DevRecord): string {
	if (!session) return 'No session selected.';
	if (session.status === 'exited') return 'Session exited. Restart it to run a dev command.';
	if (!dev.live && dev.content) return dev.content;
	if (!dev.live && dev.sessionId === session.id) return 'Dev command exited. Press d to start it again.';
	return dev.content || 'Press d to start dev command.';
}

export function DevPane({session, dev, width, height}: DevPaneProps) {
	const header = session ? `Dev — ${session.title}${dev.live ? ' ●' : ' ○'}` : 'Dev';
	const command = dev.command ? ` • ${dev.command}` : '';
	const subheader = `${dev.cwd ?? session?.cwd ?? 'Select a session from the sidebar.'}${command}`;
	const bodyHeight = Math.max(1, height - 2);
	const lines = fitLines(fallbackMessage(session, dev), width, bodyHeight);

	return (
		<Box flexDirection="column" width={width} height={height}>
			<Text bold>{truncate(header, width)}</Text>
			<Text dimColor>{truncate(subheader, width)}</Text>
			{lines.map((line, index) => (
				<Text key={`dev-line-${index}`}>{line}</Text>
			))}
		</Box>
	);
}
