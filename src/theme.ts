import { useColorScheme } from 'react-native';

export interface AppTheme {
	dark: boolean;
	background: string;
	surface: string;
	border: string;
	text: string;
	muted: string;
	accent: string;
	onAccent: string;
	danger: string;
	input: string;
}

export const useAppTheme = (): AppTheme => {
	const dark = useColorScheme() === 'dark';
	return dark
		? {
				dark: true,
				background: '#0b1020',
				surface: '#151d31',
				border: '#2b3854',
				text: '#f8fafc',
				muted: '#a6b2c8',
				accent: '#8ab4ff',
				onAccent: '#0b1020',
				danger: '#ff8a8a',
				input: '#10182a',
			}
		: {
				dark: false,
				background: '#f4f6fb',
				surface: '#ffffff',
				border: '#d9dfeb',
				text: '#111827',
				muted: '#5d697d',
				accent: '#2457c5',
				onAccent: '#ffffff',
				danger: '#b42318',
				input: '#f8fafc',
			};
};
