import { Alert } from 'react-native';

/** Present the native destructive confirmation and invoke the mutation only from its confirm callback. */
export function confirmNativeAction(
	title: string,
	message: string,
	action: () => void,
	confirmLabel = 'Remove',
): void {
	Alert.alert(title, message, [
		{ text: 'Cancel', style: 'cancel' },
		{ text: confirmLabel, style: 'destructive', onPress: action },
	]);
}
