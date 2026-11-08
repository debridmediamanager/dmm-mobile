import { describe, expect, it, vi } from 'vitest';

const { alert } = vi.hoisted(() => ({ alert: vi.fn() }));
vi.mock('react-native', () => ({ Alert: { alert } }));

import { confirmNativeAction } from './confirmAction';

describe('native destructive confirmation', () => {
	it('does not mutate when the generated native cancel callback is invoked', () => {
		const remove = vi.fn();
		confirmNativeAction('Remove?', 'Confirm removal', remove);
		const buttons = alert.mock.calls.at(-1)?.[2] as Array<{ text?: string; onPress?: () => void }>;
		buttons.find((button) => button.text === 'Cancel')?.onPress?.();
		expect(remove).not.toHaveBeenCalled();
	});

	it('mutates once when the generated native confirm callback is invoked', () => {
		const remove = vi.fn();
		confirmNativeAction('Remove?', 'Confirm removal', remove);
		const buttons = alert.mock.calls.at(-1)?.[2] as Array<{ text?: string; onPress?: () => void }>;
		buttons.find((button) => button.text === 'Remove')?.onPress?.();
		expect(remove).toHaveBeenCalledTimes(1);
	});
});
