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
const PREFIX = 'episode:';

/** What alerts need from the system. */
interface Notifier {
	/** Asks to notify where the system asks; whether the app may. */
	request(): Promise<boolean>;
	allowed(): Promise<boolean>;
	scheduled(): Promise<Alert[]>;
	schedule(alert: Alert): Promise<void>;
	cancel(id: string): Promise<void>;
	cancelAll(): Promise<void>;
}

/** iOS: expo-notifications, loaded only there (its pod is iOS only; tvOS has none). Its Android side brings Firebase. */
function expoNotifications(): Notifier {
	const N: typeof import('expo-notifications') = require('expo-notifications');
	// An alert that comes while the app is open shows as well; quietly, like the rest.
	N.setNotificationHandler({ handleNotification: async () => ({ shouldShowBanner: true, shouldShowList: true, shouldPlaySound: false, shouldSetBadge: false }) });
	return {
		request: async () => (await N.requestPermissionsAsync({ ios: { allowAlert: true, allowSound: true, allowBadge: false } })).granted,
		allowed: async () => (await N.getPermissionsAsync()).granted,
		scheduled: async () =>
			(await N.getAllScheduledNotificationsAsync()).map((request) => ({ id: request.identifier, at: Number(request.content.data?.at) || 0, title: request.content.title ?? '', body: request.content.body ?? '' })),
		schedule: async (alert) =>
			void (await N.scheduleNotificationAsync({
				identifier: alert.id,
				content: { title: alert.title, body: alert.body, data: { at: alert.at } },
				trigger: { type: N.SchedulableTriggerInputTypes.DATE, date: alert.at },
			})),
		cancel: (id) => N.cancelScheduledNotificationAsync(id),
		cancelAll: () => N.cancelAllScheduledNotificationsAsync(),
	};
}

let notifier: Notifier | null = null;
// Android: the app's own module (modules/dmm-alerts), alarms and the system's notifications, no Firebase.
const system = (): Notifier => (notifier ??= Platform.OS === 'android' ? require('expo').requireNativeModule('DmmAlerts') : expoNotifications());

let on: boolean | null = null;
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

/** On: asks for permission (false when refused) and schedules the calendar. Off: cancels every scheduled alert. */
export async function setAlerts(enable: boolean): Promise<boolean> {
	if (enable && !(await system().request())) return false;
	on = enable;
	await SecureStore.setItemAsync(KEY, enable ? '1' : '0');
	if (enable) await syncAlerts(latest);
	else await queue(() => system().cancelAll());
	return true;
}

/** Schedules the calendar's upcoming episodes and cancels what left or moved; nothing while alerts are off or not allowed. */
export function syncAlerts(episodes: readonly CalendarEpisode[], now = Date.now()): Promise<void> {
	latest = episodes;
	return queue(async () => {
		if (!(await alertsOn())) return;
		const N = system();
		// Turned off in the system's settings since: nothing is scheduled, and Settings says why.
		if (!(await N.allowed())) return;
		const scheduled = (await N.scheduled()).filter((alert) => alert.id.startsWith(PREFIX));
		const { cancel, add } = alertDiff(scheduled, alertsFor(episodes, now));
		for (const id of cancel) await N.cancel(id);
		for (const alert of add) await N.schedule(alert);
	});
}

/** Whether the system still lets the app notify, for Settings. */
export async function alertsAllowed(): Promise<boolean> {
	return alertsSupported && (await system().allowed());
}
