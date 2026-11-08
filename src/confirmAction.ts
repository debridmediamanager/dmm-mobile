import { Alert } from 'react-native';

/** Present the native destructive confirmation and invoke the mutation only from its confirm callback. */
export function confirmNativeAction(
	title: string,
	message: string,
	action: () => void,
): void {
	Alert.alert(title, message, [
		{ text: 'Cancel', style: 'cancel' },
		{ text: 'Remove', style: 'destructive', onPress: action },
	]);
}
