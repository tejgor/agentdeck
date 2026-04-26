import React from 'react';
import {Box, Text} from 'ink';
import type {SessionRecord} from './types.js';

interface SidebarProps {
	sessions: SessionRecord[];
	selectedId?: string;
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

function statusGlyph(session: SessionRecord, spinnerFrame: string): string {
	switch (session.status) {
		case 'starting':
			return spinnerFrame;
		case 'running':
			if (session.agentStatus === 'active') {
				return spinnerFrame;
			}
			if (session.agentStatus === 'idle') {
				return '●';
			}
			return '◌';
		case 'exited':
			return '○';
	}
}

function statusColor(session: SessionRecord): 'green' | 'yellow' | 'gray' {
	switch (session.status) {
		case 'starting':
			return 'yellow';
		case 'running':
			return session.agentStatus === 'unknown' || !session.agentStatus ? 'yellow' : 'green';
		case 'exited':
			return 'gray';
	}
}

function programGlyph(program: SessionRecord['program']): string {
	switch (program) {
		case 'claude':
			return '✶';
		case 'pi':
			return 'π';
	}
}

function indexedLine(label: string, index: number, width: number): string {
	if (width <= 0) {
		return '';
	}
	const suffix = ` [${index}]`;
	if (suffix.length >= width) {
		return truncate(label, width);
	}
	const left = truncate(label, width - suffix.length);
	return `${left}${' '.repeat(Math.max(0, width - left.length - suffix.length))}${suffix}`;
}

function visibleSessions(sessions: SessionRecord[], selectedIndex: number, availableRows: number): SessionRecord[] {
	if (availableRows <= 0 || sessions.length <= availableRows) {
		return sessions;
	}

	const half = Math.floor(availableRows / 2);
	let start = Math.max(0, selectedIndex - half);
	const maxStart = Math.max(0, sessions.length - availableRows);
	if (start > maxStart) {
		start = maxStart;
	}
	return sessions.slice(start, start + availableRows);
}

export function Sidebar({sessions, selectedId, width, height, spinnerFrame}: SidebarProps) {
	const selectedIndex = Math.max(0, sessions.findIndex(session => session.id === selectedId));
	const rowsForSessions = Math.max(1, height - 1);
	const visible = visibleSessions(sessions, selectedIndex, rowsForSessions);
	const visibleStart = Math.max(0, sessions.indexOf(visible[0] ?? sessions[0]));

	return (
		<Box flexDirection="column" width={width} height={height}>
			<Text bold>{truncate('Instances', width)}</Text>
			{sessions.length === 0 ? (
				<Text dimColor>{truncate('No sessions yet.', width)}</Text>
			) : (
				visible.map((session, index) => {
					const actualIndex = visibleStart + index + 1;
					const active = session.id === selectedId;
					const label = `${active ? '›' : ' '} ${statusGlyph(session, spinnerFrame)} ${programGlyph(session.program)} ${session.title}`;
					return (
						<Text key={session.id} inverse={active} color={statusColor(session)}>
							{indexedLine(label, actualIndex, width)}
						</Text>
					);
				})
			)}
		</Box>
	);
}
