import { Platform } from 'react-native';
import * as SecureStore from 'expo-secure-store';
import { alertDiff, alertsFor, type Alert, type CalendarEpisode } from './calendar';

/**
 * New-episode alerts on phones and tablets: off until switched on in Settings, which is when the app asks for
 * permission to notify. Every calendar refresh schedules a local notification at each upcoming episode's air time
 * and cancels the ones that left or moved. Nothing runs in the background and no server sends anything: without
 * the app opened, the alerts already scheduled still fire, and the next ones are scheduled at the next opening.
 * Android times them inexactly (no exact-alarm permission): up to an hour after the air time.
 */
export const alertsSupported = Platform.OS !== 'web' && !Platform.isTV;

const KEY = 'dmm.library.alerts';
const CHANNEL = 'episodes';
const PREFIX = 'episode:';

// Loaded only where alerts exist: its pod is iOS only, so an Apple TV build has no native side for it.
const notifications = (): typeof import('expo-notifications') => require('expo-notifications');

let on: boolean | null = null;
let ready = false;
/** The calendar as last seen, so switching alerts on schedules at once. */
let latest: readonly CalendarEpisode[] = [];
let tail: Promise<unknown> = Promise.resolve();
const queue = (job: () => Promise<void>): Promise<void> => {
	const next = tail.then(job, job);
	tail = next.catch(() => undefined);
	return next;
};

export async function alertsOn(): Promise<boolean> {
	on ??= alertsSupported && (await SecureStore.getItemAsync(KEY).catch(() => null)) === '1';
	return on;
}

function api() {
	const N = notifications();
	if (!ready) {
		ready = true;
		// An alert that comes while the app is open shows as well; quietly, like the rest.
		N.setNotificationHandler({ handleNotification: async () => ({ shouldShowBanner: true, shouldShowList: true, shouldPlaySound: false, shouldSetBadge: false }) });
	}
	return N;
}

/** On: asks for permission (false when refused) and schedules the calendar. Off: cancels every scheduled alert. */
export async function setAlerts(enable: boolean): Promise<boolean> {
	const N = api();
	if (enable) {
		// Android 13 and later ask for the permission only once the app has a notification channel.
		if (Platform.OS === 'android') await N.setNotificationChannelAsync(CHANNEL, { name: 'New episodes', importance: N.AndroidImportance.DEFAULT });
		const { granted } = await N.requestPermissionsAsync({ ios: { allowAlert: true, allowSound: true, allowBadge: false } });
		if (!granted) return false;
	}
	on = enable;
	await SecureStore.setItemAsync(KEY, enable ? '1' : '0');
	if (enable) await syncAlerts(latest);
	else await queue(() => N.cancelAllScheduledNotificationsAsync());
	return true;
}

/** Schedules the calendar's upcoming episodes and cancels what left or moved; nothing while alerts are off or not allowed. */
export function syncAlerts(episodes: readonly CalendarEpisode[], now = Date.now()): Promise<void> {
	latest = episodes;
	return queue(async () => {
		if (!(await alertsOn())) return;
		const N = api();
		// Turned off in the system's settings since: nothing is scheduled, and Settings says why.
		if (!(await N.getPermissionsAsync()).granted) return;
		const scheduled: Alert[] = (await N.getAllScheduledNotificationsAsync())
			.filter((request) => request.identifier.startsWith(PREFIX))
			.map((request) => ({ id: request.identifier, at: Number(request.content.data?.at) || 0, title: request.content.title ?? '', body: request.content.body ?? '' }));
		const { cancel, add } = alertDiff(scheduled, alertsFor(episodes, now));
		for (const id of cancel) await N.cancelScheduledNotificationAsync(id);
		for (const alert of add) {
			await N.scheduleNotificationAsync({
				identifier: alert.id,
				content: { title: alert.title, body: alert.body, data: { at: alert.at } },
				trigger: { type: N.SchedulableTriggerInputTypes.DATE, date: alert.at, channelId: CHANNEL },
			});
		}
	});
}

/** Whether the system still lets the app notify, for Settings. */
export async function alertsAllowed(): Promise<boolean> {
	return alertsSupported && (await api().getPermissionsAsync()).granted;
}
