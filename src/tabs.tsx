import React from 'react';
import {Box, Text} from 'ink';
import type {RightPaneTab} from './types.js';

const TABS: Array<{key: RightPaneTab; label: string}> = [
	{key: 'preview', label: 'Preview'},
	{key: 'terminal', label: 'Terminal'},
];

function truncate(text: string, width: number): string {
	if (width <= 0) {
		return '';
	}
	if (text.length <= width) {
		return text;
	}
	return width === 1 ? text.slice(0, 1) : `${text.slice(0, width - 1)}…`;
}

export function TabBar({activeTab, width}: {activeTab: RightPaneTab; width: number}) {
	const tabWidth = Math.max(1, Math.floor(width / TABS.length));
	return (
		<Box width={width}>
			{TABS.map(tab => {
				const active = tab.key === activeTab;
				return (
					<Box key={tab.key} width={tabWidth}>
						<Text inverse={active} color={active ? 'cyan' : undefined}>
							{truncate(` ${tab.label} `, tabWidth)}
						</Text>
					</Box>
				);
			})}
		</Box>
	);
}
