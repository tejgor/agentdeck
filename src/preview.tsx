import React from 'react';
import {Box, Text} from 'ink';
import type {PreviewRecord, SessionRecord} from './types.js';

interface PreviewPaneProps {
	session?: SessionRecord;
	preview: PreviewRecord;
	width: number;
	height: number;
	spinnerFrame: string;
}

function truncate(text: string, width: number): string {
	if (width <= 0) {
		return '';
	}
	if (text.length <= width) {
		return text;
	}
	if (width === 1) {
		return text.slice(0, 1);
	}
	return `${text.slice(0, width - 1)}…`;
}

function fitLines(text: string, width: number, height: number): string[] {
	const rawLines = text.length > 0 ? text.split('\n') : [''];
	const lines = rawLines.map(line => truncate(line, width));
	if (lines.length >= height) {
		return lines.slice(0, height);
	}
	return [...lines, ...Array.from({length: height - lines.length}, () => '')];
}

function fallbackMessage(session: SessionRecord | undefined, preview: PreviewRecord): string {
	if (!session) {
		return 'No sessions yet. Press n to create one.';
	}
	if (session.status === 'starting') {
		return 'Starting session…';
	}
	if (session.status === 'exited') {
		return preview.content || 'Session exited.';
	}
	return preview.content || 'Waiting for agent output…';
}

function programGlyph(program: SessionRecord['program']): string {
	switch (program) {
		case 'claude':
			return '✶';
		case 'pi':
			return 'π';
	}
}

function statusIcon(session: SessionRecord | undefined, preview: PreviewRecord, spinnerFrame: string): string {
	if (!session) {
		return '';
	}
	if (session.status === 'starting') {
		return spinnerFrame;
	}
	if (session.status === 'exited') {
		return '○';
	}
	const agentStatus = preview.agentStatus ?? session.agentStatus;
	if (agentStatus === 'active') {
		return spinnerFrame;
	}
	if (agentStatus === 'idle') {
		return '●';
	}
	return '◌';
}

export function PreviewPane({session, preview, width, height, spinnerFrame}: PreviewPaneProps) {
	const icon = statusIcon(session, preview, spinnerFrame);
	const header = session ? `${programGlyph(session.program)} ${session.title} ${icon}` : 'Preview';
	const subheader = session ? session.cwd : 'Select a session from the sidebar.';
	const bodyHeight = Math.max(1, height - 2);
	const content = fallbackMessage(session, preview);
	const lines = fitLines(content, width, bodyHeight);

	return (
		<Box flexDirection="column" width={width} height={height}>
			<Text bold>{truncate(header, width)}</Text>
			<Text dimColor>{truncate(subheader, width)}</Text>
			{lines.map((line, index) => (
				<Text key={`preview-line-${index}`}>{line}</Text>
			))}
		</Box>
	);
}
